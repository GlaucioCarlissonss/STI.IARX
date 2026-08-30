'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireSession, requirePermission } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'
import {
  approvalRuleSchema,
  expenseCategorySchema,
  installmentCountSchema,
  payableApprovalSchema,
  payablePaymentSchema,
  payableSchema,
  payableWithInstallmentsSchema,
  receivableSchema,
  receivableSettlementSchema,
  recordId,
} from '@/lib/schemas/cadastros'

/*
 * Títulos a pagar e a receber.
 *
 * Toda ação usa `.select('id')` depois de escrever e confere `length`. Não é
 * zelo: RLS nega devolvendo ZERO LINHAS em vez de erro, e sem esta checagem a
 * tela diria "salvo" com o dado intacto. É o padrão de todo o projeto.
 */

const NOT_AFFECTED = 'Não foi possível concluir: registro não encontrado ou sem permissão.'
const PAGAR = '/financeiro/titulos-a-pagar'
const RECEBER = '/financeiro/titulos-a-receber'

function falha(m?: string): ActionState {
  return { error: m ?? NOT_AFFECTED }
}

/** Erro do Postgres em linguagem de quem usa a tela. */
function traduz(error: { code?: string; message: string }): ActionState {
  // A trigger da máquina de estados e os CHECKs usam check_violation, e a
  // mensagem deles já foi escrita para ser lida — vale mais que a genérica.
  if (error.code === '23514') return falha(error.message)
  if (error.code === '23505') return falha('Já existe um registro com este código.')
  if (error.code === '23503') return falha('Um dos vínculos escolhidos não existe mais.')
  return falha(error.message)
}

/* ========================================================================== */
/* Títulos a pagar                                                            */
/* ========================================================================== */

/**
 * Lança a despesa. É o "criar despesa" do menu.
 *
 * Se o tenant tiver aprovação ligada, o título nasce em `pending_approval`; se
 * não, nasce `approved`. A decisão é do banco, via
 * `app.required_approval_levels()` — replicá-la aqui criaria duas verdades sobre
 * quem precisa aprovar o quê.
 */
export async function createPayable(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await requirePermission('financeiro.titulos_pagar.criar')
  if ('error' in gate) return gate
  const { profile } = await requireSession()
  if (!profile.tenant_id) return falha('Sessão sem tenant.')

  const dados = Object.fromEntries(formData)
  const parsed = payableSchema.safeParse(dados)
  if (!parsed.success) return falha(parsed.error.issues[0]?.message ?? 'Dados inválidos.')

  const parcelas = payableWithInstallmentsSchema.safeParse(dados)
  if (!parcelas.success) return falha(parcelas.error.issues[0]?.message ?? 'Parcelamento inválido.')

  const supabase = await createClient()

  const { data: niveis, error: erroNiveis } = await supabase.rpc('required_approval_levels_for', {
    p_amount: parsed.data.amount,
    p_cost_center_id: parsed.data.cost_center_id,
    p_branch_id: parsed.data.branch_id,
  })
  // A função levanta erro quando a aprovação está ligada e nenhuma faixa cobre o
  // valor. Repassar a mensagem dela é melhor que engolir: ela diz o que
  // configurar.
  if (erroNiveis) return traduz(erroNiveis)

  const precisaAprovar = Array.isArray(niveis) && niveis.length > 0
  const status = precisaAprovar ? 'pending_approval' : 'approved'

  const total = parcelas.data.parcelas
  const linhas = montaParcelas({
    base: parsed.data,
    tenantId: profile.tenant_id,
    criadoPor: profile.id,
    status,
    total,
    intervaloDias: parcelas.data.intervalo_dias,
  })

  const { data: criados, error } = await supabase.from('payables').insert(linhas).select('id')
  if (error) return traduz(error)
  if (!criados || criados.length === 0) return falha()

  // Parcela aponta para a primeira. Duas instruções em vez de uma porque o id do
  // pai só existe depois do insert, e gerar uuid na aplicação para amarrar antes
  // tiraria o default do banco.
  if (total > 1) {
    const [primeira, ...resto] = criados as { id: string }[]
    const { error: erroVinculo } = await supabase
      .from('payables')
      .update({ parent_payable_id: primeira!.id })
      .in('id', resto.map((r) => r.id))
    if (erroVinculo) return traduz(erroVinculo)
  }

  revalidatePath(PAGAR)
  return {
    success:
      total > 1
        ? `${total} parcelas lançadas${precisaAprovar ? ', aguardando aprovação' : ''}.`
        : precisaAprovar
          ? 'Despesa lançada e enviada para aprovação.'
          : 'Despesa lançada e já aprovada — este tenant não exige aprovação.',
  }
}

/**
 * Divide o valor em parcelas sem perder centavo.
 *
 * A sobra da divisão vai para a PRIMEIRA parcela, não para a última. Parece
 * detalhe, e não é: jogar a sobra na última faz a parcela final ficar diferente
 * das outras num boleto que o fornecedor já emitiu, e a divergência aparece
 * meses depois.
 */
function montaParcelas(input: {
  base: ReturnType<typeof payableSchema.parse>
  tenantId: string
  criadoPor: string
  status: string
  total: number
  intervaloDias: number
}) {
  const { base, tenantId, criadoPor, status, total, intervaloDias } = input
  const centavos = Math.round(base.amount * 100)
  const porParcela = Math.floor(centavos / total)
  const sobra = centavos - porParcela * total

  const vencimentoBase = new Date(`${base.due_on}T12:00:00Z`)

  return Array.from({ length: total }, (_, i) => {
    const vencimento = new Date(vencimentoBase)
    vencimento.setUTCDate(vencimento.getUTCDate() + i * intervaloDias)
    return {
      ...base,
      tenant_id: tenantId,
      created_by: criadoPor,
      status,
      amount: (porParcela + (i === 0 ? sobra : 0)) / 100,
      due_on: vencimento.toISOString().slice(0, 10),
      installment_number: i + 1,
      installment_total: total,
    }
  })
}

export async function updatePayable(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await requirePermission('financeiro.titulos_pagar.editar')
  if ('error' in gate) return gate

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return falha('Registro inválido.')
  const parsed = payableSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return falha(parsed.error.issues[0]?.message ?? 'Dados inválidos.')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('payables')
    .update(parsed.data)
    .eq('id', id.data)
    .select('id')

  if (error) return traduz(error)
  if (!data || data.length === 0) return falha()

  revalidatePath(PAGAR)
  return { success: 'Título atualizado.' }
}

/**
 * Aprova ou reprova.
 *
 * Grava a decisão em `payable_approvals` ANTES de mexer no título: se o update do
 * título falhar, sobra o rastro da decisão sem o efeito — o inverso deixaria o
 * título aprovado sem registro de quem aprovou, que é justamente o que o módulo
 * de aprovação existe para impedir.
 */
export async function decidePayable(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await requirePermission('financeiro.titulos_pagar.aprovar')
  if ('error' in gate) return gate
  const { profile } = await requireSession()

  const parsed = payableApprovalSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return falha(parsed.error.issues[0]?.message ?? 'Dados inválidos.')
  const { id, decision, note } = parsed.data

  const supabase = await createClient()
  const { data: titulo } = await supabase
    .from('payables')
    .select('id, tenant_id, status')
    .eq('id', id)
    .maybeSingle<{ id: string; tenant_id: string; status: string }>()

  if (!titulo) return falha()
  if (titulo.status !== 'pending_approval') {
    return falha(`Este título está em "${titulo.status}" e não está aguardando aprovação.`)
  }

  const nivel = Number(formData.get('level') ?? 1)
  const { error: erroRastro } = await supabase.from('payable_approvals').insert({
    tenant_id: titulo.tenant_id,
    payable_id: id,
    level: Number.isInteger(nivel) && nivel >= 1 ? nivel : 1,
    decision,
    decided_by: profile.id,
    note,
  })
  if (erroRastro) return traduz(erroRastro)

  const { data, error } = await supabase
    .from('payables')
    .update(
      decision === 'approved'
        ? { status: 'approved' }
        : { status: 'rejected', rejection_reason: note },
    )
    .eq('id', id)
    .select('id')

  if (error) return traduz(error)
  if (!data || data.length === 0) return falha()

  revalidatePath(PAGAR)
  return { success: decision === 'approved' ? 'Título aprovado.' : 'Título reprovado.' }
}

/**
 * Dá baixa no pagamento e gera a movimentação bancária.
 *
 * A movimentação primeiro, o título depois: se o título falhar sobra uma
 * movimentação a conciliar, que aparece no extrato e alguém resolve. Na ordem
 * inversa sobraria um título "pago" sem dinheiro tendo saído da conta — erro
 * invisível até o fechamento do mês.
 */
export async function payPayable(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await requirePermission('financeiro.titulos_pagar.pagar')
  if ('error' in gate) return gate
  const { profile } = await requireSession()
  if (!profile.tenant_id) return falha('Sessão sem tenant.')

  const parsed = payablePaymentSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return falha(parsed.error.issues[0]?.message ?? 'Dados inválidos.')
  const { id, bank_account_id, paid_on } = parsed.data

  const supabase = await createClient()
  const { data: titulo } = await supabase
    .from('payables')
    .select('id, description, amount, status, cost_center_id')
    .eq('id', id)
    .maybeSingle<{
      id: string
      description: string
      amount: number
      status: string
      cost_center_id: string | null
    }>()

  if (!titulo) return falha()
  if (!['approved', 'scheduled'].includes(titulo.status)) {
    return falha(`Só título aprovado pode ser pago. Este está em "${titulo.status}".`)
  }

  const grupo = randomUUID()
  const { data: mov, error: erroMov } = await supabase
    .from('bank_account_movements')
    .insert({
      tenant_id: profile.tenant_id,
      bank_account_id,
      direction: 'out',
      amount: titulo.amount,
      moved_on: paid_on,
      description: `Pagamento: ${titulo.description}`,
      cost_center_id: titulo.cost_center_id,
      created_by: profile.id,
    })
    .select('id')

  if (erroMov) return traduz(erroMov)
  if (!mov || mov.length === 0) return falha()

  const { data, error } = await supabase
    .from('payables')
    .update({
      status: 'paid',
      paid_on,
      bank_account_id,
      bank_movement_id: (mov[0] as { id: string }).id,
    })
    .eq('id', id)
    .select('id')

  if (error) {
    // Compensa: sem isto a conta ficaria debitada por um pagamento que a tela diz
    // não ter acontecido.
    await supabase.from('bank_account_movements').delete().eq('id', (mov[0] as { id: string }).id)
    return traduz(error)
  }
  if (!data || data.length === 0) return falha()

  void grupo
  revalidatePath(PAGAR)
  revalidatePath('/financeiro/contas-bancarias')
  return { success: 'Pagamento registrado e lançado na conta.' }
}

export async function setPayableStatus(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const alvo = String(formData.get('status') ?? '')
  // Cancelar é a única mudança de situação livre nesta ação; aprovar e pagar têm
  // ações próprias porque exigem dado adicional e permissão diferente.
  if (alvo !== 'cancelled') return falha('Mudança de situação inválida para esta ação.')

  const gate = await requirePermission('financeiro.titulos_pagar.cancelar')
  if ('error' in gate) return gate

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return falha('Registro inválido.')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('payables')
    .update({ status: 'cancelled' })
    .eq('id', id.data)
    .select('id')

  if (error) return traduz(error)
  if (!data || data.length === 0) return falha()

  revalidatePath(PAGAR)
  return { success: 'Título cancelado.' }
}

/* ========================================================================== */
/* Títulos a receber                                                          */
/* ========================================================================== */

export async function createReceivable(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await requirePermission('financeiro.titulos_receber.criar')
  if ('error' in gate) return gate
  const { profile } = await requireSession()
  if (!profile.tenant_id) return falha('Sessão sem tenant.')

  const dados = Object.fromEntries(formData)
  const parsed = receivableSchema.safeParse(dados)
  if (!parsed.success) return falha(parsed.error.issues[0]?.message ?? 'Dados inválidos.')

  const parcelas = installmentCountSchema.safeParse(dados.parcelas ?? '')
  if (!parcelas.success) return falha(parcelas.error.issues[0]?.message ?? 'Parcelamento inválido.')

  const supabase = await createClient()
  const total = parcelas.data
  const centavos = Math.round(parsed.data.amount * 100)
  const porParcela = Math.floor(centavos / total)
  const sobra = centavos - porParcela * total
  const base = new Date(`${parsed.data.due_on}T12:00:00Z`)

  const linhas = Array.from({ length: total }, (_, i) => {
    const venc = new Date(base)
    venc.setUTCMonth(venc.getUTCMonth() + i)
    return {
      ...parsed.data,
      tenant_id: profile.tenant_id,
      created_by: profile.id,
      // Nasce ABERTO, não em rascunho: título a receber existe porque a receita
      // foi combinada, e rascunho só adiaria o trabalho de abrir um por um.
      status: 'open' as const,
      amount: (porParcela + (i === 0 ? sobra : 0)) / 100,
      due_on: venc.toISOString().slice(0, 10),
      installment_number: i + 1,
      installment_total: total,
    }
  })

  const { data, error } = await supabase.from('receivables').insert(linhas).select('id')
  if (error) return traduz(error)
  if (!data || data.length === 0) return falha()

  revalidatePath(RECEBER)
  return { success: total > 1 ? `${total} parcelas lançadas.` : 'Título a receber lançado.' }
}

export async function updateReceivable(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await requirePermission('financeiro.titulos_receber.editar')
  if ('error' in gate) return gate

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return falha('Registro inválido.')
  const parsed = receivableSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return falha(parsed.error.issues[0]?.message ?? 'Dados inválidos.')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('receivables')
    .update(parsed.data)
    .eq('id', id.data)
    .select('id')

  if (error) return traduz(error)
  if (!data || data.length === 0) return falha()

  revalidatePath(RECEBER)
  return { success: 'Título atualizado.' }
}

/** Baixa do recebimento, com a entrada na conta. */
export async function settleReceivable(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await requirePermission('financeiro.titulos_receber.baixar')
  if ('error' in gate) return gate
  const { profile } = await requireSession()
  if (!profile.tenant_id) return falha('Sessão sem tenant.')

  const parsed = receivableSettlementSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return falha(parsed.error.issues[0]?.message ?? 'Dados inválidos.')
  const { id, bank_account_id, received_on, received_amount } = parsed.data

  const supabase = await createClient()
  const { data: titulo } = await supabase
    .from('receivables')
    .select('id, description, amount, status, cost_center_id')
    .eq('id', id)
    .maybeSingle<{
      id: string
      description: string
      amount: number
      status: string
      cost_center_id: string | null
    }>()

  if (!titulo) return falha()
  if (titulo.status !== 'open') {
    return falha(`Só título aberto pode receber baixa. Este está em "${titulo.status}".`)
  }

  const valor = received_amount ?? titulo.amount
  const { data: mov, error: erroMov } = await supabase
    .from('bank_account_movements')
    .insert({
      tenant_id: profile.tenant_id,
      bank_account_id,
      direction: 'in',
      amount: valor,
      moved_on: received_on,
      description: `Recebimento: ${titulo.description}`,
      cost_center_id: titulo.cost_center_id,
      created_by: profile.id,
    })
    .select('id')

  if (erroMov) return traduz(erroMov)
  if (!mov || mov.length === 0) return falha()

  const { data, error } = await supabase
    .from('receivables')
    .update({
      status: 'received',
      received_on,
      received_amount: valor,
      bank_account_id,
      bank_movement_id: (mov[0] as { id: string }).id,
    })
    .eq('id', id)
    .select('id')

  if (error) {
    await supabase.from('bank_account_movements').delete().eq('id', (mov[0] as { id: string }).id)
    return traduz(error)
  }
  if (!data || data.length === 0) return falha()

  revalidatePath(RECEBER)
  revalidatePath('/financeiro/contas-bancarias')
  return {
    success:
      valor < titulo.amount
        ? `Baixa registrada com diferença de ${(titulo.amount - valor).toFixed(2)} — o valor original foi preservado.`
        : 'Recebimento registrado e lançado na conta.',
  }
}

export async function setReceivableStatus(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const alvo = String(formData.get('status') ?? '')
  if (!['open', 'cancelled'].includes(alvo)) {
    return falha('Mudança de situação inválida para esta ação.')
  }

  const gate = await requirePermission('financeiro.titulos_receber.cancelar')
  if ('error' in gate) return gate

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return falha('Registro inválido.')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('receivables')
    .update({ status: alvo })
    .eq('id', id.data)
    .select('id')

  if (error) return traduz(error)
  if (!data || data.length === 0) return falha()

  revalidatePath(RECEBER)
  return { success: alvo === 'cancelled' ? 'Título cancelado.' : 'Título reaberto.' }
}

/* ========================================================================== */
/* Configuração do módulo: categorias de despesa e alçada                     */
/* ========================================================================== */

export async function createExpenseCategory(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await requirePermission('financeiro.titulos_pagar.configurar')
  if ('error' in gate) return gate
  const { profile } = await requireSession()
  if (!profile.tenant_id) return falha('Sessão sem tenant.')

  const parsed = expenseCategorySchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return falha(parsed.error.issues[0]?.message ?? 'Dados inválidos.')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('expense_categories')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })
    .select('id')

  if (error) return traduz(error)
  if (!data || data.length === 0) return falha()

  revalidatePath(PAGAR)
  return { success: 'Categoria de despesa cadastrada.' }
}

export async function setExpenseCategoryActive(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await requirePermission('financeiro.titulos_pagar.configurar')
  if ('error' in gate) return gate

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return falha('Registro inválido.')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('expense_categories')
    .update({ is_active: formData.get('is_active') === 'true' })
    .eq('id', id.data)
    .select('id')

  if (error) return traduz(error)
  if (!data || data.length === 0) return falha()

  revalidatePath(PAGAR)
  return { success: 'Situação da categoria atualizada.' }
}

/**
 * Cadastra uma faixa de alçada.
 *
 * Este é o ponto em que a regra que eu me recusei a inventar entra no sistema —
 * digitada por quem tem autoridade para decidi-la, não escolhida por mim.
 */
export async function createApprovalRule(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await requirePermission('financeiro.titulos_pagar.configurar')
  if ('error' in gate) return gate
  const { profile } = await requireSession()
  if (!profile.tenant_id) return falha('Sessão sem tenant.')

  const parsed = approvalRuleSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return falha(parsed.error.issues[0]?.message ?? 'Dados inválidos.')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('approval_rules')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })
    .select('id')

  if (error) return traduz(error)
  if (!data || data.length === 0) return falha()

  revalidatePath(PAGAR)
  return { success: 'Faixa de alçada cadastrada.' }
}

export async function deleteApprovalRule(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await requirePermission('financeiro.titulos_pagar.configurar')
  if ('error' in gate) return gate

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return falha('Registro inválido.')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('approval_rules')
    .delete()
    .eq('id', id.data)
    .select('id')

  if (error) return traduz(error)
  if (!data || data.length === 0) return falha()

  revalidatePath(PAGAR)
  return { success: 'Faixa removida.' }
}

/**
 * Liga ou desliga a exigência de aprovação no tenant.
 *
 * Ligar sem nenhuma faixa cadastrada deixaria todo lançamento novo falhando com o
 * erro da função de alçada. Então a ação confere antes e recusa com a explicação,
 * em vez de deixar a pessoa descobrir no primeiro título.
 */
export async function setApprovalRequired(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await requirePermission('financeiro.titulos_pagar.configurar')
  if ('error' in gate) return gate
  const { profile } = await requireSession()
  if (!profile.tenant_id) return falha('Sessão sem tenant.')

  const ligar = formData.get('required') === 'true'
  const supabase = await createClient()

  if (ligar) {
    const { count } = await supabase
      .from('approval_rules')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', true)
    if (!count) {
      return falha(
        'Cadastre ao menos uma faixa de alçada antes de exigir aprovação — sem faixa, todo título novo seria recusado.',
      )
    }
  }

  const { data, error } = await supabase
    .from('tenants')
    .update({ payable_approval_required: ligar })
    .eq('id', profile.tenant_id)
    .select('id')

  if (error) return traduz(error)
  if (!data || data.length === 0) return falha()

  revalidatePath(PAGAR)
  return {
    success: ligar
      ? 'Aprovação de títulos ligada. Novo título passa a nascer aguardando aprovação.'
      : 'Aprovação de títulos desligada. Novo título nasce já aprovado.',
  }
}
