import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireSession, canManageRecords } from '@/lib/session'
import { getAgents, getBranches } from '@/lib/data/lookups'
import { assetStatusLabel, assetTypeLabel } from '@/lib/i18n'
import { formatCurrency, formatDate } from '@/lib/format'
import type { ItAsset } from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { NewAssetForm } from './new-asset-form'

export const metadata: Metadata = { title: 'Inventário de TI' }

const statusTone: Record<string, 'ok' | 'warn' | 'neutral' | 'breach'> = {
  active: 'ok',
  in_stock: 'neutral',
  maintenance: 'warn',
  retired: 'neutral',
  lost: 'breach',
}

export default async function InventarioPage() {
  const { profile } = await requireSession()
  const supabase = await createClient()

  const [{ data: assets }, branches, agents, { data: suppliers }] = await Promise.all([
    supabase
      .from('it_assets')
      .select(
        'id, asset_tag, serial_number, asset_type, brand, model, status, branch_id, assigned_user_id, acquisition_date, warranty_until, acquisition_cost, notes',
      )
      .is('deleted_at', null)
      .order('asset_tag')
      .returns<ItAsset[]>(),
    getBranches(),
    getAgents(),
    supabase.from('suppliers').select('id, name').is('deleted_at', null).order('name'),
  ])

  const list = assets ?? []
  const branchName = new Map(branches.map((b) => [b.id, b.name]))
  const userName = new Map(agents.map((a) => [a.id, a.full_name]))

  const today = new Date()
  const in90 = new Date(today.getTime() + 90 * 86400000)
  // Sem o piso em `today`, garantia vencida há anos contava como "vencendo em
  // 90 dias" para sempre — um parque antigo mostrava um tile vermelho
  // permanente e sem ação possível, e escondia no meio dele a garantia que de
  // fato vence semana que vem.
  const expiringWarranty = list.filter(
    (a) =>
      a.warranty_until &&
      new Date(a.warranty_until) >= today &&
      new Date(a.warranty_until) <= in90 &&
      a.status !== 'retired',
  ).length

  const totalValue = list.reduce((sum, a) => sum + (a.acquisition_cost ?? 0), 0)

  return (
    <>
      <PageHeader
        title="Inventário de TI"
        description="Equipamentos, periféricos e licenças, com ciclo de vida rastreado."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Ativos cadastrados" value={list.length} />
        <StatTile label="Em uso" value={list.filter((a) => a.status === 'active').length} tone="ok" />
        <StatTile
          label="Em manutenção"
          value={list.filter((a) => a.status === 'maintenance').length}
          tone="warn"
        />
        <StatTile
          label="Garantia vencendo"
          value={expiringWarranty}
          hint="próximos 90 dias"
          tone={expiringWarranty > 0 ? 'crit' : 'neutral'}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div>
          {list.length > 0 ? (
            <>
              <p className="mb-2 text-sm text-[var(--color-ink-2)]">
                Valor total de aquisição: {formatCurrency(totalValue)}
              </p>
              <Table
                head={['Patrimônio', 'Equipamento', 'Nº de série', 'Status', 'Filial', 'Responsável', 'Garantia']}
              >
                {list.map((a) => (
                  <tr key={a.id} className="hover:bg-[var(--color-surface-2)]">
                    <Td className="font-mono text-xs">{a.asset_tag ?? '—'}</Td>
                    <Td>
                      <span className="font-medium text-[var(--color-ink)]">
                        {a.brand} {a.model}
                      </span>
                      <p className="text-xs text-[var(--color-ink-3)]">
                        {assetTypeLabel[a.asset_type] ?? a.asset_type}
                      </p>
                    </Td>
                    <Td className="font-mono text-xs text-[var(--color-ink-2)]">
                      {a.serial_number ?? '—'}
                    </Td>
                    <Td>
                      <Badge tone={statusTone[a.status] ?? 'neutral'}>
                        {assetStatusLabel[a.status] ?? a.status}
                      </Badge>
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">
                      {a.branch_id ? (branchName.get(a.branch_id) ?? '—') : '—'}
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">
                      {a.assigned_user_id ? (userName.get(a.assigned_user_id) ?? '—') : '—'}
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">{formatDate(a.warranty_until)}</Td>
                  </tr>
                ))}
              </Table>
            </>
          ) : (
            <EmptyState
              title="Nenhum ativo cadastrado"
              description="Cadastre o primeiro equipamento no formulário ao lado."
            />
          )}
        </div>

        {canManageRecords(profile.role) && (
          <Card title="Novo ativo">
            <NewAssetForm branches={branches} agents={agents} suppliers={suppliers ?? []} />
          </Card>
        )}
      </div>
    </>
  )
}
