import Link from 'next/link'
import type { Route } from 'next'
import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { getBranches } from '@/lib/data/lookups'
import { escopoDeCliente, porFilial } from '@/lib/data/escopo'
import { lerPagina, paginar } from '@/lib/data/paginacao'
import { contractStatusTone, linkStateLabel, linkStateTone, linkStatusLabel, linkTechnologyLabel } from '@/lib/i18n'
import { formatCurrency } from '@/lib/format'
import type { ConnectivityCostRow, InternetLink } from '@/lib/types'
import {
  Badge, EmptyState, FaixaDeIndicadores, PageHeader, Pager, StatTile, Table, Td,
} from '@/components/ui'
import { comParametros } from '@/lib/data/endereco'
import { GavetaDeLink } from './gaveta'
import type { AreaOption, SupplierOption } from './link-forms'

export const metadata: Metadata = { title: 'Links de internet' }

/**
 * Links de internet.
 *
 * A camada de dados existe desde a migração 0013 e a tela só chega agora — era o
 * último item "em breve" com banco pronto. Por isso a 0022 traz as chaves
 * `conectividade.links.*`: nesta base, permissão entra junto com a tela que ela
 * governa, nunca antes.
 *
 * O RLS de `internet_links` (0013:947) é POR FILIAL — `app.can_see_branch()`.
 * Então esta tela mostra a conectividade das filiais que a pessoa atende, não a do
 * tenant inteiro, e os totais aqui são os totais do que ela vê. Isso não é
 * limitação a corrigir: é a mesma regra do inventário.
 *
 * Os indicadores são calculados em memória a partir da mesma lista que a tabela
 * mostra, e não de `vw_internet_dashboard`. A view existe e agrega por
 * filial × operadora × tecnologia × situação — reagrupar aquilo daria o mesmo
 * número por um caminho mais longo, e um número de cabeçalho que discorda da
 * tabela logo abaixo é pior que nenhum número.
 */

interface ResumoDeLinks {
  status: string
  links_count: number
  monthly_total: number
  links_down: number
  links_unknown: number
  expiring_90d: number
  expirados: number
  without_contract: number
}

export default async function LinksDeInternetPage({
  searchParams,
}: {
  searchParams: Promise<{
    pagina?: string
    aberto?: string
    novo?: string
    monitoramento?: string
  }>
}) {
  const params = await searchParams
  await requireScreen('conectividade.links.ver')

  const [podeCriar, podeEditar, podeMudarStatus, podeRegistrar, podeAnexar] = await Promise.all([
    allowed('conectividade.links.criar'),
    allowed('conectividade.links.editar'),
    allowed('conectividade.links.mudar_status'),
    allowed('conectividade.links.registrar_evento'),
    allowed('conectividade.links.anexar'),
  ])
  const podeMonitorar = await allowed('conectividade.links.monitoramento')

  const supabase = await createClient()
  const escopo = await escopoDeCliente()
  const pagina = lerPagina(params.pagina)

  const [
    { data: links, count },
    { data: custos },
    branches,
    { data: areas },
    { data: fornecedores },
    { data: resumo },
  ] = await Promise.all([
    /* `internet_links.branch_id` é NOT NULL: link sempre pertence a uma filial,
       então aqui é `porFilial` e não a variante que inclui nulos. */
    paginar(
      porFilial(
        supabase
          .from('internet_links')
          .select(
            'id, branch_id, branch_area_id, contract_number, supplier_id, carrier_name, technology, download_mbps, upload_mbps, guaranteed_mbps, has_static_ip, static_ip, cpe_brand, cpe_model, cpe_serial, status, monthly_cost, activated_on, cancelled_on, contract_start, contract_end, monitoring_host, last_state, last_state_at, notes',
            { count: 'exact' },
          )
          .is('deleted_at', null)
          .order('contract_number', { nullsFirst: false })
          // `contract_number` é nulável: sem desempate, dois links sem contrato
          // trocam de lugar entre páginas.
          .order('id'),
        escopo,
      ),
      pagina,
    ).returns<InternetLink[]>(),
    porFilial(
      supabase
        .from('vw_connectivity_cost')
        .select(
          'branch_id, branch_name, lines_active, telecom_monthly_cost, links_active, internet_monthly_cost, total_monthly_cost',
        )
        .order('total_monthly_cost', { ascending: false }),
      escopo,
    ).returns<ConnectivityCostRow[]>(),
    getBranches(),
    supabase
      .from('branch_areas')
      .select('id, branch_id, name')
      .eq('is_active', true)
      .order('sort_order')
      .returns<AreaOption[]>(),
    supabase
      .from('suppliers')
      .select('id, name')
      .is('deleted_at', null)
      .order('name')
      .returns<SupplierOption[]>(),
    /* Os indicadores vêm da VIEW (migração 0028), não da lista paginada —
       `lista.filter(...).length` contaria 50 links num parque de 300. Ela é a
       `vw_internet_dashboard`, que existia desde a 0013 e nunca tinha tido
       leitor; a 0028 só lhe acrescentou `links_unknown`, que é o indicador de
       "não monitorado" que a tela mostra desde que ganhou interface. */
    porFilial(
      supabase
        .from('vw_internet_dashboard')
        .select(
          'branch_id, status, links_count, monthly_total, links_down, links_unknown, expiring_90d, expirados, without_contract',
        ),
      escopo,
    ).returns<ResumoDeLinks[]>(),
  ])

  const lista = links ?? []

  /*
   * Segunda rodada: anexos e eventos SÓ dos links desta página. Antes vinham os
   * anexos de todos os contratos e os 300 eventos mais recentes do tenant, para
   * alimentar gavetas que, numa página de 50 linhas, no máximo 50 pessoas
   * abririam.
   */
  const idsDaPagina = lista.map((k) => k.id)

  /*
   * A lista mostra DOIS fatos por link: "tem contrato anexado?" e "tem queda em
   * aberto?". Antes, para saber isso, a tela trazia todos os anexos e todos os
   * eventos de todos os links da página — porque o painel embutido precisava
   * deles. Com o painel na gaveta, basta perguntar pelos dois fatos, e cada
   * consulta devolve só a coluna `link_id`.
   */
  const [{ data: comContrato }, { data: comQueda }] = await Promise.all([
    idsDaPagina.length > 0
      ? supabase
          .from('internet_link_attachments')
          .select('link_id')
          .eq('kind', 'contract')
          .in('link_id', idsDaPagina)
      : { data: null },
    idsDaPagina.length > 0
      ? supabase
          .from('link_availability_events')
          .select('link_id')
          .eq('state', 'down')
          .is('ended_at', null)
          .in('link_id', idsDaPagina)
      : { data: null },
  ])
  const branchName = new Map(branches.map((b) => [b.id, b.name]))
  const areaName = new Map((areas ?? []).map((a) => [a.id, a.name]))
  const fornecedorName = new Map((fornecedores ?? []).map((f) => [f.id, f.name]))

  const temContrato = new Set((comContrato ?? []).map((a) => a.link_id))
  /* Queda em aberto AGORA, por link desta página: a coluna de estado mostra o
     último estado conhecido, e este conjunto é o que distingue "fora do ar há
     pouco" de "queda ainda aberta no registro". */
  const comQuedaAberta = new Set((comQueda ?? []).map((e) => e.link_id))

  /*
   * Indicadores a partir da view, somando as linhas agregadas. A regra de cada
   * um é a mesma de antes, agora escrita em SQL — inclusive `expiring_90d`, que
   * NÃO põe piso em `current_date`: contrato terminado há dois anos continua
   * contando como "vigência terminando nos próximos 90 dias". Essa regra é da
   * tela, não minha, e mudá-la mudaria um número que alguém lê todo dia; está
   * registrada em docs/10 como decisão de produto pendente.
   */
  const agregado = resumo ?? []
  const somar = (campo: keyof ResumoDeLinks, status?: string) =>
    agregado
      .filter((r) => status === undefined || r.status === status)
      .reduce((s, r) => s + Number(r[campo] ?? 0), 0)

  const totalLinks = somar('links_count')
  const totalAtivos = somar('links_count', 'active')
  const foraDoAr = somar('links_down')
  const naoMonitorados = somar('links_unknown')
  const semContrato = somar('without_contract')
  const custoAtivo = somar('monthly_total', 'active')
  const vencendo = somar('expiring_90d')
  const expirados = somar('expirados')


  /** Operadora do link: fornecedor cadastrado tem precedência sobre o texto livre. */
  const operadora = (k: InternetLink) =>
    (k.supplier_id ? fornecedorName.get(k.supplier_id) : null) ?? k.carrier_name ?? '—'

  /* Quem alcança qualquer uma das quatro ações do link tem o número do
     contrato como link para a gaveta; quem só consulta lê o número. */
  const abrePainel = podeEditar || podeAnexar || podeRegistrar || podeMudarStatus

  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/conectividade/links', params, {
      ...mudancas,
      pagina: params.pagina ?? null,
    })

  const gavetaAberta = Boolean(params.aberto || params.novo || params.monitoramento)

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && (
        <GavetaDeLink
          id={params.aberto}
          novo={Boolean(params.novo)}
          monitoramento={Boolean(params.monitoramento)}
          fechar={endereco({ aberto: null, novo: null, monitoramento: null })}
        />
      )}

      <PageHeader
        title="Links de internet"
        description="Contrato, banda, IP, CPE e monitoração por filial. Link sem host monitorado aparece como não monitorado — nunca como fora do ar."
        action={
          <div className="flex flex-wrap gap-2">
            {podeMonitorar && (
              <Link
                href={endereco({ monitoramento: '1' }) as Route}
                data-testid="abrir-monitoramento"
                className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
              >
                Entrada de monitoramento
              </Link>
            )}
            {podeCriar && (
              <Link
                href={endereco({ novo: '1' }) as Route}
                data-testid="novo-registro"
                className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
              >
                Novo link
              </Link>
            )}
          </div>
        }
      />

      <FaixaDeIndicadores>
        <StatTile label="Links cadastrados" value={totalLinks} />
        <StatTile label="Ativos" value={totalAtivos} tone="ok" />
        <StatTile
          label="Fora do ar"
          value={foraDoAr}
          hint="agora"
          tone={foraDoAr > 0 ? 'breach' : 'ok'}
        />
        <StatTile label="Não monitorados" value={naoMonitorados} hint="sem host cadastrado" />
        <StatTile label="Custo mensal ativo" value={formatCurrency(custoAtivo)} />
        <StatTile
          label="Sem contrato anexado"
          value={semContrato}
          hint="governança documental"
          tone={semContrato > 0 ? 'warn' : 'ok'}
        />
      </FaixaDeIndicadores>

      {vencendo > 0 && (
        <p className="mb-6 rounded-lg bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn-ink)]">
          {vencendo} contrato(s) com vigência terminando nos próximos 90 dias
          {expirados > 0 && ` — ${expirados} já expirada(s)`}.
        </p>
      )}

      <div>
        <div className="flex flex-col gap-6">
          {lista.length > 0 ? (
            <>
            <Table
              label="Links de internet"
              head={[
                'Contrato',
                'Operadora',
                'Tecnologia',
                'Banda',
                'Filial / área',
                'Situação',
                'Monitoração',
                'Contrato anexo',
                'Custo',
              ]}
            >
              {lista.map((k) => (
                  <tr key={k.id} className="hover:bg-[var(--color-surface-2)]">
                    <Td className="font-mono text-xs font-medium">
                      {abrePainel ? (
                        <Link
                          href={endereco({ aberto: k.id }) as Route}
                          data-testid="abrir-registro"
                          className="text-[var(--color-brand-ink)] hover:underline"
                        >
                          {k.contract_number ?? 'sem número'}
                        </Link>
                      ) : (
                        (k.contract_number ?? '—')
                      )}
                    </Td>
                    <Td className="font-medium text-[var(--color-ink)]">{operadora(k)}</Td>
                    <Td className="text-[var(--color-ink-2)]">
                      {linkTechnologyLabel[k.technology] ?? k.technology}
                    </Td>
                    <Td className="tabular-nums text-[var(--color-ink-2)]">
                      {k.download_mbps
                        ? `${k.download_mbps}/${k.upload_mbps ?? '—'} Mbps`
                        : '—'}
                      {k.guaranteed_mbps !== null && (
                        <p className="text-xs text-[var(--color-ink-3)]">
                          garantida {k.guaranteed_mbps} Mbps
                        </p>
                      )}
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">
                      {branchName.get(k.branch_id) ?? '—'}
                      <p className="text-xs text-[var(--color-ink-3)]">
                        {k.branch_area_id ? (areaName.get(k.branch_area_id) ?? '—') : 'sem área'}
                      </p>
                    </Td>
                    <Td>
                      <Badge tone={contractStatusTone[k.status] ?? 'neutral'}>
                        {linkStatusLabel[k.status] ?? k.status}
                      </Badge>
                    </Td>
                    <Td>
                      <Badge
                        tone={
                          comQuedaAberta.has(k.id)
                            ? 'breach'
                            : (linkStateTone[k.last_state] ?? 'neutral')
                        }
                      >
                        {comQuedaAberta.has(k.id)
                          ? 'queda em aberto'
                          : (linkStateLabel[k.last_state] ?? k.last_state)}
                      </Badge>
                    </Td>
                    <Td>
                      {temContrato.has(k.id) ? (
                        <Badge tone="ok">anexado</Badge>
                      ) : (
                        <Badge tone="crit">faltando</Badge>
                      )}
                    </Td>
                    <Td className="tabular-nums">{formatCurrency(k.monthly_cost)}</Td>
                  </tr>

              ))}
            </Table>
            <Pager
              pagina={pagina.numero}
              total={count ?? 0}
              tamanho={pagina.tamanho}
              base="/conectividade/links"
              params={params}
            />
            </>
          ) : (
            <EmptyState
              title="Nenhum link cadastrado"
              description="Links das filiais que o seu acesso alcança apareceriam aqui."
            />
          )}

          <section>
            <h2 className="mb-3 text-lg font-semibold text-[var(--color-ink)]">
              Custo de conectividade por filial
            </h2>
            {custos && custos.length > 0 ? (
              <Table
                label="Custo de conectividade por filial"
                head={['Filial', 'Linhas', 'Telefonia', 'Links', 'Internet', 'Total mensal']}
              >
                {custos.map((c) => (
                  <tr key={c.branch_id}>
                    <Td className="font-medium text-[var(--color-ink)]">{c.branch_name}</Td>
                    <Td className="tabular-nums">{c.lines_active}</Td>
                    <Td className="tabular-nums">{formatCurrency(Number(c.telecom_monthly_cost))}</Td>
                    <Td className="tabular-nums">{c.links_active}</Td>
                    <Td className="tabular-nums">
                      {formatCurrency(Number(c.internet_monthly_cost))}
                    </Td>
                    <Td className="tabular-nums font-semibold">
                      {formatCurrency(Number(c.total_monthly_cost))}
                    </Td>
                  </tr>
                ))}
              </Table>
            ) : (
              <EmptyState title="Sem dados de custo" />
            )}
          </section>
        </div>

      </div>
    </div>
  )
}
