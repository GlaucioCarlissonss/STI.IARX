'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'

const changePasswordSchema = z
  .object({
    password: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres.'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    message: 'As senhas não coincidem.',
    path: ['confirm'],
  })

/**
 * Troca a própria senha (RF-USR-03).
 *
 * Sem confirmar a senha atual: a sessão já prova quem a pessoa é, e o Supabase
 * não pede a senha antiga para `updateUser` — pedir aqui só duplicaria uma
 * checagem que o próprio login já fez. É também o único jeito de sair da senha
 * temporária que `createUserAccount` gera, já que não há fluxo de e-mail.
 */
export async function changePassword(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSession()

  const parsed = changePasswordSchema.safeParse({
    password: formData.get('password'),
    confirm: formData.get('confirm'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password })

  if (error) return { error: error.message }

  return { success: 'Senha atualizada.' }
}
