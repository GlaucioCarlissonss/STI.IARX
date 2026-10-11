/**
 * Compliance de SLA: da linha da view para a linha da tabela.
 *
 * Mora aqui, e não dentro da página, porque é aritmética pura — e aritmética
 * que decide um percentual exibido merece teste próprio, que um módulo de
 * página (cheio de `createClient` e `requireScreen`) não deixaria escrever.
 */

/**
 * Uma linha da view, que NÃO é uma linha da tabela.
 *
 * `vw_sla_compliance` agrupa por período, fila, atendente e cliente. A tabela
 * mostra período e fila — então cada linha dela é a soma de várias destas.
 *
 * Os dois percentuais que a view calcula ficaram de fora do `select` de
 * propósito: percentual não se soma. Eles são recalculados abaixo a partir dos
 * totais somados, que é a única forma de a porcentagem de um mês inteiro estar
 * certa. Trazê-los e somá-los daria um número com cara de porcentagem e sem
 * significado nenhum.
 */
export interface LinhaDeCompliance {
  period: string
  queue_name: string
  tickets_total: number
  tickets_with_sla: number
  response_breaches: number
  resolution_breaches: number
}

export interface ComplianceRow extends LinhaDeCompliance {
  resolution_compliance_pct: number | null
  response_compliance_pct: number | null
}

/**
 * Soma as linhas da view por (período, fila) e recalcula os percentuais.
 *
 * A tabela antes repetia o mesmo par "março / Suporte" uma vez por atendente,
 * cada uma com uma fatia dos tickets. A chave do React carregava um `i` no fim
 * justamente para sobreviver a isso — sinal de que o problema tinha sido visto
 * e contornado, não resolvido.
 *
 * O denominador é `tickets_with_sla` (a cobertura), e não `tickets_total`:
 * ticket que nenhuma definição alcançou não tem prazo a cumprir e não pode
 * entrar no cálculo de cumprimento. É a mesma conta da view, feita sobre a soma.
 */
export function agruparCompliance(linhas: LinhaDeCompliance[]): ComplianceRow[] {
  const mapa = new Map<string, ComplianceRow>()
  for (const l of linhas) {
    const chave = `${l.period}|${l.queue_name}`
    const atual = mapa.get(chave)
    if (atual) {
      atual.tickets_total += Number(l.tickets_total)
      atual.tickets_with_sla += Number(l.tickets_with_sla)
      atual.response_breaches += Number(l.response_breaches)
      atual.resolution_breaches += Number(l.resolution_breaches)
    } else {
      mapa.set(chave, {
        period: l.period,
        queue_name: l.queue_name,
        tickets_total: Number(l.tickets_total),
        tickets_with_sla: Number(l.tickets_with_sla),
        response_breaches: Number(l.response_breaches),
        resolution_breaches: Number(l.resolution_breaches),
        resolution_compliance_pct: null,
        response_compliance_pct: null,
      })
    }
  }

  const pct = (cobertos: number, violacoes: number) =>
    cobertos === 0 ? null : Math.round(((cobertos - violacoes) / cobertos) * 10000) / 100

  return [...mapa.values()].map((r) => ({
    ...r,
    resolution_compliance_pct: pct(r.tickets_with_sla, r.resolution_breaches),
    response_compliance_pct: pct(r.tickets_with_sla, r.response_breaches),
  }))
}
