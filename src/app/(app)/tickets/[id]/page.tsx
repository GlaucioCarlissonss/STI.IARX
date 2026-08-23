import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, canWorkTickets } from '@/lib/session'
import { getAgents, getQueues } from '@/lib/data/lookups'
import { formatDateTime, formatMinutes, formatRelative, formatTimeRemaining } from '@/lib/format'
import { changeSourceLabel, ticketFieldLabel, ticketStatusLabel } from '@/lib/i18n'
import type { EnrichedTicket, TicketComment, TicketHistoryEntry } from '@/lib/types'
import { Badge, Card, PriorityBadge, SlaBadge, StatusBadge } from '@/components/ui'
import { TicketActions } from './ticket-actions'
import { CommentForm } from './comment-form'
import { Attachments, type AttachmentRecord } from '@/components/attachments'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const supabase = await createClient()
  const { data } = await supabase
    .from('vw_tickets_enriched')
    .select('ticket_number, title')
    .eq('id', id)
    .maybeSingle()

  return { title: data ? `#${data.ticket_number} · ${data.title}` : 'Ticket' }
}

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { profile } = await requireScreen('helpdesk.tickets.ver')
  const supabase = await createClient()

  const { data: ticket } = await supabase
    .from('vw_tickets_enriched')
    .select('*')
    .eq('id', id)
    .maybeSingle<EnrichedTicket>()

  // RLS já filtrou o que o usuário não pode ver: "não encontrado" aqui significa
  // tanto inexistente quanto fora do escopo — e não vazamos qual dos dois.
  if (!ticket) notFound()

  const isAgent = canWorkTickets(profile.role)

  const [
    { data: comments },
    { data: attachments },
    { data: history },
    { data: transitions },
    queues,
    agents,
  ] =
    await Promise.all([
      supabase
        .from('ticket_comments')
        .select('id, ticket_id, author_id, body, visibility, created_at, author:profiles(full_name, role)')
        .eq('ticket_id', id)
        .is('deleted_at', null)
        .order('created_at', { ascending: true })
        .returns<TicketComment[]>(),
      supabase
        .from('ticket_attachments')
        .select('id, storage_path, file_name, mime_type, size_bytes, created_at, kind')
        .eq('ticket_id', id)
        .order('created_at', { ascending: false })
        .returns<AttachmentRecord[]>(),
      supabase
        .from('ticket_history')
        .select('id, field, old_value, new_value, change_source, created_at, actor_id')
        .eq('ticket_id', id)
        .order('created_at', { ascending: false })
        .limit(60)
        .returns<TicketHistoryEntry[]>(),
      supabase
        .from('ticket_status_transitions')
        .select('to_status')
        .eq('from_status', ticket.status),
      getQueues(),
      getAgents(),
    ])

  const allowedStatuses = (transitions ?? []).map((t) => t.to_status as EnrichedTicket['status'])

  return (
    <>
      <div className="mb-6">
        <p className="font-mono text-sm text-[var(--color-ink-3)]">#{ticket.ticket_number}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-[var(--color-ink)]">
          {ticket.title}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <StatusBadge status={ticket.status} />
          <PriorityBadge label={ticket.priority_label} color={ticket.priority_color} />
          <SlaBadge state={ticket.resolution_state} />
          {ticket.is_paused && <Badge tone="warn">Relógio de SLA pausado</Badge>}
          {ticket.sla_coverage === 'uncovered' && (
            <Badge tone="neutral">Sem SLA configurado para esta combinação</Badge>
          )}
          {ticket.source_system && (
            <Badge tone="info">
              Origem: {ticket.source_system}
              {ticket.external_id ? ` #${ticket.external_id}` : ''}
            </Badge>
          )}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card title="Descrição">
            {ticket.description ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-ink)]">
                {ticket.description}
              </p>
            ) : (
              <p className="text-sm italic text-[var(--color-ink-3)]">Sem descrição.</p>
            )}
          </Card>

          <Card title={`Comentários (${comments?.length ?? 0})`}>
            <ul className="flex flex-col gap-4">
              {(comments ?? []).map((c) => (
                <li
                  key={c.id}
                  className={`rounded-lg border p-4 ${
                    c.visibility === 'internal'
                      ? 'border-[var(--color-warn-ink)]/25 bg-[var(--color-warn-soft)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
                  }`}
                >
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-[var(--color-ink)]">
                      {c.author?.full_name ?? 'Sistema'}
                    </span>
                    {c.visibility === 'internal' && <Badge tone="warn">Interno</Badge>}
                    <span className="text-xs text-[var(--color-ink-3)]">
                      {formatDateTime(c.created_at)}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-[var(--color-ink)]">{c.body}</p>
                </li>
              ))}
              {(comments ?? []).length === 0 && (
                <li className="text-sm italic text-[var(--color-ink-3)]">
                  Nenhum comentário ainda.
                </li>
              )}
            </ul>

            <div className="mt-5 border-t border-[var(--color-border)] pt-5">
              <CommentForm ticketId={ticket.id} canPostInternal={isAgent} />
            </div>
          </Card>

          {/* Até esta rodada `ticket_attachments` existia sem nenhum caminho de
              upload: anexar arquivo a um ticket era impossível. */}
          <Attachments
            entity="tickets"
            entityId={ticket.id}
            records={attachments ?? []}
            title="Anexos do ticket"
          />

          <Card title="Histórico">
            <ol className="flex flex-col gap-2.5">
              {(history ?? []).map((h) => (
                <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                  <span className="text-xs tabular-nums text-[var(--color-ink-3)]">
                    {formatDateTime(h.created_at)}
                  </span>
                  <span className="font-medium text-[var(--color-ink)]">
                    {ticketFieldLabel[h.field] ?? h.field}
                  </span>
                  <span className="text-[var(--color-ink-2)]">
                    {h.field === 'status'
                      ? `${ticketStatusLabel[h.old_value as EnrichedTicket['status']] ?? h.old_value ?? '—'} → ${
                          ticketStatusLabel[h.new_value as EnrichedTicket['status']] ?? h.new_value
                        }`
                      : h.field === 'queue_transfer_reason'
                        ? `motivo: ${h.new_value}`
                        : `${h.old_value ?? '—'} → ${h.new_value ?? '—'}`}
                  </span>
                  <Badge tone="neutral">{changeSourceLabel[h.change_source] ?? h.change_source}</Badge>
                </li>
              ))}
              {(history ?? []).length === 0 && (
                <li className="text-sm italic text-[var(--color-ink-3)]">Sem alterações registradas.</li>
              )}
            </ol>
          </Card>
        </div>

        <aside className="flex flex-col gap-6">
          <Card title="SLA">
            <dl className="flex flex-col gap-3 text-sm">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                  Primeira resposta
                </dt>
                <dd className="mt-0.5 flex items-center gap-2">
                  <SlaBadge state={ticket.response_state} />
                  <span className="text-[var(--color-ink-2)]">
                    {ticket.responded_at
                      ? formatDateTime(ticket.responded_at)
                      : `vence ${formatDateTime(ticket.response_due_at)}`}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                  Resolução
                </dt>
                <dd className="mt-0.5 flex items-center gap-2">
                  <SlaBadge state={ticket.resolution_state} />
                  <span className="text-[var(--color-ink-2)]">
                    {ticket.resolved_at
                      ? formatDateTime(ticket.resolved_at)
                      : `vence ${formatDateTime(ticket.resolution_due_at)}`}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                  Tempo restante
                </dt>
                <dd
                  className={`mt-0.5 text-lg font-bold tabular-nums ${
                    (ticket.minutes_to_resolution_due ?? 0) < 0
                      ? 'text-[var(--color-breach-ink)]'
                      : 'text-[var(--color-ink)]'
                  }`}
                >
                  {ticket.is_paused
                    ? 'Pausado'
                    : formatTimeRemaining(ticket.minutes_to_resolution_due)}
                </dd>
              </div>
              {(ticket.paused_minutes ?? 0) > 0 && (
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                    Tempo pausado
                  </dt>
                  <dd className="mt-0.5 text-[var(--color-ink-2)]">
                    {formatMinutes(ticket.paused_minutes)} de expediente
                  </dd>
                </div>
              )}
            </dl>
          </Card>

          {isAgent && (
            <Card title="Ações">
              <TicketActions
                ticketId={ticket.id}
                currentQueueId={ticket.queue_id}
                currentAssigneeId={ticket.assignee_id}
                allowedStatuses={allowedStatuses}
                queues={queues}
                agents={agents}
              />
            </Card>
          )}

          <Card title="Detalhes">
            <dl className="flex flex-col gap-2.5 text-sm">
              <Detail label="Fila" value={ticket.queue_name} />
              <Detail
                label="Categoria"
                value={
                  ticket.category_name
                    ? `${ticket.category_parent_name ? `${ticket.category_parent_name} › ` : ''}${ticket.category_name}`
                    : '—'
                }
              />
              <Detail label="Cliente" value={ticket.client_name ?? '—'} />
              <Detail label="Filial" value={ticket.branch_name ?? '—'} />
              <Detail label="Solicitante" value={ticket.requester_name ?? '—'} />
              <Detail label="Atendente" value={ticket.assignee_name ?? 'Não atribuído'} />
              <Detail label="Fornecedor" value={ticket.supplier_name ?? '—'} />
              <Detail
                label="Aberto em"
                value={`${formatDateTime(ticket.created_at)} (${formatRelative(ticket.created_at)})`}
              />
              {ticket.reopened_count > 0 && (
                <Detail label="Reaberturas" value={String(ticket.reopened_count)} />
              )}
              {ticket.tags.length > 0 && (
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                    Tags
                  </dt>
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {ticket.tags.map((tag) => (
                      <Badge key={tag} tone="neutral">
                        {tag}
                      </Badge>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
          </Card>
        </aside>
      </div>
    </>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[var(--color-ink-3)]">{label}</dt>
      <dd className="text-right font-medium text-[var(--color-ink)]">{value}</dd>
    </div>
  )
}
