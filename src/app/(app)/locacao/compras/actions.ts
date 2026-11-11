'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'
import { emptyToNull, optionalNonNegativeNumber, optionalUuid, uuid } from '@/lib/schemas/campos'

function revalida() {
  revalidatePath('/locacao/compras')
  revalidatePath('/locacao/pecas')
  revalidatePath('/financeiro/titulos-a-pagar')
}

const quantidadePositiva = z
  .string()
  .trim()
  .transform((v) => Number(v))
  .refine((v) => Number.isFinite(v) && v > 0, { message: 'A quantidade é maior que zero.' })

export async function salvarOrdem(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.compras.gerenciar', {
    papel: 'config',
    mensagem: 'Sem permissão para criar ordem de compra.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      id: optionalUuid,
      code: z.string().trim().min(3, 'Informe o número da ordem.'),
      supplier_id: optionalUuid,
      depot_id: uuid,
      expected_on: emptyToNull,
      notes: emptyToNull,
    })
    .safeParse({
      id: formData.get('id'),
      code: formData.get('code'),
      supplier_id: formData.get('supplier_id'),
      depot_id: formData.get('depot_id'),
      expected_on: formData.get('expected_on'),
      notes: formData.get('notes'),
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const { id, ...campos } = parsed.data
  const supabase = await createClient()

  const { data, error } = id
    ? await supabase.from('purchase_orders').update(campos).eq('id', id).select('id')
    : await supabase
        .from('purchase_orders')
        .insert({ ...campos, tenant_id: profile.tenant_id })
        .select('id')

  if (error?.code === '23505') return { error: `Já existe uma ordem com o número ${campos.code}.` }
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalida()
  return { success: id ? 'Ordem atualizada.' : `Ordem ${campos.code} criada como rascunho.` }
}

/** Acrescenta uma linha. O total da ordem é refeito pelo gatilho da 0053. */
export async function salvarItem(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.compras.gerenciar', {
    papel: 'config',
    mensagem: 'Sem permissão para editar itens da ordem.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      order_id: uuid,
      part_id: uuid,
      quantity: quantidadePositiva,
      unit_price: optionalNonNegativeNumber,
    })
    .safeParse({
      order_id: formData.get('order_id'),
      part_id: formData.get('part_id'),
      quantity: formData.get('quantity'),
      unit_price: formData.get('unit_price') ?? '',
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const preco = parsed.data.unit_price ?? 0
  const supabase = await createClient()
  const { error } = await supabase.from('purchase_order_items').insert({
    tenant_id: profile.tenant_id,
    order_id: parsed.data.order_id,
    part_id: parsed.data.part_id,
    quantity: parsed.data.quantity,
    unit_price: preco,
    amount: Number((parsed.data.quantity * preco).toFixed(2)),
  })
  if (error) return { error: mensagemDeErro(error) }

  revalida()
  return { success: 'Item acrescentado à ordem.' }
}

export async function removerItem(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.compras.gerenciar', {
    papel: 'config',
    mensagem: 'Sem permissão para editar itens da ordem.',
  })
  if ('error' in gate) return gate

  const id = uuid.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const supabase = await createClient()
  const { data: item } = await supabase
    .from('purchase_order_items')
    .select('id, received_quantity')
    .eq('id', id.data)
    .maybeSingle<{ id: string; received_quantity: number }>()
  if (!item) return { error: NAO_AFETADO }

  /* Item já recebido tem movimento de estoque atrás dele. Apagá-lo deixaria a
     entrada sem origem — e o razão precisa poder explicar cada saldo. */
  if (Number(item.received_quantity) > 0) {
    return { error: 'Este item já teve recebimento. Cancele a ordem em vez de apagar a linha.' }
  }

  const { data, error } = await supabase
    .from('purchase_order_items')
    .delete()
    .eq('id', id.data)
    .select('id')
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalida()
  return { success: 'Item removido.' }
}

export async function moverOrdem(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.compras.gerenciar', {
    papel: 'config',
    mensagem: 'Sem permissão para mover a ordem.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({ id: uuid, status: z.enum(['draft', 'sent', 'cancelled']) })
    .safeParse({ id: formData.get('id'), status: formData.get('status') })
  if (!parsed.success) return { error: 'Registro inválido.' }

  const supabase = await createClient()
  const { data: ordem } = await supabase
    .from('purchase_orders')
    .select('id, code, status, payable_id')
    .eq('id', parsed.data.id)
    .maybeSingle<{ id: string; code: string; status: string; payable_id: string | null }>()
  if (!ordem) return { error: NAO_AFETADO }

  if (parsed.data.status === 'cancelled' && ordem.payable_id) {
    return {
      error:
        'Esta ordem já gerou título a pagar. Cancele o título no financeiro antes — senão a cobrança fica viva sem a compra.',
    }
  }
  if (parsed.data.status === 'sent' && ordem.status !== 'draft') {
    return { error: 'Só rascunho é enviado.' }
  }

  const { data, error } = await supabase
    .from('purchase_orders')
    .update({ status: parsed.data.status })
    .eq('id', ordem.id)
    .select('id')
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalida()
  return {
    success:
      parsed.data.status === 'sent'
        ? `Ordem ${ordem.code} enviada ao fornecedor.`
        : `Ordem ${ordem.code} cancelada.`,
  }
}

/**
 * Recebe mercadoria — e é aqui que o estoque cresce.
 *
 * O recebimento é PARCIAL por natureza: cada entrega gera seu próprio movimento,
 * com a quantidade que chegou de verdade. A ordem só vira `received` quando
 * todas as linhas se completam; até lá fica `partial`, e continua cobrando o
 * fornecedor pelo que falta.
 */
export async function receberItem(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.compras.receber', {
    mensagem: 'Sem permissão para receber mercadoria.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({ item_id: uuid, quantity: quantidadePositiva })
    .safeParse({ item_id: formData.get('item_id'), quantity: formData.get('quantity') })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data: item } = await supabase
    .from('purchase_order_items')
    .select('id, order_id, part_id, quantity, unit_price, received_quantity')
    .eq('id', parsed.data.item_id)
    .maybeSingle<{
      id: string
      order_id: string
      part_id: string
      quantity: number
      unit_price: number
      received_quantity: number
    }>()
  if (!item) return { error: NAO_AFETADO }

  const falta = Number(item.quantity) - Number(item.received_quantity)
  if (parsed.data.quantity > falta) {
    return {
      error: `Faltam ${falta} nesta linha. Receber mais do que foi pedido esconderia uma divergência de entrega.`,
    }
  }

  const { data: ordem } = await supabase
    .from('purchase_orders')
    .select('id, code, depot_id, status')
    .eq('id', item.order_id)
    .maybeSingle<{ id: string; code: string; depot_id: string; status: string }>()
  if (!ordem) return { error: NAO_AFETADO }
  if (ordem.status === 'cancelled') return { error: 'Ordem cancelada não recebe mercadoria.' }

  const { error: erroMov } = await supabase.from('part_movements').insert({
    tenant_id: profile.tenant_id,
    part_id: item.part_id,
    depot_id: ordem.depot_id,
    kind: 'purchase',
    quantity: parsed.data.quantity,
    unit_cost: item.unit_price,
    purchase_order_id: ordem.id,
    notes: `Recebimento da ordem ${ordem.code}`,
    created_by: profile.id,
  })
  if (erroMov) return { error: mensagemDeErro(erroMov) }

  const { error: erroItem } = await supabase
    .from('purchase_order_items')
    .update({ received_quantity: Number(item.received_quantity) + parsed.data.quantity })
    .eq('id', item.id)
  if (erroItem) return { error: mensagemDeErro(erroItem) }

  /* O estado da ordem é DERIVADO das linhas, e relido depois da escrita: supor
     o novo estado a partir do que acabamos de mandar erraria sempre que duas
     pessoas recebessem ao mesmo tempo. */
  const { data: linhas } = await supabase
    .from('purchase_order_items')
    .select('quantity, received_quantity')
    .eq('order_id', ordem.id)
    .returns<{ quantity: number; received_quantity: number }[]>()

  const completas = (linhas ?? []).every(
    (l) => Number(l.received_quantity) >= Number(l.quantity),
  )
  await supabase
    .from('purchase_orders')
    .update({ status: completas ? 'received' : 'partial' })
    .eq('id', ordem.id)

  revalida()
  return {
    success: completas
      ? `Recebido. A ordem ${ordem.code} está completa.`
      : `Recebido. A ordem ${ordem.code} segue com entrega pendente.`,
  }
}

/**
 * Registra a NF e gera o TÍTULO A PAGAR que já existe no financeiro.
 *
 * Simétrico à fatura de locação, que gera o título a receber. O segundo
 * financeiro é a forma clássica de um sistema passar a ter duas verdades sobre
 * o mesmo dinheiro — aqui a compra aponta para o título, e o título guarda o
 * número da nota.
 */
export async function registrarNota(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.compras.faturar', {
    papel: 'config',
    mensagem: 'Sem permissão para registrar nota fiscal.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      id: uuid,
      invoice_ref: z.string().trim().min(1, 'Informe o número da nota.'),
      due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe o vencimento.'),
    })
    .safeParse({
      id: formData.get('id'),
      invoice_ref: formData.get('invoice_ref'),
      due_on: formData.get('due_on'),
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data: ordem } = await supabase
    .from('purchase_orders')
    .select('id, code, supplier_id, status, total, payable_id')
    .eq('id', parsed.data.id)
    .maybeSingle<{
      id: string
      code: string
      supplier_id: string | null
      status: string
      total: number
      payable_id: string | null
    }>()
  if (!ordem) return { error: NAO_AFETADO }
  if (ordem.payable_id) return { error: 'Esta ordem já gerou título a pagar.' }
  if (ordem.status === 'cancelled') return { error: 'Ordem cancelada não gera título.' }
  if (Number(ordem.total) <= 0) return { error: 'Ordem sem valor não gera título a pagar.' }

  const hoje = new Date().toISOString().slice(0, 10)
  const { data: titulo, error: erroTitulo } = await supabase
    .from('payables')
    .insert({
      tenant_id: profile.tenant_id,
      supplier_id: ordem.supplier_id,
      description: `Peças — ordem ${ordem.code}`,
      document_ref: parsed.data.invoice_ref,
      amount: ordem.total,
      issued_on: hoje,
      due_on: parsed.data.due_on,
      status: 'draft',
    })
    .select('id')
    .single<{ id: string }>()
  if (erroTitulo) return { error: mensagemDeErro(erroTitulo) }

  const { data, error } = await supabase
    .from('purchase_orders')
    .update({ invoice_ref: parsed.data.invoice_ref, payable_id: titulo.id })
    .eq('id', ordem.id)
    .select('id')
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalida()
  return {
    success: `Nota ${parsed.data.invoice_ref} registrada e título a pagar criado no financeiro.`,
  }
}
