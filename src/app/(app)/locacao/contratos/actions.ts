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
  optionalUuid,
  uuid,
} from '@/lib/schemas/campos'

const ESTADOS_DE_CONTRATO = ['draft', 'active', 'suspended', 'ended', 'cancelled'] as const

function revalida() {
  revalidatePath('/locacao/contratos')
  /* A frota também: alocar e recolher mudam o estado do equipamento, e a lista
     de frota aberta noutra aba mostraria o estado antigo. */
  revalidatePath('/locacao/frota')
}

/** Cadastra ou edita o contrato. O estado não vem daqui — ver `moverContrato`. */
export async function salvarContrato(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get('id') ?? '')
  const gate = await permitirEscrita(id ? 'locacao.contratos.editar' : 'locacao.contratos.criar', {
    papel: 'config',
    mensagem: 'Sem permissão para mexer em contratos de locação.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      client_id: uuid,
      code: z.string().trim().min(1, 'O contrato precisa de um número.').max(40),
      starts_on: z.string().date('Informe o início da vigência.'),
      ends_on: emptyToNull,
      billing_day: z.coerce.number().int().min(1).max(28),
      default_franchise: optionalNonNegativeNumber,
      default_excess_price: optionalNonNegativeNumber,
      adjustment_index: emptyToNull,
      adjustment_month: emptyToNull,
      notes: emptyToNull,
    })
    .safeParse({
      client_id: formData.get('client_id'),
      code: formData.get('code'),
      starts_on: formData.get('starts_on'),
      ends_on: formData.get('ends_on'),
      billing_day: formData.get('billing_day'),
      default_franchise: formData.get('default_franchise'),
      default_excess_price: formData.get('default_excess_price'),
      adjustment_index: formData.get('adjustment_index'),
      adjustment_month: formData.get('adjustment_month'),
      notes: formData.get('notes'),
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const valores = {
    ...parsed.data,
    adjustment_month: parsed.data.adjustment_month ? Number(parsed.data.adjustment_month) : null,
  }

  const supabase = await createClient()
  if (id) {
    const { data, error } = await supabase
      .from('rental_contracts')
      .update(valores)
      .eq('id', id)
      .select('id')
    if (error) return { error: mensagemDeErro(error) }
    if (!data || data.length === 0) return { error: NAO_AFETADO }
    revalida()
    return { success: 'Contrato salvo.' }
  }

  const { error } = await supabase
    .from('rental_contracts')
    .insert({ ...valores, tenant_id: profile.tenant_id })
  if (error) return { error: mensagemDeErro(error) }
  revalida()
  return { success: `Contrato ${parsed.data.code} criado como rascunho.` }
}

/**
 * Move o estado do contrato.
 *
 * Encerrar e rescindir devolvem os itens por gatilho — sem isso, o equipamento
 * ficaria preso numa alocação viva de um contrato morto, e o índice de alocação
 * única o impediria de entrar em outro contrato sem dizer por quê.
 */
export async function moverContrato(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.contratos.mover', {
    papel: 'config',
    mensagem: 'Sem permissão para mudar o estado do contrato.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({ id: uuid, status: z.enum(ESTADOS_DE_CONTRATO) })
    .safeParse({ id: formData.get('id'), status: formData.get('status') })
  if (!parsed.success) return { error: 'Transição inválida.' }

  const supabase = await createClient()

  /* A transição é conferida contra a TABELA, e não contra uma lista aqui: é a
     mesma fonte que a tela lê para desenhar os botões. */
  const { data: atual } = await supabase
    .from('rental_contracts')
    .select('id, status')
    .eq('id', parsed.data.id)
    .maybeSingle<{ id: string; status: string }>()
  if (!atual) return { error: NAO_AFETADO }

  const { data: permitido } = await supabase
    .from('rental_contract_status_transitions')
    .select('to_status')
    .eq('from_status', atual.status)
    .eq('to_status', parsed.data.status)
    .maybeSingle<{ to_status: string }>()

  if (!permitido) {
    return { error: `Um contrato ${atual.status} não vai para ${parsed.data.status}.` }
  }

  const { data, error } = await supabase
    .from('rental_contracts')
    .update({ status: parsed.data.status })
    .eq('id', parsed.data.id)
    .select('id')
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalida()
  return {
    success:
      parsed.data.status === 'ended' || parsed.data.status === 'cancelled'
        ? 'Contrato encerrado. Os itens foram devolvidos — recolha o equipamento na tela de frota.'
        : 'Contrato atualizado.',
  }
}

/**
 * Aloca um equipamento no contrato.
 *
 * Três regras estão no banco e esta ação não as repete: a peça tem de estar
 * disponível, o contrato tem de estar vivo, e o mesmo equipamento não pode ter
 * duas alocações vivas. Repetir aqui daria duas listas para divergirem — e a
 * que manda é a do banco, que vale também para o `insert` à mão.
 */
export async function alocarEquipamento(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.contratos.alocar', {
    papel: 'records',
    mensagem: 'Sem permissão para alocar equipamento.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      contract_id: uuid,
      equipment_id: uuid,
      operation_location_id: optionalUuid,
      monthly_price: z.coerce.number().min(0, 'O preço acordado não pode ser negativo.'),
      franchise: optionalNonNegativeNumber,
      excess_price: optionalNonNegativeNumber,
    })
    .safeParse({
      contract_id: formData.get('contract_id'),
      equipment_id: formData.get('equipment_id'),
      operation_location_id: formData.get('operation_location_id'),
      monthly_price: formData.get('monthly_price'),
      franchise: formData.get('franchise'),
      excess_price: formData.get('excess_price'),
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('rental_contract_items')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })
  if (error) return { error: mensagemDeErro(error) }

  /* A peça sai da base alocável. A transição é validada pelo gatilho da 0048:
     se ela não estivesse disponível, o insert acima já teria falhado. */
  const { error: erroEstado } = await supabase
    .from('rental_equipment')
    .update({ status: 'reserved' })
    .eq('id', parsed.data.equipment_id)
  if (erroEstado) return { error: mensagemDeErro(erroEstado) }

  revalida()
  return { success: 'Equipamento reservado para este contrato.' }
}

/**
 * Move a alocação: expedir, entregar, recolher, cancelar.
 *
 * Cada passo mexe em DOIS lugares — o item e o equipamento — e a ordem importa:
 * o item primeiro, porque é ele que carrega data e leitura; o equipamento
 * depois, porque a transição dele é validada contra o estado anterior.
 */
export async function moverAlocacao(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.contratos.alocar', {
    papel: 'records',
    mensagem: 'Sem permissão para mexer na alocação.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({
      id: uuid,
      equipment_id: uuid,
      acao: z.enum(['expedir', 'entregar', 'recolher', 'cancelar']),
      meter: optionalNonNegativeNumber,
    })
    .safeParse({
      id: formData.get('id'),
      equipment_id: formData.get('equipment_id'),
      acao: formData.get('acao'),
      meter: formData.get('meter'),
    })
  if (!parsed.success) return { error: 'Ação inválida.' }

  const supabase = await createClient()
  const hoje = new Date().toISOString().slice(0, 10)

  const porAcao = {
    expedir: { item: null, equip: 'in_transit_out' as const },
    entregar: {
      item: { status: 'delivered', delivered_on: hoje, meter_at_delivery: parsed.data.meter },
      equip: 'rented' as const,
    },
    recolher: {
      item: { status: 'returned', returned_on: hoje, meter_at_return: parsed.data.meter },
      equip: 'in_transit_back' as const,
    },
    cancelar: { item: { status: 'cancelled' }, equip: 'available' as const },
  }[parsed.data.acao]

  if (porAcao.item) {
    const { data, error } = await supabase
      .from('rental_contract_items')
      .update(porAcao.item)
      .eq('id', parsed.data.id)
      .select('id')
    if (error) return { error: mensagemDeErro(error) }
    if (!data || data.length === 0) return { error: NAO_AFETADO }
  }

  const { error: erroEstado } = await supabase
    .from('rental_equipment')
    .update({ status: porAcao.equip })
    .eq('id', parsed.data.equipment_id)
  if (erroEstado) return { error: mensagemDeErro(erroEstado) }

  revalida()
  const frase = {
    expedir: 'Equipamento expedido — está a caminho do cliente.',
    entregar: 'Entrega confirmada: a peça está em operação e começa a faturar.',
    recolher: 'Recolhimento registrado. Confira a peça na inspeção, na tela de frota.',
    cancelar: 'Alocação cancelada e equipamento devolvido à base alocável.',
  }[parsed.data.acao]
  return { success: frase }
}

/** Cadastra um local de operação do cliente. */
export async function salvarLocal(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.contratos.editar', {
    papel: 'config',
    mensagem: 'Sem permissão para cadastrar local de operação.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      id: emptyToNull,
      client_id: uuid,
      branch_id: optionalUuid,
      name: z.string().trim().min(1, 'O local precisa de nome.').max(120),
      address_line: emptyToNull,
      contact_name: emptyToNull,
      contact_phone: emptyToNull,
    })
    .safeParse({
      id: formData.get('id'),
      client_id: formData.get('client_id'),
      branch_id: formData.get('branch_id'),
      name: formData.get('name'),
      address_line: formData.get('address_line'),
      contact_name: formData.get('contact_name'),
      contact_phone: formData.get('contact_phone'),
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const { id, ...valores } = parsed.data
  const supabase = await createClient()

  if (id) {
    const { data, error } = await supabase
      .from('operation_locations')
      .update(valores)
      .eq('id', id)
      .select('id')
    if (error) return { error: mensagemDeErro(error) }
    if (!data || data.length === 0) return { error: NAO_AFETADO }
  } else {
    const { error } = await supabase
      .from('operation_locations')
      .insert({ ...valores, tenant_id: profile.tenant_id })
    if (error) return { error: mensagemDeErro(error) }
  }

  revalida()
  return { success: 'Local de operação salvo.' }
}
