import type { Metadata } from 'next'
import Link from 'next/link'
import { RecoverForm } from './recover-form'

export const metadata: Metadata = { title: 'Recuperar senha' }

export default async function RecuperarSenhaPage({
  searchParams,
}: {
  searchParams: Promise<{ expirado?: string }>
}) {
  const { expirado } = await searchParams

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-surface-2)] px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="text-2xl font-bold tracking-tight text-[var(--color-brand)]">STI</p>
          <h1 className="mt-2 text-lg font-semibold text-[var(--color-ink)]">Recuperar senha</h1>
          <p className="mt-1 text-sm text-[var(--color-ink-2)]">
            Informe o e-mail da sua conta e enviaremos um link para criar uma senha nova.
          </p>
        </div>

        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          {/* Link expirado, já usado ou adulterado chegam todos com este aviso: a
              ação de quem o vê é a mesma nos três casos — pedir outro. */}
          {expirado && (
            <p
              role="alert"
              className="mb-4 rounded-lg bg-[var(--color-warn-soft)] px-3.5 py-2.5 text-sm font-medium text-[var(--color-warn-ink)]"
            >
              Esse link não vale mais. Peça um novo abaixo.
            </p>
          )}
          <RecoverForm />
        </div>

        <p className="mt-6 text-center text-sm">
          <Link href="/login" className="font-medium text-[var(--color-brand-ink)] hover:underline">
            Voltar para o login
          </Link>
        </p>
      </div>
    </main>
  )
}
