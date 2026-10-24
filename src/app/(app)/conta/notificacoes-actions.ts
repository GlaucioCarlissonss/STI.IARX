'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession } from '@/lib/session'
import type { ActionState } from '@/lib/actions/estado'
import { mensagemDeErro } from '@/lib/actions/erros'
import { KINDS_DE_AVISO } from './avisos'

const preferenciaSchema = z.object({
  kind: z.enum(KINDS_DE_AVISO as unknown as [string, ...string[]]),
  enabled: z.enum(['true', 'false']).transform((v) => v === 'true'),
})

/**
 * Liga ou desliga um aviso para a PRÓPRIA pessoa.
 *
 * Sem chave de permissão, pelo mesmo motivo do foco por empresa: escolher o que
 * se recebe é preferência de quem usa, não autoridade sobre dado. A policy
 * `notification_preferences_own` é o que garante que ninguém mexe na preferência
 * de outro — nem o administrador, de propósito: "o admin desligou meu aviso" é
 * um problema de suporte que não precisa existir.
 */
export async function definirPreferencia(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!profile.tenant_id) return { error: 'Sessão sem tenant.' }

  const parsed = preferenciaSchema.safeParse({
    kind: formData.get('kind'),
    enabled: formData.get('enabled'),
  })
  if (!parsed.success) return { error: 'Tipo de aviso inválido.' }

  const supabase = await createClient()
  const { error } = await supabase.from('notification_preferences').upsert(
    {
      tenant_id: profile.tenant_id,
      user_id: profile.id,
      kind: parsed.data.kind,
      enabled: parsed.data.enabled,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'tenant_id,user_id,kind' },
  )

  if (error) return { error: mensagemDeErro(error) }

  revalidatePath('/conta')
  return { success: parsed.data.enabled ? 'Aviso ligado.' : 'Aviso desligado.' }
}
