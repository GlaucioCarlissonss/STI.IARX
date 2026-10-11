import { describe, expect, it } from 'vitest'
import { agruparCompliance, type LinhaDeCompliance } from './compliance'

/**
 * O defeito que esta função corrige valia um teste próprio.
 *
 * `vw_sla_compliance` agrupa por período, fila, **atendente** e cliente. A
 * tabela de `/sla` mostra período e fila — então ela repetia "março / Suporte"
 * uma vez por atendente, cada linha com uma fatia dos tickets, e quem lesse
 * pegava a primeira. A chave do React carregava um índice no fim justamente
 * para sobreviver às repetições: o problema tinha sido visto e contornado.
 */

const linha = (p: Partial<LinhaDeCompliance> = {}): LinhaDeCompliance => ({
  period: '2026-03-01',
  queue_name: 'Suporte',
  tickets_total: 0,
  tickets_with_sla: 0,
  response_breaches: 0,
  resolution_breaches: 0,
  ...p,
})

describe('agruparCompliance', () => {
  it('junta as linhas do mesmo mês e fila numa só', () => {
    const r = agruparCompliance([
      linha({ tickets_total: 10, tickets_with_sla: 8 }),
      linha({ tickets_total: 6, tickets_with_sla: 6 }),
    ])
    expect(r).toHaveLength(1)
    expect(r[0]!.tickets_total).toBe(16)
    expect(r[0]!.tickets_with_sla).toBe(14)
  })

  it('e mantém separados o que de fato é diferente', () => {
    const r = agruparCompliance([
      linha({ queue_name: 'Suporte' }),
      linha({ queue_name: 'Infra' }),
      linha({ period: '2026-02-01', queue_name: 'Suporte' }),
    ])
    expect(r).toHaveLength(3)
  })

  it('recalcula o percentual sobre a soma, em vez de somar percentuais', () => {
    /*
     * Dois atendentes: um com 90 cobertos e 9 violações (90%), outro com 10
     * cobertos e 9 violações (10%). A média dos percentuais daria 50%. O
     * número certo é 82% — 18 violações em 100 cobertos —, e a diferença entre
     * os dois é a conversa inteira numa reunião de SLA.
     */
    const r = agruparCompliance([
      linha({ tickets_with_sla: 90, resolution_breaches: 9 }),
      linha({ tickets_with_sla: 10, resolution_breaches: 9 }),
    ])
    expect(r[0]!.resolution_compliance_pct).toBe(82)
  })

  it('usa a cobertura como denominador, não o total de tickets', () => {
    // Ticket que nenhuma definição alcançou não tem prazo a cumprir: incluí-lo
    // no denominador puniria a equipe por um buraco de configuração.
    const r = agruparCompliance([
      linha({ tickets_total: 100, tickets_with_sla: 50, resolution_breaches: 5 }),
    ])
    expect(r[0]!.resolution_compliance_pct).toBe(90)
  })

  it('sem nenhum ticket coberto o percentual é nulo, e não 0% nem 100%', () => {
    /*
     * As duas alternativas mentem em direções opostas: 0% acusa a equipe de
     * falhar em tickets que não tinham prazo, e 100% comemora um mês em que
     * nada foi medido. Nulo vira "—" na tela, que é a verdade.
     */
    const r = agruparCompliance([linha({ tickets_total: 30, tickets_with_sla: 0 })])
    expect(r[0]!.resolution_compliance_pct).toBeNull()
    expect(r[0]!.response_compliance_pct).toBeNull()
  })

  it('arredonda em duas casas, como a view fazia', () => {
    const r = agruparCompliance([linha({ tickets_with_sla: 3, resolution_breaches: 1 })])
    expect(r[0]!.resolution_compliance_pct).toBe(66.67)
  })

  it('resposta e resolução são contadas separadamente', () => {
    const r = agruparCompliance([
      linha({ tickets_with_sla: 10, response_breaches: 1, resolution_breaches: 4 }),
    ])
    expect(r[0]!.response_compliance_pct).toBe(90)
    expect(r[0]!.resolution_compliance_pct).toBe(60)
  })

  it('lista vazia devolve lista vazia, sem linha fantasma', () => {
    expect(agruparCompliance([])).toEqual([])
  })
})
