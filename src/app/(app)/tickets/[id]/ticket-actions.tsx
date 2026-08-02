'use client'

import { useState } from 'react'
import type { Profile, Queue, TicketStatus } from '@/lib/types'
import { ticketStatusLabel } from '@/lib/i18n'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { assignTicket, changeStatus, transferQueue } from '../actions'

/**
 * Painel de ações do ticket.
 *
 * A lista de status vem de `ticket_status_transitions` (ADR-007): a UI oferece
 * exatamente as transições que o banco aceita, em vez de manter uma segunda
 * cópia da máquina de estados que inevitavelmente divergiria.
 */
export function TicketActions({
  ticketId,
  currentQueueId,
  currentAssigneeId,
  allowedStatuses,
  queues,
  agents,
}: {
  ticketId: string
  currentQueueId: string
  currentAssigneeId: string | null
  allowedStatuses: TicketStatus[]
  queues: Queue[]
  agents: Profile[]
}) {
  const [showTransfer, setShowTransfer] = useState(false)

  return (
    <div className="flex flex-col gap-5">
      <ActionForm action={changeStatus}>
        <input type="hidden" name="ticket_id" value={ticketId} />
        <Field label="Alterar status" htmlFor="status">
          <div className="flex gap-2">
            <select id="status" name="status" className={inputClass} disabled={allowedStatuses.length === 0}>
              {allowedStatuses.map((s) => (
                <option key={s} value={s}>
                  {ticketStatusLabel[s]}
                </option>
              ))}
              {allowedStatuses.length === 0 && <option>Nenhuma transição disponível</option>}
            </select>
            <SubmitButton pendingLabel="…">Aplicar</SubmitButton>
          </div>
        </Field>
      </ActionForm>

      <ActionForm action={assignTicket}>
        <input type="hidden" name="ticket_id" value={ticketId} />
        <Field label="Atendente" htmlFor="assignee_id">
          <div className="flex gap-2">
            <select
              id="assignee_id"
              name="assignee_id"
              defaultValue={currentAssigneeId ?? ''}
              className={inputClass}
            >
              <option value="">Não atribuído</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.full_name}
                </option>
              ))}
            </select>
            <SubmitButton variant="secondary" pendingLabel="…">
              Salvar
            </SubmitButton>
          </div>
        </Field>
      </ActionForm>

      <div>
        <button
          type="button"
          onClick={() => setShowTransfer((v) => !v)}
          aria-expanded={showTransfer}
          className="text-sm font-semibold text-[var(--color-brand-ink)] hover:underline"
        >
          {showTransfer ? 'Cancelar transferência' : 'Transferir de fila'}
        </button>

        {showTransfer && (
          <ActionForm action={transferQueue} className="mt-3 flex flex-col gap-3">
            <input type="hidden" name="ticket_id" value={ticketId} />
            <Field label="Fila de destino" htmlFor="queue_id" required>
              <select id="queue_id" name="queue_id" defaultValue={currentQueueId} className={inputClass}>
                {queues.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.name}
                  </option>
                ))}
              </select>
            </Field>
            {/* Motivo obrigatório (RF-FIL-05): sem ele, a transferência vira uma
                caixa-preta e ninguém consegue auditar o repasse entre times. */}
            <Field label="Motivo" htmlFor="reason" required>
              <textarea
                id="reason"
                name="reason"
                rows={2}
                required
                minLength={3}
                className={inputClass}
                placeholder="ex.: demanda de infraestrutura, fora do escopo do time atual"
              />
            </Field>
            <SubmitButton pendingLabel="Transferindo…">Confirmar transferência</SubmitButton>
          </ActionForm>
        )}
      </div>
    </div>
  )
}
