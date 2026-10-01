'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { newPasswordSchema } from '@/lib/schemas/auth'
import type { ActionState } from '@/app/(app)/tickets/actions'

/**
 * Grava a senha nova de quem chegou pelo link de recuperação.
 *
 * Exige sessão — a de recuperação, criada em `/auth/confirmar`. Quem abre esta
 * rota sem ter vindo do e-mail não tem sessão nenhuma e o `proxy.ts` já o manda
 * para o login antes de chegar aqui; a checagem abaixo é a segunda tranca, para
 * o caso de a sessão expirar entre abrir a tela e enviar o formulário.
 *
 * Mesma regra de senha de `/conta` — vem de `src/lib/schemas/auth.ts`.
 */
export async function setNewPassword(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return {
      error: 'O link expirou. Peça um novo e-mail de redefinição.',
    }
  }

  const parsed = newPasswordSchema.safeParse({
    password: formData.get('password'),
    confirm: formData.get('confirm'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password })
  if (error) return { error: error.message }

  /* Entra direto: a sessão de recuperação já é uma sessão válida, e mandar de
     volta ao login faria a pessoa digitar agora a senha que acabou de escolher. */
  revalidatePath('/', 'layout')
  redirect('/painel')
}
