import { describe, expect, it } from 'vitest'
import {
  conferir,
  conformidade,
  escreverVariacao,
  META_PADRAO_DE_SLA,
  TOLERANCIA,
  tomDaConformidade,
  tomDaVariacao,
  variacao,
} from './conferencia'

/**
 * O que estes testes protegem
 * ---------------------------
 * Três números de painel que mentem bonito:
 *
 *  - um indicador que não bate com o próprio detalhamento (os dois parecem
 *    certos sozinhos, e a divergência aparece numa reunião);
 *  - uma variação percentual sobre base zero ("+100%" quando o mês anterior não
 *    tinha lançamento nenhum);
 *  - 100% de conformidade num mês sem chamado nenhum.
 */

describe('conferir', () => {
  it('bate quando a soma do detalhe fecha no indicador', () => {
    const r = conferir(1000, [600, 400])
    expect(r.bate).toBe(true)
    expect(r.diferenca).toBe(0)
  })

  it('NÃO bate quando um filtro divergiu, e diz de quanto', () => {
    /*
     * É o defeito que esta função existe para pegar: o indicador e o detalhe
     * montados por consultas diferentes, uma com um filtro a mais. Sem a
     * conferência, os dois números convivem na mesma tela parecendo certos.
     */
    const r = conferir(1000, [600, 300])
    expect(r.bate).toBe(false)
    expect(r.diferenca).toBe(100)
    expect(r.soma).toBe(900)
  })

  it('tolera meio centavo, e não mais que isso', () => {
    // A tolerância cobre a conversão para `number` ao atravessar o JSON.
    // `numeric(14,2)` no banco é exato — mais que meio centavo é erro de verdade.
    expect(conferir(100, [99.996]).bate).toBe(true)
    expect(conferir(100, [99.98]).bate).toBe(false)
    expect(TOLERANCIA).toBeLessThan(0.01)
  })

  it('soma em centavos inteiros, não em ponto flutuante', () => {
    /*
     * Somar 0.1 + 0.2 em float dá 0.30000000000000004 — acrescentaria ao
     * resultado justamente o tipo de erro que esta função detecta.
     */
    expect(conferir(0.3, [0.1, 0.2]).bate).toBe(true)
    expect(conferir(0.3, [0.1, 0.2]).soma).toBe(0.3)
  })

  it('detalhe vazio contra indicador zero bate', () => {
    // Competência sem lançamento é caso normal, não divergência.
    expect(conferir(0, []).bate).toBe(true)
  })

  it('e detalhe vazio contra indicador diferente de zero NÃO bate', () => {
    // Este é o caso real: o indicador achou dado e o detalhe não. Quase sempre
    // um filtro de permissão divergindo entre as duas consultas.
    expect(conferir(500, []).bate).toBe(false)
  })
})

describe('variacao', () => {
  it('calcula a diferença percentual', () => {
    expect(variacao(110, 100)).toBe(10)
    expect(variacao(90, 100)).toBe(-10)
  })

  it('base zero devolve NULO, e não um percentual inventado', () => {
    /*
     * De zero para qualquer coisa a variação é infinita. Um painel que escreve
     * "+100%" está afirmando uma comparação que não existe: o mês anterior não
     * tinha lançamento nenhum.
     */
    expect(variacao(500, 0)).toBeNull()
    expect(escreverVariacao(null)).toBe('sem base de comparação')
  })

  it('em CUSTO, subir é ruim — o tom é invertido', () => {
    // É a cor que a pessoa lê antes do número, então a decisão precisa estar
    // escrita e testada.
    expect(tomDaVariacao(20)).toBe('warn')
    expect(tomDaVariacao(-20)).toBe('ok')
    expect(tomDaVariacao(1)).toBe('neutral')
    expect(tomDaVariacao(null)).toBe('neutral')
  })

  it('escreve com sinal e em português', () => {
    expect(escreverVariacao(12.3)).toContain('+12,3%')
    expect(escreverVariacao(-4)).toContain('-4,0%')
  })
})

describe('conformidade', () => {
  it('é a proporção de chamados que não estouraram', () => {
    expect(conformidade(100, 5)).toBe(95)
    expect(conformidade(3, 0)).toBe(100)
  })

  it('sem chamado com acordo devolve NULO — e isso não é 100%', () => {
    /*
     * "Nenhum estouro em nenhum chamado" é ausência de medida, não conformidade
     * perfeita. Escrever 100% faria um mês sem atendimento parecer o melhor mês
     * do ano — e é exatamente o mês em que alguém deveria perguntar o que houve.
     */
    expect(conformidade(0, 0)).toBeNull()
    expect(tomDaConformidade(null)).toBe('neutral')
  })

  it('o tom compara contra a meta', () => {
    expect(tomDaConformidade(96)).toBe('ok')
    expect(tomDaConformidade(90)).toBe('warn')
    expect(tomDaConformidade(70)).toBe('breach')
    expect(META_PADRAO_DE_SLA).toBe(95)
  })
})
