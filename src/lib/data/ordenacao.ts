/**
 * Ordenação vinda da barra de endereço.
 *
 * ## Por que existe uma lista branca, e por que ela é o módulo inteiro
 *
 * A coluna de ordenação chega pela URL — `?ordem=prazo` — e a URL é digitável.
 * Passar esse texto adiante para o `.order()` seria entregar um nome de coluna
 * escolhido por quem acessa: na melhor hipótese um erro 500 com nome de coluna
 * do banco na mensagem, na pior um canal para sondar o schema. Aqui a chave da
 * URL é apenas um ÍNDICE num mapa escrito no código; o que sai é sempre uma das
 * colunas que o mapa contém, ou o padrão. Não existe caminho em que um texto de
 * fora chegue à consulta.
 *
 * ## Por que a direção padrão varia por coluna
 *
 * Porque o que a pessoa quer ver primeiro varia. Em "prazo", o útil é o que
 * vence antes (crescente). Em "prioridade", o crítico (decrescente). Fixar uma
 * direção só obrigaria a dois cliques em metade das colunas — e o primeiro
 * clique mostraria justamente o que ninguém procura: os chamados mais folgados
 * no topo de uma lista de urgências.
 */

export interface Coluna {
  /** A coluna real, no banco. Nunca vem de fora. */
  coluna: string
  /** Direção do PRIMEIRO clique. */
  ascPadrao: boolean
}

export interface Ordem {
  /** A chave pública, que aparece na URL e volta para os links do cabeçalho. */
  chave: string
  coluna: string
  asc: boolean
}

/**
 * As colunas por que a lista de tickets pode ser ordenada.
 *
 * `score` é o padrão e não tem cabeçalho clicável: é a ordenação de trabalho
 * (criticidade + prazo + espera) calculada pela view, e é o que a tela mostra
 * para quem chega sem pedir nada.
 */
export const ORDENS_DE_TICKET: Record<string, Coluna> = {
  score: { coluna: 'queue_score', ascPadrao: false },
  numero: { coluna: 'ticket_number', ascPadrao: false },
  titulo: { coluna: 'title', ascPadrao: true },
  status: { coluna: 'status', ascPadrao: true },
  prioridade: { coluna: 'priority_weight', ascPadrao: false },
  fila: { coluna: 'queue_name', ascPadrao: true },
  atendente: { coluna: 'assignee_name', ascPadrao: true },
  prazo: { coluna: 'minutes_to_resolution_due', ascPadrao: true },
}

/**
 * Lê `?ordem=` e `?dir=` com a tolerância de quem sabe que o endereço é editável:
 * qualquer coisa fora do mapa cai no padrão, em silêncio. Uma tela de erro
 * porque alguém apagou uma letra da URL não ajuda ninguém.
 */
export function lerOrdem(
  colunas: Record<string, Coluna>,
  bruto: string | undefined,
  dir: string | undefined,
  padrao: string,
): Ordem {
  /*
   * `Object.hasOwn`, e não `bruto in colunas`: `in` percorre o protótipo, então
   * `?ordem=__proto__` e `?ordem=constructor` davam "chave conhecida" num
   * objeto literal. O que saía dali não era uma coluna — era `Object.prototype`
   * — e `.order(undefined)` vira erro de servidor numa tela de lista. O teste
   * `ordenacao.test.ts` pegou isto; a lista branca só é branca se a conferência
   * olhar apenas o que o objeto tem de seu.
   */
  const chave = bruto && Object.hasOwn(colunas, bruto) ? bruto : padrao
  const alvo = Object.hasOwn(colunas, chave) ? colunas[chave] : colunas[padrao]
  const asc = dir === 'asc' ? true : dir === 'desc' ? false : alvo.ascPadrao
  return { chave, coluna: alvo.coluna, asc }
}

/**
 * A direção que o PRÓXIMO clique naquele cabeçalho deve pedir.
 *
 * Clicar na coluna que já ordena inverte; clicar em outra começa pela direção
 * padrão dela. É o comportamento que toda planilha tem, e é o que as pessoas
 * tentam sem ler nada.
 */
export function proximaDirecao(
  colunas: Record<string, Coluna>,
  atual: Ordem,
  chave: string,
): 'asc' | 'desc' {
  if (atual.chave === chave) return atual.asc ? 'desc' : 'asc'
  const alvo = Object.hasOwn(colunas, chave) ? colunas[chave] : undefined
  return (alvo?.ascPadrao ?? true) ? 'asc' : 'desc'
}
