'use server'

import { createClient } from '@/lib/supabase/server'
import { recoveryEmailSchema } from '@/lib/schemas/auth'
import type { AuthFormState } from '@/app/login/actions'

/**
 * Pede o e-mail de redefinição de senha.
 *
 * DUAS DECISÕES DE SEGURANÇA, e nenhuma é detalhe:
 *
 * 1. **A resposta é sempre a mesma.** Dizer "não encontramos esse e-mail" daria
 *    a qualquer um uma forma de descobrir quem tem conta aqui — o mesmo motivo
 *    pelo qual `signIn` devolve "e-mail ou senha incorretos" sem distinguir os
 *    dois casos. Erro do Supabase é registrado no servidor e some da tela.
 *
 * 2. **O destino do link vem de `NEXT_PUBLIC_SITE_URL`, não do cabeçalho da
 *    requisição.** Derivar do `Host` seria cômodo e perigoso: quem controla
 *    esse cabeçalho controlaria para onde o link de redefinição aponta, e o
 *    e-mail legítimo levaria a pessoa para o site de quem atacou. Sem a variável
 *    configurada o fluxo recusa em vez de adivinhar.
 *
 *    O Supabase ainda valida esse destino contra a lista de URLs permitidas
 *    (Authentication → URL Configuration) — é a trava final, e ela precisa
 *    conhecer o endereço. Ver `docs/09-conectar-no-supabase.md`.
 */
export async function requestPasswordReset(
  _prev: AuthFormState & { sent?: boolean },
  formData: FormData,
): Promise<AuthFormState & { sent?: boolean }> {
  const parsed = recoveryEmailSchema.safeParse({ email: formData.get('email') })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const site = process.env.NEXT_PUBLIC_SITE_URL
  if (!site) {
    return {
      error:
        'A recuperação de senha ainda não foi configurada neste ambiente. Peça ao administrador para definir o endereço público do sistema.',
    }
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${site.replace(/\/+$/, '')}/auth/confirmar`,
  })

  if (error) {
    // Vai para o log do servidor, não para a tela — ver a decisão 1 acima.
    console.error('[recuperar-senha] falha ao enviar e-mail:', error.message)
  }

  return { sent: true }
}
