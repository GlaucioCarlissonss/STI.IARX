import type { Provedor } from './provedor'

/**
 * Esvaziamento da caixa de saída.
 *
 * É a metade em TypeScript da divisão declarada na migração 0029: a regra de
 * QUEM avisar vive no SQL, onde os dados estão; a conversa com o provedor vive
 * aqui, porque o banco não faz chamada de rede. A fronteira entre as duas é a
 * tabela `email_outbox`.
 */

/** O mínimo do cliente Supabase que esta função usa. Permite testar sem rede. */
export interface ClienteDaCaixa {
  from(tabela: string): {
    select(colunas: string): {
      eq(c: string, v: string): {
        lte(c: string, v: string): {
          order(c: string, o: { ascending: boolean }): {
            limit(n: number): Promise<{ data: LinhaDaCaixa[] | null; error: unknown }>
          }
        }
      }
    }
    update(valores: Record<string, unknown>): {
      eq(c: string, v: string): Promise<{ error: unknown }>
    }
  }
}

export interface LinhaDaCaixa {
  id: string
  to_email: string
  to_name: string | null
  subject: string
  body_text: string
  kind: string
  attempts: number
}

export interface ResultadoDaDrenagem {
  enviadas: number
  falhas: number
  /** Verdadeiro quando não há provedor: a fila fica intacta, nada se perde. */
  semProvedor: boolean
}

/**
 * Quanto esperar antes da próxima tentativa, em minutos.
 *
 * Crescimento exponencial com teto: 1, 4, 9, 16, 25 minutos. Repetir de minuto
 * em minuto contra um provedor fora do ar não entrega nada e ainda gasta a cota
 * de requisições — e, quando o provedor volta, cinco tentativas empilhadas
 * saem de uma vez.
 */
export function proximaTentativa(tentativas: number): Date {
  const minutos = Math.min(tentativas * tentativas, 60)
  return new Date(Date.now() + minutos * 60_000)
}

/** Depois disto a mensagem é dada como perdida e o motivo fica registrado. */
export const MAXIMO_DE_TENTATIVAS = 5

/**
 * Os caminhos que o SQL escreve relativos, e que o envio completa.
 *
 * O banco escreve `/avaliar/<token>` porque ele não conhece o domínio — e
 * inventar uma coluna para guardá-lo seria a terceira cópia de uma configuração
 * que já vive em `NEXT_PUBLIC_SITE_URL`. Quem completa é quem envia.
 */
export const CAMINHOS_DE_EMAIL = [
  'avaliar',
  'tickets',
  /* Entraram com a 0057: sem eles, o e-mail de redefinição sairia com
     `/nova-senha/<token>` em caminho relativo — que num cliente de e-mail não é
     link nenhum, e a pessoa receberia a mensagem certa com o caminho
     inutilizável. */
  'nova-senha',
  'confirmar-email',
  /* E `convite` com a 0061, que repetiu o mesmo esquecimento: a migração
     escreveu `/convite/<token>` e esta lista não sabia do caminho. O teste
     abaixo da lista existe para que a 0062 não possa repeti-lo. */
  'convite',
  /*
   * `inventario` é da 0032, e ninguém tinha percebido: o alerta do agente manda
   * "Veja a máquina em /inventario/agentes/<id>" desde aquela entrega, e o
   * caminho nunca foi completado. Foi o teste de varredura que o encontrou —
   * não eu, procurando.
   */
  'inventario',
] as const

/**
 * Completa o caminho relativo que o SQL escreveu com o endereço público.
 *
 * ## Esta lista é a terceira cópia de uma informação, e já falhou duas vezes
 *
 * Quem escreve o caminho é a migração; quem o completa é esta função; e nada
 * liga uma coisa à outra. Aconteceu na 0057 e de novo na 0061 — nos dois casos
 * o e-mail saía certo, com um caminho que não é link.
 *
 * O conserto não foi acrescentar mais um item: foi `caixa-de-saida.test.ts`
 * varrer as migrações atrás de caminhos relativos em corpo de e-mail e exigir
 * que cada um esteja aqui. A terceira cópia continua existindo, mas agora ela
 * acusa quando diverge.
 */
export function completarEnderecos(texto: string, origem: string): string {
  const base = origem.replace(/\/+$/, '')
  const caminhos = CAMINHOS_DE_EMAIL.join('|')
  return texto.replace(new RegExp(`(^|\\s)/(${caminhos})/`, 'g'), `$1${base}/$2/`)
}

/**
 * Envia o que está pendente e vencido.
 *
 * `limite` existe para a execução ter fim: uma fila represada de dez mil
 * mensagens não pode virar uma requisição de dez minutos que o servidor corta
 * no meio, deixando metade enviada e nenhum registro de onde parou.
 */
export async function drenarCaixaDeSaida(
  supabase: ClienteDaCaixa,
  provedor: Provedor | null,
  origem: string,
  limite = 50,
): Promise<ResultadoDaDrenagem> {
  if (!provedor) return { enviadas: 0, falhas: 0, semProvedor: true }

  const { data } = await supabase
    .from('email_outbox')
    .select('id, to_email, to_name, subject, body_text, kind, attempts')
    .eq('status', 'pending')
    .lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(limite)

  let enviadas = 0
  let falhas = 0

  for (const linha of data ?? []) {
    const texto = completarEnderecos(linha.body_text, origem)
    const r = await provedor.enviar({
      to: linha.to_email,
      toName: linha.to_name,
      subject: linha.subject,
      text: texto,
    })

    if (r.ok) {
      /*
       * O corpo do convite de avaliação carrega o token do link em claro. Depois
       * de enviado ele não serve a mais ninguém — e um segredo que já cumpriu o
       * papel e continua guardado é só risco acumulado. O assunto, o destinatário
       * e a data ficam, que é o que o suporte precisa.
       */
      const corpo =
        linha.kind === 'satisfaction_invite'
          ? '(corpo removido após o envio: continha o link de avaliação)'
          : linha.body_text

      await supabase
        .from('email_outbox')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          attempts: linha.attempts + 1,
          body_text: corpo,
        })
        .eq('id', linha.id)
      enviadas += 1
      continue
    }

    const tentativas = linha.attempts + 1
    const desistiu = tentativas >= MAXIMO_DE_TENTATIVAS

    await supabase
      .from('email_outbox')
      .update({
        status: desistiu ? 'failed' : 'pending',
        attempts: tentativas,
        last_error: r.erro.slice(0, 500),
        scheduled_for: desistiu ? undefined : proximaTentativa(tentativas).toISOString(),
      })
      .eq('id', linha.id)
    falhas += 1
  }

  return { enviadas, falhas, semProvedor: false }
}
