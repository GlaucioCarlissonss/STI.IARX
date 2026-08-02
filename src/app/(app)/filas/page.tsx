import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireSession } from '@/lib/session'
import type { EnrichedTicket } from '@/lib/types'
import { Badge, Card, PageHeader } from '@/components/ui'

export const metadata: Metadata = { title: 'Filas' }

export default async function FilasPage() {
  await requireSession()
  const supabase = await createClient()

  const [{ data: queues }, { data: openTickets }] = await Promise.all([
    supabase
      .from('queues')
      .select('id, name, slug, description, is_system_default')
      .is('deleted_at', null)
      .eq('is_active', true)
      .order('is_system_default', { ascending: false })
      .order('name'),
    // Uma consulta só, agregada em memória: são poucas filas, e assim evitamos
    // N+1 (uma contagem por fila) que o dashboard pagaria a cada refresh.
    supabase
      .from('vw_tickets_enriched')
      .select('queue_slug, resolution_state, priority_weight')
      .not('status', 'in', '("resolved","closed")')
      .returns<Pick<EnrichedTicket, 'queue_slug' | 'resolution_state' | 'priority_weight'>[]>(),
  ])

  const tickets = openTickets ?? []

  return (
    <>
      <PageHeader
        title="Filas"
        description="Cada fila ordena por score: criticidade, urgência de prazo e tempo de espera."
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(queues ?? []).map((q) => {
          const inQueue = tickets.filter((t) => t.queue_slug === q.slug)
          const breached = inQueue.filter((t) => t.resolution_state === 'breached').length
          const atRisk = inQueue.filter((t) =>
            ['warning', 'critical'].includes(t.resolution_state ?? ''),
          ).length
          const critical = inQueue.filter((t) => t.priority_weight >= 80).length

          return (
            <Card key={q.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/filas/${q.slug}` as Route}
                    className="text-base font-semibold text-[var(--color-brand-ink)] hover:underline"
                  >
                    {q.name}
                  </Link>
                  {q.description && (
                    <p className="mt-0.5 text-xs text-[var(--color-ink-3)]">{q.description}</p>
                  )}
                </div>
                {q.is_system_default && <Badge tone="info">Padrão</Badge>}
              </div>

              <p className="mt-4 text-3xl font-bold tabular-nums text-[var(--color-ink)]">
                {inQueue.length}
                <span className="ml-1.5 text-sm font-medium text-[var(--color-ink-3)]">
                  em aberto
                </span>
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                {breached > 0 && <Badge tone="breach">{breached} estourado(s)</Badge>}
                {atRisk > 0 && <Badge tone="warn">{atRisk} em risco</Badge>}
                {critical > 0 && <Badge tone="crit">{critical} crítico(s)</Badge>}
                {breached === 0 && atRisk === 0 && <Badge tone="ok">Prazos sob controle</Badge>}
              </div>
            </Card>
          )
        })}
      </div>
    </>
  )
}
