import { describe, expect, it } from 'vitest'
import { calcularFatura, limitesDaCompetencia, totalDaFatura } from './fatura'
import type { AlocacaoParaFatura } from './fatura'

const base: AlocacaoParaFatura = {
  contract_item_id: 'i1',
  equipment_id: 'e1',
  asset_tag: 'EQP-0412',
  descricao: 'Concentrador O2 5L',
  monthly_price: 1500,
  franchise: 100,
  excess_price: 10,
  delivered_on: null,
  returned_on: null,
  meter_inicio: null,
  meter_fim: null,
}

describe('limitesDaCompetencia', () => {
  it('pega o mês inteiro, inclusive em fevereiro', () => {
    expect(limitesDaCompetencia('2026-02-01').dias).toBe(28)
    expect(limitesDaCompetencia('2024-02-01').dias).toBe(29)
    expect(limitesDaCompetencia('2026-11-01').dias).toBe(30)
  })
})

describe('locação do período', () => {
  it('mês cheio cobra o preço cheio, e não diz "proporcional"', () => {
    const [linha] = calcularFatura('2026-11-01', [base])
    expect(linha!.amount).toBe(1500)
    expect(linha!.description).not.toMatch(/proporcional/i)
    expect(linha!.days).toBe(30)
  })

  it('entrega no dia 20 cobra 11 dias — o dia da entrega é dia de uso', () => {
    const [linha] = calcularFatura('2026-11-01', [{ ...base, delivered_on: '2026-11-20' }])
    // 11 dias de 30: 1500 × 11/30 = 550
    expect(linha!.days).toBe(11)
    expect(linha!.amount).toBe(550)
    expect(linha!.description).toMatch(/11\/30 dias/)
  })

  it('devolução no meio do mês cobra só até ela', () => {
    const [linha] = calcularFatura('2026-11-01', [{ ...base, returned_on: '2026-11-10' }])
    expect(linha!.days).toBe(10)
    expect(linha!.amount).toBe(500)
  })

  it('alocação que não encostou na competência não gera linha', () => {
    const linhas = calcularFatura('2026-11-01', [
      { ...base, delivered_on: '2026-12-01' },
      { ...base, returned_on: '2026-10-20' },
    ])
    expect(linhas).toHaveLength(0)
  })
})

describe('excedente de franquia', () => {
  it('cobra só o que passou da franquia', () => {
    const linhas = calcularFatura('2026-11-01', [
      { ...base, meter_inicio: 1000, meter_fim: 1150 },
    ])
    const excedente = linhas.find((l) => l.kind === 'excess')
    // consumo 150, franquia 100, excedente 50 × R$ 10 = 500
    expect(excedente?.quantity).toBe(50)
    expect(excedente?.amount).toBe(500)
    expect(excedente?.meter_from).toBe(1000)
  })

  it('consumo dentro da franquia não vira linha', () => {
    const linhas = calcularFatura('2026-11-01', [
      { ...base, meter_inicio: 1000, meter_fim: 1080 },
    ])
    expect(linhas.filter((l) => l.kind === 'excess')).toHaveLength(0)
  })

  it('SEM leitura, nenhuma linha de excedente — e isso não é zero cobrado', () => {
    /*
     * A distinção que o módulo defende: "não medimos" e "medimos e deu zero"
     * são fatos diferentes. Uma linha zerada diria o segundo quando o caso é o
     * primeiro, e é assim que uma fatura perde a confiança de quem confere.
     */
    const linhas = calcularFatura('2026-11-01', [{ ...base, meter_inicio: null, meter_fim: 1200 }])
    expect(linhas.filter((l) => l.kind === 'excess')).toHaveLength(0)
  })

  it('a franquia é proporcional junto com a locação', () => {
    // Entrou no dia 16: 15 dias de 30, meia franquia (50), consumo 120 → 70 de excedente.
    const linhas = calcularFatura('2026-11-01', [
      { ...base, delivered_on: '2026-11-16', meter_inicio: 1000, meter_fim: 1120 },
    ])
    const excedente = linhas.find((l) => l.kind === 'excess')
    expect(excedente?.quantity).toBe(70)
    expect(excedente?.amount).toBe(700)
  })

  it('sem preço de excedente combinado, não se cobra excedente', () => {
    const linhas = calcularFatura('2026-11-01', [
      { ...base, excess_price: null, meter_inicio: 1000, meter_fim: 9999 },
    ])
    expect(linhas.filter((l) => l.kind === 'excess')).toHaveLength(0)
  })
})

describe('totalDaFatura', () => {
  it('é a soma das linhas, em centavos exatos', () => {
    const linhas = calcularFatura('2026-11-01', [
      { ...base, delivered_on: '2026-11-20', meter_inicio: 1000, meter_fim: 1150 },
    ])
    // 550 de locação proporcional + excedente (150 − 36.67 de franquia) × 10
    expect(totalDaFatura(linhas)).toBe(
      linhas.reduce((s, l) => s + l.amount, 0),
    )
    expect(Number.isInteger(totalDaFatura(linhas) * 100)).toBe(true)
  })
})
