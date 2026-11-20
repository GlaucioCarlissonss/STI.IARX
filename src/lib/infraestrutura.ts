/**
 * "O banco não respondeu" é uma causa, e não um sintoma de conta.
 *
 * ## O defeito que este arquivo existe para impedir
 *
 * Com o PostgreSQL parado, o que a pessoa lia dependia de qual consulta falhava
 * primeiro, e nenhuma das saídas servia:
 *
 *  · **medido e reproduzível:** "O sistema não conseguiu abrir. A falha foi
 *    registrada. Tente de novo; se continuar, avise o suporte." Honesto, e
 *    insuficiente — não diz que a conta está bem, não diz a quem avisar, e
 *    quem está sem entrar vai desconfiar da própria senha;
 *
 *  · **visto uma vez, não reproduzível sob demanda** (com o servidor iniciado
 *    contra um banco já morto): "A sua sessão foi encerrada porque esta conta
 *    está desativada. Procure o administrador da sua empresa para reativá-la."
 *    Nada ali era verdade, e o pior não é a imprecisão: é o CONSELHO. Manda
 *    procurar quem não pode ajudar, enquanto quem poderia — quem cuida do
 *    servidor — não é avisado de nada.
 *
 * A causa do segundo é uma só: `getSessionContext()` devolvia `null` para três
 * situações diferentes — sem cookie, perfil não lido e conta inativa — e quem
 * recebia o `null` traduzia as três para a terceira. Com o erro da consulta
 * descartado, "o banco não respondeu" virava "a sua conta está desativada".
 *
 * ## Por que a lista é por CÓDIGO, e não por texto da mensagem
 *
 * Mensagem de driver muda de versão para versão e é traduzida pelo sistema
 * operacional. Código de `errno` e `SQLSTATE` não mudam — e interface que
 * ramifica por texto quebra na primeira melhoria de redação.
 *
 * O texto entra só como rede de segurança, para o caso de a falha chegar
 * embrulhada por alguma camada que perdeu o código no caminho.
 */

/**
 * Códigos de sistema: a conexão não chegou a existir.
 *
 * São de `errno`, postos pelo Node em erros de socket — não pelo PostgreSQL,
 * que nestes casos nunca foi alcançado.
 */
const ERRNO = new Set([
  'ECONNREFUSED', // nada escutando na porta: o banco está parado
  'ENOTFOUND', // o nome não resolve: DNS, ou o host errado no DATABASE_URL
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT', // a rede engoliu o pacote; comum com firewall no meio
  'ECONNRESET', // o banco caiu com a conexão aberta
  'EPIPE',
])

/**
 * `SQLSTATE` da classe 08 (falha de conexão) e os três da 53/57 que significam
 * "o servidor existe e não pode atender agora".
 *
 * Estes são diferentes dos de ERRNO: aqui o PostgreSQL respondeu, dizendo que
 * não dá. Continua não sendo problema da conta de quem está na tela.
 */
const SQLSTATE = new Set([
  '08000',
  '08003',
  '08006',
  '08001',
  '08004',
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now — o banco está subindo
])

const TEXTO = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|connection (refused|terminated|closed)|server closed the connection|Connection terminated/i

/**
 * A falha impediu o sistema de falar com o banco?
 *
 * Aceita `unknown` porque chega de três lugares com formatos diferentes: o
 * objeto de erro do `pg`, o `{ code, message }` que o driver devolve, e o que
 * for que um `catch` pegou.
 */
export function ehFalhaDeInfraestrutura(erro: unknown): boolean {
  if (!erro || typeof erro !== 'object') return false

  const e = erro as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown }

  const codigo = typeof e.code === 'string' ? e.code : ''
  if (ERRNO.has(codigo) || SQLSTATE.has(codigo)) return true

  /* `errno` numérico negativo (-111 para ECONNREFUSED) aparece quando o erro
     passou por uma camada que preservou o número e perdeu o nome. */
  if (typeof e.errno === 'string' && ERRNO.has(e.errno)) return true

  const texto = typeof e.message === 'string' ? e.message : ''
  if (TEXTO.test(texto)) return true

  /* Erro embrulhado: `new Error('falhou', { cause: erroOriginal })`. Sem olhar
     a causa, um embrulho de uma linha esconde a classificação inteira. */
  if (e.cause) return ehFalhaDeInfraestrutura(e.cause)

  return false
}

/**
 * O que a pessoa lê quando o sistema não alcançou o banco.
 *
 * Três coisas, e as três são deliberadas:
 *
 *  1. diz que **não é a conta dela** — senão ela vai tentar outra senha, pedir
 *     redefinição e procurar o administrador da empresa, três caminhos que não
 *     levam a lugar nenhum;
 *  2. diz a quem avisar: quem cuida do servidor, não quem administra a empresa;
 *  3. não diz host, porta nem nome de banco. Isso está no log, que é onde serve.
 */
export const AVISO_DE_INDISPONIBILIDADE =
  'O sistema não conseguiu falar com o banco de dados. Isto não é problema da sua conta nem da ' +
  'sua senha — avise quem cuida do servidor e tente de novo em alguns minutos.'

/** Código estável para a interface ramificar sem depender da frase acima. */
export const CODIGO_INDISPONIVEL = 'banco_indisponivel'
