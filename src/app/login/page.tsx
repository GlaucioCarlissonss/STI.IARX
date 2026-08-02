import type { Metadata } from 'next'
import { LoginForm } from './login-form'

export const metadata: Metadata = { title: 'Entrar' }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ proxima?: string }>
}) {
  const { proxima } = await searchParams

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-surface-2)] px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="text-2xl font-bold tracking-tight text-[var(--color-brand)]">STI</p>
          <h1 className="mt-2 text-lg font-semibold text-[var(--color-ink)]">
            Helpdesk e Gestão de TI
          </h1>
          <p className="mt-1 text-sm text-[var(--color-ink-2)]">
            Entre com suas credenciais para continuar.
          </p>
        </div>

        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <LoginForm proxima={proxima} />
        </div>

        <p className="mt-6 text-center text-xs text-[var(--color-ink-3)]">
          Painéis de TV não usam esta tela — eles são acessados por token de exibição.
        </p>
      </div>
    </main>
  )
}
