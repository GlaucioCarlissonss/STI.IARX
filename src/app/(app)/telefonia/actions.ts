'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { NAO_AFETADO, mensagemDeErro } from '@/lib/actions/erros'
import { permitirEscrita } from '@/lib/actions/guarda'
import type { ActionState } from '@/app/(app)/tickets/actions'
import { recordId, telecomLineSchema, telecomStatusSchema } from '@/lib/schemas/cadastros'


export async function createTelecomLine(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('telefonia.linhas.criar', { mensagem: 'Sem permissão para cadastrar linhas.' })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = telecomLineSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('telecom_lines')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) return { error: mensagemDeErro(error, 'Este número já está cadastrado.') }

  revalidatePath('/telefonia')
  return { success: 'Linha cadastrada.' }
}

export async function updateTelecomLine(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('telefonia.linhas.editar')
  if ('error' in gate) return gate

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const parsed = telecomLineSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('telecom_lines')
    .update(parsed.data)
    .eq('id', id.data)
    .select('id')

  if (error) return { error: mensagemDeErro(error, 'Este número já está cadastrado.') }
  if (!updated?.length) return { error: NAO_AFETADO }

  revalidatePath('/telefonia')
  return { success: 'Linha atualizada.' }
}

/**
 * Suspender ou cancelar sem abrir a ficha inteira.
 *
 * Cancelar exige data — a constraint `line_cancelled_needs_date` recusaria o
 * `update` sem ela. Por isso o cancelamento não entra neste atalho: ele pede um
 * campo, e um atalho que abre formulário deixou de ser atalho. Cancelar é feito
 * na edição completa, onde a data está à mão.
 */
export async function setTelecomLineStatus(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('telefonia.linhas.mudar_status')
  if ('error' in gate) return gate

  const parsed = z
    .object({ id: recordId, status: telecomStatusSchema.exclude(['cancelled']) })
    .safeParse({ id: formData.get('id'), status: formData.get('status') })
  if (!parsed.success) {
    return { error: 'Para cancelar a linha, use a edição completa e informe a data.' }
  }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('telecom_lines')
    .update({ status: parsed.data.status })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NAO_AFETADO }

  revalidatePath('/telefonia')
  return { success: parsed.data.status === 'active' ? 'Linha reativada.' : 'Linha suspensa.' }
}
