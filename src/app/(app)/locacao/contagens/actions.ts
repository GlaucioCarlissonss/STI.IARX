'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'
import { emptyToNull, uuid } from '@/lib/schemas/campos'

function revalida() {
  revalidatePath('/locacao/contagens')
  revalidatePath('/locacao/pecas')
}

/**
 * Abre a contagem e CONGELA o esperado.
 *
 * O esperado é fotografado na abertura, e não lido no fechamento: comparar a
 * contagem de ontem com o saldo de hoje transformaria a peça consumida no meio
 * numa "falta" que nunca houve — e o ajuste registraria uma perda inventada.
 */
export async function abrirContagem(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.contagens.contar', {
    mensagem: 'Sem permissão para abrir contagem.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = z
    .object({
      depot_id: uuid,
      code: z.string().trim().min(3, 'Informe o código da contagem.'),
      notes: emptyToNull,
    })
    .safeParse({
      depot_id: formData.get('depot_id'),
      code: formData.get('code'),
      notes: formData.get('notes'),
    })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()

  const { data: aberta } = await supabase
    .from('inventory_counts')
    .select('code')
    .eq('depot_id', parsed.data.depot_id)
    .eq('status', 'open')
    .maybeSingle<{ code: string }>()
  /* Duas contagens abertas no mesmo depósito congelariam o mesmo esperado duas
     vezes, e o segundo fechamento ajustaria uma diferença que o primeiro já
     corrigiu — uma perda contada em dobro. */
  if (aberta) {
    return { error: `Já há a contagem ${aberta.code} aberta neste depósito. Feche-a antes.` }
  }

  const { data: contagem, error } = await supabase
    .from('inventory_counts')
    .insert({
      tenant_id: profile.tenant_id,
      depot_id: parsed.data.depot_id,
      code: parsed.data.code,
      notes: parsed.data.notes,
    })
    .select('id')
    .single<{ id: string }>()

  if (error?.code === '23505') return { error: `Já existe a contagem ${parsed.data.code}.` }
  if (error) return { error: mensagemDeErro(error) }

  const { data: saldos } = await supabase
    .from('part_balances')
    .select('part_id, quantity')
    .eq('depot_id', parsed.data.depot_id)
    .returns<{ part_id: string; quantity: number }[]>()

  if (saldos && saldos.length > 0) {
    const { error: erroItens } = await supabase.from('inventory_count_items').insert(
      saldos.map((s) => ({
        tenant_id: profile.tenant_id,
        count_id: contagem.id,
        part_id: s.part_id,
        expected_quantity: s.quantity,
      })),
    )
    if (erroItens) {
      /* Contagem sem item é uma contagem que fecha sem ajustar nada e parece ter
         dado certo. Prefiro não deixá-la existir. */
      await supabase.from('inventory_counts').delete().eq('id', contagem.id)
      return { error: mensagemDeErro(erroItens) }
    }
  }

  revalida()
  return {
    success: `Contagem ${parsed.data.code} aberta com ${saldos?.length ?? 0} peça(s) a conferir.`,
  }
}

/** Lança a quantidade contada de uma peça. Em branco = ainda não contada. */
export async function lancarContagem(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.contagens.contar', {
    mensagem: 'Sem permissão para lançar contagem.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({
      id: uuid,
      counted_quantity: z
        .string()
        .trim()
        .transform((v) => (v === '' ? null : Number(v)))
        .refine((v) => v === null || (Number.isFinite(v) && v >= 0), {
          message: 'Informe um número maior ou igual a zero.',
        }),
    })
    .safeParse({ id: formData.get('id'), counted_quantity: formData.get('counted_quantity') ?? '' })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('inventory_count_items')
    .update({ counted_quantity: parsed.data.counted_quantity })
    .eq('id', parsed.data.id)
    .select('id')
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalida()
  return { success: 'Contagem lançada.' }
}

/**
 * Fecha a contagem — e é o gatilho da 0053 que gera os ajustes.
 *
 * Esta ação não calcula diferença nenhuma: ela muda o estado, e o banco faz o
 * resto. Calcular aqui também criaria uma segunda implementação da mesma conta,
 * que é como a tela e o razão passam a discordar.
 */
export async function fecharContagem(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.contagens.fechar', {
    papel: 'config',
    mensagem: 'Sem permissão para fechar contagem — o ajuste é perda ou sobra reconhecida.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const id = uuid.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('inventory_counts')
    .update({ status: 'closed', closed_by: profile.id })
    .eq('id', id.data)
    .select('code')
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalida()
  return {
    success: `Contagem ${data[0]?.code} fechada. As diferenças viraram ajustes no razão do estoque.`,
  }
}

export async function cancelarContagem(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('locacao.contagens.contar', {
    mensagem: 'Sem permissão para cancelar contagem.',
  })
  if ('error' in gate) return gate

  const id = uuid.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const supabase = await createClient()
  const { data: contagem } = await supabase
    .from('inventory_counts')
    .select('id, code, status')
    .eq('id', id.data)
    .maybeSingle<{ id: string; code: string; status: string }>()
  if (!contagem) return { error: NAO_AFETADO }
  /* Fechada já virou ajuste no razão, e o razão é imutável. Cancelar aqui não
     desfaria nada — só mentiria sobre o que aconteceu. */
  if (contagem.status === 'closed') {
    return { error: 'Contagem fechada não se cancela: os ajustes já estão no razão.' }
  }

  const { data, error } = await supabase
    .from('inventory_counts')
    .update({ status: 'cancelled' })
    .eq('id', contagem.id)
    .select('id')
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalida()
  return { success: `Contagem ${contagem.code} cancelada — nenhum ajuste foi gerado.` }
}
