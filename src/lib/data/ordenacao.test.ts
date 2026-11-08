import { describe, expect, it } from 'vitest'
import { ORDENS_DE_TICKET, lerOrdem, proximaDirecao } from './ordenacao'

/**
 * O que estes testes protegem, em uma frase: nenhum texto vindo da barra de
 * endereço pode virar nome de coluna numa consulta.
 */
describe('lerOrdem', () => {
  it('aceita só o que está no mapa', () => {
    expect(lerOrdem(ORDENS_DE_TICKET, 'prazo', undefined, 'score').coluna).toBe(
      'minutes_to_resolution_due',
    )
  })

  it('cai no padrão diante de qualquer coisa que alguém digite na URL', () => {
    for (const tentativa of [
      'title; drop table tickets',
      'tenant_id',
      '(select 1)',
      '',
      'TÍTULO',
      '__proto__',
      'constructor',
    ]) {
      const ordem = lerOrdem(ORDENS_DE_TICKET, tentativa, undefined, 'score')
      expect(ordem.chave).toBe('score')
      expect(ordem.coluna).toBe('queue_score')
    }
  })

  it('a coluna que sai É SEMPRE uma das escritas no código', () => {
    const permitidas = Object.values(ORDENS_DE_TICKET).map((c) => c.coluna)
    for (const chave of [...Object.keys(ORDENS_DE_TICKET), 'inventado', 'profiles.email']) {
      expect(permitidas).toContain(lerOrdem(ORDENS_DE_TICKET, chave, 'asc', 'score').coluna)
    }
  })

  it('a direção padrão depende da coluna: prazo sobe, prioridade desce', () => {
    expect(lerOrdem(ORDENS_DE_TICKET, 'prazo', undefined, 'score').asc).toBe(true)
    expect(lerOrdem(ORDENS_DE_TICKET, 'prioridade', undefined, 'score').asc).toBe(false)
  })

  it('mas a direção explícita na URL manda', () => {
    expect(lerOrdem(ORDENS_DE_TICKET, 'prazo', 'desc', 'score').asc).toBe(false)
    expect(lerOrdem(ORDENS_DE_TICKET, 'prioridade', 'asc', 'score').asc).toBe(true)
  })

  it('direção malformada não quebra nada; vale o padrão da coluna', () => {
    expect(lerOrdem(ORDENS_DE_TICKET, 'prazo', 'ASCENDENTE', 'score').asc).toBe(true)
  })
})

describe('proximaDirecao', () => {
  it('clicar na coluna que já ordena inverte', () => {
    const atual = lerOrdem(ORDENS_DE_TICKET, 'prazo', 'asc', 'score')
    expect(proximaDirecao(ORDENS_DE_TICKET, atual, 'prazo')).toBe('desc')
  })

  it('clicar em outra começa pela direção útil dela', () => {
    const atual = lerOrdem(ORDENS_DE_TICKET, 'prazo', 'asc', 'score')
    expect(proximaDirecao(ORDENS_DE_TICKET, atual, 'prioridade')).toBe('desc')
    expect(proximaDirecao(ORDENS_DE_TICKET, atual, 'titulo')).toBe('asc')
  })
})
