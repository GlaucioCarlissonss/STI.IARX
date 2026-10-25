'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { ErrorNote } from '@/components/ui'
import { excluirProjeto } from '../actions'

export function ExcluirProjeto({ id }: { id: string }) {
  const [state, formAction] = useActionState(excluirProjeto, {})

  return (
    <>
      <form action={formAction}>
        <input type="hidden" name="id" value={id} />
        <SubmitButton pendingLabel="Excluindo…" variant="danger">
          Excluir projeto
        </SubmitButton>
      </form>
      {state.error && <ErrorNote>{state.error}</ErrorNote>}
      {state.success && (
        <p role="status" className="mt-2 text-sm text-[var(--color-ok-ink)]">
          {state.success}
        </p>
      )}
    </>
  )
}
