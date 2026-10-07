import { Fragment } from 'react'
import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { agruparPor } from '@/lib/data/agrupar'
import { requireScreen, allowed } from '@/lib/session'
import { getAgents, getBranches } from '@/lib/data/lookups'
import { escopoDeCliente, porFilialOuGeral } from '@/lib/data/escopo'
import { lerPagina, paginar } from '@/lib/data/paginacao'
import { contractStatusTone, lineStatusLabel, lineTypeLabel } from '@/lib/i18n'
import { formatCurrency, formatDate } from '@/lib/format'
import type { BranchArea, TelecomDashboardRow, TelecomLine } from '@/lib/types'
import {
  Badge, Card, EmptyState, Field, PageHeader, Pager, StatTile, Table, Td, inputClass,
} from '@/components/ui'
import { EditPanel } from '@/components/edit-panel'
import { Attachments, type AttachmentRecord } from '@/components/attachments'
import { EditLineForm, NewLineForm } from './line-forms'

export const metadata: Metadata = { title: 'Telefonia' }

export default async function TelefoniaPage({
  searchParams,
}: {
  searchParams: Promise<{
    filial?: string
    operadora?: string
    situacao?: string
    pagina?: string
  }>
}) {
  const filtros = await searchParams
  await requireScreen('telefonia.linhas.ver')
  const supabase = await createClient()
  const escopo = await escopoDeCliente()
  const pagina = lerPagina(filtros.pagina)

  const [
    { data: lines, count }, { data: painel }, branches, agents,
    { data: areas }, { data: devices },
  ] = await Promise.all([
    /*
     * Os filtros saíram da memória e foram para o banco.
     *
     * Antes a consulta trazia TODAS as linhas do tenant e o filtro acontecia
     * depois, em JavaScript — com o comentário "são poucas linhas por tenant".
     * Com paginação isso deixa de funcionar: filtrar depois de cortar em 50
     * filtraria a página, não o acervo, e a tela mostraria "3 resultados" quando
     * existem 300. Filtro e corte precisam acontecer no mesmo lugar, e esse
     * lugar é o banco.
     */
    paginar(
      (() => {
        let q = porFilialOuGeral(
          supabase
            .from('telecom_lines')
            .select(
              'id, phone_number, carrier, plan_name, line_type, status, branch_id, company_area_id, assigned_user_id, device_asset_id, monthly_cost, activated_on, cancelled_on, loyalty_until',
              { count: 'exact' },
            )
            .is('deleted_at', null)
            .order('phone_number')
            .order('id'),
          escopo,
        )
        if (filtros.filial) q = q.eq('branch_id', filtros.filial)
        if (filtros.operadora) q = q.eq('carrier', filtros.operadora)
        if (filtros.situacao) q = q.eq('status', filtros.situacao)
        return q
      })(),
      pagina,
    ).returns<TelecomLine[]>(),
    /* `vw_telecom_dashboard` (0013) no lugar de `vw_telecom_costs`: ela traz os
       mesmos números e mais dois que não apareciam em lugar nenhum — linha sem
       responsável e linha livre de fidelidade. A view existia desde aquela
       migração e nunca tinha sido consultada. */
    porFilialOuGeral(
      supabase
        .from('vw_telecom_dashboard')
        .select(
          'branch_id, branch_name, company_area_id, area_name, carrier, line_type, status, lines_count, monthly_total, monthly_avg, without_user, free_to_cancel',
        )
        .order('monthly_total', { ascending: false }),
      escopo,
    ).returns<TelecomDashboardRow[]>(),
    getBranches(),
    getAgents(),
    supabase
      .from('branch_areas')
      .select('id, branch_id, name, code, kind, is_active, sort_order')
      .eq('is_active', true)
      .order('sort_order')
      .returns<BranchArea[]>(),
    supabase
      .from('it_assets')
      .select('id, asset_tag, brand, model')
      .in('asset_type', ['smartphone', 'tablet'])
      .is('deleted_at', null),
    // Uma consulta para todas as linhas; agrupada em memória para não virar N+1.
  ])

  /* Anexos só das linhas desta página. */
  const idsDaPagina = (lines ?? []).map((l) => l.id)
  const { data: anexos } =
    idsDaPagina.length > 0
      ? await supabase
          .from('telecom_line_attachments')
          .select('id, line_id, storage_path, file_name, mime_type, size_bytes, created_at, kind')
          .in('line_id', idsDaPagina)
          .order('created_at', { ascending: false })
          .returns<(AttachmentRecord & { line_id: string })[]>()
      : { data: null }

  const [podeEditar, podeCriar, podeAnexar] = await Promise.all([
    allowed('telefonia.linhas.editar'),
    allowed('telefonia.linhas.criar'),
    allowed('telefonia.linhas.anexar'),
  ])
  const anexosPorLinha = agruparPor(anexos, 'line_id')
  const list = lines ?? []

  /* A lista de operadoras do seletor vem do PAINEL, não da lista.
     Com a consulta paginada, tirá-la das linhas visíveis deixaria o filtro com
     as operadoras da página 1 — e escolher uma operadora que só aparece na
     página 4 seria impossível. */
  const operadoras = [...new Set((painel ?? []).map((c) => c.carrier))].filter(Boolean).sort()

  /* O painel acompanha o mesmo recorte da tabela: dois números na mesma tela
     dizendo coisas diferentes sobre o mesmo filtro é pior que um número só.
     Ele continua sendo filtrado em memória porque é agregado — dezenas de
     linhas, não milhares. */
  const linhasPainel = (painel ?? []).filter(
    (c) =>
      (!filtros.filial || c.branch_id === filtros.filial) &&
      (!filtros.operadora || c.carrier === filtros.operadora) &&
      (!filtros.situacao || c.status === filtros.situacao),
  )
  const somaPainel = (campo: 'lines_count' | 'monthly_total', status?: string) =>
    linhasPainel
      .filter((c) => status === undefined || c.status === status)
      .reduce((n, c) => n + Number(c[campo] ?? 0), 0)

  const totalLinhas = somaPainel('lines_count')
  const ativas = somaPainel('lines_count', 'active')
  const suspensas = somaPainel('lines_count', 'suspended')
  const semDono = linhasPainel.reduce((n, c) => n + Number(c.without_user), 0)
  const semFidelidade = linhasPainel.reduce((n, c) => n + Number(c.free_to_cancel), 0)
  const listaAreas = areas ?? []
  const areaName = new Map(listaAreas.map((a) => [a.id, a.name]))
  const branchName = new Map(branches.map((b) => [b.id, b.name]))
  const userName = new Map(agents.map((a) => [a.id, a.full_name]))

  const activeCost = somaPainel('monthly_total', 'active')

  return (
    <>
      <PageHeader
        title="Telefonia"
        description="Linhas móveis e fixas, com custo mensal por filial e operadora."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Linhas cadastradas" value={totalLinhas} />
        <StatTile label="Ativas" value={ativas} tone="ok" />
        <StatTile
          label="Suspensas"
          value={suspensas}
          tone="warn"
        />
        <StatTile label="Custo mensal ativo" value={formatCurrency(activeCost)} />
        <StatTile
          label="Sem responsável"
          value={semDono}
          hint="linha que ninguém reconhece na fatura"
          tone={semDono > 0 ? 'warn' : 'ok'}
        />
        <StatTile
          label="Livres de fidelidade"
          value={semFidelidade}
          hint="podem ser canceladas sem multa"
        />
      </div>

      {/* `method="get"` sem JavaScript, como em /tickets: o recorte fica na barra
          de endereço e pode ser guardado nos favoritos ou mandado a outra pessoa. */}
      <form method="get" className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="min-w-[12rem]">
          <Field label="Filial" htmlFor="filial">
            <select id="filial" name="filial" defaultValue={filtros.filial ?? ''} className={inputClass}>
              <option value="">Todas</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="min-w-[10rem]">
          <Field label="Operadora" htmlFor="operadora">
            <select id="operadora" name="operadora" defaultValue={filtros.operadora ?? ''} className={inputClass}>
              <option value="">Todas</option>
              {operadoras.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="min-w-[10rem]">
          <Field label="Situação" htmlFor="situacao">
            <select id="situacao" name="situacao" defaultValue={filtros.situacao ?? ''} className={inputClass}>
              <option value="">Todas</option>
              {Object.entries(lineStatusLabel).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <button
          type="submit"
          className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)]"
        >
          Filtrar
        </button>
        {(filtros.filial || filtros.operadora || filtros.situacao) && (
          <a href="/telefonia" className="text-sm font-medium text-[var(--color-brand-ink)] hover:underline">
            Limpar
          </a>
        )}
      </form>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="flex flex-col gap-6">
          {list.length > 0 ? (
            <>
            <Table
              label="Linhas telefônicas"
              head={[
                'Número', 'Operadora / plano', 'Tipo', 'Status',
                'Filial / área', 'Responsável', 'Custo', 'Fidelidade',
              ]}
            >
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
                    <Badge tone={contractStatusTone[l.status] ?? 'neutral'}>
                      {lineStatusLabel[l.status] ?? l.status}
                    </Badge>
                  </Td>
                  <Td className="text-[var(--color-ink-2)]">
                    {l.branch_id ? (branchName.get(l.branch_id) ?? '—') : '—'}
                    <p className="text-xs text-[var(--color-ink-3)]">
                      {l.company_area_id ? (areaName.get(l.company_area_id) ?? '—') : 'sem área'}
                    </p>
                  </Td>
                  <Td className="text-[var(--color-ink-2)]">
                    {l.assigned_user_id ? (userName.get(l.assigned_user_id) ?? '—') : '—'}
                  </Td>
                  <Td className="tabular-nums">{formatCurrency(l.monthly_cost)}</Td>
                  <Td className="text-[var(--color-ink-2)]">{formatDate(l.loyalty_until)}</Td>
                </tr>
                {(podeEditar || podeAnexar) && (
                  <tr>
                    <Td className="bg-[var(--color-surface-2)]" colSpan={8}>
                      <EditPanel title={`Ficha e anexos — ${l.phone_number}`}>
                        <div className="flex flex-col gap-4">
                          {podeEditar && (
                            <EditLineForm
                              line={l}
                              branches={branches}
                              areas={listaAreas}
                              agents={agents}
                              devices={devices ?? []}
                            />
                          )}
                          <Attachments
                            entity="linhas"
                            entityId={l.id}
                            records={anexosPorLinha.get(l.id) ?? []}
                            title="Contratos e termos"
                          />
                        </div>
                      </EditPanel>
                    </Td>
                  </tr>
                )}
                </Fragment>
              ))}
            </Table>
            <Pager
              pagina={pagina.numero}
              total={count ?? 0}
              tamanho={pagina.tamanho}
              base="/telefonia"
              params={filtros}
            />
            </>
          ) : (
            <EmptyState
              title="Nenhuma linha encontrada"
              description="Ajuste os filtros ou cadastre a primeira linha no formulário ao lado."
            />
          )}

          <section>
            <h2 className="mb-3 text-lg font-semibold text-[var(--color-ink)]">
              Custo e governança por filial, área e operadora
            </h2>
            {linhasPainel.length > 0 ? (
              <Table
                label="Painel de telefonia"
                head={[
                  'Filial / área', 'Operadora', 'Tipo', 'Situação',
                  'Linhas', 'Custo mensal', 'Média', 'Sem dono', 'Sem fidelidade',
                ]}
              >
                {linhasPainel.map((c, i) => (
                  <tr key={`${c.branch_id}-${c.company_area_id}-${c.carrier}-${c.line_type}-${c.status}-${i}`}>
                    <Td className="text-[var(--color-ink-2)]">
                      {c.branch_name ?? 'Sem filial'}
                      <p className="text-xs text-[var(--color-ink-3)]">
                        {c.area_name ?? 'sem área'}
                      </p>
                    </Td>
                    <Td className="font-medium text-[var(--color-ink)]">{c.carrier}</Td>
                    <Td className="text-[var(--color-ink-2)]">
                      {lineTypeLabel[c.line_type] ?? c.line_type}
                    </Td>
                    <Td>
                      <Badge tone={contractStatusTone[c.status] ?? 'neutral'}>
                        {lineStatusLabel[c.status] ?? c.status}
                      </Badge>
                    </Td>
                    <Td className="tabular-nums">{c.lines_count}</Td>
                    <Td className="tabular-nums font-medium">{formatCurrency(c.monthly_total)}</Td>
                    <Td className="tabular-nums text-[var(--color-ink-2)]">
                      {formatCurrency(c.monthly_avg)}
                    </Td>
                    {/* Linha ativa sem responsável é conta que ninguém reconhece
                        quando a fatura chega — e é o número que some quando o
                        relatório agrega só por custo. */}
                    <Td className="tabular-nums">
                      {c.without_user > 0 ? (
                        <Badge tone="warn">{c.without_user}</Badge>
                      ) : (
                        <span className="text-[var(--color-ink-3)]">—</span>
                      )}
                    </Td>
                    <Td className="tabular-nums text-[var(--color-ink-2)]">{c.free_to_cancel}</Td>
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
              areas={listaAreas}
              agents={agents}
              devices={devices ?? []}
            />
          </Card>
        )}
      </div>
    </>
  )
}
