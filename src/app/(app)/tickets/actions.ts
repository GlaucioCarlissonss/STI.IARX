'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession } from '@/lib/session'

/**
 * Server Actions de ticket — o ÚNICO caminho de escrita a partir da UI (ADR-011).
 *
 * Todas usam o cliente de sessão, nunca `service_role`: se o RLS negar, a
 * escrita falha, e é assim que deve ser. E todas carimbam
 * `change_source = 'ui'`, que é o sinal usado pela sincronização reversa para
 * distinguir uma mudança nossa de um eco da integração (ADR-008).
 */

export interface ActionState {
  error?: string
  success?: string
}

const uuid = z.string().uuid()
const optionalUuid = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .pipe(z.union([uuid, z.null()]))

const createTicketSchema = z.object({
  title: z.string().trim().min(4, 'O título precisa ter ao menos 4 caracteres.').max(200),
  description: z.string().trim().max(20000).optional(),
  priority_id: uuid,
  category_id: optionalUuid,
  queue_id: optionalUuid,
  branch_id: optionalUuid,
  assignee_id: optionalUuid,
})

export async function createTicket(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()

  const parsed = createTicketSchema.safeParse({
    title: formData.get('title'),
    description: formData.get('description') ?? undefined,
    priority_id: formData.get('priority_id'),
    category_id: formData.get('category_id'),
    queue_id: formData.get('queue_id'),
    branch_id: formData.get('branch_id'),
    assignee_id: formData.get('assignee_id'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('tickets')
    .insert({
      tenant_id: profile.tenant_id,
      title: parsed.data.title,
      description: parsed.data.description || null,
      priority_id: parsed.data.priority_id,
      category_id: parsed.data.category_id,
      // queue_id nulo é resolvido pela trigger, que aplica a fila padrão.
      queue_id: parsed.data.queue_id,
      branch_id: parsed.data.branch_id,
      assignee_id: parsed.data.assignee_id,
      requester_id: profile.id,
      source: 'ui',
      change_source: 'ui',
    })
    .select('id')
    .single()

  if (error) return { error: `Não foi possível abrir o ticket: ${error.message}` }

  revalidatePath('/tickets')
  revalidatePath('/painel')
  redirect(`/tickets/${data.id}`)
}

const statusSchema = z.object({
  ticket_id: uuid,
  status: z.enum([
    'open',
    'triage',
    'assigned',
    'in_progress',
    'waiting_requester',
    'waiting_third_party',
    'resolved',
    'closed',
  ]),
})

export async function changeStatus(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession()

  const parsed = statusSchema.safeParse({
    ticket_id: formData.get('ticket_id'),
    status: formData.get('status'),
  })
  if (!parsed.success) return { error: 'Status inválido.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('tickets')
    .update({ status: parsed.data.status, change_source: 'ui' })
    .eq('id', parsed.data.ticket_id)

  if (error) {
    // A máquina de estados vive no banco (ADR-007); a mensagem de violação já
    // explica o que foi tentado, então repassamos em vez de mascarar.
    return { error: error.message }
  }

  revalidatePath(`/tickets/${parsed.data.ticket_id}`)
  revalidatePath('/tickets')
  revalidatePath('/painel')
  return { success: 'Status atualizado.' }
}

const assignSchema = z.object({
  ticket_id: uuid,
  assignee_id: optionalUuid,
})

export async function assignTicket(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession()

  const parsed = assignSchema.safeParse({
    ticket_id: formData.get('ticket_id'),
    assignee_id: formData.get('assignee_id'),
  })
  if (!parsed.success) return { error: 'Atendente inválido.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('tickets')
    .update({ assignee_id: parsed.data.assignee_id, change_source: 'ui' })
    .eq('id', parsed.data.ticket_id)

  if (error) return { error: error.message }

  revalidatePath(`/tickets/${parsed.data.ticket_id}`)
  return { success: parsed.data.assignee_id ? 'Ticket atribuído.' : 'Atribuição removida.' }
}

const transferSchema = z.object({
  ticket_id: uuid,
  queue_id: uuid,
  reason: z.string().trim().min(3, 'Descreva o motivo da transferência.'),
})

/** Transferência entre filas com motivo obrigatório (RF-FIL-05). */
export async function transferQueue(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()

  const parsed = transferSchema.safeParse({
    ticket_id: formData.get('ticket_id'),
    queue_id: formData.get('queue_id'),
    reason: formData.get('reason'),
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('tickets')
    .update({ queue_id: parsed.data.queue_id, change_source: 'ui' })
    .eq('id', parsed.data.ticket_id)

  if (error) return { error: error.message }

  // A trigger de histórico registra a troca de fila, mas não conhece o motivo —
  // ele é intenção do usuário, então entra como um registro próprio.
  await supabase.from('ticket_history').insert({
    tenant_id: profile.tenant_id,
    ticket_id: parsed.data.ticket_id,
    actor_id: profile.id,
    field: 'queue_transfer_reason',
    new_value: parsed.data.reason,
    change_source: 'ui',
    reason: parsed.data.reason,
  })

  revalidatePath(`/tickets/${parsed.data.ticket_id}`)
  revalidatePath('/filas')
  return { success: 'Ticket transferido.' }
}

const commentSchema = z.object({
  ticket_id: uuid,
  body: z.string().trim().min(1, 'Escreva um comentário.').max(20000),
  visibility: z.enum(['public', 'internal']),
})

export async function addComment(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()

  const parsed = commentSchema.safeParse({
    ticket_id: formData.get('ticket_id'),
    body: formData.get('body'),
    visibility: formData.get('visibility') ?? 'public',
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('ticket_comments').insert({
    tenant_id: profile.tenant_id,
    ticket_id: parsed.data.ticket_id,
    author_id: profile.id,
    body: parsed.data.body,
    visibility: parsed.data.visibility,
    source: 'ui',
  })

  if (error) return { error: error.message }

  revalidatePath(`/tickets/${parsed.data.ticket_id}`)
  return { success: 'Comentário publicado.' }
}
