import type { Route } from 'next'

/**
 * Paginação das listagens.
 *
 * ## O que havia antes
 *
 * Nenhuma página usava `.range()`. Em vez disso, três telas tinham um teto fixo
 * — `/tickets` em 200, `/inventario` em 400, `/conectividade/links` em 300 — e
 * as outras cinco não tinham teto nenhum.
 *
 * Os dois comportamentos são ruins, por motivos opostos:
 *
 * - **O teto mente.** A consulta corta em 200 e a tela não diz nada. Quem tem
 *   240 tickets abertos trabalha a semana inteira sem saber que 40 existem.
 *   Não há erro, não há aviso, não há sintoma: há 200 linhas e uma lista que
 *   parece completa.
 * - **A ausência de teto trava.** `/financeiro/titulos-a-pagar` traz todos os
 *   títulos, de todos os meses, com todas as colunas. Com alguns milhares de
 *   linhas isso é megabytes de JSON por visita, e o travamento vem de uma vez,
 *   no dia em que o acervo cresce — não aos poucos.
 *
 * ## Por que 50
 *
 * É o que cabe em duas rolagens de tela cheia sem virar uma tabela infinita, e
 * é pequeno o bastante para a consulta voltar rápido mesmo sem índice quente.
 * O número é uma decisão de ergonomia, não de desempenho: abaixo disso a pessoa
 * passa o dia clicando em "próxima".
 *
 * ## O que a paginação NÃO pode quebrar
 *
 * Os indicadores no alto dessas telas eram calculados a partir da lista inteira
 * (`lista.filter(...).length`). Paginando a consulta sem mais nada, eles
 * passariam a contar só a página visível — e "Ativos cadastrados: 50" numa
 * empresa com 412 equipamentos é pior que a truncagem que estamos corrigindo.
 * Por isso a migração 0028 criou as views de agregado, e cada tela paginada lê
 * os seus totais de lá.
 */

/** Linhas por página. */
export const TAMANHO_PADRAO = 50

export interface Pagina {
  /** 1-based, como aparece na barra de endereço. */
  numero: number
  /** Primeiro índice, 0-based, para `.range()`. */
  de: number
  /** Último índice, inclusive. */
  ate: number
  tamanho: number
}

/**
 * Lê `?pagina=` da barra de endereço.
 *
 * Tolera o absurdo em silêncio — `?pagina=abc`, `?pagina=-3`, `?pagina=1e9` —
 * porque o parâmetro vem de um link que alguém pode editar, e uma tela de erro
 * por causa de um número malformado na URL não ajuda ninguém. Fora da faixa, a
 * consulta simplesmente volta vazia, e o rodapé mostra "0 de N" com o caminho de
 * volta à primeira página.
 */
export function lerPagina(bruto: string | undefined, tamanho = TAMANHO_PADRAO): Pagina {
  const n = Number(bruto)
  const numero = Number.isInteger(n) && n >= 1 ? Math.min(n, 100_000) : 1
  const de = (numero - 1) * tamanho
  return { numero, de, ate: de + tamanho - 1, tamanho }
}

/**
 * O mínimo que um construtor de consulta precisa expor para ser paginado.
 *
 * Mesma conversão de `escopo.ts`, pelo mesmo motivo e com a mesma garantia: o
 * tipo do `PostgrestFilterBuilder` é condicional sobre o schema inteiro, e
 * passá-lo por um genérico `T extends Paginavel<T>` estoura em `TS2589`.
 * `.range()` devolve `this` no próprio postgrest-js, então `as T` descreve o que
 * acontece em execução.
 */
interface Paginavel {
  range(de: number, ate: number): Paginavel
}

export function paginar<T>(consulta: T, pagina: Pagina): T {
  return (consulta as Paginavel).range(pagina.de, pagina.ate) as T
}

/** O total que o PostgREST devolve em `count` é o de ANTES do `range`. */
export function totalDePaginas(total: number, tamanho = TAMANHO_PADRAO): number {
  return Math.max(1, Math.ceil(total / tamanho))
}

/**
 * Monta o endereço de uma página preservando os demais parâmetros.
 *
 * Preservar os filtros é o ponto: sem isso, ir para a página 2 de uma busca
 * devolveria a página 2 da lista inteira, e a pessoa concluiria que a busca
 * tinha "zerado" — comportamento que parece defeito do filtro, não da paginação.
 */
export function enderecoDaPagina(
  base: string,
  params: Record<string, string | undefined>,
  numero: number,
): Route {
  const busca = new URLSearchParams()
  for (const [chave, valor] of Object.entries(params)) {
    if (valor && chave !== 'pagina') busca.set(chave, valor)
  }
  // Página 1 não carrega o parâmetro: o endereço limpo é o que se copia e cola.
  if (numero > 1) busca.set('pagina', String(numero))
  const qs = busca.toString()
  return (qs ? `${base}?${qs}` : base) as Route
}
