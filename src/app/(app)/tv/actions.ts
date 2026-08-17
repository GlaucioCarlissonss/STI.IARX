'use server'

import { randomBytes, createHash } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession, canManageRecords, requirePermission } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'

const createTokenSchema = z.object({
  name: z.string().trim().min(3, 'Dê um nome ao painel (ex.: TV Recepção Matriz).'),
  layout_id: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : v))
    .pipe(z.union([z.string().uuid('Seleção inválida.'), z.null()])),
  branch_ids: z.array(z.string().uuid('Seleção inválida.')).default([]),
})

export interface TokenActionState extends ActionState {
  /** Segredo em claro. Só existe nesta resposta — depois disso, só o hash. */
  plainToken?: string
}

/**
 * Emite um token de exibição para painel de TV (ADR-006).
 *
 * O segredo é gerado aqui, devolvido UMA única vez para o administrador copiar,
 * e persistido apenas como SHA-256. Não há como recuperá-lo depois: se perder,
 * emite-se outro e revoga-se o anterior.
 */
export async function createDashboardToken(
  _prev: TokenActionState,
  formData: FormData,
): Promise<TokenActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('tv.tokens.criar')
  if ('error' in gate) return gate
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão para emitir tokens.' }

  const parsed = createTokenSchema.safeParse({
    name: formData.get('name'),
    layout_id: formData.get('layout_id'),
    branch_ids: formData.getAll('branch_ids').filter((v): v is string => typeof v === 'string' && v !== ''),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  // 32 bytes de entropia criptográfica. Base64url para caber numa URL sem escape.
  const plain = randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(plain).digest('hex')

  const supabase = await createClient()
  const { error } = await supabase.from('dashboard_tokens').insert({
    tenant_id: profile.tenant_id,
    layout_id: parsed.data.layout_id,
    name: parsed.data.name,
    token_hash: hash,
    branch_ids: parsed.data.branch_ids,
    created_by: profile.id,
  })

  if (error) return { error: error.message }

  revalidatePath('/tv')
  return { success: 'Token emitido. Copie agora — ele não será exibido novamente.', plainToken: plain }
}

export async function revokeDashboardToken(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('tv.tokens.revogar')
  if ('error' in gate) return gate
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão para revogar tokens.' }

  const id = formData.get('token_id')
  if (typeof id !== 'string') return { error: 'Token inválido.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('dashboard_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)

  if (error) return { error: error.message }

  revalidatePath('/tv')
  return { success: 'Token revogado. O painel para de funcionar imediatamente.' }
}
