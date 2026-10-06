import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Página não encontrada',
  robots: { index: false, follow: false },
}

/**
 * O 404 da aplicação, no lugar do padrão do Next — que é em inglês, fundo
 * branco, sem nenhum caminho de volta.
 *
 * Ele cobre tanto um endereço digitado errado quanto o `notFound()` chamado por
 * `/tickets/[id]`, `/filas/[slug]` e `/integracoes/[id]` quando o registro não
 * existe **ou quando o RLS não o entrega**. Os dois casos chegam aqui iguais, e
 * essa é a decisão correta: dizer "este ticket existe, mas não é seu"
 * confirmaria a existência do registro a quem não pode vê-lo. O texto fala de
 * endereço, não de permissão, justamente por isso.
 *
 * `/tv/[token]` tem o seu próprio: uma TV de parede precisa de um 404 escuro e
 * legível a cinco metros, e não deste.
 */
export default function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center px-6 py-16">
      <div className="w-full max-w-md text-center">
        <p className="fonte-display text-2xl font-bold text-[var(--color-brand)]">STI</p>
        <h1 className="mt-6 text-xl font-bold text-[var(--color-ink)]">Este endereço não existe</h1>
        <p className="mt-2 text-sm text-[var(--color-ink-2)]">
          A página pode ter sido removida, ou o link que trouxe você até aqui está desatualizado.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/painel"
            className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
          >
            Ir para a Visão geral
          </Link>
          <Link
            href="/tickets"
            className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
          >
            Ver os tickets
          </Link>
        </div>
      </div>
    </div>
  )
}
