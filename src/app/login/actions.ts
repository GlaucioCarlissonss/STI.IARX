'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import type { Route } from 'next'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'

const credentialsSchema = z.object({
  email: z.string().email('Informe um e-mail válido.'),
  password: z.string().min(1, 'Informe a senha.'),
})

export interface AuthFormState {
  error?: string
}

export async function signIn(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword(parsed.data)

  if (error) {
    // Mensagem genérica de propósito: distinguir "e-mail não existe" de "senha
    // errada" entrega ao atacante uma forma de enumerar contas válidas.
    return { error: 'E-mail ou senha incorretos.' }
  }

  /*
   * CONTA DESATIVADA NÃO ENTRA — e até aqui entrava.
   *
   * A tela de usuários oferece inativar alguém desde que existe, e `is_active`
   * era lido em `getSessionContext` e nunca aplicado: quem fosse desativado
   * continuava entrando e usando o sistema normalmente. Medi antes de afirmar —
   * desativei uma conta do exemplo e ela chegou ao painel.
   *
   * É a diferença entre "tirei o acesso dessa pessoa" e "mudei um campo que não
   * faz nada", e quem desativa acredita na primeira.
   *
   * A mensagem aqui é específica, e isso é seguro: neste ponto a senha JÁ foi
   * conferida. Quem chegou aqui provou ser o dono da conta, então dizer-lhe que
   * ela está desativada não informa estranho nenhum — e a alternativa,
   * "e-mail ou senha incorretos", mandaria a pessoa tentar de novo para sempre.
   */
  const { data: perfil } = await supabase
    .from('profiles')
    .select('is_active')
    .eq('id', (await supabase.auth.getUser()).data.user?.id ?? '')
    .maybeSingle<{ is_active: boolean }>()

  if (perfil && !perfil.is_active) {
    await supabase.auth.signOut()
    return {
      error:
        'Esta conta está desativada. Procure o administrador da sua empresa para reativá-la.',
    }
  }

  // Só aceitamos caminho relativo iniciado por "/" e sem "//": um destino como
  // "//site-malicioso.com" seria tratado pelo navegador como URL absoluta,
  // transformando o login em um redirecionador aberto.
  const next = formData.get('proxima')
  const isSafeInternalPath =
    typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')

  revalidatePath('/', 'layout')
  redirect(isSafeInternalPath ? (next as Route) : '/painel')
}

export async function signOut(): Promise<void> {
  const supabase = await createClient()
  await supabase.auth.signOut()
  revalidatePath('/', 'layout')
  redirect('/login')
}
