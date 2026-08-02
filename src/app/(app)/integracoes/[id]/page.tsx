import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { requireRole } from '@/lib/session'
import { integrationOutcomeLabel, integrationStatusLabel } from '@/lib/i18n'
import { formatDateTime, formatNumber } from '@/lib/format'
import type { Integration, IntegrationLog } from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader, Table, Td } from '@/components/ui'
import { InboundTokenForm } from './inbound-token-form'

export const metadata: Metadata = { title: 'Integração' }

interface MappingRow {
  id: string
  source_path: string
  target_field: string
  transform: string
  value_map: Record<string, string>
  is_required: boolean
}

interface EventRow {
  id: string
  event_key: string
  event_type: string | null
  external_id: string | null
  status: string
  attempts: number
  last_error: string | null
  received_at: string
  ticket_id: string | null
}

const outcomeTone: Record<string, 'ok' | 'breach' | 'warn' | 'neutral'> = {
  ok: 'ok',
  error: 'breach',
  retry: 'warn',
  skipped_echo: 'neutral',
  duplicate: 'neutral',
}

const eventTone: Record<string, 'ok' | 'breach' | 'warn' | 'neutral'> = {
  processed: 'ok',
  failed: 'breach',
  pending: 'warn',
  skipped_echo: 'neutral',
  ignored: 'neutral',
}

export default async function IntegracaoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireRole(['super_admin', 'admin'])
  const supabase = await createClient()

  const { data: integration } = await supabase
    .from('integrations')
    .select(
      'id, name, slug, source_system, direction, status, auth_type, base_url, reverse_sync_enabled, last_sync_at, request_count, error_count',
    )
    .eq('id', id)
    .maybeSingle<Integration>()

  if (!integration) notFound()

  const [{ data: mappings }, { data: events }, { data: logs }] = await Promise.all([
    supabase
      .from('integration_mappings')
      .select('id, source_path, target_field, transform, value_map, is_required')
      .eq('integration_id', id)
      .order('target_field')
      .returns<MappingRow[]>(),
    supabase
      .from('integration_events')
      .select('id, event_key, event_type, external_id, status, attempts, last_error, received_at, ticket_id')
      .eq('integration_id', id)
      .order('received_at', { ascending: false })
      .limit(30)
      .returns<EventRow[]>(),
    supabase
      .from('integration_logs')
      .select('id, direction, method, endpoint, response_status, duration_ms, outcome, error_message, created_at')
      .eq('integration_id', id)
      .order('created_at', { ascending: false })
      .limit(40)
      .returns<IntegrationLog[]>(),
  ])

  const webhookPath =
    integration.source_system === 'bitrix24'
      ? `/functions/v1/bitrix24-webhook?integracao=${integration.slug}`
      : `/functions/v1/integration-webhook?integracao=${integration.slug}`

  return (
    <>
      <PageHeader
        title={integration.name}
        description={`${integration.source_system} · ${integration.direction}`}
        action={<Badge tone={integration.status === 'active' ? 'ok' : 'neutral'}>
          {integrationStatusLabel[integration.status]}
        </Badge>}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card title="Endpoint de recebimento">
            <p className="text-sm text-[var(--color-ink-2)]">
              Configure o webhook de saída do sistema de origem para este endereço:
            </p>
            <code className="mt-2 block overflow-x-auto whitespace-nowrap rounded bg-[var(--color-surface-2)] p-3 font-mono text-xs">
              {`{SUPABASE_URL}${webhookPath}`}
            </code>
            <p className="mt-2 text-xs text-[var(--color-ink-3)]">
              Requisições recebidas: {formatNumber(integration.request_count)} · erros:{' '}
              {formatNumber(integration.error_count)} · último sync:{' '}
              {formatDateTime(integration.last_sync_at)}
            </p>
          </Card>

          <Card title={`Mapeamento de campos (${mappings?.length ?? 0})`}>
            {mappings && mappings.length > 0 ? (
              <Table head={['Campo de origem', 'Campo do ticket', 'Transformação', 'Valores']}>
                {mappings.map((m) => (
                  <tr key={m.id}>
                    <Td className="font-mono text-xs">{m.source_path}</Td>
                    <Td className="font-medium text-[var(--color-ink)]">
                      {m.target_field}
                      {m.is_required && (
                        <span className="ml-1 text-[var(--color-breach-ink)]">*</span>
                      )}
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">{m.transform}</Td>
                    <Td className="font-mono text-xs text-[var(--color-ink-3)]">
                      {Object.keys(m.value_map ?? {}).length > 0
                        ? Object.entries(m.value_map)
                            .map(([k, v]) => `${k}→${v}`)
                            .join(', ')
                        : '—'}
                    </Td>
                  </tr>
                ))}
              </Table>
            ) : (
              <EmptyState title="Nenhum mapeamento cadastrado" />
            )}
          </Card>

          <Card title="Eventos recentes">
            {events && events.length > 0 ? (
              <Table head={['Recebido', 'Evento', 'ID externo', 'Situação', 'Tentativas', 'Erro']}>
                {events.map((e) => (
                  <tr key={e.id}>
                    <Td className="tabular-nums text-xs text-[var(--color-ink-2)]">
                      {formatDateTime(e.received_at)}
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">{e.event_type ?? '—'}</Td>
                    <Td className="font-mono text-xs">{e.external_id ?? '—'}</Td>
                    <Td>
                      <Badge tone={eventTone[e.status] ?? 'neutral'}>{e.status}</Badge>
                    </Td>
                    <Td className="tabular-nums">{e.attempts}</Td>
                    <Td className="max-w-64 truncate text-xs text-[var(--color-breach-ink)]">
                      {e.last_error ?? ''}
                    </Td>
                  </tr>
                ))}
              </Table>
            ) : (
              <EmptyState title="Nenhum evento recebido ainda" />
            )}
          </Card>

          <Card title="Log de requisições">
            {logs && logs.length > 0 ? (
              <Table head={['Quando', 'Direção', 'Endpoint', 'HTTP', 'Duração', 'Resultado']}>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <Td className="tabular-nums text-xs text-[var(--color-ink-2)]">
                      {formatDateTime(l.created_at)}
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">{l.direction}</Td>
                    <Td className="max-w-56 truncate font-mono text-xs">{l.endpoint ?? '—'}</Td>
                    <Td className="tabular-nums">{l.response_status ?? '—'}</Td>
                    <Td className="tabular-nums">{l.duration_ms ? `${l.duration_ms}ms` : '—'}</Td>
                    <Td>
                      <Badge tone={outcomeTone[l.outcome] ?? 'neutral'}>
                        {integrationOutcomeLabel[l.outcome] ?? l.outcome}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </Table>
            ) : (
              <EmptyState title="Sem requisições registradas" />
            )}
          </Card>
        </div>

        <aside className="flex flex-col gap-6">
          <Card title="Token de verificação">
            <p className="mb-3 text-sm text-[var(--color-ink-2)]">
              Cole aqui o <code className="font-mono text-xs">application_token</code> gerado pelo
              sistema de origem. Guardamos apenas o hash — o valor em claro nunca é persistido.
            </p>
            <InboundTokenForm integrationId={integration.id} />
          </Card>

          <Card title="Sincronização reversa">
            <p className="text-sm text-[var(--color-ink-2)]">
              {integration.reverse_sync_enabled
                ? 'Ativa: alterações feitas aqui são replicadas para o sistema de origem, com supressão de eco.'
                : 'Desativada. Os tickets são atualizados somente na direção origem → SaaS.'}
            </p>
          </Card>
        </aside>
      </div>
    </>
  )
}
