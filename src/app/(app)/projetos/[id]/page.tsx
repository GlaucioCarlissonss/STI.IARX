import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { paraExibicao } from '@/lib/projetos/competencia'
import { emOrdemDeLeitura, type TarefaDoCronograma } from '@/lib/projetos/cronograma'
import { Badge, Card, PageHeader, StatTile } from '@/components/ui'
import { Gantt } from './gantt'
import { TarefasDoProjeto } from './tarefas'
import { EnvolvidosDoProjeto, type Envolvido } from './envolvidos'
import { ExcluirProjeto } from './excluir'
import { ROTULO_DO_STATUS, type LinhaDeProjeto } from '../page'

export const metadata: Metadata = { title: 'Projeto' }

/**
 * Um projeto: cronograma, tarefas e envolvidos.
 *
 * ## A ordem da tela
 *
 * O cronograma vem primeiro porque é a pergunta que traz alguém aqui — "como
 * está o projeto?" se responde olhando as barras, não lendo uma tabela. A lista
 * de tarefas vem depois, para editar; os envolvidos por último, porque quase
 * nunca mudam.
 */
export default async function ProjetoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireScreen('projetos.projetos.ver')
  const podeEditar = await allowed('projetos.projetos.editar')
  const podeExecutar = await allowed('projetos.projetos.executar')
  const podeExcluir = await allowed('projetos.projetos.excluir')

  const supabase = await createClient()
  const { data: projeto } = await supabase
    .from('vw_projects')
    .select('*')
    .eq('id', id)
    .maybeSingle<LinhaDeProjeto>()

  if (!projeto) notFound()

  const [{ data: tarefas }, { data: envolvidos }] = await Promise.all([
    supabase
      .from('vw_project_tasks')
      .select(
        'id, parent_task_id, name, start_month, planned_end_month, actual_end_month, assignee, status, meses_atraso, desvio_meses, atrasado, total_subtarefas',
      )
      .eq('project_id', id)
      .returns<(TarefaDoCronograma & { total_subtarefas: number })[]>(),
    supabase
      .from('project_members')
      .select('id, name, role_in_project')
      .eq('project_id', id)
      .order('name')
      .returns<Envolvido[]>(),
  ])

  const lista = tarefas ?? []
  const emOrdem = emOrdemDeLeitura(lista)
  const atrasadas = lista.filter((t) => t.atrasado).length
  const entregues = lista.filter((t) => t.actual_end_month !== null)
  /* Entregue no prazo = fim real menor ou igual ao planejado. O denominador é só
     o que foi ENTREGUE: tarefa concluída sem data de entrega não entra, porque
     ela não tem como ser medida contra o prazo. */
  const noPrazo = entregues.filter((t) => t.desvio_meses <= 0).length

  return (
    <>
      <PageHeader
        title={projeto.name}
        description={
          [projeto.client_name, projeto.branch_name].filter(Boolean).join(' · ') || 'Sem cliente'
        }
        action={
          <Link
            href={'/projetos' as Route}
            className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
          >
            Voltar
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge
          tone={
            projeto.status === 'concluido'
              ? 'ok'
              : projeto.status === 'cancelado'
                ? 'neutral'
                : projeto.atrasado
                  ? 'breach'
                  : 'info'
          }
        >
          {ROTULO_DO_STATUS[projeto.status] ?? projeto.status}
        </Badge>
        <span className="text-sm text-[var(--color-ink-2)]">
          {paraExibicao(projeto.start_month)} → {paraExibicao(projeto.planned_end_month)}
          {projeto.actual_end_month && ` · entregue ${paraExibicao(projeto.actual_end_month)}`}
        </span>
        {projeto.atrasado && (
          <Badge tone="breach">{projeto.meses_atraso} mês(es) de atraso</Badge>
        )}
        {projeto.actual_end_month && projeto.desvio_meses !== 0 && (
          <Badge tone={projeto.desvio_meses > 0 ? 'warn' : 'ok'}>
            {projeto.desvio_meses > 0
              ? `${projeto.desvio_meses} mês(es) depois do planejado`
              : `${Math.abs(projeto.desvio_meses)} mês(es) adiantado`}
          </Badge>
        )}
      </div>

      {projeto.description && (
        <Card className="mb-6">
          <p className="whitespace-pre-wrap text-sm text-[var(--color-ink)]">
            {projeto.description}
          </p>
        </Card>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Tarefas" value={lista.length} />
        <StatTile label="Entregues" value={entregues.length} />
        <StatTile
          label="Atrasadas"
          value={atrasadas}
          hint="passaram do prazo sem entrega"
          tone={atrasadas > 0 ? 'breach' : 'ok'}
        />
        <StatTile
          label="Entregues no prazo"
          value={
            entregues.length > 0 ? `${Math.round((noPrazo / entregues.length) * 100)}%` : '—'
          }
          hint={entregues.length > 0 ? `${noPrazo} de ${entregues.length}` : 'nada entregue ainda'}
          tone="neutral"
        />
      </div>

      <Card title="Cronograma" className="mb-6">
        <Gantt tarefas={lista} />
      </Card>

      <TarefasDoProjeto
        projectId={id}
        tarefas={emOrdem}
        podeEditar={podeEditar}
        podeExecutar={podeExecutar}
      />

      <EnvolvidosDoProjeto
        projectId={id}
        envolvidos={envolvidos ?? []}
        podeEditar={podeEditar}
        className="mt-6"
      />

      {podeExcluir && (
        <Card title="Excluir projeto" className="mt-6">
          <p className="mb-3 text-sm text-[var(--color-ink-2)]">
            A exclusão é lógica: o projeto sai da listagem e o histórico de auditoria continua
            apontando para uma linha que existe. As tarefas saem junto.
          </p>
          <ExcluirProjeto id={id} />
        </Card>
      )}
    </>
  )
}
