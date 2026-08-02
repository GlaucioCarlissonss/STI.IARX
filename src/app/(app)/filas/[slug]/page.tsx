import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { requireSession } from '@/lib/session'
import type { EnrichedTicket } from '@/lib/types'
import { EmptyState, PageHeader } from '@/components/ui'
import { TicketList } from '@/components/ticket-list'
import { RealtimeRefresh } from '@/components/realtime-refresh'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  return { title: `Fila ${slug}` }
}

export default async function FilaPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  await requireSession()
  const supabase = await createClient()

  const { data: queue } = await supabase
    .from('queues')
    .select('id, name, slug, description, weight_criticality, weight_deadline, weight_age')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle()

  if (!queue) notFound()

  const { data: tickets } = await supabase
    .from('vw_tickets_enriched')
    .select('*')
    .eq('queue_id', queue.id)
    .not('status', 'in', '("resolved","closed")')
    .order('queue_score', { ascending: false })
    .returns<EnrichedTicket[]>()

  return (
    <>
      <RealtimeRefresh />

      <PageHeader
        title={queue.name}
        description={
          queue.description ??
          'Ordenação automática por score de priorização.'
        }
      />

      <p className="mb-4 text-xs text-[var(--color-ink-3)]">
        Pesos desta fila — criticidade {queue.weight_criticality}, prazo {queue.weight_deadline}
        , espera {queue.weight_age}. Empates são desfeitos por ordem de chegada.
      </p>

      {tickets && tickets.length > 0 ? (
        <TicketList tickets={tickets} />
      ) : (
        <EmptyState title="Fila vazia" description="Nenhum ticket em aberto nesta fila." />
      )}
    </>
  )
}
