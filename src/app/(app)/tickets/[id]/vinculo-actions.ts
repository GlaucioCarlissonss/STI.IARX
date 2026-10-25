'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { uuid } from '@/lib/schemas/campos'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'

/**
 * Vincular equipamento e linha telefônica ao chamado.
 *
 * ## Por que isto faltava, e o que custava
 *
 * `ticket_assets` e `ticket_telecom_lines` existem desde a migração 0004, com
 * RLS e chave composta. Nenhuma tela jamais escreveu nelas — e o README
 * **afirmava** "vínculo com tickets" no inventário desde a primeira versão.
 *
 * O custo não é cosmético. Sem o vínculo:
 *
 * - não dá para responder "quantos chamados esta máquina já deu?", que é a
 *   pergunta que decide trocar um equipamento em vez de consertá-lo pela quinta
 *   vez;
 * - o histórico do ativo não mostra o atendimento, e o do chamado não mostra o
 *   equipamento — as duas metades da mesma história ficam em telas que não se
 *   falam.
 *
 * ## Vincular não é editar o chamado
 *
 * Por isso a chave é `helpdesk.tickets.vincular` e não `editar`: acrescentar
 * contexto é ato de quem atende, feito no meio do atendimento, e não exige o
 * poder de mudar título, fila ou prazo.
 */

const vinculoSchema = z.object({
  ticket_id: uuid,
  alvo_id: uuid,
  tipo: z.enum(['ativo', 'linha']),
})

const TABELA = {
  ativo: { nome: 'ticket_assets', coluna: 'asset_id' },
  linha: { nome: 'ticket_telecom_lines', coluna: 'line_id' },
} as const

export async function vincularAoChamado(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('helpdesk.tickets.vincular', {
    mensagem: 'Sem permissão para vincular ativo ou linha.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = vinculoSchema.safeParse({
    ticket_id: formData.get('ticket_id'),
    alvo_id: formData.get('alvo_id'),
    tipo: formData.get('tipo'),
  })
  if (!parsed.success) return { error: 'Escolha o que vincular.' }
  const { ticket_id, alvo_id, tipo } = parsed.data
  const { nome, coluna } = TABELA[tipo]

  const supabase = await createClient()
  const { data, error } = await supabase
    .from(nome)
    .insert({ ticket_id, [coluna]: alvo_id, tenant_id: profile.tenant_id })
    .select('ticket_id')

  if (error) {
    /* A chave primária é `(ticket_id, alvo)`. Vincular duas vezes é um clique
       repetido, não um erro de quem usa — a mensagem diz isso em vez de falar
       de constraint. */
    if (error.code === '23505') {
      return { error: tipo === 'ativo' ? 'Este ativo já está no chamado.' : 'Esta linha já está no chamado.' }
    }
    return { error: mensagemDeErro(error) }
  }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath(`/tickets/${ticket_id}`)
  return { success: tipo === 'ativo' ? 'Ativo vinculado.' : 'Linha vinculada.' }
}

export async function desvincularDoChamado(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('helpdesk.tickets.vincular', {
    mensagem: 'Sem permissão para desvincular.',
  })
  if ('error' in gate) return gate

  const parsed = vinculoSchema.safeParse({
    ticket_id: formData.get('ticket_id'),
    alvo_id: formData.get('alvo_id'),
    tipo: formData.get('tipo'),
  })
  if (!parsed.success) return { error: 'Vínculo inválido.' }
  const { ticket_id, alvo_id, tipo } = parsed.data
  const { nome, coluna } = TABELA[tipo]

  const supabase = await createClient()
  const { data, error } = await supabase
    .from(nome)
    .delete()
    .eq('ticket_id', ticket_id)
    .eq(coluna, alvo_id)
    .select('ticket_id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath(`/tickets/${ticket_id}`)
  return { success: 'Vínculo removido.' }
}
