import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  credencialDoCanal,
  erroDeEntrega,
  type CanalResolvido,
  type MensagemNormalizada,
  type Provedor,
} from './tipos'

/**
 * WhatsApp pela **API oficial da Meta** (Cloud API).
 *
 * ## Por que não uma biblioteca não-oficial
 *
 * As bibliotecas que falam com o WhatsApp Web (`whatsapp-web.js`, `Baileys` e
 * companhia) são mais fáceis de ligar e **violam os termos de uso**. O número é
 * banido — não "pode ser": é, e sem aviso. Um produto cujo canal principal depende
 * de um número que pode sumir de um dia para o outro não é um produto que se
 * vende a uma empresa, e o cliente que perdeu o número não volta.
 *
 * O custo da escolha certa é real: a Cloud API exige conta Business verificada,
 * número dedicado, modelos de mensagem aprovados para iniciar conversa, e cobra
 * por conversa. Está em docs/16.
 *
 * ## As duas chaves, e por que são duas
 *
 * A Meta tem dois segredos com papéis diferentes, e confundi-los é um erro de
 * segurança:
 *
 *   · **Access token** (`secret_ref`) — autoriza ESTE sistema a ENVIAR. Longo,
 *     rotacionável, por número.
 *   · **App Secret** (`config.app_secret_ref`) — autentica o que CHEGA, pelo
 *     HMAC do cabeçalho `X-Hub-Signature-256`. É por aplicativo, não por número.
 *
 * Sem o segundo, qualquer um que descubra a URL do webhook manda mensagem em nome
 * de qualquer pessoa — e a URL vaza em log de proxy, em histórico de terminal e
 * no painel da própria Meta.
 *
 * ## O token de verificação é o token da URL
 *
 * A Meta pede um "verify token" no aperto de mão inicial (um GET com
 * `hub.challenge`). Este adaptador usa **o mesmo token que está na URL**, e isso
 * não enfraquece nada: quem souber o token da URL já pode postar no webhook, e o
 * verify token só serve ao aperto de mão. Em troca, a configuração tem um segredo
 * a menos para alguém copiar errado.
 *
 * ## O que eu NÃO pude verificar
 *
 * Nada aqui foi executado contra a Graph API: não há credencial da Meta nem
 * acesso a `graph.facebook.com` no ambiente onde isto foi escrito. O formato do
 * payload, o cálculo do HMAC e o corpo de envio seguem a documentação da Cloud
 * API v21, e a normalização e a assinatura têm teste de unidade com payloads
 * reais copiados dela. A primeira ligação com um número de verdade pode exigir
 * ajuste.
 */

/** O caminho do número no Graph: `/{versao}/{phone_number_id}/messages`. */
const VERSAO_GRAPH = 'v21.0'

function appSecret(canal: CanalResolvido): string | null {
  const ref = canal.config['app_secret_ref']
  return typeof ref === 'string' ? credencialDoCanal(ref) : null
}

export const whatsapp: Provedor = {
  nome: 'whatsapp',

  /**
   * Confere o `X-Hub-Signature-256` sobre os bytes CRUS.
   *
   * Sobre os bytes crus, e não sobre o JSON re-serializado: `JSON.parse` seguido
   * de `JSON.stringify` muda espaçamento, ordem e escape, e o HMAC deixa de
   * bater. É o erro mais comum nesta integração, e ele se manifesta como "a Meta
   * parou de entregar" — porque toda entrega passa a ser recusada.
   *
   * **Sem App Secret configurado, devolve `false`.** Não é zelo: um webhook de
   * WhatsApp sem verificação de assinatura aceita mensagem forjada de qualquer
   * remetente, e mensagem forjada vira chamado com o nome de outra pessoa. O
   * canal fica recusando tudo até alguém configurar — visível, em vez de aberto
   * em silêncio.
   */
  verificar(bruto, cabecalhos, canal) {
    const segredo = appSecret(canal)
    if (!segredo) return false

    const cabecalho = cabecalhos.get('x-hub-signature-256') ?? ''
    const esperado = cabecalho.startsWith('sha256=') ? cabecalho.slice(7) : ''
    if (esperado.length !== 64) return false

    const calculado = createHmac('sha256', segredo).update(bruto).digest('hex')

    /* `timingSafeEqual` exige buffers do mesmo tamanho; os dois são hexa de 64
       caracteres, garantido pela checagem acima. */
    try {
      return timingSafeEqual(Buffer.from(calculado, 'hex'), Buffer.from(esperado, 'hex'))
    } catch {
      return false
    }
  },

  /**
   * Traduz `entry[].changes[].value.messages[]`.
   *
   * O mesmo webhook entrega **eventos de status** (`sent`, `delivered`, `read`,
   * `failed`) no campo `statuses[]`. Eles não são mensagens, e devolver zero para
   * eles é o caminho normal — numa conversa ativa há três ou quatro status para
   * cada mensagem de verdade.
   */
  normalizar(corpo) {
    const saida: MensagemNormalizada[] = []
    const raiz = corpo as { entry?: unknown[] }
    if (!Array.isArray(raiz?.entry)) return saida

    for (const entrada of raiz.entry) {
      const mudancas = (entrada as { changes?: unknown[] })?.changes
      if (!Array.isArray(mudancas)) continue

      for (const mudanca of mudancas) {
        const valor = (mudanca as { value?: Record<string, unknown> })?.value
        if (!valor) continue

        /* O nome do perfil vem num array separado das mensagens, indexado pelo
           `wa_id`. Sem este mapa, todo contato entraria sem nome — e a tela de
           conversas ficaria com uma coluna de telefones. */
        const nomes = new Map<string, string>()
        const contatos = valor['contacts']
        if (Array.isArray(contatos)) {
          for (const c of contatos) {
            const waId = (c as { wa_id?: string })?.wa_id
            const nome = (c as { profile?: { name?: string } })?.profile?.name
            if (waId && nome) nomes.set(waId, nome)
          }
        }

        const mensagens = valor['messages']
        if (!Array.isArray(mensagens)) continue

        for (const m of mensagens) {
          const msg = m as Record<string, unknown>
          const de = typeof msg['from'] === 'string' ? msg['from'] : null
          if (!de) continue

          const tipo = typeof msg['type'] === 'string' ? msg['type'] : 'unknown'
          const midia: NonNullable<MensagemNormalizada['midia']> = []
          let texto: string | undefined

          switch (tipo) {
            case 'text':
              texto = (msg['text'] as { body?: string })?.body
              break
            case 'button':
              texto = (msg['button'] as { text?: string })?.text
              break
            case 'interactive': {
              /* Resposta de botão ou de lista. O que interessa é o TÍTULO que a
                 pessoa viu e tocou, não o id interno — o id é do nosso lado e
                 não diz nada a quem lê o chamado. */
              const inter = msg['interactive'] as Record<string, unknown>
              const botao = inter?.['button_reply'] as { title?: string } | undefined
              const lista = inter?.['list_reply'] as { title?: string } | undefined
              texto = botao?.title ?? lista?.title
              break
            }
            case 'image':
            case 'audio':
            case 'video':
            case 'document':
            case 'sticker': {
              const anexo = msg[tipo] as Record<string, unknown> | undefined
              if (anexo) {
                midia.push({
                  tipo,
                  nome: typeof anexo['filename'] === 'string' ? anexo['filename'] : undefined,
                  id: typeof anexo['id'] === 'string' ? anexo['id'] : undefined,
                })
              }
              /* A legenda do anexo é o texto da mensagem. Sem ela, um chamado
                 aberto por uma foto com legenda "a tela está assim" nasceria sem
                 título nenhum. */
              texto = typeof anexo?.['caption'] === 'string' ? anexo['caption'] : undefined
              break
            }
            case 'location': {
              const loc = msg['location'] as { latitude?: number; longitude?: number } | undefined
              if (loc) texto = `Localização enviada: ${loc.latitude}, ${loc.longitude}`
              break
            }
            default:
              /* Tipo novo que a Meta lançou e este código ainda não conhece. A
                 mensagem entra com uma descrição em vez de ser descartada: a
                 pessoa escreveu alguma coisa, e perdê-la é pior que registrá-la
                 sem o conteúdo. */
              texto = `(mensagem do tipo "${tipo}", ainda não interpretada)`
          }

          saida.push({
            externo: typeof msg['id'] === 'string' ? msg['id'] : undefined,
            de,
            nome: nomes.get(de),
            texto: texto?.slice(0, 20000),
            /* O carimbo vem em segundos, como TEXTO. Tratá-lo como milissegundos
               colocaria toda mensagem em 1970. */
            em: carimbo(msg['timestamp']),
            midia: midia.length > 0 ? midia : undefined,
          })
        }
      }
    }

    return saida
  },

  /**
   * Envia pela Graph API.
   *
   * ## A janela de 24 horas
   *
   * A Meta só permite mensagem livre dentro de 24 horas desde a última mensagem
   * DA PESSOA. Fora disso, só modelo pré-aprovado. Este adaptador envia texto
   * livre e, quando a Meta recusa por causa da janela, o erro volta com a
   * explicação — em vez de um "falhou" que ninguém sabe interpretar.
   *
   * Mandar modelo automaticamente seria pior: modelo custa mais caro, precisa ser
   * aprovado antes, e o texto dele não é o que o atendente escreveu.
   */
  async enviar(destino, texto, canal, credencial) {
    if (!credencial) return { ok: false, erro: 'Canal sem credencial configurada.' }

    const numero = canal.config['phone_number_id']
    if (typeof numero !== 'string' || numero === '') {
      return { ok: false, erro: 'Canal sem phone_number_id na configuração.' }
    }

    const url = `https://graph.facebook.com/${VERSAO_GRAPH}/${encodeURIComponent(numero)}/messages`

    let resposta: Response
    try {
      resposta = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credencial}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: destino,
          type: 'text',
          /* `preview_url: false`: a prévia de link num texto de suporte abre o
             endereço do nosso lado e vaza a URL interna para a Meta. */
          text: { preview_url: false, body: texto.slice(0, 4096) },
        }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (e) {
      return { ok: false, erro: `Rede: ${e instanceof Error ? e.message : 'falha'}` }
    }

    const corpo = await resposta.text()
    if (!resposta.ok) {
      /*
       * O erro 131047 é "fora da janela de 24 horas", e é o mais comum em
       * operação normal. Traduzi-lo aqui evita que quem olha a fila de saída
       * conclua que a integração quebrou.
       */
      if (corpo.includes('131047')) {
        return {
          ok: false,
          erro: 'Fora da janela de 24 horas do WhatsApp: a pessoa precisa escrever de novo, ou use um modelo aprovado.',
        }
      }
      return { ok: false, erro: erroDeEntrega(resposta.status, corpo) }
    }

    try {
      const json = JSON.parse(corpo) as { messages?: { id?: string }[] }
      return { ok: true, externo: json.messages?.[0]?.id }
    } catch {
      // 200 com corpo ilegível: a mensagem saiu, e o id não dá para saber.
      return { ok: true }
    }
  },
}

/** Carimbo em segundos (texto ou número) para ISO. */
function carimbo(bruto: unknown): string | undefined {
  const n = typeof bruto === 'string' ? Number(bruto) : typeof bruto === 'number' ? bruto : NaN
  if (!Number.isFinite(n) || n <= 0) return undefined
  return new Date(n * 1000).toISOString()
}

/**
 * O aperto de mão inicial da Meta.
 *
 * Ela faz um `GET` com `hub.mode=subscribe`, `hub.verify_token` e
 * `hub.challenge`, e espera o challenge **cru, em texto puro**. Responder JSON,
 * ou com aspas em volta, faz a Meta recusar a inscrição — e a mensagem de erro
 * dela não diz o motivo.
 */
export function respostaDoApertoDeMao(url: URL, token: string): string | null {
  if (url.searchParams.get('hub.mode') !== 'subscribe') return null
  if (url.searchParams.get('hub.verify_token') !== token) return null
  return url.searchParams.get('hub.challenge')
}
