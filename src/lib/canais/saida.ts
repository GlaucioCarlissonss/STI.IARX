import { credencialDoCanal } from './tipos'
import { provedorDoCanal } from './registro'

/**
 * Esvaziamento da fila de saída dos canais.
 *
 * É a metade em TypeScript da divisão declarada na migração 0034 — a mesma da
 * caixa de saída de e-mail (0029): a regra de **o que** sai vive no SQL (a
 * trigger em `ticket_comments`), e a conversa com o provedor vive aqui, porque o
 * banco não faz chamada de rede. A fronteira é a tabela `channel_messages`.
 */

/** O mínimo do cliente Supabase que esta função usa. Permite testar sem rede. */
export interface ClienteDaSaida {
  from(tabela: string): {
    select(colunas: string): {
      eq(c: string, v: string): {
        lte(c: string, v: string): {
          order(c: string, o: { ascending: boolean }): {
            limit(n: number): Promise<{ data: LinhaDeSaida[] | null; error: unknown }>
          }
        }
      }
    }
    update(valores: Record<string, unknown>): {
      eq(c: string, v: string): Promise<{ error: unknown }>
    }
  }
}

export interface LinhaDeSaida {
  id: string
  channel_id: string
  conversation_id: string | null
  body: string | null
  attempts: number
  /* A junção vem embutida: a mensagem sozinha não sabe para onde ir nem com que
     credencial. Uma segunda consulta por mensagem multiplicaria o custo pelo
     tamanho da fila. */
  conversa: {
    contato: { external_id: string } | null
  } | null
  canal: {
    kind: string
    status: string
    config: Record<string, unknown>
    secret_ref: string | null
  } | null
}

export interface ResultadoDaSaida {
  enviadas: number
  falhas: number
  /** Mensagens que nem foram tentadas: canal pausado, tipo desconhecido. */
  puladas: number
}

/** Depois disto a mensagem é dada como perdida e o motivo fica registrado. */
export const MAXIMO_DE_TENTATIVAS = 5

/**
 * Quanto esperar antes da próxima tentativa, em minutos.
 *
 * Crescimento ao quadrado com teto de uma hora — o mesmo de `email_outbox`, e
 * pelo mesmo motivo: repetir de minuto em minuto contra um provedor fora do ar
 * não entrega nada e gasta cota.
 *
 * Aqui há um motivo a mais, específico do WhatsApp: a Meta aplica limite de
 * requisições por número, e um laço apertado contra um erro persistente consome
 * a cota que as mensagens boas precisariam.
 */
export function proximaTentativa(tentativas: number): Date {
  const minutos = Math.min(tentativas * tentativas, 60)
  return new Date(Date.now() + minutos * 60_000)
}

/**
 * Envia o que está na fila e vencido.
 *
 * `limite` existe para a execução ter fim: uma fila represada não pode virar uma
 * requisição de dez minutos que o servidor corta no meio, deixando metade enviada
 * e nenhum registro de onde parou.
 */
export async function drenarSaidaDosCanais(
  supabase: ClienteDaSaida,
  limite = 50,
): Promise<ResultadoDaSaida> {
  const { data } = await supabase
    .from('channel_messages')
    .select(
      'id, channel_id, conversation_id, body, attempts, conversa:channel_conversations(contato:channel_contacts(external_id)), canal:channels(kind, status, config, secret_ref)',
    )
    .eq('status', 'na_fila')
    .lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(limite)

  let enviadas = 0
  let falhas = 0
  let puladas = 0

  for (const linha of data ?? []) {
    const canal = linha.canal
    const destino = linha.conversa?.contato?.external_id

    /*
     * Canal pausado NÃO é falha: alguém o pausou de propósito, e as mensagens
     * ficam esperando. Contar como falha gastaria as cinco tentativas durante a
     * pausa, e as respostas seriam dadas como perdidas sem ninguém ter errado.
     */
    if (!canal || canal.status !== 'ativo') {
      puladas += 1
      continue
    }

    const provedor = provedorDoCanal(canal.kind)
    if (!provedor || !destino || !linha.body) {
      /* Sem adaptador, sem destino ou sem corpo não há o que tentar de novo:
         marcar como falha evita a mensagem ficar na fila para sempre, e o motivo
         fica escrito. */
      await supabase
        .from('channel_messages')
        .update({
          status: 'falhou',
          attempts: linha.attempts + 1,
          last_error: !provedor
            ? `Tipo de canal sem adaptador: ${canal.kind}`
            : !destino
              ? 'Conversa sem contato: não há para quem enviar.'
              : 'Mensagem sem corpo.',
        })
        .eq('id', linha.id)
      falhas += 1
      continue
    }

    const r = await provedor.enviar(
      destino,
      linha.body,
      { kind: canal.kind as never, status: canal.status, config: canal.config ?? {}, secret_ref: canal.secret_ref },
      credencialDoCanal(canal.secret_ref),
    )

    if (r.ok) {
      await supabase
        .from('channel_messages')
        .update({
          status: 'enviada',
          sent_at: new Date().toISOString(),
          attempts: linha.attempts + 1,
          external_id: r.externo ?? null,
        })
        .eq('id', linha.id)
      enviadas += 1
      continue
    }

    const tentativas = linha.attempts + 1
    const desistiu = tentativas >= MAXIMO_DE_TENTATIVAS

    await supabase
      .from('channel_messages')
      .update({
        status: desistiu ? 'falhou' : 'na_fila',
        attempts: tentativas,
        last_error: r.erro.slice(0, 500),
        scheduled_for: desistiu ? undefined : proximaTentativa(tentativas).toISOString(),
      })
      .eq('id', linha.id)
    falhas += 1
  }

  return { enviadas, falhas, puladas }
}
