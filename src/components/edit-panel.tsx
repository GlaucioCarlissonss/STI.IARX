import type { ReactNode } from 'react'

/**
 * Revelador do formulário de edição, na própria linha do registro.
 *
 * É `<details>`/`<summary>` puro, sem estado no cliente: já vem com
 * abre/fecha por teclado, `aria-expanded` implícito e busca-na-página do
 * navegador funcionando dentro do conteúdo fechado. Um modal daria o mesmo
 * resultado visual ao custo de escrever armadilha de foco, restauração de foco
 * e `Esc` à mão — três lugares onde acessibilidade costuma quebrar em silêncio.
 *
 * Sem `'use client'` de propósito: não há interatividade em JavaScript aqui, e
 * assim os formulários de edição continuam sendo enviados ao servidor mesmo
 * antes de a hidratação terminar.
 */
export function EditPanel({
  label = 'Editar',
  title,
  children,
}: {
  /** Texto do botão que abre o painel. */
  label?: string
  /** Cabeçalho de dentro do painel — diz QUAL registro está aberto. */
  title?: string
  children: ReactNode
}) {
  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--color-ink-2)] transition-colors hover:bg-[var(--color-surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand)] [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="transition-transform group-open:rotate-90">
          ›
        </span>
        {label}
      </summary>
      <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
        {title && (
          <h3 className="mb-3 text-sm font-semibold text-[var(--color-ink)]">{title}</h3>
        )}
        {children}
      </div>
    </details>
  )
}
