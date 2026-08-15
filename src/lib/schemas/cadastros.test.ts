import { describe, expect, it } from 'vitest'
import {
  assetSchema,
  branchSchema,
  clientSchema,
  recordId,
  supplierSchema,
  telecomLineSchema,
} from './cadastros'

/**
 * Estes testes existem porque cadastrar e editar passam pelo MESMO schema.
 * Se alguém afrouxar uma regra pensando só no formulário de edição, aqui quebra.
 */

const UUID = '11111111-2222-4333-8444-555555555555'

function firstError(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.success ? null : (result.error?.issues[0]?.message ?? null)
}

describe('recordId', () => {
  it('recusa id que não é UUID, em português', () => {
    expect(firstError(recordId.safeParse('123'))).toBe('Registro inválido.')
  })
})

describe('clientSchema', () => {
  it('exige razão social com mensagem em português', () => {
    expect(firstError(clientSchema.safeParse({ legal_name: 'X' }))).toBe(
      'Informe a razão social.',
    )
  })

  it('converte campo opcional vazio em null, não em string vazia', () => {
    const parsed = clientSchema.parse({
      legal_name: 'Grupo Meridiano',
      trade_name: '',
      cnpj: '   ',
      contract_ref: '',
    })
    expect(parsed).toEqual({
      legal_name: 'Grupo Meridiano',
      trade_name: null,
      cnpj: null,
      contract_ref: null,
    })
  })
})

describe('branchSchema', () => {
  const base = {
    client_id: UUID,
    name: 'Matriz São Paulo',
    code: '',
    cnpj: '',
    city: 'São Paulo',
    state: 'SP',
    timezone: 'America/Sao_Paulo',
    business_hours_id: '',
    contact_name: '',
    contact_email: '',
    contact_phone: '',
  }

  it('aceita uma filial completa', () => {
    const parsed = branchSchema.parse(base)
    expect(parsed.city).toBe('São Paulo')
    expect(parsed.business_hours_id).toBeNull()
  })

  it('recusa UF com mais de duas letras antes de o banco reclamar', () => {
    expect(firstError(branchSchema.safeParse({ ...base, state: 'São Paulo' }))).toBe(
      'A UF tem exatamente 2 letras.',
    )
  })

  it('aceita UF vazia — o campo é opcional', () => {
    expect(branchSchema.parse({ ...base, state: '' }).state).toBeNull()
  })

  it('recusa e-mail de contato inválido em português', () => {
    expect(firstError(branchSchema.safeParse({ ...base, contact_email: 'não-é-email' }))).toBe(
      'E-mail de contato inválido.',
    )
  })

  it('exige fuso horário — é a base do cálculo de SLA', () => {
    expect(firstError(branchSchema.safeParse({ ...base, timezone: '' }))).toBe(
      'Selecione um fuso horário.',
    )
  })

  it('exige cliente válido', () => {
    expect(firstError(branchSchema.safeParse({ ...base, client_id: '' }))).toBe(
      'Selecione o cliente.',
    )
  })
})

describe('assetSchema', () => {
  const base = {
    asset_tag: 'PAT-001',
    serial_number: '',
    asset_type: 'notebook',
    brand: '',
    model: '',
    status: 'active',
    branch_id: '',
    assigned_user_id: '',
    supplier_id: '',
    acquisition_date: '',
    warranty_until: '',
    acquisition_cost: '',
    notes: '',
  }

  it('aceita um ativo mínimo', () => {
    const parsed = assetSchema.parse(base)
    expect(parsed.asset_tag).toBe('PAT-001')
    expect(parsed.acquisition_cost).toBeNull()
  })

  it('recusa custo negativo', () => {
    expect(firstError(assetSchema.safeParse({ ...base, acquisition_cost: '-10' }))).toBe(
      'Informe um número válido, maior ou igual a zero.',
    )
  })

  it('recusa status fora do ciclo de vida', () => {
    expect(assetSchema.safeParse({ ...base, status: 'emprestado' }).success).toBe(false)
  })
})

describe('telecomLineSchema', () => {
  const base = {
    phone_number: '11 98888-0001',
    carrier: 'Vivo',
    plan_name: '',
    line_type: 'postpaid',
    status: 'active',
    branch_id: '',
    assigned_user_id: '',
    device_asset_id: '',
    monthly_cost: '89,90'.replace(',', '.'),
    activated_on: '',
    cancelled_on: '',
    loyalty_until: '',
  }

  it('aceita uma linha ativa', () => {
    expect(telecomLineSchema.parse(base).monthly_cost).toBe(89.9)
  })

  it('exige data ao cancelar — espelha a constraint do banco', () => {
    expect(firstError(telecomLineSchema.safeParse({ ...base, status: 'cancelled' }))).toBe(
      'Linha cancelada exige a data de cancelamento.',
    )
  })

  it('aceita cancelamento quando a data vem junto', () => {
    const parsed = telecomLineSchema.parse({
      ...base,
      status: 'cancelled',
      cancelled_on: '2026-01-31',
    })
    expect(parsed.cancelled_on).toBe('2026-01-31')
  })
})

describe('supplierSchema', () => {
  const base = { name: 'Fibra Norte', legal_name: '', cnpj: '', email: '', phone: '', services: '', rating: '' }

  it('transforma serviços separados por vírgula em lista limpa', () => {
    expect(supplierSchema.parse({ ...base, services: 'Link, Telefonia ,, Suporte' }).services).toEqual(
      ['Link', 'Telefonia', 'Suporte'],
    )
  })

  it('devolve lista vazia quando não há serviço informado', () => {
    expect(supplierSchema.parse(base).services).toEqual([])
  })

  it('recusa avaliação fora de 0 a 5', () => {
    expect(firstError(supplierSchema.safeParse({ ...base, rating: '7' }))).toBe(
      'Informe um número entre 0 e 5.',
    )
  })

  it('recusa e-mail inválido em português', () => {
    expect(firstError(supplierSchema.safeParse({ ...base, email: 'arroba-faltando' }))).toBe(
      'E-mail inválido.',
    )
  })
})
