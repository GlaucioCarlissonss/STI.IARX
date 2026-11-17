import { createHash } from 'node:crypto'

/**
 * Limite de requisições por origem, para as telas públicas.
 *
 * ## O que ele defende, e o que a 0057 já defendia
 *
 * A emissão de token tem espera de 60 segundos **por conta**. Isso protege a
 * caixa de UMA pessoa de receber trinta links.
 *
 * Não protege de quem varre uma lista. Com dez mil e-mails vazados, cada um que
 * tiver conta aqui recebe uma mensagem legítima, assinada pelo nosso domínio,
 * sem ter pedido nada — e nenhuma conta passou do limite dela. O estrago é o
 * domínio denunciado como remetente de spam, e aí para todo o e-mail do
 * sistema, inclusive o aviso de SLA.
 *
 * ## O IP nunca chega ao banco
 *
 * O que vai é um hash com segredo. IP é dado pessoal, e guardá-lo para contar
 * requisição seria manter registro de quem visitou e quando em troca de nada:
 * para contar basta saber que duas vieram da mesma origem, e igualdade de hash
 * responde isso.
 */

/**
 * O IP do cliente atrás do proxy reverso — e por que é o ÚLTIMO da lista.
 *
 * ## A armadilha
 *
 * `X-Forwarded-For` é uma lista que cada proxy ACRESCENTA. O Caddy do
 * `compose.producao.yml` recebe a requisição e anexa o endereço de quem falou
 * com ele. Então, se o visitante mandar o cabeçalho já preenchido:
 *
 *     cliente envia:  X-Forwarded-For: 9.9.9.9
 *     Caddy entrega:  X-Forwarded-For: 9.9.9.9, 203.0.113.7
 *                                      ↑ inventado   ↑ o real
 *
 * Pegar o PRIMEIRO item — que é o que quase toda biblioteca faz por padrão, e o
 * que parece certo porque "o primeiro é o cliente original" — entrega o controle
 * da chave de limite a quem está sendo limitado. Um valor novo por requisição e
 * o limite deixa de existir, sem erro nenhum e sem aparecer em lugar algum.
 *
 * Com exatamente UM proxy confiável, o real é o último. É o caso aqui: o app
 * não publica porta (ver `compose.producao.yml`), então ninguém alcança o
 * servidor sem passar pelo Caddy.
 *
 * ## Se um dia houver outro proxy na frente
 *
 * Com dois proxies confiáveis, o real passa a ser o penúltimo. Esta função
 * precisaria saber quantos são — e o sinal de que chegou a hora é o limite
 * passar a contar todo mundo como a mesma origem, porque o último vira o IP do
 * proxy de fora.
 */
export function ipDoCliente(cabecalhos: {
  xForwardedFor?: string | null
  xRealIp?: string | null
}): string | null {
  const xff = cabecalhos.xForwardedFor?.trim()
  if (xff) {
    const partes = xff
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    const ultimo = partes[partes.length - 1]
    if (ultimo) return ultimo
  }

  /*
   * `X-Real-IP` como segunda opção: alguns proxies mandam só ele. Não é lista,
   * então não tem a armadilha acima — mas também é definido pelo proxy, e por
   * isso vem depois do `X-Forwarded-For`, que é o que o Caddy envia.
   */
  const real = cabecalhos.xRealIp?.trim()
  return real || null
}

/**
 * A chave que vai ao banco: hash do IP, com segredo.
 *
 * Sem o segredo, um SHA-256 de IPv4 se quebra por força bruta em minutos — são
 * quatro bilhões de possibilidades, e um computador comum percorre isso num
 * café. O segredo é o que torna o hash irreversível de verdade.
 *
 * Quando não há segredo nenhum configurado, ele ainda assim conta — o limite
 * continua funcionando, só perde a privacidade. Degradar a proteção de dados é
 * ruim; desligar a defesa em silêncio seria pior, e é o que aconteceria se esta
 * função devolvesse `null` por falta de configuração.
 */
export function origemHasheada(
  ip: string | null,
  ambiente: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (!ip) return null

  const segredo =
    ambiente.LIMITE_ORIGEM_PEPPER || ambiente.LOCAL_AUTH_SECRET || ambiente.JOBS_SECRET || ''

  if (!segredo && !avisouDoSegredo) {
    avisouDoSegredo = true
    console.warn(
      '[limite] sem LIMITE_ORIGEM_PEPPER, LOCAL_AUTH_SECRET ou JOBS_SECRET: ' +
        'o limite por origem continua valendo, mas o hash do IP fica reversível.',
    )
  }

  return createHash('sha256').update(`${segredo}:${ip}`).digest('hex')
}

let avisouDoSegredo = false

/** Os limites de cada tela pública, num lugar só. */
export const LIMITES = {
  /*
   * Cinco pedidos de redefinição por hora, da mesma origem.
   *
   * Generoso para uma pessoa — quem erra o e-mail duas vezes e tenta de novo não
   * esbarra — e inútil para quem quer varrer uma lista de dez mil endereços.
   */
  password_reset: { limite: 5, janelaSeg: 3600 },
  /* Cadastro é mais raro que redefinição: três por hora por origem. */
  signup: { limite: 3, janelaSeg: 3600 },
} as const

export type Balde = keyof typeof LIMITES

/** O mínimo do cliente que este módulo usa, para o teste não precisar de rede. */
export interface ClienteDeLimite {
  schema(nome: string): {
    rpc(
      nome: string,
      args: Record<string, unknown>,
    ): PromiseLike<{ data: unknown; error: { message?: string } | null }>
  }
}

/**
 * Pergunta ao banco se a requisição pode seguir.
 *
 * **Em caso de erro, DEIXA PASSAR.** É a decisão que mais pesa aqui, e ela é
 * deliberada: se o banco estiver indisponível, bloquear transformaria uma falha
 * de infraestrutura em "ninguém consegue redefinir a senha" — uma indisponibilidade
 * maior que a que o limite evita. O limite é defesa contra abuso, não contra
 * acesso legítimo, e falhar fechado aqui puniria sobretudo quem tem direito de
 * entrar.
 *
 * O erro vai para o log, onde o alerta de trabalho parado e a tela de avisos
 * tornam a indisponibilidade visível por outros caminhos.
 */
export async function permitirRequisicao(
  supabase: ClienteDeLimite,
  balde: Balde,
  origem: string | null,
): Promise<boolean> {
  if (!origem) return true

  const { limite, janelaSeg } = LIMITES[balde]
  try {
    const { data, error } = await supabase.schema('app').rpc('permitir_requisicao', {
      p_balde: balde,
      p_origem: origem,
      p_limite: limite,
      p_janela_seg: janelaSeg,
    })
    if (error) {
      console.error('[limite] falha ao consultar o limite:', error.message)
      return true
    }
    return data !== false
  } catch (e) {
    console.error('[limite] falha ao consultar o limite:', e)
    return true
  }
}
