import { NextResponse } from 'next/server'
import { createAnonClient } from '@/lib/supabase/anon'
import { loteDeMetricasSchema } from '@/lib/agent/metricas'
import { lerCorpoLimitado, tokenDoAgente, LIMITE_METRICAS } from '../corpo'

/**
 * Onde as amostras de desempenho entram.
 *
 * ## Por que um lote, e não uma amostra por requisição
 *
 * O agente amostra de cinco em cinco minutos e envia de dez em dez. Uma
 * requisição por amostra dobraria o número de conexões para transportar a mesma
 * informação — e, pior, deixaria metade do lote perdida quando a rede caísse no
 * meio, sem nada que dissesse qual metade.
 *
 * ## Por que esta rota não precisa do batimento
 *
 * Mandar métrica já é dar sinal de vida: a função no banco atualiza
 * `last_seen_at`. O agente que está enviando métricas não chama
 * `/api/agent/heartbeat` — seria uma segunda requisição dizendo o que a primeira
 * já disse.
 */

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const token = tokenDoAgente(request)
  if (!token) {
    return NextResponse.json({ erro: 'Token da máquina ausente.' }, { status: 401 })
  }

  const corpo = await lerCorpoLimitado(request, LIMITE_METRICAS)
  if (!corpo.ok) return corpo.resposta

  const parsed = loteDeMetricasSchema.safeParse(corpo.json)
  if (!parsed.success) {
    console.error('[agent/metrics] lote recusado:', parsed.error.issues.slice(0, 5))
    return NextResponse.json({ erro: 'Lote de métricas malformado.' }, { status: 400 })
  }

  const supabase = createAnonClient()
  const { data, error } = await supabase.rpc('agent_ingest_metrics', {
    p_device_token: token,
    p_amostras: parsed.data.amostras,
  })

  if (error) {
    console.error('[agent/metrics]', error.message)
    return NextResponse.json({ erro: 'Não foi possível registrar as métricas.' }, { status: 500 })
  }

  const linha = Array.isArray(data) ? data[0] : null
  if (!linha || linha.status === 'unauthorized') {
    return NextResponse.json({ erro: 'Token da máquina não é válido.' }, { status: 401 })
  }

  /*
   * `aceitas` pode ser menor que o enviado, e isso NÃO é erro: amostra repetida
   * (reenvio do lote) e amostra com relógio errado são descartadas de propósito.
   * O agente usa o número para registrar, não para decidir reenviar — a fila
   * local é esvaziada quando a requisição responde 200, e não quando todas as
   * amostras são aceitas. Reenviar o que foi legitimamente descartado seria um
   * laço que não termina.
   */
  return NextResponse.json({ status: linha.status, aceitas: linha.aceitas })
}
