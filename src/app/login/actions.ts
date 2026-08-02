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
