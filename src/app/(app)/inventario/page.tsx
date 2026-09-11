import { Fragment } from 'react'
import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { getAgents, getBranches } from '@/lib/data/lookups'
import { assetStatusLabel, assetTypeLabel, custodyEventLabel, custodyReasonLabel } from '@/lib/i18n'
import { formatCurrency, formatDate } from '@/lib/format'
import type { Branch, BranchArea, CustodyEvent, ItAsset, Profile } from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { EditPanel } from '@/components/edit-panel'
import { Attachments, type AttachmentRecord } from '@/components/attachments'
import { CustodyForm, EditAssetForm, NewAssetForm } from './asset-forms'

export const metadata: Metadata = { title: 'Inventário de TI' }

const statusTone: Record<string, 'ok' | 'warn' | 'neutral' | 'breach'> = {
  active: 'ok',
  in_stock: 'neutral',
  maintenance: 'warn',
  retired: 'neutral',
  lost: 'breach',
}

export default async function InventarioPage() {
  await requireScreen('inventario.ativos.ver')
  const supabase = await createClient()

  const [
    { data: assets }, branches, agents, { data: suppliers },
    { data: areas }, { data: custodia }, { data: anexos },
  ] = await Promise.all([
    supabase
      .from('it_assets')
      .select(
        'id, asset_tag, serial_number, asset_type, brand, model, status, branch_id, branch_area_id, assigned_user_id, supplier_id, acquisition_date, warranty_until, acquisition_cost, notes',
      )
      .is('deleted_at', null)
      .order('asset_tag')
      .returns<ItAsset[]>(),
    getBranches(),
    getAgents(),
    supabase.from('suppliers').select('id, name').is('deleted_at', null).order('name'),
    supabase
      .from('branch_areas')
      .select('id, branch_id, name, code, kind, is_active, sort_order')
      .eq('is_active', true)
      .order('sort_order')
      .returns<BranchArea[]>(),
    /* A timeline lê a VIEW, não a tabela: ela já resolve os nomes de quem
       entregou e de quem recebeu, e refazer esse join aqui seria a quarta cópia
       da mesma regra. Uma consulta para todos os ativos, agrupada em memória. */
    supabase
      .from('asset_custody_history')
      .select(
        'id, asset_id, event_type, previous_user_name, current_user_name, previous_branch_id, branch_id, previous_area_id, branch_area_id, reason, reason_note, performed_by_name, changed_at',
      )
      .order('changed_at', { ascending: false })
      .limit(400)
      .returns<CustodyEvent[]>(),
    // Uma consulta para todos os ativos, agrupada em memória. Uma por linha da
    // tabela seria N+1 numa tela que lista o inventário inteiro.
    supabase
      .from('asset_attachments')
      .select('id, asset_id, storage_path, file_name, mime_type, size_bytes, created_at, kind')
      .order('created_at', { ascending: false })
      .returns<(AttachmentRecord & { asset_id: string })[]>(),
  ])

  const [podeEditar, podeCriar, podeAnexar, podeCustodiar] = await Promise.all([
    allowed('inventario.ativos.editar'),
    allowed('inventario.ativos.criar'),
    allowed('inventario.ativos.anexar'),
    allowed('inventario.ativos.custodiar'),
  ])
  // Anexo por ativo. Quem pode anexar mas não editar também precisa do painel,
  // então a linha aparece para qualquer uma das duas permissões.
  const anexosPorAtivo = new Map<string, AttachmentRecord[]>()
  for (const a of anexos ?? []) {
    anexosPorAtivo.set(a.asset_id, [...(anexosPorAtivo.get(a.asset_id) ?? []), a])
  }
  const custodiaPorAtivo = new Map<string, CustodyEvent[]>()
  for (const e of custodia ?? []) {
    custodiaPorAtivo.set(e.asset_id, [...(custodiaPorAtivo.get(e.asset_id) ?? []), e])
  }
  const listaAreas = areas ?? []
  const areaName = new Map(listaAreas.map((a) => [a.id, a.name]))
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
                head={[
                  'Patrimônio', 'Equipamento', 'Nº de série', 'Status',
                  'Filial / área', 'Responsável', 'Garantia',
                ]}
              >
                {list.map((a) => (
                  <Fragment key={a.id}>
                  <tr className="hover:bg-[var(--color-surface-2)]">
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
                      <p className="text-xs text-[var(--color-ink-3)]">
                        {a.branch_area_id ? (areaName.get(a.branch_area_id) ?? '—') : 'sem área'}
                      </p>
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">
                      {a.assigned_user_id ? (userName.get(a.assigned_user_id) ?? '—') : '—'}
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">{formatDate(a.warranty_until)}</Td>
                  </tr>
                  {(podeEditar || podeAnexar || podeCustodiar) && (
                    <tr>
                      <Td className="bg-[var(--color-surface-2)]" colSpan={7}>
                        <EditPanel
                          title={`Ficha, custódia e anexos — ${[a.brand, a.model].filter(Boolean).join(' ') || a.asset_tag || 'ativo'}`}
                        >
                          <div className="flex flex-col gap-4">
                            {podeEditar && (
                              <EditAssetForm
                                asset={a}
                                branches={branches}
                                areas={listaAreas}
                                agents={agents}
                                suppliers={suppliers ?? []}
                              />
                            )}
                            <Custodia
                              asset={a}
                              eventos={custodiaPorAtivo.get(a.id) ?? []}
                              branches={branches}
                              areas={listaAreas}
                              agents={agents}
                              podeCustodiar={podeCustodiar}
                            />
                            <Attachments
                              entity="ativos"
                              entityId={a.id}
                              records={anexosPorAtivo.get(a.id) ?? []}
                              title="Notas fiscais e fotos"
                            />
                          </div>
                        </EditPanel>
                      </Td>
                    </tr>
                  )}
                  </Fragment>
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

        {podeCriar && (
          <Card title="Novo ativo">
            <NewAssetForm
              branches={branches}
              areas={listaAreas}
              agents={agents}
              suppliers={suppliers ?? []}
            />
          </Card>
        )}
      </div>
    </>
  )
}

/**
 * Custódia do equipamento: quem tem, onde está, e o rastro de como chegou lá.
 *
 * O banco guarda esse histórico desde a migração 0007 e nenhuma tela o mostrava
 * — a trigger gravava evento a cada troca de responsável, filial ou área, e o
 * registro ficava só no banco. A timeline É o valor do módulo: sem ela, "quem
 * está com o notebook" é um campo que alguém sobrescreve e ninguém audita.
 */
function Custodia({
  asset,
  eventos,
  branches,
  areas,
  agents,
  podeCustodiar,
}: {
  asset: ItAsset
  eventos: CustodyEvent[]
  branches: Branch[]
  areas: BranchArea[]
  agents: Profile[]
  podeCustodiar: boolean
}) {
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">Custódia</h3>
        <span className="text-xs text-[var(--color-ink-3)]">
          {eventos.length === 0 ? 'sem movimentação' : `${eventos.length} evento(s)`}
        </span>
      </div>

      {podeCustodiar && (
        <div className="mb-3">
          <EditPanel label="Transferir custódia" title="Transferir custódia">
            <CustodyForm asset={asset} branches={branches} areas={areas} agents={agents} />
          </EditPanel>
        </div>
      )}

      {eventos.length > 0 ? (
        <ol className="flex flex-col gap-2">
          {eventos.slice(0, 10).map((e) => (
            <li key={e.id} className="text-sm text-[var(--color-ink-2)]">
              <span className="font-medium text-[var(--color-ink)]">
                {formatDate(e.changed_at)}
              </span>{' '}
              · {custodyEventLabel[e.event_type] ?? e.event_type}
              {' · '}
              <span className="text-[var(--color-ink-3)]">
                {custodyReasonLabel[e.reason] ?? e.reason}
              </span>
              <p className="text-xs text-[var(--color-ink-3)]">
                {e.previous_user_name ?? 'sem responsável'} → {e.current_user_name ?? 'sem responsável'}
                {e.performed_by_name && ` · registrado por ${e.performed_by_name}`}
              </p>
              {e.reason_note && (
                <p className="text-xs italic text-[var(--color-ink-3)]">{e.reason_note}</p>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm italic text-[var(--color-ink-3)]">
          Nenhuma movimentação registrada. O histórico é gravado pelo banco a cada troca de
          responsável, filial ou área.
        </p>
      )}
    </section>
  )
}
