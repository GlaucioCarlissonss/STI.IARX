import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAnonClient } from '@/lib/supabase/anon'

/**
 * A entrada de monitoramento: o Zabbix avisa que um link caiu ou voltou.
 *
 * Fecha o M8 / LG-07, que esteve aberto com a justificativa *exige um Zabbix
 * real para testar contra*. O que exige um Zabbix real é provar que o script de
 * mídia DELE foi configurado certo — trabalho de quem instala. O lado de cá é
 * contrato, e contrato se testa com o corpo que o contrato promete.
 *
 * ## O contrato, porque ele é nosso
 *
 * O webhook do Zabbix não tem formato: é um script JavaScript que o operador
 * cola, e ele manda o que mandarem ele mandar. Então o formato é definido aqui,
 * e `docs/13` traz o script pronto para colar.
 *
 * ```json
 * { "host": "LINK-SP-01", "external_id": "{EVENT.ID}",
 *   "state": "PROBLEM", "at": "2026-10-31T12:00:00Z", "note": "{EVENT.NAME}" }
 * ```
 *
 * `state` aceita o vocabulário do Zabbix (`PROBLEM`/`OK`, de
 * `{TRIGGER.STATUS}`) e o nosso (`down`/`up`). `host` casa com
 * `internet_links.monitoring_host`; `external_id`, com `monitoring_external_id`
 * — e o identificador tem precedência, porque renomear o host no Zabbix não
 * deveria desligar o registro de disponibilidade.
 *
 * ## Por que o token vai na URL
 *
 * Mesmo motivo de `/api/canais/<token>`: o que se configura num script de mídia
 * é uma URL. Exigir cabeçalho tornaria o recurso difícil justamente para quem
 * precisa usá-lo. O token identifica o tenant, e não vem do corpo de propósito
 * — o corpo é escrito por quem chama.
 *
 * ## Por que quase tudo responde 200
 *
 * Porque o Zabbix REPETE o que não deu 2xx, e repetir não conserta host
 * errado. "Link não encontrado" e "estado inválido" são configuração: a
 * resposta diz o que houve, o Zabbix registra no log de mídia dele, e a
 * repetição não acontece. Fica 4xx só o que faz sentido repetir ou corrigir
 * fora do Zabbix: corpo ilegível (400) e token desconhecido (401).
 *
 * A alternativa — 422 para host errado — faria o monitor bater na porta para
 * sempre por causa de um cadastro faltando, e o primeiro sintoma seria a conta
 * de rede, não o cadastro.
 */

export const dynamic = 'force-dynamic'

/** Um alerta de monitoramento é pequeno. 64 KB já é generoso. */
const LIMITE = 64 * 1024

const corpoSchema = z
  .object({
    host: z.string().trim().min(1).max(200).nullish(),
    external_id: z.string().trim().min(1).max(200).nullish(),
    state: z.string().trim().min(1).max(40),
    at: z.string().datetime({ offset: true }).nullish(),
    note: z.string().trim().max(2000).nullish(),
  })
  .refine((c) => Boolean(c.host || c.external_id), {
    message: 'Informe ao menos "host" ou "external_id".',
  })

type Resultado = {
  ok: boolean
  acao?: string
  motivo?: string
  link_id?: string
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const cru = await request.text()
  if (cru.length > LIMITE) {
    return NextResponse.json({ ok: false, motivo: 'corpo_grande_demais' }, { status: 413 })
  }

  let json: unknown
  try {
    json = JSON.parse(cru)
  } catch {
    return NextResponse.json({ ok: false, motivo: 'json_invalido' }, { status: 400 })
  }

  const parsed = corpoSchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, motivo: 'corpo_invalido', detalhe: parsed.error.issues[0]?.message },
      { status: 400 },
    )
  }

  /*
   * Cliente ANÔNIMO, não o de serviço. A função é `security definer` e deriva o
   * tenant do token — não há parâmetro de tenant para falsificar, e um defeito
   * aqui não vira acesso à base inteira. É o mesmo desenho do agente de
   * inventário, e o motivo de esta rota não acrescentar um quarto uso de
   * `service_role` ao ADR-011.
   */
  const supabase = createAnonClient()
  const { data, error } = await supabase.rpc('link_event_ingest', {
    p_token: token,
    p_host: parsed.data.host ?? null,
    p_external_id: parsed.data.external_id ?? null,
    p_state: parsed.data.state,
    p_at: parsed.data.at ?? null,
    p_note: parsed.data.note ?? null,
  })

  if (error) {
    console.error('[monitoramento] ingestão:', error.message)
    return NextResponse.json({ ok: false, motivo: 'falha_interna' }, { status: 500 })
  }

  const r = (data ?? { ok: false, motivo: 'sem_resposta' }) as Resultado
  if (r.motivo === 'token_desconhecido') {
    return NextResponse.json(r, { status: 401 })
  }
  return NextResponse.json(r, { status: 200 })
}

/*
 * `GET` existe para dar uma resposta clara a quem abrir a URL no navegador
 * conferindo se "está no ar" — o primeiro reflexo de quem configura. Não diz se
 * o token vale: isso transformaria a rota num oráculo de tokens válidos para
 * quem quisesse adivinhar um.
 */
export function GET() {
  return NextResponse.json(
    { ok: true, servico: 'entrada de monitoramento', metodo: 'POST' },
    { status: 200 },
  )
}
