'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession, canManageRecords } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'
import { assetSchema, assetStatusSchema, recordId } from '@/lib/schemas/cadastros'

const NOT_AFFECTED = 'Não foi possível salvar: registro não encontrado ou sem permissão.'
const DUPLICATE = 'Já existe um ativo com este patrimônio ou número de série.'

export async function createAsset(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão para cadastrar ativos.' }

  const parsed = assetSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('it_assets')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) {
    // Patrimônio e número de série são únicos por tenant — a mensagem crua do
    // Postgres não ajudaria quem está cadastrando.
    if (error.code === '23505') return { error: DUPLICATE }
    return { error: error.message }
  }

  revalidatePath('/inventario')
  return { success: 'Ativo cadastrado.' }
}

/**
 * Edição da ficha do ativo.
 *
 * Trocar filial ou responsável aqui é registrado por trigger
 * (`trg_assets_history`), não por esta ação — assim a mesma mudança feita por
 * importação ou SQL direto também entra no histórico de custódia.
 */
export async function updateAsset(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const parsed = assetSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('it_assets')
    .update(parsed.data)
    .eq('id', id.data)
    .select('id')

  if (error) {
    if (error.code === '23505') return { error: DUPLICATE }
    return { error: error.message }
  }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/inventario')
  return { success: 'Ativo atualizado.' }
}

/**
 * Muda o estado do ativo no ciclo de vida (RF-INV-02).
 * O evento de histórico é gravado pela trigger `trg_assets_history`, não aqui —
 * assim uma alteração feita por importação em massa também fica registrada.
 */
export async function changeAssetStatus(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = z
    .object({ asset_id: recordId, status: assetStatusSchema })
    .safeParse({ asset_id: formData.get('asset_id'), status: formData.get('status') })
  if (!parsed.success) return { error: 'Dados inválidos.' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('it_assets')
    .update({ status: parsed.data.status })
    .eq('id', parsed.data.asset_id)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/inventario')
  return { success: 'Status do ativo atualizado.' }
}
