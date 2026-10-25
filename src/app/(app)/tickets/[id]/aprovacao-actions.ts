'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession } from '@/lib/session'
import { mensagemDeErro } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'

const schema = z.object({
  ticket_id: z.string().uuid(),
  aprovado: z.enum(['sim', 'nao']),
  motivo: z.string().trim().max(2000).optional(),
})

/**
 * Aprova ou recusa um pedido de serviço.
 *
 * ## Por que esta ação é tão fina
 *
 * Porque a decisão inteira acontece em `decidir_pedido()`, no banco: o registro
 * da aprovação, o estado do chamado e o comentário com o motivo mudam **numa
 * transação só**.
 *
 * Em três chamadas daqui, uma falha de rede no meio deixaria o pedido aprovado
 * com o chamado ainda parado — ou o contrário. Nenhum dos dois estados é
 * distinguível de um defeito quando alguém for olhar seis meses depois, e os
 * dois exigiriam conserto à mão no banco.
 *
 * A permissão também é conferida lá: `autoatendimento.catalogo.aprovar` **e** o
 * perfil de acesso que o serviço exigir. Repetir a checagem aqui daria uma
 * mensagem mais bonita e uma segunda fonte de verdade — e a segunda fonte é a
 * que fica desatualizada.
 */
export async function decidirPedido(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSession()

  const parsed = schema.safeParse({
    ticket_id: formData.get('ticket_id'),
    aprovado: formData.get('aprovado'),
    motivo: formData.get('motivo') ?? '',
  })
  if (!parsed.success) return { error: 'Decisão inválida.' }

  const aprovado = parsed.data.aprovado === 'sim'
  if (!aprovado && (parsed.data.motivo ?? '').length < 3) {
    /* O banco também recusa. Esta mensagem diz o que fazer, e evita a ida e
       volta que termina em "violates check constraint". */
    return {
      error:
        'Escreva o motivo da recusa. Sem ele, o mesmo pedido volta na semana que vem e custa o tempo de todo mundo de novo.',
    }
  }

  const supabase = await createClient()
  const { error } = await supabase.rpc('decidir_pedido', {
    p_ticket_id: parsed.data.ticket_id,
    p_aprovado: aprovado,
    p_motivo: parsed.data.motivo || null,
  })

  if (error) return { error: mensagemDeErro(error) }

  revalidatePath(`/tickets/${parsed.data.ticket_id}`)
  revalidatePath('/tickets')
  return {
    success: aprovado
      ? 'Pedido aprovado. O chamado voltou a andar e o relógio do SLA recomeçou.'
      : 'Pedido recusado. O chamado foi fechado com o motivo registrado.',
  }
}
