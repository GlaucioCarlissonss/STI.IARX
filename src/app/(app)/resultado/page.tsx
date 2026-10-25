import { Fragment } from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { competenciaAtual, paraExibicao, somarMeses } from '@/lib/projetos/competencia'
import { emReais, ROTULO_DA_CLASSIFICACAO, ROTULO_DA_ORIGEM } from '@/lib/orcamento/rateio'
import {
  conferir,
  escreverVariacao,
  tomDaConformidade,
  tomDaVariacao,
  variacao,
} from '@/lib/gestao/conferencia'
import { Badge, Card, EmptyState, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { SerieDoResultado, type PontoDaSerie } from './serie'

export const metadata: Metadata = { title: 'Visão de resultado' }

interface Resultado {
  gasto_mes: number
  gasto_mes_anterior: number
  gasto_despesa: number
  gasto_investimento: number
  gasto_compartilhado: number
  compromisso_12m: number
  projetos_total: number
  projetos_em_andamento: number
  projetos_atrasados: number
  projetos_entregues_no_prazo: number
  projetos_entregues: number
  sla_tickets: number
  sla_com_acordo: number
  sla_fora: number
  sla_conformidade: number | null
  competencia_fechada: boolean
}

interface GastoPorFilial {
  branch_id: string | null
  branch_name: string
  total: number
}

interface ProjetoAtrasado {
  id: string
  name: string
  branch_name: string | null
  planned_end_month: string
  meses_atraso: number
  status: string
}

interface SlaPorFila {
  queue_name: string
  tickets_total: number
  tickets_with_sla: number
  resolution_breaches: number
}

interface LancamentoAberto {
  id: string
  amount: number
  description: string | null
  category_name: string
  supplier_name: string | null
  natureza: string
  classificacao: string
  origem: string
}

interface ChamadoAberto {
  id: string
  ticket_number: number
  title: string
  status: string
  sla_coverage: string | null
  resolution_breached: boolean | null
  resolution_state: string | null
}

/**
 * A visão de resultado: financeiro, SLA e projetos numa tela só.
 *
 * ## Por que ela existe
 *
 * É a tela que o GSTI.IARX chama de Painel Executivo, e a razão de os três
 * módulos existirem juntos lá: **o gestor de TI não acompanha custo, prazo e
 * entrega em três lugares — ele responde por um resultado.**
 *
 * Ela também fecha uma dívida registrada quando o módulo de SLA do GSTI foi
 * recusado (migração 0037): o que faltava aqui não era a tabela de agregados, era
 * a leitura mensal consolidada. Esta é a leitura, e ela é relatório mesmo —
 * nenhuma tabela nova, nenhum número digitado.
 *
 * ## O recorte entra uma vez e vale para os três
 *
 * Cliente e competência vão para `gestao_resultado()`, que monta os três
 * indicadores no banco. Com três consultas montadas aqui, um filtro que diverge
 * entre elas produziria uma tela em que os números não conversam — e ninguém
 * perceberia, porque cada um parece certo sozinho.
 *
 * ## E a tela confere a si mesma
 *
 * O contrato de leitura do painel do GSTI é "a soma do detalhe conferida contra
 * o indicador na própria tela". Um indicador que não bate com o próprio
 * detalhamento é o defeito mais caro de um painel: os dois números parecem
 * certos sozinhos, e a divergência aparece quando o cliente compara, numa
 * reunião. A conferência não impede o erro — faz ele aparecer para quem está
 * olhando.
 */
export default async function ResultadoPage({
  searchParams,
}: {
  searchParams: Promise<{ cliente?: string; competencia?: string; abrir?: string }>
}) {
  const params = await searchParams
  await requireScreen('gestao.resultado.ver')

  /* Cada bloco é governado pela permissão do módulo de ORIGEM. Sem ela, o bloco
     não aparece e a tela diz que está oculto por permissão — mostrar zero seria
     lido como "não há gasto", que é outra coisa. */
  const podeFinanceiro = await allowed('financeiro.orcamento.ver')
  const podeProjetos = await allowed('projetos.projetos.ver')
  const podeSla = await allowed('sla.compliance.ver')

  const supabase = await createClient()
  const { data: clientes } = await supabase
    .from('clients')
    .select('id, trade_name, legal_name')
    .is('deleted_at', null)
    .order('legal_name')
    .returns<{ id: string; trade_name: string | null; legal_name: string }[]>()

  const lista = clientes ?? []
  const clienteId = params.cliente ?? lista[0]?.id ?? null
  const competencia = params.competencia
    ? params.competencia.length === 7
      ? `${params.competencia}-01`
      : params.competencia
    : competenciaAtual()

  if (!clienteId) {
    return (
      <>
        <PageHeader
          title="Visão de resultado"
          description="Custo, prazo e entrega da TI numa tela só."
        />
        <EmptyState
          title="Nenhum cliente cadastrado"
          description="A visão de resultado é sempre de um cliente. Cadastre um em Clientes e filiais."
        />
      </>
    )
  }

  /*
   * O que está aberto, lido da URL.
   *
   * O detalhe aberto é ESTADO DE NAVEGAÇÃO, e não estado de componente: fica na
   * URL, volta com o botão "voltar", sobrevive a um recarregamento e pode ser
   * mandado por mensagem para outra pessoa — que abre a tela no mesmo lugar, com
   * o mesmo recorte. Um `useState` daria o mesmo acordeão e perderia as quatro
   * coisas, e a terceira é a que importa numa reunião.
   */
  const [tipoAberto, chaveAberta] = (params.abrir ?? '').split(':')
  const filialAberta = tipoAberto === 'filial' ? (chaveAberta ?? '') : null
  const filaAberta = tipoAberto === 'fila' ? decodeURIComponent(chaveAberta ?? '') : null

  const [resultadoRes, filialRes, atrasadosRes, filaRes, serieRes] = await Promise.all([
    supabase
      .rpc('gestao_resultado', { p_client_id: clienteId, p_competence: competencia })
      .maybeSingle<Resultado>(),
    podeFinanceiro
      ? supabase.rpc('gestao_gasto_por_filial', {
          p_client_id: clienteId,
          p_competence: competencia,
        })
      : null,
    /* O filtro do atraso vai no servidor, não aqui: `atrasado` é coluna da view
       (derivada do mês corrente contra o fim planejado). Recortar em JS sobre
       uma página de resultados faria o detalhamento cobrir menos projetos que o
       indicador — e a conferência acusaria uma divergência que não existe. */
    podeProjetos
      ? supabase
          .from('vw_projects')
          .select('id, name, branch_name, planned_end_month, meses_atraso, status')
          .eq('client_id', clienteId)
          .eq('atrasado', true)
          .order('planned_end_month')
          .returns<ProjetoAtrasado[]>()
      : null,
    podeSla
      ? supabase
          .from('vw_sla_compliance')
          .select('queue_name, tickets_total, tickets_with_sla, resolution_breaches')
          .eq('client_id', clienteId)
          .gte('period', competencia)
          .lt('period', somarMeses(competencia, 1))
          .returns<SlaPorFila[]>()
      : null,
    supabase.rpc('gestao_serie', {
      p_client_id: clienteId,
      p_competence: competencia,
      p_meses: 12,
    }),
  ])

  /*
   * Os registros por trás do número, com o MESMO recorte que o produziu.
   *
   * Buscados só quando há algo aberto — a tela fechada não paga por eles. E
   * buscados aqui, no servidor, pelo mesmo cliente e pela mesma competência:
   * se o filtro divergisse, a conferência logo abaixo da lista acusaria.
   */
  const [lancamentosRes, chamadosRes] = await Promise.all([
    filialAberta && podeFinanceiro
      ? (() => {
          const q = supabase
            .from('vw_it_cost_entries')
            .select(
              'id, amount, description, category_name, supplier_name, natureza, classificacao, origem',
            )
            .eq('client_id', clienteId)
            .eq('competence', competencia)
            .eq('scenario_key', 'oficial')
            .order('amount', { ascending: false })
          /* "grupo" é a linha sem filial. `is('branch_id', null)` e
             `eq('branch_id', ...)` não são a mesma consulta, e tratar as duas
             como uma faria a linha do grupo abrir os lançamentos de todo mundo. */
          return (
            filialAberta === 'grupo' ? q.is('branch_id', null) : q.eq('branch_id', filialAberta)
          ).returns<LancamentoAberto[]>()
        })()
      : null,
    filaAberta && podeSla
      ? supabase
          .from('vw_tickets_enriched')
          .select(
            'id, ticket_number, title, status, sla_coverage, resolution_breached, resolution_state',
          )
          .eq('client_id', clienteId)
          .eq('queue_name', filaAberta)
          .gte('created_at', competencia)
          .lt('created_at', somarMeses(competencia, 1))
          .order('ticket_number')
          .returns<ChamadoAberto[]>()
      : null,
  ])

  const lancamentosAbertos = lancamentosRes?.data ?? []
  const chamadosAbertos = chamadosRes?.data ?? []
  const serie = ((serieRes.data ?? []) as unknown as PontoDaSerie[]).map((p) => ({
    ...p,
    gasto: Number(p.gasto),
    conformidade: p.conformidade === null ? null : Number(p.conformidade),
  }))

  const r = resultadoRes.data
  const filiais = ((filialRes?.data ?? []) as unknown as GastoPorFilial[]).map((f) => ({
    ...f,
    total: Number(f.total),
  }))
  const projetosAtrasados = atrasadosRes?.data ?? []

  /* `vw_sla_compliance` agrupa por fila E por responsável, então o mesmo nome de
     fila volta uma vez por atendente. Somar aqui é o que torna a linha uma fila
     de verdade — e o que faz a soma do detalhe bater com o indicador. */
  const filas = Object.values(
    (filaRes?.data ?? []).reduce<Record<string, SlaPorFila>>((acc, f) => {
      const atual = acc[f.queue_name] ?? {
        queue_name: f.queue_name,
        tickets_total: 0,
        tickets_with_sla: 0,
        resolution_breaches: 0,
      }
      acc[f.queue_name] = {
        queue_name: f.queue_name,
        tickets_total: atual.tickets_total + Number(f.tickets_total),
        tickets_with_sla: atual.tickets_with_sla + Number(f.tickets_with_sla),
        resolution_breaches: atual.resolution_breaches + Number(f.resolution_breaches),
      }
      return acc
    }, {}),
  ).sort((a, b) => b.tickets_total - a.tickets_total)

  /* A conferência. O indicador vem da função; a soma, do detalhamento. */
  const conferenciaFinanceiro = conferir(Number(r?.gasto_mes ?? 0), filiais.map((f) => f.total))
  const conferenciaProjetos = conferir(
    Number(r?.projetos_atrasados ?? 0),
    projetosAtrasados.map(() => 1),
  )
  const conferenciaSla = conferir(
    Number(r?.sla_tickets ?? 0),
    filas.map((f) => Number(f.tickets_total)),
  )

  const variacaoDoGasto = variacao(Number(r?.gasto_mes ?? 0), Number(r?.gasto_mes_anterior ?? 0))

  /* Trocar de cliente ou de mês FECHA o detalhe aberto: ele é de um recorte, e
     carregá-lo para outro mostraria registros de um recorte sob o título de
     outro — o começo exato da desconfiança num painel. */
  const href = (p: Record<string, string>): Route => {
    const q = new URLSearchParams({ cliente: clienteId, competencia, ...p })
    return `/resultado?${q.toString()}` as Route
  }

  /** Clicar no que já está aberto fecha. Sem isso, não há como voltar. */
  const hrefAbrir = (chave: string): Route =>
    params.abrir === chave ? href({}) : href({ abrir: chave })

  /* Os chips cobrem o que o gráfico não cobre: a série termina no mês corrente,
     então sem eles não haveria como olhar uma competência futura — que é
     exatamente onde o compromisso já lançado aparece. */
  const ultimosMeses = Array.from({ length: 6 }, (_, i) => somarMeses(competencia, i - 4))

  return (
    <>
      <PageHeader
        title="Visão de resultado"
        description="Custo, prazo e entrega da TI numa tela só — com o mesmo recorte nos três."
      />

      <div className="mb-4">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
          Cliente
        </p>
        <div className="flex flex-wrap gap-1.5">
          {lista.map((c) => (
            <Link
              key={c.id}
              href={href({ cliente: c.id })}
              aria-current={c.id === clienteId ? 'page' : undefined}
              className={`rounded-full px-2.5 py-1 text-xs ${
                c.id === clienteId
                  ? 'bg-[var(--color-brand-soft)] font-semibold text-[var(--color-brand-ink)]'
                  : 'text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]'
              }`}
            >
              {c.trade_name ?? c.legal_name}
            </Link>
          ))}
        </div>
      </div>

      <div className="mb-6 flex flex-wrap gap-1.5" role="group" aria-label="Escolher a competência">
        {ultimosMeses.map((m) => (
          <Link
            key={m}
            href={href({ competencia: m })}
            aria-current={m === competencia ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 text-xs tabular-nums ${
              m === competencia
                ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
                : 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]'
            }`}
          >
            {paraExibicao(m)}
          </Link>
        ))}
      </div>

      {r?.competencia_fechada && (
        <div
          role="status"
          className="mb-6 rounded-lg border border-[var(--color-ok-ink)]/30 bg-[var(--color-ok-soft)] p-3 text-sm text-[var(--color-ok-ink)]"
        >
          <strong>Competência fechada.</strong> Estes números não mudam mais — é isso que faz um
          resultado divulgado continuar valendo.
        </div>
      )}

      {/* Os quatro indicadores. A ordem é a do GSTI: dinheiro primeiro, porque é
          o que o gestor presta contas; compromisso em seguida, porque é o número
          que surpreende; depois entrega e atendimento. */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label={`Gasto de TI em ${paraExibicao(competencia)}`}
          value={podeFinanceiro ? emReais(Number(r?.gasto_mes ?? 0)) : '—'}
          hint={
            podeFinanceiro
              ? escreverVariacao(variacaoDoGasto)
              : 'oculto: exige permissão do orçamento'
          }
          tone={podeFinanceiro ? tomDaVariacao(variacaoDoGasto) : 'neutral'}
        />
        <StatTile
          label="Compromisso — 12 meses"
          value={podeFinanceiro ? emReais(Number(r?.compromisso_12m ?? 0)) : '—'}
          hint={
            podeFinanceiro
              ? 'parcelas e recorrências já lançadas'
              : 'oculto: exige permissão do orçamento'
          }
        />
        <StatTile
          label="Projetos atrasados"
          value={podeProjetos ? Number(r?.projetos_atrasados ?? 0) : '—'}
          hint={
            podeProjetos
              ? `${r?.projetos_em_andamento ?? 0} em andamento · ${r?.projetos_total ?? 0} no total`
              : 'oculto: exige permissão de projetos'
          }
          tone={podeProjetos && Number(r?.projetos_atrasados ?? 0) > 0 ? 'breach' : 'ok'}
        />
        <StatTile
          label="Conformidade de SLA"
          value={
            !podeSla
              ? '—'
              : r?.sla_conformidade === null || r?.sla_conformidade === undefined
                ? '—'
                : `${Number(r.sla_conformidade).toFixed(1).replace('.', ',')}%`
          }
          hint={
            !podeSla
              ? 'oculto: exige permissão de SLA'
              : Number(r?.sla_com_acordo ?? 0) > 0
                ? `${r?.sla_tickets ?? 0} chamados · ${r?.sla_fora ?? 0} fora do prazo`
                : 'nenhum chamado com acordo nesta competência'
          }
          tone={podeSla ? tomDaConformidade(r?.sla_conformidade ?? null) : 'neutral'}
        />
      </div>

      {!podeFinanceiro && !podeProjetos && !podeSla && (
        <EmptyState
          title="Nada a mostrar com as suas permissões"
          description="Esta tela compila financeiro, projetos e SLA. Sem a permissão de nenhum dos três, não há o que compilar — peça acesso a quem administra o ambiente."
        />
      )}

      {(podeFinanceiro || podeProjetos || podeSla) && serie.length > 1 && (
        <Card title="Os três ao longo do tempo" className="mb-6">
          <SerieDoResultado pontos={serie} competenciaAtiva={competencia} href={href} />
        </Card>
      )}

      {podeFinanceiro && (
        <Card title="Gasto por filial" className="mb-6">
          {filiais.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-3)]">
              Nenhum lançamento em {paraExibicao(competencia)}.
            </p>
          ) : (
            <Table
              label="Gasto por filial"
              head={['Filial', 'Gasto', 'Participação', 'Lançamentos']}
            >
              {filiais.map((f) => {
                const chave = `filial:${f.branch_id ?? 'grupo'}`
                const aberta = params.abrir === chave
                return (
                  <Fragment key={f.branch_id ?? 'grupo'}>
                    <tr className={aberta ? 'bg-[var(--color-surface-2)]' : undefined}>
                      <Td>{f.branch_name}</Td>
                      <Td className="tabular-nums">{emReais(f.total)}</Td>
                      <Td className="tabular-nums text-[var(--color-ink-2)]">
                        {conferenciaFinanceiro.soma > 0
                          ? `${((f.total / conferenciaFinanceiro.soma) * 100).toFixed(1).replace('.', ',')}%`
                          : '—'}
                      </Td>
                      <Td>
                        <Link
                          href={hrefAbrir(chave)}
                          aria-expanded={aberta}
                          className="text-xs font-semibold text-[var(--color-brand-ink)] hover:underline"
                        >
                          {aberta ? 'fechar' : 'ver os lançamentos'}
                        </Link>
                      </Td>
                    </tr>
                    {aberta && (
                      <tr>
                        <Td colSpan={4} className="bg-[var(--color-surface-2)]">
                          <RegistrosDaFilial
                            filial={f.branch_name}
                            competencia={competencia}
                            total={f.total}
                            lancamentos={lancamentosAbertos}
                          />
                        </Td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </Table>
          )}
          <Conferencia
            rotulo="o gasto do mês"
            resultado={conferenciaFinanceiro}
            formatar={emReais}
          />
          <p className="mt-2 text-xs text-[var(--color-ink-3)]">
            Despesa {emReais(Number(r?.gasto_despesa ?? 0))} · investimento{' '}
            {emReais(Number(r?.gasto_investimento ?? 0))} · compartilhado{' '}
            {emReais(Number(r?.gasto_compartilhado ?? 0))}.{' '}
            <Link
              href={'/financeiro/orcamento' as Route}
              className="text-[var(--color-brand-ink)] hover:underline"
            >
              Abrir o orçamento
            </Link>
          </p>
        </Card>
      )}

      {podeProjetos && (
        <Card title="Projetos atrasados" className="mb-6">
          {projetosAtrasados.length === 0 ? (
            <p className="text-sm text-[var(--color-ok-ink)]">
              Nenhum projeto atrasado. Atraso é derivado do mês corrente contra o fim planejado —
              ninguém marca um projeto como atrasado.
            </p>
          ) : (
            <Table label="Projetos atrasados" head={['Projeto', 'Filial', 'Previsto', 'Atraso']}>
              {projetosAtrasados.map((p) => (
                <tr key={p.id}>
                  <Td>
                    <Link
                      href={`/projetos/${p.id}` as Route}
                      className="font-medium text-[var(--color-ink)] hover:underline"
                    >
                      {p.name}
                    </Link>
                  </Td>
                  <Td className="text-[var(--color-ink-2)]">{p.branch_name ?? 'do grupo'}</Td>
                  <Td className="tabular-nums text-[var(--color-ink-2)]">
                    {paraExibicao(p.planned_end_month)}
                  </Td>
                  <Td>
                    <Badge tone="breach">{p.meses_atraso} mês(es)</Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          <Conferencia
            rotulo="o número de projetos atrasados"
            resultado={conferenciaProjetos}
            formatar={(v) => `${v}`}
          />
          <p className="mt-2 text-xs text-[var(--color-ink-3)]">
            {r?.projetos_entregues ?? 0} entregue(s), {r?.projetos_entregues_no_prazo ?? 0} no
            prazo.{' '}
            <Link
              href={'/projetos' as Route}
              className="text-[var(--color-brand-ink)] hover:underline"
            >
              Abrir o cronograma
            </Link>
          </p>
        </Card>
      )}

      {podeSla && (
        <Card title="Atendimento por fila" className="mb-6">
          {filas.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-3)]">
              Nenhum chamado deste cliente em {paraExibicao(competencia)}.
            </p>
          ) : (
            <Table
              label="Conformidade por fila"
              head={[
                'Fila',
                'Chamados',
                'Com acordo',
                'Fora do prazo',
                'Conformidade',
                'Chamados',
              ]}
            >
              {filas.map((f) => {
                const pct =
                  f.tickets_with_sla > 0
                    ? ((f.tickets_with_sla - f.resolution_breaches) / f.tickets_with_sla) * 100
                    : null
                const chave = `fila:${encodeURIComponent(f.queue_name)}`
                const aberta = params.abrir === chave
                return (
                  <Fragment key={f.queue_name}>
                    <tr className={aberta ? 'bg-[var(--color-surface-2)]' : undefined}>
                      <Td>{f.queue_name}</Td>
                      <Td className="tabular-nums text-[var(--color-ink-2)]">{f.tickets_total}</Td>
                      <Td className="tabular-nums text-[var(--color-ink-2)]">
                        {f.tickets_with_sla}
                      </Td>
                      <Td className="tabular-nums text-[var(--color-ink-2)]">
                        {f.resolution_breaches}
                      </Td>
                      <Td>
                        {pct === null ? (
                          <span className="text-[var(--color-ink-3)]">—</span>
                        ) : (
                          <Badge tone={tomDaConformidade(pct)}>
                            {pct.toFixed(1).replace('.', ',')}%
                          </Badge>
                        )}
                      </Td>
                      <Td>
                        <Link
                          href={hrefAbrir(chave)}
                          aria-expanded={aberta}
                          className="text-xs font-semibold text-[var(--color-brand-ink)] hover:underline"
                        >
                          {aberta ? 'fechar' : 'ver os chamados'}
                        </Link>
                      </Td>
                    </tr>
                    {aberta && (
                      <tr>
                        <Td colSpan={6} className="bg-[var(--color-surface-2)]">
                          <RegistrosDaFila
                            fila={f.queue_name}
                            competencia={competencia}
                            total={f.tickets_total}
                            chamados={chamadosAbertos}
                          />
                        </Td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </Table>
          )}
          <Conferencia
            rotulo="o total de chamados"
            resultado={conferenciaSla}
            formatar={(v) => `${v}`}
          />
          {/* O eixo do SLA é outro, e a tela diz isso em vez de deixar supor. */}
          <p className="mt-2 text-xs text-[var(--color-ink-3)]">
            O SLA se abre por <strong>fila</strong>, e não por filial: é como{' '}
            <code className="font-mono">vw_sla_compliance</code> agrupa. Forçar o mesmo eixo dos
            outros dois afirmaria uma comparação que o dado não sustenta.{' '}
            <Link href={'/sla' as Route} className="text-[var(--color-brand-ink)] hover:underline">
              Abrir o compliance
            </Link>
          </p>
        </Card>
      )}

      <Card title="De onde vem cada número">
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-[var(--color-ink-2)]">
          <li>
            <strong>Os três têm o mesmo recorte.</strong> Cliente e competência entram uma vez e
            valem para financeiro, projetos e SLA — montados juntos no banco, não em três consultas
            que poderiam divergir.
          </li>
          <li>
            <strong>Nada aqui é digitado.</strong> O gasto vem do orçamento, o atraso é derivado do
            mês corrente contra o fim planejado, e a conformidade é contada chamado a chamado.
          </li>
          <li>
            <strong>A tela confere a si mesma.</strong> A soma de cada detalhamento é comparada
            com o indicador, e a divergência aparece aqui — não numa reunião.
          </li>
          <li>
            <strong>Conformidade sem chamado é travessão, não 100%.</strong> Ausência de medida não
            é desempenho perfeito.
          </li>
        </ul>
      </Card>
    </>
  )
}

/**
 * O resultado da conferência, na tela.
 *
 * Quando bate, uma linha discreta: a afirmação de que foi conferido vale mais
 * que o silêncio, porque é ela que dá crédito ao número quando alguém perguntar.
 * Quando não bate, um aviso — com a diferença, que é por onde se começa a
 * procurar.
 */
function Conferencia({
  rotulo,
  resultado,
  formatar,
}: {
  rotulo: string
  resultado: { bate: boolean; indicador: number; soma: number; diferenca: number }
  formatar: (v: number) => string
}) {
  if (resultado.bate) {
    return (
      <p className="mt-3 text-xs text-[var(--color-ink-3)]">
        Conferido: a soma do detalhamento fecha com {rotulo} ({formatar(resultado.indicador)}).
      </p>
    )
  }
  return (
    <p
      role="status"
      className="mt-3 rounded border border-[var(--color-breach-ink)]/30 bg-[var(--color-breach-soft)] p-2 text-xs text-[var(--color-breach-ink)]"
    >
      <strong>Divergência.</strong> O indicador diz {formatar(resultado.indicador)} e a soma do
      detalhamento dá {formatar(resultado.soma)} — diferença de{' '}
      {formatar(Math.abs(resultado.diferenca))}. Os dois foram montados por consultas diferentes, e
      alguma delas tem um filtro a mais.
    </p>
  )
}

/**
 * Os lançamentos por trás do gasto de uma filial.
 *
 * ## O que faz dele um "abrir o número" e não "uma lista parecida"
 *
 * O recorte. Mesmo cliente, mesma competência, mesmo cenário, mesma filial — e
 * a soma conferida contra a linha que foi clicada, aqui dentro. Uma lista que
 * não fecha com o número que a abriu é pior que nenhuma lista: ela parece
 * confirmar.
 */
function RegistrosDaFilial({
  filial,
  competencia,
  total,
  lancamentos,
}: {
  filial: string
  competencia: string
  total: number
  lancamentos: LancamentoAberto[]
}) {
  const conferencia = conferir(
    total,
    lancamentos.map((l) => Number(l.amount)),
  )

  if (lancamentos.length === 0) {
    return (
      <p className="text-xs text-[var(--color-ink-3)]">
        Nenhum lançamento de {filial} em {paraExibicao(competencia)} — e o indicador diz{' '}
        {emReais(total)}. Quando os dois discordam assim, o filtro de uma das consultas é mais
        estreito que o da outra.
      </p>
    )
  }

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
        {lancamentos.length} lançamento(s) de {filial} em {paraExibicao(competencia)}
      </p>
      <ul className="flex flex-col gap-1.5">
        {lancamentos.map((l) => (
          <li key={l.id} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span className="text-[var(--color-ink)]">
              {l.description ?? l.category_name}
              {l.supplier_name && (
                <span className="text-[var(--color-ink-3)]"> · {l.supplier_name}</span>
              )}
              <span className="text-[var(--color-ink-3)]">
                {' '}
                · {ROTULO_DA_CLASSIFICACAO[l.classificacao] ?? l.classificacao} ·{' '}
                {ROTULO_DA_ORIGEM[l.origem] ?? l.origem}
              </span>
            </span>
            <span className="tabular-nums font-medium">{emReais(Number(l.amount))}</span>
          </li>
        ))}
      </ul>
      <Conferencia rotulo="o gasto da filial" resultado={conferencia} formatar={emReais} />
    </div>
  )
}

/**
 * Os chamados por trás de uma fila.
 *
 * Aqui a conferência compara CONTAGEM, não dinheiro — e o número que ela usa é
 * `tickets_total`, o mesmo da coluna "Chamados" da linha clicada. Comparar
 * contra "com acordo" daria uma divergência garantida em toda fila que tenha um
 * chamado sem cobertura, e a tela estaria gritando sobre o próprio recorte.
 */
function RegistrosDaFila({
  fila,
  competencia,
  total,
  chamados,
}: {
  fila: string
  competencia: string
  total: number
  chamados: ChamadoAberto[]
}) {
  const conferencia = conferir(
    total,
    chamados.map(() => 1),
  )

  if (chamados.length === 0) {
    return (
      <p className="text-xs text-[var(--color-ink-3)]">
        Nenhum chamado de {fila} em {paraExibicao(competencia)} — e o indicador conta {total}.
      </p>
    )
  }

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
        {chamados.length} chamado(s) de {fila} em {paraExibicao(competencia)}
      </p>
      <ul className="flex flex-col gap-1.5">
        {chamados.map((c) => (
          <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <Link
              href={`/tickets/${c.id}` as Route}
              className="text-[var(--color-ink)] hover:underline"
            >
              <span className="tabular-nums text-[var(--color-ink-3)]">#{c.ticket_number}</span>{' '}
              {c.title}
            </Link>
            {c.sla_coverage !== 'covered' ? (
              /* Sem acordo não é "no prazo": é fora da medida. Mostrar um selo
                 verde aqui faria a fila parecer melhor do que foi medida. */
              <span className="text-xs text-[var(--color-ink-3)]">sem acordo</span>
            ) : (
              <Badge tone={c.resolution_breached ? 'breach' : 'ok'}>
                {c.resolution_breached ? 'fora do prazo' : 'no prazo'}
              </Badge>
            )}
          </li>
        ))}
      </ul>
      <Conferencia
        rotulo="os chamados da fila"
        resultado={conferencia}
        formatar={(v) => `${v}`}
      />
    </div>
  )
}
