import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { escopoDeCliente, porClienteOuGeral } from '@/lib/data/escopo'
import { requireScreen, allowed } from '@/lib/session'
import { getAgents } from '@/lib/data/lookups'
import { MembrosDaFila, type Membro } from '../membros'
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
  await requireScreen('helpdesk.filas.ver')
  const podeEditar = await allowed('helpdesk.filas.editar')
  const supabase = await createClient()

  const { data: queue } = await supabase
    .from('queues')
    .select('id, name, slug, description, weight_criticality, weight_deadline, weight_age')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle()

  if (!queue) notFound()

  /* `queue_members` estava no banco desde a 0004, com RLS e auditoria, e era a
     última lacuna de interface que o roadmap (docs/06, M1) ainda marcava como
     pendente: nenhuma tela jamais escreveu nela. */
  const [{ data: membros }, atendentes] = await Promise.all([
    supabase
      .from('queue_members')
      .select('queue_id, user_id, is_lead, pessoa:profiles(full_name, role)')
      .eq('queue_id', queue.id)
      .order('is_lead', { ascending: false })
      .returns<Membro[]>(),
    podeEditar ? getAgents() : Promise.resolve([]),
  ])

  const { data: tickets } = await porClienteOuGeral(
    supabase
      .from('vw_tickets_enriched')
      .select('*')
      .eq('queue_id', queue.id)
      .not('status', 'in', '("resolved","closed")')
      .order('queue_score', { ascending: false }),
    await escopoDeCliente(),
  ).returns<EnrichedTicket[]>()

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

      {/* A equipe vem DEPOIS da fila de chamados, e não antes: quem abre esta
          tela no dia a dia veio trabalhar a fila, não administrá-la. */}
      <div className="mt-6">
        <MembrosDaFila
          queueId={queue.id}
          membros={membros ?? []}
          candidatos={atendentes.map((a) => ({ id: a.id, full_name: a.full_name }))}
          podeEditar={podeEditar}
        />
      </div>
    </>
  )
}
