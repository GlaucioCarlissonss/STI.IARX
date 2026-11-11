'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'
import {
  emptyToNull,
  optionalNonNegativeNumber,
  optionalPositiveInt,
  optionalUuid,
  uuid,
} from '@/lib/schemas/campos'

function revalida() {
  revalidatePath('/locacao/pecas')
  revalidatePath('/locacao/compras')
  revalidatePath('/locacao/contagens')
}

const quantidadePositiva = z
  .string()
  .trim()
  .transform((v) => Number(v))
  .refine((v) => Number.isFinite(v) && v > 0, { message: 'A quantidade é maior que zero.' })

export async function salvarPeca(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.pecas.gerenciar', {
    papel: 'config',
    mensagem: 'Sem permissão para cadastrar peça.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      id: optionalUuid,
      sku: z.string().trim().min(2, 'Informe o código (SKU) da peça.'),
      name: z.string().trim().min(3, 'Informe o nome da peça.'),
      unit: z.enum(['un', 'm', 'kg', 'l', 'cx', 'par']),
      category: emptyToNull,
      manufacturer_id: optionalUuid,
      notes: emptyToNull,
    })
    .safeParse({
      id: formData.get('id'),
      sku: formData.get('sku'),
      name: formData.get('name'),
      unit: formData.get('unit'),
      category: formData.get('category'),
      manufacturer_id: formData.get('manufacturer_id'),
      notes: formData.get('notes'),
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const { id, ...campos } = parsed.data
  const supabase = await createClient()

  const { data, error } = id
    ? await supabase.from('parts').update(campos).eq('id', id).select('id')
    : await supabase
        .from('parts')
        .insert({ ...campos, tenant_id: profile.tenant_id })
        .select('id')

  /* A mensagem de duplicidade diz ONDE está o conflito. "Registro duplicado"
     obrigaria a pessoa a adivinhar se o problema é o SKU ou o nome. */
  if (error?.code === '23505') return { error: `Já existe uma peça com o código ${campos.sku}.` }
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalida()
  return { success: id ? 'Peça atualizada.' : `Peça ${campos.sku} cadastrada.` }
}

/**
 * Define o mínimo e o máximo de uma peça EM UM DEPÓSITO.
 *
 * O par (peça, depósito) é a chave: o mínimo da oficina não é o mínimo do
 * galpão, e uma política por peça obrigaria a escolher entre encher a oficina
 * ou desabastecê-la.
 */
export async function salvarPolitica(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.pecas.gerenciar', {
    papel: 'config',
    mensagem: 'Sem permissão para definir política de reposição.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      part_id: uuid,
      depot_id: uuid,
      min_quantity: optionalNonNegativeNumber,
      max_quantity: optionalNonNegativeNumber,
      lead_time_days: optionalPositiveInt,
    })
    .safeParse({
      part_id: formData.get('part_id'),
      depot_id: formData.get('depot_id'),
      min_quantity: formData.get('min_quantity') ?? '',
      max_quantity: formData.get('max_quantity') ?? '',
      lead_time_days: formData.get('lead_time_days') ?? '',
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const minimo = parsed.data.min_quantity ?? 0
  const maximo = parsed.data.max_quantity ?? 0

  /* O banco também recusa, e isso é proposital — mas a mensagem daqui explica a
     consequência, que a constraint não tem como explicar. */
  if (maximo < minimo) {
    return {
      error:
        'O máximo não pode ser menor que o mínimo: a sugestão de compra nasceria negativa e a peça nunca sairia da lista de reposição.',
    }
  }

  const supabase = await createClient()
  const { data: existente } = await supabase
    .from('part_stock_policies')
    .select('id')
    .eq('part_id', parsed.data.part_id)
    .eq('depot_id', parsed.data.depot_id)
    .maybeSingle<{ id: string }>()

  const campos = {
    min_quantity: minimo,
    max_quantity: maximo,
    lead_time_days: parsed.data.lead_time_days,
  }

  const { data, error } = existente
    ? await supabase.from('part_stock_policies').update(campos).eq('id', existente.id).select('id')
    : await supabase
        .from('part_stock_policies')
        .insert({
          ...campos,
          tenant_id: profile.tenant_id,
          part_id: parsed.data.part_id,
          depot_id: parsed.data.depot_id,
        })
        .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalida()
  return { success: 'Política de reposição salva.' }
}

/**
 * Lança um movimento à mão — entrada, saída ou ajuste.
 *
 * O sinal sai do tipo, e não de um campo separado: deixar a pessoa digitar
 * "−3" num campo de quantidade é convidar o engano que o estoque não perdoa.
 */
export async function lancarMovimento(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.pecas.movimentar', {
    mensagem: 'Sem permissão para movimentar o estoque.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      part_id: uuid,
      depot_id: uuid,
      direcao: z.enum(['entrada', 'saida', 'ajuste_mais', 'ajuste_menos']),
      quantity: quantidadePositiva,
      unit_cost: optionalNonNegativeNumber,
      notes: emptyToNull,
    })
    .safeParse({
      part_id: formData.get('part_id'),
      depot_id: formData.get('depot_id'),
      direcao: formData.get('direcao'),
      quantity: formData.get('quantity'),
      unit_cost: formData.get('unit_cost') ?? '',
      notes: formData.get('notes'),
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const { direcao, quantity } = parsed.data
  const kind =
    direcao === 'entrada' ? 'purchase' : direcao === 'saida' ? 'transfer_out' : 'adjustment'
  const assinada = direcao === 'entrada' || direcao === 'ajuste_mais' ? quantity : -quantity

  const supabase = await createClient()
  const { error } = await supabase.from('part_movements').insert({
    tenant_id: profile.tenant_id,
    part_id: parsed.data.part_id,
    depot_id: parsed.data.depot_id,
    kind,
    quantity: assinada,
    unit_cost: direcao === 'entrada' ? parsed.data.unit_cost : null,
    notes: parsed.data.notes,
    created_by: profile.id,
  })
  if (error) return { error: mensagemDeErro(error) }

  revalida()
  return { success: 'Movimento lançado — o saldo já reflete.' }
}

/**
 * Transfere entre depósitos: duas pernas, um ato.
 *
 * Uma perna só faria a peça sumir de um lado sem aparecer no outro, e o
 * conjunto dos saldos deixaria de bater com o total comprado. A saída vai
 * primeiro, porque é ela que pode ser recusada por saldo — se a entrada fosse
 * antes, uma recusa deixaria a peça duplicada.
 */
export async function transferirPeca(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.pecas.movimentar', {
    mensagem: 'Sem permissão para transferir peça.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      part_id: uuid,
      depot_id: uuid,
      destino_id: uuid,
      quantity: quantidadePositiva,
      notes: emptyToNull,
    })
    .safeParse({
      part_id: formData.get('part_id'),
      depot_id: formData.get('depot_id'),
      destino_id: formData.get('destino_id'),
      quantity: formData.get('quantity'),
      notes: formData.get('notes'),
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  if (parsed.data.depot_id === parsed.data.destino_id) {
    return { error: 'Origem e destino são o mesmo depósito.' }
  }

  const supabase = await createClient()

  const { error: erroSaida } = await supabase.from('part_movements').insert({
    tenant_id: profile.tenant_id,
    part_id: parsed.data.part_id,
    depot_id: parsed.data.depot_id,
    kind: 'transfer_out',
    quantity: -parsed.data.quantity,
    transfer_depot_id: parsed.data.destino_id,
    notes: parsed.data.notes,
    created_by: profile.id,
  })
  if (erroSaida) return { error: mensagemDeErro(erroSaida) }

  const { error: erroEntrada } = await supabase.from('part_movements').insert({
    tenant_id: profile.tenant_id,
    part_id: parsed.data.part_id,
    depot_id: parsed.data.destino_id,
    kind: 'transfer_in',
    quantity: parsed.data.quantity,
    transfer_depot_id: parsed.data.depot_id,
    notes: parsed.data.notes,
    created_by: profile.id,
  })

  if (erroEntrada) {
    /* A saída já passou. Desfazer é lançar o contrário — o razão é imutável de
       propósito, então a correção fica à vista em vez de ser apagada. */
    await supabase.from('part_movements').insert({
      tenant_id: profile.tenant_id,
      part_id: parsed.data.part_id,
      depot_id: parsed.data.depot_id,
      kind: 'transfer_in',
      quantity: parsed.data.quantity,
      notes: 'Estorno: a entrada no destino falhou',
      created_by: profile.id,
    })
    return { error: mensagemDeErro(erroEntrada) }
  }

  revalida()
  return { success: 'Transferência concluída nos dois depósitos.' }
}
