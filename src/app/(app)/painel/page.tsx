import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { requireSession, canManageRecords } from '@/lib/session'
import { formatMinutes } from '@/lib/format'
import type { DashboardMetrics, EnrichedTicket } from '@/lib/types'
import { Card, EmptyState, PageHeader, StatTile } from '@/components/ui'
import { TicketList } from '@/components/ticket-list'
import { RealtimeRefresh } from '@/components/realtime-refresh'

export const metadata: Metadata = { title: 'Painel' }

export default async function PainelPage() {
  const { profile } = await requireSession()
  const supabase = await createClient()

  const [{ data: metrics }, { data: online }, { data: atRisk }, { data: mine }] = await Promise.all([
    supabase.from('vw_dashboard_metrics').select('*').maybeSingle<DashboardMetrics>(),
    supabase.from('vw_agents_online').select('agents_online, agents_total').maybeSingle(),
    // Os que mais importam: já estourados ou perto de estourar, no topo.
    supabase
      .from('vw_tickets_enriched')
      .select('*')
      .in('resolution_state', ['breached', 'critical', 'warning'])
      .not('status', 'in', '("resolved","closed")')
      .order('minutes_to_resolution_due', { ascending: true })
      .limit(10)
      .returns<EnrichedTicket[]>(),
    supabase
      .from('vw_tickets_enriched')
      .select('*')
      .eq('assignee_id', profile.id)
      .not('status', 'in', '("resolved","closed")')
      .order('queue_score', { ascending: false })
      .limit(10)
      .returns<EnrichedTicket[]>(),
  ])

  const m = metrics

  return (
    <>
      {/* Atualiza os contadores quando qualquer ticket muda (RNF-08). */}
      <RealtimeRefresh />

      <PageHeader
        title={`Olá, ${profile.full_name.split(' ')[0]}`}
        description="Visão geral da operação de atendimento."
        // A página /tv exige o mesmo canManageRecords (super_admin/admin/gestor).
        // Mostrar o botão para os demais papéis levava a um redirect silencioso
        // de volta para /painel, sem explicação — o "cliquei e não aconteceu
        // nada" mais fácil de bater de frente no dia a dia.
        action={
          canManageRecords(profile.role) ? (
            <Link
              href="/tv"
              className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
            >
              Painéis de TV
            </Link>
          ) : undefined
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Em aberto" value={m?.open_total ?? 0} hint={`${m?.open_new ?? 0} aguardando triagem`} />
        <StatTile label="Em andamento" value={m?.in_progress_total ?? 0} tone="info" />
        <StatTile label="Críticos" value={m?.critical_total ?? 0} tone="crit" />
        <StatTile label="SLA estourado" value={m?.sla_breached ?? 0} tone="breach" />
        <StatTile label="SLA em risco" value={m?.sla_at_risk ?? 0} tone="warn" />
        <StatTile label="Aguardando terceiros" value={m?.waiting_total ?? 0} hint="relógio de SLA pausado" />
        <StatTile
          label="Resolvidos hoje"
          value={m?.resolved_today ?? 0}
          tone="ok"
          hint={`${m?.created_today ?? 0} abertos hoje`}
        />
        <StatTile
          label="Tempo médio de resolução"
          value={formatMinutes(m?.avg_resolution_minutes_24h)}
          hint="últimas 24 horas"
        />
      </div>

      <div className="mb-6">
        <Card
          title={`Atendentes online: ${online?.agents_online ?? 0} de ${online?.agents_total ?? 0}`}
        >
          <p className="text-sm text-[var(--color-ink-2)]">
            Considera atividade nos últimos 5 minutos.
          </p>
        </Card>
      </div>

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold text-[var(--color-ink)]">
          Atenção imediata — SLA em risco ou estourado
        </h2>
        {atRisk && atRisk.length > 0 ? (
          <TicketList tickets={atRisk} />
        ) : (
          <EmptyState title="Nenhum ticket em risco" description="Todos os prazos estão sob controle." />
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-[var(--color-ink)]">Meus tickets</h2>
        {mine && mine.length > 0 ? (
          <TicketList tickets={mine} />
        ) : (
          <EmptyState title="Nenhum ticket atribuído a você" />
        )}
      </section>
    </>
  )
}
