import { describe, expect, it } from 'vitest'
import { bitrix24 } from './bitrix24'
import { email } from './email'
import { dataIso, n8n, primeiroTexto } from './n8n'
import { provedorDoCanal, ROTULO_DO_CANAL, EXIGENCIAS_DO_CANAL } from './registro'
import { credencialDoCanal, mensagemNormalizadaSchema } from './tipos'
import type { CanalResolvido } from './tipos'

const canal = (kind: CanalResolvido['kind'], config: Record<string, unknown> = {}): CanalResolvido => ({
  kind,
  status: 'ativo',
  config,
  secret_ref: null,
})

describe('registro de provedores', () => {
  it('tem adaptador para todo tipo que o banco aceita', () => {
    /*
     * O CHECK de `channels.kind` na migração 0034 lista estes quatro. Um tipo no
     * banco sem adaptador aqui produziria um canal que se cria, recebe webhook e
     * não faz nada — descoberto em produção, por uma mensagem que sumiu.
     */
    for (const kind of ['whatsapp', 'email', 'bitrix24', 'n8n']) {
      expect(provedorDoCanal(kind)).not.toBeNull()
      expect(ROTULO_DO_CANAL[kind as keyof typeof ROTULO_DO_CANAL]).toBeTruthy()
      expect(EXIGENCIAS_DO_CANAL[kind as keyof typeof EXIGENCIAS_DO_CANAL].length).toBeGreaterThan(0)
    }
    expect(provedorDoCanal('telegram')).toBeNull()
  })
})

describe('credencialDoCanal', () => {
  it('lê do ambiente pelo nome que o canal guardou', () => {
    process.env.TESTE_CRED_CANAL = 'valor-secreto'
    expect(credencialDoCanal('TESTE_CRED_CANAL')).toBe('valor-secreto')
  })

  it('recusa o que não é nome de variável', () => {
    /*
     * `process.env[x]` com `x` vindo de uma linha de tabela é exatamente o tipo
     * de leitura que alguém usaria para sondar o ambiente. A validação repete a
     * do CHECK no banco de propósito: uma camada muda e a outra esquecida é
     * defeito; duas dizendo a mesma coisa é redundância barata.
     */
    expect(credencialDoCanal('caminho/estranho')).toBeNull()
    expect(credencialDoCanal('minuscula')).toBeNull()
    expect(credencialDoCanal('')).toBeNull()
    expect(credencialDoCanal(null)).toBeNull()
  })

  it('devolve nulo quando a variável não existe — não é erro', () => {
    // Canal sem credencial recebe e não responde, como a caixa de saída de
    // e-mail sem RESEND_API_KEY.
    delete process.env.TESTE_CRED_AUSENTE
    expect(credencialDoCanal('TESTE_CRED_AUSENTE')).toBeNull()
  })
})

describe('n8n — o canal genérico', () => {
  it('aceita `de` e também `from`', () => {
    /*
     * Não é indulgência. Quem monta o fluxo copia o nome do campo do serviço de
     * origem, e metade deles chama de `from`. Recusar produziria um 400 que o
     * fluxo engole em silêncio, e a mensagem sumiria sem rastro dos dois lados.
     */
    expect(n8n.normalizar({ de: 'telegram:1', texto: 'oi' }, canal('n8n'))[0]?.de).toBe('telegram:1')
    expect(n8n.normalizar({ from: 'telegram:1', text: 'oi' }, canal('n8n'))[0]?.de).toBe('telegram:1')
  })

  it('aceita lote, porque o nó HTTP do N8N manda lote', () => {
    const msgs = n8n.normalizar(
      [
        { de: 'sms:1', texto: 'um' },
        { de: 'sms:2', texto: 'dois' },
      ],
      canal('n8n'),
    )
    expect(msgs.map((m) => m.texto)).toEqual(['um', 'dois'])
  })

  it('descarta o item sem remetente e mantém o resto', () => {
    const msgs = n8n.normalizar([{ texto: 'sem quem' }, { de: 'sms:2', texto: 'ok' }], canal('n8n'))
    expect(msgs).toHaveLength(1)
  })

  it('não verifica assinatura, e isso está declarado', () => {
    // O N8N não assina nada, e exigir que assinasse obrigaria quem monta o fluxo
    // a escrever código — que é o que ele veio evitar. O que protege é o token
    // da URL, e as exigências do canal dizem isso com todas as letras.
    expect(n8n.verificar(new Uint8Array(), new Headers(), canal('n8n'))).toBe(true)
    expect(EXIGENCIAS_DO_CANAL.n8n.join(' ')).toContain('não confere assinatura')
  })

  it('recusa URL de saída que não é https', async () => {
    const r = await n8n.enviar('x', 'oi', canal('n8n', { url: 'http://interno/webhook' }), null)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.erro).toContain('https')
  })
})

describe('dataIso', () => {
  it('aceita ISO, segundos e milissegundos', () => {
    /*
     * Os três aparecem conforme o serviço de origem, e quem monta o fluxo no N8N
     * não controla qual. O corte separa segundos de milissegundos: um carimbo em
     * segundos de 2026 tem 10 dígitos, um em milissegundos tem 13.
     */
    expect(dataIso('2026-01-01T12:00:00Z')).toBe('2026-01-01T12:00:00.000Z')
    expect(dataIso(1767268800)).toBe('2026-01-01T12:00:00.000Z')
    expect(dataIso(1767268800000)).toBe('2026-01-01T12:00:00.000Z')
  })

  it('devolve undefined para o que não dá', () => {
    for (const lixo of ['ontem', '', null, undefined, 0, -5, {}]) {
      expect(dataIso(lixo)).toBeUndefined()
    }
  })
})

describe('primeiroTexto', () => {
  it('pula vazio e espaço, e aceita número', () => {
    expect(primeiroTexto(null, '', '  ', 'achou', 'depois')).toBe('achou')
    // O Bitrix24 manda id de usuário como número.
    expect(primeiroTexto(undefined, 123)).toBe('123')
    expect(primeiroTexto(null, undefined)).toBeUndefined()
  })
})

describe('bitrix24', () => {
  it('lê a mensagem de dentro de data.PARAMS, com chave em MAIÚSCULAS', () => {
    const msgs = bitrix24.normalizar(
      {
        event: 'ONIMBOTMESSAGEADD',
        data: {
          PARAMS: {
            MESSAGE_ID: '9981',
            FROM_USER_ID: '42',
            MESSAGE: 'a impressora parou',
            DIALOG_ID: 'chat77',
          },
          USER: { NAME: 'Fulana' },
        },
      },
      canal('bitrix24'),
    )

    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      externo: '9981',
      // Prefixo `bitrix:`: o id do Bitrix24 é um número de usuário, e um número
      // solto colidiria com um telefone se alguém trocasse o tipo do canal.
      de: 'bitrix:42',
      texto: 'a impressora parou',
      thread: 'chat77',
    })
  })

  it('devolve zero para evento sem remetente', () => {
    expect(bitrix24.normalizar({ event: 'ONTASKADD', data: {} }, canal('bitrix24'))).toEqual([])
    expect(bitrix24.normalizar(null, canal('bitrix24'))).toEqual([])
  })

  it('confere o application_token quando ele está configurado', () => {
    process.env.TESTE_BITRIX_TOKEN = 'tok-do-app'
    const c = canal('bitrix24', { application_token_ref: 'TESTE_BITRIX_TOKEN' })

    const bom = new TextEncoder().encode('auth%5Bapplication_token%5D=tok-do-app&event=X')
    expect(bitrix24.verificar(bom, new Headers(), c)).toBe(true)

    const ruim = new TextEncoder().encode('auth%5Bapplication_token%5D=outro&event=X')
    expect(bitrix24.verificar(ruim, new Headers(), c)).toBe(false)
  })

  it('fecha quando o token está configurado e a variável não existe', () => {
    // Configurado e ausente = fechado, nunca aberto. É o mesmo princípio de
    // JOBS_SECRET e do App Secret da Meta.
    delete process.env.TESTE_BITRIX_AUSENTE
    const c = canal('bitrix24', { application_token_ref: 'TESTE_BITRIX_AUSENTE' })
    expect(bitrix24.verificar(new Uint8Array(), new Headers(), c)).toBe(false)
  })

  it('sem application_token configurado, apoia-se no segredo da URL', () => {
    expect(bitrix24.verificar(new Uint8Array(), new Headers(), canal('bitrix24'))).toBe(true)
  })

  it('recusa envio sem credencial, dizendo POR QUÊ', async () => {
    const r = await bitrix24.enviar('bitrix:42', 'oi', canal('bitrix24'), null)
    expect(r.ok).toBe(false)
    // A URL do webhook de entrada do Bitrix24 contém o segredo no caminho — por
    // isso ela mora no ambiente, e a mensagem explica isso a quem for configurar.
    expect(!r.ok && r.erro).toContain('segredo')
  })
})

describe('email', () => {
  it('extrai o endereço de "Nome <endereco>"', () => {
    /*
     * O endereço é a identidade do contato e precisa ser estável: `Fulana de Tal
     * <x@y>` e `"Fulana" <x@y>` são a mesma pessoa, e guardar a string inteira
     * criaria dois contatos — e dois chamados paralelos para a mesma conversa.
     */
    const msgs = email.normalizar(
      { from: 'Fulana de Tal <Fulana@Empresa.com.BR>', subject: 'ajuda', text: 'não entro' },
      canal('email'),
    )
    expect(msgs[0]!.de).toBe('fulana@empresa.com.br')
    expect(msgs[0]!.nome).toBe('Fulana de Tal')
  })

  it('aceita os nomes de campo dos três provedores', () => {
    // Escolher um só obrigaria o cliente a usar aquele provedor — e trocar de
    // provedor é justamente a razão de usar um.
    for (const corpo of [
      { from: 'a@b.com', text: 'resend' },
      { From: 'a@b.com', TextBody: 'postmark' },
      { sender: 'a@b.com', 'body-plain': 'mailgun' },
    ]) {
      const m = email.normalizar(corpo, canal('email'))
      expect(m).toHaveLength(1)
      expect(m[0]!.de).toBe('a@b.com')
    }
  })

  it('cai para o HTML quando não há texto, e tira a marcação', () => {
    const msgs = email.normalizar(
      { from: 'a@b.com', html: '<p>a impressora<br>parou</p>' },
      canal('email'),
    )
    expect(msgs[0]!.texto).toContain('a impressora')
    expect(msgs[0]!.texto).not.toContain('<p>')
  })

  it('põe o assunto no corpo, e NÃO o usa como título', () => {
    /*
     * Quem responde um e-mail de suporte deixa "Re: Re: Enc:" no assunto, e
     * usá-lo como título daria uma fila inteira de "Re: Re:". O título sai do
     * começo da mensagem; o assunto fica registrado porque às vezes é a única
     * coisa que a pessoa escreveu.
     */
    const msgs = email.normalizar(
      { from: 'a@b.com', subject: 'Re: Re: Enc: chamado', text: 'segue em anexo' },
      canal('email'),
    )
    expect(msgs[0]!.texto).toContain('Assunto: Re: Re: Enc: chamado')
    expect(msgs[0]!.texto).toContain('segue em anexo')
  })

  it('devolve zero quando não dá para saber o remetente', () => {
    expect(email.normalizar({ subject: 'órfão' }, canal('email'))).toEqual([])
    expect(email.normalizar({ from: 'nao-e-endereco' }, canal('email'))).toEqual([])
  })

  it('lê anexos por referência', () => {
    const msgs = email.normalizar(
      {
        from: 'a@b.com',
        text: 'veja',
        attachments: [{ filename: 'erro.png', content_type: 'image/png', url: 'https://x/y' }],
      },
      canal('email'),
    )
    expect(msgs[0]!.midia).toEqual([{ tipo: 'image/png', nome: 'erro.png', url: 'https://x/y' }])
  })
})

describe('o schema da mensagem normalizada', () => {
  it('exige remetente e recusa texto absurdo', () => {
    expect(mensagemNormalizadaSchema.safeParse({ texto: 'sem de' }).success).toBe(false)
    expect(mensagemNormalizadaSchema.safeParse({ de: 'x' }).success).toBe(true)
    expect(
      mensagemNormalizadaSchema.safeParse({ de: 'x', texto: 'y'.repeat(20_001) }).success,
    ).toBe(false)
  })

  it('recusa data que não é data', () => {
    // Um carimbo inválido do provedor viraria `now()` no banco se passasse — e a
    // ordem da conversa é lida por ele.
    expect(mensagemNormalizadaSchema.safeParse({ de: 'x', em: 'ontem' }).success).toBe(false)
  })

  it('aceita a saída de todos os adaptadores', () => {
    /*
     * A prova de que a forma única existe de verdade: o que cada adaptador
     * produz passa pelo mesmo schema que a rota aplica antes de chamar o banco.
     * Sem esta asserção, um adaptador poderia produzir um campo a mais ou um
     * tipo errado e só quebrar em produção.
     */
    const amostras = [
      n8n.normalizar({ de: 'telegram:1', texto: 'oi', em: 1767268800 }, canal('n8n')),
      bitrix24.normalizar(
        { data: { PARAMS: { FROM_USER_ID: '42', MESSAGE: 'oi', MESSAGE_ID: '1' } } },
        canal('bitrix24'),
      ),
      email.normalizar({ from: 'a@b.com', text: 'oi' }, canal('email')),
    ].flat()

    expect(amostras.length).toBeGreaterThan(0)
    for (const m of amostras) {
      const r = mensagemNormalizadaSchema.safeParse(m)
      expect(r.success, `falhou: ${JSON.stringify(m)}`).toBe(true)
    }
  })
})
