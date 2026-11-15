import type { Metadata } from 'next'
import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import { modoLocal } from '@/lib/db/modo'
import { FormularioDeSenhaComToken } from './formulario'

export const metadata: Metadata = { title: 'Nova senha' }

/* O token é um segredo de curta vida: nenhuma resposta desta rota pode ser
   guardada por cache, nem do navegador nem de proxy. */
export const dynamic = 'force-dynamic'

/**
 * A tela que o link de recuperação abre, no modo local.
 *
 * ## Por que ela confere o token ANTES de desenhar o formulário
 *
 * Porque pedir duas senhas, confirmar, enviar e só então ouvir "este link não
 * vale mais" é desperdiçar o esforço de alguém que já estava num dia ruim. A
 * conferência aqui é só leitura — `token_de_acesso_vale` não gasta nada — e o
 * token continua sendo consumido na hora de gravar, que é onde o uso único
 * precisa ser garantido.
 *
 * ## O que ela não diz
 *
 * "Expirado", "já usado" e "não existe" produzem a MESMA tela. A distinção
 * ajudaria quem tenta adivinhar token muito mais do que ajuda quem perdeu o
 * prazo — e para este a instrução é a mesma nos três casos: peça outro link.
 */
export default async function NovaSenhaComToken({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  let vale = false
  if (modoLocal() && token) {
    const admin = createAdminClient()
    const { data } = await admin.rpc('token_de_acesso_vale', {
      p_token: token,
      p_purpose: 'password_reset',
    })
    vale = data === true
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-surface-2)] px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="fonte-display text-2xl font-bold tracking-tight text-[var(--color-brand)]">
            STI
          </p>
          <h1 className="mt-2 text-lg font-semibold text-[var(--color-ink)]">
            {vale ? 'Criar nova senha' : 'Link sem validade'}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-ink-2)]">
            {vale
              ? 'Escolha a senha que você vai usar para entrar a partir de agora.'
              : 'Links de redefinição valem por uma hora e servem uma vez só.'}
          </p>
        </div>

        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          {vale ? (
            <FormularioDeSenhaComToken token={token} />
          ) : (
            <div className="flex flex-col gap-4 text-center">
              <p className="text-sm text-[var(--color-ink-2)]">
                Peça um novo e-mail de redefinição — leva um minuto, e o anterior deixa de valer
                assim que o novo chega.
              </p>
              <Link
                href="/recuperar-senha"
                className="w-full rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-ink)]"
              >
                Pedir novo link
              </Link>
              <Link href="/login" className="text-sm text-[var(--color-ink-3)] hover:underline">
                Voltar para a entrada
              </Link>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
