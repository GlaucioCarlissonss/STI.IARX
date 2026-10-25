/**
 * A conferência que o painel faz de si mesmo.
 *
 * ## O contrato de leitura do painel do GSTI
 *
 * > *"a soma do detalhe conferida contra o indicador na própria tela"*
 *
 * É a melhor ideia daquele painel, e a razão é concreta: **um indicador que não
 * bate com o próprio detalhamento é o defeito mais caro de um painel de
 * gestão.** Os dois números parecem certos sozinhos; a divergência só aparece
 * quando alguém compara — e quem compara geralmente é o cliente, numa reunião.
 *
 * A causa é quase sempre a mesma: o indicador e o detalhe foram montados por
 * consultas diferentes, e um filtro divergiu. Conferir na tela não impede o
 * erro; faz ele aparecer **para quem está olhando**, no instante em que acontece,
 * em vez de três meses depois.
 *
 * ## Por que a tolerância existe, e por que ela é tão pequena
 *
 * `numeric(14,2)` no banco é decimal exato, então a soma de dinheiro deveria
 * fechar na casa do centavo. A tolerância de meio centavo cobre o único
 * arredondamento real do caminho: a conversão para `number` em JavaScript ao
 * atravessar o JSON. Mais que isso seria tolerar um erro de verdade.
 */

/** Meio centavo. Acima disto, a divergência é real e precisa aparecer. */
export const TOLERANCIA = 0.005

export interface Conferencia {
  bate: boolean
  indicador: number
  soma: number
  diferenca: number
}

export function conferir(indicador: number, detalhe: readonly number[]): Conferencia {
  /* Em centavos inteiros: somar em ponto flutuante acrescentaria ao resultado
     justamente o tipo de erro que esta função existe para detectar. */
  const soma = detalhe.reduce((s, v) => s + Math.round(v * 100), 0) / 100
  const diferenca = Math.round((indicador - soma) * 100) / 100
  return {
    bate: Math.abs(diferenca) <= TOLERANCIA,
    indicador,
    soma,
    diferenca,
  }
}

/**
 * Variação percentual entre dois meses.
 *
 * Devolve `null` quando o mês anterior é zero. Não é preciosismo: a variação de
 * zero para qualquer coisa é infinita, e um painel que escreve "+∞%" ou "+100%"
 * está inventando — o mês anterior não tinha lançamento nenhum, e a comparação
 * não existe.
 */
export function variacao(atual: number, anterior: number): number | null {
  if (anterior === 0) return null
  return Math.round(((atual - anterior) / anterior) * 1000) / 10
}

/**
 * Como a tela escreve uma variação.
 *
 * Em custo, subir é ruim — então o tom é invertido em relação ao que um painel
 * de receita usaria. É uma decisão que precisa estar escrita, porque a cor é o
 * que a pessoa lê antes do número.
 */
export function tomDaVariacao(pct: number | null): 'ok' | 'warn' | 'neutral' {
  if (pct === null) return 'neutral'
  if (pct > 5) return 'warn'
  if (pct < -5) return 'ok'
  return 'neutral'
}

export function escreverVariacao(pct: number | null): string {
  if (pct === null) return 'sem base de comparação'
  const sinal = pct > 0 ? '+' : ''
  return `${sinal}${pct.toFixed(1).replace('.', ',')}% em relação ao mês anterior`
}

/**
 * O percentual de conformidade a partir dos chamados com acordo e dos estouros.
 *
 * Devolve `null` quando não há chamado com acordo — e isso **não é 100%**.
 * "Nenhum estouro em nenhum chamado" é ausência de medida, não conformidade
 * perfeita; escrever 100% ali faria um mês sem atendimento parecer o melhor mês
 * do ano.
 */
export function conformidade(comAcordo: number, fora: number): number | null {
  if (comAcordo <= 0) return null
  return Math.round(((comAcordo - fora) / comAcordo) * 1000) / 10
}

/** Tom da conformidade contra uma meta. Sem meta, o padrão de mercado: 95%. */
export const META_PADRAO_DE_SLA = 95

export function tomDaConformidade(pct: number | null, meta = META_PADRAO_DE_SLA) {
  if (pct === null) return 'neutral' as const
  if (pct >= meta) return 'ok' as const
  if (pct >= meta - 10) return 'warn' as const
  return 'breach' as const
}
