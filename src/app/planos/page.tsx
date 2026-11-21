import type { Metadata } from 'next'
import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import { modoLocal } from '@/lib/db/modo'

export const metadata: Metadata = {
  title: 'Planos',
  description: 'Quanto custa o STI, e o que entra em cada plano.',
}
export const dynamic = 'force-dynamic'

interface Plano {
  codigo: string
  nome: string
  resumo: string
  preco_mensal: number | null
  limite_usuarios: number | null
  limite_chamados_mes: number | null
  esferas: string[]
  destaques: string[]
}

const brl = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

/**
 * Os planos, para quem ainda NÃO tem conta.
 *
 * ## Por que ela lê por função, e não pela tabela
 *
 * Quem abre esta página não tem sessão — é dela que sai a decisão de criar uma.
 * `public.planos_publicos()` é `security definer` com filtro fixo: devolve só o
 * que é público e ativo, e só as colunas que esta página mostra. Dar `select`
 * direto ao papel anônimo abriria a tabela inteira, incluindo plano que ainda
 * não foi anunciado.
 *
 * ## O que esta página NÃO faz, e por que isso está escrito nela
 *
 * Não cobra. Este sistema não emite boleto, não integra adquirente e não guarda
 * cartão. O preço existe para dizer quanto custa; quem cobra é quem vende, por
 * fora.
 *
 * Um botão "Assinar" que levasse a um formulário de cartão prometeria o que não
 * existe, e o primeiro cliente descobriria no primeiro vencimento. O botão leva
 * para a avaliação, que é o que de fato acontece em seguida.
 */
export default async function PlanosPage() {
  let planos: Plano[] = []

  if (modoLocal()) {
    const admin = createAdminClient()
    const { data } = await admin.rpc('planos_publicos')
    planos = Array.isArray(data) ? (data as Plano[]) : []
  }

  return (
    <main className="min-h-screen bg-[var(--color-surface-2)] px-4 py-12">
      <div className="mx-auto max-w-5xl">
        <div className="mb-10 text-center">
          <Link
            href="/login"
            className="fonte-display text-2xl font-bold tracking-tight text-[var(--color-brand)]"
          >
            STI
          </Link>
          <h1 className="mt-3 text-2xl font-bold text-[var(--color-ink)]">
            Quanto custa, e o que entra
          </h1>
          <p className="mx-auto mt-2 max-w-2xl text-sm text-[var(--color-ink-2)]">
            Todo plano começa com <strong>90 dias de avaliação</strong>, com o sistema inteiro
            liberado — sem recurso bloqueado e sem cartão.
          </p>
        </div>

        {planos.length === 0 ? (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
            <p className="text-sm text-[var(--color-ink-2)]">
              Os planos ainda não foram publicados nesta instalação. Fale com quem a administra.
            </p>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-3">
            {planos.map((p) => (
              <div
                key={p.codigo}
                className="flex flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
              >
                <h2 className="text-lg font-semibold text-[var(--color-ink)]">{p.nome}</h2>
                <p className="mt-1 text-sm text-[var(--color-ink-2)]">{p.resumo}</p>

                <p className="mt-4">
                  {p.preco_mensal === null ? (
                    <span className="text-xl font-bold text-[var(--color-ink)]">
                      Sob consulta
                    </span>
                  ) : (
                    <>
                      <span className="text-2xl font-bold text-[var(--color-ink)]">
                        {brl(p.preco_mensal)}
                      </span>
                      <span className="text-sm text-[var(--color-ink-3)]"> /mês</span>
                    </>
                  )}
                </p>

                <ul className="mt-5 flex flex-1 flex-col gap-2">
                  {p.destaques.map((d) => (
                    <li key={d} className="flex gap-2 text-sm text-[var(--color-ink-2)]">
                      {/* Símbolo junto da cor: a marca verde sozinha não chega a
                          quem não a distingue, e aqui ela é o único canal que
                          diferencia item incluído de texto comum. */}
                      <span aria-hidden="true" className="text-[var(--color-ok-ink)]">
                        ✓
                      </span>
                      {d}
                    </li>
                  ))}
                </ul>

                <p className="mt-5 border-t border-[var(--color-border)] pt-4 text-xs text-[var(--color-ink-3)]">
                  {p.limite_usuarios === null
                    ? 'Usuários sem limite'
                    : `Até ${p.limite_usuarios} usuários`}
                  {' · '}
                  {p.limite_chamados_mes === null
                    ? 'chamados sem limite'
                    : `${p.limite_chamados_mes} chamados/mês`}
                  {p.esferas.includes('rental') ? ' · inclui locação' : ''}
                </p>

                <Link
                  href="/criar-conta"
                  className="mt-5 rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-center text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-ink)]"
                >
                  Começar a avaliação
                </Link>
              </div>
            ))}
          </div>
        )}

        <div className="mx-auto mt-10 max-w-2xl rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-ink-2)]">
          <h2 className="font-semibold text-[var(--color-ink)]">
            O que acontece quando a avaliação acaba
          </h2>
          <p className="mt-2">
            A equipe <strong>continua entrando, consultando e exportando</strong> tudo — nada é
            apagado e nada fica escondido. O que para é o cadastro de coisas novas: abrir
            chamado, lançar título, registrar medição.
          </p>
          <p className="mt-3">
            O pagamento é combinado direto com quem vende. Este sistema não emite boleto nem
            guarda cartão — e dizer o contrário aqui seria prometer o que ele não faz.
          </p>
        </div>

        <p className="mt-8 text-center text-sm">
          <Link href="/login" className="font-medium text-[var(--color-brand-ink)] hover:underline">
            Já tem conta? Entrar
          </Link>
        </p>
      </div>
    </main>
  )
}
