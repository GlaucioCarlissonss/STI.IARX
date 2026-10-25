import { erroDeEntrega, type Provedor } from './tipos'
import { dataIso, primeiroTexto } from './n8n'

/**
 * Bitrix24 como canal de conversa.
 *
 * ## O que já existia, e por que isto é outra coisa
 *
 * Esta base já fala com o Bitrix24 desde a migração 0009 — mas naquele caminho
 * (`integrations`, ADR-009) o que viaja é uma **tarefa**: campos mapeados nos dois
 * sentidos, com supressão de eco e regras de transformação.
 *
 * Aqui o que viaja é uma **mensagem**. São problemas diferentes, e o cabeçalho da
 * migração 0034 explica por que não foram fundidos. O que este adaptador faz é o
 * caminho de conversa: um evento de mensagem do Bitrix24 vira comentário no
 * chamado, e a resposta do atendente volta para lá.
 *
 * ## Os dois jeitos de o Bitrix24 falar, e qual este adaptador usa
 *
 * O Bitrix24 oferece dois caminhos para mensagens:
 *
 *   · **Open Channels** (`imconnector`) — o canal unificado dele, que já agrega
 *     WhatsApp, Telegram e chat do site. Integrar como conector exige registrar
 *     um aplicativo, implementar o protocolo de conector e passar pela revisão
 *     da Bitrix.
 *   · **Webhook de saída** (`outbound webhook`) sobre eventos de IM
 *     (`ONIMBOTMESSAGEADD`, `ONIMCONNECTORMESSAGEADD`) — configurado em minutos,
 *     sem aplicativo registrado.
 *
 * Este adaptador usa o **segundo**, e é uma escolha de custo/benefício explícita:
 * o primeiro entrega mais (fica dentro da experiência do Bitrix24) e custa
 * semanas mais revisão de terceiro. Quem já usa Open Channels pode ligá-los aqui
 * pelo webhook de saída deles, que é o arranjo que a maioria vai querer de
 * qualquer jeito.
 *
 * ## A URL de saída É a credencial
 *
 * O webhook de entrada do Bitrix24 tem a forma
 * `https://empresa.bitrix24.com.br/rest/1/<SEGREDO>/` — o segredo está no
 * caminho. Por isso este adaptador lê a URL da **variável de ambiente** nomeada
 * em `secret_ref`, e não de `outbound_url`: uma URL que é credencial não pode
 * morar numa coluna que aparece em backup e em export de suporte.
 *
 * ## O que eu NÃO pude verificar
 *
 * Nada aqui foi executado contra um Bitrix24 real — não há instância nem
 * credencial no ambiente onde isto foi escrito. O formato do evento e a chamada
 * `im.message.add` seguem a documentação REST, e a normalização tem teste de
 * unidade. A primeira ligação com uma instância de verdade pode exigir ajuste do
 * nome dos campos, que o Bitrix24 entrega em MAIÚSCULAS e com variações entre
 * eventos.
 */

export const bitrix24: Provedor = {
  nome: 'bitrix24',

  /**
   * O Bitrix24 manda um `application_token` no corpo do evento, e é com ele que
   * se confere a origem — não há HMAC.
   *
   * Quando o canal tem `config.application_token_ref`, o valor é conferido; sem
   * ele, o que autentica é o token da URL. A diferença está escrita porque é
   * informação de segurança: um canal sem o token conferido aceita evento
   * forjado de quem descobrir a URL.
   */
  verificar(bruto, _cabecalhos, canal) {
    const ref = canal.config['application_token_ref']
    if (typeof ref !== 'string' || ref === '') return true // só o segredo da URL

    const esperado = process.env[ref]
    if (!esperado) return false // configurado e ausente = fechado, não aberto

    /* O evento chega como `application/x-www-form-urlencoded`, então o token é
       lido do corpo cru — antes de qualquer interpretação, que é onde um corpo
       não autenticado não deve chegar. */
    const texto = new TextDecoder().decode(bruto)
    const campos = new URLSearchParams(texto)
    return campos.get('auth[application_token]') === esperado
  },

  /**
   * Traduz o evento de mensagem.
   *
   * O Bitrix24 entrega chave em MAIÚSCULAS, aninhada em `data[PARAMS]`, e o
   * formato varia entre `ONIMBOTMESSAGEADD` e `ONIMCONNECTORMESSAGEADD`. Em vez
   * de um `if` por evento, este normalizador procura os campos nos lugares
   * conhecidos e usa o primeiro que achar — a lista cresce sem reescrever a
   * função, e um evento novo degrada para "não entendi" em vez de quebrar.
   */
  normalizar(corpo) {
    const raiz = corpo as Record<string, unknown>
    const data = (raiz?.['data'] ?? raiz) as Record<string, unknown>
    const params = (data?.['PARAMS'] ?? data?.['params'] ?? data) as Record<string, unknown>
    if (!params || typeof params !== 'object') return []

    const de = primeiroTexto(
      params['FROM_USER_ID'],
      params['AUTHOR_ID'],
      params['from'],
      (params['USER'] as Record<string, unknown> | undefined)?.['ID'],
    )
    if (!de) return []

    const texto = primeiroTexto(params['MESSAGE'], params['message'], params['TEXT'])
    const usuario = params['USER'] as Record<string, unknown> | undefined

    return [
      {
        externo: primeiroTexto(params['MESSAGE_ID'], params['ID'], params['message_id']),
        /* Prefixo `bitrix:`, pela mesma convenção do canal genérico: o
           identificador do Bitrix24 é um número de usuário, e um número solto
           colidiria com um telefone se alguém trocasse o tipo do canal. */
        de: `bitrix:${de}`,
        nome: primeiroTexto(
          params['FROM_USER_NAME'],
          usuario?.['NAME'],
          usuario?.['FIRST_NAME'],
        ),
        texto: texto?.slice(0, 20000),
        em: dataIso(params['DATE_CREATE'] ?? params['timestamp']),
        thread: primeiroTexto(params['DIALOG_ID'], params['CHAT_ID'], params['chat_id']),
      },
    ]
  },

  /**
   * Envia por `im.message.add` no webhook de entrada.
   *
   * O destino chega com o prefixo `bitrix:` que a normalização pôs — ele é
   * retirado aqui, porque do lado do Bitrix24 o id é o número puro.
   */
  async enviar(destino, texto, canal, credencial) {
    if (!credencial) {
      return {
        ok: false,
        erro: 'Canal sem credencial: o webhook de entrada do Bitrix24 contém o segredo e mora no ambiente.',
      }
    }
    if (!credencial.startsWith('https://')) {
      return { ok: false, erro: 'A URL do webhook do Bitrix24 precisa ser https.' }
    }

    const id = destino.startsWith('bitrix:') ? destino.slice(7) : destino
    const base = credencial.endsWith('/') ? credencial : `${credencial}/`

    let resposta: Response
    try {
      resposta = await fetch(`${base}im.message.add.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          /* `DIALOG_ID` aceita tanto o id de usuário (`123`) quanto o de chat
             (`chat45`). Mandar o que veio no evento é o que faz a resposta cair
             na mesma conversa em que a pergunta foi feita. */
          DIALOG_ID:
            typeof canal.config['dialog_id'] === 'string' ? canal.config['dialog_id'] : id,
          MESSAGE: texto.slice(0, 10000),
        }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (e) {
      return { ok: false, erro: `Rede: ${e instanceof Error ? e.message : 'falha'}` }
    }

    const corpo = await resposta.text()
    if (!resposta.ok) {
      return { ok: false, erro: erroDeEntrega(resposta.status, corpo) }
    }

    /*
     * O Bitrix24 responde **200 com `error` no corpo** quando a chamada falha —
     * token expirado, permissão faltando, método desconhecido. Tratar só o
     * código HTTP marcaria como entregue uma mensagem que não saiu, e o
     * atendente acharia que respondeu.
     */
    try {
      const json = JSON.parse(corpo) as { error?: string; error_description?: string; result?: unknown }
      if (json.error) {
        return { ok: false, erro: `Bitrix24: ${json.error_description ?? json.error}` }
      }
      return { ok: true, externo: json.result !== undefined ? String(json.result) : undefined }
    } catch {
      return { ok: false, erro: 'Bitrix24 respondeu 200 com corpo ilegível.' }
    }
  },
}
