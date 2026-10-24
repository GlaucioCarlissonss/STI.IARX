'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { ActionState } from '@/lib/actions/estado'

/**
 * Grava a nota. Não há sessão, não há permissão a checar: o token É a
 * autorização, e quem o valida é `public.submit_satisfaction` no banco.
 */
const avaliacaoSchema = z.object({
  token: z.string().min(16, 'Link inválido.'),
  score: z.coerce.number().int().min(1).max(5),
  comment: z
    .string()
    .trim()
    .max(2000, 'O comentário pode ter no máximo 2.000 caracteres.')
    .optional(),
})

export async function enviarAvaliacao(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = avaliacaoSchema.safeParse({
    token: formData.get('token'),
    score: formData.get('score'),
    comment: formData.get('comment') ?? undefined,
  })
  if (!parsed.success) return { error: 'Escolha uma nota de 1 a 5.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('submit_satisfaction', {
    p_token: parsed.data.token,
    p_score: parsed.data.score,
    p_comment: parsed.data.comment ?? null,
  })

  /*
   * A função devolve só `true`/`false`, e `false` cobre três casos: token que
   * não existe, já respondido e expirado. A mensagem aqui é uma só, de
   * propósito — distinguir os três diria a quem estivesse tentando adivinhar um
   * token qual dos três ele acertou.
   */
  if (error || data !== true) {
    return { error: 'Não foi possível registrar. O link pode ter expirado ou já ter sido usado.' }
  }

  return { success: 'Obrigado! A sua avaliação foi registrada.' }
}
