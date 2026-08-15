'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession, canManageRecords } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'
import {
  branchSchema,
  clientSchema,
  clientStatusSchema,
  recordId,
} from '@/lib/schemas/cadastros'

/**
 * Mensagem única para o caso em que a escrita não atingiu linha nenhuma.
 *
 * Um `update` barrado pelo RLS não devolve erro — devolve zero linhas. Sem esta
 * checagem a tela diria "salvo" e o dado continuaria como estava, que é a pior
 * das falhas possíveis num cadastro: silenciosa e convincente.
 */
const NOT_AFFECTED = 'Não foi possível salvar: registro não encontrado ou sem permissão.'

export async function createClientRecord(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = clientSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('clients')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) {
    if (error.code === '23505') return { error: 'Já existe um cliente com este CNPJ.' }
    return { error: error.message }
  }

  revalidatePath('/clientes')
  return { success: 'Cliente cadastrado.' }
}

export async function updateClientRecord(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const parsed = clientSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('clients')
    .update(parsed.data)
    .eq('id', id.data)
    .select('id')

  if (error) {
    if (error.code === '23505') return { error: 'Já existe um cliente com este CNPJ.' }
    return { error: error.message }
  }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/clientes')
  return { success: 'Cliente atualizado.' }
}

/**
 * Muda a situação do cliente sem apagá-lo.
 *
 * Cliente inativo carrega filiais, tickets e contratos históricos; excluir
 * levaria junto o registro do que já foi atendido. Inativar é reversível e
 * preserva a história — por isso não existe exclusão aqui.
 */
export async function setClientStatus(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = z
    .object({ id: recordId, status: clientStatusSchema })
    .safeParse({ id: formData.get('id'), status: formData.get('status') })
  if (!parsed.success) return { error: 'Situação inválida.' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('clients')
    .update({ status: parsed.data.status })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/clientes')
  return {
    success: parsed.data.status === 'active' ? 'Cliente reativado.' : 'Situação atualizada.',
  }
}

export async function createBranch(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = branchSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('branches')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) return { error: error.message }

  revalidatePath('/clientes')
  return { success: 'Filial cadastrada.' }
}

export async function updateBranch(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const parsed = branchSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('branches')
    .update(parsed.data)
    .eq('id', id.data)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NOT_AFFECTED }

  // O endereço da filial mora em /mapas e alimenta a geolocalização: alterar
  // cidade ou UF aqui muda o que aquela tela mostra.
  revalidatePath('/clientes')
  revalidatePath('/mapas')
  return { success: 'Filial atualizada.' }
}

export async function setBranchActive(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = z
    .object({ id: recordId, is_active: z.enum(['true', 'false']) })
    .safeParse({ id: formData.get('id'), is_active: formData.get('is_active') })
  if (!parsed.success) return { error: 'Situação inválida.' }

  const isActive = parsed.data.is_active === 'true'

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('branches')
    .update({ is_active: isActive })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/clientes')
  revalidatePath('/mapas')
  return { success: isActive ? 'Filial reativada.' : 'Filial inativada.' }
}
