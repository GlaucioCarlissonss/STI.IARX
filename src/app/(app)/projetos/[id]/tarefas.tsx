'use client'

import { useActionState, useState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { Badge, Card, ErrorNote, Field, inputClass } from '@/components/ui'
import { paraExibicao } from '@/lib/projetos/competencia'
import type { LinhaDoCronograma } from '@/lib/projetos/cronograma'
import { atualizarAndamento, criarTarefa, excluirTarefa } from '../actions'

const ROTULO_DO_STATUS: Record<string, string> = {
  pendente: 'Pendente',
  em_andamento: 'Em andamento',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
}

/** Até onde a hierarquia vai. Igual ao `app.profundidade_maxima_de_tarefa()`. */
const PROFUNDIDADE_MAXIMA = 3

/**
 * As tarefas do projeto.
 *
 * ## A tarefa principal se ESCOLHE, nunca se digita
 *
 * É um defeito relatado no GSTI original e vale repetir a correção: com um campo
 * de texto livre, errar um acento devolvia *"não existe uma tarefa X"* para uma
 * tarefa que existe. E num projeto ainda sem tarefa nenhuma o campo continuava
 * pedindo um nome que não havia como fornecer.
 *
 * Aqui o seletor traz as tarefas existentes **indentadas pelo nível**, porque a
 * indentação é o que diz se a escolha vai criar um segundo ou um terceiro nível
 * — informação que uma lista plana de nomes não dá. E ele só oferece quem ainda
 * cabe um nível abaixo: oferecer as demais seria oferecer um erro.
 */
export function TarefasDoProjeto({
  projectId,
  tarefas,
  podeEditar,
  podeExecutar,
}: {
  projectId: string
  tarefas: LinhaDoCronograma[]
  podeEditar: boolean
  podeExecutar: boolean
}) {
  const [criacao, criarAction] = useActionState(criarTarefa, {})
  const [andamento, andamentoAction] = useActionState(atualizarAndamento, {})
  const [exclusao, excluirAction] = useActionState(excluirTarefa, {})
  const [emEdicao, setEmEdicao] = useState<string | null>(null)

  /* Só quem ainda cabe um nível abaixo. Uma tarefa de nível 3 não pode receber
     filha, e oferecê-la produziria um erro que a trigger recusa — com razão, e
     depois de a pessoa ter preenchido o formulário inteiro. */
  const possiveisPais = tarefas.filter((t) => t.nivel < PROFUNDIDADE_MAXIMA)

  return (
    <Card title={`Tarefas (${tarefas.length})`}>
      {tarefas.length === 0 ? (
        <p className="text-sm text-[var(--color-ink-3)]">Nenhuma tarefa cadastrada.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--color-border)]">
          {tarefas.map((t) => (
            <li key={t.id} className="py-2.5">
              <div
                className="flex flex-wrap items-center gap-2"
                style={{ paddingLeft: `${(t.nivel - 1) * 1.25}rem` }}
              >
                <span
                  className={`text-sm ${
                    t.atrasado ? 'text-[var(--color-breach-ink)]' : 'text-[var(--color-ink)]'
                  }`}
                >
                  {t.name}
                </span>
                <Badge
                  tone={
                    t.status === 'concluida'
                      ? 'ok'
                      : t.status === 'cancelada'
                        ? 'neutral'
                        : t.atrasado
                          ? 'breach'
                          : 'info'
                  }
                >
                  {ROTULO_DO_STATUS[t.status] ?? t.status}
                </Badge>
                <span className="text-xs text-[var(--color-ink-3)]">
                  {paraExibicao(t.start_month)} → {paraExibicao(t.planned_end_month)}
                  {t.actual_end_month && ` · entregue ${paraExibicao(t.actual_end_month)}`}
                  {t.assignee && ` · ${t.assignee}`}
                </span>
                {t.atrasado && (
                  <span className="text-xs text-[var(--color-breach-ink)]">
                    {t.meses_atraso} mês(es) de atraso
                  </span>
                )}

                {(podeExecutar || podeEditar) && (
                  <button
                    type="button"
                    onClick={() => setEmEdicao(emEdicao === t.id ? null : t.id)}
                    aria-expanded={emEdicao === t.id}
                    className="text-xs text-[var(--color-brand-ink)] hover:underline"
                  >
                    {emEdicao === t.id ? 'fechar' : 'andamento'}
                  </button>
                )}
                {podeEditar && (
                  <form action={excluirAction} className="inline">
                    <input type="hidden" name="id" value={t.id} />
                    <input type="hidden" name="project_id" value={projectId} />
                    <button
                      type="submit"
                      aria-label={`Excluir a tarefa ${t.name}`}
                      className="text-[var(--color-ink-3)] hover:text-[var(--color-breach-ink)]"
                    >
                      ×
                    </button>
                  </form>
                )}
              </div>

              {emEdicao === t.id && (podeExecutar || podeEditar) && (
                <form
                  action={andamentoAction}
                  className="mt-2 flex flex-wrap items-end gap-2"
                  style={{ paddingLeft: `${(t.nivel - 1) * 1.25}rem` }}
                >
                  <input type="hidden" name="id" value={t.id} />
                  <input type="hidden" name="project_id" value={projectId} />
                  <Field label="Situação" htmlFor={`st-${t.id}`}>
                    <select
                      id={`st-${t.id}`}
                      name="status"
                      defaultValue={t.status}
                      className={inputClass}
                    >
                      {Object.entries(ROTULO_DO_STATUS).map(([v, r]) => (
                        <option key={v} value={v}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label="Mês de entrega"
                    htmlFor={`fim-${t.id}`}
                    hint="Obrigatório ao concluir — é ele que vira o desvio."
                  >
                    <input
                      id={`fim-${t.id}`}
                      name="actual_end_month"
                      type="month"
                      defaultValue={t.actual_end_month?.slice(0, 7) ?? ''}
                      className={inputClass}
                    />
                  </Field>
                  <SubmitButton pendingLabel="Salvando…" variant="secondary">
                    Salvar andamento
                  </SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {andamento.error && <ErrorNote>{andamento.error}</ErrorNote>}
      {andamento.success && (
        <p role="status" className="mt-2 text-sm text-[var(--color-ok-ink)]">
          {andamento.success}
        </p>
      )}
      {exclusao.error && <ErrorNote>{exclusao.error}</ErrorNote>}

      {podeEditar && (
        <div className="mt-5 border-t border-[var(--color-border)] pt-4">
          <h3 className="mb-3 text-sm font-semibold text-[var(--color-ink)]">Nova tarefa</h3>
          <form action={criarAction} className="flex flex-col gap-3">
            <input type="hidden" name="project_id" value={projectId} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nome" htmlFor="t-name" required>
                <input
                  id="t-name"
                  name="name"
                  required
                  minLength={2}
                  maxLength={160}
                  className={inputClass}
                  placeholder="Levantar o inventário atual"
                />
              </Field>
              <Field label="Responsável" htmlFor="t-assignee" hint="Texto livre: pode ser fornecedor.">
                <input id="t-assignee" name="assignee" maxLength={160} className={inputClass} />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Início" htmlFor="t-inicio" required>
                <input id="t-inicio" name="start_month" type="month" required className={inputClass} />
              </Field>
              <Field label="Fim planejado" htmlFor="t-fim" required>
                <input
                  id="t-fim"
                  name="planned_end_month"
                  type="month"
                  required
                  className={inputClass}
                />
              </Field>
              <Field
                label="Tarefa principal"
                htmlFor="t-pai"
                hint={
                  possiveisPais.length === 0
                    ? 'Sem tarefa que ainda aceite subtarefa: esta fica no primeiro nível.'
                    : 'A indentação mostra em que nível a subtarefa vai cair.'
                }
              >
                <select
                  id="t-pai"
                  name="parent_task_id"
                  defaultValue=""
                  disabled={possiveisPais.length === 0}
                  className={inputClass}
                >
                  <option value="">nenhuma (primeiro nível)</option>
                  {possiveisPais.map((t) => (
                    <option key={t.id} value={t.id}>
                      {'  '.repeat(t.nivel - 1)}
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {criacao.error && <ErrorNote>{criacao.error}</ErrorNote>}
            {criacao.success && (
              <p role="status" className="text-sm text-[var(--color-ok-ink)]">
                {criacao.success}
              </p>
            )}

            <SubmitButton pendingLabel="Cadastrando…">Cadastrar tarefa</SubmitButton>
          </form>
          <p className="mt-2 text-xs text-[var(--color-ink-3)]">
            A hierarquia vai até {PROFUNDIDADE_MAXIMA} níveis (principal → subtarefa → subtarefa) —
            é o que o cronograma ainda mostra sem virar indentação ilegível. O banco recusa ciclo e
            o quarto nível por trigger, não por convenção da tela.
          </p>
        </div>
      )}
    </Card>
  )
}
