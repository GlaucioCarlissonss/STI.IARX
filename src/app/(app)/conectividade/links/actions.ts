'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireSession, requirePermission, canManageRecords } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'
import {
  recordId,
  internetLinkSchema,
  linkOutageSchema,
  linkStatusSchema,
} from '@/lib/schemas/cadastros'

/**
 * Links de internet.
 *
 * A camada de dados existe desde a migração 0013; só agora existe tela. As ações
 * seguem o padrão desta base: `requirePermission` pela chave granular **e**
 * `canManageRecords` pelo papel, porque as duas coisas são checadas no banco
 * também — a policy de escrita de `internet_links` (0013:947) exige
 * `app.can_manage_records()`.
 *
 * `.select('id')` depois de todo `update` não é enfeite: quando o RLS nega, o
 * PostgREST devolve **zero linhas e nenhum erro**. Sem checar o tamanho, a tela
 * diria "salvo" para uma escrita que não aconteceu.
 */

const NOT_AFFECTED = 'Não foi possível salvar: registro não encontrado ou sem permissão.'
const ROTA = '/conectividade/links'

export async function createInternetLink(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('conectividade.links.criar')
  if ('error' in gate) return gate
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = internetLinkSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('internet_links')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) {
    if (error.code === '23505') return { error: 'Já existe um link com este número de contrato.' }
    return { error: error.message }
  }

  revalidatePath(ROTA)
  return { success: 'Link cadastrado.' }
}

export async function updateInternetLink(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('conectividade.links.editar')
  if ('error' in gate) return gate
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const parsed = internetLinkSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('internet_links')
    .update(parsed.data)
    .eq('id', id.data)
    .select('id')

  if (error) {
    if (error.code === '23505') return { error: 'Já existe um link com este número de contrato.' }
    return { error: error.message }
  }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath(ROTA)
  return { success: 'Link atualizado.' }
}

/**
 * Atalho de situação, sem abrir a ficha inteira.
 *
 * `cancelled` fica de fora: a constraint `link_cancel_needs_date` exige a data de
 * cancelamento, que este atalho não tem como pedir. Cancelar é pela ficha — e
 * cancelar contrato merece mesmo mais do que um clique.
 */
export async function setInternetLinkStatus(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('conectividade.links.mudar_status')
  if ('error' in gate) return gate
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const status = linkStatusSchema.exclude(['cancelled']).safeParse(formData.get('status'))
  if (!status.success) return { error: 'Situação inválida para este atalho.' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('internet_links')
    .update({ status: status.data })
    .eq('id', id.data)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath(ROTA)
  return { success: status.data === 'active' ? 'Link reativado.' : 'Link suspenso.' }
}

/**
 * Abre uma queda.
 *
 * O índice parcial `uq_link_event_open` (0013:547) garante no máximo UMA queda
 * aberta por link. Abrir a segunda estoura `23505`, e isso é informação para quem
 * está na tela — não erro do sistema.
 *
 * `internet_links.last_state` não é atualizado aqui: a trigger
 * `trg_link_event_syncs_state` (0022) faz isso no banco, que é onde o webhook do
 * Zabbix também vai escrever. Dois caminhos de escrita mantendo a mesma coluna à
 * mão divergiriam no primeiro evento vindo de fora da tela.
 */
export async function openLinkOutage(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('conectividade.links.registrar_evento')
  if ('error' in gate) return gate
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = linkOutageSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase.from('link_availability_events').insert({
    tenant_id: profile.tenant_id,
    link_id: parsed.data.link_id,
    state: 'down',
    source: 'manual',
    note: parsed.data.note,
  })

  if (error) {
    if (error.code === '23505') return { error: 'Já existe uma queda aberta para este link.' }
    return { error: error.message }
  }

  revalidatePath(ROTA)
  return { success: 'Queda registrada.' }
}

/** Fecha a queda aberta. Sem queda aberta não há o que fechar, e a tela diz isso. */
export async function closeLinkOutage(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('conectividade.links.registrar_evento')
  if ('error' in gate) return gate
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const id = recordId.safeParse(formData.get('link_id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const supabase = await createClient()
  const { data: fechados, error } = await supabase
    .from('link_availability_events')
    .update({ ended_at: new Date().toISOString() })
    .eq('link_id', id.data)
    .is('ended_at', null)
    .select('id')

  if (error) return { error: error.message }
  if (!fechados?.length) return { error: 'Não há queda aberta para este link.' }

  revalidatePath(ROTA)
  return { success: 'Retorno registrado.' }
}
