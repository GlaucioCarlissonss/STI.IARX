'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { optionalUuid, uuid } from '@/lib/schemas/campos'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'
import { paraInterno } from '@/lib/projetos/competencia'

/**
 * Projetos, tarefas e envolvidos.
 *
 * ## A competência passa por uma porta só
 *
 * `paraInterno()` aceita `AAAA-MM` (o que o `<input type="month">` manda),
 * `MM/AAAA` (o que a planilha manda) e devolve `null` para qualquer outra coisa.
 * Um zod `.transform()` com ela em cada campo é o que impede uma data que o
 * banco leria de outro jeito — e o CHECK `app.eh_competencia` é a segunda trava,
 * no banco, para o que não passar por aqui.
 */

const competencia = z
  .string()
  .transform((v) => paraInterno(v))
  .refine((v): v is string => v !== null, 'Informe o mês no formato MM/AAAA.')

const competenciaOpcional = z
  .union([z.literal(''), z.string()])
  .transform((v) => (v === '' ? null : paraInterno(v)))
  .refine((v) => v !== undefined, 'Mês inválido.')

const projetoSchema = z
  .object({
    client_id: uuid,
    branch_id: optionalUuid,
    name: z.string().trim().min(2, 'Dê um nome ao projeto.').max(160),
    description: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .transform((v) => (v ? v : null)),
    start_month: competencia,
    planned_end_month: competencia,
    actual_end_month: competenciaOpcional,
    status: z.enum(['planejado', 'em_andamento', 'concluido', 'cancelado']),
  })
  .refine((d) => d.planned_end_month >= d.start_month, {
    message: 'O fim planejado não pode ser anterior ao início.',
    path: ['planned_end_month'],
  })
  .refine((d) => !d.actual_end_month || d.actual_end_month >= d.start_month, {
    message: 'O fim real não pode ser anterior ao início.',
    path: ['actual_end_month'],
  })
  /* Concluído sem fim real: o banco também recusa (`proj_concluido_tem_fim_real`),
     mas a mensagem dele fala de constraint. Esta diz o que fazer — e diz por quê,
     porque "concluído" sem data é um projeto que parece entregue e não tem
     desvio nenhum para medir. */
  .refine((d) => d.status !== 'concluido' || d.actual_end_month !== null, {
    message: 'Projeto concluído exige o mês de fim real — é ele que vira o desvio.',
    path: ['actual_end_month'],
  })

function dadosDoFormulario(formData: FormData) {
  return {
    client_id: formData.get('client_id'),
    branch_id: formData.get('branch_id'),
    name: formData.get('name'),
    description: formData.get('description') ?? '',
    start_month: formData.get('start_month'),
    planned_end_month: formData.get('planned_end_month'),
    actual_end_month: formData.get('actual_end_month') ?? '',
    status: formData.get('status') ?? 'planejado',
  }
}

export async function criarProjeto(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('projetos.projetos.criar', {
    mensagem: 'Sem permissão para criar projeto.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = projetoSchema.safeParse(dadosDoFormulario(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('projects')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id, created_by: profile.id })
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/projetos')
  return { success: 'Projeto criado. Cadastre as tarefas para o cronograma aparecer.' }
}

export async function editarProjeto(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('projetos.projetos.editar', {
    mensagem: 'Sem permissão para editar projeto.',
  })
  if ('error' in gate) return gate

  const parsed = projetoSchema.safeParse(dadosDoFormulario(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const id = z.object({ id: uuid }).safeParse({ id: formData.get('id') })
  if (!id.success) return { error: 'Projeto inválido.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('projects')
    .update(parsed.data)
    .eq('id', id.data.id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/projetos', 'layout')
  return { success: 'Projeto atualizado.' }
}

export async function excluirProjeto(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('projetos.projetos.excluir', {
    mensagem: 'Sem permissão para excluir projeto.',
  })
  if ('error' in gate) return gate

  const parsed = z.object({ id: uuid }).safeParse({ id: formData.get('id') })
  if (!parsed.success) return { error: 'Projeto inválido.' }

  const supabase = await createClient()
  /* Exclusão lógica, como todo cadastro desta base: o projeto sai da tela e o
     histórico de auditoria continua apontando para uma linha que existe. */
  const { data, error } = await supabase
    .from('projects')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/projetos', 'layout')
  return { success: 'Projeto excluído. As tarefas dele saem junto da listagem.' }
}

/* ------------------------------------------------------------------ Tarefas */

const tarefaSchema = z
  .object({
    project_id: uuid,
    name: z.string().trim().min(2, 'Dê um nome à tarefa.').max(160),
    start_month: competencia,
    planned_end_month: competencia,
    actual_end_month: competenciaOpcional,
    assignee: z
      .string()
      .trim()
      .max(160)
      .optional()
      .transform((v) => (v ? v : null)),
    status: z.enum(['pendente', 'em_andamento', 'concluida', 'cancelada']),
    parent_task_id: optionalUuid,
  })
  .refine((d) => d.planned_end_month >= d.start_month, {
    message: 'O fim planejado da tarefa não pode ser anterior ao início.',
    path: ['planned_end_month'],
  })

export async function criarTarefa(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('projetos.projetos.editar', {
    mensagem: 'Sem permissão para cadastrar tarefa.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = tarefaSchema.safeParse({
    project_id: formData.get('project_id'),
    name: formData.get('name'),
    start_month: formData.get('start_month'),
    planned_end_month: formData.get('planned_end_month'),
    actual_end_month: formData.get('actual_end_month') ?? '',
    assignee: formData.get('assignee') ?? '',
    status: formData.get('status') ?? 'pendente',
    parent_task_id: formData.get('parent_task_id'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('project_tasks')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })
    .select('id')

  /* A trigger `trg_task_hierarquia` recusa ciclo, projeto diferente e quarto
     nível com `check_violation`, e a mensagem dela já está em português e já diz
     o motivo — repassar é melhor que traduzir de novo e divergir. */
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath(`/projetos/${parsed.data.project_id}`)
  return { success: 'Tarefa cadastrada.' }
}

export async function editarTarefa(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('projetos.projetos.editar', {
    mensagem: 'Sem permissão para editar tarefa.',
  })
  if ('error' in gate) return gate

  const parsed = tarefaSchema.extend({ id: uuid }).safeParse({
    id: formData.get('id'),
    project_id: formData.get('project_id'),
    name: formData.get('name'),
    start_month: formData.get('start_month'),
    planned_end_month: formData.get('planned_end_month'),
    actual_end_month: formData.get('actual_end_month') ?? '',
    assignee: formData.get('assignee') ?? '',
    status: formData.get('status') ?? 'pendente',
    parent_task_id: formData.get('parent_task_id'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const { id, ...valores } = parsed.data
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('project_tasks')
    .update(valores)
    .eq('id', id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath(`/projetos/${valores.project_id}`)
  return { success: 'Tarefa atualizada.' }
}

const andamentoSchema = z.object({
  id: uuid,
  project_id: uuid,
  status: z.enum(['pendente', 'em_andamento', 'concluida', 'cancelada']),
  actual_end_month: competenciaOpcional,
})

/**
 * Atualiza só o andamento — a ação de quem EXECUTA a tarefa.
 *
 * Separada de `editarTarefa` porque a permissão é outra
 * (`projetos.projetos.executar`, teto `atendente`): quem faz a tarefa diz que
 * terminou sem precisar poder mexer em prazo, hierarquia ou nome. Exigir papel
 * de gestor para registrar uma entrega faria o cronograma envelhecer no gargalo
 * de quem o administra.
 */
export async function atualizarAndamento(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('projetos.projetos.executar', {
    mensagem: 'Sem permissão para atualizar o andamento.',
  })
  if ('error' in gate) return gate

  const parsed = andamentoSchema.safeParse({
    id: formData.get('id'),
    project_id: formData.get('project_id'),
    status: formData.get('status'),
    actual_end_month: formData.get('actual_end_month') ?? '',
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const { id, project_id, ...valores } = parsed.data

  /* Concluída sem mês de entrega não vira desvio nenhum: o cronograma mostraria
     a barra planejada sem a realizada, e o indicador de entrega no prazo não
     contaria a tarefa. Dizer isso é melhor que gravar e deixar o número errado. */
  if (valores.status === 'concluida' && !valores.actual_end_month) {
    return { error: 'Tarefa concluída precisa do mês de entrega — é ele que vira o desvio.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('project_tasks')
    .update(valores)
    .eq('id', id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath(`/projetos/${project_id}`)
  return { success: 'Andamento atualizado.' }
}

export async function excluirTarefa(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('projetos.projetos.editar', {
    mensagem: 'Sem permissão para excluir tarefa.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({ id: uuid, project_id: uuid })
    .safeParse({ id: formData.get('id'), project_id: formData.get('project_id') })
  if (!parsed.success) return { error: 'Tarefa inválida.' }

  const supabase = await createClient()

  /*
   * Excluir tarefa principal é BLOQUEADO, não cascateado.
   *
   * Em cascata, uma confirmação de "excluir 1 tarefa" apagaria a subárvore
   * inteira em silêncio — e a mensagem lista as subtarefas para a pessoa saber
   * o que desagrupar primeiro. A chave estrangeira `on delete restrict` é a
   * mesma regra no banco, para o caminho que não passar por aqui.
   */
  const { data: filhas } = await supabase
    .from('project_tasks')
    .select('name')
    .eq('parent_task_id', parsed.data.id)
    .is('deleted_at', null)
    .returns<{ name: string }[]>()

  if (filhas && filhas.length > 0) {
    return {
      error: `Esta tarefa tem ${filhas.length} subtarefa(s) — ${filhas
        .map((f) => `"${f.name}"`)
        .join(', ')}. Exclua ou desagrupe as subtarefas primeiro.`,
    }
  }

  const { data, error } = await supabase
    .from('project_tasks')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath(`/projetos/${parsed.data.project_id}`)
  return { success: 'Tarefa excluída.' }
}

/* --------------------------------------------------------------- Envolvidos */

export async function adicionarEnvolvido(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('projetos.projetos.editar', {
    mensagem: 'Sem permissão para alterar os envolvidos.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      project_id: uuid,
      name: z.string().trim().min(2, 'Informe o nome.').max(160),
      role_in_project: z
        .string()
        .trim()
        .max(120)
        .optional()
        .transform((v) => (v ? v : null)),
      profile_id: optionalUuid,
    })
    .safeParse({
      project_id: formData.get('project_id'),
      name: formData.get('name'),
      role_in_project: formData.get('role_in_project') ?? '',
      profile_id: formData.get('profile_id'),
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('project_members')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })
    .select('id')

  if (error) {
    if (error.code === '23505') return { error: 'Essa pessoa já está no projeto.' }
    return { error: mensagemDeErro(error) }
  }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath(`/projetos/${parsed.data.project_id}`)
  return { success: 'Envolvido acrescentado.' }
}

export async function removerEnvolvido(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('projetos.projetos.editar', {
    mensagem: 'Sem permissão para alterar os envolvidos.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({ id: uuid, project_id: uuid })
    .safeParse({ id: formData.get('id'), project_id: formData.get('project_id') })
  if (!parsed.success) return { error: 'Envolvido inválido.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('project_members')
    .delete()
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath(`/projetos/${parsed.data.project_id}`)
  return { success: 'Envolvido removido.' }
}
