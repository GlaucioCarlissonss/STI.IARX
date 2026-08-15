'use server'

import { createHash } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession, canManageConfig } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'

const toggleSchema = z.object({
  integration_id: z.string().uuid('Seleção inválida.'),
  status: z.enum(['active', 'paused']),
})

export async function setIntegrationStatus(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageConfig(profile.role)) return { error: 'Apenas administradores.' }

  const parsed = toggleSchema.safeParse({
    integration_id: formData.get('integration_id'),
    status: formData.get('status'),
  })
  if (!parsed.success) return { error: 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('integrations')
    .update({ status: parsed.data.status })
    .eq('id', parsed.data.integration_id)

  if (error) return { error: error.message }

  revalidatePath('/integracoes')
  return { success: parsed.data.status === 'active' ? 'Integração ativada.' : 'Integração pausada.' }
}

const reverseSyncSchema = z.object({
  integration_id: z.string().uuid('Seleção inválida.'),
  enabled: z.enum(['true', 'false']),
})

/**
 * Liga/desliga a sincronização reversa (RF-INT-09).
 * Desligada por padrão (lacuna L-06): antes de escrever de volta no sistema do
 * cliente, alguém precisa decidir conscientemente que é isso mesmo que se quer.
 */
export async function setReverseSync(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageConfig(profile.role)) return { error: 'Apenas administradores.' }

  const parsed = reverseSyncSchema.safeParse({
    integration_id: formData.get('integration_id'),
    enabled: formData.get('enabled'),
  })
  if (!parsed.success) return { error: 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('integrations')
    .update({ reverse_sync_enabled: parsed.data.enabled === 'true' })
    .eq('id', parsed.data.integration_id)

  if (error) return { error: error.message }

  revalidatePath('/integracoes')
  return {
    success:
      parsed.data.enabled === 'true'
        ? 'Sincronização reversa ativada.'
        : 'Sincronização reversa desativada.',
  }
}

const tokenSchema = z.object({
  integration_id: z.string().uuid('Seleção inválida.'),
  token: z.string().trim().min(8, 'O token precisa ter ao menos 8 caracteres.'),
})

/**
 * Registra o token de verificação inbound.
 *
 * Guardamos apenas o SHA-256 (ADR-009): o valor em claro fica no Bitrix24 e no
 * ambiente da Edge Function. Um dump do banco não entrega credencial nenhuma.
 */
export async function setInboundToken(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageConfig(profile.role)) return { error: 'Apenas administradores.' }

  const parsed = tokenSchema.safeParse({
    integration_id: formData.get('integration_id'),
    token: formData.get('token'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const hash = createHash('sha256').update(parsed.data.token).digest('hex')

  const supabase = await createClient()
  const { error } = await supabase
    .from('integrations')
    .update({ inbound_token_hash: hash })
    .eq('id', parsed.data.integration_id)

  if (error) return { error: error.message }

  revalidatePath('/integracoes')
  return { success: 'Token registrado. Apenas o hash foi armazenado.' }
}
