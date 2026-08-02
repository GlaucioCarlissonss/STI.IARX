'use client'

import { useActionState, type ReactNode } from 'react'
import { useFormStatus } from 'react-dom'
import type { ActionState } from '@/app/(app)/tickets/actions'
import { ErrorNote } from './ui'

/**
 * Formulário ligado a uma Server Action, com feedback de erro/sucesso.
 *
 * Centraliza o `useActionState` para que cada tela não repita o mesmo boilerplate
 * de pending/erro — e para que a mensagem de retorno tenha sempre o mesmo
 * tratamento acessível (`role="alert"` / `role="status"`).
 */
export function ActionForm({
  action,
  children,
  className = '',
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>
  children: ReactNode
  className?: string
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {})

  return (
    <form action={formAction} className={className}>
      {children}
      {state.error && (
        <div className="mt-3">
          <ErrorNote>{state.error}</ErrorNote>
        </div>
      )}
      {state.success && (
        <p
          role="status"
          className="mt-3 rounded-lg bg-[var(--color-ok-soft)] px-3.5 py-2.5 text-sm font-medium text-[var(--color-ok-ink)]"
        >
          {state.success}
        </p>
      )}
    </form>
  )
}

export function SubmitButton({
  children,
  variant = 'primary',
  pendingLabel = 'Salvando…',
}: {
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'danger'
  pendingLabel?: string
}) {
  const { pending } = useFormStatus()

  const variants = {
    primary: 'bg-[var(--color-brand)] text-white hover:bg-[var(--color-brand-ink)]',
    secondary:
      'border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]',
    danger: 'bg-[var(--color-breach-ink)] text-white hover:opacity-90',
  }

  return (
    <button
      type="submit"
      disabled={pending}
      className={`inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]}`}
    >
      {pending ? pendingLabel : children}
    </button>
  )
}
