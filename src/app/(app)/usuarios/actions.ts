'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession, canManageConfig } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'

const ROLES = ['admin', 'gestor', 'atendente', 'solicitante', 'visualizador'] as const

const updateSchema = z.object({
  user_id: z.string().uuid(),
  role: z.enum(ROLES),
  branch_ids: z.array(z.string().uuid()).default([]),
  is_active: z.boolean(),
})

/**
 * Atualiza papel e visibilidade por filial (RF-USR-02).
 *
 * `super_admin` não aparece na lista de papéis atribuíveis de propósito: é
 * papel da operação da plataforma, e a trigger `trg_profiles_no_escalation`
 * rejeitaria a concessão de qualquer forma.
 */
export async function updateUserAccess(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageConfig(profile.role)) {
    return { error: 'Apenas administradores podem alterar acessos.' }
  }

  const parsed = updateSchema.safeParse({
    user_id: formData.get('user_id'),
    role: formData.get('role'),
    branch_ids: formData.getAll('branch_ids').filter((v): v is string => typeof v === 'string' && v !== ''),
    is_active: formData.get('is_active') === 'on',
  })

  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()

  const { error: profileError } = await supabase
    .from('profiles')
    .update({ role: parsed.data.role, is_active: parsed.data.is_active })
    .eq('id', parsed.data.user_id)

  if (profileError) return { error: profileError.message }

  // Substituição completa do conjunto de filiais: apagar e reinserir é mais
  // simples e mais seguro do que calcular o diff, e o volume é de dezenas de
  // linhas no pior caso.
  const { error: deleteError } = await supabase
    .from('user_branches')
    .delete()
    .eq('user_id', parsed.data.user_id)

  if (deleteError) return { error: deleteError.message }

  if (parsed.data.branch_ids.length > 0) {
    const { error: insertError } = await supabase.from('user_branches').insert(
      parsed.data.branch_ids.map((branchId, index) => ({
        user_id: parsed.data.user_id,
        branch_id: branchId,
        tenant_id: profile.tenant_id,
        is_primary: index === 0,
      })),
    )
    if (insertError) return { error: insertError.message }
  }

  revalidatePath('/usuarios')
  return { success: 'Acesso atualizado.' }
}
