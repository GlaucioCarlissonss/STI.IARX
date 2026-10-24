'use client'

import { useActionState, useState } from 'react'
import type { ActionState } from '@/lib/actions/estado'
import { enviarAvaliacao } from './actions'

/**
 * Cinco botões de nota, e o comentário só depois de escolher.
 *
 * ## Por que botão e não `<select>`
 *
 * A pesquisa compete com o resto do dia de quem recebe. Um clique responde; uma
 * lista suspensa são três toques no celular, e cada toque a mais derruba a taxa
 * de resposta. O comentário aparece depois da nota porque é opcional — mostrá-lo
 * antes faz a pesquisa parecer longa, e pesquisa que parece longa não é
 * respondida.
 *
 * ## Acessibilidade
 *
 * É um `radiogroup`: para o leitor de tela é UMA pergunta com cinco respostas, e
 * a seta percorre as notas em vez de exigir cinco tabulações. O número tem um
 * rótulo em texto (`1 — Péssimo`), porque "nota 1" sem escala não diz se 1 é bom.
 */
const NOTAS = [
  { valor: 1, rotulo: 'Péssimo' },
  { valor: 2, rotulo: 'Ruim' },
  { valor: 3, rotulo: 'Regular' },
  { valor: 4, rotulo: 'Bom' },
  { valor: 5, rotulo: 'Ótimo' },
]

export function FormularioDeAvaliacao({ token }: { token: string }) {
  const [state, formAction] = useActionState<ActionState, FormData>(enviarAvaliacao, {})
  const [nota, setNota] = useState<number | null>(null)

  if (state.success) {
    return (
      <p
        role="status"
        className="mt-8 rounded-xl bg-[var(--color-ok-soft)] px-4 py-3 text-sm font-medium text-[var(--color-ok-ink)]"
      >
        {state.success}
      </p>
    )
  }

  return (
    <form action={formAction} className="mt-8">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="score" value={nota ?? ''} />

      <div
        role="radiogroup"
        aria-label="Nota do atendimento, de 1 a 5"
        className="flex justify-center gap-2"
      >
        {NOTAS.map((n) => {
          const ativo = nota === n.valor
          return (
            <button
              key={n.valor}
              type="button"
              role="radio"
              aria-checked={ativo}
              onClick={() => setNota(n.valor)}
              className={`grid size-14 place-items-center rounded-xl border text-lg font-bold transition-colors ${
                ativo
                  ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-[var(--color-on-brand)]'
                  : 'border-[var(--color-border-strong)] text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]'
              }`}
            >
              <span aria-hidden="true">{n.valor}</span>
              <span className="sr-only">{`${n.valor} — ${n.rotulo}`}</span>
            </button>
          )
        })}
      </div>

      <p aria-live="polite" className="mt-2 h-5 text-sm text-[var(--color-ink-2)]">
        {nota ? NOTAS.find((n) => n.valor === nota)!.rotulo : ''}
      </p>

      {nota !== null && (
        <div className="mt-4 text-left">
          <label htmlFor="comment" className="text-sm font-medium text-[var(--color-ink)]">
            Quer contar alguma coisa? <span className="text-[var(--color-ink-3)]">(opcional)</span>
          </label>
          <textarea
            id="comment"
            name="comment"
            rows={3}
            maxLength={2000}
            className="mt-1.5 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] transition-colors focus:border-[var(--color-brand)]"
          />
          <button
            type="submit"
            className="mt-3 w-full rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-ink)]"
          >
            Enviar avaliação
          </button>
        </div>
      )}

      {state.error && (
        <p
          role="alert"
          className="mt-4 rounded-lg bg-[var(--color-breach-soft)] px-3.5 py-2.5 text-sm font-medium text-[var(--color-breach-ink)]"
        >
          {state.error}
        </p>
      )}
    </form>
  )
}
