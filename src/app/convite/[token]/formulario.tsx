'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import type { ActionState } from '@/lib/actions/estado'
import { ErrorNote, Field, inputClass } from '@/components/ui'
import { aceitarConvite } from './actions'

function Botao() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-ink)] disabled:opacity-60"
    >
      {pending ? 'Criando…' : 'Criar a minha conta'}
    </button>
  )
}

export function FormularioDeConvite({ token, email }: { token: string; email: string }) {
  const [state, acao] = useActionState<ActionState, FormData>(aceitarConvite, {})

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

      {/*
        * O e-mail aparece e NÃO é editável: ele veio do convite, e deixá-lo
        * livre faria o formulário aceitar um endereço diferente do que foi
        * convidado — o que transformaria qualquer convite num cadastro livre.
        */}
      <Field label="E-mail" htmlFor="email-convidado">
        <input
          id="email-convidado"
          type="email"
          value={email}
          readOnly
          disabled
          className={`${inputClass} opacity-70`}
        />
      </Field>

      <Field label="Seu nome" htmlFor="nome" required>
        <input id="nome" name="nome" type="text" autoComplete="name" required className={inputClass} />
      </Field>

      <Field label="Senha" htmlFor="senha" required hint="Pelo menos 12 caracteres.">
        <input
          id="senha"
          name="senha"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          className={inputClass}
        />
      </Field>

      {state.error && <ErrorNote>{state.error}</ErrorNote>}

      <Botao />
    </form>
  )
}
