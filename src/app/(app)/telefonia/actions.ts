'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession, canManageRecords } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'
import { emptyToNull, optionalUuid, optionalNonNegativeNumber } from '@/lib/form-schemas'

const lineSchema = z
  .object({
    phone_number: z.string().trim().min(8, 'Informe o número da linha.'),
    carrier: z.string().trim().min(2, 'Informe a operadora.'),
    plan_name: emptyToNull,
    line_type: z.enum(['postpaid', 'prepaid', 'control']),
    status: z.enum(['active', 'suspended', 'cancelled']),
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

export async function createTelecomLine(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão para cadastrar linhas.' }

  const parsed = lineSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('telecom_lines')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) {
    if (error.code === '23505') return { error: 'Este número já está cadastrado.' }
    return { error: error.message }
  }

  revalidatePath('/telefonia')
  return { success: 'Linha cadastrada.' }
}
