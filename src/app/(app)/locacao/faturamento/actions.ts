'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'
import { emptyToNull, uuid } from '@/lib/schemas/campos'
import { calcularFatura, limitesDaCompetencia } from '@/lib/locacao/fatura'
import type { AlocacaoParaFatura } from '@/lib/locacao/fatura'

function revalida() {
  revalidatePath('/locacao/faturamento')
  revalidatePath('/locacao/contratos')
  revalidatePath('/financeiro/titulos-a-receber')
}

/**
 * Gera a prévia da fatura de uma competência — como RASCUNHO.
 *
 * ## Por que o rascunho é a prévia
 *
 * Porque uma prévia que não se grava teria de ser recalculada na emissão, e aí
 * existiriam duas execuções do mesmo cálculo com dados que podem ter mudado no
 * meio. O que a pessoa confere é exatamente o que vai ser emitido: as mesmas
 * linhas, no banco, com a memória de cálculo dentro.
 *
 * Rascunho não cobra nada: não tem título, não tem numeração definitiva no
 * sentido fiscal, e pode ser cancelado sem rastro contábil.
 */
export async function gerarFatura(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.faturamento.faturar', {
    papel: 'config',
    mensagem: 'Sem permissão para gerar fatura.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({ contract_id: uuid, competencia: z.string().regex(/^\d{4}-\d{2}$/, 'Escolha a competência.') })
    .safeParse({
      contract_id: formData.get('contract_id'),
      competencia: formData.get('competencia'),
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const competence = `${parsed.data.competencia}-01`
  const supabase = await createClient()

  const { data: contrato } = await supabase
    .from('rental_contracts')
    /* Sem `code`: ele só servia para montar o número da fatura, e quem numera
       agora é o gatilho da 0056. Campo buscado e não lido vira peso morto que o
       próximo leitor tenta entender. */
    .select('id, client_id, status, billing_day')
    .eq('id', parsed.data.contract_id)
    .maybeSingle<{ id: string; client_id: string; status: string; billing_day: number }>()
  if (!contrato) return { error: NAO_AFETADO }

  if (contrato.status === 'draft' || contrato.status === 'cancelled') {
    return {
      error: `Contrato em ${contrato.status === 'draft' ? 'rascunho' : 'rescisão'} não fatura. Ative-o antes.`,
    }
  }

  const { data: consumo } = await supabase
    .from('vw_rental_consumption')
    .select(
      'contract_item_id, contract_id, equipment_id, asset_tag, meter_kind, monthly_price, franchise, excess_price, delivered_on, returned_on, meter_at_delivery, meter_at_return, meter_now, meter_used',
    )
    .eq('contract_id', contrato.id)
    .returns<
      {
        contract_item_id: string
        equipment_id: string
        asset_tag: string
        monthly_price: number
        franchise: number | null
        excess_price: number | null
        delivered_on: string | null
        returned_on: string | null
        meter_at_delivery: number | null
        meter_at_return: number | null
        meter_now: number
      }[]
    >()

  if (!consumo || consumo.length === 0) {
    return { error: 'Este contrato não tem equipamento entregue — não há o que faturar.' }
  }

  /*
   * As leituras do PERÍODO, e não o medidor de agora.
   *
   * O medidor do equipamento anda; o que importa para a competência é quanto
   * ele marcava no começo e no fim dela. A série da 0050 é quem responde isso —
   * e, quando não há leitura dentro do período, o cálculo não cobra excedente
   * em vez de inventar um.
   */
  const { inicio, fim } = limitesDaCompetencia(competence)
  const deDia = (d: Date) => d.toISOString().slice(0, 10)

  const alocacoes: AlocacaoParaFatura[] = []
  for (const c of consumo) {
    const { data: leituras } = await supabase
      .from('meter_readings')
      .select('reading, read_on')
      .eq('equipment_id', c.equipment_id)
      .lte('read_on', deDia(fim))
      .order('read_on', { ascending: true })
      .returns<{ reading: number; read_on: string }[]>()

    const noPeriodo = (leituras ?? []).filter((l) => l.read_on >= deDia(inicio))
    const antes = (leituras ?? []).filter((l) => l.read_on < deDia(inicio))

    const inicial = antes.at(-1)?.reading ?? c.meter_at_delivery
    const final = noPeriodo.at(-1)?.reading ?? null

    alocacoes.push({
      contract_item_id: c.contract_item_id,
      equipment_id: c.equipment_id,
      asset_tag: c.asset_tag,
      descricao: '',
      monthly_price: Number(c.monthly_price),
      franchise: c.franchise === null ? null : Number(c.franchise),
      excess_price: c.excess_price === null ? null : Number(c.excess_price),
      delivered_on: c.delivered_on,
      returned_on: c.returned_on,
      meter_inicio: inicial === null || inicial === undefined ? null : Number(inicial),
      meter_fim: final === null ? null : Number(final),
    })
  }

  const linhas = calcularFatura(competence, alocacoes)
  if (linhas.length === 0) {
    return {
      error:
        'Nenhum equipamento esteve em operação nesta competência. Confira as datas de entrega e devolução.',
    }
  }

  const vencimento = new Date(fim)
  vencimento.setDate(vencimento.getDate() + contrato.billing_day)

  /*
   * O número NÃO é montado aqui — quem numera é o gatilho da migração 0056.
   *
   * Aqui havia `${contrato.code}/${competencia}`, e o número derivado assim
   * colidia ao refaturar uma competência cancelada: a cancelada continua viva e
   * continua segurando aquele texto. O índice de competência libera a refeita
   * (ele exclui `cancelled`), o índice de número não liberava, e a pessoa levava
   * um erro de chave duplicada numa operação que o modelo autoriza.
   *
   * O gatilho resolve dando sufixo à reemissão (`.../202610-2`) em vez de
   * reciclar o número da cancelada. Ele fica encostado no índice que o obriga, e
   * não a um `insert` de distância dele.
   */
  const { data: fatura, error } = await supabase
    .from('rental_invoices')
    .insert({
      tenant_id: profile.tenant_id,
      contract_id: contrato.id,
      client_id: contrato.client_id,
      competence,
      status: 'draft',
      due_on: deDia(vencimento),
    })
    .select('id')
    .single<{ id: string }>()

  if (error) return { error: mensagemDeErro(error) }

  const { error: erroItens } = await supabase.from('rental_invoice_items').insert(
    linhas.map((l) => ({
      tenant_id: profile.tenant_id,
      invoice_id: fatura.id,
      contract_item_id: l.contract_item_id,
      equipment_id: l.equipment_id,
      kind: l.kind,
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unit_price,
      amount: l.amount,
      meter_from: l.meter_from,
      meter_to: l.meter_to,
      days: l.days,
    })),
  )
  if (erroItens) return { error: mensagemDeErro(erroItens) }

  revalida()
  return {
    success: `Prévia gerada: ${linhas.length} linha(s). Confira antes de emitir — rascunho não cobra nada.`,
  }
}

/**
 * Emite a fatura e gera o título a receber.
 *
 * O título nasce AQUI e não antes: rascunho é cálculo, fatura emitida é
 * cobrança. O vínculo fica nos dois sentidos — a fatura guarda o id do título,
 * e o título guarda o número da fatura em `document_ref`.
 */
export async function emitirFatura(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.faturamento.faturar', {
    papel: 'config',
    mensagem: 'Sem permissão para emitir fatura.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const id = uuid.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const supabase = await createClient()
  const { data: fatura } = await supabase
    .from('rental_invoices')
    .select('id, contract_id, client_id, number, competence, status, total, due_on')
    .eq('id', id.data)
    .maybeSingle<{
      id: string
      contract_id: string
      client_id: string
      number: string
      competence: string
      status: string
      total: number
      due_on: string | null
    }>()
  if (!fatura) return { error: NAO_AFETADO }
  if (fatura.status !== 'draft') return { error: 'Só rascunho é emitido.' }

  const hoje = new Date().toISOString().slice(0, 10)
  const { data: titulo, error: erroTitulo } = await supabase
    .from('receivables')
    .insert({
      tenant_id: profile.tenant_id,
      client_id: fatura.client_id,
      description: `Locação — fatura ${fatura.number}`,
      document_ref: fatura.number,
      amount: fatura.total,
      issued_on: hoje,
      due_on: fatura.due_on ?? hoje,
      status: 'open',
    })
    .select('id')
    .single<{ id: string }>()

  if (erroTitulo) return { error: mensagemDeErro(erroTitulo) }

  const { data, error } = await supabase
    .from('rental_invoices')
    .update({ status: 'issued', issued_on: hoje, receivable_id: titulo.id })
    .eq('id', fatura.id)
    .select('id')
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalida()
  return {
    success: `Fatura ${fatura.number} emitida e título a receber gerado no financeiro.`,
  }
}

/**
 * Cancela a fatura — e o título que ela gerou.
 *
 * Os dois juntos, sempre: fatura cancelada com título vivo é cobrança sem
 * documento, e é exatamente o que o cliente contesta.
 */
export async function cancelarFatura(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.faturamento.cancelar', {
    papel: 'config',
    mensagem: 'Sem permissão para cancelar fatura.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({ id: uuid, motivo: emptyToNull })
    .safeParse({ id: formData.get('id'), motivo: formData.get('motivo') })
  if (!parsed.success) return { error: 'Registro inválido.' }

  const supabase = await createClient()
  const { data: fatura } = await supabase
    .from('rental_invoices')
    .select('id, number, status, receivable_id, notes')
    .eq('id', parsed.data.id)
    .maybeSingle<{
      id: string
      number: string
      status: string
      receivable_id: string | null
      notes: string | null
    }>()
  if (!fatura) return { error: NAO_AFETADO }
  if (fatura.status === 'cancelled') return { error: 'Esta fatura já está cancelada.' }

  if (fatura.receivable_id) {
    const { error: erroTitulo } = await supabase
      .from('receivables')
      .update({ status: 'cancelled' })
      .eq('id', fatura.receivable_id)
    if (erroTitulo) return { error: mensagemDeErro(erroTitulo) }
  }

  const { data, error } = await supabase
    .from('rental_invoices')
    .update({
      status: 'cancelled',
      notes: [fatura.notes, parsed.data.motivo && `Cancelada: ${parsed.data.motivo}`]
        .filter(Boolean)
        .join('\n'),
    })
    .eq('id', fatura.id)
    .select('id')
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalida()
  return {
    success: fatura.receivable_id
      ? `Fatura ${fatura.number} cancelada, e o título a receber junto.`
      : `Fatura ${fatura.number} cancelada.`,
  }
}
