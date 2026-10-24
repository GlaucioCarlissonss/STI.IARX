import { NextResponse } from 'next/server'
import { createAnonClient } from '@/lib/supabase/anon'
import { tokenDoAgente } from '../corpo'

/**
 * O sinal de vida.
 *
 * ## Por que isto é uma rota separada da ingestão
 *
 * A tela de frota precisa distinguir "máquina igual" de "máquina parada", e
 * precisa com granularidade de minutos. O inventário muda poucas vezes por ano.
 *
 * Se o sinal de vida fosse reenviar o inventário, a conta seria: 200 máquinas ×
 * 144 envios por dia × meio megabyte de lista de software = **14 GB por dia**,
 * para transportar um dado que não mudou. O cliente notaria na rede, e nós na
 * conta do servidor.
 *
 * Esta rota não tem corpo nenhum: o token está no cabeçalho, e a resposta é um
 * booleano. A requisição inteira cabe em algumas centenas de bytes.
 */

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const token = tokenDoAgente(request)
  if (!token) {
    return NextResponse.json({ erro: 'Token da máquina ausente.' }, { status: 401 })
  }

  /* A versão vem no cabeçalho e não no corpo, para esta rota não precisar ler
     corpo nenhum — é o que a torna barata. */
  const versao = request.headers.get('x-agent-version')?.slice(0, 40) ?? null

  const supabase = createAnonClient()
  const { data, error } = await supabase.rpc('agent_heartbeat', {
    p_device_token: token,
    p_agent_version: versao,
  })

  if (error) {
    console.error('[agent/heartbeat]', error.message)
    return NextResponse.json({ erro: 'Não foi possível registrar o contato.' }, { status: 500 })
  }

  if (data !== true) {
    /* 401 e não 403: o agente precisa saber que a credencial morreu, para se
       reinscrever em vez de repetir a mesma tentativa para sempre. */
    return NextResponse.json({ erro: 'Token da máquina não é válido.' }, { status: 401 })
  }

  return NextResponse.json({ ok: true })
}
