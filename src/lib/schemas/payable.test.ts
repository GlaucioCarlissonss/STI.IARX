import { describe, expect, it } from 'vitest'
import { payableSchema, payableWithInstallmentsSchema } from './cadastros'

/**
 * O que o FORMULÁRIO manda tem de ser o que o SCHEMA espera.
 *
 * Este teste existe por causa de um defeito encontrado ao migrar a tela: lançar
 * uma despesa pelo formulário devolvia *"Invalid input: expected nonoptional,
 * received undefined"* e nada era gravado. A mensagem não dizia qual campo, e o
 * banco de exemplo tinha zero títulos — ou seja, provavelmente nunca ninguém
 * tinha conseguido lançar um.
 *
 * O caso abaixo é exatamente o que `NewPayableForm` envia quando a pessoa
 * preenche só o obrigatório: os campos do formulário, com os opcionais vazios.
 * Se alguém acrescentar um campo exigido ao schema sem acrescentá-lo ao
 * formulário, este teste reprova antes de a tela reprovar em silêncio.
 */
const doFormulario = {
  description: 'Licença Microsoft 365 — dezembro',
  amount: '4820.00',
  document_ref: '',
  issued_on: '2026-11-09',
  due_on: '2026-12-15',
  expense_category_id: '',
  cost_center_id: '',
  supplier_id: '',
  branch_id: '',
  notes: '',
  parcelas: '1',
  intervalo_dias: '30',
}

describe('título a pagar: formulário × schema', () => {
  it('aceita o mínimo que o formulário manda', () => {
    const r = payableSchema.safeParse(doFormulario)
    expect(r.success ? '' : r.error.issues[0]?.message).toBe('')
  })

  it('aceita também o parcelamento que o formulário manda', () => {
    const r = payableWithInstallmentsSchema.safeParse(doFormulario)
    expect(r.success ? '' : r.error.issues[0]?.message).toBe('')
  })

  it('e continua recusando o que é de fato inválido', () => {
    expect(payableSchema.safeParse({ ...doFormulario, amount: '0' }).success).toBe(false)
    expect(payableSchema.safeParse({ ...doFormulario, description: 'a' }).success).toBe(false)
    /* Vencimento antes da emissão é erro de digitação em 100% dos casos. */
    expect(
      payableSchema.safeParse({ ...doFormulario, due_on: '2026-11-01' }).success,
    ).toBe(false)
  })
})
