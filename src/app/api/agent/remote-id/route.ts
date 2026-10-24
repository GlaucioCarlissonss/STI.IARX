import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAnonClient } from '@/lib/supabase/anon'
import { lerCorpoLimitado, tokenDoAgente, LIMITE_INSCRICAO } from '../corpo'

/**
 * A máquina registra o próprio id no serviço de acesso remoto.
 *
 * ## O que esta plataforma faz, e o que não faz
 *
 * Ela **não implementa controle remoto de tela**. Isso é um produto inteiro —
 * NAT traversal, relay, codec, latência, segurança — e construí-lo aqui custaria
 * meses para entregar pior que o RustDesk auto-hospedado, que é open source e
 * entrega o recurso em dias.
 *
 * O que cabe aqui é o pedaço que só esta plataforma pode fazer: saber **qual id
 * do RustDesk pertence a qual máquina do inventário**. É o elo que falta, e é
 * barato. O resto é um link.
 *
 * Rota separada da ingestão porque o id muda quase nunca: o RustDesk o gera uma
 * vez e o guarda. Mandá-lo junto de cada lote de métricas seria repetir a mesma
 * string 288 vezes por dia.
 */

const corpoSchema = z.object({
  remote_id: z.string().trim().max(120),
})

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const token = tokenDoAgente(request)
  if (!token) {
    return NextResponse.json({ erro: 'Token da máquina ausente.' }, { status: 401 })
  }

  const corpo = await lerCorpoLimitado(request, LIMITE_INSCRICAO)
  if (!corpo.ok) return corpo.resposta

  const parsed = corpoSchema.safeParse(corpo.json)
  if (!parsed.success) {
    return NextResponse.json({ erro: 'Identificação malformada.' }, { status: 400 })
  }

  const supabase = createAnonClient()
  const { data, error } = await supabase.rpc('agent_set_remote_id', {
    p_device_token: token,
    p_remote_id: parsed.data.remote_id,
  })

  if (error) {
    console.error('[agent/remote-id]', error.message)
    return NextResponse.json({ erro: 'Não foi possível registrar.' }, { status: 500 })
  }
  if (data !== true) {
    return NextResponse.json({ erro: 'Token da máquina não é válido.' }, { status: 401 })
  }

  return NextResponse.json({ ok: true })
}
