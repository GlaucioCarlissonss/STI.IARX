import type { ReactNode } from 'react'

/**
 * Revelador de uma SEÇÃO dentro de um registro já aberto.
 *
 * ## O que ele deixou de ser
 *
 * Até a Fase 5 ele era o jeito de abrir um REGISTRO: um `<details>` por linha
 * de tabela, com o formulário inteiro dentro da célula. Treze telas faziam
 * isso, e em todas o formulário herdava a largura da coluna em que nasceu — o
 * editor da regra de mapeamento chegou a ter nove campos na largura de uma
 * coluna chamada "Ações". Esse idioma acabou: registro se abre na gaveta
 * (`components/gaveta.tsx`), que tem largura própria, endereço próprio e `Esc`.
 *
 * O que sobrou — e é legítimo — são **seções dentro da gaveta**: editar um dos
 * contratos do fornecedor que já está aberto, transferir a custódia do ativo
 * que já está aberto. Essas não competem com a gaveta, fazem parte dela. Hoje
 * são dois usos, em `fornecedores/gaveta.tsx` e `clientes/gaveta.tsx`.
 *
 * Um `EditPanel` novo numa PÁGINA, em vez de dentro de uma gaveta, é o idioma
 * voltando — e a suíte `demo/tests/local/gaveta.spec.mjs` reprova isso em cada
 * uma das treze telas, conferindo que nenhum campo de formulário aparece na
 * tela por padrão.
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
