/*
 * O portal instalável, e o que ele faz quando a rede some.
 *
 * Por que esta suíte existe
 * -------------------------
 * PWA é das coisas que parecem prontas e não estão: o manifesto responde 200, o
 * ícone existe, e mesmo assim o navegador recusa instalar por um campo faltando
 * que ninguém lê. E o service worker, que é a parte que importa numa rede ruim,
 * só mostra o que faz quando a rede CAI — o que não acontece sozinho num teste.
 *
 * Então aqui a rede cai de propósito.
 *
 * O que é verificado:
 *   1. o manifesto tem o que o navegador exige para oferecer instalação;
 *   2. os ícones existem de verdade, nos dois tamanhos e no formato maskable;
 *   3. o service worker registra e assume o controle;
 *   4. com a rede derrubada, a navegação cai na página de sem conexão — e não
 *      no erro do navegador, que faz quem vê concluir que o sistema caiu;
 *   5. e, principalmente, que ele NÃO guarda página autenticada.
 *
 * A quinta é a que justifica as outras: num sistema multi-tenant, página
 * guardada é página que pode reaparecer para a próxima pessoa no mesmo
 * computador.
 *
 * Como rodar: ver `telas.spec.mjs`.
 */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3177'

let falhas = 0
const ok = (c, m) => {
  if (!c) falhas++
  console.log(`${c ? '  ok  ' : '  FALHOU '} ${m}`)
}

const b = await chromium.launch()

// ---------------------------------------------------------------------------
console.log('\n=== 1. O manifesto ===')
// ---------------------------------------------------------------------------
{
  const r = await fetch(`${BASE}/manifest.webmanifest`)
  ok(r.status === 200, 'o manifesto responde')
  ok(
    (r.headers.get('content-type') ?? '').includes('manifest'),
    'com o tipo que o navegador espera',
  )

  const m = await r.json()
  ok(m.name?.length > 0 && m.short_name?.length > 0, 'tem nome e nome curto')
  ok(m.display === 'standalone', 'abre sem barra de endereço')
  ok(m.start_url === '/portal', 'e abre no PORTAL, não na raiz que o solicitante não alcança')
  ok(/^#[0-9a-f]{6}$/i.test(m.theme_color), 'tem cor de tema')

  const tamanhos = (m.icons ?? []).map((i) => i.sizes)
  ok(tamanhos.includes('192x192') && tamanhos.includes('512x512'), 'tem os dois tamanhos exigidos')
  ok(
    (m.icons ?? []).some((i) => i.purpose === 'maskable'),
    'e um maskable — sem ele o monograma sai cortado em metade dos Android',
  )

  for (const icone of m.icons ?? []) {
    const ri = await fetch(BASE + icone.src)
    ok(
      ri.status === 200 && (ri.headers.get('content-type') ?? '').includes('image/png'),
      `o ícone ${icone.src} existe de verdade`,
    )
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. O service worker assume o controle ===')
// ---------------------------------------------------------------------------
{
  const ctx = await b.newContext()
  const p = await ctx.newPage()
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })

  const controlando = await p.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready
    return Boolean(reg.active)
  })
  ok(controlando, 'o service worker registra e fica ativo')

  /* Espera o controle efetivo: `clients.claim()` é assíncrono, e sem esperar o
     teste seguinte mediria a página que ainda não passa por ele. */
  await p.evaluate(async () => {
    if (navigator.serviceWorker.controller) return
    await new Promise((r) => {
      navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })
      setTimeout(r, 3000)
    })
  })
  ok(
    await p.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    'e passa a controlar a página',
  )

  await ctx.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. A página de sem conexão existe e está guardada ===')
// ---------------------------------------------------------------------------
/*
 * A QUEDA DE REDE DE VERDADE É TESTADA EM OUTRO LUGAR, e vale explicar por quê.
 *
 * `context.setOffline(true)` derruba a rede da PÁGINA. O service worker faz as
 * requisições dele num contexto de rede próprio, que nem `setOffline` nem
 * `route` alcançam: a navegação "offline" chega ao servidor como se nada fosse,
 * e a asserção passaria pelo motivo errado — atestando uma queda que nunca
 * aconteceu. Isso é pior que asserção nenhuma.
 *
 * O comportamento sob queda está em `src/lib/sw.test.ts`, que avalia o
 * `public/sw.js` publicado dentro de um escopo falso e pode, aí sim, derrubar a
 * rede de verdade. Aqui fica o que o navegador consegue provar: a página existe,
 * responde sem sessão, e está no cache para quando for precisa.
 */
{
  const r = await fetch(`${BASE}/sem-conexao`)
  ok(r.status === 200, 'a página de sem conexão responde')
  const html = await r.text()
  ok(/Sem conex/i.test(html), 'e diz o que aconteceu')
  ok(
    /O sistema continua no ar/i.test(html),
    'em vez de deixar concluir que o sistema caiu, que é o que o erro do navegador faz',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. O que o service worker NÃO guarda ===')
// ---------------------------------------------------------------------------
{
  const ctx = await b.newContext()
  const p = await ctx.newPage()
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await p.fill('input[name="email"]', 'admin@iaroffice.com.br')
  await p.fill('input[name="password"]', 'desenvolvimento')
  await p.click('button[type="submit"]')
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 })
  await p.goto(`${BASE}/tickets`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(1500)

  const guardados = await p.evaluate(async () => {
    const nomes = await caches.keys()
    const urls = []
    for (const n of nomes) {
      const c = await caches.open(n)
      for (const req of await c.keys()) urls.push(req.url)
    }
    return urls
  })

  const paginas = guardados.filter((u) => {
    const caminho = new URL(u).pathname
    return (
      !caminho.startsWith('/_next/static/') &&
      !caminho.startsWith('/icones/') &&
      caminho !== '/icon.svg' &&
      caminho !== '/sem-conexao'
    )
  })

  ok(
    paginas.length === 0,
    `nenhuma página autenticada guardada (${paginas.length ? paginas.join(', ') : 'nenhuma'})`,
  )
  ok(
    guardados.some((u) => new URL(u).pathname === '/sem-conexao'),
    'e a página de sem conexão, essa sim, está guardada',
  )

  await ctx.close()
}

await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
