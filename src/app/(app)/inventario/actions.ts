'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession, canManageRecords } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'
import { emptyToNull, optionalUuid, optionalNonNegativeNumber } from '@/lib/form-schemas'

const assetSchema = z.object({
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
  status: z.enum(['in_stock', 'active', 'maintenance', 'retired', 'lost']),
  branch_id: optionalUuid,
  assigned_user_id: optionalUuid,
  supplier_id: optionalUuid,
  acquisition_date: emptyToNull,
  warranty_until: emptyToNull,
  acquisition_cost: optionalNonNegativeNumber,
  notes: emptyToNull,
})

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
    if (error.code === '23505') {
      return { error: 'Já existe um ativo com este patrimônio ou número de série.' }
    }
    return { error: error.message }
  }

  revalidatePath('/inventario')
  return { success: 'Ativo cadastrado.' }
}

const statusSchema = z.object({
  asset_id: z.string().uuid('Seleção inválida.'),
  status: z.enum(['in_stock', 'active', 'maintenance', 'retired', 'lost']),
})

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

  const parsed = statusSchema.safeParse({
    asset_id: formData.get('asset_id'),
    status: formData.get('status'),
  })
  if (!parsed.success) return { error: 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('it_assets')
    .update({ status: parsed.data.status })
    .eq('id', parsed.data.asset_id)

  if (error) return { error: error.message }

  revalidatePath('/inventario')
  return { success: 'Status do ativo atualizado.' }
}
