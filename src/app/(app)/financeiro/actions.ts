'use server'

import { randomUUID } from 'crypto'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession, requirePermission } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'
import {
  bankAccountSchema,
  bankMovementSchema,
  bankTransferSchema,
  costCenterSchema,
  recordId,
} from '@/lib/schemas/cadastros'

const NOT_AFFECTED = 'Não foi possível salvar: registro não encontrado ou sem permissão.'
const DEPTH = 'Centros de custo suportam no máximo 3 níveis.'

/* --- Centros de custo ------------------------------------------------------ */

export async function createCostCenter(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('financeiro.centros_custo.criar')
  if ('error' in gate) return gate

  const parsed = costCenterSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('cost_centers')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) {
    if (error.code === '23505') return { error: 'Já existe um centro de custo com este código.' }
    if (error.code === '23514') return { error: DEPTH }
    return { error: error.message }
  }

  revalidatePath('/financeiro/centros-de-custo')
  return { success: 'Centro de custo cadastrado.' }
}

export async function updateCostCenter(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSession()
  const gate = await requirePermission('financeiro.centros_custo.editar')
  if ('error' in gate) return gate

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const parsed = costCenterSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  if (parsed.data.parent_id === id.data) {
    return { error: 'Um centro de custo não pode ser pai de si mesmo.' }
  }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('cost_centers')
    .update(parsed.data)
    .eq('id', id.data)
    .select('id')

  if (error) {
    if (error.code === '23505') return { error: 'Já existe um centro de custo com este código.' }
    // A trigger cobre profundidade e ciclo com o mesmo errcode.
    if (error.code === '23514') return { error: `${DEPTH} A hierarquia também não pode formar ciclo.` }
    return { error: error.message }
  }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/financeiro/centros-de-custo')
  return { success: 'Centro de custo atualizado.' }
}

export async function setCostCenterActive(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSession()
  const gate = await requirePermission('financeiro.centros_custo.inativar')
  if ('error' in gate) return gate

  const parsed = z
    .object({ id: recordId, is_active: z.enum(['true', 'false']) })
    .safeParse({ id: formData.get('id'), is_active: formData.get('is_active') })
  if (!parsed.success) return { error: 'Situação inválida.' }

  const isActive = parsed.data.is_active === 'true'

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('cost_centers')
    .update({ is_active: isActive })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/financeiro/centros-de-custo')
  return { success: isActive ? 'Centro de custo reativado.' : 'Centro de custo inativado.' }
}

/* --- Contas bancárias ------------------------------------------------------ */

export async function createBankAccount(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('financeiro.contas_bancarias.criar')
  if ('error' in gate) return gate

  const parsed = bankAccountSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('bank_accounts')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) {
    if (error.code === '23505') {
      return { error: 'Já existe uma conta com este banco, agência e número.' }
    }
    return { error: error.message }
  }

  revalidatePath('/financeiro/contas-bancarias')
  return { success: 'Conta bancária cadastrada.' }
}

export async function updateBankAccount(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSession()
  const gate = await requirePermission('financeiro.contas_bancarias.editar')
  if ('error' in gate) return gate

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const parsed = bankAccountSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('bank_accounts')
    .update(parsed.data)
    .eq('id', id.data)
    .select('id')

  if (error) {
    if (error.code === '23505') {
      return { error: 'Já existe uma conta com este banco, agência e número.' }
    }
    return { error: error.message }
  }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/financeiro/contas-bancarias')
  return { success: 'Conta bancária atualizada.' }
}

export async function setBankAccountStatus(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSession()
  const gate = await requirePermission('financeiro.contas_bancarias.inativar')
  if ('error' in gate) return gate

  const parsed = z
    .object({ id: recordId, status: z.enum(['active', 'inactive', 'blocked']) })
    .safeParse({ id: formData.get('id'), status: formData.get('status') })
  if (!parsed.success) return { error: 'Situação inválida.' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('bank_accounts')
    .update({ status: parsed.data.status })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/financeiro/contas-bancarias')
  return { success: 'Situação da conta atualizada.' }
}

/* --- Movimentações --------------------------------------------------------- */

export async function createBankMovement(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('financeiro.contas_bancarias.movimentar')
  if ('error' in gate) return gate

  const parsed = bankMovementSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase.from('bank_account_movements').insert({
    ...parsed.data,
    tenant_id: profile.tenant_id,
    created_by: profile.id,
  })

  if (error) return { error: error.message }

  revalidatePath('/financeiro/contas-bancarias')
  return { success: 'Movimentação lançada.' }
}

/**
 * Transferência entre contas do tenant.
 *
 * Grava as DUAS metades numa única chamada, com o mesmo `transfer_group`. A
 * trigger `trg_movements_transfer_pairs` é `deferrable` justamente para isso:
 * gravar a saída e a entrada em dois `insert` separados deixaria a primeira
 * metade sozinha no banco se o segundo falhasse — dinheiro que saiu de uma conta
 * e não entrou em nenhuma.
 */
export async function transferBetweenAccounts(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('financeiro.contas_bancarias.transferir')
  if ('error' in gate) return gate

  const parsed = bankTransferSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const { from_account_id, to_account_id, amount, moved_on, description } = parsed.data
  const grupo = randomUUID()

  const supabase = await createClient()
  const { error } = await supabase.from('bank_account_movements').insert([
    {
      tenant_id: profile.tenant_id,
      bank_account_id: from_account_id,
      direction: 'out',
      amount,
      moved_on,
      description,
      transfer_group: grupo,
      created_by: profile.id,
    },
    {
      tenant_id: profile.tenant_id,
      bank_account_id: to_account_id,
      direction: 'in',
      amount,
      moved_on,
      description,
      transfer_group: grupo,
      created_by: profile.id,
    },
  ])

  if (error) return { error: error.message }

  revalidatePath('/financeiro/contas-bancarias')
  return { success: 'Transferência registrada nas duas contas.' }
}

/** Marca ou desmarca a conciliação de uma movimentação com o extrato. */
export async function toggleMovementReconciled(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSession()
  const gate = await requirePermission('financeiro.contas_bancarias.movimentar')
  if ('error' in gate) return gate

  const parsed = z
    .object({ id: recordId, reconciled: z.enum(['true', 'false']) })
    .safeParse({ id: formData.get('id'), reconciled: formData.get('reconciled') })
  if (!parsed.success) return { error: 'Dados inválidos.' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('bank_account_movements')
    .update({
      reconciled_at: parsed.data.reconciled === 'true' ? new Date().toISOString() : null,
    })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/financeiro/contas-bancarias')
  return {
    success: parsed.data.reconciled === 'true' ? 'Marcada como conciliada.' : 'Conciliação desfeita.',
  }
}
