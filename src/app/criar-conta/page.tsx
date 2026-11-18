import type { Metadata } from 'next'
import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import { modoLocal } from '@/lib/db/modo'
import { FormularioDeCadastro } from './formulario'

export const metadata: Metadata = { title: 'Criar conta' }
export const dynamic = 'force-dynamic'

/**
 * A porta de entrada de quem ainda não é cliente.
 *
 * O prazo de avaliação vem do banco (`platform_settings.trial_days`), e não de
 * uma constante aqui: a mesma pergunta é respondida na hora de criar a empresa,
 * e dois lugares com o mesmo número é um deles errado mais cedo ou mais tarde.
 */
export default async function CriarContaPage() {
  let dias = 90
  let aberto = true

  if (modoLocal()) {
    const admin = createAdminClient()
    const [{ data: d }, { data: a }] = await Promise.all([
      admin.schema('app').rpc('parametro_numerico', { p_chave: 'trial_days', p_padrao: 90 }),
      admin.schema('app').rpc('parametro_ligado', { p_chave: 'signup_aberto', p_padrao: true }),
    ])
    if (typeof d === 'number') dias = d
    if (a === false) aberto = false
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-surface-2)] px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <p className="fonte-display text-2xl font-bold tracking-tight text-[var(--color-brand)]">
            STI
          </p>
          <h1 className="mt-2 text-lg font-semibold text-[var(--color-ink)]">
            {aberto ? 'Criar a conta da sua empresa' : 'Cadastro temporariamente fechado'}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-ink-2)]">
            {aberto
              ? 'Você será o administrador, e poderá convidar a sua equipe depois.'
              : 'Não estamos aceitando novos cadastros neste momento.'}
          </p>
        </div>

        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          {aberto ? (
            <FormularioDeCadastro dias={dias} />
          ) : (
            /*
              * Fechado é diferente de quebrado, e a tela precisa dizer qual dos
              * dois é. Quem tem convite continua entrando — o parâmetro fecha o
              * cadastro livre, não o produto.
              */
            <div className="flex flex-col gap-4 text-center">
              <p className="text-sm text-[var(--color-ink-2)]">
                Se você recebeu um convite de uma empresa que já usa o STI, ele continua valendo:
                abra o link do convite.
              </p>
              <Link
                href="/login"
                className="w-full rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-ink)]"
              >
                Já tenho conta
              </Link>
            </div>
          )}
        </div>

        {aberto && (
          <p className="mt-4 text-center text-sm">
            <Link href="/login" className="font-medium text-[var(--color-brand-ink)] hover:underline">
              Já tenho conta
            </Link>
          </p>
        )}
      </div>
    </main>
  )
}
