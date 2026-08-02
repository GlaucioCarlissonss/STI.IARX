'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { inputClass } from '@/components/ui'
import { addComment } from '../actions'

export function CommentForm({
  ticketId,
  canPostInternal,
}: {
  ticketId: string
  canPostInternal: boolean
}) {
  return (
    <ActionForm action={addComment} className="flex flex-col gap-3">
      <input type="hidden" name="ticket_id" value={ticketId} />

      <label htmlFor="body" className="text-sm font-medium text-[var(--color-ink)]">
        Novo comentário
      </label>
      <textarea
        id="body"
        name="body"
        rows={4}
        required
        className={inputClass}
        placeholder="Escreva a atualização do atendimento…"
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        {canPostInternal ? (
          <fieldset className="flex items-center gap-4">
            <legend className="sr-only">Visibilidade do comentário</legend>
            <label className="flex items-center gap-1.5 text-sm text-[var(--color-ink-2)]">
              <input type="radio" name="visibility" value="public" defaultChecked />
              Público (visível ao solicitante)
            </label>
            <label className="flex items-center gap-1.5 text-sm text-[var(--color-ink-2)]">
              <input type="radio" name="visibility" value="internal" />
              Interno (somente equipe)
            </label>
          </fieldset>
        ) : (
          <input type="hidden" name="visibility" value="public" />
        )}

        <SubmitButton pendingLabel="Publicando…">Publicar</SubmitButton>
      </div>
    </ActionForm>
  )
}
