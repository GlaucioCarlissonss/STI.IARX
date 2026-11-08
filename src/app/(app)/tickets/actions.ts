'use server'

import { revalidatePath } from 'next/cache'
import { mensagemDeErro } from '@/lib/actions/erros'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { optionalUuid, uuid } from '@/lib/schemas/campos'
import { createClient } from '@/lib/supabase/server'
import { requireSession, requirePermission } from '@/lib/session'
import type { ActionState } from '@/lib/actions/estado'

/**
 * Server Actions de ticket — o ÚNICO caminho de escrita a partir da UI (ADR-011).
 *
 * Todas usam o cliente de sessão, nunca `service_role`: se o RLS negar, a
 * escrita falha, e é assim que deve ser. E todas carimbam
 * `change_source = 'ui'`, que é o sinal usado pela sincronização reversa para
 * distinguir uma mudança nossa de um eco da integração (ADR-008).
 */

const createTicketSchema = z.object({
  title: z
    .string()
    .trim()
    .min(4, 'O título precisa ter ao menos 4 caracteres.')
    .max(200, 'O título pode ter no máximo 200 caracteres.'),
  description: z.string().trim().max(20000, 'A descrição pode ter no máximo 20.000 caracteres.').optional(),
  priority_id: uuid,
  category_id: optionalUuid,
  queue_id: optionalUuid,
  branch_id: optionalUuid,
  assignee_id: optionalUuid,
})

export async function createTicket(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('helpdesk.tickets.criar')
  if ('error' in gate) return gate

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

  if (error) return { error: mensagemDeErro(error) }

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
  const gate = await requirePermission('helpdesk.tickets.mudar_status')
  if ('error' in gate) return gate

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
    return { error: mensagemDeErro(error) }
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
  const gate = await requirePermission('helpdesk.tickets.atribuir')
  if ('error' in gate) return gate

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

  if (error) return { error: mensagemDeErro(error) }

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
  const gate = await requirePermission('helpdesk.tickets.transferir')
  if ('error' in gate) return gate

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

  if (error) return { error: mensagemDeErro(error) }

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

/* --- Ações em massa ------------------------------------------------------ */

const TETO_DO_LOTE = 50

const loteSchema = z.object({
  ids: z.array(uuid).min(1, 'Selecione ao menos um chamado.').max(TETO_DO_LOTE),
  acao: z.enum(['atribuir', 'status', 'fila']),
  valor: z.string(),
  motivo: z.string().trim().optional(),
})

/**
 * Atribuir, mudar status ou mover de fila vários chamados de uma vez.
 *
 * ## Por que uma linha de cada vez, e não um `update … in (…)`
 *
 * Porque a máquina de estados vive no banco (ADR-007) e é uma trigger: num
 * `update` único, UM chamado numa transição proibida derruba a instrução
 * inteira, e os outros quarenta e nove — perfeitamente válidos — não mudam.
 * Pior: a pessoa recebe uma mensagem sobre um chamado que ela talvez nem
 * lembre de ter marcado, e não tem como saber o que aconteceu com o resto.
 *
 * Com uma escrita por chamado, o que podia ser feito é feito, e o retorno diz
 * exatamente quantos ficaram de fora. É mais viagem ao banco; é a diferença
 * entre uma ação em massa que funciona e uma que falha por tudo ou nada.
 *
 * ## A permissão é conferida por AÇÃO
 *
 * Não existe uma permissão "mexer em lote": atribuir em lote exige a mesma
 * chave que atribuir um, e mudar status em lote exige a de mudar status. O
 * lote é uma conveniência da tela, não um atalho por fora do controle de
 * acesso — e o RLS continua sendo quem recorta o tenant, em cada uma das
 * escritas.
 */
export async function acaoEmLote(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()

  const parsed = loteSchema.safeParse({
    ids: formData.getAll('id').map(String),
    acao: formData.get('acao'),
    valor: String(formData.get('valor') ?? ''),
    motivo: formData.get('motivo') ?? undefined,
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Seleção inválida.' }
  }

  const { ids, acao, valor, motivo } = parsed.data

  const permissao = {
    atribuir: 'helpdesk.tickets.atribuir',
    status: 'helpdesk.tickets.mudar_status',
    fila: 'helpdesk.tickets.transferir',
  }[acao]
  const gate = await requirePermission(permissao)
  if ('error' in gate) return gate

  let campos: Record<string, string | null>
  if (acao === 'atribuir') {
    // Valor vazio é intenção legítima: tirar o atendente de tudo que está
    // marcado é como se devolve um lote para a fila.
    if (valor && !uuid.safeParse(valor).success) return { error: 'Atendente inválido.' }
    campos = { assignee_id: valor || null }
  } else if (acao === 'status') {
    const estado = statusSchema.shape.status.safeParse(valor)
    if (!estado.success) return { error: 'Status inválido.' }
    campos = { status: estado.data }
  } else {
    if (!uuid.safeParse(valor).success) return { error: 'Fila inválida.' }
    // RF-FIL-05: transferência exige motivo. Em lote a regra é a mesma — um
    // motivo em branco para quarenta chamados é exatamente o histórico que
    // ninguém consegue reconstituir seis meses depois.
    if (!motivo || motivo.length < 3) return { error: 'Descreva o motivo da transferência.' }
    campos = { queue_id: valor }
  }

  const supabase = await createClient()

  const resultados = await Promise.all(
    ids.map(async (id) => {
      const { data, error } = await supabase
        .from('tickets')
        .update({ ...campos, change_source: 'ui' })
        .eq('id', id)
        .select('id')
      // Sem erro e sem linha é RLS negando em silêncio: conta como recusado.
      return !error && (data?.length ?? 0) > 0
    }),
  )

  const feitos = resultados.filter(Boolean).length
  const recusados = ids.length - feitos

  if (feitos === 0) {
    return { error: 'Nenhum chamado pôde ser alterado. Verifique a transição e a permissão.' }
  }

  if (acao === 'fila' && motivo) {
    await supabase.from('ticket_history').insert(
      ids.map((id) => ({
        tenant_id: profile.tenant_id,
        ticket_id: id,
        actor_id: profile.id,
        field: 'queue_transfer_reason',
        new_value: motivo,
        change_source: 'ui',
        reason: motivo,
      })),
    )
  }

  revalidatePath('/tickets')
  revalidatePath('/filas')
  revalidatePath('/painel')

  const plural = feitos === 1 ? 'chamado atualizado' : 'chamados atualizados'
  return {
    success: recusados
      ? `${feitos} ${plural}; ${recusados} recusado(s) pela transição ou pela permissão.`
      : `${feitos} ${plural}.`,
  }
}

const commentSchema = z.object({
  ticket_id: uuid,
  body: z
    .string()
    .trim()
    .min(1, 'Escreva um comentário.')
    .max(20000, 'O comentário pode ter no máximo 20.000 caracteres.'),
  visibility: z.enum(['public', 'internal']),
})

export async function addComment(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('helpdesk.tickets.comentar')
  if ('error' in gate) return gate

  const parsed = commentSchema.safeParse({
    ticket_id: formData.get('ticket_id'),
    body: formData.get('body'),
    visibility: formData.get('visibility') ?? 'public',
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  // Comentário interno é uma permissão à parte, checada aqui e não no gate de
  // cima: a visibilidade só se conhece depois de ler o formulário. Sem isto um
  // solicitante conseguia escrever na parte do ticket que ele não deveria nem
  // ler — bastava mandar `visibility=internal`, já que o campo vinha do cliente
  // e nada o confrontava com o papel de quem enviou.
  if (parsed.data.visibility === 'internal') {
    const internal = await requirePermission('helpdesk.tickets.comentar_interno')
    if ('error' in internal) return { error: 'Sem permissão para comentário interno.' }
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

  if (error) return { error: mensagemDeErro(error) }

  revalidatePath(`/tickets/${parsed.data.ticket_id}`)
  return { success: 'Comentário publicado.' }
}
