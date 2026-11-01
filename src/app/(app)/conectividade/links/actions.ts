'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { NAO_AFETADO, mensagemDeErro } from '@/lib/actions/erros'
import { permitirEscrita } from '@/lib/actions/guarda'
import type { ActionState } from '@/lib/actions/estado'
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

const ROTA = '/conectividade/links'

export async function createInternetLink(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('conectividade.links.criar')
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = internetLinkSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('internet_links')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) return { error: mensagemDeErro(error, 'Já existe um link com este número de contrato.') }

  revalidatePath(ROTA)
  return { success: 'Link cadastrado.' }
}

export async function updateInternetLink(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('conectividade.links.editar')
  if ('error' in gate) return gate

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

  if (error) return { error: mensagemDeErro(error, 'Já existe um link com este número de contrato.') }
  if (!updated?.length) return { error: NAO_AFETADO }

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
  const gate = await permitirEscrita('conectividade.links.mudar_status')
  if ('error' in gate) return gate

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

  if (error) return { error: mensagemDeErro(error) }
  if (!updated?.length) return { error: NAO_AFETADO }

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
  const gate = await permitirEscrita('conectividade.links.registrar_evento')
  if ('error' in gate) return gate
  const { profile } = gate

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

  if (error) return { error: mensagemDeErro(error, 'Já existe uma queda aberta para este link.') }

  revalidatePath(ROTA)
  return { success: 'Queda registrada.' }
}

/** Fecha a queda aberta. Sem queda aberta não há o que fechar, e a tela diz isso. */
export async function closeLinkOutage(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('conectividade.links.registrar_evento')
  if ('error' in gate) return gate

  const id = recordId.safeParse(formData.get('link_id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const supabase = await createClient()
  const { data: fechados, error } = await supabase
    .from('link_availability_events')
    .update({ ended_at: new Date().toISOString() })
    .eq('link_id', id.data)
    .is('ended_at', null)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!fechados?.length) return { error: 'Não há queda aberta para este link.' }

  revalidatePath(ROTA)
  return { success: 'Retorno registrado.' }
}

/* -------------------------------------------------------------------------- */
/* A entrada de monitoramento (0046)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Cria uma entrada de monitoramento e guarda apenas o hash do token.
 *
 * O token em claro existe uma vez: na resposta desta ação, para a pessoa colar
 * no Zabbix. Mesmo contrato de `dashboard_tokens` (ADR-006), `agent_enrollments`
 * (0031) e `channels` (0034) — e pelo mesmo motivo: um token guardado em claro é
 * um token que aparece em backup, em export de suporte e na tela de quem tem
 * `select`.
 *
 * Quem gera é o SERVIDOR, e não o formulário. Gerar no navegador faria o valor
 * passar pelo corpo da requisição e pelo log de quem estivesse no caminho; e
 * `crypto.randomUUID()` de um navegador antigo não promete entropia nenhuma.
 */
export async function criarEntradaDeMonitoramento(
  _prev: ActionState & { token?: string },
  formData: FormData,
): Promise<ActionState & { token?: string }> {
  const gate = await permitirEscrita('conectividade.links.monitoramento')
  if ('error' in gate) return gate
  const { profile } = gate

  const nome = String(formData.get('name') ?? '').trim()
  if (nome.length < 2 || nome.length > 120) {
    return { error: 'Dê um nome de 2 a 120 caracteres — "Zabbix da matriz", por exemplo.' }
  }

  const { randomBytes, createHash } = await import('node:crypto')
  /* 32 bytes em base64url: 43 caracteres sem `+`, `/` ou `=`, que é o que
     sobrevive a ser colado numa URL dentro de um script de mídia. */
  const token = randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(token).digest('hex')

  const supabase = await createClient()
  const { error } = await supabase.from('monitoring_webhooks').insert({
    tenant_id: profile.tenant_id,
    name: nome,
    inbound_token_hash: hash,
    created_by: profile.id,
  })

  if (error) return { error: mensagemDeErro(error) }

  /*
   * SEM `revalidatePath` aqui, e é o oposto do que todas as outras ações desta
   * base fazem.
   *
   * Revalidar faz o Next re-renderizar a rota e remontar a árvore de cliente — e
   * com ela o estado de `useActionState`, onde o token acabou de chegar. O
   * resultado é uma entrada criada no banco cujo endereço ninguém chegou a ler:
   * o único remédio é criar outra e desligar esta.
   *
   * Foi reproduzido pela suíte de navegador, que clicava e não encontrava o
   * endereço em rodada nenhuma.
   *
   * O custo de não revalidar é pequeno e visível: a nova entrada entra na lista
   * na próxima navegação. O custo de revalidar é invisível e caro.
   */
  return { success: 'Entrada criada. Copie o endereço agora — ele não volta a aparecer.', token }
}

/** Desliga uma entrada sem apagá-la: o histórico de `last_seen_at` continua. */
export async function desligarEntradaDeMonitoramento(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('conectividade.links.monitoramento')
  if ('error' in gate) return gate

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('monitoring_webhooks')
    .update({ active: false })
    .eq('id', id.data)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data?.length) return { error: NAO_AFETADO }

  revalidatePath(ROTA)
  return { success: 'Entrada desligada. O Zabbix passa a receber 401.' }
}
