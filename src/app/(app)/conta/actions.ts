'use server'

import { createClient } from '@/lib/supabase/server'
import { requireSession } from '@/lib/session'
import { newPasswordSchema } from '@/lib/schemas/auth'
import type { ActionState } from '@/app/(app)/tickets/actions'

/**
 * Troca a própria senha (RF-USR-03).
 *
 * Sem confirmar a senha atual: a sessão já prova quem a pessoa é, e o Supabase
 * não pede a senha antiga para `updateUser` — pedir aqui só duplicaria uma
 * checagem que o próprio login já fez.
 *
 * Esta é a troca de quem ESTÁ dentro. Quem esqueceu a senha usa
 * `/recuperar-senha`, que existe desde que o fluxo por e-mail foi ligado — antes
 * dele, esta tela era a única saída da senha temporária gerada em
 * `createUserAccount`, e quem não conseguia entrar dependia de um administrador.
 *
 * A regra de senha mora em `src/lib/schemas/auth.ts`: é a MESMA aqui e no fluxo
 * de recuperação, e duas cópias divergiriam na primeira vez que alguém mexesse
 * no mínimo de caracteres.
 */
export async function changePassword(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSession()

  const parsed = newPasswordSchema.safeParse({
    password: formData.get('password'),
    confirm: formData.get('confirm'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password })

  if (error) return { error: error.message }

  return { success: 'Senha atualizada.' }
}
