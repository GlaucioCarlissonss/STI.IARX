import { describe, expect, it } from 'vitest'
import { formatMonth } from './format'

/**
 * Só `formatMonth`, e não o arquivo inteiro: os outros formatadores são chamadas
 * diretas a `Intl` e testá-los seria testar a plataforma. Este tem lógica própria
 * — quebra a string em vez de entregá-la ao construtor de `Date` — e é aí que mora
 * o defeito que o teste impede.
 */
describe('formatMonth', () => {
  it('rotula o mês de uma data pura do banco', () => {
    expect(formatMonth('2026-11-01')).toBe('nov. de 26')
  })

  /*
   * O motivo de existir. `new Date('2026-11-01')` é meia-noite UTC; num fuso a
   * oeste de Greenwich (o Brasil inteiro) isso volta como 31/10, e a tela mostraria
   * o mês anterior em TODA a linha de uma projeção financeira. Montar a data no
   * fuso local é o que evita isso — e este teste falha se alguém "simplificar"
   * para `new Date(value)`.
   */
  it('não desloca o mês por causa do fuso', () => {
    expect(formatMonth('2026-01-01')).toContain('jan')
    expect(formatMonth('2026-12-01')).toContain('dez')
    expect(formatMonth('2026-03-01')).toContain('mar')
  })

  it('devolve o travessão para ausente ou inválido', () => {
    expect(formatMonth(null)).toBe('—')
    expect(formatMonth(undefined)).toBe('—')
    expect(formatMonth('')).toBe('—')
    expect(formatMonth('mês que vem')).toBe('—')
  })
})
