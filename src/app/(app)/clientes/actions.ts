'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { NAO_AFETADO, mensagemDeErro } from '@/lib/actions/erros'
import { permitirEscrita } from '@/lib/actions/guarda'
import type { ActionState } from '@/lib/actions/estado'
import {
  branchAreaSchema,
  branchSchema,
  clientSchema,
  clientStatusSchema,
  recordId,
} from '@/lib/schemas/cadastros'


export async function createClientRecord(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('clientes.grupos.criar')
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = clientSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('clients')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) return { error: mensagemDeErro(error, 'Já existe um cliente com este CNPJ.') }

  revalidatePath('/clientes')
  return { success: 'Cliente cadastrado.' }
}

export async function updateClientRecord(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('clientes.grupos.editar')
  if ('error' in gate) return gate

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const parsed = clientSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('clients')
    .update(parsed.data)
    .eq('id', id.data)
    .select('id')

  if (error) return { error: mensagemDeErro(error, 'Já existe um cliente com este CNPJ.') }
  if (!updated?.length) return { error: NAO_AFETADO }

  revalidatePath('/clientes')
  return { success: 'Cliente atualizado.' }
}

/**
 * Muda a situação do cliente sem apagá-lo.
 *
 * Cliente inativo carrega filiais, tickets e contratos históricos; excluir
 * levaria junto o registro do que já foi atendido. Inativar é reversível e
 * preserva a história — por isso não existe exclusão aqui.
 */
export async function setClientStatus(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('clientes.grupos.inativar')
  if ('error' in gate) return gate

  const parsed = z
    .object({ id: recordId, status: clientStatusSchema })
    .safeParse({ id: formData.get('id'), status: formData.get('status') })
  if (!parsed.success) return { error: 'Situação inválida.' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('clients')
    .update({ status: parsed.data.status })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NAO_AFETADO }

  revalidatePath('/clientes')
  return {
    success: parsed.data.status === 'active' ? 'Cliente reativado.' : 'Situação atualizada.',
  }
}

export async function createBranch(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('clientes.filiais.criar')
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = branchSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('branches')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) return { error: error.message }

  revalidatePath('/clientes')
  return { success: 'Filial cadastrada.' }
}

export async function updateBranch(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('clientes.filiais.editar')
  if ('error' in gate) return gate

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const parsed = branchSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('branches')
    .update(parsed.data)
    .eq('id', id.data)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NAO_AFETADO }

  // O endereço da filial mora em /mapas e alimenta a geolocalização: alterar
  // cidade ou UF aqui muda o que aquela tela mostra.
  revalidatePath('/clientes')
  revalidatePath('/mapas')
  return { success: 'Filial atualizada.' }
}

export async function setBranchActive(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('clientes.filiais.inativar')
  if ('error' in gate) return gate

  const parsed = z
    .object({ id: recordId, is_active: z.enum(['true', 'false']) })
    .safeParse({ id: formData.get('id'), is_active: formData.get('is_active') })
  if (!parsed.success) return { error: 'Situação inválida.' }

  const isActive = parsed.data.is_active === 'true'

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('branches')
    .update({ is_active: isActive })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NAO_AFETADO }

  revalidatePath('/clientes')
  revalidatePath('/mapas')
  return { success: isActive ? 'Filial reativada.' : 'Filial inativada.' }
}

/* --- Áreas da filial ------------------------------------------------------ */

/**
 * Área é subdivisão da filial, e o que dá sentido a "onde o equipamento está".
 *
 * Até aqui ela só podia nascer por SQL, embora ativo, linha e link a exijam na
 * prática — um cadastro obrigatório sem tela de cadastro. As três ações abaixo
 * fecham isso; a EXCLUSÃO não entra de propósito: área com ativo, linha ou link
 * vinculado não pode sumir (as FKs são `restrict`/`set null` justamente por
 * isso), e o caminho certo é inativar, que preserva o histórico.
 */
export async function createBranchArea(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('clientes.areas.criar')
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = branchAreaSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('branch_areas')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) {
    // `uq_area_name` é por `lower(name)`: "Enfermagem" e "enfermagem" são a
    // mesma área, e é essa unicidade que o módulo existe para garantir.
    if (error.code === '23505') return { error: 'Já existe uma área com este nome nesta filial.' }
    return { error: error.message }
  }

  revalidatePath('/clientes')
  return { success: 'Área cadastrada.' }
}

export async function updateBranchArea(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('clientes.areas.editar')
  if ('error' in gate) return gate

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const parsed = branchAreaSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('branch_areas')
    .update(parsed.data)
    .eq('id', id.data)
    .select('id')

  if (error) return { error: mensagemDeErro(error, 'Já existe uma área com este nome nesta filial.') }
  if (!updated?.length) return { error: NAO_AFETADO }

  revalidatePath('/clientes')
  return { success: 'Área atualizada.' }
}

export async function setBranchAreaActive(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('clientes.areas.inativar')
  if ('error' in gate) return gate

  const parsed = z
    .object({ id: recordId, is_active: z.enum(['true', 'false']) })
    .safeParse({ id: formData.get('id'), is_active: formData.get('is_active') })
  if (!parsed.success) return { error: 'Situação inválida.' }

  const isActive = parsed.data.is_active === 'true'

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('branch_areas')
    .update({ is_active: isActive })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NAO_AFETADO }

  revalidatePath('/clientes')
  return { success: isActive ? 'Área reativada.' : 'Área inativada.' }
}

/**
 * Cria as áreas padrão da filial.
 *
 * Chama `app.fn_seed_branch_areas()` pela fachada da 0023 em vez de trazer a
 * lista para cá: a lista já existe no banco desde a 0013, e uma segunda cópia no
 * TypeScript divergiria da primeira na manutenção seguinte.
 *
 * É idempotente — `uq_area_name` impede duplicar —, então clicar duas vezes
 * completa o que falta em vez de errar.
 */
export async function seedBranchAreas(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('clientes.areas.criar')
  if ('error' in gate) return gate

  const id = recordId.safeParse(formData.get('branch_id'))
  if (!id.success) return { error: 'Filial inválida.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('seed_branch_areas', { p_branch_id: id.data })

  if (error) return { error: error.message }

  const criadas = Number(data ?? 0)
  revalidatePath('/clientes')
  return {
    success: criadas > 0
      ? `${criadas} área(s) padrão cadastrada(s).`
      : 'Esta filial já tem todas as áreas padrão.',
  }
}
