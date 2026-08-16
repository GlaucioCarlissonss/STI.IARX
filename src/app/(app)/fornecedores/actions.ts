'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession, canManageRecords } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'
import { recordId, supplierContractSchema, supplierSchema } from '@/lib/schemas/cadastros'

const NOT_AFFECTED = 'Não foi possível salvar: registro não encontrado ou sem permissão.'
const DUPLICATE = 'Já existe um fornecedor com este CNPJ.'

export async function createSupplier(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = supplierSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('suppliers')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) {
    if (error.code === '23505') return { error: DUPLICATE }
    return { error: error.message }
  }

  revalidatePath('/fornecedores')
  return { success: 'Fornecedor cadastrado.' }
}

export async function updateSupplier(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const parsed = supplierSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('suppliers')
    .update(parsed.data)
    .eq('id', id.data)
    .select('id')

  if (error) {
    if (error.code === '23505') return { error: DUPLICATE }
    return { error: error.message }
  }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/fornecedores')
  // Ativos e linhas mostram o fornecedor nos seletores.
  revalidatePath('/inventario')
  return { success: 'Fornecedor atualizado.' }
}

/**
 * Inativa sem apagar: contratos e ativos comprados continuam apontando para o
 * fornecedor, e a `ON DELETE RESTRICT` do banco recusaria a exclusão de
 * qualquer forma.
 */
export async function setSupplierActive(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = z
    .object({ id: recordId, is_active: z.enum(['true', 'false']) })
    .safeParse({ id: formData.get('id'), is_active: formData.get('is_active') })
  if (!parsed.success) return { error: 'Situação inválida.' }

  const isActive = parsed.data.is_active === 'true'

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('suppliers')
    .update({ is_active: isActive })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/fornecedores')
  revalidatePath('/inventario')
  return { success: isActive ? 'Fornecedor reativado.' : 'Fornecedor inativado.' }
}

/* --- Contratos de fornecedor ---------------------------------------------- */

export async function createSupplierContract(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = supplierContractSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('supplier_contracts')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) return { error: error.message }

  revalidatePath('/fornecedores')
  return { success: 'Contrato cadastrado.' }
}

export async function updateSupplierContract(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const parsed = supplierContractSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('supplier_contracts')
    .update(parsed.data)
    .eq('id', id.data)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/fornecedores')
  return { success: 'Contrato atualizado.' }
}

export async function setSupplierContractActive(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = z
    .object({ id: recordId, is_active: z.enum(['true', 'false']) })
    .safeParse({ id: formData.get('id'), is_active: formData.get('is_active') })
  if (!parsed.success) return { error: 'Situação inválida.' }

  const isActive = parsed.data.is_active === 'true'

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('supplier_contracts')
    .update({ is_active: isActive })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/fornecedores')
  return { success: isActive ? 'Contrato reativado.' : 'Contrato inativado.' }
}
