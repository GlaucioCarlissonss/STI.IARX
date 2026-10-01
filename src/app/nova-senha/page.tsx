import type { Metadata } from 'next'
import { NewPasswordForm } from './new-password-form'

export const metadata: Metadata = { title: 'Nova senha' }

/**
 * Tela da senha nova, no fim do link de recuperação.
 *
 * NÃO está na lista de rotas públicas do `proxy.ts` de propósito: quem chega
 * aqui sem ter passado por `/auth/confirmar` não tem sessão, e o proxy já o
 * manda para o login. Deixá-la pública exibiria um formulário de troca de senha
 * para qualquer visitante — que não trocaria nada, mas confundiria.
 */
export default function NovaSenhaPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-surface-2)] px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="text-2xl font-bold tracking-tight text-[var(--color-brand)]">STI</p>
          <h1 className="mt-2 text-lg font-semibold text-[var(--color-ink)]">Criar nova senha</h1>
          <p className="mt-1 text-sm text-[var(--color-ink-2)]">
            Escolha a senha que você vai usar para entrar a partir de agora.
          </p>
        </div>

        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <NewPasswordForm />
        </div>
      </div>
    </main>
  )
}
