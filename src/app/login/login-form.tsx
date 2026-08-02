'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { signIn, type AuthFormState } from './actions'
import { Field, ErrorNote, inputClass } from '@/components/ui'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-brand-ink)] disabled:opacity-60"
    >
      {pending ? 'Entrando…' : 'Entrar'}
    </button>
  )
}

export function LoginForm({ proxima }: { proxima?: string }) {
  const [state, formAction] = useActionState<AuthFormState, FormData>(signIn, {})

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {proxima && <input type="hidden" name="proxima" value={proxima} />}

      <Field label="E-mail" htmlFor="email" required>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className={inputClass}
          placeholder="voce@empresa.com.br"
        />
      </Field>

      <Field label="Senha" htmlFor="password" required>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
        />
      </Field>

      {state.error && <ErrorNote>{state.error}</ErrorNote>}

      <SubmitButton />
    </form>
  )
}
