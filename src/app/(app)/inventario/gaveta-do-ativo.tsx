import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { getAgents, getBranches } from '@/lib/data/lookups'
import { formatDate } from '@/lib/format'
import { assetStatusLabel, assetStatusTone, assetTypeLabel, custodyEventLabel, custodyReasonLabel } from '@/lib/i18n'
import type { BranchArea, CustodyEvent, ItAsset } from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta } from '@/components/gaveta'
import { Attachments, type AttachmentRecord } from '@/components/attachments'
import { CustodyForm, EditAssetForm, NewAssetForm } from './asset-forms'

/**
 * O ativo na gaveta — e o cadastro de um novo, no mesmo lugar.
 *
 * ## O que saiu da tela por causa disto
 *
 * Duas coisas que ocupavam espaço permanente:
 *
 * 1. **Uma coluna de 23rem com o formulário "Novo ativo"**, aberta o tempo
 *    todo, inclusive para quem passou ali só para consultar um patrimônio.
 *    Era quase um terço da largura dedicada a uma ação que acontece algumas
 *    vezes por semana.
 * 2. **Um painel de edição por LINHA**, somando formulário, timeline de
 *    custódia e anexos para cada um dos 50 ativos da página. Mesmo recolhido,
 *    ele existia na marcação — e, pior, a página buscava custódia e anexos do
 *    parque inteiro da página para alimentar painéis que quase ninguém abria.
 *
 * Agora os dois são a mesma gaveta, e as consultas de custódia e anexo
 * acontecem **só para o ativo que está aberto**. A tela ficou mais larga e a
 * consulta, menor.
 *
 * ## Por que o formulário não aparece para quem não pode editar
 *
 * Porque campo desabilitado não é informação: é um convite recusado. Quem tem
 * leitura vê a ficha e o histórico de custódia — que é o que a permissão dela
 * autoriza — e nada mais.
 */
export async function GavetaDoAtivo({
  id,
  novo,
  fechar,
}: {
  /** O ativo aberto. Ignorado quando `novo` é verdadeiro. */
  id?: string
  novo?: boolean
  fechar: string
}) {
  const [branches, agents, podeEditar, podeCriar, podeCustodiar] = await Promise.all([
    getBranches(),
    getAgents(),
    allowed('inventario.ativos.editar'),
    allowed('inventario.ativos.criar'),
    allowed('inventario.ativos.custodiar'),
  ])

  const supabase = await createClient()
  const [{ data: areas }, { data: suppliers }] = await Promise.all([
    supabase
      .from('branch_areas')
      .select('id, branch_id, name, code, kind, is_active, sort_order')
      .eq('is_active', true)
      .order('sort_order')
      .returns<BranchArea[]>(),
    supabase.from('suppliers').select('id, name').is('deleted_at', null).order('name'),
  ])

  if (novo) {
    /* Sem permissão de criar, a gaveta simplesmente não abre — e o botão que
       levaria até aqui também não existe. Duas portas, a mesma conferência. */
    if (!podeCriar) return null
    return (
      <Gaveta fechar={fechar} rotulo="Novo ativo">
        <Cabecalho titulo="Novo ativo" linha="Cadastro de equipamento" fechar={fechar} />
        <div className="flex-1 overflow-y-auto px-4 pb-6 pt-3">
          <NewAssetForm
            branches={branches}
            areas={areas ?? []}
            agents={agents}
            suppliers={suppliers ?? []}
          />
        </div>
      </Gaveta>
    )
  }

  if (!id) return null

  const { data: ativo } = await supabase
    .from('it_assets')
    .select(
      'id, asset_tag, serial_number, asset_type, brand, model, status, branch_id, branch_area_id, assigned_user_id, supplier_id, acquisition_date, warranty_until, acquisition_cost, notes',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle<ItAsset>()

  if (!ativo) return null

  const [{ data: custodia }, { data: anexos }, podeAnexar] = await Promise.all([
    supabase
      .from('asset_custody_history')
      .select(
        'id, asset_id, event_type, previous_user_name, current_user_name, previous_branch_id, branch_id, previous_area_id, branch_area_id, reason, reason_note, performed_by_name, changed_at',
      )
      .eq('asset_id', id)
      .order('changed_at', { ascending: false })
      .limit(20)
      .returns<CustodyEvent[]>(),
    supabase
      .from('asset_attachments')
      .select('id, asset_id, storage_path, file_name, mime_type, size_bytes, created_at, kind')
      .eq('asset_id', id)
      .order('created_at', { ascending: false })
      .returns<(AttachmentRecord & { asset_id: string })[]>(),
    allowed('inventario.ativos.anexar'),
  ])

  const nome = [ativo.brand, ativo.model].filter(Boolean).join(' ') || ativo.asset_tag || 'Ativo'

  return (
    <Gaveta fechar={fechar} rotulo={nome}>
      <Cabecalho
        titulo={nome}
        linha={`${ativo.asset_tag ?? 'sem patrimônio'} · ${assetTypeLabel[ativo.asset_type] ?? ativo.asset_type}`}
        fechar={fechar}
        selo={
          <Badge tone={assetStatusTone[ativo.status] ?? 'neutral'}>
            {assetStatusLabel[ativo.status] ?? ativo.status}
          </Badge>
        }
      />

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-6 pt-3">
        {podeEditar ? (
          <EditAssetForm
            asset={ativo}
            branches={branches}
            areas={areas ?? []}
            agents={agents}
            suppliers={suppliers ?? []}
          />
        ) : (
          <Ficha ativo={ativo} />
        )}

        <Custodia
          asset={ativo}
          eventos={custodia ?? []}
          branches={branches}
          areas={areas ?? []}
          agents={agents}
          podeCustodiar={podeCustodiar}
        />

        {(podeAnexar || (anexos ?? []).length > 0) && (
          <Attachments
            entity="ativos"
            entityId={ativo.id}
            records={anexos ?? []}
            title="Notas fiscais e fotos"
          />
        )}
      </div>
    </Gaveta>
  )
}

function Cabecalho({
  titulo,
  linha,
  fechar,
  selo,
}: {
  titulo: string
  linha: string
  fechar: string
  selo?: React.ReactNode
}) {
  return (
    <header className="border-b border-[var(--color-border)] px-4 py-3">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-xs text-[var(--color-ink-3)]">{linha}</p>
        <a
          href={fechar}
          aria-label="Fechar a gaveta"
          data-testid="fechar-gaveta"
          className="rounded-lg border border-[var(--color-border)] px-2 py-0.5 text-sm text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]"
        >
          ✕
        </a>
      </div>
      <h2 className="mt-1 flex flex-wrap items-center gap-2 text-lg font-bold leading-snug text-[var(--color-ink)]">
        {titulo}
        {selo}
      </h2>
    </header>
  )
}

/** O que quem só tem leitura enxerga no lugar do formulário. */
function Ficha({ ativo }: { ativo: ItAsset }) {
  const linhas: [string, string][] = [
    ['Patrimônio', ativo.asset_tag ?? '—'],
    ['Nº de série', ativo.serial_number ?? '—'],
    ['Tipo', assetTypeLabel[ativo.asset_type] ?? ativo.asset_type],
    ['Aquisição', formatDate(ativo.acquisition_date)],
    ['Garantia até', formatDate(ativo.warranty_until)],
  ]
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {linhas.map(([rotulo, valor]) => (
        <div key={rotulo} className="contents">
          <dt className="text-[var(--color-ink-3)]">{rotulo}</dt>
          <dd className="text-right font-medium text-[var(--color-ink)]">{valor}</dd>
        </div>
      ))}
    </dl>
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
  branches: Awaited<ReturnType<typeof getBranches>>
  areas: BranchArea[]
  agents: Awaited<ReturnType<typeof getAgents>>
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
          <CustodyForm asset={asset} branches={branches} areas={areas} agents={agents} />
        </div>
      )}

      {eventos.length > 0 ? (
        <ol className="flex flex-col gap-2">
          {eventos.slice(0, 10).map((e) => (
            <li key={e.id} className="text-sm text-[var(--color-ink-2)]">
              <span className="font-medium text-[var(--color-ink)]">{formatDate(e.changed_at)}</span>{' '}
              · {custodyEventLabel[e.event_type] ?? e.event_type}
              {' · '}
              <span className="text-[var(--color-ink-3)]">
                {custodyReasonLabel[e.reason] ?? e.reason}
              </span>
              <p className="text-xs text-[var(--color-ink-3)]">
                {e.previous_user_name ?? 'sem responsável'} →{' '}
                {e.current_user_name ?? 'sem responsável'}
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
