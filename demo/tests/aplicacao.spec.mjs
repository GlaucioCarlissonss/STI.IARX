/*
 * Teste de navegador da APLICAÇÃO — não do protótipo.
 *
 * Por que ele existe
 * ------------------
 * `prototipo.spec.mjs` cobre regra de permissão no protótipo. A aplicação de
 * verdade não tinha nenhuma cobertura em navegador, e três coisas das entregas 4
 * e 5 SÓ existem no navegador: a resolução do tema, o foco visível e o
 * comportamento em tela estreita. As três falham em silêncio — ninguém abre um
 * chamado dizendo "o contorno de foco sumiu".
 *
 * Ele já achou um defeito na primeira execução: nenhum ícone de aba, e o
 * navegador pedindo `/favicon.ico` a cada navegação, levando 404 e registrando
 * um erro no console. Ruído permanente esconde o erro de verdade quando ele vem.
 *
 * O que ele NÃO cobre, e por quê
 * ------------------------------
 * Apenas as rotas públicas. As telas autenticadas dependem de um Supabase
 * acessível, que este ambiente não tem (ver docs/09). Fingir uma sessão aqui
 * testaria o dublê, não o sistema.
 *
 * Como rodar
 * ----------
 *   NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder npm run build
 *   node demo/tests/aplicacao.spec.mjs
 *
 * O script sobe e derruba o servidor sozinho.
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const PORTA = 3177
const BASE = `http://127.0.0.1:${PORTA}`

let falhas = 0
const ok = (c, m) => {
  if (!c) falhas++
  console.log(`${c ? '  ok ' : '  FALHOU '} ${m}`)
}

const servidor = spawn('npm', ['run', 'start'], {
  env: {
    ...process.env,
    PORT: String(PORTA),
    NEXT_PUBLIC_SUPABASE_URL: 'https://placeholder.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
  },
  stdio: 'ignore',
})

/** Espera o servidor responder, em vez de dormir um tempo fixo e torcer. */
async function esperarSubir(tentativas = 40) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(`${BASE}/login`)
      if (r.ok) return
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('o servidor não subiu')
}

try {
  await esperarSubir()
  const b = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  })

  // ---------------------------------------------------------------------------
  console.log('\n=== 1. Rotas públicas abrem sem erro de página ===')
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
    const p = await ctx.newPage()
    const erros = []
    p.on('pageerror', (e) => erros.push(`PAGEERROR ${e.message}`))
    p.on('console', (m) => {
      if (m.type() === 'error') erros.push(`CONSOLE ${m.text()}`)
    })
    p.on('response', (r) => {
      if (r.status() >= 400) erros.push(`HTTP ${r.status()} ${r.url()}`)
    })

    for (const rota of ['/login', '/recuperar-senha']) {
      const r = await p.goto(BASE + rota, { waitUntil: 'networkidle' })
      ok(r.status() === 200, `${rota} responde 200`)
    }
    ok(erros.length === 0, `nenhum erro nem recurso faltando: ${erros.join(' | ') || 'nenhum'}`)
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  // SEM SEÇÃO DE 404, e vale dizer por quê.
  //
  // `src/proxy.ts` guarda TODA rota: um visitante sem sessão que digite um
  // endereço inexistente é levado ao login com `?proxima=`, sem nunca descobrir
  // se aquele endereço existe. Está certo assim — mas significa que
  // `src/app/not-found.tsx` só é alcançável com sessão, e sessão exige um
  // Supabase de verdade (docs/09).
  //
  // Uma primeira versão deste arquivo afirmava "rota inexistente responde 404" e
  // oscilava entre passar e falhar: com uma URL de Supabase inventada, a chamada
  // de autenticação do proxy às vezes falha rápido e às vezes estoura o tempo, e
  // os dois caminhos terminam em páginas diferentes. Asserção que oscila é pior
  // que asserção ausente — ela ensina a ignorar o vermelho.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  console.log('\n=== 2. Tema: as quatro combinações ===')
  /*
   * A quarta é a que importa: sistema no escuro e "claro" escolhido. Sem o
   * `:root:not([data-tema='claro'])` na media query, o botão existiria e não
   * faria nada — e num monitor claro esse defeito nunca aparece.
   */
  {
    const casos = [
      ['sistema claro, sem escolha', 'light', null, 'rgb(246, 247, 249)'],
      ['sistema escuro, sem escolha', 'dark', null, 'rgb(12, 16, 22)'],
      ['sistema claro, escolheu escuro', 'light', 'escuro', 'rgb(12, 16, 22)'],
      ['sistema escuro, escolheu claro', 'dark', 'claro', 'rgb(246, 247, 249)'],
    ]
    for (const [nome, esquema, escolha, esperado] of casos) {
      const ctx = await b.newContext({ colorScheme: esquema })
      const p = await ctx.newPage()
      await p.goto(`${BASE}/login`)
      if (escolha) {
        await p.evaluate((v) => localStorage.setItem('sti.tema', v), escolha)
        await p.reload({ waitUntil: 'networkidle' })
      }
      const fundo = await p.evaluate(() => getComputedStyle(document.body).backgroundColor)
      ok(fundo === esperado, `${nome} → ${fundo}`)
      await ctx.close()
    }
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 3. Tipografia: as duas famílias chegaram ===')
  {
    const ctx = await b.newContext()
    const p = await ctx.newPage()
    await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
    await p.evaluate(() => document.fonts.ready)
    const corpo = await p.evaluate(() => getComputedStyle(document.body).fontFamily)
    const titulo = await p.evaluate(() => getComputedStyle(document.querySelector('h1')).fontFamily)
    ok(corpo.includes('IBM Plex Sans'), `corpo em IBM Plex Sans (${corpo.split(',')[0]})`)
    ok(titulo.includes('Space Grotesk'), `título em Space Grotesk (${titulo.split(',')[0]})`)
    ok(!/Arial|Roboto|Inter/.test(corpo + titulo), 'nenhuma fonte proibida na pilha efetiva')
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 4. Foco visível no teclado (WCAG 2.4.7) ===')
  {
    const ctx = await b.newContext()
    const p = await ctx.newPage()
    await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
    await p.keyboard.press('Tab')
    const foco = await p.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      const s = getComputedStyle(el)
      return { tag: el.tagName, largura: s.outlineWidth, estilo: s.outlineStyle }
    })
    ok(foco !== null, `a primeira tabulação chega a um elemento (${foco?.tag})`)
    ok(
      foco && foco.estilo !== 'none' && parseFloat(foco.largura) >= 2,
      `o contorno de foco é visível (${foco?.largura} ${foco?.estilo})`,
    )
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 5. Tela de celular: nada vaza para o lado ===')
  /*
   * Rolagem horizontal da PÁGINA é o defeito clássico de responsividade: o
   * conteúdo continua lá, mas metade fica fora e a pessoa não descobre que
   * precisa arrastar. 360px é o Android pequeno que ainda se usa.
   */
  {
    const ctx = await b.newContext({ viewport: { width: 360, height: 740 } })
    const p = await ctx.newPage()
    for (const rota of ['/login', '/recuperar-senha']) {
      await p.goto(BASE + rota, { waitUntil: 'networkidle' })
      const vaza = await p.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      )
      ok(!vaza, `${rota} cabe em 360px sem rolagem horizontal`)
    }
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 6. O ícone da aba existe e carrega ===')
  {
    const ctx = await b.newContext()
    const p = await ctx.newPage()
    await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
    const href = await p.evaluate(
      () => document.querySelector('link[rel~="icon"]')?.getAttribute('href') ?? null,
    )
    ok(href !== null, `a página declara um ícone (${href})`)
    if (href) {
      const r = await p.request.get(BASE + href)
      ok(r.status() === 200, `o ícone responde 200 em vez de 404`)
    }
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 7. Peso do JavaScript na rota mais leve ===')
  /*
   * Não é uma meta de desempenho: é um alarme de contágio.
   *
   * A tela de login não usa Leaflet, nem Zod, nem o cliente do Supabase — ela
   * tem um formulário e dois links. Se o número abaixo saltar, quase sempre é
   * porque algo pesado vazou para um módulo compartilhado: um `import` sem
   * `type`, um componente de servidor que virou cliente, uma biblioteca
   * carregada no topo em vez de sob demanda. Esse tipo de regressão não quebra
   * nada e não aparece em nenhum outro teste.
   *
   * O teto é folgado de propósito. Apertá-lo até o valor de hoje transformaria
   * cada refatoração legítima numa falha, e o teste passaria a ser ignorado —
   * que é o único jeito garantido de um alarme não servir para nada.
   */
  {
    const TETO_KB = 700
    const ctx = await b.newContext()
    const p = await ctx.newPage()
    const pedacos = []
    p.on('response', (r) => {
      if (r.request().resourceType() !== 'script') return
      pedacos.push(
        r
          .body()
          .then((b) => b.length)
          .catch(() => 0),
      )
    })
    await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
    const kb = (await Promise.all(pedacos)).reduce((a, b) => a + b, 0) / 1024
    ok(kb < TETO_KB, `/login baixa ${kb.toFixed(0)} KB de JavaScript (teto ${TETO_KB} KB)`)
    await ctx.close()
  }

  await b.close()
} finally {
  servidor.kill('SIGTERM')
}

console.log(
  falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`,
)
process.exit(falhas === 0 ? 0 : 1)
