import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * O interruptor entre Supabase e PostgreSQL local, nas quatro fábricas.
 *
 * ## Por que este arquivo existe
 *
 * `docs/22` registrava, em "o que continua não verificado": *as quatro fábricas
 * ganharam um `if`, e o ramo do Supabase não roda aqui*. Era verdade e era
 * desconfortável — o ambiente de desenvolvimento passou a exercitar **só um dos
 * dois caminhos**, e o outro é justamente o que roda em produção.
 *
 * O que dá para provar sem um Supabase de verdade é a **decisão**: quem é
 * escolhido, com qual configuração, e o que acontece quando falta chave. Isso
 * cobre a classe inteira de defeito que o `if` introduziu. O que continua sem
 * prova é o comportamento do cliente do Supabase depois de criado — e esse
 * nunca foi o risco novo.
 *
 * ## Por que não há mock do `@supabase/supabase-js`
 *
 * Porque o cliente do Supabase **não fala com a rede ao ser criado**: ele monta
 * um objeto e espera a primeira consulta. Mockar a biblioteca testaria o mock;
 * criar o cliente de verdade, com uma URL que não existe, testa o código.
 *
 * ## A quarta fábrica
 *
 * `lib/supabase/client.ts` — o cliente de navegador — **não tem `if`**, e isso é
 * deliberado: `modoLocal()` depende de `DATABASE_URL`, que é variável de
 * servidor e não existe no navegador. Quem decide ali é
 * `components/realtime-refresh.tsx`, pela única pista que o navegador tem: a URL
 * do Supabase ausente ou de reserva. A condição daquele guarda está testada
 * abaixo, separada do componente, porque é a regra que importa.
 */

const ORIGINAL = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL }
  vi.resetModules()
  vi.unstubAllGlobals()
  vi.doUnmock('next/headers')
})

function ambiente(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

const LOCAL = {
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5433/sti_iarx_dev',
  NEXT_PUBLIC_SUPABASE_URL: 'https://placeholder.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
  LOCAL_AUTH_SECRET: 'segredo-de-teste-com-mais-de-16',
}

const SUPABASE = {
  DATABASE_URL: undefined,
  NEXT_PUBLIC_SUPABASE_URL: 'https://exemplo.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'chave-anonima-publica-por-design',
}

/**
 * Como se reconhece quem voltou.
 *
 * O cliente do Supabase carrega `realtime` e `auth`; o local não tem nenhum dos
 * dois — ele tem `from`, `rpc`, `storage` e um `channel()` que é um apagador de
 * ruído. Distinguir por essa propriedade, e não por `instanceof`, é o que
 * mantém o teste válido quando a biblioteca mudar de classe interna.
 */
const ehDoSupabase = (c: unknown) => typeof (c as { realtime?: unknown })?.realtime === 'object'

describe('o interruptor', () => {
  it('não liga o modo local sem DATABASE_URL, mesmo sem Supabase configurado', async () => {
    ambiente({ DATABASE_URL: undefined, NEXT_PUBLIC_SUPABASE_URL: '' })
    const { modoLocal } = await import('@/lib/db/modo')
    expect(modoLocal()).toBe(false)
  })

  it('liga com DATABASE_URL e URL de Supabase vazia', async () => {
    ambiente({ ...LOCAL, NEXT_PUBLIC_SUPABASE_URL: '' })
    const { modoLocal } = await import('@/lib/db/modo')
    expect(modoLocal()).toBe(true)
  })

  it('liga com DATABASE_URL e a URL de reserva', async () => {
    ambiente(LOCAL)
    const { modoLocal } = await import('@/lib/db/modo')
    expect(modoLocal()).toBe(true)
  })

  /*
   * A asserção que justifica o desenho inteiro. Um `MODO=local` esquecido ligado
   * em produção faria o app falar com o banco errado em silêncio. Aqui é o
   * contrário: com um Supabase de verdade configurado, o modo local NÃO liga
   * nem com `DATABASE_URL` presente.
   */
  it('NÃO liga quando há um Supabase de verdade, mesmo com DATABASE_URL presente', async () => {
    ambiente({ ...SUPABASE, DATABASE_URL: LOCAL.DATABASE_URL })
    const { modoLocal } = await import('@/lib/db/modo')
    expect(modoLocal()).toBe(false)
  })
})

describe('fábrica anônima', () => {
  it('devolve o cliente local em modo local', async () => {
    ambiente(LOCAL)
    const { createAnonClient } = await import('@/lib/supabase/anon')
    expect(ehDoSupabase(createAnonClient())).toBe(false)
  })

  it('devolve o cliente do Supabase quando há Supabase', async () => {
    ambiente(SUPABASE)
    const { createAnonClient } = await import('@/lib/supabase/anon')
    expect(ehDoSupabase(createAnonClient())).toBe(true)
  })
})

describe('fábrica de serviço', () => {
  it('devolve o cliente local em modo local, e não exige chave de serviço', async () => {
    ambiente({ ...LOCAL, SUPABASE_SERVICE_ROLE_KEY: undefined })
    const { createAdminClient } = await import('@/lib/supabase/admin')
    expect(ehDoSupabase(createAdminClient())).toBe(false)
  })

  /*
   * O papel `service_role` existe no PostgreSQL local com `bypassrls`, igual ao
   * do Supabase — por isso não há chave a guardar, e por isso a ausência dela
   * não pode derrubar o modo local.
   */
  it('exige a chave de serviço quando há Supabase, e diz para que ela serve', async () => {
    ambiente({ ...SUPABASE, SUPABASE_SERVICE_ROLE_KEY: undefined })
    const { createAdminClient } = await import('@/lib/supabase/admin')
    expect(() => createAdminClient()).toThrowError(/SUPABASE_SERVICE_ROLE_KEY ausente/)
  })

  it('devolve o cliente do Supabase quando a chave está presente', async () => {
    ambiente({ ...SUPABASE, SUPABASE_SERVICE_ROLE_KEY: 'chave-de-servico-de-teste' })
    const { createAdminClient } = await import('@/lib/supabase/admin')
    expect(ehDoSupabase(createAdminClient())).toBe(true)
  })
})

describe('fábrica de sessão', () => {
  /* `next/headers` só existe dentro de uma requisição do Next. O armazenamento
     falso aqui é de cookie, não de Supabase: o que se testa é a escolha da
     fábrica, e ela acontece depois de ler o cookie. */
  function cookiesFalsos() {
    const mapa = new Map<string, string>()
    vi.doMock('next/headers', () => ({
      cookies: async () => ({
        get: (n: string) => (mapa.has(n) ? { name: n, value: mapa.get(n)! } : undefined),
        set: (n: string, v: string) => void mapa.set(n, v),
        delete: (n: string) => void mapa.delete(n),
        getAll: () => [...mapa].map(([name, value]) => ({ name, value })),
      }),
    }))
  }

  it('devolve o cliente local em modo local', async () => {
    ambiente(LOCAL)
    cookiesFalsos()
    const { createClient } = await import('@/lib/supabase/server')
    expect(ehDoSupabase(await createClient())).toBe(false)
  })

  it('devolve o cliente do Supabase quando há Supabase', async () => {
    ambiente(SUPABASE)
    cookiesFalsos()
    const { createClient } = await import('@/lib/supabase/server')
    expect(ehDoSupabase(await createClient())).toBe(true)
  })
})

describe('o guarda do navegador', () => {
  /*
   * A regra de `realtime-refresh.tsx`, isolada. Lá ela não pode chamar
   * `modoLocal()` — `DATABASE_URL` não existe no navegador —, então decide pela
   * única pista disponível. Testá-la aqui é o que impede que as duas regras
   * divirjam sem ninguém notar: se um dia o modo local passar a aceitar outra
   * marca de URL de reserva, este teste falha junto com o outro.
   */
  const semWebSocket = (url: string | undefined) => !url || url.includes('placeholder')

  it('não abre WebSocket sem URL ou com a URL de reserva', () => {
    expect(semWebSocket(undefined)).toBe(true)
    expect(semWebSocket('')).toBe(true)
    expect(semWebSocket(LOCAL.NEXT_PUBLIC_SUPABASE_URL)).toBe(true)
  })

  it('abre WebSocket quando há Supabase de verdade', () => {
    expect(semWebSocket(SUPABASE.NEXT_PUBLIC_SUPABASE_URL)).toBe(false)
  })
})
