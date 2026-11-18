'use server'

import { headers } from 'next/headers'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { modoLocal } from '@/lib/db/modo'
import { ipDoCliente, origemHasheada, permitirRequisicao } from '@/lib/limite'
import type { ActionState } from '@/lib/actions/estado'

const aceiteSchema = z.object({
  token: z.string().min(1),
  nome: z.string().trim().min(2, 'Informe o seu nome.').max(120),
  senha: z.string().min(12, 'A senha precisa de pelo menos 12 caracteres.').max(200),
})

/**
 * Aceita o convite e cria a conta.
 *
 * ## Por que aqui a conta nasce ATIVA
 *
 * O cadastro público (0060) manda confirmar o e-mail porque qualquer um pode
 * digitar o endereço de outra pessoa. Aqui o link JÁ foi para o endereço
 * convidado: abri-lo é a prova de que quem está ali lê aquela caixa — a mesma
 * prova que a confirmação produziria.
 *
 * Pedir confirmação depois do convite seria pedir duas vezes o mesmo, e cada
 * passo a mais perde gente que nunca chega a usar o produto.
 */
export async function aceitarConvite(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = aceiteSchema.safeParse({
    token: formData.get('token'),
    nome: formData.get('nome'),
    senha: formData.get('senha'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  if (!modoLocal()) {
    return { error: 'O aceite de convite não está disponível neste ambiente.' }
  }

  const admin = createAdminClient()

  /* Mesmo balde do cadastro: é a mesma porta pública criando conta, e separar
     os contadores daria a quem quisesse o dobro das tentativas. */
  const cabecalhos = await headers()
  const origem = origemHasheada(
    ipDoCliente({
      xForwardedFor: cabecalhos.get('x-forwarded-for'),
      xRealIp: cabecalhos.get('x-real-ip'),
    }),
  )
  if (!(await permitirRequisicao(admin, 'signup', origem))) {
    return { error: 'Tente novamente em alguns minutos.' }
  }

  const { data, error } = await admin.schema('app').rpc('aceitar_convite', {
    p_token: parsed.data.token,
    p_nome: parsed.data.nome,
    p_senha: parsed.data.senha,
  })

  if (error) {
    console.error('[convite] falha ao aceitar:', error.message)
    return { error: 'Não foi possível concluir agora. Tente novamente em alguns minutos.' }
  }

  /*
   * Uma mensagem só para "vencido", "já usado" e "inventado" — e também para o
   * caso raro de o endereço ter ganhado conta entre o convite e o aceite. Nos
   * quatro, a instrução útil é a mesma: peça um convite novo.
   */
  if (!data) {
    return { error: 'Este convite não vale mais. Peça um novo a quem administra a empresa.' }
  }

  return { success: 'Conta criada. Entre com o seu e-mail e a senha que você escolheu.' }
}
