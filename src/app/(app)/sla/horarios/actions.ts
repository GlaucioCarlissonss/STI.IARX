'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { uuid } from '@/lib/schemas/campos'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'

/**
 * Expediente, faixas de horário e feriados.
 *
 * ## Por que estas ações não existiam
 *
 * `business_hours`, `business_hours_intervals` e `business_hours_holidays` estão
 * no banco desde a migração 0006, com RLS, auditoria e a aritmética de prazo que
 * as usa (`fn_add_business_minutes`, `fn_business_minutes_between`). O que nunca
 * existiu foi a tela: dava para **escolher** um expediente no formulário de
 * contrato e de definição de SLA, e não dava para **criar** nenhum — nem
 * cadastrar um feriado.
 *
 * Na prática, todo tenant vivia com o expediente que o seed criou, e **nenhum
 * feriado era respeitado**: um chamado aberto na véspera de Natal contava prazo
 * no dia 25.
 */

const TZ_BRASIL = /^[A-Za-z]+\/[A-Za-z_]+$/

const expedienteSchema = z.object({
  name: z.string().trim().min(2, 'Dê um nome ao expediente (ex.: Comercial 8h-18h).').max(80),
  timezone: z
    .string()
    .trim()
    .regex(TZ_BRASIL, 'O fuso precisa ter a forma Região/Cidade (ex.: America/Sao_Paulo).'),
  is_default: z.coerce.boolean(),
})

export async function criarExpediente(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('sla.horarios.criar')
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = expedienteSchema.safeParse({
    name: formData.get('name'),
    timezone: formData.get('timezone'),
    is_default: formData.get('is_default') === 'on',
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()

  /* Um padrão por tenant (`uq_business_hours_default`). Tirar o anterior ANTES de
     inserir é o que evita a violação — e é o comportamento que a pessoa espera:
     marcar um novo como padrão desmarca o antigo, não dá erro. */
  if (parsed.data.is_default) {
    await supabase.from('business_hours').update({ is_default: false }).eq('is_default', true)
  }

  const { data, error } = await supabase
    .from('business_hours')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/sla/horarios')
  return {
    success:
      'Expediente criado. Sem faixas de horário ele não conta tempo nenhum — cadastre os dias da semana abaixo.',
  }
}

export async function editarExpediente(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('sla.horarios.editar')
  if ('error' in gate) return gate

  const parsed = expedienteSchema.extend({ id: uuid }).safeParse({
    id: formData.get('id'),
    name: formData.get('name'),
    timezone: formData.get('timezone'),
    is_default: formData.get('is_default') === 'on',
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const { id, ...valores } = parsed.data
  const supabase = await createClient()

  if (valores.is_default) {
    await supabase
      .from('business_hours')
      .update({ is_default: false })
      .eq('is_default', true)
      .neq('id', id)
  }

  const { data, error } = await supabase
    .from('business_hours')
    .update(valores)
    .eq('id', id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/sla/horarios')
  return { success: 'Expediente atualizado. Os prazos em andamento passam a contar pelo novo.' }
}

const faixaSchema = z
  .object({
    business_hours_id: uuid,
    weekday: z.coerce.number().int().min(0).max(6),
    starts_at: z.string().regex(/^\d{2}:\d{2}$/, 'Horário inválido.'),
    ends_at: z.string().regex(/^\d{2}:\d{2}$/, 'Horário inválido.'),
  })
  .refine((d) => d.ends_at > d.starts_at, {
    message: 'A faixa precisa terminar depois de começar.',
    path: ['ends_at'],
  })

/**
 * Acrescenta uma faixa de horário a um dia da semana.
 *
 * Faixas, no plural, por dia: o almoço de uma hora é a razão de a tabela existir
 * em vez de duas colunas `abre`/`fecha`. Quem fecha das 12h às 13h cadastra
 * 08:00–12:00 e 13:00–18:00, e o prazo de um chamado aberto 11h50 não corre
 * durante o almoço.
 */
export async function adicionarFaixa(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('sla.horarios.editar')
  if ('error' in gate) return gate

  const parsed = faixaSchema.safeParse({
    business_hours_id: formData.get('business_hours_id'),
    weekday: formData.get('weekday'),
    starts_at: formData.get('starts_at'),
    ends_at: formData.get('ends_at'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('business_hours_intervals')
    .insert({
      ...parsed.data,
      /* O banco guarda `time`; o formulário manda HH:MM. Os segundos são
         explícitos para a comparação do índice único não depender de como o
         PostgREST normaliza a string. */
      starts_at: `${parsed.data.starts_at}:00`,
      ends_at: `${parsed.data.ends_at}:00`,
    })
    .select('id')

  if (error) {
    if (error.code === '23505') {
      return { error: 'Já existe uma faixa começando nesse horário, nesse dia.' }
    }
    return { error: mensagemDeErro(error) }
  }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/sla/horarios')
  return { success: 'Faixa adicionada.' }
}

export async function removerFaixa(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('sla.horarios.editar')
  if ('error' in gate) return gate

  const parsed = z.object({ id: uuid }).safeParse({ id: formData.get('id') })
  if (!parsed.success) return { error: 'Faixa inválida.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('business_hours_intervals')
    .delete()
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/sla/horarios')
  return { success: 'Faixa removida.' }
}

const feriadoSchema = z.object({
  business_hours_id: uuid,
  holiday_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.'),
  /* `name` é NOT NULL no banco, e com razão: uma lista de datas sem nome não
     diz a ninguém por que 2026-02-17 não conta. */
  name: z.string().trim().min(2, 'Diga que feriado é (ex.: Carnaval).').max(120),
})

/**
 * Cadastra um feriado.
 *
 * Data cheia com ano, e não dia/mês recorrente: Carnaval e Corpus Christi mudam
 * de data todo ano, e um "recorrente" que funcionasse só para os fixos seria uma
 * armadilha — a pessoa cadastraria 25/12 recorrente e suporia que o resto
 * também estava coberto.
 */
export async function adicionarFeriado(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('sla.horarios.editar')
  if ('error' in gate) return gate

  const parsed = feriadoSchema.safeParse({
    business_hours_id: formData.get('business_hours_id'),
    holiday_date: formData.get('holiday_date'),
    name: formData.get('name'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('business_hours_holidays')
    .insert(parsed.data)
    .select('id')

  if (error) {
    if (error.code === '23505') return { error: 'Esse dia já está cadastrado como feriado.' }
    return { error: mensagemDeErro(error) }
  }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/sla/horarios')
  return { success: 'Feriado cadastrado. Os prazos deixam de correr nesse dia.' }
}

export async function removerFeriado(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('sla.horarios.editar')
  if ('error' in gate) return gate

  const parsed = z.object({ id: uuid }).safeParse({ id: formData.get('id') })
  if (!parsed.success) return { error: 'Feriado inválido.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('business_hours_holidays')
    .delete()
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/sla/horarios')
  return { success: 'Feriado removido.' }
}
