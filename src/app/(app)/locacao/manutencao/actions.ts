'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'
import { emptyToNull, optionalNonNegativeNumber, optionalUuid, uuid } from '@/lib/schemas/campos'

function revalida(ticketId?: string) {
  revalidatePath('/locacao/manutencao')
  revalidatePath('/chamados')
  if (ticketId) revalidatePath(`/chamados/${ticketId}`)
}

/** A fila de campo é achada pelo `slug`, e não pelo nome — nome se renomeia. */
const SLUG_DA_FILA_DE_CAMPO = 'campo'

/**
 * Abre um atendimento de campo.
 *
 * O chamado nasce em `tickets` — com fila, prioridade, SLA, anexo e histórico
 * que já existem — e a extensão de campo entra junto, na mesma ação. São dois
 * `insert`, e não um: a tabela 1:1 é o que evita dez colunas nulas em todo
 * chamado de helpdesk.
 *
 * Se o segundo falhar, o primeiro é desfeito à mão. Não há transação aqui
 * porque o cliente do banco é o do PostgREST, que não as expõe — então o
 * desfazer explícito é o que impede um chamado de campo órfão, sem equipamento,
 * aparecendo na fila errada.
 */
export async function abrirAtendimento(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.manutencao.abrir', {
    mensagem: 'Sem permissão para abrir atendimento de campo.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      equipment_id: uuid,
      kind: z.enum(['corrective', 'preventive', 'installation', 'removal']),
      title: z.string().trim().min(5, 'Descreva o atendimento em pelo menos 5 caracteres.'),
      description: emptyToNull,
      priority_id: uuid,
      cost_limit: optionalNonNegativeNumber,
      billable_to: z.enum(['provider', 'client']),
    })
    .safeParse({
      equipment_id: formData.get('equipment_id'),
      kind: formData.get('kind'),
      title: formData.get('title'),
      description: formData.get('description'),
      priority_id: formData.get('priority_id'),
      cost_limit: formData.get('cost_limit') ?? '',
      billable_to: formData.get('billable_to') ?? 'provider',
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()

  const { data: fila } = await supabase
    .from('queues')
    .select('id')
    .eq('slug', SLUG_DA_FILA_DE_CAMPO)
    .is('deleted_at', null)
    .maybeSingle<{ id: string }>()
  if (!fila) {
    return {
      error:
        'Não há fila de campo cadastrada (slug "campo"). Crie-a em Filas antes de abrir atendimentos.',
    }
  }

  /*
   * A alocação VIVA do equipamento, se houver — é ela que diz a qual contrato e
   * a qual cliente o atendimento pertence. Quando a peça está na base não há
   * alocação, e isso é legítimo: preventiva no galpão também é atendimento.
   */
  const { data: alocacao } = await supabase
    .from('vw_rental_allocations')
    .select('id, client_id, operation_location_id')
    .eq('equipment_id', parsed.data.equipment_id)
    .in('status', ['reserved', 'delivered'])
    .maybeSingle<{ id: string; client_id: string | null; operation_location_id: string | null }>()

  /* A filial sai do LOCAL DE OPERAÇÃO, e não do cliente: um cliente tem várias
     filiais, e é a filial que governa a visibilidade do chamado para o
     atendente — pôr a errada esconderia o atendimento de quem vai atendê-lo. */
  let branchId: string | null = null
  if (alocacao?.operation_location_id) {
    const { data: local } = await supabase
      .from('operation_locations')
      .select('branch_id')
      .eq('id', alocacao.operation_location_id)
      .maybeSingle<{ branch_id: string | null }>()
    branchId = local?.branch_id ?? null
  }

  const { data: ticket, error: erroTicket } = await supabase
    .from('tickets')
    .insert({
      tenant_id: profile.tenant_id,
      title: parsed.data.title,
      description: parsed.data.description,
      status: 'open',
      priority_id: parsed.data.priority_id,
      queue_id: fila.id,
      client_id: alocacao?.client_id ?? null,
      branch_id: branchId,
      requester_id: profile.id,
      source: 'ui',
      tags: ['campo'],
    })
    .select('id, ticket_number')
    .single<{ id: string; ticket_number: number }>()

  if (erroTicket) return { error: mensagemDeErro(erroTicket) }

  const { error: erroCampo } = await supabase.from('ticket_field_service').insert({
    ticket_id: ticket.id,
    tenant_id: profile.tenant_id,
    equipment_id: parsed.data.equipment_id,
    contract_item_id: alocacao?.id ?? null,
    kind: parsed.data.kind,
    cost_limit: parsed.data.cost_limit,
    billable_to: parsed.data.billable_to,
  })

  if (erroCampo) {
    /* Chamado sem extensão seria um chamado de campo que a tela de campo não
       enxerga — pior que nenhum, porque fica escondido numa fila que ninguém
       lê por outro caminho. */
    await supabase.from('tickets').delete().eq('id', ticket.id)
    return { error: mensagemDeErro(erroCampo) }
  }

  revalida(ticket.id)
  return { success: `Atendimento #${ticket.ticket_number} aberto na fila de campo.` }
}

/**
 * Aponta horas.
 *
 * O valor da linha é calculado aqui e GRAVADO: a hora muda de preço com o
 * tempo, e recalcular o passado com a tabela de hoje mudaria o custo de um
 * serviço que já foi faturado.
 */
export async function apontarHoras(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.manutencao.atender', {
    mensagem: 'Sem permissão para apontar horas.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      ticket_id: uuid,
      technician_id: optionalUuid,
      worked_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe a data do trabalho.'),
      hours: z
        .string()
        .trim()
        .transform((v) => Number(v))
        .refine((v) => Number.isFinite(v) && v > 0 && v <= 24, {
          message: 'As horas vão de 0 (exclusive) a 24.',
        }),
      hourly_rate: optionalNonNegativeNumber,
      notes: emptyToNull,
    })
    .safeParse({
      ticket_id: formData.get('ticket_id'),
      technician_id: formData.get('technician_id'),
      worked_on: formData.get('worked_on'),
      hours: formData.get('hours'),
      hourly_rate: formData.get('hourly_rate') ?? '',
      notes: formData.get('notes'),
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const valorHora = parsed.data.hourly_rate ?? 0
  const supabase = await createClient()
  const { error } = await supabase.from('ticket_labor_entries').insert({
    tenant_id: profile.tenant_id,
    ticket_id: parsed.data.ticket_id,
    technician_id: parsed.data.technician_id ?? profile.id,
    worked_on: parsed.data.worked_on,
    hours: parsed.data.hours,
    hourly_rate: valorHora,
    amount: Number((parsed.data.hours * valorHora).toFixed(2)),
    notes: parsed.data.notes,
  })
  if (error) return { error: mensagemDeErro(error) }

  revalida(parsed.data.ticket_id)
  return { success: `${parsed.data.hours.toLocaleString('pt-BR')}h apontadas.` }
}

/** Registra uma peça consumida. Na Fase 6 ela passa a dar baixa no estoque. */
export async function apontarPeca(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.manutencao.atender', {
    mensagem: 'Sem permissão para apontar peças.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      ticket_id: uuid,
      description: z.string().trim().min(3, 'Descreva a peça.'),
      quantity: z
        .string()
        .trim()
        .transform((v) => Number(v))
        .refine((v) => Number.isFinite(v) && v > 0, { message: 'A quantidade é maior que zero.' }),
      unit_cost: optionalNonNegativeNumber,
    })
    .safeParse({
      ticket_id: formData.get('ticket_id'),
      description: formData.get('description'),
      quantity: formData.get('quantity'),
      unit_cost: formData.get('unit_cost') ?? '',
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const unitario = parsed.data.unit_cost ?? 0
  const supabase = await createClient()
  const { error } = await supabase.from('ticket_parts_used').insert({
    tenant_id: profile.tenant_id,
    ticket_id: parsed.data.ticket_id,
    description: parsed.data.description,
    quantity: parsed.data.quantity,
    unit_cost: unitario,
    amount: Number((parsed.data.quantity * unitario).toFixed(2)),
  })
  if (error) return { error: mensagemDeErro(error) }

  revalida(parsed.data.ticket_id)
  return { success: 'Peça registrada no atendimento.' }
}

/**
 * Aprova o custo acima da alçada.
 *
 * Aprovar NÃO apaga o estouro: o teto continua gravado, o custo continua o que
 * é, e o que muda é existir um nome e uma hora autorizando. É isso que permite,
 * seis meses depois, responder quem autorizou aquele conserto de R$ 4.000.
 */
export async function aprovarCusto(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.manutencao.aprovar', {
    papel: 'config',
    mensagem: 'Sem permissão para aprovar custo acima da alçada.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({ ticket_id: uuid, approval_note: emptyToNull })
    .safeParse({
      ticket_id: formData.get('ticket_id'),
      approval_note: formData.get('approval_note'),
    })
  if (!parsed.success) return { error: 'Registro inválido.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('ticket_field_service')
    .update({
      approved_by: profile.id,
      approved_at: new Date().toISOString(),
      approval_note: parsed.data.approval_note,
    })
    .eq('ticket_id', parsed.data.ticket_id)
    .select('ticket_id')
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalida(parsed.data.ticket_id)
  return { success: 'Custo aprovado — o atendimento já pode ser fechado.' }
}

/** Desfaz a aprovação. Existe porque aprovar por engano acontece. */
export async function revogarAprovacao(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.manutencao.aprovar', {
    papel: 'config',
    mensagem: 'Sem permissão para revogar aprovação.',
  })
  if ('error' in gate) return gate

  const id = uuid.safeParse(formData.get('ticket_id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('ticket_field_service')
    .update({ approved_by: null, approved_at: null, approval_note: null })
    .eq('ticket_id', id.data)
    .select('ticket_id')
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalida(id.data)
  return { success: 'Aprovação revogada.' }
}

/**
 * Edita quem paga e qual é a alçada.
 *
 * Quem paga é o campo que, na Fase 6, decide se o custo vira linha de fatura —
 * então ele precisa ser corrigível depois do diagnóstico: só no local se
 * descobre que o atolamento era grampo dentro do mecanismo, e não desgaste.
 */
export async function salvarCampo(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.manutencao.atender', {
    mensagem: 'Sem permissão para editar o atendimento.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({
      ticket_id: uuid,
      kind: z.enum(['corrective', 'preventive', 'installation', 'removal']),
      billable_to: z.enum(['provider', 'client']),
      cost_limit: optionalNonNegativeNumber,
    })
    .safeParse({
      ticket_id: formData.get('ticket_id'),
      kind: formData.get('kind'),
      billable_to: formData.get('billable_to'),
      cost_limit: formData.get('cost_limit') ?? '',
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('ticket_field_service')
    .update({
      kind: parsed.data.kind,
      billable_to: parsed.data.billable_to,
      cost_limit: parsed.data.cost_limit,
    })
    .eq('ticket_id', parsed.data.ticket_id)
    .select('ticket_id')
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalida(parsed.data.ticket_id)
  return { success: 'Atendimento atualizado.' }
}

/**
 * Move o chamado de campo pela máquina de estados.
 *
 * A transição em si é validada pelo gatilho da 0005, e a alçada pelo da 0051 —
 * esta ação não repete nenhuma das duas regras. Ela existe para que fechar um
 * atendimento não exija sair da tela de campo e procurar o chamado na lista.
 */
export async function moverAtendimento(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.manutencao.atender', {
    mensagem: 'Sem permissão para mover o atendimento.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({ ticket_id: uuid, status: z.string().trim().min(1) })
    .safeParse({ ticket_id: formData.get('ticket_id'), status: formData.get('status') })
  if (!parsed.success) return { error: 'Registro inválido.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('tickets')
    .update({ status: parsed.data.status })
    .eq('id', parsed.data.ticket_id)
    .select('ticket_number')
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalida(parsed.data.ticket_id)
  return { success: `Atendimento #${data[0]?.ticket_number} atualizado.` }
}

/**
 * Remove um apontamento.
 *
 * Existe porque apontamento errado acontece — 25h em vez de 2,5h, a peça
 * lançada no chamado do lado. Sem remoção, a única saída seria lançar um valor
 * negativo, e aí o custo deixaria de ser a soma do que foi feito para virar a
 * soma do que foi feito mais a contabilidade dos enganos.
 *
 * A mesma chave de apontar: quem lança corrige. O que continua sendo de outra
 * pessoa é APROVAR.
 */
export async function removerApontamento(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.manutencao.atender', {
    mensagem: 'Sem permissão para remover apontamento.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({ id: uuid, ticket_id: uuid, tipo: z.enum(['hora', 'peca']) })
    .safeParse({
      id: formData.get('id'),
      ticket_id: formData.get('ticket_id'),
      tipo: formData.get('tipo'),
    })
  if (!parsed.success) return { error: 'Registro inválido.' }

  const supabase = await createClient()
  const tabela = parsed.data.tipo === 'hora' ? 'ticket_labor_entries' : 'ticket_parts_used'
  const { data, error } = await supabase
    .from(tabela)
    .delete()
    .eq('id', parsed.data.id)
    .select('id')
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalida(parsed.data.ticket_id)
  return { success: parsed.data.tipo === 'hora' ? 'Apontamento removido.' : 'Peça removida.' }
}
