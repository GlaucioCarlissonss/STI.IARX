import { describe, expect, it } from 'vitest'
import {
  drenarSaidaDosCanais,
  MAXIMO_DE_TENTATIVAS,
  proximaTentativa,
  type ClienteDaSaida,
  type LinhaDeSaida,
} from './saida'

/**
 * A drenagem é o ponto onde um erro custa caro de dois jeitos opostos: marcar
 * como enviada uma resposta que não saiu (o atendente acha que respondeu e o
 * cliente continua esperando), ou reenviar uma que já saiu — e no WhatsApp cada
 * reenvio é uma mensagem que a pessoa recebe E uma conversa que a Meta cobra.
 */

function clienteFalso(linhas: LinhaDeSaida[]) {
  const updates: { id: string; valores: Record<string, unknown> }[] = []
  const cliente = {
    from() {
      return {
        select: () => ({
          eq: () => ({
            lte: () => ({
              order: () => ({ limit: async () => ({ data: linhas, error: null }) }),
            }),
          }),
        }),
        update: (valores: Record<string, unknown>) => ({
          eq: async (_c: string, id: string) => {
            updates.push({ id, valores })
            return { error: null }
          },
        }),
      }
    },
  } as unknown as ClienteDaSaida
  return { cliente, updates }
}

const linha = (p: Partial<LinhaDeSaida> = {}): LinhaDeSaida => ({
  id: 'm1',
  channel_id: 'c1',
  conversation_id: 'v1',
  body: 'Bom dia! Já estou a caminho.',
  attempts: 0,
  conversa: { contato: { external_id: 'telegram:1' } },
  canal: { kind: 'n8n', status: 'ativo', config: {}, secret_ref: null },
  ...p,
})

describe('proximaTentativa', () => {
  it('cresce ao quadrado e tem teto de uma hora', () => {
    /*
     * Além do motivo de sempre (não martelar um provedor fora do ar), aqui há um
     * específico: a Meta aplica limite de requisições por número, e um laço
     * apertado contra erro persistente consome a cota que as mensagens boas
     * precisariam.
     */
    const minutos = (n: number) => Math.round((proximaTentativa(n).getTime() - Date.now()) / 60_000)
    expect(minutos(1)).toBe(1)
    expect(minutos(3)).toBe(9)
    expect(minutos(100)).toBe(60)
  })
})

describe('drenarSaidaDosCanais', () => {
  it('fila vazia é caso normal, não erro', async () => {
    const { cliente } = clienteFalso([])
    expect(await drenarSaidaDosCanais(cliente)).toEqual({ enviadas: 0, falhas: 0, puladas: 0 })
  })

  it('canal PAUSADO é pulado, e não contado como falha', async () => {
    /*
     * A distinção que importa. Contar como falha gastaria as cinco tentativas
     * durante a pausa, e as respostas seriam dadas como perdidas sem ninguém ter
     * errado — justamente quando alguém pausou o canal de propósito.
     */
    const { cliente, updates } = clienteFalso([
      linha({ canal: { kind: 'n8n', status: 'pausado', config: {}, secret_ref: null } }),
    ])
    const r = await drenarSaidaDosCanais(cliente)
    expect(r).toEqual({ enviadas: 0, falhas: 0, puladas: 1 })
    expect(updates).toEqual([])
  })

  it('tipo sem adaptador falha de uma vez, com o motivo escrito', async () => {
    // Sem adaptador não há o que tentar de novo: deixar na fila a manteria lá
    // para sempre.
    const { cliente, updates } = clienteFalso([
      linha({ canal: { kind: 'telegram', status: 'ativo', config: {}, secret_ref: null } }),
    ])
    const r = await drenarSaidaDosCanais(cliente)
    expect(r.falhas).toBe(1)
    expect(updates[0]!.valores.status).toBe('falhou')
    expect(String(updates[0]!.valores.last_error)).toContain('telegram')
  })

  it('conversa sem contato falha explicando que não há para quem enviar', async () => {
    const { cliente, updates } = clienteFalso([linha({ conversa: null })])
    await drenarSaidaDosCanais(cliente)
    expect(updates[0]!.valores.status).toBe('falhou')
    expect(String(updates[0]!.valores.last_error)).toContain('não há para quem enviar')
  })

  it('erro do provedor volta para a fila com nova tentativa marcada', async () => {
    // O n8n sem URL de saída recusa — é um erro de configuração, e ele deve
    // continuar tentando porque alguém pode configurar a qualquer momento.
    const { cliente, updates } = clienteFalso([linha({ attempts: 1 })])
    const r = await drenarSaidaDosCanais(cliente)

    expect(r.falhas).toBe(1)
    expect(updates[0]!.valores.status).toBe('na_fila')
    expect(updates[0]!.valores.attempts).toBe(2)
    expect(updates[0]!.valores.scheduled_for).toBeTruthy()
    expect(updates[0]!.valores.last_error).toBeTruthy()
  })

  it('na última tentativa desiste, e o motivo fica registrado', async () => {
    const { cliente, updates } = clienteFalso([linha({ attempts: MAXIMO_DE_TENTATIVAS - 1 })])
    await drenarSaidaDosCanais(cliente)

    expect(updates[0]!.valores.status).toBe('falhou')
    // Sem `scheduled_for`: mensagem desistida não volta para a fila.
    expect(updates[0]!.valores.scheduled_for).toBeUndefined()
    expect(updates[0]!.valores.last_error).toBeTruthy()
  })

  it('o erro cru do provedor fica no registro, não vira mensagem de tela', async () => {
    const { cliente, updates } = clienteFalso([linha()])
    await drenarSaidaDosCanais(cliente)
    expect(String(updates[0]!.valores.last_error).length).toBeLessThanOrEqual(500)
  })
})
