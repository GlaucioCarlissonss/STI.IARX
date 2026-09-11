import { z } from 'zod'
import {
  emptyToNull,
  optionalUuid,
  optionalNonNegativeNumber,
  optionalNumberInRange,
  optionalPositiveInt,
  intInRange,
} from '../form-schemas'

/**
 * Schemas dos cadastros administrativos — cliente, filial, ativo, linha e
 * fornecedor.
 *
 * Ficam aqui, e não dentro de cada `actions.ts`, por dois motivos:
 *
 * 1. **Cadastrar e editar precisam da MESMA regra.** Quando o formulário de
 *    edição carrega o próprio schema, as duas validações divergem na primeira
 *    manutenção — e o campo que é obrigatório ao criar passa a aceitar vazio ao
 *    editar, sem ninguém notar.
 * 2. **Um módulo `'use server'` só pode exportar funções assíncronas.** Um
 *    schema exportado de dentro do `actions.ts` quebraria a compilação, e um
 *    schema não exportado não é testável. Aqui os testes alcançam a regra sem
 *    subir servidor nem banco.
 */

/** Identificador do registro sendo editado. */
export const recordId = z.string().uuid('Registro inválido.')

/* --- Cliente ------------------------------------------------------------ */

export const clientSchema = z.object({
  legal_name: z.string().trim().min(2, 'Informe a razão social.'),
  trade_name: emptyToNull,
  cnpj: emptyToNull,
  contract_ref: emptyToNull,
})

export const clientStatusSchema = z.enum(['active', 'inactive', 'prospect'])

/* --- Filial ------------------------------------------------------------- */

export const branchSchema = z.object({
  client_id: z.string().uuid('Selecione o cliente.'),
  name: z.string().trim().min(2, 'Informe o nome da filial.'),
  code: emptyToNull,
  cnpj: emptyToNull,
  city: emptyToNull,
  // `char(2)` no banco: cortar aqui evita que a violação chegue como erro cru.
  state: emptyToNull.pipe(
    z.union([z.string().length(2, 'A UF tem exatamente 2 letras.'), z.null()]),
  ),
  // O timezone da filial é a base de todo cálculo de horário útil de SLA (ADR-004),
  // por isso é obrigatório e tem default explícito.
  timezone: z.string().trim().min(3, 'Selecione um fuso horário.'),
  business_hours_id: optionalUuid,
  contact_name: emptyToNull,
  contact_email: emptyToNull.pipe(
    z.union([z.string().email('E-mail de contato inválido.'), z.null()]),
  ),
  contact_phone: emptyToNull,
})

/* --- Ativo de TI -------------------------------------------------------- */

export const assetStatusSchema = z.enum(['in_stock', 'active', 'maintenance', 'retired', 'lost'])

export const assetSchema = z.object({
  asset_tag: emptyToNull,
  serial_number: emptyToNull,
  asset_type: z.enum([
    'notebook',
    'desktop',
    'server',
    'smartphone',
    'tablet',
    'monitor',
    'printer',
    'peripheral',
    'network',
    'software_license',
    'other',
  ]),
  brand: emptyToNull,
  model: emptyToNull,
  status: assetStatusSchema,
  branch_id: optionalUuid,
  branch_area_id: optionalUuid,
  assigned_user_id: optionalUuid,
  supplier_id: optionalUuid,
  acquisition_date: emptyToNull,
  warranty_until: emptyToNull,
  acquisition_cost: optionalNonNegativeNumber,
  notes: emptyToNull,
})

/* --- Área da filial ----------------------------------------------------- */

export const areaKindSchema = z.enum(['assistencial', 'administrativa', 'apoio', 'tecnica'])

export const branchAreaSchema = z.object({
  branch_id: z.string().uuid('Selecione a filial.'),
  name: z.string().trim().min(2, 'Informe o nome da área.'),
  code: emptyToNull,
  kind: areaKindSchema,
  // `smallint` no banco: 32767 é o teto real, e aceitar mais aqui trocaria uma
  // mensagem em português por um erro de overflow vindo do PostgreSQL.
  sort_order: intInRange(0, 32767),
})

/* --- Custódia de ativo -------------------------------------------------- */

export const custodyReasonSchema = z.enum([
  'realocacao',
  'devolucao',
  'substituicao',
  'baixa',
  'manutencao',
  'aquisicao',
  'perda',
  'outro',
])

export const assetCustodySchema = z.object({
  asset_id: recordId,
  assigned_user_id: optionalUuid,
  branch_id: optionalUuid,
  branch_area_id: optionalUuid,
  reason: custodyReasonSchema,
  note: emptyToNull,
})

/* --- Linha telefônica --------------------------------------------------- */

export const telecomStatusSchema = z.enum(['active', 'suspended', 'cancelled'])

export const telecomLineSchema = z
  .object({
    phone_number: z.string().trim().min(8, 'Informe o número da linha.'),
    carrier: z.string().trim().min(2, 'Informe a operadora.'),
    plan_name: emptyToNull,
    line_type: z.enum(['postpaid', 'prepaid', 'control']),
    status: telecomStatusSchema,
    branch_id: optionalUuid,
    company_area_id: optionalUuid,
    assigned_user_id: optionalUuid,
    device_asset_id: optionalUuid,
    monthly_cost: optionalNonNegativeNumber,
    activated_on: emptyToNull,
    cancelled_on: emptyToNull,
    loyalty_until: emptyToNull,
  })
  // Espelha a constraint `line_cancelled_needs_date` do banco. Validar aqui
  // também é o que permite dar uma mensagem em português em vez de repassar
  // uma violação de CHECK.
  .refine((v) => v.status !== 'cancelled' || v.cancelled_on !== null, {
    message: 'Linha cancelada exige a data de cancelamento.',
    path: ['cancelled_on'],
  })

/* --- Link de internet --------------------------------------------------- */

export const linkStatusSchema = z.enum(['active', 'suspended', 'cancelled'])

export const linkTechnologySchema = z.enum([
  'fiber',
  'radio',
  'satellite',
  'mobile_4g',
  'mobile_5g',
  'xdsl',
  'other',
])

/**
 * Espelha os quatro CHECKs de `public.internet_links` (migração 0013:465-479).
 *
 * Validar aqui não substitui o banco — substituiria seria perigoso —, mas é o que
 * permite dizer "a operadora é obrigatória" em vez de repassar
 * `violates check constraint "link_has_carrier"` para a tela.
 *
 * `has_static_ip` não é campo do formulário: é derivado de `static_ip` ter valor.
 * Pedir a marcação e o endereço separados criaria o estado "marquei mas não
 * preenchi", que é justamente o que o CHECK `link_static_ip_pair` recusa.
 */
export const internetLinkSchema = z
  .object({
    branch_id: z.string().uuid('Selecione a filial.'),
    branch_area_id: optionalUuid,
    contract_number: emptyToNull,
    supplier_id: optionalUuid,
    carrier_name: emptyToNull,
    technology: linkTechnologySchema,
    download_mbps: optionalPositiveInt,
    upload_mbps: optionalPositiveInt,
    guaranteed_mbps: optionalPositiveInt,
    static_ip: emptyToNull,
    cpe_brand: emptyToNull,
    cpe_model: emptyToNull,
    cpe_serial: emptyToNull,
    status: linkStatusSchema,
    monthly_cost: optionalNonNegativeNumber,
    activated_on: emptyToNull,
    cancelled_on: emptyToNull,
    contract_start: emptyToNull,
    contract_end: emptyToNull,
    monitoring_host: emptyToNull,
    notes: emptyToNull,
  })
  .transform((v) => ({ ...v, has_static_ip: v.static_ip !== null }))
  .refine((v) => v.supplier_id !== null || v.carrier_name !== null, {
    message: 'Informe o fornecedor cadastrado ou o nome da operadora.',
    path: ['carrier_name'],
  })
  .refine((v) => v.status !== 'cancelled' || v.cancelled_on !== null, {
    message: 'Link cancelado exige a data de cancelamento.',
    path: ['cancelled_on'],
  })
  .refine(
    (v) => v.contract_end === null || v.contract_start === null || v.contract_end >= v.contract_start,
    {
      message: 'O fim da vigência não pode ser anterior ao início.',
      path: ['contract_end'],
    },
  )

/** Registro manual de queda. O retorno não precisa de campo: fecha a queda aberta. */
export const linkOutageSchema = z.object({
  link_id: recordId,
  note: emptyToNull,
})

/* --- Fornecedor --------------------------------------------------------- */

export const supplierSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome do fornecedor.'),
  legal_name: emptyToNull,
  cnpj: emptyToNull,
  email: emptyToNull.pipe(z.union([z.string().email('E-mail inválido.'), z.null()])),
  phone: emptyToNull,
  // Serviços chegam como texto separado por vírgula e viram text[] no banco.
  services: z
    .string()
    .trim()
    .transform((v) => (v === '' ? [] : v.split(',').map((s) => s.trim()).filter(Boolean))),
  rating: optionalNumberInRange(0, 5),
})

/* --- Contrato de fornecedor ---------------------------------------------- */

export const supplierContractSchema = z
  .object({
    supplier_id: z.string().uuid('Selecione o fornecedor.'),
    contract_number: emptyToNull,
    description: emptyToNull,
    starts_on: emptyToNull,
    ends_on: emptyToNull,
    monthly_cost: optionalNonNegativeNumber,
    response_sla_minutes: optionalPositiveInt,
    resolution_sla_minutes: optionalPositiveInt,
  })
  // Espelha a constraint `sc_valid_period` do banco.
  .refine((v) => !v.ends_on || !v.starts_on || v.ends_on >= v.starts_on, {
    message: 'A vigência final não pode ser anterior ao início.',
    path: ['ends_on'],
  })

/* --- Categoria de ticket -------------------------------------------------- */

export const categorySchema = z.object({
  parent_id: optionalUuid,
  name: z.string().trim().min(2, 'Informe o nome da categoria.'),
  description: emptyToNull,
})

/* --- Prioridade de ticket -------------------------------------------------
 *
 * `key` não é campo do formulário: é derivada do `label` no servidor (ver
 * `sla/actions.ts`) e nunca reeditada — mudar a chave depois de criada
 * quebraria o vínculo com `sla_definitions`.
 */

export const prioritySchema = z.object({
  label: z.string().trim().min(2, 'Informe o nome da prioridade.'),
  weight: intInRange(0, 100),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Cor inválida.'),
  sort_order: intInRange(0, 999),
})

/* --- Contrato de SLA por cliente ------------------------------------------ */

export const slaContractSchema = z
  .object({
    client_id: z.string().uuid('Selecione o cliente.'),
    branch_id: optionalUuid,
    name: z.string().trim().min(2, 'Informe o nome do contrato.'),
    business_hours_id: optionalUuid,
    valid_from: emptyToNull,
    valid_to: emptyToNull,
    notes: emptyToNull,
  })
  // Espelha a constraint `slac_valid_period` do banco.
  .refine((v) => !v.valid_to || !v.valid_from || v.valid_to >= v.valid_from, {
    message: 'A vigência final não pode ser anterior ao início.',
    path: ['valid_to'],
  })

/* --- Definição de SLA ------------------------------------------------------ */

export const slaDefinitionSchema = z
  .object({
    contract_id: optionalUuid,
    category_id: optionalUuid,
    priority_id: z.string().uuid('Selecione a prioridade.'),
    first_response_minutes: intInRange(1, 100_000),
    resolution_minutes: intInRange(1, 100_000),
    business_hours_id: optionalUuid,
  })
  // Espelha a constraint `slad_resolution_after_response` do banco.
  .refine((v) => v.resolution_minutes >= v.first_response_minutes, {
    message: 'A resolução não pode ser mais curta que a primeira resposta.',
    path: ['resolution_minutes'],
  })

/* --- Financeiro: centro de custo ------------------------------------------ */

export const costCenterSchema = z.object({
  parent_id: optionalUuid,
  code: z.string().trim().min(1, 'Informe o código do centro de custo.').max(30),
  name: z.string().trim().min(2, 'Informe o nome do centro de custo.'),
  description: emptyToNull,
  branch_id: optionalUuid,
})

/* --- Financeiro: conta bancária ------------------------------------------- */

export const bankAccountTypeSchema = z.enum(['checking', 'savings', 'payment', 'investment'])
export const bankAccountStatusSchema = z.enum(['active', 'inactive', 'blocked'])

export const bankAccountSchema = z.object({
  name: z.string().trim().min(2, 'Informe um nome para identificar a conta.'),
  bank_name: z.string().trim().min(2, 'Informe o banco.'),
  bank_code: emptyToNull,
  agency: emptyToNull,
  account_number: emptyToNull,
  account_type: bankAccountTypeSchema,
  holder_name: emptyToNull,
  holder_document: emptyToNull,
  // Saldo inicial pode ser negativo: conta que entra no sistema já no vermelho
  // é situação real, e recusá-la obrigaria a mentir o número de partida.
  opening_balance: z
    .string()
    .trim()
    .transform((v) => (v === '' ? 0 : Number(v)))
    .refine((v) => Number.isFinite(v), { message: 'Saldo inicial inválido.' }),
  credit_limit: optionalNonNegativeNumber.transform((v) => v ?? 0),
  status: bankAccountStatusSchema,
  notes: emptyToNull,
})

/* --- Financeiro: movimentação --------------------------------------------- */

export const bankMovementSchema = z.object({
  bank_account_id: z.string().uuid('Selecione a conta.'),
  direction: z.enum(['in', 'out']),
  amount: z
    .string()
    .trim()
    .transform((v) => Number(v))
    .refine((v) => Number.isFinite(v) && v > 0, {
      message: 'O valor precisa ser maior que zero.',
    }),
  moved_on: z.string().trim().min(10, 'Informe a data.'),
  description: z.string().trim().min(2, 'Descreva a movimentação.'),
  cost_center_id: optionalUuid,
})

/**
 * Transferência entre contas.
 *
 * Origem e destino diferentes é regra de negócio, não detalhe de UI: uma
 * transferência para a própria conta gravaria duas linhas que se anulam e
 * poluiriam o extrato com um fato que não aconteceu.
 */
export const bankTransferSchema = z
  .object({
    from_account_id: z.string().uuid('Selecione a conta de origem.'),
    to_account_id: z.string().uuid('Selecione a conta de destino.'),
    amount: z
      .string()
      .trim()
      .transform((v) => Number(v))
      .refine((v) => Number.isFinite(v) && v > 0, {
        message: 'O valor precisa ser maior que zero.',
      }),
    moved_on: z.string().trim().min(10, 'Informe a data.'),
    description: z.string().trim().min(2, 'Descreva a transferência.'),
  })
  .refine((v) => v.from_account_id !== v.to_account_id, {
    message: 'Origem e destino precisam ser contas diferentes.',
    path: ['to_account_id'],
  })

/* --- Títulos a pagar e a receber (migração 0020) -------------------------- */

/**
 * Valor em reais vindo de `<input type="number">`.
 *
 * Rejeita zero e negativo aqui em vez de deixar o CHECK do banco reclamar: a
 * mensagem do Postgres fala de constraint, e quem está lançando a despesa não
 * tem por que saber o que é isso.
 */
const dinheiro = z
  .string()
  .trim()
  .min(1, 'Informe o valor.')
  .transform((v) => Number(v.replace(',', '.')))
  .refine((v) => Number.isFinite(v) && v > 0, { message: 'O valor precisa ser maior que zero.' })
  .refine((v) => v <= 999_999_999.99, { message: 'Valor acima do limite do sistema.' })

const dataObrigatoria = (rotulo: string) =>
  z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, `Informe ${rotulo}.`)

/**
 * Base comum de título a pagar.
 *
 * `issued_on` não pode ser depois de `due_on`: título emitido depois do próprio
 * vencimento é erro de digitação em 100% dos casos, e passar disso produz
 * relatório de vencidos que ninguém entende.
 */
export const payableSchema = z
  .object({
    description: z.string().trim().min(2, 'Descreva a despesa.').max(200, 'Descrição longa demais.'),
    document_ref: emptyToNull,
    supplier_id: optionalUuid,
    supplier_contract_id: optionalUuid,
    expense_category_id: optionalUuid,
    cost_center_id: optionalUuid,
    branch_id: optionalUuid,
    amount: dinheiro,
    issued_on: dataObrigatoria('a data de emissão'),
    due_on: dataObrigatoria('o vencimento'),
    notes: emptyToNull,
  })
  .refine((v) => v.issued_on <= v.due_on, {
    message: 'O vencimento não pode ser anterior à emissão.',
    path: ['due_on'],
  })

/**
 * Parcelamento.
 *
 * Uma parcela é o padrão, e é por isso que o campo aceita 1. Acima de 1 o
 * servidor gera N títulos ligados — a divisão não é do formulário, porque o
 * arredondamento do centavo tem de ser resolvido em um lugar só.
 */
export const installmentCountSchema = z
  .string()
  .trim()
  .transform((v) => (v === '' ? 1 : Number(v)))
  .refine((v) => Number.isInteger(v) && v >= 1 && v <= 60, {
    message: 'O número de parcelas vai de 1 a 60.',
  })

export const payableWithInstallmentsSchema = z.object({
  parcelas: installmentCountSchema,
  /** Dias entre uma parcela e a seguinte. 30 é o intervalo usual. */
  intervalo_dias: z
    .string()
    .trim()
    .transform((v) => (v === '' ? 30 : Number(v)))
    .refine((v) => Number.isInteger(v) && v >= 1 && v <= 365, {
      message: 'O intervalo vai de 1 a 365 dias.',
    }),
})

/** Baixa de pagamento. Exige conta e data — o banco também exige. */
export const payablePaymentSchema = z.object({
  id: recordId,
  bank_account_id: z.string().uuid('Selecione a conta de onde saiu o dinheiro.'),
  paid_on: dataObrigatoria('a data do pagamento'),
})

export const payableApprovalSchema = z.object({
  id: recordId,
  decision: z.enum(['approved', 'rejected']),
  note: emptyToNull,
})
  .refine((v) => v.decision !== 'rejected' || (v.note !== null && v.note.length >= 3), {
    message: 'Rejeição exige o motivo — sem ele quem recebe o título de volta não sabe o que corrigir.',
    path: ['note'],
  })

export const receivableSchema = z
  .object({
    description: z.string().trim().min(2, 'Descreva o título.').max(200, 'Descrição longa demais.'),
    document_ref: emptyToNull,
    client_id: optionalUuid,
    sla_contract_id: optionalUuid,
    cost_center_id: optionalUuid,
    branch_id: optionalUuid,
    amount: dinheiro,
    issued_on: dataObrigatoria('a data de emissão'),
    due_on: dataObrigatoria('o vencimento'),
    notes: emptyToNull,
  })
  .refine((v) => v.issued_on <= v.due_on, {
    message: 'O vencimento não pode ser anterior à emissão.',
    path: ['due_on'],
  })

/**
 * Baixa de recebimento.
 *
 * `received_amount` é opcional e cai no valor do título quando vazio. Existe
 * separado porque desconto e recebimento parcial acontecem, e sobrescrever o
 * valor original apagaria a diferença que a conciliação precisa ver.
 */
export const receivableSettlementSchema = z.object({
  id: recordId,
  bank_account_id: z.string().uuid('Selecione a conta que recebeu.'),
  received_on: dataObrigatoria('a data do recebimento'),
  received_amount: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : Number(v.replace(',', '.'))))
    .refine((v) => v === null || (Number.isFinite(v) && v > 0), {
      message: 'O valor recebido precisa ser maior que zero.',
    }),
})

export const expenseCategorySchema = z.object({
  code: z.string().trim().min(2, 'Informe o código.').max(30, 'Código longo demais.'),
  name: z.string().trim().min(2, 'Informe o nome.').max(120, 'Nome longo demais.'),
  requires_supplier: z.union([z.literal('on'), z.literal('')]).optional().transform((v) => v === 'on'),
})

/**
 * Faixa de alçada.
 *
 * O teto vazio significa "sem teto", e é assim que o último nível se expressa.
 * Não vou exigir teto: exigir obrigaria a inventar um número grande arbitrário, e
 * aí um título acima dele ficaria sem alçada nenhuma.
 */
export const approvalRuleSchema = z
  .object({
    level: intInRange(1, 9),
    level_name: z.string().trim().min(2, 'Dê um nome ao nível.').max(60, 'Nome longo demais.'),
    min_amount: z
      .string()
      .trim()
      .transform((v) => (v === '' ? 0 : Number(v.replace(',', '.'))))
      .refine((v) => Number.isFinite(v) && v >= 0, { message: 'O valor mínimo não pode ser negativo.' }),
    max_amount: z
      .string()
      .trim()
      .transform((v) => (v === '' ? null : Number(v.replace(',', '.'))))
      .refine((v) => v === null || (Number.isFinite(v) && v > 0), {
        message: 'O valor máximo precisa ser maior que zero, ou vazio para "sem teto".',
      }),
    cost_center_id: optionalUuid,
    branch_id: optionalUuid,
    required_profile_id: optionalUuid,
  })
  .refine((v) => v.max_amount === null || v.max_amount > v.min_amount, {
    message: 'O valor máximo precisa ser maior que o mínimo.',
    path: ['max_amount'],
  })
