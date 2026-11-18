import type { Metadata } from 'next'
import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import { modoLocal } from '@/lib/db/modo'

export const metadata: Metadata = { title: 'Confirmar e-mail' }
export const dynamic = 'force-dynamic'

/**
 * O que o link de confirmação abre.
 *
 * ## Por que confirma aqui, e não num botão
 *
 * Porque o ato já aconteceu: a pessoa clicou no link que só ela recebeu. Pedir
 * um segundo clique numa tela que diz "confirme sua confirmação" não acrescenta
 * prova nenhuma e perde gente no caminho.
 *
 * O risco conhecido dessa escolha é o pré-carregador de link de alguns clientes
 * de e-mail, que abre o endereço antes da pessoa. Aqui isso é inofensivo: o
 * efeito é ativar a conta de quem recebeu o e-mail, que é exatamente o que
 * deveria acontecer. Num fluxo destrutivo — cancelar, apagar — a conclusão
 * seria a oposta.
 *
 * ## Uma tela só para "não vale"
 *
 * Vencido, já usado e inventado dão a mesma resposta. Distinguir ajudaria quem
 * tenta adivinhar muito mais do que ajuda quem demorou — e para este a
 * instrução é a mesma nos três casos.
 */
export default async function ConfirmarEmail({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  let confirmou = false
  if (modoLocal() && token) {
    const admin = createAdminClient()
    const { data, error } = await admin.rpc('confirmar_email_com_token', { p_token: token })
    if (error) console.error('[confirmar-email]', error.message)
    confirmou = data === true
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-surface-2)] px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="fonte-display text-2xl font-bold tracking-tight text-[var(--color-brand)]">
            STI
          </p>
          <h1 className="mt-2 text-lg font-semibold text-[var(--color-ink)]">
            {confirmou ? 'E-mail confirmado' : 'Link sem validade'}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-ink-2)]">
            {confirmou
              ? 'A sua conta está ativa. Entre com o e-mail e a senha que você escolheu.'
              : 'Links de confirmação valem por 48 horas e servem uma vez só.'}
          </p>
        </div>

        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <div className="flex flex-col gap-4 text-center">
            {!confirmou && (
              <p className="text-sm text-[var(--color-ink-2)]">
                Se você já confirmou antes, é só entrar. Se o prazo venceu, cadastre-se de novo —
                o endereço volta a ficar livre.
              </p>
            )}
            <Link
              href="/login"
              className="w-full rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-ink)]"
            >
              Ir para a entrada
            </Link>
            {!confirmou && (
              <Link href="/criar-conta" className="text-sm text-[var(--color-ink-3)] hover:underline">
                Criar conta
              </Link>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
