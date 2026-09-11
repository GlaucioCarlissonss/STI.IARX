'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession, canManageRecords, requirePermission } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'
import {
  assetCustodySchema,
  assetSchema,
  assetStatusSchema,
  recordId,
} from '@/lib/schemas/cadastros'

const NOT_AFFECTED = 'Não foi possível salvar: registro não encontrado ou sem permissão.'
const DUPLICATE = 'Já existe um ativo com este patrimônio ou número de série.'

export async function createAsset(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('inventario.ativos.criar')
  if ('error' in gate) return gate
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
  const gate = await requirePermission('inventario.ativos.editar')
  if ('error' in gate) return gate
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
  const gate = await requirePermission('inventario.ativos.mudar_status')
  if ('error' in gate) return gate
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

/**
 * Transfere a custódia de um ativo.
 *
 * Chama a RPC `change_asset_custody` (migração 0023) em vez de fazer o `update`
 * direto, e o motivo é concreto: a trigger que grava o histórico
 * (`app.assets_after_update_history`, 0013) lê o motivo de uma variável de
 * sessão, e o cliente Supabase fala com o banco por um pool de conexões — não há
 * como definir essa variável e garantir que ela chegue na mesma transação do
 * `update`. Um `.from('it_assets').update(...)` aqui gravaria TODO evento com
 * motivo `outro`, e o campo do formulário não governaria nada.
 *
 * A RPC devolve o id do ativo, ou nulo quando o RLS negou — negação do PostgREST
 * volta como ausência de dado e nenhum erro, e dizer "salvo" nesse caso seria a
 * pior falha possível num registro patrimonial.
 */
export async function changeAssetCustody(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('inventario.ativos.custodiar')
  if ('error' in gate) return gate
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = assetCustodySchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('change_asset_custody', {
    p_asset_id: parsed.data.asset_id,
    p_user_id: parsed.data.assigned_user_id,
    p_branch_id: parsed.data.branch_id,
    p_area_id: parsed.data.branch_area_id,
    p_reason: parsed.data.reason,
    p_note: parsed.data.note,
  })

  if (error) {
    // A trigger `trg_assets_area_branch` (0013) recusa área de outra filial.
    // A mensagem crua viria como violação de constraint, em inglês.
    if (error.code === '23514' || /area/i.test(error.message)) {
      return { error: 'A área informada pertence a outra filial.' }
    }
    return { error: error.message }
  }
  if (!data) return { error: NOT_AFFECTED }

  revalidatePath('/inventario')
  return { success: 'Custódia registrada.' }
}
