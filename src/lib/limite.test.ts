import { describe, expect, it, vi } from 'vitest'
import {
  ipDoCliente,
  origemHasheada,
  permitirRequisicao,
  LIMITES,
  type ClienteDeLimite,
} from './limite'

describe('ipDoCliente', () => {
  it('pega o ÚLTIMO item do X-Forwarded-For, e não o primeiro', () => {
    /*
     * A asserção que justifica este módulo existir.
     *
     * O Caddy ACRESCENTA ao cabeçalho. Se o visitante o mandar já preenchido,
     * o primeiro item é o que ELE escreveu e o último é o que o Caddy viu.
     * Pegar o primeiro — o padrão de quase toda biblioteca, e o que "parece
     * certo" — entregaria a chave do limite a quem está sendo limitado.
     */
    expect(ipDoCliente({ xForwardedFor: '9.9.9.9, 203.0.113.7' })).toBe('203.0.113.7')
  })

  it('com um proxy só, a lista tem um item e ele é o cliente', () => {
    expect(ipDoCliente({ xForwardedFor: '203.0.113.7' })).toBe('203.0.113.7')
  })

  it('tolera espaços, que é como os proxies de verdade escrevem', () => {
    expect(ipDoCliente({ xForwardedFor: ' 9.9.9.9 ,  203.0.113.7 ' })).toBe('203.0.113.7')
  })

  it('cai para X-Real-IP quando não há lista', () => {
    expect(ipDoCliente({ xRealIp: '203.0.113.9' })).toBe('203.0.113.9')
  })

  it('prefere o X-Forwarded-For, que é o que o Caddy manda', () => {
    expect(ipDoCliente({ xForwardedFor: '203.0.113.7', xRealIp: '9.9.9.9' })).toBe('203.0.113.7')
  })

  it('sem cabeçalho nenhum devolve nulo', () => {
    expect(ipDoCliente({})).toBeNull()
    expect(ipDoCliente({ xForwardedFor: '', xRealIp: '  ' })).toBeNull()
  })
})

describe('origemHasheada', () => {
  const amb = { LIMITE_ORIGEM_PEPPER: 'segredo-de-teste' }

  it('não devolve o IP', () => {
    const h = origemHasheada('203.0.113.7', amb)
    expect(h).not.toContain('203.0.113.7')
    expect(h).toMatch(/^[a-f0-9]{64}$/)
  })

  it('a mesma origem dá a mesma chave — é o que faz o contador funcionar', () => {
    expect(origemHasheada('203.0.113.7', amb)).toBe(origemHasheada('203.0.113.7', amb))
  })

  it('origens diferentes dão chaves diferentes', () => {
    expect(origemHasheada('203.0.113.7', amb)).not.toBe(origemHasheada('203.0.113.8', amb))
  })

  it('o segredo muda o hash — é o que o torna irreversível', () => {
    /*
     * Sem segredo, um SHA-256 de IPv4 se quebra por força bruta em minutos: são
     * quatro bilhões de possibilidades. Com segredo, a tabela teria de ser
     * refeita para cada instalação.
     */
    const comUm = origemHasheada('203.0.113.7', { LIMITE_ORIGEM_PEPPER: 'a' })
    const comOutro = origemHasheada('203.0.113.7', { LIMITE_ORIGEM_PEPPER: 'b' })
    expect(comUm).not.toBe(comOutro)
  })

  it('SEM segredo nenhum ainda conta — a defesa não se desliga sozinha', () => {
    /*
     * Degradar a privacidade é ruim; desligar a defesa em silêncio por falta de
     * configuração seria pior. Aqui o hash fica reversível e o limite continua
     * valendo, com aviso no log.
     */
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(origemHasheada('203.0.113.7', {})).toMatch(/^[a-f0-9]{64}$/)
    aviso.mockRestore()
  })

  it('sem IP não há origem', () => {
    expect(origemHasheada(null, amb)).toBeNull()
  })
})

function clienteFalso(resposta: { data?: unknown; erro?: string } | 'explode') {
  const chamadas: Record<string, unknown>[] = []
  const cliente = {
    schema: () => ({
      rpc: (_n: string, args: Record<string, unknown>) => {
        chamadas.push(args)
        if (resposta === 'explode') return Promise.reject(new Error('banco fora'))
        return Promise.resolve({
          data: resposta.data,
          error: resposta.erro ? { message: resposta.erro } : null,
        })
      },
    }),
  }
  return { cliente: cliente as unknown as ClienteDeLimite, chamadas }
}

describe('permitirRequisicao', () => {
  it('passa adiante o que o banco respondeu', async () => {
    const { cliente } = clienteFalso({ data: false })
    expect(await permitirRequisicao(cliente, 'password_reset', 'abc')).toBe(false)
  })

  it('leva o limite e a janela do catálogo', async () => {
    const { cliente, chamadas } = clienteFalso({ data: true })
    await permitirRequisicao(cliente, 'password_reset', 'abc')
    expect(chamadas[0]).toMatchObject({
      p_balde: 'password_reset',
      p_limite: LIMITES.password_reset.limite,
      p_janela_seg: LIMITES.password_reset.janelaSeg,
    })
  })

  it('sem origem, não limita', async () => {
    const { cliente, chamadas } = clienteFalso({ data: false })
    expect(await permitirRequisicao(cliente, 'password_reset', null)).toBe(true)
    expect(chamadas).toHaveLength(0)
  })

  it('com o banco fora, DEIXA PASSAR', async () => {
    /*
     * A decisão que mais pesa neste módulo. Falhar fechado transformaria uma
     * indisponibilidade do banco em "ninguém redefine senha" — uma queda maior
     * que a que o limite evita. O limite defende contra abuso, não contra
     * acesso legítimo.
     */
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { cliente } = clienteFalso('explode')
    expect(await permitirRequisicao(cliente, 'password_reset', 'abc')).toBe(true)
    expect(erro).toHaveBeenCalled()
    erro.mockRestore()
  })

  it('com erro devolvido pelo banco, também deixa passar e registra', async () => {
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { cliente } = clienteFalso({ erro: 'permission denied' })
    expect(await permitirRequisicao(cliente, 'password_reset', 'abc')).toBe(true)
    expect(erro).toHaveBeenCalled()
    erro.mockRestore()
  })
})
