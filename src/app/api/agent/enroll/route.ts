import { NextResponse } from 'next/server'
import { createAnonClient } from '@/lib/supabase/anon'
import { inscricaoSchema } from '@/lib/agent/inventario'
import { lerCorpoLimitado, LIMITE_INSCRICAO } from '../corpo'

/**
 * A primeira coisa que o agente faz na vida: trocar o token do tenant pelo dele.
 *
 * Depois disto o token do tenant não volta a ser usado nesta máquina — fica no
 * arquivo de configuração do instalador, e o agente passa a se autenticar com o
 * próprio. É o que faz "revogar um notebook roubado" ser uma linha de banco em
 * vez de trocar a credencial de 200 computadores.
 *
 * ## Por que esta rota não distingue os motivos da recusa
 *
 * Token errado, token vencido, token esgotado, máquina revogada: tudo responde
 * 401 com a mesma frase. Distinguir diria a quem estivesse tentando adivinhar um
 * token qual dos quatro ele acertou — e "acertei o token, só está vencido" é
 * informação de muito valor para quem tenta.
 */

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const corpo = await lerCorpoLimitado(request, LIMITE_INSCRICAO)
  if (!corpo.ok) return corpo.resposta

  const parsed = inscricaoSchema.safeParse(corpo.json)
  if (!parsed.success) {
    return NextResponse.json({ erro: 'Inscrição malformada.' }, { status: 400 })
  }

  const supabase = createAnonClient()
  const { data, error } = await supabase.rpc('agent_enroll', {
    p_enrollment_token: parsed.data.enrollment_token,
    p_device: parsed.data.device,
  })

  if (error) {
    /* O erro cru fica no registro do servidor e NÃO na resposta: ele traz nome de
       função e de coluna, que é mapa do schema para quem está sondando. */
    console.error('[agent/enroll]', error.message)
    return NextResponse.json({ erro: 'Não foi possível inscrever a máquina.' }, { status: 500 })
  }

  /* A função devolve zero linhas quando recusa. Não é erro de banco: é a recusa
     em si, desenhada para não dizer de qual dos quatro motivos se trata. */
  const linha = Array.isArray(data) ? data[0] : null
  if (!linha?.device_token) {
    return NextResponse.json({ erro: 'Inscrição não autorizada.' }, { status: 401 })
  }

  return NextResponse.json({
    device_id: linha.device_id,
    device_token: linha.device_token,
    tenant_id: linha.tenant_id,
  })
}
