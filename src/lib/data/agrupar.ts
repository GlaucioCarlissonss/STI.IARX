/**
 * Agrupa linhas por uma chave estrangeira.
 *
 * O laço abaixo estava copiado em **10 páginas**, sempre com a mesma forma:
 *
 * ```ts
 * const anexosPorTicket = new Map<string, Anexo[]>()
 * for (const a of anexos ?? []) {
 *   anexosPorTicket.set(a.ticket_id, [...(anexosPorTicket.get(a.ticket_id) ?? []), a])
 * }
 * ```
 *
 * Ele existe por um bom motivo e continua existindo: é o que evita o N+1 — uma
 * consulta traz todos os filhos de uma vez e o agrupamento acontece em memória,
 * em vez de uma consulta por pai. O que muda é só a repetição.
 *
 * A versão de lá reconstruía o array a cada item (`[...anterior, novo]`), o que é
 * quadrático. Esta empurra no array existente. Na prática a diferença só aparece
 * em lista grande — mas é de graça.
 */
export function agruparPor<T, K extends keyof T>(
  linhas: readonly T[] | null | undefined,
  chave: K,
): Map<T[K], T[]> {
  const mapa = new Map<T[K], T[]>()
  for (const linha of linhas ?? []) {
    const k = linha[chave]
    const atual = mapa.get(k)
    if (atual) atual.push(linha)
    else mapa.set(k, [linha])
  }
  return mapa
}
