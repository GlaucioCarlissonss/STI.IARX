import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { respostaDoApertoDeMao, whatsapp } from './whatsapp'
import type { CanalResolvido } from './tipos'

/**
 * A assinatura e a normalização são as duas coisas que, erradas, quebram tudo em
 * silêncio: a primeira faz a Meta "parar de entregar" (porque toda entrega passa
 * a ser recusada), e a segunda faz a mensagem virar chamado sem texto.
 *
 * Os payloads abaixo são os da documentação da Cloud API, copiados — não
 * inventados. É o mais perto de verdade que dá para chegar sem uma credencial da
 * Meta, e está dito no adaptador que a primeira ligação real pode exigir ajuste.
 */

const SEGREDO = 'app-secret-de-teste'

function canal(config: Record<string, unknown> = {}): CanalResolvido {
  return {
    kind: 'whatsapp',
    status: 'ativo',
    config: { app_secret_ref: 'TESTE_APP_SECRET', phone_number_id: '123456', ...config },
    secret_ref: 'TESTE_TOKEN',
  }
}

function assinar(corpo: string): Headers {
  const h = new Headers()
  h.set('x-hub-signature-256', `sha256=${createHmac('sha256', SEGREDO).update(corpo).digest('hex')}`)
  return h
}

describe('verificação da assinatura', () => {
  it('aceita a assinatura correta sobre os bytes CRUS', () => {
    process.env.TESTE_APP_SECRET = SEGREDO
    const corpo = '{"object":"whatsapp_business_account","entry":[]}'
    expect(whatsapp.verificar(new TextEncoder().encode(corpo), assinar(corpo), canal())).toBe(true)
  })

  it('recusa a assinatura de outro corpo', () => {
    /*
     * É o cenário real do erro mais comum desta integração: o corpo é
     * re-serializado (`JSON.parse` + `JSON.stringify`) antes de verificar, o
     * espaçamento muda, e o HMAC deixa de bater. O sintoma é "a Meta parou de
     * entregar", porque toda entrega passa a ser recusada.
     */
    process.env.TESTE_APP_SECRET = SEGREDO
    const original = '{"a":1}'
    const reserializado = '{ "a": 1 }'
    expect(
      whatsapp.verificar(new TextEncoder().encode(reserializado), assinar(original), canal()),
    ).toBe(false)
  })

  it('recusa quando NÃO há App Secret configurado', () => {
    /*
     * A trava que importa. Um webhook de WhatsApp sem verificação de assinatura
     * aceita mensagem forjada de qualquer remetente — e mensagem forjada vira
     * chamado com o nome de outra pessoa.
     *
     * Fechado por falta de configuração, nunca aberto: o canal recusa tudo até
     * alguém configurar, o que é visível, em vez de aceitar tudo, o que não é.
     */
    delete process.env.TESTE_APP_SECRET
    const corpo = '{"a":1}'
    expect(whatsapp.verificar(new TextEncoder().encode(corpo), assinar(corpo), canal())).toBe(false)
  })

  it('recusa cabeçalho ausente, vazio ou de tamanho errado', () => {
    process.env.TESTE_APP_SECRET = SEGREDO
    const bytes = new TextEncoder().encode('{"a":1}')
    expect(whatsapp.verificar(bytes, new Headers(), canal())).toBe(false)

    const curto = new Headers({ 'x-hub-signature-256': 'sha256=abc' })
    expect(whatsapp.verificar(bytes, curto, canal())).toBe(false)

    // Sem o prefixo `sha256=` o valor não é o que a Meta manda.
    const semPrefixo = new Headers({ 'x-hub-signature-256': 'a'.repeat(64) })
    expect(whatsapp.verificar(bytes, semPrefixo, canal())).toBe(false)
  })

  it('recusa hexa inválido sem estourar', () => {
    // `Buffer.from(x, 'hex')` com caractere inválido devolve buffer curto, e
    // `timingSafeEqual` lança. O adaptador tem de recusar, não quebrar a rota.
    process.env.TESTE_APP_SECRET = SEGREDO
    const h = new Headers({ 'x-hub-signature-256': `sha256=${'z'.repeat(64)}` })
    expect(whatsapp.verificar(new TextEncoder().encode('{}'), h, canal())).toBe(false)
  })
})

describe('normalização', () => {
  const envelope = (valor: Record<string, unknown>) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA_ID', changes: [{ field: 'messages', value: valor }] }],
  })

  it('lê uma mensagem de texto com o nome do perfil', () => {
    const msgs = whatsapp.normalizar(
      envelope({
        messaging_product: 'whatsapp',
        contacts: [{ profile: { name: 'Fulana de Tal' }, wa_id: '5544999887766' }],
        messages: [
          {
            from: '5544999887766',
            id: 'wamid.AAA',
            timestamp: '1761400000',
            type: 'text',
            text: { body: 'a impressora parou' },
          },
        ],
      }),
      canal(),
    )

    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      externo: 'wamid.AAA',
      de: '5544999887766',
      // O nome vem de um array SEPARADO das mensagens, indexado pelo wa_id. Sem
      // esse cruzamento, a tela de conversas seria uma coluna de telefones.
      nome: 'Fulana de Tal',
      texto: 'a impressora parou',
    })
    expect(msgs[0]!.em).toBe(new Date(1761400000 * 1000).toISOString())
  })

  it('trata o carimbo como SEGUNDOS, não milissegundos', () => {
    // A Meta manda segundos, como texto. Tratar como milissegundos colocaria
    // toda mensagem em 1970 — e o gráfico, o SLA e a ordem da conversa junto.
    const msgs = whatsapp.normalizar(
      envelope({
        messages: [{ from: '55449', id: 'x', timestamp: '1761400000', type: 'text', text: { body: 'oi' } }],
      }),
      canal(),
    )
    expect(new Date(msgs[0]!.em!).getUTCFullYear()).toBeGreaterThan(2020)
  })

  it('devolve ZERO para eventos de status — e isso é o caminho normal', () => {
    /*
     * A Meta manda `sent`, `delivered`, `read` e `failed` no MESMO webhook das
     * mensagens. Numa conversa ativa há três ou quatro status para cada mensagem
     * de verdade; tratá-los como erro encheria o registro de falhas em operação
     * perfeitamente normal.
     */
    const msgs = whatsapp.normalizar(
      envelope({
        statuses: [{ id: 'wamid.AAA', status: 'delivered', timestamp: '1761400000' }],
      }),
      canal(),
    )
    expect(msgs).toEqual([])
  })

  it('usa a legenda do anexo como texto', () => {
    // Sem isto, um chamado aberto por uma foto com legenda "a tela está assim"
    // nasceria sem título nenhum.
    const msgs = whatsapp.normalizar(
      envelope({
        messages: [
          {
            from: '55449',
            id: 'wamid.IMG',
            timestamp: '1761400000',
            type: 'image',
            image: { id: 'MEDIA_ID', mime_type: 'image/jpeg', caption: 'a tela está assim' },
          },
        ],
      }),
      canal(),
    )
    expect(msgs[0]!.texto).toBe('a tela está assim')
    expect(msgs[0]!.midia).toEqual([{ tipo: 'image', nome: undefined, id: 'MEDIA_ID' }])
  })

  it('lê o título do botão que a pessoa tocou, não o id', () => {
    // O id é do nosso lado e não diz nada a quem lê o chamado.
    const msgs = whatsapp.normalizar(
      envelope({
        messages: [
          {
            from: '55449',
            id: 'wamid.BTN',
            timestamp: '1761400000',
            type: 'interactive',
            interactive: { type: 'button_reply', button_reply: { id: 'op_1', title: 'Sim, resolveu' } },
          },
        ],
      }),
      canal(),
    )
    expect(msgs[0]!.texto).toBe('Sim, resolveu')
  })

  it('registra tipo desconhecido em vez de descartar a mensagem', () => {
    // A Meta lança tipo novo sem avisar. A pessoa escreveu alguma coisa, e
    // perdê-la é pior que registrá-la sem o conteúdo.
    const msgs = whatsapp.normalizar(
      envelope({
        messages: [{ from: '55449', id: 'wamid.NEW', timestamp: '1761400000', type: 'tipo_novo' }],
      }),
      canal(),
    )
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.texto).toContain('tipo_novo')
  })

  it('não quebra com payload fora de forma', () => {
    for (const lixo of [null, undefined, {}, { entry: 'nao-e-array' }, { entry: [{}] }, []]) {
      expect(whatsapp.normalizar(lixo, canal())).toEqual([])
    }
  })
})

describe('aperto de mão', () => {
  it('devolve o challenge quando o token bate', () => {
    const url = new URL(
      'https://x/api/canais/tok?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=1234',
    )
    expect(respostaDoApertoDeMao(url, 'tok')).toBe('1234')
  })

  it('recusa token errado e modo errado', () => {
    const errado = new URL(
      'https://x/api/canais/tok?hub.mode=subscribe&hub.verify_token=outro&hub.challenge=1234',
    )
    expect(respostaDoApertoDeMao(errado, 'tok')).toBeNull()

    const modo = new URL(
      'https://x/api/canais/tok?hub.mode=unsubscribe&hub.verify_token=tok&hub.challenge=1234',
    )
    expect(respostaDoApertoDeMao(modo, 'tok')).toBeNull()
  })
})

describe('envio', () => {
  it('recusa sem credencial e sem phone_number_id', async () => {
    expect(await whatsapp.enviar('55449', 'oi', canal(), null)).toEqual({
      ok: false,
      erro: 'Canal sem credencial configurada.',
    })
    const semNumero = { ...canal(), config: { app_secret_ref: 'X' } }
    const r = await whatsapp.enviar('55449', 'oi', semNumero, 'token')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.erro).toContain('phone_number_id')
  })
})
