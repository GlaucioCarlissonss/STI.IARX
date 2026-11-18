import type { Metadata } from 'next'
import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import { modoLocal } from '@/lib/db/modo'
import { FormularioDeConvite } from './formulario'

export const metadata: Metadata = { title: 'Convite' }
export const dynamic = 'force-dynamic'

interface Convite {
  empresa: string
  email: string
}

/**
 * O que o link do convite abre.
 *
 * ## A tela diz PARA ONDE a pessoa está entrando, antes de pedir a senha
 *
 * Um formulário que pede senha sem dizer de qual empresa é um formulário que
 * ninguém deveria preencher — e quem recebeu o convite pode não lembrar quem o
 * mandou. Por isso `convite_valido` devolve o nome da empresa sem gastar o
 * convite: ler não é aceitar.
 *
 * O papel NÃO aparece. Ele é informação interna de quem convidou, e anunciá-lo
 * aqui ("você entrará como atendente") só criaria conversa antes mesmo de a
 * pessoa entrar.
 */
export default async function ConvitePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  let convite: Convite | null = null
  if (modoLocal() && token) {
    const admin = createAdminClient()
    const { data } = await admin.rpc('convite_valido', { p_token: token })
    const linha = Array.isArray(data) ? data[0] : data
    if (linha?.empresa) convite = linha as Convite
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-surface-2)] px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="fonte-display text-2xl font-bold tracking-tight text-[var(--color-brand)]">
            STI
          </p>
          <h1 className="mt-2 text-lg font-semibold text-[var(--color-ink)]">
            {convite ? `Convite para a ${convite.empresa}` : 'Convite sem validade'}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-ink-2)]">
            {convite
              ? 'Escolha a sua senha para entrar. Não é preciso confirmar o e-mail: este link já chegou nele.'
              : 'Convites valem por alguns dias e servem uma vez só.'}
          </p>
        </div>

        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          {convite ? (
            <FormularioDeConvite token={token} email={convite.email} />
          ) : (
            <div className="flex flex-col gap-4 text-center">
              <p className="text-sm text-[var(--color-ink-2)]">
                Peça um convite novo a quem administra a empresa. Se você já criou a sua conta
                com este convite, é só entrar.
              </p>
              <Link
                href="/login"
                className="w-full rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-ink)]"
              >
                Ir para a entrada
              </Link>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
