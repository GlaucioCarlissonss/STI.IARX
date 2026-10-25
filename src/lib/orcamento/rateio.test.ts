import { describe, expect, it } from 'vitest'
import {
  emReais,
  MAXIMO_DE_OCORRENCIAS,
  ocorrenciasDaRecorrencia,
  ratear,
  ROTULO_DA_ORIGEM,
  somar,
} from './rateio'

/**
 * A propriedade que estes testes protegem
 * ---------------------------------------
 * **A soma das parcelas fecha exatamente no total.** Um centavo de diferença por
 * contrato, em cem contratos, é o tipo de erro que ninguém encontra depois — e
 * que aparece só quando o cliente confere a planilha contra a nota.
 *
 * O teste roda sobre muitos totais e divisores de propósito: o caso que quebra
 * nunca é 100 em 2, é 1.000,01 em 7.
 */

describe('ratear', () => {
  it('a soma fecha exatamente, para qualquer total e qualquer divisor', () => {
    for (const total of [100, 100.01, 0.03, 1000.01, 1234.56, 9999.99, 0.01, 7, 33.33]) {
      for (const n of [1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 24, 36]) {
        const partes = ratear(total, n)
        expect(partes).toHaveLength(n)
        expect(somar(partes)).toBeCloseTo(total, 2)
      }
    }
  })

  it('o resto vai nas PRIMEIRAS parcelas', () => {
    // 100,00 em 3 é 33,34 + 33,33 + 33,33 — convenção comercial brasileira, e o
    // que faz a soma bater com o valor do contrato.
    expect(ratear(100, 3)).toEqual([33.34, 33.33, 33.33])
    expect(ratear(0.03, 2)).toEqual([0.02, 0.01])
  })

  it('divisão exata não inventa centavo', () => {
    expect(ratear(100, 4)).toEqual([25, 25, 25, 25])
  })

  it('uma parcela devolve o total', () => {
    expect(ratear(1234.56, 1)).toEqual([1234.56])
  })

  it('não quebra com entrada inválida', () => {
    for (const [t, n] of [
      [-1, 3],
      [100, 0],
      [100, -1],
      [100, 1.5],
      [Number.NaN, 3],
      [Number.POSITIVE_INFINITY, 3],
    ] as const) {
      expect(ratear(t, n)).toEqual([])
    }
  })

  it('trabalha em centavos inteiros, e isso não é preciosismo', () => {
    /*
     * `0.1 + 0.2` é `0.30000000000000004` em JavaScript. Somar cem parcelas em
     * ponto flutuante erra o total de verdade — e o erro cresce com o número de
     * parcelas, que é exatamente o caso de um contrato longo.
     */
    const partes = ratear(0.3, 3)
    expect(somar(partes)).toBe(0.3)
  })
})

describe('somar', () => {
  it('soma sem erro de ponto flutuante', () => {
    expect(somar([0.1, 0.2])).toBe(0.3)
    expect(somar([])).toBe(0)
  })
})

describe('ocorrências da recorrência', () => {
  it('conta as duas pontas', () => {
    expect(ocorrenciasDaRecorrencia('2026-01-01', '2026-03-01', '2026-12-01')).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ])
  })

  it('vigência em aberto projeta até o horizonte pedido', () => {
    /*
     * NULO = contrato em vigor. Encerrar um contrato é cadastrar a vigência
     * dele; supor uma data que ninguém informou inventaria o fim de contratos
     * que estão valendo.
     */
    const r = ocorrenciasDaRecorrencia('2026-01-01', null, '2026-06-01')
    expect(r).toHaveLength(6)
    expect(r[r.length - 1]).toBe('2026-06-01')
  })

  it('vigência depois do horizonte é cortada no horizonte', () => {
    const r = ocorrenciasDaRecorrencia('2026-01-01', '2030-01-01', '2026-03-01')
    expect(r).toHaveLength(3)
  })

  it('atravessa o ano', () => {
    expect(ocorrenciasDaRecorrencia('2026-11-01', '2027-02-01', '2027-12-01')).toEqual([
      '2026-11-01',
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
    ])
  })

  it('tem teto, porque ano digitado errado geraria milhares de linhas', () => {
    expect(ocorrenciasDaRecorrencia('2026-01-01', null, '2206-01-01')).toHaveLength(
      MAXIMO_DE_OCORRENCIAS,
    )
  })

  it('fim anterior ao início devolve nada, em vez de contar para trás', () => {
    expect(ocorrenciasDaRecorrencia('2026-06-01', '2026-01-01', '2026-12-01')).toEqual([])
  })
})

describe('rótulos', () => {
  it('a origem cobre as quatro procedências do banco', () => {
    /*
     * As quatro do CHECK de `it_cost_entries.origem`. Uma origem sem rótulo
     * apareceria crua na tela de conferência — justamente a tela que existe para
     * tornar o total verificável.
     */
    expect(Object.keys(ROTULO_DA_ORIGEM).sort()).toEqual([
      'manual',
      'planilha',
      'projecao',
      'titulo_a_pagar',
    ])
  })
})

describe('emReais', () => {
  it('escreve em moeda brasileira', () => {
    expect(emReais(1234.5)).toContain('1.234,50')
    expect(emReais(0)).toContain('0,00')
  })
})
