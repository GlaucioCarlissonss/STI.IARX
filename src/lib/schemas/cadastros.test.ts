import { describe, expect, it } from 'vitest'
import {
  assetSchema,
  branchSchema,
  categorySchema,
  clientSchema,
  prioritySchema,
  recordId,
  slaContractSchema,
  slaDefinitionSchema,
  supplierContractSchema,
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

describe('supplierContractSchema', () => {
  const base = {
    supplier_id: UUID,
    contract_number: '',
    description: '',
    starts_on: '2026-01-01',
    ends_on: '2026-12-31',
    monthly_cost: '',
    response_sla_minutes: '',
    resolution_sla_minutes: '',
  }

  it('aceita um contrato mínimo', () => {
    const parsed = supplierContractSchema.parse(base)
    expect(parsed.starts_on).toBe('2026-01-01')
    expect(parsed.response_sla_minutes).toBeNull()
  })

  it('recusa vigência final anterior ao início — espelha sc_valid_period', () => {
    expect(
      firstError(supplierContractSchema.safeParse({ ...base, ends_on: '2025-01-01' })),
    ).toBe('A vigência final não pode ser anterior ao início.')
  })

  it('recusa SLA contratado não inteiro ou zero', () => {
    expect(
      firstError(supplierContractSchema.safeParse({ ...base, response_sla_minutes: '0' })),
    ).toBe('Informe um número inteiro maior que zero.')
  })

  it('exige fornecedor', () => {
    expect(firstError(supplierContractSchema.safeParse({ ...base, supplier_id: '' }))).toBe(
      'Selecione o fornecedor.',
    )
  })
})

describe('categorySchema', () => {
  it('exige nome com mensagem em português', () => {
    expect(firstError(categorySchema.safeParse({ parent_id: '', name: 'X', description: '' }))).toBe(
      'Informe o nome da categoria.',
    )
  })

  it('aceita categoria de topo (sem pai)', () => {
    const parsed = categorySchema.parse({ parent_id: '', name: 'Hardware', description: '' })
    expect(parsed.parent_id).toBeNull()
  })

  it('aceita subcategoria com pai válido', () => {
    const parsed = categorySchema.parse({ parent_id: UUID, name: 'Notebook', description: '' })
    expect(parsed.parent_id).toBe(UUID)
  })
})

describe('prioritySchema', () => {
  const base = { label: 'Crítica', weight: '90', color: '#ef4444', sort_order: '1' }

  it('aceita uma prioridade completa', () => {
    const parsed = prioritySchema.parse(base)
    expect(parsed.weight).toBe(90)
    expect(parsed.color).toBe('#ef4444')
  })

  it('recusa peso fora de 0–100', () => {
    expect(firstError(prioritySchema.safeParse({ ...base, weight: '150' }))).toBe(
      'Informe um número inteiro entre 0 e 100.',
    )
  })

  it('recusa cor fora do formato hexadecimal', () => {
    expect(firstError(prioritySchema.safeParse({ ...base, color: 'vermelho' }))).toBe(
      'Cor inválida.',
    )
  })

  it('não tem campo key — é derivada no servidor, não no formulário', () => {
    expect('key' in prioritySchema.shape).toBe(false)
  })
})

describe('slaContractSchema', () => {
  const base = {
    client_id: UUID,
    branch_id: '',
    name: 'Contrato padrão 2026',
    business_hours_id: '',
    valid_from: '2026-01-01',
    valid_to: '2026-12-31',
    notes: '',
  }

  it('aceita um contrato de SLA completo', () => {
    expect(slaContractSchema.parse(base).name).toBe('Contrato padrão 2026')
  })

  it('recusa vigência final anterior ao início — espelha slac_valid_period', () => {
    expect(firstError(slaContractSchema.safeParse({ ...base, valid_to: '2025-01-01' }))).toBe(
      'A vigência final não pode ser anterior ao início.',
    )
  })

  it('exige cliente', () => {
    expect(firstError(slaContractSchema.safeParse({ ...base, client_id: '' }))).toBe(
      'Selecione o cliente.',
    )
  })
})

describe('slaDefinitionSchema', () => {
  const base = {
    contract_id: '',
    category_id: '',
    priority_id: UUID,
    first_response_minutes: '30',
    resolution_minutes: '240',
    business_hours_id: '',
  }

  it('aceita uma definição padrão do tenant (sem contrato nem categoria)', () => {
    const parsed = slaDefinitionSchema.parse(base)
    expect(parsed.contract_id).toBeNull()
    expect(parsed.resolution_minutes).toBe(240)
  })

  it('recusa resolução mais curta que a primeira resposta — espelha slad_resolution_after_response', () => {
    expect(
      firstError(
        slaDefinitionSchema.safeParse({ ...base, first_response_minutes: '300', resolution_minutes: '60' }),
      ),
    ).toBe('A resolução não pode ser mais curta que a primeira resposta.')
  })

  it('exige prioridade', () => {
    expect(firstError(slaDefinitionSchema.safeParse({ ...base, priority_id: '' }))).toBe(
      'Selecione a prioridade.',
    )
  })
})
