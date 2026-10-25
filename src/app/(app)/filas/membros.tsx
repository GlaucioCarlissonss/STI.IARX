'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { Badge, Card, ErrorNote, inputClass } from '@/components/ui'
import { adicionarMembro, alternarLideranca, removerMembro } from './membros-actions'

export interface Membro {
  queue_id: string
  user_id: string
  is_lead: boolean
  pessoa: { full_name: string; role: string } | null
}

/**
 * A equipe da fila.
 *
 * ## O aviso que a tela precisa dar
 *
 * Esta lista **não restringe acesso**. O RLS de `tickets` não lê
 * `queue_members`, e ninguém deixa de ver um chamado por não estar aqui. Uma
 * tela que sugerisse o contrário seria pior que a ausência dela: a pessoa
 * configuraria a fila achando que fechou o acesso, e não fechou nada.
 *
 * O que a lista faz é responder "quem cuida disso" — para atribuir, para medir
 * carga e para saber a quem recorrer quando o responsável sai de férias.
 */
export function MembrosDaFila({
  queueId,
  membros,
  candidatos,
  podeEditar,
}: {
  queueId: string
  membros: Membro[]
  candidatos: { id: string; full_name: string }[]
  podeEditar: boolean
}) {
  const [adicao, adicionarAction] = useActionState(adicionarMembro, {})
  const [remocao, removerAction] = useActionState(removerMembro, {})
  const [lideranca, liderancaAction] = useActionState(alternarLideranca, {})

  const naFila = new Set(membros.map((m) => m.user_id))
  const disponiveis = candidatos.filter((c) => !naFila.has(c.id))

  return (
    <Card title={`Equipe da fila (${membros.length})`}>
      {membros.length === 0 ? (
        <p className="text-sm text-[var(--color-ink-2)]">
          Ninguém atribuído a esta fila ainda. Os chamados continuam visíveis para toda a equipe de
          atendimento — esta lista diz quem cuida, não quem pode ver.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {membros.map((m) => (
            <li key={m.user_id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-[var(--color-ink)]">{m.pessoa?.full_name ?? 'sem nome'}</span>
              {m.is_lead && <Badge tone="info">responsável</Badge>}
              {podeEditar && (
                <>
                  <form action={liderancaAction} className="inline">
                    <input type="hidden" name="queue_id" value={queueId} />
                    <input type="hidden" name="user_id" value={m.user_id} />
                    {/* Checkbox marcada por padrão quando se quer PROMOVER, e
                        ausente quando se quer rebaixar: o formulário só manda o
                        campo se ele estiver marcado. */}
                    {!m.is_lead && <input type="hidden" name="is_lead" value="on" />}
                    <button
                      type="submit"
                      className="text-xs text-[var(--color-brand-ink)] hover:underline"
                    >
                      {m.is_lead ? 'deixar de ser responsável' : 'tornar responsável'}
                    </button>
                  </form>
                  <form action={removerAction} className="inline">
                    <input type="hidden" name="queue_id" value={queueId} />
                    <input type="hidden" name="user_id" value={m.user_id} />
                    <button
                      type="submit"
                      aria-label={`Remover ${m.pessoa?.full_name ?? 'a pessoa'} da fila`}
                      className="text-[var(--color-ink-3)] hover:text-[var(--color-breach-ink)]"
                    >
                      ×
                    </button>
                  </form>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {podeEditar && disponiveis.length > 0 && (
        <form action={adicionarAction} className="mt-4 flex flex-wrap items-end gap-2">
          <input type="hidden" name="queue_id" value={queueId} />
          <label className="sr-only" htmlFor={`membro-${queueId}`}>
            Quem acrescentar
          </label>
          <select
            id={`membro-${queueId}`}
            name="user_id"
            defaultValue=""
            required
            className={inputClass}
          >
            <option value="" disabled>
              Acrescentar alguém…
            </option>
            {disponiveis.map((c) => (
              <option key={c.id} value={c.id}>
                {c.full_name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 pb-2 text-sm text-[var(--color-ink)]">
            <input type="checkbox" name="is_lead" />
            responsável
          </label>
          <SubmitButton pendingLabel="…" variant="secondary">
            Acrescentar
          </SubmitButton>
        </form>
      )}

      {adicao.error && <ErrorNote>{adicao.error}</ErrorNote>}
      {remocao.error && <ErrorNote>{remocao.error}</ErrorNote>}
      {lideranca.error && <ErrorNote>{lideranca.error}</ErrorNote>}
      {(adicao.success || remocao.success || lideranca.success) && (
        <p role="status" className="mt-2 text-sm text-[var(--color-ok-ink)]">
          {adicao.success || remocao.success || lideranca.success}
        </p>
      )}

      <p className="mt-3 text-xs text-[var(--color-ink-3)]">
        <strong>Esta lista não restringe acesso.</strong> Quem tem permissão de ver chamados vê os
        desta fila, membro ou não — a lista diz quem cuida, para atribuir e para medir carga.
      </p>
    </Card>
  )
}
