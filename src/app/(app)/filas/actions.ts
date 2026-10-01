'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession, canManageRecords, requirePermission } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'
import { queueRuleSchema, queueSchema, recordId } from '@/lib/schemas/cadastros'

/**
 * Regras de roteamento automático.
 *
 * Até a migração 0024 esta tabela era lida por ninguém: existia desde a 0004,
 * semeada e auditada, e o motor que a 0004 prometeu (`fn_route_ticket`) nunca
 * tinha sido escrito. O editor sem o motor teria sido uma tela que configura o
 * nada; o motor sem o editor, uma regra que só muda por SQL. Vieram juntos.
 *
 * As três ações usam uma única chave — `helpdesk.filas.configurar_regras` —
 * porque criar, editar e inativar regra são a mesma decisão.
 */
const NOT_AFFECTED = 'Não foi possível salvar: registro não encontrado ou sem permissão.'

export async function createQueueRule(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('helpdesk.filas.configurar_regras')
  if ('error' in gate) return gate
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = queueRuleSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('queue_rules')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) return { error: error.message }

  revalidatePath('/filas')
  return { success: 'Regra cadastrada. Ela passa a valer para os próximos tickets.' }
}

export async function updateQueueRule(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('helpdesk.filas.configurar_regras')
  if ('error' in gate) return gate
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const parsed = queueRuleSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('queue_rules')
    .update(parsed.data)
    .eq('id', id.data)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/filas')
  return { success: 'Regra atualizada.' }
}

/**
 * Liga e desliga a regra sem apagá-la.
 *
 * Não há exclusão: a regra aparece no `audit_log` e no histórico de por que um
 * ticket foi parar numa fila. Apagar tiraria a explicação junto com a regra —
 * e roteamento sem explicação é a reclamação mais comum de quem atende.
 */
export async function setQueueRuleActive(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('helpdesk.filas.configurar_regras')
  if ('error' in gate) return gate
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = z
    .object({ id: recordId, is_active: z.enum(['true', 'false']) })
    .safeParse({ id: formData.get('id'), is_active: formData.get('is_active') })
  if (!parsed.success) return { error: 'Situação inválida.' }

  const isActive = parsed.data.is_active === 'true'

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('queue_rules')
    .update({ is_active: isActive })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/filas')
  return { success: isActive ? 'Regra reativada.' : 'Regra desativada.' }
}

/* --- As filas em si ------------------------------------------------------- */

/**
 * A fila padrão do sistema é intocável, e isso é decidido no BANCO.
 *
 * `trg_protect_default_queue` (0004) recusa renomear, trocar o identificador,
 * desativar ou remover a fila padrão, "para que nenhuma rota administrativa
 * consiga burlar". As ações abaixo não repetem essa regra — elas traduzem o erro
 * que a trigger levanta. Reimplementar a checagem aqui criaria uma segunda
 * verdade, e seria a daqui que ficaria para trás.
 */
function erroDeFila(error: { code?: string; message: string }): string {
  if (error.code === '23505') return 'Já existe uma fila com este identificador.'
  // `restrict_violation` é o código que a trigger usa para as quatro proteções.
  if (error.code === '2BP01' || /fila padrão/i.test(error.message)) return error.message
  return error.message
}

export async function createQueue(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('helpdesk.filas.criar')
  if ('error' in gate) return gate
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = queueSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('queues')
    // `is_system_default` NÃO vem do formulário: já existe um índice parcial
    // único garantindo uma padrão por tenant, e deixar a tela escolher quem é a
    // padrão seria oferecer um botão que o banco recusa.
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) return { error: erroDeFila(error) }

  revalidatePath('/filas')
  return { success: 'Fila criada.' }
}

export async function updateQueue(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('helpdesk.filas.editar')
  if ('error' in gate) return gate
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const parsed = queueSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('queues')
    .update(parsed.data)
    .eq('id', id.data)
    .select('id')

  if (error) return { error: erroDeFila(error) }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/filas')
  return { success: 'Fila atualizada.' }
}

export async function setQueueActive(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('helpdesk.filas.inativar')
  if ('error' in gate) return gate
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = z
    .object({ id: recordId, is_active: z.enum(['true', 'false']) })
    .safeParse({ id: formData.get('id'), is_active: formData.get('is_active') })
  if (!parsed.success) return { error: 'Situação inválida.' }

  const isActive = parsed.data.is_active === 'true'

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('queues')
    .update({ is_active: isActive })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: erroDeFila(error) }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/filas')
  return {
    success: isActive
      ? 'Fila reativada.'
      : 'Fila inativada. Os tickets que já estão nela continuam onde estão.',
  }
}
