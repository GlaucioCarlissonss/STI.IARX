import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { lerPagina, paginar } from '@/lib/data/paginacao'
import { paraExibicao } from '@/lib/projetos/competencia'
import { Badge, Card, EmptyState, PageHeader, Pager, StatTile, Table, Td } from '@/components/ui'
import { ProjetoForm } from './projeto-form'

export const metadata: Metadata = { title: 'Projetos' }

export interface LinhaDeProjeto {
  id: string
  client_id: string
  branch_id: string | null
  name: string
  description: string | null
  start_month: string
  planned_end_month: string
  actual_end_month: string | null
  status: string
  client_name: string | null
  branch_name: string | null
  duracao_planejada_meses: number
  meses_atraso: number
  desvio_meses: number
  atrasado: boolean
  total_tarefas: number
  tarefas_entregues: number
  tarefas_atrasadas: number
}

export const ROTULO_DO_STATUS: Record<string, string> = {
  planejado: 'Planejado',
  em_andamento: 'Em andamento',
  concluido: 'Concluído',
  cancelado: 'Cancelado',
}

/**
 * Projetos de TI.
 *
 * ## De onde este módulo veio
 *
 * Do GSTI.IARX, o SaaS de gestão para gestores de TI. Dos três módulos daquele
 * sistema, este é o único que esta base não tinha de forma nenhuma — e por isso
 * é o único que veio inteiro. O financeiro entra lendo o que já existe
 * (`payables` já guarda título com parcelamento), e o módulo de SLA **não entra**:
 * ele existe lá porque aquele sistema não tem helpdesk, e aqui o SLA é calculado
 * de chamado em chamado.
 *
 * ## O indicador que importa é "atrasados"
 *
 * Atraso é derivado, nunca digitado: existe quando o mês corrente passou do fim
 * planejado sem fim real registrado. Ninguém marca um projeto como atrasado — e
 * é por isso que o número é confiável. Com fim real, o atraso vira **desvio**,
 * que pode ser negativo quando a entrega veio adiantada.
 */
export default async function ProjetosPage({
  searchParams,
}: {
  searchParams: Promise<{ pagina?: string; filtro?: string }>
}) {
  const params = await searchParams
  await requireScreen('projetos.projetos.ver')
  const podeCriar = await allowed('projetos.projetos.criar')

  const supabase = await createClient()
  const pagina = lerPagina(params.pagina)
  const FILTROS = ['atrasados', 'em_andamento', 'concluidos'] as const
  type Filtro = (typeof FILTROS)[number]
  const filtro = FILTROS.includes(params.filtro as Filtro) ? (params.filtro as Filtro) : null

  let consulta = supabase.from('vw_projects').select('*', { count: 'exact' })
  if (filtro === 'em_andamento') consulta = consulta.eq('status', 'em_andamento')
  if (filtro === 'concluidos') consulta = consulta.eq('status', 'concluido')
  /* "Atrasados" não dá para filtrar no banco: `atrasado` é derivado de `now()` na
     view, e o PostgREST não filtra coluna calculada por expressão. O recorte é
     feito sobre o universo, logo abaixo. */

  const [{ data: linhas, count }, { data: universo }, { data: clientes }, { data: filiais }] =
    await Promise.all([
      paginar(consulta.order('planned_end_month'), pagina).returns<LinhaDeProjeto[]>(),
      /* Os indicadores leem o acervo inteiro, e não a página — mesma lição da
         entrega 6. Quatro colunas. */
      supabase
        .from('vw_projects')
        .select('status, atrasado, meses_atraso, desvio_meses')
        .returns<{ status: string; atrasado: boolean; meses_atraso: number; desvio_meses: number }[]>(),
      podeCriar
        ? supabase
            .from('clients')
            .select('id, trade_name, legal_name')
            .is('deleted_at', null)
            .order('legal_name')
            .returns<{ id: string; trade_name: string | null; legal_name: string }[]>()
        : Promise.resolve({ data: [] }),
      podeCriar
        ? supabase
            .from('branches')
            .select('id, name, client_id')
            .is('deleted_at', null)
            .order('name')
            .returns<{ id: string; name: string; client_id: string }[]>()
        : Promise.resolve({ data: [] }),
    ])

  const todos = universo ?? []
  const atrasados = todos.filter((p) => p.atrasado).length
  const emAndamento = todos.filter((p) => p.status === 'em_andamento').length
  const concluidos = todos.filter((p) => p.status === 'concluido')
  /* Desvio médio só dos entregues: incluir os que ainda correm misturaria
     "atrasou 2 meses" com "entregou 1 mês adiantado" e o número não diria nada. */
  const desvioMedio =
    concluidos.length > 0
      ? concluidos.reduce((s, p) => s + p.desvio_meses, 0) / concluidos.length
      : null

  const lista = (linhas ?? []).filter((p) => (filtro === 'atrasados' ? p.atrasado : true))

  const filtroHref = (valor: Filtro | null): Route =>
    (valor ? `/projetos?filtro=${valor}` : '/projetos') as Route

  return (
    <>
      <PageHeader
        title="Projetos"
        description="Cronograma mensal de TI. Atraso e desvio são calculados, nunca digitados."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Projetos" value={todos.length} />
        <StatTile label="Em andamento" value={emAndamento} />
        {/* O que importa: ninguém marca um projeto como atrasado, então o número
            não depende de alguém lembrar de atualizar. */}
        <StatTile
          label="Atrasados"
          value={atrasados}
          hint="passaram do fim planejado sem entrega"
          tone={atrasados > 0 ? 'breach' : 'ok'}
        />
        <StatTile
          label="Desvio médio"
          value={
            desvioMedio === null
              ? '—'
              : `${desvioMedio > 0 ? '+' : ''}${desvioMedio.toFixed(1).replace('.', ',')} mês`
          }
          hint={concluidos.length > 0 ? `nos ${concluidos.length} entregues` : 'nada entregue ainda'}
          tone={desvioMedio !== null && desvioMedio > 0 ? 'warn' : 'ok'}
        />
      </div>

      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filtrar projetos">
        {(
          [
            [null, 'Todos'],
            ['em_andamento', 'Em andamento'],
            ['atrasados', 'Atrasados'],
            ['concluidos', 'Concluídos'],
          ] as const
        ).map(([valor, rotulo]) => (
          <Link
            key={rotulo}
            href={filtroHref(valor)}
            aria-current={filtro === valor ? 'page' : undefined}
            className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
              filtro === valor
                ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
                : 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]'
            }`}
          >
            {rotulo}
          </Link>
        ))}
      </div>

      {lista.length === 0 ? (
        <EmptyState
          title={filtro ? 'Nada com esse filtro' : 'Nenhum projeto cadastrado'}
          description={
            filtro === 'atrasados'
              ? 'Esse é o estado bom. Volte a "Todos" para ver tudo.'
              : filtro
                ? 'Volte a "Todos" para ver tudo.'
                : 'Um projeto tem nome, mês de início e fim planejado. O cronograma aparece quando houver tarefas.'
          }
        />
      ) : (
        <>
          <Table
            label="Projetos"
            head={['Projeto', 'Cliente', 'Cronograma', 'Tarefas', 'Situação']}
          >
            {lista.map((p) => (
              <tr key={p.id}>
                <Td>
                  <Link
                    href={`/projetos/${p.id}` as Route}
                    className="font-medium text-[var(--color-ink)] hover:underline"
                  >
                    {p.name}
                  </Link>
                  {p.branch_name && (
                    <p className="text-xs text-[var(--color-ink-3)]">{p.branch_name}</p>
                  )}
                </Td>
                <Td className="text-[var(--color-ink-2)]">{p.client_name ?? '—'}</Td>
                <Td className="whitespace-nowrap text-[var(--color-ink-2)]">
                  {paraExibicao(p.start_month)} → {paraExibicao(p.planned_end_month)}
                  <p className="text-xs text-[var(--color-ink-3)]">
                    {p.duracao_planejada_meses} mês(es)
                    {p.actual_end_month && ` · entregue ${paraExibicao(p.actual_end_month)}`}
                  </p>
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {p.total_tarefas === 0 ? (
                    <span className="text-[var(--color-ink-3)]">nenhuma</span>
                  ) : (
                    <>
                      {p.tarefas_entregues} de {p.total_tarefas}
                      {p.tarefas_atrasadas > 0 && (
                        <p className="text-xs text-[var(--color-warn-ink)]">
                          {p.tarefas_atrasadas} atrasada(s)
                        </p>
                      )}
                    </>
                  )}
                </Td>
                <Td>
                  <Badge
                    tone={
                      p.status === 'concluido'
                        ? 'ok'
                        : p.status === 'cancelado'
                          ? 'neutral'
                          : p.atrasado
                            ? 'breach'
                            : 'info'
                    }
                  >
                    {ROTULO_DO_STATUS[p.status] ?? p.status}
                  </Badge>
                  {p.atrasado && (
                    <p className="mt-1 text-xs text-[var(--color-breach-ink)]">
                      {p.meses_atraso} mês(es) de atraso
                    </p>
                  )}
                  {p.actual_end_month && p.desvio_meses !== 0 && (
                    <p className="mt-1 text-xs text-[var(--color-ink-3)]">
                      {p.desvio_meses > 0
                        ? `${p.desvio_meses} mês(es) depois do planejado`
                        : `${Math.abs(p.desvio_meses)} mês(es) adiantado`}
                    </p>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
          <Pager
            pagina={pagina.numero}
            total={count ?? 0}
            tamanho={pagina.tamanho}
            base="/projetos"
            params={params}
          />
        </>
      )}

      {podeCriar && (
        <ProjetoForm
          className="mt-6"
          clientes={(clientes ?? []).map((c) => ({
            id: c.id,
            nome: c.trade_name ?? c.legal_name,
          }))}
          filiais={filiais ?? []}
        />
      )}

      <Card title="Como o atraso é calculado" className="mt-6">
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-[var(--color-ink-2)]">
          <li>
            <strong>Atraso é derivado, nunca digitado.</strong> Existe quando o mês corrente passou
            do fim planejado e não há fim real registrado. Ninguém marca um projeto como atrasado —
            e por isso o número não depende de alguém lembrar de atualizá-lo.
          </li>
          <li>
            Registrado o fim real, o atraso <strong>vira desvio</strong>: a diferença em meses
            entre o planejado e o entregue, que pode ser negativa quando a entrega veio adiantada.
          </li>
          <li>
            <strong>Cancelado não acusa atraso.</strong> Um projeto que a empresa decidiu não fazer
            não é um prazo perdido.
          </li>
          <li>
            Projeto concluído exige o mês de fim real — sem ele, &ldquo;concluído&rdquo; seria um
            rótulo sem desvio nenhum para medir.
          </li>
        </ul>
      </Card>
    </>
  )
}
