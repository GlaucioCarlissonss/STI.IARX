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
  assigned_user_id: optionalUuid,
  supplier_id: optionalUuid,
  acquisition_date: emptyToNull,
  warranty_until: emptyToNull,
  acquisition_cost: optionalNonNegativeNumber,
  notes: emptyToNull,
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
