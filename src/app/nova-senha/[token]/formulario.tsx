'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import type { ActionState } from '@/lib/actions/estado'
import { ErrorNote, Field, inputClass } from '@/components/ui'
import { definirSenhaComToken } from './actions'

function Botao() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-ink)] disabled:opacity-60"
    >
      {pending ? 'Salvando…' : 'Salvar nova senha'}
    </button>
  )
}

/**
 * O formulário da senha nova com token na URL.
 *
 * O token viaja num `<input type="hidden">` e não num campo visível: ele já veio
 * no endereço, mostrá-lo de novo só convidaria alguém a copiá-lo para outro
 * lugar — e ele é, por um momento, equivalente à senha.
 */
export function FormularioDeSenhaComToken({ token }: { token: string }) {
  const [state, acao] = useActionState<ActionState, FormData>(definirSenhaComToken, {})

  /*
   * Depois de trocar, o formulário SAI de cena e dá lugar ao caminho de entrada.
   * Deixá-lo na tela com a mensagem de sucesso em cima convidaria a trocar de
   * novo — e o token já morreu, então a segunda tentativa falharia com uma
   * mensagem que contradiz a de cima.
   */
  if (state.success) {
    return (
      <div className="flex flex-col gap-4 text-center">
        <p className="text-sm text-[var(--color-ok-ink)]" role="status">
          {state.success}
        </p>
        <Link
          href="/login"
          className="w-full rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-ink)]"
        >
          Ir para a entrada
        </Link>
      </div>
    )
  }

  return (
    <form action={acao} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />

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

      <Botao />
    </form>
  )
}
