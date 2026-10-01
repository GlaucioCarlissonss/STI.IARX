'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import type { ActionState } from '@/app/(app)/tickets/actions'
import { ErrorNote, Field, inputClass } from '@/components/ui'
import { setNewPassword } from './actions'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-brand-ink)] disabled:opacity-60"
    >
      {pending ? 'Salvando…' : 'Salvar nova senha'}
    </button>
  )
}

export function NewPasswordForm() {
  const [state, formAction] = useActionState<ActionState, FormData>(setNewPassword, {})

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Nova senha" htmlFor="password" required hint="Pelo menos 8 caracteres.">
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          className={inputClass}
        />
      </Field>

      <Field label="Repita a nova senha" htmlFor="confirm" required>
        <input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          className={inputClass}
        />
      </Field>

      {state.error && <ErrorNote>{state.error}</ErrorNote>}

      <SubmitButton />
    </form>
  )
}
