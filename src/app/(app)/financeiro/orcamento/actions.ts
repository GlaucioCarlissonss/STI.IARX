'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { optionalUuid, uuid } from '@/lib/schemas/campos'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'
import { paraInterno } from '@/lib/projetos/competencia'
import { ocorrenciasDaRecorrencia, ratear, somar } from '@/lib/orcamento/rateio'

/**
 * O orçamento de TI.
 *
 * ## Três escritas, três permissões
 *
 * `lancar` cria e edita lançamento; `fechar` fecha e reabre competência. São
 * atos diferentes de propósito: quem lança não decide quando o mês para de
 * aceitar lançamento, e é o fechamento que dá sentido a um número divulgado.
 *
 * ## A trava do mês fechado não está aqui
 *
 * Ela está na trigger `trg_entry_fechamento`, no banco — inclusive para a
 * importação e para qualquer caminho que não passe por estas funções. O que
 * estas ações fazem é traduzir a exceção dela para uma frase que diz o que
 * fazer.
 */

const competencia = z
  .string()
  .transform((v) => paraInterno(v))
  .refine((v): v is string => v !== null, 'Informe o mês no formato MM/AAAA.')

const competenciaOpcional = z
  .union([z.literal(''), z.string()])
  .transform((v) => (v === '' ? null : paraInterno(v)))

const lancamentoSchema = z
  .object({
    client_id: uuid,
    branch_id: optionalUuid,
    expense_category_id: uuid,
    cost_center_id: optionalUuid,
    supplier_id: optionalUuid,
    scenario_id: uuid,
    competence: competencia,
    amount: z.coerce.number().min(0, 'O valor não pode ser negativo.').max(999999999),
    description: z
      .string()
      .trim()
      .max(400)
      .optional()
      .transform((v) => (v ? v : null)),
    natureza: z.enum(['fixa', 'pontual_unica', 'pontual_parcelada']),
    classificacao: z.enum(['despesa', 'investimento']),
    consumo: z.enum(['integral', 'compartilhado']),
    installment_total: z.coerce.number().int().min(1).max(360).optional(),
    recurrence_until: competenciaOpcional,
    /**
     * O valor informado é o total do contrato ou o de cada parcela?
     *
     * As duas leituras existem na vida real — "R$ 12.000 em 12x" e "12x de
     * R$ 1.000" —, e supor uma delas erraria o total por doze.
     */
    valor_e_total: z.coerce.boolean(),
  })
  .refine((d) => d.natureza !== 'pontual_parcelada' || (d.installment_total ?? 0) >= 2, {
    message: 'Um lançamento parcelado precisa de pelo menos 2 parcelas.',
    path: ['installment_total'],
  })

function dados(formData: FormData) {
  return {
    client_id: formData.get('client_id'),
    branch_id: formData.get('branch_id'),
    expense_category_id: formData.get('expense_category_id'),
    cost_center_id: formData.get('cost_center_id'),
    supplier_id: formData.get('supplier_id'),
    scenario_id: formData.get('scenario_id'),
    competence: formData.get('competence'),
    amount: formData.get('amount'),
    description: formData.get('description') ?? '',
    natureza: formData.get('natureza') ?? 'pontual_unica',
    classificacao: formData.get('classificacao') ?? 'despesa',
    consumo: formData.get('consumo') ?? 'integral',
    installment_total: formData.get('installment_total') || undefined,
    recurrence_until: formData.get('recurrence_until') ?? '',
    valor_e_total: formData.get('valor_e_total') === 'on',
  }
}

/** Horizonte da projeção de uma recorrência em aberto: 24 meses à frente. */
const HORIZONTE_MESES = 24

/**
 * Lança um custo — e, nas naturezas que se repetem, a série inteira.
 *
 * ## Por que a série é gravada, e não calculada na leitura
 *
 * Porque cada ocorrência é editável por si: um contrato de licença que reajusta
 * em julho tem onze meses de um valor e um de outro. Uma série calculada na
 * leitura não teria onde guardar a exceção, e a exceção é o caso normal.
 */
export async function lancarCusto(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('financeiro.orcamento.lancar', {
    mensagem: 'Sem permissão para lançar no orçamento.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = lancamentoSchema.safeParse(dados(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  const d = parsed.data

  const comum = {
    tenant_id: profile.tenant_id,
    client_id: d.client_id,
    branch_id: d.branch_id,
    expense_category_id: d.expense_category_id,
    cost_center_id: d.cost_center_id,
    supplier_id: d.supplier_id,
    scenario_id: d.scenario_id,
    description: d.description,
    natureza: d.natureza,
    classificacao: d.classificacao,
    consumo: d.consumo,
    origem: 'manual' as const,
    created_by: profile.id,
  }

  const supabase = await createClient()

  /* --- Pontual única: uma linha e pronto. --- */
  if (d.natureza === 'pontual_unica') {
    const { data, error } = await supabase
      .from('it_cost_entries')
      .insert({ ...comum, competence: d.competence, amount: d.amount })
      .select('id')
    if (error) return { error: mensagemDeErro(error) }
    if (!data || data.length === 0) return { error: NAO_AFETADO }
    revalidatePath('/financeiro/orcamento')
    return { success: 'Custo lançado.' }
  }

  /* --- Parcelada: a soma das parcelas fecha exatamente no total. --- */
  if (d.natureza === 'pontual_parcelada') {
    const n = d.installment_total!
    const valores = d.valor_e_total ? ratear(d.amount, n) : Array.from({ length: n }, () => d.amount)

    const meses = ocorrenciasDaRecorrencia(d.competence, null, mesesDepois(d.competence, n - 1))
    if (meses.length !== n) return { error: 'Não foi possível montar a série de parcelas.' }

    /* A parcela 1 primeiro, porque as demais apontam para ela — é o que preserva
       a série e permite responder "quanto falta deste contrato". */
    const { data: primeira, error: erroPrimeira } = await supabase
      .from('it_cost_entries')
      .insert({
        ...comum,
        competence: meses[0]!,
        amount: valores[0]!,
        installment_number: 1,
        installment_total: n,
      })
      .select('id')
    if (erroPrimeira) return { error: mensagemDeErro(erroPrimeira) }
    if (!primeira || primeira.length === 0) return { error: NAO_AFETADO }

    const restantes = meses.slice(1).map((mes, i) => ({
      ...comum,
      competence: mes,
      amount: valores[i + 1]!,
      installment_number: i + 2,
      installment_total: n,
      parent_entry_id: primeira[0]!.id,
    }))

    if (restantes.length > 0) {
      const { error } = await supabase.from('it_cost_entries').insert(restantes)
      /*
       * Se uma parcela cair num mês FECHADO, a trigger recusa — e aí a série
       * fica pela metade. Dizer isso é melhor que o silêncio: a parcela 1 já
       * existe, e quem lançou precisa saber que as outras não.
       */
      if (error) {
        return {
          error: `A parcela 1 foi lançada, mas as demais não: ${mensagemDeErro(error)}`,
        }
      }
    }

    revalidatePath('/financeiro/orcamento')
    const total = somar(valores)
    return {
      success: `${n} parcelas lançadas, somando ${total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.`,
    }
  }

  /* --- Fixa: uma ocorrência por mês até a vigência (ou o horizonte). --- */
  const meses = ocorrenciasDaRecorrencia(
    d.competence,
    d.recurrence_until ?? null,
    mesesDepois(d.competence, HORIZONTE_MESES),
  )
  if (meses.length === 0) return { error: 'A vigência termina antes de começar.' }

  const { data: primeira, error: erroPrimeira } = await supabase
    .from('it_cost_entries')
    .insert({
      ...comum,
      competence: meses[0]!,
      amount: d.amount,
      recurrence_until: d.recurrence_until,
    })
    .select('id')
  if (erroPrimeira) return { error: mensagemDeErro(erroPrimeira) }
  if (!primeira || primeira.length === 0) return { error: NAO_AFETADO }

  const restantes = meses.slice(1).map((mes) => ({
    ...comum,
    competence: mes,
    amount: d.amount,
    recurrence_until: d.recurrence_until,
    parent_entry_id: primeira[0]!.id,
  }))

  if (restantes.length > 0) {
    const { error } = await supabase.from('it_cost_entries').insert(restantes)
    if (error) return { error: `A primeira ocorrência entrou, as demais não: ${mensagemDeErro(error)}` }
  }

  revalidatePath('/financeiro/orcamento')
  return {
    success: d.recurrence_until
      ? `${meses.length} ocorrências lançadas, até ${d.recurrence_until.slice(5, 7)}/${d.recurrence_until.slice(0, 4)}.`
      : `${meses.length} ocorrências lançadas (${HORIZONTE_MESES} meses à frente). Sem vigência, a projeção fica em aberto — estenda quando precisar.`,
  }
}

function mesesDepois(competencia: string, n: number): string {
  const [ano, mes] = competencia.slice(0, 7).split('-').map(Number)
  const total = ano! * 12 + (mes! - 1) + n
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`
}

/* -------------------------------------------------------------- Importação */

export interface ImportacaoState extends ActionState {
  resumo?: { importados: number; ja_existiam: number; valor_total: number }
}

/**
 * Traz os títulos a pagar de uma competência para o orçamento.
 *
 * É a ponte que impede a segunda verdade sobre o mesmo dinheiro: em vez de
 * redigitar o que já está em `payables`, o orçamento importa, com o
 * `payable_id` gravado e índice único. Rodar duas vezes não duplica — e vai
 * rodar duas vezes, porque quem importa não tem como saber se já importou.
 */
export async function importarTitulos(
  _prev: ImportacaoState,
  formData: FormData,
): Promise<ImportacaoState> {
  const gate = await permitirEscrita('financeiro.orcamento.lancar', {
    mensagem: 'Sem permissão para importar títulos.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({ client_id: uuid, scenario_id: uuid, competence: competencia })
    .safeParse({
      client_id: formData.get('client_id'),
      scenario_id: formData.get('scenario_id'),
      competence: formData.get('competence'),
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('orcamento_importar_titulos', {
    p_client_id: parsed.data.client_id,
    p_competence: parsed.data.competence,
    p_scenario_id: parsed.data.scenario_id,
  })

  if (error) return { error: mensagemDeErro(error) }

  const resumo = (Array.isArray(data) ? data[0] : null) as
    | { importados: number; ja_existiam: number; valor_total: number }
    | null
  if (!resumo) return { error: 'A importação não devolveu resultado.' }

  revalidatePath('/financeiro/orcamento')

  if (resumo.importados === 0) {
    return {
      resumo,
      success:
        resumo.ja_existiam > 0
          ? `Nada a importar: os ${resumo.ja_existiam} título(s) desta competência já estão no orçamento.`
          : 'Nenhum título a pagar vence nesta competência.',
    }
  }

  return {
    resumo,
    success: `${resumo.importados} título(s) importados${
      resumo.ja_existiam > 0 ? `, ${resumo.ja_existiam} já estavam` : ''
    }.`,
  }
}

/* -------------------------------------------------------------- Fechamento */

export async function fecharCompetencia(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('financeiro.orcamento.fechar', {
    mensagem: 'Sem permissão para fechar a competência.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      client_id: uuid,
      competence: competencia,
      note: z
        .string()
        .trim()
        .max(400)
        .optional()
        .transform((v) => (v ? v : null)),
    })
    .safeParse({
      client_id: formData.get('client_id'),
      competence: formData.get('competence'),
      note: formData.get('note') ?? '',
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('it_budget_closings')
    .upsert(
      {
        tenant_id: profile.tenant_id,
        client_id: parsed.data.client_id,
        competence: parsed.data.competence,
        note: parsed.data.note,
        closed_at: new Date().toISOString(),
        closed_by: profile.id,
        /* Fechar de novo limpa a reabertura anterior — senão a linha ficaria
           fechada e reaberta ao mesmo tempo. */
        reopened_at: null,
        reopened_by: null,
        reopen_reason: null,
      },
      { onConflict: 'client_id,competence' },
    )
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/financeiro/orcamento')
  return {
    success:
      'Competência fechada. Nenhum lançamento entra, sai ou muda nela — nem por importação.',
  }
}

export async function reabrirCompetencia(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('financeiro.orcamento.fechar', {
    mensagem: 'Sem permissão para reabrir a competência.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      id: uuid,
      /* Reabrir exige motivo — o banco também recusa sem ele. "Fechei e reabri"
         sem causa é um evento que ninguém consegue explicar depois, e a causa é
         a única coisa que alguém vai querer saber. */
      reason: z.string().trim().min(5, 'Diga por que a competência está sendo reaberta.').max(400),
    })
    .safeParse({ id: formData.get('id'), reason: formData.get('reason') })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('it_budget_closings')
    .update({
      reopened_at: new Date().toISOString(),
      reopened_by: profile.id,
      reopen_reason: parsed.data.reason,
    })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/financeiro/orcamento')
  return { success: 'Competência reaberta. A reabertura fica registrada, com o motivo.' }
}

/* ------------------------------------------------------------------ Metas */

export async function salvarMeta(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('financeiro.orcamento.lancar', {
    mensagem: 'Sem permissão para definir metas.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      client_id: uuid,
      name: z.string().trim().min(2, 'Dê um nome à meta.').max(120),
      expense_category_id: optionalUuid,
      branch_id: optionalUuid,
      monthly_cap: z.coerce.number().min(0).max(999999999),
      valid_from: competenciaOpcional,
      valid_until: competenciaOpcional,
    })
    .safeParse({
      client_id: formData.get('client_id'),
      name: formData.get('name'),
      expense_category_id: formData.get('expense_category_id'),
      branch_id: formData.get('branch_id'),
      monthly_cap: formData.get('monthly_cap'),
      valid_from: formData.get('valid_from') ?? '',
      valid_until: formData.get('valid_until') ?? '',
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('it_budget_targets')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })
    .select('id')

  if (error) {
    if (error.code === '23505') return { error: 'Já existe uma meta com esse nome neste cliente.' }
    return { error: mensagemDeErro(error) }
  }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/financeiro/orcamento')
  return { success: 'Meta definida.' }
}
