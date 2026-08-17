import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen } from '@/lib/session'
import { integrationStatusLabel } from '@/lib/i18n'
import { formatDateTime, formatNumber } from '@/lib/format'
import type { Integration } from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader, StatTile } from '@/components/ui'
import { IntegrationControls } from './integration-controls'

export const metadata: Metadata = { title: 'Integrações' }

const statusTone = { active: 'ok', paused: 'neutral', error: 'breach' } as const

export default async function IntegracoesPage() {
  await requireScreen('integracoes.hub.ver')
  const supabase = await createClient()

  const [{ data: integrations }, { data: pending }] = await Promise.all([
    supabase
      .from('integrations')
      .select(
        'id, name, slug, source_system, direction, status, auth_type, base_url, reverse_sync_enabled, last_sync_at, request_count, error_count',
      )
      .order('name')
      .returns<Integration[]>(),
    supabase
      .from('integration_events')
      .select('integration_id, status')
      .in('status', ['pending', 'failed']),
  ])

  const list = integrations ?? []
  const failedByIntegration = new Map<string, number>()
  // A consulta busca 'pending' e 'failed' juntos, mas só 'failed' era
  // contado — uma fila travada em 'pending' (webhook chegando, nada sendo
  // processado) não acendia badge nenhum, e o admin via a integração como
  // saudável enquanto os eventos se acumulavam sem processar.
  const pendingByIntegration = new Map<string, number>()
  for (const e of pending ?? []) {
    const target = e.status === 'failed' ? failedByIntegration : pendingByIntegration
    target.set(e.integration_id, (target.get(e.integration_id) ?? 0) + 1)
  }

  const totalRequests = list.reduce((s, i) => s + i.request_count, 0)
  const totalErrors = list.reduce((s, i) => s + i.error_count, 0)

  return (
    <>
      <PageHeader
        title="Integrações"
        description="Motor genérico de entrada de tickets. Adicionar uma origem nova é cadastro e mapeamento — não exige código."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Integrações" value={list.length} />
        <StatTile label="Ativas" value={list.filter((i) => i.status === 'active').length} tone="ok" />
        <StatTile label="Requisições" value={formatNumber(totalRequests)} />
        <StatTile
          label="Erros acumulados"
          value={formatNumber(totalErrors)}
          tone={totalErrors > 0 ? 'breach' : 'neutral'}
        />
      </div>

      {list.length === 0 ? (
        <EmptyState
          title="Nenhuma integração cadastrada"
          description="Cadastre uma integração no banco e aponte o webhook da origem para a Edge Function."
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {list.map((i) => {
            const failed = failedByIntegration.get(i.id) ?? 0
            const pendingCount = pendingByIntegration.get(i.id) ?? 0
            return (
              <Card key={i.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/integracoes/${i.id}` as Route}
                      className="text-base font-semibold text-[var(--color-brand-ink)] hover:underline"
                    >
                      {i.name}
                    </Link>
                    <p className="text-xs text-[var(--color-ink-3)]">
                      {i.source_system} · {i.direction} · {i.auth_type}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {failed > 0 && <Badge tone="breach">{failed} falha(s)</Badge>}
                    {pendingCount > 0 && <Badge tone="neutral">{pendingCount} pendente(s)</Badge>}
                    <Badge tone={statusTone[i.status]}>{integrationStatusLabel[i.status]}</Badge>
                  </div>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-[var(--color-ink-3)]">Último sync</dt>
                    <dd className="font-medium">{formatDateTime(i.last_sync_at)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-[var(--color-ink-3)]">Requisições / erros</dt>
                    <dd className="font-medium tabular-nums">
                      {formatNumber(i.request_count)} / {formatNumber(i.error_count)}
                    </dd>
                  </div>
                </dl>

                <div className="mt-4 border-t border-[var(--color-border)] pt-4">
                  <IntegrationControls
                    integrationId={i.id}
                    status={i.status}
                    reverseSyncEnabled={i.reverse_sync_enabled}
                  />
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </>
  )
}
