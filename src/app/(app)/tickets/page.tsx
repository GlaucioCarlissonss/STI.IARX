import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { requireScreen } from '@/lib/session'
import { getPriorities, getQueues } from '@/lib/data/lookups'
import { ticketStatusLabel } from '@/lib/i18n'
import type { EnrichedTicket, TicketStatus } from '@/lib/types'
import { TicketList } from '@/components/ticket-list'
import { EmptyState, PageHeader, inputClass } from '@/components/ui'

export const metadata: Metadata = { title: 'Tickets' }

const OPEN_STATUSES: TicketStatus[] = [
  'open',
  'triage',
  'assigned',
  'in_progress',
  'waiting_requester',
  'waiting_third_party',
]

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; fila?: string; prioridade?: string; busca?: string }>
}) {
  const params = await searchParams
  await requireScreen('helpdesk.tickets.ver')

  const supabase = await createClient()
  const [queues, priorities] = await Promise.all([getQueues(), getPriorities()])

  let query = supabase
    .from('vw_tickets_enriched')
    .select('*')
    .order('queue_score', { ascending: false })
    .limit(200)

  // "abertos" é o padrão: quem abre a tela quer trabalhar, não navegar histórico.
  if (!params.status || params.status === 'abertos') {
    query = query.in('status', OPEN_STATUSES)
  } else if (params.status !== 'todos') {
    query = query.eq('status', params.status)
  }

  if (params.fila) query = query.eq('queue_slug', params.fila)
  if (params.prioridade) query = query.eq('priority_key', params.prioridade)
  if (params.busca) query = query.ilike('title', `%${params.busca}%`)

  const { data, error } = await query.returns<EnrichedTicket[]>()
  const tickets = data ?? []

  return (
    <>
      <PageHeader
        title="Tickets"
        description="Ordenados por score de priorização: criticidade, prazo de SLA e tempo de espera."
        action={
          <Link
            href="/tickets/novo"
            className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--color-brand-ink)]"
          >
            Abrir ticket
          </Link>
        }
      />

      <form
        method="get"
        className="mb-5 flex flex-wrap items-end gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <div className="flex min-w-52 flex-1 flex-col gap-1.5">
          <label htmlFor="busca" className="text-xs font-semibold text-[var(--color-ink-2)]">
            Buscar por título
          </label>
          <input
            id="busca"
            name="busca"
            type="search"
            defaultValue={params.busca ?? ''}
            className={inputClass}
            placeholder="ex.: internet, servidor…"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="status" className="text-xs font-semibold text-[var(--color-ink-2)]">
            Status
          </label>
          <select id="status" name="status" defaultValue={params.status ?? 'abertos'} className={inputClass}>
            <option value="abertos">Em aberto</option>
            <option value="todos">Todos</option>
            {Object.entries(ticketStatusLabel).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="fila" className="text-xs font-semibold text-[var(--color-ink-2)]">
            Fila
          </label>
          <select id="fila" name="fila" defaultValue={params.fila ?? ''} className={inputClass}>
            <option value="">Todas</option>
            {queues.map((q) => (
              <option key={q.id} value={q.slug}>
                {q.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="prioridade" className="text-xs font-semibold text-[var(--color-ink-2)]">
            Prioridade
          </label>
          <select
            id="prioridade"
            name="prioridade"
            defaultValue={params.prioridade ?? ''}
            className={inputClass}
          >
            <option value="">Todas</option>
            {priorities.map((p) => (
              <option key={p.id} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
        >
          Filtrar
        </button>
      </form>

      {error ? (
        <EmptyState title="Não foi possível carregar os tickets" description={error.message} />
      ) : tickets.length === 0 ? (
        <EmptyState
          title="Nenhum ticket encontrado"
          description="Ajuste os filtros ou abra um novo ticket."
        />
      ) : (
        <>
          <p className="mb-2 text-sm text-[var(--color-ink-2)]">
            {tickets.length} ticket{tickets.length === 1 ? '' : 's'}
          </p>
          <TicketList tickets={tickets} />
        </>
      )}
    </>
  )
}
