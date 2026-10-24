import { NextResponse } from 'next/server'
import { createAnonClient } from '@/lib/supabase/anon'
import { ingestaoSchema } from '@/lib/agent/inventario'
import { lerCorpoLimitado, tokenDoAgente, LIMITE_INVENTARIO } from '../corpo'

/**
 * Onde o inventário entra.
 *
 * O trabalho de verdade está no banco (`public.agent_ingest_inventory`): comparar
 * o hash do conteúdo, guardar o snapshot só quando mudou, atualizar o software e
 * conciliar com o ativo. Esta rota é a casca — valida a forma, passa adiante e
 * traduz o resultado.
 *
 * Ela é fina de propósito. A alternativa seria a aplicação ler o último snapshot,
 * comparar em TypeScript e decidir se grava; isso faria a decisão depender de duas
 * requisições sem transação entre elas, e duas coletas simultâneas da mesma
 * máquina (que acontece quando o agente é reiniciado no meio de um envio)
 * gravariam dois snapshots idênticos. No banco é uma transação só.
 *
 * ## Os três resultados, e o que cada um significa para quem está depurando
 *
 * · `stored` — o inventário mudou e virou histórico.
 * · `unchanged` — chegou igual ao último. O contato foi registrado; nada mais.
 *   É o resultado NORMAL: numa frota estável, 364 dos 365 envios de uma máquina
 *   respondem isto.
 * · 401 — o token da máquina não vale mais. O agente deve se reinscrever.
 */

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const token = tokenDoAgente(request)
  if (!token) {
    return NextResponse.json({ erro: 'Token da máquina ausente.' }, { status: 401 })
  }

  const corpo = await lerCorpoLimitado(request, LIMITE_INVENTARIO)
  if (!corpo.ok) return corpo.resposta

  const parsed = ingestaoSchema.safeParse(corpo.json)
  if (!parsed.success) {
    /* O detalhe do zod vai para o registro do servidor, e só a forma geral para a
       resposta. O agente não conserta o próprio schema lendo a mensagem; quem
       conserta é quem compila a próxima versão, e essa pessoa lê o registro. */
    console.error('[agent/inventory] payload recusado:', parsed.error.issues.slice(0, 5))
    return NextResponse.json({ erro: 'Inventário malformado.' }, { status: 400 })
  }

  const supabase = createAnonClient()
  const { data, error } = await supabase.rpc('agent_ingest_inventory', {
    p_device_token: token,
    p_payload: parsed.data.inventario,
    p_collected_at: parsed.data.coletado_em ?? new Date().toISOString(),
  })

  if (error) {
    console.error('[agent/inventory]', error.message)
    return NextResponse.json({ erro: 'Não foi possível registrar o inventário.' }, { status: 500 })
  }

  const linha = Array.isArray(data) ? data[0] : null
  if (!linha || linha.status === 'unauthorized') {
    /*
     * 401 e não 403: o token não vale, e a diferença importa para o agente. Em 401
     * ele sabe que precisa se reinscrever; em 403 ele ficaria tentando para sempre
     * com a mesma credencial recusada.
     */
    return NextResponse.json({ erro: 'Token da máquina não é válido.' }, { status: 401 })
  }

  return NextResponse.json({
    status: linha.status,
    asset_id: linha.asset_id,
    snapshot_id: linha.snapshot_id,
  })
}
