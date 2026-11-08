import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { escopoDeCliente, porFilialOuGeral } from '@/lib/data/escopo'
import { comParametros } from '@/lib/data/endereco'
import { lerPagina, paginar } from '@/lib/data/paginacao'
import { requireScreen, allowed } from '@/lib/session'
import { getAgents, getBranches } from '@/lib/data/lookups'
import { assetStatusLabel, assetStatusTone, assetTypeLabel } from '@/lib/i18n'
import { formatCurrency, formatDate } from '@/lib/format'
import type { BranchArea, ItAsset } from '@/lib/types'
import { Badge, EmptyState, PageHeader, Pager, StatTile, Table, Td } from '@/components/ui'
import { GavetaDoAtivo } from './gaveta-do-ativo'

export const metadata: Metadata = { title: 'Inventário de TI' }

interface ResumoDeAtivos {
  branch_id: string | null
  status: string
  ativos: number
  valor_total: number
  garantia_90d: number
}

export default async function InventarioPage({
  searchParams,
}: {
  searchParams: Promise<{ pagina?: string; aberto?: string; novo?: string }>
}) {
  const params = await searchParams
  await requireScreen('inventario.ativos.ver')
  const supabase = await createClient()
  const escopo = await escopoDeCliente()
  const pagina = lerPagina(params.pagina)

  /* `suppliers` saiu desta consulta junto com o formulário: quem precisa da
     lista de fornecedores agora é a gaveta, e ela a busca por conta própria. */
  const [{ data: assets, count }, branches, agents, { data: areas }, { data: resumo }] =
    await Promise.all([
    /* Ativo sem filial é do tenant inteiro e entra em qualquer foco — ver a
       regra das colunas nulas em `src/lib/data/escopo.ts`. */
    paginar(
      porFilialOuGeral(
        supabase
          .from('it_assets')
          .select(
            'id, asset_tag, serial_number, asset_type, brand, model, status, branch_id, branch_area_id, assigned_user_id, supplier_id, acquisition_date, warranty_until, acquisition_cost, notes',
            { count: 'exact' },
          )
          .is('deleted_at', null)
          .order('asset_tag', { nullsFirst: false })
          // Desempate estável: `asset_tag` é nulável, e sem segunda chave dois
          // ativos sem patrimônio trocam de lugar entre páginas — um aparece
          // duas vezes e o outro, nenhuma.
          .order('id'),
        escopo,
      ),
      pagina,
    ).returns<ItAsset[]>(),
    getBranches(),
    getAgents(),
    supabase
      .from('branch_areas')
      .select('id, branch_id, name, code, kind, is_active, sort_order')
      .eq('is_active', true)
      .order('sort_order')
      .returns<BranchArea[]>(),
    /* Os indicadores vêm da VIEW, não da lista. Com a lista paginada,
       `list.filter(...).length` contaria 50 ativos num parque de 412 — número
       errado com cara de fato, que é pior que a truncagem silenciosa que esta
       entrega veio corrigir. A view agrega o acervo inteiro (migração 0028) e
       respeita o mesmo foco por empresa, porque carrega `branch_id`. */
    porFilialOuGeral(
      supabase
        .from('vw_assets_summary')
        .select('branch_id, status, ativos, valor_total, garantia_90d'),
      escopo,
    ).returns<ResumoDeAtivos[]>(),
  ])

  /*
   * Custódia e anexos NÃO são mais buscados aqui.
   *
   * Eles alimentavam um painel por linha, e por isso a tela trazia a timeline e
   * os anexos dos 50 ativos da página para abastecer painéis que, na prática,
   * quase ninguém abria. Agora quem busca é a gaveta, e só do ativo que está
   * aberto: uma consulta por chamada de verdade, em vez de cinquenta por
   * precaução.
   */
  const podeCriar = await allowed('inventario.ativos.criar')
  const listaAreas = areas ?? []
  const areaName = new Map(listaAreas.map((a) => [a.id, a.name]))
  const list = assets ?? []
  const branchName = new Map(branches.map((b) => [b.id, b.name]))
  const userName = new Map(agents.map((a) => [a.id, a.full_name]))

  /*
   * Os totais somam as linhas da VIEW, que já vêm agrupadas por filial e
   * situação — algumas dezenas de linhas, não o parque inteiro. A regra de cada
   * um é a mesma de antes, agora escrita em SQL na migração 0028, inclusive o
   * piso em `current_date` da garantia: sem ele, garantia vencida há anos
   * contava como "vencendo em 90 dias" para sempre, e o indicador vermelho
   * permanente escondia a que de fato vence semana que vem.
   */
  const agregado = resumo ?? []
  const somar = (campo: 'ativos' | 'valor_total' | 'garantia_90d', status?: string) =>
    agregado
      .filter((r) => status === undefined || r.status === status)
      .reduce((s, r) => s + Number(r[campo] ?? 0), 0)

  const totalAtivos = somar('ativos')
  const emUso = somar('ativos', 'active')
  const emManutencao = somar('ativos', 'maintenance')
  const expiringWarranty = somar('garantia_90d')
  const totalValue = somar('valor_total')

  /* Endereço desta tela com um parâmetro trocado — é assim que a gaveta abre e
     fecha sem perder a página em que a pessoa estava. */
  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/inventario', params, { ...mudancas, pagina: params.pagina ?? null })

  const gavetaAberta = Boolean(params.aberto || params.novo)

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && (
        <GavetaDoAtivo
          id={params.aberto}
          novo={Boolean(params.novo)}
          fechar={endereco({ aberto: null, novo: null })}
        />
      )}

      <PageHeader
        title="Inventário de TI"
        description="Equipamentos, periféricos e licenças, com ciclo de vida rastreado."
        action={
          /* O histórico de custódia em planilha, pedido pelo M4 do roadmap
             (LG-11): quem está com cada equipamento, desde quando e por quê. */
          /* `<a download>`, e não `<Link>`: `/api/exportar/...` é um Route
             Handler, e navegação do lado do cliente não baixa arquivo nenhum. */
          <div className="flex flex-wrap gap-2">
            <a
              download
              href="/api/exportar/custodia"
              className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
            >
              Exportar custódia
            </a>
            {/* O cadastro deixou de ocupar um terço da tela o dia inteiro e
                virou um botão — que só existe para quem pode criar. */}
            {podeCriar && (
              <Link
                href={endereco({ novo: '1' }) as Route}
                data-testid="novo-ativo"
                className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
              >
                Novo ativo
              </Link>
            )}
          </div>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Ativos cadastrados" value={totalAtivos} />
        <StatTile label="Em uso" value={emUso} tone="ok" />
        <StatTile label="Em manutenção" value={emManutencao} tone="warn" />
        <StatTile
          label="Garantia vencendo"
          value={expiringWarranty}
          hint="próximos 90 dias"
          tone={expiringWarranty > 0 ? 'crit' : 'neutral'}
        />
      </div>

      {/* A tela inteira é a lista. A coluna de 23rem com o formulário de
          cadastro — aberta o tempo todo, inclusive para quem só consulta —
          virou a gaveta de "Novo ativo". */}
      <div>
        <div>
          {list.length > 0 ? (
            <>
              <p className="mb-2 text-sm text-[var(--color-ink-2)]">
                Valor total de aquisição: {formatCurrency(totalValue)}
              </p>
              <Table
                label="Ativos de TI"
                head={[
                  'Patrimônio', 'Equipamento', 'Nº de série', 'Status',
                  'Filial / área', 'Responsável', 'Garantia',
                ]}
              >
                {list.map((a) => (
                  <tr key={a.id} className="hover:bg-[var(--color-surface-2)]">
                    <Td className="font-mono text-xs">{a.asset_tag ?? '—'}</Td>
                    <Td>
                      {/* O nome abre a gaveta. Antes, abrir um ativo era
                          expandir um painel embaixo da linha, que empurrava
                          todas as outras para baixo e fazia a lista "pular"
                          debaixo do cursor. */}
                      <Link
                        href={endereco({ aberto: a.id }) as Route}
                        data-testid="abrir-ativo"
                        className="font-medium text-[var(--color-brand-ink)] hover:underline"
                      >
                        {a.brand} {a.model}
                      </Link>
                      <p className="text-xs text-[var(--color-ink-3)]">
                        {assetTypeLabel[a.asset_type] ?? a.asset_type}
                      </p>
                    </Td>
                    <Td className="font-mono text-xs text-[var(--color-ink-2)]">
                      {a.serial_number ?? '—'}
                    </Td>
                    <Td>
                      <Badge tone={assetStatusTone[a.status] ?? 'neutral'}>
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
                ))}
              </Table>
              <Pager
                pagina={pagina.numero}
                total={count ?? 0}
                tamanho={pagina.tamanho}
                base="/inventario"
                params={params}
              />
            </>
          ) : (
            <EmptyState
              title="Nenhum ativo cadastrado"
              description={
                podeCriar
                  ? 'Cadastre o primeiro equipamento em "Novo ativo".'
                  : 'Nenhum equipamento alcançável pelo seu perfil.'
              }
            />
          )}
        </div>
      </div>
    </div>
  )
}
