import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import type { DashboardMetrics, EnrichedTicket } from '@/lib/types'
import { TvBoard } from './tv-board'
import { TvReconnecting } from './tv-reconnecting'

export const metadata: Metadata = {
  title: 'Painel de operação',
  robots: { index: false, follow: false },
}

// Nunca cachear: o painel fica aberto por semanas e precisa refletir o banco.
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Painel de TV em modo kiosk (RF-DSH-07).
 *
 * Autenticado por token de exibição, não por sessão (ADR-006) — uma TV de parede
 * não tem quem faça login nem quem renove sessão expirada.
 *
 * Este é um dos dois únicos pontos do app que usam `service_role`, e por isso
 * TODA consulta aqui filtra `tenant_id` explicitamente: sem RLS para segurar,
 * o filtro é responsabilidade deste arquivo.
 */
export default async function TvPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const supabase = createAdminClient()

  const { data: resolved, error: resolveError } = await supabase.rpc('resolve_dashboard_token', {
    p_token: token,
  })

  // Falha de rede/banco na própria consulta é diferente de "token inválido" —
  // confundir as duas faria uma instabilidade passageira derrubar a TV no
  // MESMO 404 permanente de um token de verdade revogado, sem chance de se
  // recuperar sozinha (o intervalo que atualiza a tela vive dentro do
  // `TvBoard`, que nunca chega a montar numa página 404).
  if (resolveError) return <TvReconnecting />

  const scope = Array.isArray(resolved) ? resolved[0] : resolved

  // Token inválido, expirado ou revogado — 404 sem explicar qual dos três,
  // para não transformar a rota em um oráculo de tokens válidos.
  if (!scope?.tenant_id) notFound()

  const tenantId: string = scope.tenant_id
  const branchIds: string[] = scope.branch_ids ?? []
  const refreshSeconds: number = scope.refresh_seconds ?? 45

  const [{ data: tenant }, { data: layout }, { data: online }] = await Promise.all([
    supabase.from('tenants').select('name').eq('id', tenantId).maybeSingle(),
    scope.layout_id
      ? supabase.from('dashboard_layouts').select('name, config').eq('id', scope.layout_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from('vw_agents_online')
      .select('agents_online, agents_total')
      .eq('tenant_id', tenantId)
      .maybeSingle(),
  ])

  let ticketQuery = supabase
    .from('vw_tickets_enriched')
    .select('*')
    .eq('tenant_id', tenantId)
    .not('status', 'in', '("resolved","closed")')
    .order('queue_score', { ascending: false })
    .limit(40)

  // Escopo de filial do token: array vazio significa "todas as filiais".
  if (branchIds.length > 0) ticketQuery = ticketQuery.in('branch_id', branchIds)

  const [{ data: tickets }, { data: metricsRow }] = await Promise.all([
    ticketQuery.returns<EnrichedTicket[]>(),
    supabase
      .from('vw_dashboard_metrics')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle<DashboardMetrics>(),
  ])

  // Com escopo de filial, os contadores globais do tenant não valem — eles
  // incluiriam filiais que este painel não deve mostrar. Recontamos sobre a
  // lista já filtrada.
  const scoped = branchIds.length > 0
  const list = tickets ?? []
  const metrics: DashboardMetrics = scoped
    ? {
        tenant_id: tenantId,
        open_total: list.length,
        open_new: list.filter((t) => t.status === 'open').length,
        in_progress_total: list.filter((t) => ['assigned', 'in_progress'].includes(t.status)).length,
        waiting_total: list.filter((t) => t.status.startsWith('waiting')).length,
        critical_total: list.filter((t) => t.priority_weight >= 80).length,
        sla_at_risk: list.filter((t) => ['warning', 'critical'].includes(t.resolution_state ?? '')).length,
        sla_breached: list.filter((t) => t.resolution_state === 'breached').length,
        resolved_today: 0,
        created_today: 0,
        avg_resolution_minutes_24h: null,
      }
    : (metricsRow ?? {
        tenant_id: tenantId,
        open_total: 0,
        open_new: 0,
        in_progress_total: 0,
        waiting_total: 0,
        critical_total: 0,
        sla_at_risk: 0,
        sla_breached: 0,
        resolved_today: 0,
        created_today: 0,
        avg_resolution_minutes_24h: null,
      })

  return (
    <TvBoard
      tenantName={tenant?.name ?? 'Operação'}
      layoutName={layout?.name ?? 'Painel de operação'}
      metrics={metrics}
      tickets={list}
      agentsOnline={online?.agents_online ?? 0}
      agentsTotal={online?.agents_total ?? 0}
      refreshSeconds={refreshSeconds}
      scopedToBranches={scoped}
    />
  )
}
