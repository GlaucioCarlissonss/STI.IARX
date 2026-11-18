'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import type { ActionState } from '@/lib/actions/estado'
import { ErrorNote, Field, inputClass } from '@/components/ui'
import { convidar, revogar } from './actions'

function Enviar({ rotulo, pendente }: { rotulo: string; pendente: string }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-ink)] disabled:opacity-60"
    >
      {pending ? pendente : rotulo}
    </button>
  )
}

/**
 * O formulário de convite.
 *
 * Os papéis oferecidos são TODOS os quatro, e a recusa de "acima do seu" vem do
 * banco (0061). Filtrar a lista aqui pelo papel de quem olha seria mais
 * elegante e deixaria a regra morando só na tela — e a mesma ação é alcançável
 * por quem montar a requisição à mão.
 */
export function FormularioDeConvite({ podeCriar }: { podeCriar: boolean }) {
  const [state, acao] = useActionState<ActionState, FormData>(convidar, {})

  if (!podeCriar) return null

  return (
    <form action={acao} className="flex flex-col gap-4 sm:flex-row sm:items-end">
      <div className="flex-1">
        <Field label="E-mail de quem você quer convidar" htmlFor="email" required>
          <input id="email" name="email" type="email" required className={inputClass} />
        </Field>
      </div>

      <div className="sm:w-56">
        <Field label="Papel" htmlFor="role" required>
          <select id="role" name="role" defaultValue="atendente" className={inputClass}>
            <option value="solicitante">Solicitante — abre e acompanha chamados</option>
            <option value="atendente">Atendente — atende chamados</option>
            <option value="gestor">Gestor — enxerga e decide</option>
            <option value="admin">Administrador — configura a empresa</option>
          </select>
        </Field>
      </div>

      <div className="flex flex-col gap-1 pb-0.5">
        <Enviar rotulo="Convidar" pendente="Enviando…" />
      </div>

      {state.error && (
        <div className="w-full">
          <ErrorNote>{state.error}</ErrorNote>
        </div>
      )}
      {state.success && (
        <p role="status" className="w-full text-sm text-[var(--color-ok-ink)]">
          {state.success}
        </p>
      )}
    </form>
  )
}

export function BotaoDeRevogar({ id }: { id: number }) {
  const [state, acao] = useActionState<ActionState, FormData>(revogar, {})

  return (
    <form action={acao}>
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink-2)] transition-colors hover:bg-[var(--color-surface-2)]"
      >
        Revogar
      </button>
      {state.error && <p className="mt-1 text-xs text-[var(--color-breach-ink)]">{state.error}</p>}
    </form>
  )
}
