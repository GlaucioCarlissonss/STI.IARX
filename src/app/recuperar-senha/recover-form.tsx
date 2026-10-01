'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { ErrorNote, Field, inputClass } from '@/components/ui'
import { requestPasswordReset } from './actions'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-brand-ink)] disabled:opacity-60"
    >
      {pending ? 'Enviando…' : 'Enviar link de redefinição'}
    </button>
  )
}

export function RecoverForm() {
  const [state, formAction] = useActionState(requestPasswordReset, {})

  /*
   * A confirmação NÃO diz se o e-mail existe — nem aqui nem na mensagem. É o
   * mesmo motivo pelo qual o login não distingue "e-mail inexistente" de "senha
   * errada": confirmar a existência da conta entrega uma lista de quem usa o
   * sistema a quem só precisa de um formulário público.
   */
  if (state.sent) {
    return (
      <div className="flex flex-col gap-3">
        <p
          role="status"
          className="rounded-lg bg-[var(--color-ok-soft)] px-3.5 py-2.5 text-sm font-medium text-[var(--color-ok-ink)]"
        >
          Se existir uma conta com esse e-mail, o link de redefinição já está a caminho.
        </p>
        <p className="text-sm text-[var(--color-ink-2)]">
          O link vale por tempo limitado e serve uma vez só. Não chegou? Confira a caixa de
          spam e tente de novo em alguns minutos.
        </p>
      </div>
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
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

      {state.error && <ErrorNote>{state.error}</ErrorNote>}

      <SubmitButton />
    </form>
  )
}
