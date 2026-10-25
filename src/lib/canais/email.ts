import { htmlToText } from '@/lib/integrations/mapping'
import { provedorConfigurado } from '@/lib/mail/provedor'
import { type Entrega, type MensagemNormalizada, type Provedor } from './tipos'
import { dataIso, primeiroTexto } from './n8n'

/**
 * E-mail entrante virando chamado.
 *
 * ## Por que o adaptador não fala SMTP
 *
 * Receber e-mail de verdade significa um servidor SMTP: porta 25 aberta, registro
 * reverso, SPF, DKIM, DMARC, lista de bloqueio, antivírus e fila de retentativa.
 * É um produto inteiro, e um mal feito faz o domínio da empresa cair em lista de
 * spam — o que custa muito mais que o recurso vale.
 *
 * O caminho que este adaptador usa é o que todo mundo usa: um provedor de
 * recebimento (Resend, Postmark, Mailgun, SendGrid) aponta um webhook para a URL
 * deste canal. Eles já resolveram SMTP, assinatura e antivírus, e cobram pouco.
 *
 * ## Por que ele aceita três formatos
 *
 * Cada provedor nomeia os campos de um jeito — `from`/`From`/`sender`,
 * `text`/`TextBody`/`body-plain`. Escolher um só obrigaria o cliente a usar
 * aquele provedor, e trocar de provedor é justamente a razão de usar um.
 *
 * A normalização procura o campo nos nomes conhecidos e usa o primeiro que achar.
 * É menos elegante que um adaptador por provedor e não exige um arquivo novo
 * quando o cliente muda de ideia.
 *
 * ## O que eu NÃO pude verificar
 *
 * A assinatura de webhook de cada provedor **não é conferida** — e isso está
 * escrito aqui, e não escondido. Resend, Postmark e Mailgun assinam de jeitos
 * diferentes (Svix, HMAC próprio, token por timestamp), e implementar os três
 * sem poder testar contra nenhum produziria três verificações que parecem
 * funcionar. O que autentica, por enquanto, é o segredo da URL.
 *
 * Quem for ligar isto em produção deve restringir a origem no proxy ao IP do
 * provedor, e está dito em docs/16.
 */

/** Os nomes que os provedores usam para "de quem veio". */
function remetente(m: Record<string, unknown>): string | undefined {
  const bruto = primeiroTexto(
    m['from'],
    m['From'],
    m['sender'],
    m['de'],
    (m['envelope'] as Record<string, unknown> | undefined)?.['from'],
  )
  if (!bruto) return undefined

  /*
   * `Fulana de Tal <fulana@empresa.com.br>` → `fulana@empresa.com.br`.
   *
   * O endereço é a identidade do contato, e precisa ser estável: `Fulana de Tal
   * <x@y>` e `"Fulana" <x@y>` são a mesma pessoa, e guardar a string inteira
   * criaria dois contatos — e dois chamados paralelos para a mesma conversa.
   */
  const entreSinais = bruto.match(/<([^>]+)>/)
  const endereco = (entreSinais?.[1] ?? bruto).trim().toLowerCase()
  return endereco.includes('@') ? endereco : undefined
}

/** O nome de exibição, quando o cabeçalho traz um. */
function nomeDoRemetente(m: Record<string, unknown>): string | undefined {
  const bruto = primeiroTexto(m['from'], m['From'], m['sender'], m['de'])
  if (!bruto) return undefined
  const antes = bruto.split('<')[0]?.trim().replace(/^"|"$/g, '')
  return antes && antes !== '' && antes.includes('@') === false ? antes : undefined
}

export const email: Provedor = {
  nome: 'email',

  /*
   * Sem verificação de assinatura — ver o comentário do módulo. O que autentica é
   * o segredo da URL, e a recomendação de restringir a origem no proxy está em
   * docs/16. Devolver `true` aqui é a escolha honesta: uma verificação
   * implementada às cegas para três provedores diferentes pareceria proteção e
   * não seria.
   */
  verificar() {
    return true
  },

  normalizar(corpo) {
    const raiz = corpo as Record<string, unknown>
    /* Alguns provedores embrulham o evento: `{type, data: {...}}`. */
    const m = ((raiz?.['data'] as Record<string, unknown>) ?? raiz) as Record<string, unknown>
    if (!m || typeof m !== 'object') return []

    const de = remetente(m)
    if (!de) return []

    /*
     * O corpo em TEXTO vem primeiro; o HTML só quando não há texto.
     *
     * `htmlToText` já existe neste repositório desde o Integration Hub (0009) e é
     * reusado de propósito — duas implementações de "tirar marcação de um corpo
     * de e-mail" divergiriam, e a divergência apareceria como comentário com
     * `<div>` no meio, num chamado, na frente do cliente.
     */
    const texto =
      primeiroTexto(m['text'], m['TextBody'], m['body-plain'], m['plain'], m['texto']) ??
      (() => {
        const html = primeiroTexto(m['html'], m['HtmlBody'], m['body-html'])
        return html ? htmlToText(html) : undefined
      })()

    const assunto = primeiroTexto(m['subject'], m['Subject'], m['assunto'])

    return [
      {
        externo: primeiroTexto(
          m['message_id'],
          m['MessageID'],
          m['Message-Id'],
          m['messageId'],
          m['id'],
        ),
        de,
        nome: nomeDoRemetente(m),
        /*
         * O assunto entra no começo do corpo, e não vira o título sozinho.
         *
         * Quem responde um e-mail de suporte deixa "Re: Re: Enc: chamado" no
         * assunto, e usá-lo como título daria uma fila inteira de "Re: Re:". O
         * título do chamado sai do começo da mensagem (regra de
         * `channel_ingest`); o assunto fica registrado porque às vezes ele é a
         * única coisa que a pessoa escreveu.
         */
        texto: [assunto ? `Assunto: ${assunto}` : null, texto]
          .filter(Boolean)
          .join('\n\n')
          .slice(0, 20000),
        em: dataIso(m['date'] ?? m['Date'] ?? m['timestamp'] ?? m['created_at']),
        /* `In-Reply-To` é o que liga a resposta à conversa original no e-mail.
           Guardá-lo não muda o threading (quem decide é o contato + conversa
           aberta), mas é o que permitirá responder com o cabeçalho certo. */
        thread: primeiroTexto(m['in_reply_to'], m['InReplyTo'], m['In-Reply-To'], m['references']),
        midia: anexos(m),
      },
    ]
  },

  /**
   * A resposta sai pela caixa de saída de e-mail que já existe (0029).
   *
   * Este `enviar` devolve uma instrução, não um envio: quem fala com o Resend é
   * `drenarCaixaDeSaida`, e duplicar isso aqui daria dois lugares com política
   * de retentativa, backoff e registro de erro — e eles divergiriam.
   *
   * O retorno `ok: false` com a explicação é deliberado: a mensagem fica na fila
   * de saída do canal com o motivo visível, em vez de sumir.
   */
  async enviar(destino, texto) {
    const provedor = provedorConfigurado()
    if (!provedor) {
      return {
        ok: false,
        erro: 'Sem provedor de e-mail configurado (RESEND_API_KEY e MAIL_FROM).',
      }
    }

    const r = await provedor.enviar({
      to: destino,
      toName: null,
      subject: 'Resposta do suporte',
      text: texto,
    })
    return r.ok ? { ok: true, externo: r.id } : { ok: false, erro: r.erro }
  },
}

/** Anexos por referência, como em todo canal. */
function anexos(m: Record<string, unknown>): MensagemNormalizada['midia'] {
  const bruto = m['attachments'] ?? m['Attachments']
  if (!Array.isArray(bruto) || bruto.length === 0) return undefined

  const saida: NonNullable<MensagemNormalizada['midia']> = []
  for (const a of bruto.slice(0, 20)) {
    if (!a || typeof a !== 'object') continue
    const x = a as Record<string, unknown>
    saida.push({
      tipo: primeiroTexto(x['content_type'], x['ContentType'], x['type']) ?? 'arquivo',
      nome: primeiroTexto(x['filename'], x['Name'], x['name']),
      url: primeiroTexto(x['url'], x['Url']),
    })
  }
  return saida.length > 0 ? saida : undefined
}

export type { Entrega }
