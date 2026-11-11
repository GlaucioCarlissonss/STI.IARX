'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'
import { emptyToNull, optionalNonNegativeNumber, optionalPositiveInt, uuid } from '@/lib/schemas/campos'

/**
 * Os quatro cadastros que sustentam a frota.
 *
 * Uma ação por tabela, e uma guarda só — `locacao.cadastros.gerenciar`. Chaves
 * separadas por cadastro dariam quatro checkboxes que, na prática, sempre
 * andam juntos: quem cadastra modelo cadastra o fabricante dele no mesmo
 * minuto, e separar produziria o erro "não foi possível salvar" no meio do
 * caminho, sem dizer qual metade faltava.
 */
const guarda = () =>
  permitirEscrita('locacao.cadastros.gerenciar', {
    papel: 'config',
    mensagem: 'Sem permissão para mexer nos cadastros da locação.',
  })

const MEDIDORES = ['none', 'hours', 'cycles', 'distance'] as const

async function salvar(
  tabela: string,
  id: string | null,
  valores: Record<string, unknown>,
  sucesso: string,
): Promise<ActionState> {
  const gate = await guarda()
  if ('error' in gate) return gate
  const { profile } = gate

  const supabase = await createClient()
  if (id) {
    const { data, error } = await supabase.from(tabela).update(valores).eq('id', id).select('id')
    if (error) return { error: mensagemDeErro(error) }
    /* RLS nega UPDATE com zero linhas, não com erro: sem conferir, a tela diria
       "salvo" para quem não pode salvar. */
    if (!data || data.length === 0) return { error: NAO_AFETADO }
  } else {
    const { error } = await supabase
      .from(tabela)
      .insert({ ...valores, tenant_id: profile.tenant_id })
    if (error) return { error: mensagemDeErro(error) }
  }

  revalidatePath('/locacao/cadastros')
  revalidatePath('/locacao/frota')
  return { success: sucesso }
}

export async function salvarFabricante(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = z
    .object({
      id: emptyToNull,
      name: z.string().trim().min(1, 'O fabricante precisa de nome.').max(120),
      support_contact: emptyToNull,
      notes: emptyToNull,
    })
    .safeParse({
      id: formData.get('id'),
      name: formData.get('name'),
      support_contact: formData.get('support_contact'),
      notes: formData.get('notes'),
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const { id, ...valores } = parsed.data
  return salvar('equipment_manufacturers', id, valores, 'Fabricante salvo.')
}

export async function salvarCategoria(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = z
    .object({
      id: emptyToNull,
      code: z.string().trim().min(1, 'A categoria precisa de um código curto.').max(20),
      name: z.string().trim().min(1, 'A categoria precisa de nome.').max(120),
      default_meter_kind: z.enum(MEDIDORES),
      default_useful_life_months: optionalPositiveInt,
    })
    .safeParse({
      id: formData.get('id'),
      code: formData.get('code'),
      name: formData.get('name'),
      default_meter_kind: formData.get('default_meter_kind'),
      default_useful_life_months: formData.get('default_useful_life_months'),
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const { id, ...valores } = parsed.data
  return salvar('equipment_categories', id, valores, 'Categoria salva.')
}

export async function salvarModelo(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({
      id: emptyToNull,
      manufacturer_id: uuid,
      category_id: uuid,
      code: z.string().trim().min(1, 'O modelo precisa de um código.').max(40),
      name: z.string().trim().min(1, 'O modelo precisa de nome.').max(160),
      monthly_price: optionalNonNegativeNumber,
      daily_price: optionalNonNegativeNumber,
    })
    .safeParse({
      id: formData.get('id'),
      manufacturer_id: formData.get('manufacturer_id'),
      category_id: formData.get('category_id'),
      code: formData.get('code'),
      name: formData.get('name'),
      monthly_price: formData.get('monthly_price'),
      daily_price: formData.get('daily_price'),
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const { id, ...valores } = parsed.data
  return salvar('equipment_models', id, valores, 'Modelo salvo.')
}

export async function salvarDeposito(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({
      id: emptyToNull,
      name: z.string().trim().min(1, 'O depósito precisa de nome.').max(120),
      code: emptyToNull,
      kind: z.enum(['warehouse', 'workshop', 'transit']),
      city: emptyToNull,
      state: emptyToNull,
    })
    .safeParse({
      id: formData.get('id'),
      name: formData.get('name'),
      code: formData.get('code'),
      kind: formData.get('kind'),
      city: formData.get('city'),
      state: formData.get('state'),
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const { id, ...valores } = parsed.data
  return salvar('rental_depots', id, valores, 'Depósito salvo.')
}
