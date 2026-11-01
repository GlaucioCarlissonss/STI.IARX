import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it, beforeEach } from 'vitest'

/**
 * O service worker, testado pelo arquivo que é publicado.
 *
 * ## Por que não é teste de navegador
 *
 * Porque não dá. O Playwright derruba a rede da PÁGINA, e o service worker faz
 * as requisições dele num contexto de rede próprio: `setOffline` e `route` não
 * o alcançam, e a navegação "offline" chega ao servidor como se nada fosse. Um
 * teste de navegador aqui passaria pelo motivo errado, que é pior que não
 * existir — ele atestaria uma queda que nunca aconteceu.
 *
 * ## Por que o arquivo é lido, e não copiado
 *
 * `public/sw.js` é avaliado aqui dentro de um escopo falso, com `self`, `caches`
 * e `fetch` de mentira. Reescrever a lógica no teste testaria a reescrita; ler o
 * arquivo publicado garante que o teste quebra quando o que vai para o navegador
 * muda.
 *
 * ## O que importa provar
 *
 * As três regras que, se quebrarem, estragam mais do que consertam:
 *
 *   1. **página autenticada não é guardada.** Multi-tenant: página guardada é
 *      página que pode reaparecer para a próxima pessoa no mesmo computador;
 *   2. **rede primeiro.** Um cache-first num sistema de chamados mostraria o
 *      chamado de ontem com cara de agora — resposta errada com aparência de
 *      certa é o defeito que ninguém reporta porque ninguém percebe;
 *   3. **só GET.** Um POST guardado e repetido abriria o mesmo chamado duas
 *      vezes.
 */

type Manipulador = (evento: Record<string, unknown>) => void

interface Ambiente {
  disparar: (tipo: string, evento: Record<string, unknown>) => Promise<unknown>
  guardado: Map<string, string>
  pedidosDeRede: string[]
  derrubarRede: () => void
}

const CODIGO = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8')

function montar(): Ambiente {
  const manipuladores = new Map<string, Manipulador>()
  const guardado = new Map<string, string>()
  const pedidosDeRede: string[] = []
  let redeNoAr = true

  const cacheFalso = {
    addAll: async (urls: string[]) => urls.forEach((u) => guardado.set(u, `conteúdo de ${u}`)),
    put: async (req: { url: string }, _resp: unknown) =>
      void guardado.set(new URL(req.url).pathname, 'guardado'),
    keys: async () => [...guardado.keys()].map((p) => ({ url: `https://exemplo${p}` })),
  }

  const contexto: Record<string, unknown> = {
    self: {
      addEventListener: (tipo: string, fn: Manipulador) => manipuladores.set(tipo, fn),
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
      location: { origin: 'https://exemplo' },
    },
    caches: {
      open: async () => cacheFalso,
      keys: async () => ['sti-v1-estatico'],
      delete: async () => true,
      match: async (req: { url?: string } | string) => {
        const caminho = typeof req === 'string' ? req : new URL(req.url!).pathname
        return guardado.has(caminho) ? { corpo: guardado.get(caminho), ok: true } : undefined
      },
    },
    fetch: async (req: { url: string }) => {
      pedidosDeRede.push(new URL(req.url).pathname)
      if (!redeNoAr) throw new Error('rede fora')
      return { ok: true, clone: () => ({}), corpo: 'da rede' }
    },
    Response: class {
      status: number
      constructor(_corpo: string, init?: { status?: number }) {
        this.status = init?.status ?? 200
      }
    },
    URL,
    Promise,
    console,
  }

  runInContext(CODIGO, createContext(contexto))

  return {
    guardado,
    pedidosDeRede,
    derrubarRede: () => {
      redeNoAr = false
    },
    disparar: async (tipo, evento) => {
      let resultado: unknown
      const fn = manipuladores.get(tipo)
      if (!fn) throw new Error(`o service worker não escuta "${tipo}"`)
      fn({
        ...evento,
        waitUntil: (p: Promise<unknown>) => {
          resultado = p
        },
        respondWith: (p: unknown) => {
          resultado = p
        },
      })
      return await resultado
    },
  }
}

const pedido = (caminho: string, extra: Record<string, unknown> = {}) => ({
  url: `https://exemplo${caminho}`,
  method: 'GET',
  mode: 'same-origin',
  ...extra,
})

describe('o service worker', () => {
  let amb: Ambiente

  beforeEach(async () => {
    amb = montar()
    await amb.disparar('install', {})
  })

  it('guarda a página de sem conexão na instalação', () => {
    expect(amb.guardado.has('/sem-conexao')).toBe(true)
  })

  it('NÃO responde a POST — um chamado repetido é um chamado a mais', async () => {
    const r = await amb.disparar('fetch', { request: pedido('/tickets/novo', { method: 'POST' }) })
    expect(r).toBeUndefined()
  })

  it('NÃO se mete com /api — é chamada de máquina ou sessão de alguém', async () => {
    const r = await amb.disparar('fetch', {
      request: pedido('/api/monitoramento/x', { mode: 'cors' }),
    })
    expect(r).toBeUndefined()
  })

  it('NÃO se mete com outra origem', async () => {
    const r = await amb.disparar('fetch', {
      request: { url: 'https://outra-casa/coisa', method: 'GET', mode: 'cors' },
    })
    expect(r).toBeUndefined()
  })

  it('guarda arquivo estático com hash no nome — o conteúdo nunca muda', async () => {
    await amb.disparar('fetch', { request: pedido('/_next/static/chunks/abc123.js') })
    expect(amb.pedidosDeRede).toContain('/_next/static/chunks/abc123.js')
  })

  it('na navegação, vai à REDE primeiro', async () => {
    await amb.disparar('fetch', { request: pedido('/tickets', { mode: 'navigate' }) })
    expect(amb.pedidosDeRede).toContain('/tickets')
  })

  /* A asserção que justifica o arquivo inteiro. */
  it('e NÃO guarda a página autenticada que veio da rede', async () => {
    await amb.disparar('fetch', { request: pedido('/tickets', { mode: 'navigate' }) })
    expect([...amb.guardado.keys()]).not.toContain('/tickets')
  })

  it('com a rede fora, entrega a página de sem conexão', async () => {
    amb.derrubarRede()
    const resposta = (await amb.disparar('fetch', {
      request: pedido('/portal', { mode: 'navigate' }),
    })) as { corpo?: string }
    expect(resposta?.corpo).toBe('conteúdo de /sem-conexao')
  })
})
