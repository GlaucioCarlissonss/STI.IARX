import { describe, expect, it, vi } from 'vitest'
import type { Provedor } from './provedor'
import {
  completarEnderecos,
  drenarCaixaDeSaida,
  MAXIMO_DE_TENTATIVAS,
  proximaTentativa,
  type ClienteDaCaixa,
  type LinhaDaCaixa,
} from './caixa-de-saida'

/**
 * A drenagem é o ponto onde um erro custa caro de dois jeitos opostos: marcar
 * como enviada uma mensagem que não saiu (a pessoa nunca é avisada e ninguém
 * descobre), ou reenviar uma que já saiu (quarenta e-mails).
 *
 * O provedor de mentira abaixo é o motivo de a interface `Provedor` existir:
 * sem ela, testar isto exigiria rede.
 */

function provedorFalso(resposta: 'ok' | 'erro' = 'ok') {
  const enviadas: { to: string; subject: string; text: string }[] = []
  const p: Provedor = {
    nome: 'falso',
    async enviar(m) {
      enviadas.push({ to: m.to, subject: m.subject, text: m.text })
      return resposta === 'ok' ? { ok: true, id: 'x' } : { ok: false, erro: 'HTTP 500 boom' }
    },
  }
  return { provedor: p, enviadas }
}

/** Um cliente Supabase de mentira que guarda os `update` que recebeu. */
function clienteFalso(linhas: LinhaDaCaixa[]) {
  const updates: { id: string; valores: Record<string, unknown> }[] = []
  const cliente = {
    from() {
      return {
        select: () => ({
          eq: () => ({
            lte: () => ({
              order: () => ({
                limit: async () => ({ data: linhas, error: null }),
              }),
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
  } as unknown as ClienteDaCaixa
  return { cliente, updates }
}

const linha = (p: Partial<LinhaDaCaixa> = {}): LinhaDaCaixa => ({
  id: 'm1',
  to_email: 'pessoa@empresa.com.br',
  to_name: 'Pessoa',
  subject: '[SLA] Prazo estourado',
  body_text: 'Abra o chamado em /tickets/abc',
  kind: 'sla_breach',
  attempts: 0,
  ...p,
})

describe('completarEnderecos', () => {
  it('completa o caminho que o SQL escreveu', () => {
    expect(completarEnderecos('Responda em /avaliar/abc123', 'https://sti.exemplo.com')).toBe(
      'Responda em https://sti.exemplo.com/avaliar/abc123',
    )
  })

  it('tolera barra sobrando no fim da origem', () => {
    // `NEXT_PUBLIC_SITE_URL` acaba com barra metade das vezes. Sem o corte,
    // o link sairia com `//avaliar` e alguns clientes de e-mail o quebram.
    expect(completarEnderecos('/avaliar/x', 'https://sti.exemplo.com/')).toBe(
      'https://sti.exemplo.com/avaliar/x',
    )
  })

  it('não mexe em endereço que já está completo', () => {
    const texto = 'veja https://outro.com/avaliar/x'
    expect(completarEnderecos(texto, 'https://sti.exemplo.com')).toBe(texto)
  })
})

describe('proximaTentativa', () => {
  it('cresce ao quadrado e tem teto de uma hora', () => {
    /*
     * Repetir de minuto em minuto contra provedor fora do ar não entrega nada e
     * gasta cota. O teto evita que a quinta tentativa caia daqui a um dia.
     */
    const minutos = (n: number) => Math.round((proximaTentativa(n).getTime() - Date.now()) / 60_000)
    expect(minutos(1)).toBe(1)
    expect(minutos(2)).toBe(4)
    expect(minutos(3)).toBe(9)
    expect(minutos(100)).toBe(60)
  })
})

describe('drenarCaixaDeSaida', () => {
  it('sem provedor configurado, não envia e NÃO consome a fila', async () => {
    /*
     * Ausência de chave não é erro: o sistema roda sem canal de e-mail. O que não
     * pode é fingir que enviou — a fila fica intacta e sai quando a chave entrar.
     */
    const { cliente, updates } = clienteFalso([linha()])
    const r = await drenarCaixaDeSaida(cliente, null, 'https://x.com')
    expect(r).toEqual({ enviadas: 0, falhas: 0, semProvedor: true })
    expect(updates).toEqual([])
  })

  it('envia e marca como enviada, com a data', async () => {
    const { provedor, enviadas } = provedorFalso()
    const { cliente, updates } = clienteFalso([linha()])

    const r = await drenarCaixaDeSaida(cliente, provedor, 'https://sti.exemplo.com')

    expect(r.enviadas).toBe(1)
    expect(enviadas[0]!.text).toContain('https://sti.exemplo.com/tickets/abc')
    expect(updates[0]!.valores.status).toBe('sent')
    expect(updates[0]!.valores.sent_at).toBeTruthy()
    expect(updates[0]!.valores.attempts).toBe(1)
  })

  it('apaga o corpo do convite de avaliação depois de enviar', async () => {
    /*
     * O corpo carrega o token do link em claro. Depois de enviado ele não serve a
     * mais ninguém — e segredo que já cumpriu o papel e continua guardado é só
     * risco acumulado.
     */
    const { provedor } = provedorFalso()
    const { cliente, updates } = clienteFalso([
      linha({ kind: 'satisfaction_invite', body_text: 'Responda em /avaliar/segredo123' }),
    ])

    await drenarCaixaDeSaida(cliente, provedor, 'https://sti.exemplo.com')

    expect(updates[0]!.valores.body_text).not.toContain('segredo123')
    expect(String(updates[0]!.valores.body_text)).toContain('removido após o envio')
  })

  it('mas preserva o corpo das demais — é o que o suporte lê', async () => {
    const { provedor } = provedorFalso()
    const { cliente, updates } = clienteFalso([linha({ kind: 'sla_breach' })])
    await drenarCaixaDeSaida(cliente, provedor, 'https://x.com')
    expect(updates[0]!.valores.body_text).toContain('/tickets/abc')
  })

  it('falha volta para a fila com nova tentativa marcada', async () => {
    const { provedor } = provedorFalso('erro')
    const { cliente, updates } = clienteFalso([linha({ attempts: 1 })])

    const r = await drenarCaixaDeSaida(cliente, provedor, 'https://x.com')

    expect(r.falhas).toBe(1)
    expect(updates[0]!.valores.status).toBe('pending')
    expect(updates[0]!.valores.attempts).toBe(2)
    expect(updates[0]!.valores.scheduled_for).toBeTruthy()
    expect(updates[0]!.valores.last_error).toContain('HTTP 500')
  })

  it('na última tentativa desiste, e o motivo fica registrado', async () => {
    const { provedor } = provedorFalso('erro')
    const { cliente, updates } = clienteFalso([linha({ attempts: MAXIMO_DE_TENTATIVAS - 1 })])

    await drenarCaixaDeSaida(cliente, provedor, 'https://x.com')

    expect(updates[0]!.valores.status).toBe('failed')
    // Sem `scheduled_for`: mensagem desistida não volta para a fila.
    expect(updates[0]!.valores.scheduled_for).toBeUndefined()
    expect(updates[0]!.valores.last_error).toBeTruthy()
  })

  it('o erro cru do provedor NÃO vira mensagem de tela — vai para o registro', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { provedor } = provedorFalso('erro')
    const { cliente, updates } = clienteFalso([linha()])
    await drenarCaixaDeSaida(cliente, provedor, 'https://x.com')
    // `last_error` só é legível por administrador (policy `email_outbox_select`).
    expect(String(updates[0]!.valores.last_error)).toMatch(/HTTP 500/)
    log.mockRestore()
  })

  it('fila vazia é um caso normal, não um erro', async () => {
    const { provedor } = provedorFalso()
    const { cliente } = clienteFalso([])
    expect(await drenarCaixaDeSaida(cliente, provedor, 'https://x.com')).toEqual({
      enviadas: 0,
      falhas: 0,
      semProvedor: false,
    })
  })
})
