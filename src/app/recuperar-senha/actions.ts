'use server'

import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { modoLocal } from '@/lib/db/modo'
import { ipDoCliente, origemHasheada, permitirRequisicao } from '@/lib/limite'
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

  /*
   * MODO LOCAL: o fluxo é NOSSO, e até a migração 0057 ele não existia.
   *
   * O cliente local respondia a `resetPasswordForEmail` com sucesso e não
   * enviava nada — decisão honesta enquanto a tela era só de desenvolvimento,
   * porque inventar um link que "funciona" seria pior. Com a porta pública em
   * `sti.iarx.com.br`, deixou de ser aceitável: clicar em "esqueci a senha" às
   * onze da noite e não receber nada é o pior dos dois mundos.
   *
   * Agora o token é emitido e gravado como hash pelo banco (0057), e o e-mail
   * sai pela mesma caixa de saída do aviso de SLA — que já drena no agendador e
   * já tem nova tentativa com espera crescente.
   *
   * A chamada é com a chave de serviço porque quem pede não tem sessão: é uma
   * tela pública, por definição anônima. O que contém o estrago é a própria
   * função ser `security definer`, não aceitar o usuário como parâmetro (ela o
   * descobre pelo e-mail) e devolver apenas o token — nunca dados da conta.
   */
  if (modoLocal()) {
    try {
      const admin = createAdminClient()

      /*
       * O FREIO POR ORIGEM, antes de emitir (migração 0059).
       *
       * A espera de 60 segundos da 0057 é por CONTA: protege a caixa de uma
       * pessoa de receber trinta links. Não protege de quem varre uma lista de
       * e-mails vazados — ali cada endereço com conta recebe uma mensagem
       * legítima, nenhuma conta passa do limite dela, e o que sobra é o nosso
       * domínio denunciado como remetente de spam. Isso derrubaria TODO o
       * e-mail do sistema, inclusive o aviso de SLA.
       *
       * A recusa é SILENCIOSA — `sent: true`, como todo o resto desta ação.
       * Responder "muitas tentativas" confirmaria que o limite existe e qual é,
       * e daria a quem está varrendo a informação de quando voltar.
       */
      const cabecalhos = await headers()
      const origem = origemHasheada(
        ipDoCliente({
          xForwardedFor: cabecalhos.get('x-forwarded-for'),
          xRealIp: cabecalhos.get('x-real-ip'),
        }),
      )

      if (!(await permitirRequisicao(admin, 'password_reset', origem))) {
        return { sent: true }
      }

      const { error } = await admin.schema('app').rpc('emitir_token_de_acesso', {
        p_email: parsed.data.email,
        p_purpose: 'password_reset',
        p_minutos: 60,
      })
      if (error) console.error('[recuperar-senha] falha ao emitir token:', error.message)
    } catch (e) {
      console.error('[recuperar-senha] falha ao emitir token:', e)
    }
    /*
     * `sent: true` mesmo quando a função devolveu null — e devolver null é o
     * caso comum: e-mail sem conta, conta inativa, ou pedido repetido dentro de
     * um minuto. Diferenciar aqui desfaria do lado de fora a proteção que o
     * banco aplica do lado de dentro.
     */
    return { sent: true }
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
