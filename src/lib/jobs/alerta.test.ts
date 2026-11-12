import { describe, expect, it } from 'vitest'
import type { Provedor, Mensagem } from '@/lib/mail/provedor'
import {
  avisarEpisodios,
  avisoDeQuebra,
  avisoDeVolta,
  corpoDoWebhook,
  destinoConfigurado,
  duracaoEmPortugues,
  type ClienteDeAlerta,
  type Episodio,
} from './alerta'

const EPISODIO: Episodio = {
  id: 7,
  job: 'sla_alerts',
  tipo: 'parou',
  detalhe: 'Sem execução há 95 minutos (a tolerância é de 30).',
  aberto_em: '2026-03-10T03:00:00.000Z',
  fechado_em: null,
}

describe('duracaoEmPortugues', () => {
  it('conta em minutos, horas e dias', () => {
    expect(duracaoEmPortugues(30_000)).toBe('menos de um minuto')
    expect(duracaoEmPortugues(45 * 60_000)).toBe('45 min')
    expect(duracaoEmPortugues(120 * 60_000)).toBe('2 h')
    expect(duracaoEmPortugues(135 * 60_000)).toBe('2 h 15 min')
    expect(duracaoEmPortugues(48 * 60 * 60_000)).toBe('2 d')
    expect(duracaoEmPortugues(50 * 60 * 60_000)).toBe('2 d 2 h')
  })

  it('não devolve número negativo quando os relógios discordam', () => {
    // `fechado_em` antes de `aberto_em` acontece com relógio corrigido no meio
    // do episódio. "−3 min parado" é pior que inútil: faz duvidar do resto.
    expect(duracaoEmPortugues(-120_000)).toBe('menos de um minuto')
  })
})

describe('avisoDeQuebra', () => {
  it('usa o rótulo humano, e não o identificador, no assunto', () => {
    const a = avisoDeQuebra(EPISODIO, 'Alertas de SLA')
    expect(a.assunto).toBe('[STI] Alertas de SLA parou')
    // O identificador ainda aparece no corpo: é por ele que se procura no banco.
    expect(a.texto).toContain('sla_alerts')
  })

  it('diz "está falhando" quando falhou, e não "parou"', () => {
    const a = avisoDeQuebra({ ...EPISODIO, tipo: 'falhou' }, 'Alertas de SLA')
    expect(a.assunto).toContain('está falhando')
    expect(a.texto).toContain('terminou com erro')
  })

  it('inclui a consequência quando a expectativa a descreve', () => {
    const a = avisoDeQuebra(EPISODIO, 'Alertas de SLA', 'vira SLA estourado sem aviso')
    expect(a.texto).toContain('vira SLA estourado sem aviso')
  })

  it('avisa que não haverá repetição', () => {
    // É a frase que impede alguém de achar que o silêncio seguinte significa
    // que o problema sumiu.
    expect(avisoDeQuebra(EPISODIO, 'x').texto).toContain('UMA vez por episódio')
  })
})

describe('avisoDeVolta', () => {
  it('conta quanto durou', () => {
    const a = avisoDeVolta(
      { ...EPISODIO, fechado_em: '2026-03-10T05:15:00.000Z' },
      'Alertas de SLA',
    )
    expect(a.assunto).toContain('voltou ao normal')
    expect(a.texto).toContain('2 h 15 min')
  })

  it('diz que o que ficou para trás não se recupera sozinho', () => {
    const a = avisoDeVolta({ ...EPISODIO, fechado_em: '2026-03-10T04:00:00.000Z' }, 'x')
    expect(a.texto).toContain('NÃO é recuperado')
  })
})

describe('corpoDoWebhook', () => {
  it('nomeia o evento pelo tipo do episódio', () => {
    expect(corpoDoWebhook(EPISODIO, 'Alertas de SLA', 'quebrou').evento).toBe('trabalho.parou')
    expect(corpoDoWebhook({ ...EPISODIO, tipo: 'falhou' }, 'x', 'quebrou').evento).toBe(
      'trabalho.falhou',
    )
    expect(corpoDoWebhook(EPISODIO, 'x', 'voltou').evento).toBe('trabalho.voltou')
  })

  it('é plano: quem recebe não precisa desempacotar nada', () => {
    const corpo = corpoDoWebhook(EPISODIO, 'Alertas de SLA', 'quebrou')
    expect(Object.values(corpo).every((v) => v === null || typeof v !== 'object')).toBe(true)
  })
})

describe('destinoConfigurado', () => {
  it('trata string vazia como desligado', () => {
    // `ALERTA_OPERACAO_WEBHOOK=` no .env é o estado normal de quem não usa
    // webhook. Se virasse URL vazia, todo ciclo tentaria um POST para "".
    expect(destinoConfigurado({ ALERTA_OPERACAO_EMAIL: '', ALERTA_OPERACAO_WEBHOOK: '' })).toEqual({
      email: null,
      webhook: null,
    })
  })
})

// -----------------------------------------------------------------------------
// O cliente de mentira
// -----------------------------------------------------------------------------
interface Linha extends Record<string, unknown> {
  id: number
}

function clienteFalso(tabelas: Record<string, Linha[]>) {
  const atualizacoes: { tabela: string; id: number; valores: Record<string, unknown> }[] = []
  const insercoes: { tabela: string; valores: Record<string, unknown> }[] = []

  function consulta(linhas: Linha[]) {
    const api = {
      is(coluna: string, _valor: null) {
        return consulta(linhas.filter((l) => l[coluna] === null || l[coluna] === undefined))
      },
      not(coluna: string, _op: 'is', _valor: null) {
        return consulta(linhas.filter((l) => l[coluna] !== null && l[coluna] !== undefined))
      },
      order() {
        return api
      },
      limit() {
        return api
      },
      then<R>(resolver: (r: { data: Linha[]; error: null }) => R) {
        return Promise.resolve(resolver({ data: linhas, error: null }))
      },
    }
    return api
  }

  const cliente = {
    from(tabela: string) {
      return {
        select: () => consulta(tabelas[tabela] ?? []),
        update: (valores: Record<string, unknown>) => ({
          eq: (_c: string, id: number) => {
            atualizacoes.push({ tabela, id, valores })
            const alvo = (tabelas[tabela] ?? []).find((l) => l.id === id)
            if (alvo) Object.assign(alvo, valores)
            return Promise.resolve({ error: null })
          },
        }),
        insert: (valores: Record<string, unknown>) => {
          insercoes.push({ tabela, valores })
          return Promise.resolve({ error: null })
        },
      }
    },
  }

  return { cliente: cliente as unknown as ClienteDeAlerta, atualizacoes, insercoes }
}

function provedorFalso(responde: (m: Mensagem) => boolean = () => true) {
  const enviadas: Mensagem[] = []
  const provedor: Provedor = {
    nome: 'falso',
    async enviar(m) {
      enviadas.push(m)
      return responde(m) ? { ok: true, id: 'x' } : { ok: false, erro: 'provedor fora do ar' }
    },
  }
  return { provedor, enviadas }
}

const EXPECTATIVAS: Linha[] = [
  { id: 1, job: 'sla_alerts', rotulo: 'Alertas de SLA', observacao: 'vira SLA estourado' },
]

describe('avisarEpisodios', () => {
  it('sem canal nenhum, não marca nada como avisado', async () => {
    // O ponto inteiro: um episódio marcado sem ter sido enviado nunca mais será
    // anunciado. Quando alguém configurar o e-mail, a quebra em curso tem de
    // sair.
    const { cliente, atualizacoes } = clienteFalso({
      job_expectations: EXPECTATIVAS,
      job_alert_episodes: [{ ...EPISODIO, avisado_em: null, volta_avisada_em: null }],
    })

    const r = await avisarEpisodios(cliente, null, { email: null, webhook: null })

    expect(r.semCanal).toBe(true)
    expect(r.avisados).toBe(0)
    expect(atualizacoes).toHaveLength(0)
  })

  it('avisa a quebra uma vez e marca o episódio', async () => {
    const { cliente, atualizacoes } = clienteFalso({
      job_expectations: EXPECTATIVAS,
      job_alert_episodes: [{ ...EPISODIO, avisado_em: null, volta_avisada_em: null }],
    })
    const { provedor, enviadas } = provedorFalso()

    const r = await avisarEpisodios(cliente, provedor, { email: 'ops@exemplo.com' })

    expect(r).toMatchObject({ avisados: 1, normalizados: 0, falhas: 0, semCanal: false })
    expect(enviadas).toHaveLength(1)
    expect(enviadas[0].subject).toContain('Alertas de SLA')
    expect(atualizacoes[0].valores.avisado_em).toBeTruthy()
    expect(atualizacoes[0].valores.canais).toEqual(['email'])
  })

  it('não avisa de novo o episódio já avisado', async () => {
    const { cliente } = clienteFalso({
      job_expectations: EXPECTATIVAS,
      job_alert_episodes: [
        { ...EPISODIO, avisado_em: '2026-03-10T03:05:00.000Z', volta_avisada_em: null },
      ],
    })
    const { provedor, enviadas } = provedorFalso()

    const r = await avisarEpisodios(cliente, provedor, { email: 'ops@exemplo.com' })

    expect(r.avisados).toBe(0)
    expect(enviadas).toHaveLength(0)
  })

  it('quando nenhum canal funciona, guarda o erro e NÃO marca como avisado', async () => {
    const { cliente, atualizacoes } = clienteFalso({
      job_expectations: EXPECTATIVAS,
      job_alert_episodes: [{ ...EPISODIO, avisado_em: null, volta_avisada_em: null }],
    })
    const { provedor } = provedorFalso(() => false)

    const r = await avisarEpisodios(cliente, provedor, { email: 'ops@exemplo.com' })

    expect(r).toMatchObject({ avisados: 0, falhas: 1 })
    expect(atualizacoes[0].valores.avisado_em).toBeUndefined()
    expect(String(atualizacoes[0].valores.erro_do_aviso)).toContain('provedor fora do ar')
  })

  it('um canal de dois basta: avisa, marca, e registra o que caiu', async () => {
    const { cliente, atualizacoes } = clienteFalso({
      job_expectations: EXPECTATIVAS,
      job_alert_episodes: [{ ...EPISODIO, avisado_em: null, volta_avisada_em: null }],
    })
    const { provedor } = provedorFalso()

    const r = await avisarEpisodios(cliente, provedor, {
      email: 'ops@exemplo.com',
      // Endereço que não resolve: o webhook falha sem rede de verdade.
      webhook: 'http://127.0.0.1:1/alerta',
    })

    expect(r.avisados).toBe(1)
    expect(atualizacoes[0].valores.canais).toEqual(['email'])
    expect(String(atualizacoes[0].valores.erro_do_aviso)).toContain('webhook:')
  })

  it('quando NÃO consegue ler os episódios, diz que não conseguiu', async () => {
    /*
     * A regressão que mais importa deste módulo.
     *
     * Na primeira vez que esta rotina rodou contra o banco de verdade, o `select`
     * voltava "permission denied for table job_expectations", o código fazia
     * `const { data } = await ...` e seguia com a lista vazia. A resposta era
     * `avisados: 0, falhas: 0` — indistinguível de um sistema saudável e quieto.
     *
     * Num módulo cujo trabalho inteiro é avisar, "não consegui ler" não pode se
     * parecer com "não havia nada a avisar".
     */
    const cliente = {
      from: () => ({
        select: () => ({
          is: () => ({
            is: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: null, error: { message: 'permission denied' } }),
              }),
            }),
          }),
          then: (r: (x: { data: null; error: null }) => unknown) =>
            Promise.resolve(r({ data: null, error: null })),
        }),
      }),
    } as unknown as ClienteDeAlerta

    const { provedor } = provedorFalso()
    const r = await avisarEpisodios(cliente, provedor, { email: 'ops@exemplo.com' })

    expect(r.erro).toBe('permission denied')
    expect(r.semCanal).toBe(false) // havia canal: o problema não foi falta de configuração
  })

  it('anuncia a volta só do episódio que teve a quebra anunciada', async () => {
    const { cliente, atualizacoes } = clienteFalso({
      job_expectations: EXPECTATIVAS,
      job_alert_episodes: [
        // Este teve quebra anunciada e fechou: merece o aviso de volta.
        {
          ...EPISODIO,
          id: 1,
          avisado_em: '2026-03-10T03:05:00.000Z',
          fechado_em: '2026-03-10T05:15:00.000Z',
          volta_avisada_em: null,
        },
        // Este abriu e fechou entre duas execuções, sem ninguém nunca saber.
        // Anunciar que ele "voltou ao normal" confundiria quem lê.
        {
          ...EPISODIO,
          id: 2,
          avisado_em: null,
          fechado_em: '2026-03-10T05:15:00.000Z',
          volta_avisada_em: null,
        },
      ],
    })
    const { provedor, enviadas } = provedorFalso()

    const r = await avisarEpisodios(cliente, provedor, { email: 'ops@exemplo.com' })

    expect(r.normalizados).toBe(1)
    expect(enviadas).toHaveLength(1)
    expect(enviadas[0].subject).toContain('voltou ao normal')
    expect(atualizacoes.filter((a) => a.valores.volta_avisada_em)).toHaveLength(1)
    expect(atualizacoes[0].id).toBe(1)
  })
})
