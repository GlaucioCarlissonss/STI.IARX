import { Fragment } from 'react'
import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { getAgents, getBranches } from '@/lib/data/lookups'
import { lineStatusLabel, lineTypeLabel } from '@/lib/i18n'
import { formatCurrency, formatDate } from '@/lib/format'
import type { TelecomLine } from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { EditPanel } from '@/components/edit-panel'
import { EditLineForm, NewLineForm } from './line-forms'

export const metadata: Metadata = { title: 'Telefonia' }

interface CostRow {
  branch_name: string | null
  carrier: string
  status: string
  lines_count: number
  monthly_total: number
}

const statusTone: Record<string, 'ok' | 'warn' | 'neutral'> = {
  active: 'ok',
  suspended: 'warn',
  cancelled: 'neutral',
}

export default async function TelefoniaPage() {
  await requireScreen('telefonia.linhas.ver')
  const supabase = await createClient()

  const [{ data: lines }, { data: costs }, branches, agents, { data: devices }] = await Promise.all([
    supabase
      .from('telecom_lines')
      .select(
        'id, phone_number, carrier, plan_name, line_type, status, branch_id, assigned_user_id, device_asset_id, monthly_cost, activated_on, cancelled_on, loyalty_until',
      )
      .is('deleted_at', null)
      .order('phone_number')
      .returns<TelecomLine[]>(),
    supabase
      .from('vw_telecom_costs')
      .select('branch_name, carrier, status, lines_count, monthly_total')
      .order('monthly_total', { ascending: false })
      .returns<CostRow[]>(),
    getBranches(),
    getAgents(),
    supabase
      .from('it_assets')
      .select('id, asset_tag, brand, model')
      .in('asset_type', ['smartphone', 'tablet'])
      .is('deleted_at', null),
  ])

  const [podeEditar, podeCriar] = await Promise.all([
    allowed('telefonia.linhas.editar'),
    allowed('telefonia.linhas.criar'),
  ])
  const list = lines ?? []
  const branchName = new Map(branches.map((b) => [b.id, b.name]))
  const userName = new Map(agents.map((a) => [a.id, a.full_name]))

  const activeCost = list
    .filter((l) => l.status === 'active')
    .reduce((sum, l) => sum + (l.monthly_cost ?? 0), 0)

  return (
    <>
      <PageHeader
        title="Telefonia"
        description="Linhas móveis e fixas, com custo mensal por filial e operadora."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Linhas cadastradas" value={list.length} />
        <StatTile label="Ativas" value={list.filter((l) => l.status === 'active').length} tone="ok" />
        <StatTile
          label="Suspensas"
          value={list.filter((l) => l.status === 'suspended').length}
          tone="warn"
        />
        <StatTile label="Custo mensal ativo" value={formatCurrency(activeCost)} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="flex flex-col gap-6">
          {list.length > 0 ? (
            <Table head={['Número', 'Operadora / plano', 'Tipo', 'Status', 'Filial', 'Responsável', 'Custo', 'Fidelidade']}>
              {list.map((l) => (
                <Fragment key={l.id}>
                <tr className="hover:bg-[var(--color-surface-2)]">
                  <Td className="font-mono text-xs font-medium">{l.phone_number}</Td>
                  <Td>
                    <span className="font-medium text-[var(--color-ink)]">{l.carrier}</span>
                    <p className="text-xs text-[var(--color-ink-3)]">{l.plan_name ?? '—'}</p>
                  </Td>
                  <Td className="text-[var(--color-ink-2)]">
                    {lineTypeLabel[l.line_type] ?? l.line_type}
                  </Td>
                  <Td>
                    <Badge tone={statusTone[l.status] ?? 'neutral'}>
                      {lineStatusLabel[l.status] ?? l.status}
                    </Badge>
                  </Td>
                  <Td className="text-[var(--color-ink-2)]">
                    {l.branch_id ? (branchName.get(l.branch_id) ?? '—') : '—'}
                  </Td>
                  <Td className="text-[var(--color-ink-2)]">
                    {l.assigned_user_id ? (userName.get(l.assigned_user_id) ?? '—') : '—'}
                  </Td>
                  <Td className="tabular-nums">{formatCurrency(l.monthly_cost)}</Td>
                  <Td className="text-[var(--color-ink-2)]">{formatDate(l.loyalty_until)}</Td>
                </tr>
                {podeEditar && (
                  <tr>
                    <Td className="bg-[var(--color-surface-2)]" colSpan={8}>
                      <EditPanel title={`Editar ${l.phone_number}`}>
                        <EditLineForm
                          line={l}
                          branches={branches}
                          agents={agents}
                          devices={devices ?? []}
                        />
                      </EditPanel>
                    </Td>
                  </tr>
                )}
                </Fragment>
              ))}
            </Table>
          ) : (
            <EmptyState title="Nenhuma linha cadastrada" />
          )}

          <section>
            <h2 className="mb-3 text-lg font-semibold text-[var(--color-ink)]">
              Custos por filial e operadora
            </h2>
            {costs && costs.length > 0 ? (
              <Table head={['Filial', 'Operadora', 'Situação', 'Linhas', 'Custo mensal']}>
                {costs.map((c, i) => (
                  <tr key={`${c.branch_name}-${c.carrier}-${c.status}-${i}`}>
                    <Td className="text-[var(--color-ink-2)]">{c.branch_name ?? 'Sem filial'}</Td>
                    <Td className="font-medium text-[var(--color-ink)]">{c.carrier}</Td>
                    <Td>
                      <Badge tone={statusTone[c.status] ?? 'neutral'}>
                        {lineStatusLabel[c.status] ?? c.status}
                      </Badge>
                    </Td>
                    <Td className="tabular-nums">{c.lines_count}</Td>
                    <Td className="tabular-nums font-medium">{formatCurrency(c.monthly_total)}</Td>
                  </tr>
                ))}
              </Table>
            ) : (
              <EmptyState title="Sem dados de custo" />
            )}
          </section>
        </div>

        {podeCriar && (
          <Card title="Nova linha">
            <NewLineForm
              branches={branches}
              agents={agents}
              devices={devices ?? []}
            />
          </Card>
        )}
      </div>
    </>
  )
}
