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

const ESTADOS = [
  'available', 'reserved', 'in_transit_out', 'rented', 'in_transit_back',
  'inspection', 'maintenance', 'blocked', 'lost', 'written_off',
] as const

const MEDIDORES = ['none', 'hours', 'cycles', 'distance'] as const

/*
 * Os limites repetem os do banco, e isso é deliberado — a mesma divisão de
 * trabalho do resto da casa: o CHECK é a garantia, e vale para o `update` à mão
 * e para a importação; o schema aqui é a MENSAGEM. Divergindo, ganha o banco, e
 * o sintoma é uma frase feia, não um dado inválido.
 */
const fichaSchema = z.object({
  asset_tag: z.string().trim().min(1, 'O patrimônio identifica a máquina no campo.').max(40),
  serial_number: emptyToNull,
  model_id: uuid,
  depot_id: optionalUuid,
  meter_kind: z.enum(MEDIDORES),
  acquisition_date: emptyToNull,
  acquisition_value: optionalNonNegativeNumber,
  invoice_ref: emptyToNull,
  useful_life_months: optionalPositiveInt,
  notes: emptyToNull,
})

function lerFicha(formData: FormData) {
  return fichaSchema.safeParse({
    asset_tag: formData.get('asset_tag'),
    serial_number: formData.get('serial_number'),
    model_id: formData.get('model_id'),
    depot_id: formData.get('depot_id'),
    meter_kind: formData.get('meter_kind'),
    acquisition_date: formData.get('acquisition_date'),
    acquisition_value: formData.get('acquisition_value'),
    invoice_ref: formData.get('invoice_ref'),
    useful_life_months: formData.get('useful_life_months'),
    notes: formData.get('notes'),
  })
}

/**
 * Cadastra um equipamento na frota.
 *
 * O estado inicial não vem do formulário: o gatilho só aceita nascer em
 * `available`, `maintenance` ou `blocked`, e dar a escolha aqui convidaria a
 * cadastrar "locado" — uma peça em operação que nunca saiu da base, sem
 * contrato por trás. Quem acabou de comprar e já mandou para a oficina move o
 * estado logo depois, em um clique, e o histórico registra os dois fatos.
 */
export async function criarEquipamento(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.frota.criar', {
    papel: 'config',
    mensagem: 'Sem permissão para cadastrar equipamento.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = lerFicha(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase.from('rental_equipment').insert({
    ...parsed.data,
    tenant_id: profile.tenant_id,
  })
  if (error) return { error: mensagemDeErro(error) }

  revalidatePath('/locacao/frota')
  return { success: `Equipamento ${parsed.data.asset_tag} cadastrado como disponível.` }
}

export async function editarEquipamento(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.frota.editar', {
    papel: 'config',
    mensagem: 'Sem permissão para editar o equipamento.',
  })
  if ('error' in gate) return gate

  const id = uuid.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const parsed = lerFicha(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('rental_equipment')
    .update(parsed.data)
    .eq('id', id.data)
    /* Negação de RLS em UPDATE devolve zero linhas, e não erro: sem conferir o
       tamanho, a tela diria "salvo" para quem não pode salvar. */
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/locacao/frota')
  return { success: 'Ficha do equipamento salva.' }
}

/**
 * Move o ciclo de vida.
 *
 * A tela só oferece transições que a tabela `rental_equipment_status_transitions`
 * contém — mas a conferência de verdade é do gatilho, e esta ação nem tenta
 * repeti-la. Repetir a regra aqui criaria duas listas para divergirem, e a que
 * manda é a do banco: ela vale para o `update` à mão também.
 */
export async function moverEstadoDoEquipamento(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.frota.mover', {
    papel: 'records',
    mensagem: 'Sem permissão para mover o ciclo de vida do equipamento.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({ id: uuid, status: z.enum(ESTADOS) })
    .safeParse({ id: formData.get('id'), status: formData.get('status') })
  if (!parsed.success) return { error: 'Transição inválida.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('rental_equipment')
    .update({ status: parsed.data.status })
    .eq('id', parsed.data.id)
    .select('id, asset_tag')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/locacao/frota')
  return { success: 'Estado do equipamento atualizado — e o histórico registrou.' }
}

/**
 * Bloqueia e desbloqueia.
 *
 * Bloqueio é ATRIBUTO, não estado: ele impede nova alocação sem tirar a máquina
 * de operação. Uma peça locada com preventiva vencida continua locada, faturando
 * — e, ao voltar, não entra na base alocável. O motivo é obrigatório no banco
 * porque máquina parada sem motivo é máquina que alguém destrava para destravar
 * o contrato.
 */
export async function bloquearEquipamento(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.frota.mover', {
    papel: 'records',
    mensagem: 'Sem permissão para bloquear o equipamento.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({
      id: uuid,
      blocked: z.coerce.boolean(),
      block_reason: emptyToNull,
      block_until: emptyToNull,
    })
    .safeParse({
      id: formData.get('id'),
      blocked: formData.get('blocked') === 'true',
      block_reason: formData.get('block_reason'),
      block_until: formData.get('block_until'),
    })
  if (!parsed.success) return { error: 'Dados inválidos.' }

  if (parsed.data.blocked && !parsed.data.block_reason) {
    return {
      error:
        'Descreva o motivo do bloqueio. Máquina parada sem motivo registrado é a que alguém destrava para destravar o contrato.',
    }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('rental_equipment')
    .update({
      blocked: parsed.data.blocked,
      block_reason: parsed.data.blocked ? parsed.data.block_reason : null,
      block_until: parsed.data.blocked ? parsed.data.block_until : null,
    })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/locacao/frota')
  return {
    success: parsed.data.blocked
      ? 'Equipamento bloqueado: ele não entra em nova alocação.'
      : 'Bloqueio removido.',
  }
}

/**
 * Registra uma leitura de medidor.
 *
 * O banco recusa leitura menor que a anterior, e a mensagem explica por quê:
 * horímetro que anda para trás é troca de aparelho ou erro de digitação, e os
 * dois precisam de registro, não de um `update` que apaga o passado. Em Fase 4
 * a leitura passa a ter série própria e a virar consumo faturável; aqui ela é
 * só o número que a frota mostra.
 */
export async function registrarLeitura(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.frota.mover', {
    papel: 'records',
    mensagem: 'Sem permissão para registrar leitura.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({ id: uuid, meter_reading: z.coerce.number().min(0) })
    .safeParse({ id: formData.get('id'), meter_reading: formData.get('meter_reading') })
  if (!parsed.success) return { error: 'Leitura inválida.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('rental_equipment')
    .update({
      meter_reading: parsed.data.meter_reading,
      meter_read_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/locacao/frota')
  return { success: 'Leitura registrada.' }
}
