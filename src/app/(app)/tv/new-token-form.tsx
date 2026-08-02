'use client'

import { useActionState, useState } from 'react'
import type { Branch } from '@/lib/types'
import { SubmitButton } from '@/components/action-form'
import { ErrorNote, Field, inputClass } from '@/components/ui'
import { createDashboardToken, type TokenActionState } from './actions'

export function NewTokenForm({
  layouts,
  branches,
}: {
  layouts: { id: string; name: string }[]
  branches: Branch[]
}) {
  const [state, formAction] = useActionState<TokenActionState, FormData>(createDashboardToken, {})
  const [copied, setCopied] = useState(false)

  const url =
    state.plainToken && typeof window !== 'undefined'
      ? `${window.location.origin}/tv/${state.plainToken}`
      : null

  return (
    <>
      <form action={formAction} className="flex flex-col gap-4">
        <Field label="Nome do painel" htmlFor="name" required>
          <input
            id="name"
            name="name"
            required
            minLength={3}
            className={inputClass}
            placeholder="TV Recepção Matriz"
          />
        </Field>

        <Field label="Layout" htmlFor="layout_id">
          <select id="layout_id" name="layout_id" defaultValue="" className={inputClass}>
            <option value="">Padrão do tenant</option>
            {layouts.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-[var(--color-ink)]">
            Filiais exibidas
          </legend>
          <p className="text-xs text-[var(--color-ink-3)]">
            Nenhuma marcada = todas as filiais do tenant.
          </p>
          <div className="max-h-40 overflow-y-auto rounded-lg border border-[var(--color-border)] p-2">
            {branches.map((b) => (
              <label key={b.id} className="flex items-center gap-2 py-1 text-sm text-[var(--color-ink-2)]">
                <input type="checkbox" name="branch_ids" value={b.id} />
                {b.name}
              </label>
            ))}
          </div>
        </fieldset>

        {state.error && <ErrorNote>{state.error}</ErrorNote>}

        <SubmitButton pendingLabel="Emitindo…">Emitir token</SubmitButton>
      </form>

      {/* O segredo aparece uma única vez (ADR-006): o banco só guarda o hash. */}
      {state.plainToken && (
        <div
          role="status"
          className="mt-4 rounded-lg border border-[var(--color-ok-ink)]/30 bg-[var(--color-ok-soft)] p-3.5"
        >
          <p className="text-sm font-semibold text-[var(--color-ok-ink)]">
            Token emitido — copie agora
          </p>
          <p className="mt-1 text-xs text-[var(--color-ok-ink)]">
            Este endereço não será exibido novamente. Guarde-o ou abra direto na TV.
          </p>
          <code className="mt-2 block overflow-x-auto whitespace-nowrap rounded bg-[var(--color-surface)] p-2 font-mono text-xs">
            {url ?? state.plainToken}
          </code>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(url ?? state.plainToken!)
              setCopied(true)
            }}
            className="mt-2 rounded-lg border border-[var(--color-ok-ink)]/40 px-3 py-1.5 text-xs font-semibold text-[var(--color-ok-ink)]"
          >
            {copied ? 'Copiado!' : 'Copiar endereço'}
          </button>
        </div>
      )}
    </>
  )
}
