import { erroDeEntrega, type MensagemNormalizada, type Provedor } from './tipos'

/**
 * O canal genérico — e o mais importante dos quatro.
 *
 * ## Por que ele existe
 *
 * Telegram, Slack, Instagram Direct, SMS, Microsoft Teams, Discord, um chatbot
 * próprio. Cada um tem a sua API, o seu formato de webhook e o seu jeito de
 * autenticar — e construir um adaptador para cada um dentro desta base
 * significaria que a próxima ferramenta exige mais um, para sempre.
 *
 * O N8N (e o Make, e o Zapier, e qualquer coisa que fale HTTP) já resolve esse
 * problema: ele tem conector pronto para dezenas de serviços e permite montar o
 * fluxo sem programar. O que falta é um contrato dos dois lados — e é isso que
 * este adaptador é.
 *
 * **Entrada:** um `POST` com o JSON abaixo na URL do canal.
 * **Saída:** um `POST` com um JSON previsível na URL que o cliente configurar.
 *
 * Resultado: ligar o Telegram vira um fluxo de três nós no N8N, sem tocar neste
 * repositório. É o oposto de "integração nativa com 40 ferramentas", e entrega
 * mais do que ela — inclusive com as ferramentas que ainda não existem.
 *
 * ## O formato de entrada
 *
 * ```json
 * {
 *   "externo": "telegram-9981",
 *   "de": "telegram:123456789",
 *   "nome": "Fulana",
 *   "texto": "a impressora parou",
 *   "em": "2026-10-25T12:00:00Z"
 * }
 * ```
 *
 * `de` é o identificador da pessoa NAQUELE canal, e o prefixo é convenção de quem
 * monta o fluxo — `telegram:`, `sms:`, `slack:`. O sistema o trata como texto
 * opaco: ele só precisa ser estável, porque é por ele que a conversa é
 * reencontrada.
 *
 * Um array no lugar do objeto também é aceito: o nó HTTP do N8N manda lote
 * quando o gatilho produz vários itens, e recusar isso faria o fluxo mais
 * natural não funcionar.
 *
 * ## A autenticação é o segredo da URL
 *
 * Não há assinatura a conferir: o N8N não assina nada, e exigir que ele assinasse
 * obrigaria quem monta o fluxo a escrever código — que é exatamente o que ele veio
 * evitar.
 *
 * O que protege é o token na URL: 32 bytes de entropia, e a URL inteira é
 * tratada como credencial (não aparece em tela depois de criada, pelo mesmo
 * contrato de `dashboard_tokens`). Está dito aqui com todas as letras porque
 * "este canal não verifica assinatura" é informação de segurança, e quem liga um
 * canal destes precisa saber que a URL é a chave.
 */

export const n8n: Provedor = {
  nome: 'n8n',

  /*
   * Sem assinatura a conferir. Ver o comentário do módulo: o que autentica é o
   * token da URL, e exigir assinatura do N8N anularia a razão de ele existir
   * aqui.
   */
  verificar() {
    return true
  },

  normalizar(corpo) {
    /* Objeto ou array: o nó HTTP do N8N manda lote quando o gatilho produz
       vários itens, e recusar o lote faria o fluxo mais natural não funcionar. */
    const itens = Array.isArray(corpo) ? corpo : [corpo]
    const saida: MensagemNormalizada[] = []

    for (const item of itens.slice(0, 100)) {
      if (!item || typeof item !== 'object') continue
      const m = item as Record<string, unknown>

      /*
       * `body.de` ou `body.from`: aceitar os dois não é indulgência. Quem monta o
       * fluxo no N8N copia o nome do campo do serviço de origem, e metade dos
       * serviços chama de `from`. Recusar `from` produziria um 400 que o fluxo
       * engole em silêncio, e a mensagem sumiria sem rastro dos dois lados.
       */
      const de = primeiroTexto(m['de'], m['from'], m['remetente'])
      if (!de) continue

      saida.push({
        externo: primeiroTexto(m['externo'], m['id'], m['message_id']),
        de,
        nome: primeiroTexto(m['nome'], m['name'], m['nome_exibicao']),
        texto: primeiroTexto(m['texto'], m['text'], m['body'], m['message'])?.slice(0, 20000),
        em: dataIso(m['em'] ?? m['timestamp'] ?? m['date']),
        thread: primeiroTexto(m['thread'], m['thread_id'], m['chat_id']),
      })
    }

    return saida
  },

  /**
   * Entrega na URL configurada.
   *
   * O corpo é previsível e estável, porque ele é um contrato: quem montou o fluxo
   * no N8N mapeou estes campos, e mudá-los quebra o fluxo do cliente sem aviso.
   */
  async enviar(destino, texto, canal, credencial) {
    /*
     * A URL de destino vem da variável de ambiente quando `secret_ref` existe, e
     * de `outbound_url` quando não.
     *
     * A razão é que uma URL de webhook do N8N normalmente CONTÉM o segredo no
     * caminho — e segredo em coluna de tabela aparece em backup, em export de
     * suporte e na tela de quem tem select. Quando a URL é credencial, ela vai
     * para o ambiente; quando não é, pode ficar no banco.
     */
    const url = credencial ?? (typeof canal.config['url'] === 'string' ? canal.config['url'] : null)
    if (!url) return { ok: false, erro: 'Canal sem URL de saída configurada.' }
    if (!url.startsWith('https://')) {
      return { ok: false, erro: 'A URL de saída precisa ser https: o texto da conversa viaja nela.' }
    }

    let resposta: Response
    try {
      resposta = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ para: destino, texto, canal: canal.kind }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (e) {
      return { ok: false, erro: `Rede: ${e instanceof Error ? e.message : 'falha'}` }
    }

    if (!resposta.ok) {
      return { ok: false, erro: erroDeEntrega(resposta.status, await resposta.text()) }
    }
    return { ok: true }
  },
}

/** O primeiro valor que é texto não vazio. */
export function primeiroTexto(...valores: unknown[]): string | undefined {
  for (const v of valores) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return undefined
}

/**
 * Converte para ISO o que der, e devolve `undefined` para o que não der.
 *
 * Aceita ISO, segundos e milissegundos — os três aparecem conforme o serviço de
 * origem, e quem monta o fluxo não controla qual. O corte em 10^11 separa
 * segundos de milissegundos: um carimbo em segundos de 2026 tem 10 dígitos, um
 * em milissegundos tem 13.
 */
export function dataIso(bruto: unknown): string | undefined {
  if (typeof bruto === 'string' && bruto.trim() !== '') {
    const d = new Date(bruto)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }
  if (typeof bruto === 'number' && Number.isFinite(bruto) && bruto > 0) {
    const ms = bruto < 100_000_000_000 ? bruto * 1000 : bruto
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }
  return undefined
}
