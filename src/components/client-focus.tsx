'use client'

import { useActionState, useRef } from 'react'
import { definirFocoDeCliente } from '@/app/(app)/actions'
import type { ActionState } from '@/lib/actions/estado'

export interface FocoOpcao {
  id: string
  nome: string
  cor: string
}

/**
 * Seletor da empresa em foco, no cabeçalho.
 *
 * ## Por que o `<select>` se envia sozinho
 *
 * Um botão "Aplicar" ao lado do seletor acrescenta um clique a uma ação que a
 * pessoa faz várias vezes por dia e não acrescenta informação nenhuma: escolher
 * a empresa JÁ é a confirmação. O envio no `change` elimina esse clique.
 *
 * ## E por que o botão continua existindo
 *
 * `requestSubmit()` depende de JavaScript, e um `<select>` que só funciona com
 * JS deixa de funcionar sem aviso. O botão fica escondido visualmente e aparece
 * ao receber foco (`focus:not-sr-only`), o que resolve três casos de uma vez:
 * sem JS ele é o caminho normal de envio; no teclado ele é alcançável com Tab,
 * para quem navega pelas setas sem disparar `change` a cada opção; e no leitor
 * de tela ele anuncia que há uma confirmação. Esconder com `display:none`
 * tiraria as três.
 */
export function ClientFocus({
  opcoes,
  selecionado,
}: {
  opcoes: FocoOpcao[]
  selecionado: string | null
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(definirFocoDeCliente, {})
  const form = useRef<HTMLFormElement>(null)

  const atual = opcoes.find((o) => o.id === selecionado)

  return (
    <form ref={form} action={formAction} className="hidden items-center gap-2 md:flex">
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10"
        style={{ backgroundColor: atual?.cor ?? 'var(--color-ink-3)' }}
      />
      <label htmlFor="foco-empresa" className="sr-only">
        Empresa em foco
      </label>
      <select
        id="foco-empresa"
        name="client_id"
        defaultValue={selecionado ?? ''}
        onChange={() => form.current?.requestSubmit()}
        className="max-w-44 truncate rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-[var(--color-ink)]"
      >
        <option value="">Todas as empresas</option>
        {opcoes.map((o) => (
          <option key={o.id} value={o.id}>
            {o.nome}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="sr-only rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-sm font-medium focus:not-sr-only"
      >
        Aplicar
      </button>
      {state.error && (
        <span role="alert" className="text-xs text-[var(--color-breach-ink)]">
          {state.error}
        </span>
      )}
    </form>
  )
}
