import { NextResponse } from 'next/server'
import { createAnonClient } from '@/lib/supabase/anon'
import { mensagemNormalizadaSchema, type CanalResolvido } from '@/lib/canais/tipos'
import { provedorDoCanal } from '@/lib/canais/registro'
import { respostaDoApertoDeMao } from '@/lib/canais/whatsapp'

/**
 * A porta única de entrada de todos os canais.
 *
 * Uma rota, não quatro. O que muda entre WhatsApp, e-mail, Bitrix24 e N8N é a
 * TRADUÇÃO do corpo e a verificação da origem — e as duas vivem no adaptador. O
 * resto (resolver o canal, recusar o não autenticado, entregar ao banco) é
 * idêntico, e quatro cópias disso divergiriam.
 *
 * ## Por que o token vai na URL
 *
 * Porque metade dos provedores não deixa configurar cabeçalho. A Meta configura
 * uma URL e pronto; o webhook de saída do Bitrix24 idem. Exigir um `Authorization`
 * tornaria o recurso inutilizável justamente com quem ele precisa falar.
 *
 * O token é o que identifica o canal, e ele não vem do corpo de propósito: o
 * corpo é escrito por quem chama.
 *
 * ## O corpo é lido CRU primeiro
 *
 * A assinatura da Meta (`X-Hub-Signature-256`) é um HMAC sobre os bytes exatos.
 * `JSON.parse` seguido de `JSON.stringify` muda espaçamento, ordem e escape, e o
 * HMAC deixa de bater — é o erro mais comum desta integração, e ele se manifesta
 * como "a Meta parou de entregar", porque toda entrega passa a ser recusada.
 *
 * Por isso: ler os bytes, verificar, e só então interpretar.
 */

export const dynamic = 'force-dynamic'

/** 4 MB: um e-mail com anexo em base64 passa de 1 MB sem esforço. */
const LIMITE = 4 * 1024 * 1024

async function resolverCanal(token: string): Promise<CanalResolvido | null> {
  const supabase = createAnonClient()
  const { data, error } = await supabase
    .rpc('channel_por_token', { p_token: token })
    .maybeSingle<CanalResolvido>()
  if (error) {
    console.error('[canais] resolvendo canal:', error.message)
    return null
  }
  return data ?? null
}

/**
 * O aperto de mão da Meta, e nada mais.
 *
 * Só o WhatsApp usa `GET` nesta rota. Responder a qualquer tipo de canal com o
 * challenge faria um `GET` curioso em qualquer canal devolver o parâmetro que
 * quem chamou mandou — um refletor pequeno, mas um refletor.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const canal = await resolverCanal(token)
  if (!canal || canal.kind !== 'whatsapp') {
    return new NextResponse(null, { status: 404 })
  }

  const challenge = respostaDoApertoDeMao(new URL(request.url), token)
  if (challenge === null) {
    return new NextResponse(null, { status: 403 })
  }

  /* Texto puro, cru. Responder JSON (ou com aspas em volta) faz a Meta recusar a
     inscrição — e a mensagem de erro dela não diz o motivo. */
  return new NextResponse(challenge, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const declarado = Number(request.headers.get('content-length') ?? '0')
  if (declarado > LIMITE) {
    return NextResponse.json({ erro: 'Corpo grande demais.' }, { status: 413 })
  }

  const bruto = new Uint8Array(await request.arrayBuffer())
  if (bruto.byteLength > LIMITE) {
    return NextResponse.json({ erro: 'Corpo grande demais.' }, { status: 413 })
  }

  const canal = await resolverCanal(token)
  if (!canal) {
    return NextResponse.json({ erro: 'Canal não encontrado.' }, { status: 404 })
  }

  const provedor = provedorDoCanal(canal.kind)
  if (!provedor) {
    console.error('[canais] tipo sem adaptador:', canal.kind)
    return NextResponse.json({ erro: 'Canal não suportado.' }, { status: 500 })
  }

  /* Verificar ANTES de interpretar: um corpo não autenticado não deve nem ser
     lido como JSON. */
  if (!provedor.verificar(bruto, request.headers, canal)) {
    return NextResponse.json({ erro: 'Assinatura inválida.' }, { status: 401 })
  }

  /*
   * Canal pausado responde 200, e não erro.
   *
   * É contraintuitivo e é certo: a Meta desinscreve um webhook que devolve erro
   * repetidamente, e aí religar o canal exigiria refazer a configuração dela.
   * Pausado significa "não processe", não "estou quebrado".
   */
  if (canal.status !== 'ativo') {
    return NextResponse.json({ status: 'pausado' })
  }

  let corpo: unknown
  const tipo = request.headers.get('content-type') ?? ''
  try {
    if (tipo.includes('application/x-www-form-urlencoded')) {
      /* O Bitrix24 manda formulário, não JSON. `URLSearchParams` achata as
         chaves (`data[PARAMS][MESSAGE]`), e o adaptador dele sabe ler assim. */
      corpo = Object.fromEntries(new URLSearchParams(new TextDecoder().decode(bruto)))
    } else {
      corpo = JSON.parse(new TextDecoder().decode(bruto))
    }
  } catch {
    return NextResponse.json({ erro: 'Corpo ilegível.' }, { status: 400 })
  }

  const mensagens = provedor.normalizar(corpo, canal)

  /*
   * Zero mensagens é um resultado NORMAL e frequente, não um erro: a Meta manda
   * eventos de status de entrega (`sent`, `delivered`, `read`) no mesmo webhook
   * das mensagens, e numa conversa ativa há três ou quatro status para cada
   * mensagem de verdade.
   */
  if (mensagens.length === 0) {
    return NextResponse.json({ status: 'sem_mensagem', recebidas: 0 })
  }

  const supabase = createAnonClient()
  const resultados: string[] = []

  for (const bruta of mensagens.slice(0, 100)) {
    const parsed = mensagemNormalizadaSchema.safeParse(bruta)
    if (!parsed.success) {
      console.error('[canais] mensagem normalizada inválida:', parsed.error.issues.slice(0, 3))
      resultados.push('malformed')
      continue
    }

    const { data, error } = await supabase.rpc('channel_ingest', {
      p_token: token,
      p_mensagem: parsed.data,
    })

    if (error) {
      console.error('[canais] ingestão:', error.message)
      /*
       * 500 faz o provedor tentar de novo, e tentar de novo é o que se quer: a
       * mensagem não foi gravada, e a idempotência por `external_id` garante que
       * a repetição não duplique nada quando ela der certo.
       */
      return NextResponse.json({ erro: 'Não foi possível registrar.' }, { status: 500 })
    }

    const linha = Array.isArray(data) ? data[0] : null
    resultados.push(linha?.status ?? 'desconhecido')
  }

  if (resultados.includes('unauthorized')) {
    return NextResponse.json({ erro: 'Canal não autorizado.' }, { status: 401 })
  }

  return NextResponse.json({ status: 'ok', recebidas: resultados.length, resultados })
}
