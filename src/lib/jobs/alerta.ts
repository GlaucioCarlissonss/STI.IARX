import type { Provedor } from '@/lib/mail/provedor'

/**
 * O aviso de que um trabalho agendado parou.
 *
 * ## A metade em TypeScript de uma divisão que já existia
 *
 * A migração 0055 decide QUEM está quebrado — ela tem os dados e sabe a cadência
 * esperada de cada trabalho. Este módulo faz o que o banco não faz: chamada de
 * rede. A fronteira entre os dois é a tabela `job_alert_episodes`, do mesmo
 * jeito que a fronteira do e-mail de SLA é a `email_outbox`.
 *
 * ## Por que NÃO pela caixa de saída
 *
 * `email_outbox` exige `tenant_id`. Trabalho agendado é da instalação: o SLA que
 * deixou de ser medido deixou de ser medido para todo mundo. Para enfileirar ali
 * seria preciso escolher um tenant arbitrário, que passaria a "possuir" um
 * problema de infraestrutura que não é dele — e o aviso apareceria na conta de
 * um cliente qualquer.
 *
 * Por isso o envio aqui é direto, pelo provedor, para um destinatário que vem do
 * ambiente. É quem administra o servidor que precisa ler, não quem usa o sistema.
 *
 * ## Dois avisos por episódio, no máximo
 *
 * A quebra e a volta. Um trabalho que falha de cinco em cinco minutos mandaria
 * 288 e-mails por dia; no segundo dia ninguém lê nenhum, e o alerta deixou de
 * existir com a agravante de todo mundo achar que ele existe. O `avisado_em` na
 * tabela é o que impede isso.
 */

export type TipoDeEpisodio = 'falhou' | 'parou'

export interface Episodio {
  id: number
  job: string
  tipo: TipoDeEpisodio
  detalhe: string | null
  aberto_em: string
  fechado_em: string | null
}

export interface Aviso {
  assunto: string
  texto: string
}

/** Quanto tempo o problema durou, em palavras. */
export function duracaoEmPortugues(milissegundos: number): string {
  /*
   * `floor`, e não `round`: arredondar faz 30 segundos virarem "1 min" e engolir
   * a frase que existe justamente para esse caso. Duração se trunca — ninguém
   * espera que 2 h 15 min 40 s apareçam como 2 h 16 min.
   */
  const minutos = Math.max(0, Math.floor(milissegundos / 60_000))
  if (minutos < 1) return 'menos de um minuto'
  if (minutos < 60) return `${minutos} min`

  const horas = Math.floor(minutos / 60)
  const resto = minutos % 60
  if (horas < 24) return resto === 0 ? `${horas} h` : `${horas} h ${resto} min`

  const dias = Math.floor(horas / 24)
  const horasRestantes = horas % 24
  return horasRestantes === 0 ? `${dias} d` : `${dias} d ${horasRestantes} h`
}

function emPortugues(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
}

/**
 * O texto da quebra.
 *
 * Ele diz O QUE PARAR SIGNIFICA, e não só que parou. Quem recebe isto às três da
 * manhã não tem o modelo do sistema na cabeça — e "sla_alerts falhou" não ajuda
 * ninguém a decidir se levanta da cama ou se olha de manhã.
 */
export function avisoDeQuebra(e: Episodio, rotulo: string, consequencia?: string | null): Aviso {
  const verbo = e.tipo === 'parou' ? 'parou' : 'está falhando'
  const linhas = [
    `O trabalho agendado "${rotulo}" ${verbo}.`,
    '',
    `Detectado em: ${emPortugues(e.aberto_em)}`,
    `Identificador interno: ${e.job}`,
    '',
    e.detalhe ?? '',
  ]

  if (consequencia) {
    linhas.push('', `Enquanto isso durar: ${consequencia}`)
  }

  linhas.push(
    '',
    e.tipo === 'parou'
      ? 'Nenhuma execução foi registrada dentro da cadência esperada. Confira se o agendador está chamando POST /api/jobs/run.'
      : 'A última execução terminou com erro. O detalhe acima é a mensagem que o banco devolveu.',
    '',
    'Este aviso sai UMA vez por episódio. O próximo será o de normalização.',
  )

  return {
    assunto: `[STI] ${rotulo} ${verbo}`,
    texto: linhas.join('\n'),
  }
}

/** O texto da volta. Só vai para quem recebeu a quebra. */
export function avisoDeVolta(e: Episodio, rotulo: string): Aviso {
  const duracao = e.fechado_em
    ? duracaoEmPortugues(new Date(e.fechado_em).getTime() - new Date(e.aberto_em).getTime())
    : null

  return {
    assunto: `[STI] ${rotulo} voltou ao normal`,
    texto: [
      `O trabalho agendado "${rotulo}" voltou a executar normalmente.`,
      '',
      `Começou em: ${emPortugues(e.aberto_em)}`,
      e.fechado_em ? `Normalizou em: ${emPortugues(e.fechado_em)}` : '',
      duracao ? `Duração: ${duracao}` : '',
      '',
      'O que não foi feito durante a parada NÃO é recuperado retroativamente por',
      'este aviso. Vale conferir o que ficou para trás nesse intervalo.',
    ]
      .filter((l) => l !== '')
      .join('\n'),
  }
}

/**
 * O corpo que vai ao webhook.
 *
 * Campos achatados e nomes estáveis, de propósito: quem recebe isto é um fluxo
 * do n8n ou um script de três linhas, e um objeto aninhado só obrigaria quem
 * está do outro lado a escrever código para desempacotar.
 */
export function corpoDoWebhook(
  e: Episodio,
  rotulo: string,
  evento: 'quebrou' | 'voltou',
): Record<string, unknown> {
  return {
    evento: evento === 'voltou' ? 'trabalho.voltou' : `trabalho.${e.tipo}`,
    episodio: e.id,
    trabalho: e.job,
    rotulo,
    detalhe: e.detalhe,
    aberto_em: e.aberto_em,
    fechado_em: e.fechado_em,
    gerado_em: new Date().toISOString(),
  }
}

/**
 * Entrega ao webhook, com prazo.
 *
 * `AbortSignal.timeout` não é detalhe: esta chamada acontece DENTRO da execução
 * dos trabalhos agendados. Um endereço que aceita a conexão e nunca responde
 * seguraria a execução inteira até o servidor cortar a requisição — e aí os
 * trabalhos que vêm depois deixariam de rodar por causa do alerta de que um
 * trabalho deixou de rodar.
 */
export async function entregarAoWebhook(
  url: string,
  corpo: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; erro: string }> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) {
      const texto = await r.text().catch(() => '')
      return { ok: false, erro: `HTTP ${r.status} ${texto.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (erro) {
    return { ok: false, erro: erro instanceof Error ? erro.message : String(erro) }
  }
}

export interface DestinoDoAlerta {
  /** Para onde mandar e-mail. Vazio desliga o canal de e-mail. */
  email?: string | null
  /** Para onde fazer POST. Vazio desliga o canal de webhook. */
  webhook?: string | null
}

/** Lê os dois canais do ambiente. Existe separado para o teste não mexer em `process.env`. */
export function destinoConfigurado(
  ambiente: Readonly<Record<string, string | undefined>> = process.env,
): DestinoDoAlerta {
  return {
    email: ambiente.ALERTA_OPERACAO_EMAIL || null,
    webhook: ambiente.ALERTA_OPERACAO_WEBHOOK || null,
  }
}

export interface ResultadoDoAlerta {
  avisados: number
  normalizados: number
  falhas: number
  /** Verdadeiro quando nada está configurado: os episódios ficam intactos. */
  semCanal: boolean
  /**
   * Por que a rotina não conseguiu LER os episódios.
   *
   * Este campo existe por causa de um defeito que eu mesmo escrevi e só apareceu
   * ao rodar a rota de verdade: o `select` voltava "permission denied for table
   * job_expectations", o código fazia `const { data } = await ...` e seguia em
   * frente com a lista vazia. O resultado dizia `avisados: 0, falhas: 0` — que é
   * exatamente o que um sistema saudável e silencioso diz.
   *
   * Num módulo cujo trabalho inteiro é avisar, "não consegui ler" NUNCA pode ser
   * indistinguível de "não havia nada a avisar".
   */
  erro?: string
}

/** O mínimo do cliente Supabase que este módulo usa. Permite testar sem rede. */
interface Consulta<T> extends PromiseLike<{ data: T[] | null; error: unknown }> {
  is(coluna: string, valor: null): Consulta<T>
  not(coluna: string, operador: 'is', valor: null): Consulta<T>
  order(coluna: string, opcoes: { ascending: boolean }): Consulta<T>
  limit(n: number): Consulta<T>
}

export interface ClienteDeAlerta {
  from(tabela: string): {
    select(colunas: string): Consulta<Record<string, unknown>>
    update(valores: Record<string, unknown>): {
      eq(coluna: string, valor: number | string): PromiseLike<{ error: unknown }>
    }
    insert(valores: Record<string, unknown>): PromiseLike<{ error: unknown }>
  }
}

interface LinhaDeExpectativa {
  job: string
  rotulo: string
  observacao: string | null
}

/**
 * Envia por todos os canais configurados e diz se ALGUM funcionou.
 *
 * "Algum" e não "todos", deliberadamente: se o e-mail saiu e o webhook caiu, a
 * pessoa foi avisada — repetir o episódio no ciclo seguinte só para alcançar o
 * webhook mandaria um segundo e-mail idêntico, que é precisamente o ruído que
 * este desenho existe para evitar. O canal que falhou fica registrado em
 * `erro_do_aviso`.
 */
async function entregar(
  aviso: Aviso,
  corpo: Record<string, unknown>,
  provedor: Provedor | null,
  destino: DestinoDoAlerta,
): Promise<{ canais: string[]; erros: string[] }> {
  const canais: string[] = []
  const erros: string[] = []

  if (provedor && destino.email) {
    const r = await provedor.enviar({
      to: destino.email,
      subject: aviso.assunto,
      text: aviso.texto,
    })
    if (r.ok) canais.push('email')
    else erros.push(`email: ${r.erro}`)
  }

  if (destino.webhook) {
    const r = await entregarAoWebhook(destino.webhook, corpo)
    if (r.ok) canais.push('webhook')
    else erros.push(`webhook: ${r.erro}`)
  }

  return { canais, erros }
}

/**
 * Avisa o que ainda não foi avisado: as quebras novas e as voltas pendentes.
 *
 * Chamada depois de `app.sincronizar_episodios_de_alerta()`, que é quem abre e
 * fecha episódio. A separação é a de sempre: a decisão no banco, a rede aqui.
 */
export async function avisarEpisodios(
  supabase: ClienteDeAlerta,
  provedor: Provedor | null,
  destino: DestinoDoAlerta,
): Promise<ResultadoDoAlerta> {
  const temEmail = Boolean(provedor && destino.email)
  const temWebhook = Boolean(destino.webhook)

  /*
   * Sem canal nenhum, sai ANTES de ler qualquer coisa — e, principalmente, sem
   * marcar nada como avisado. O episódio fica aberto e sem aviso; no dia em que
   * alguém configurar um canal, a quebra que está acontecendo é anunciada.
   * Marcar aqui transformaria "ninguém foi avisado" em "já avisamos".
   */
  if (!temEmail && !temWebhook) {
    return { avisados: 0, normalizados: 0, falhas: 0, semCanal: true }
  }

  /*
   * Os rótulos vêm numa consulta separada em vez de relação embutida: o driver
   * local (docs/22) fala o dialeto do PostgREST mas não resolve `select` com
   * relação aninhada, e aqui são oito linhas.
   */
  const { data: expectativas, error: erroDasExpectativas } = (await supabase
    .from('job_expectations')
    .select('job, rotulo, observacao')) as {
    data: LinhaDeExpectativa[] | null
    error: { message?: string } | null
  }

  /*
   * Sem os rótulos o aviso ainda sai, só que pior (identificador cru no assunto).
   * Então isto não interrompe — mas é registrado, porque um erro aqui costuma
   * ser o mesmo erro que vai derrubar as consultas seguintes.
   */
  if (erroDasExpectativas) {
    console.error('[alerta] job_expectations', erroDasExpectativas.message)
  }

  const rotulos = new Map((expectativas ?? []).map((e) => [e.job, e]))
  const descrever = (job: string) => rotulos.get(job)?.rotulo ?? job

  let avisados = 0
  let normalizados = 0
  let falhas = 0

  // --- As quebras ainda não anunciadas ---------------------------------------
  const { data: quebras, error: erroDasQuebras } = (await supabase
    .from('job_alert_episodes')
    .select('id, job, tipo, detalhe, aberto_em, fechado_em')
    .is('avisado_em', null)
    .is('fechado_em', null)
    .order('aberto_em', { ascending: true })
    .limit(20)) as { data: Episodio[] | null; error: { message?: string } | null }

  /*
   * Aqui a falha de leitura ENCERRA a rotina com erro declarado, em vez de
   * continuar sobre uma lista vazia. Seguir em frente devolveria
   * `avisados: 0, falhas: 0` — a mesma resposta de um sistema saudável — e o
   * alerta estaria quebrado com cara de estar funcionando. Foi o que aconteceu
   * na primeira vez que rodei isto contra o banco de verdade.
   */
  if (erroDasQuebras) {
    const mensagem = erroDasQuebras.message ?? 'erro ao ler job_alert_episodes'
    console.error('[alerta] job_alert_episodes', mensagem)
    return { avisados: 0, normalizados: 0, falhas: 0, semCanal: false, erro: mensagem }
  }

  for (const episodio of quebras ?? []) {
    const rotulo = descrever(episodio.job)
    const { canais, erros } = await entregar(
      avisoDeQuebra(episodio, rotulo, rotulos.get(episodio.job)?.observacao),
      corpoDoWebhook(episodio, rotulo, 'quebrou'),
      provedor,
      destino,
    )

    if (canais.length === 0) {
      /*
       * Nenhum canal funcionou: NÃO marca como avisado. O erro fica gravado e o
       * ciclo seguinte tenta de novo — um aviso perdido em silêncio seria pior
       * que o problema que ele anuncia.
       */
      falhas += 1
      await supabase
        .from('job_alert_episodes')
        .update({ erro_do_aviso: erros.join('; ').slice(0, 500) })
        .eq('id', episodio.id)
      continue
    }

    await supabase
      .from('job_alert_episodes')
      .update({
        avisado_em: new Date().toISOString(),
        canais,
        erro_do_aviso: erros.length > 0 ? erros.join('; ').slice(0, 500) : null,
      })
      .eq('id', episodio.id)
    avisados += 1
  }

  // --- As voltas ainda não anunciadas ----------------------------------------
  const { data: voltas, error: erroDasVoltas } = (await supabase
    .from('job_alert_episodes')
    .select('id, job, tipo, detalhe, aberto_em, fechado_em')
    .is('volta_avisada_em', null)
    .not('fechado_em', 'is', null)
    .not('avisado_em', 'is', null)
    .order('fechado_em', { ascending: true })
    .limit(20)) as { data: Episodio[] | null; error: { message?: string } | null }

  if (erroDasVoltas) {
    const mensagem = erroDasVoltas.message ?? 'erro ao ler as voltas'
    console.error('[alerta] voltas', mensagem)
    return { avisados, normalizados: 0, falhas, semCanal: false, erro: mensagem }
  }

  for (const episodio of voltas ?? []) {
    const rotulo = descrever(episodio.job)
    const { canais } = await entregar(
      avisoDeVolta(episodio, rotulo),
      corpoDoWebhook(episodio, rotulo, 'voltou'),
      provedor,
      destino,
    )

    if (canais.length === 0) {
      falhas += 1
      continue
    }

    await supabase
      .from('job_alert_episodes')
      .update({ volta_avisada_em: new Date().toISOString() })
      .eq('id', episodio.id)
    normalizados += 1
  }

  return { avisados, normalizados, falhas, semCanal: false }
}

/**
 * Grava em `job_runs` que um trabalho falhou.
 *
 * ## Por que isto precisa existir em TypeScript
 *
 * Toda função `app.job_*` insere a linha de `job_runs` no começo e a completa no
 * fim. Quando ela levanta exceção, a chamada inteira é UMA transação — e o
 * `insert` do começo volta atrás junto com o resto. O registro da execução que
 * falhou desaparece exatamente no caso em que ele seria útil.
 *
 * Quem sobrevive à exceção é esta rota, que recebe a mensagem de erro do
 * PostgREST. Ela é o único ponto do sistema que sabe que houve uma tentativa e
 * que ela deu errado. Até aqui essa informação ia para `console.error` e
 * acabava ali.
 */
export async function registrarFalhaDeTrabalho(
  supabase: ClienteDeAlerta,
  job: string,
  mensagem: string,
): Promise<void> {
  const agora = new Date().toISOString()
  await supabase.from('job_runs').insert({
    job,
    started_at: agora,
    finished_at: agora,
    ok: false,
    affected: 0,
    detail: mensagem.slice(0, 500),
  })
}
