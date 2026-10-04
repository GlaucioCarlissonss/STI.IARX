'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { NAO_AFETADO, mensagemDeErro } from '@/lib/actions/erros'
import { permitirEscrita } from '@/lib/actions/guarda'
import type { ActionState } from '@/lib/actions/estado'
import { recordId, supplierContractSchema, supplierSchema } from '@/lib/schemas/cadastros'

const DUPLICATE = 'Já existe um fornecedor com este CNPJ.'

export async function createSupplier(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('fornecedores.cadastro.criar')
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = supplierSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('suppliers')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) return { error: mensagemDeErro(error, DUPLICATE) }

  revalidatePath('/fornecedores')
  return { success: 'Fornecedor cadastrado.' }
}

export async function updateSupplier(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('fornecedores.cadastro.editar')
  if ('error' in gate) return gate

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

  if (error) return { error: mensagemDeErro(error, DUPLICATE) }
  if (!updated?.length) return { error: NAO_AFETADO }

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
  const gate = await permitirEscrita('fornecedores.cadastro.inativar')
  if ('error' in gate) return gate

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
  if (!updated?.length) return { error: NAO_AFETADO }

  revalidatePath('/fornecedores')
  revalidatePath('/inventario')
  return { success: isActive ? 'Fornecedor reativado.' : 'Fornecedor inativado.' }
}

/* --- Contratos de fornecedor ---------------------------------------------- */

export async function createSupplierContract(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('fornecedores.contratos.criar')
  if ('error' in gate) return gate
  const { profile } = gate

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
  const gate = await permitirEscrita('fornecedores.contratos.editar')
  if ('error' in gate) return gate

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
  if (!updated?.length) return { error: NAO_AFETADO }

  revalidatePath('/fornecedores')
  return { success: 'Contrato atualizado.' }
}

export async function setSupplierContractActive(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('fornecedores.contratos.inativar')
  if ('error' in gate) return gate

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
  if (!updated?.length) return { error: NAO_AFETADO }

  revalidatePath('/fornecedores')
  return { success: isActive ? 'Contrato reativado.' : 'Contrato inativado.' }
}
