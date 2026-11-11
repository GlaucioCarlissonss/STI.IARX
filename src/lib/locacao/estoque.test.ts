import { describe, expect, it } from 'vitest'
import { descreverMovimentoDePeca, formatarQuantidade, progressoDaOrdem } from './rotulos'

/*
 * O que estes testes protegem é pequeno e fácil de errar em silêncio: o sinal
 * do movimento e a forma de medir o quanto de uma ordem já chegou.
 */

describe('descreverMovimentoDePeca', () => {
  it('escreve o sinal, e não só a cor', () => {
    expect(descreverMovimentoDePeca({ kind: 'purchase', quantity: 5, unidade: 'un' })).toBe('+5 un')
    expect(descreverMovimentoDePeca({ kind: 'consumption', quantity: -1, unidade: 'un' })).toBe(
      '−1 un',
    )
  })

  it('mostra o valor absoluto depois do sinal, sem o menos duplicado', () => {
    expect(descreverMovimentoDePeca({ kind: 'adjustment', quantity: -2.5, unidade: 'kg' })).toBe(
      '−2,5 kg',
    )
  })
})

describe('formatarQuantidade', () => {
  it('não inventa casas decimais em peça inteira', () => {
    expect(formatarQuantidade(12, 'un')).toBe('12 un')
  })

  it('mantém as casas que existem', () => {
    expect(formatarQuantidade(2.75, 'm')).toBe('2,75 m')
  })
})

describe('progressoDaOrdem', () => {
  it('mede em QUANTIDADE, e não em número de linhas', () => {
    /*
     * Uma linha de 100 unidades e outra de 1: com a linha pequena recebida, a
     * contagem de linhas diria "metade da ordem chegou" faltando 99% dela. É
     * exatamente o engano que faz alguém parar de cobrar o fornecedor.
     */
    const itens = [
      { quantity: 100, received_quantity: 0 },
      { quantity: 1, received_quantity: 1 },
    ]
    expect(progressoDaOrdem(itens)).toBeCloseTo(1 / 101, 5)
  })

  it('é 0 quando nada chegou, e 1 quando tudo chegou', () => {
    expect(progressoDaOrdem([{ quantity: 8, received_quantity: 0 }])).toBe(0)
    expect(progressoDaOrdem([{ quantity: 8, received_quantity: 8 }])).toBe(1)
  })

  it('não passa de 1 se o recebido exceder o pedido', () => {
    // O banco já recusa isso; a função não pode devolver 120% se um dia passar.
    expect(progressoDaOrdem([{ quantity: 5, received_quantity: 7 }])).toBe(1)
  })

  it('ordem sem item é 0, e não divisão por zero', () => {
    expect(progressoDaOrdem([])).toBe(0)
  })
})
