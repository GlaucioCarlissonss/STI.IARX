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

/*
 * Recusa a porta ocupada ANTES de subir o servidor.
 *
 * Sem esta checagem, um `next start` esquecido de uma execução anterior continua
 * atendendo em 3177 — servindo o build ANTIGO — e esta suíte o testa achando que
 * é o novo. Aconteceu duas vezes, e nas duas o sintoma foi um conjunto de
 * asserções falhando contra código que estava correto no disco: o tipo de pista
 * falsa que custa meia hora.
 */
async function exigirPortaLivre() {
  try {
    await fetch(BASE, { signal: AbortSignal.timeout(1500) })
  } catch {
    return // ninguém atendeu: é o que queremos
  }
  console.error(
    `\nA porta ${PORTA} já está ocupada — provavelmente um 'next start' de uma ` +
      `execução anterior, servindo um build ANTIGO.\n` +
      `Encerre-o antes de rodar esta suíte:\n` +
      `  fuser -k ${PORTA}/tcp\n`,
  )
  process.exit(1)
}

await exigirPortaLivre()

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

  // ---------------------------------------------------------------------------
  console.log('\n=== 8. A pesquisa de satisfação abre sem login ===')
  /*
   * `/avaliar/<token>` é pública de propósito: quem responde é o solicitante, que
   * muitas vezes não tem conta — é o funcionário da empresa-cliente que ligou
   * para o suporte. Se o proxy a tratasse como rota protegida, ela redirecionaria
   * para o login e a taxa de resposta seria zero.
   *
   * Com token inválido ela mostra a mesma frase que mostraria para um token
   * adulterado. Distinguir os dois diria a quem estivesse adivinhando que chegou
   * perto.
   */
  {
    const ctx = await b.newContext()
    const p = await ctx.newPage()
    const r = await p.goto(`${BASE}/avaliar/token-que-nao-existe`, { waitUntil: 'networkidle' })

    ok(r.status() === 200, 'responde 200 em vez de redirecionar para o login')
    ok(!p.url().includes('/login'), `não passou pelo login (${p.url()})`)

    /*
     * `innerText`, e não `textContent`: o segundo inclui o conteúdo das tags
     * `<script>`, e o payload do React Server Components traz `null` e
     * `undefined` como parte da própria serialização. A primeira versão desta
     * asserção falhou medindo as entranhas do framework em vez do texto da tela.
     */
    const visivel = await p.locator('body').innerText()
    ok(visivel.includes('Este link não é válido'), 'mostra a recusa em português')
    ok(
      !/does not exist|not found|null|undefined|Error/i.test(visivel),
      'e não vaza detalhe técnico na recusa',
    )
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 9. As rotas do agente: abertas à máquina, fechadas sem token ===')
  // ---------------------------------------------------------------------------
  /*
   * Quem chama estas rotas é um serviço rodando em computador de cliente: sem
   * navegador, sem cookie, e **sem seguir redirecionamento**. Se o guarda de
   * sessão as pegasse, a resposta seria um 307 para `/login` que o agente
   * registraria como "o servidor respondeu algo estranho" e repetiria para
   * sempre — a máquina ficaria muda e o registro não diria por quê.
   *
   * O que autoriza ali é o token DA MÁQUINA, conferido no banco. Estas asserções
   * provam as duas metades: o guarda deixa passar, e a rota recusa sozinha.
   */
  {
    const ctx = await b.newContext()
    const req = ctx.request

    for (const rota of ['/api/agent/inventory', '/api/agent/heartbeat']) {
      const r = await req.post(BASE + rota, { data: {} })
      ok(r.status() === 401, `${rota} sem token responde 401, e não 307 para o login`)
      const corpo = await r.text()
      ok(
        !corpo.includes('<!DOCTYPE') && !corpo.includes('<html'),
        `${rota} responde JSON, e não a página de login`,
      )
    }

    // Inscrição malformada é recusada antes de o banco ser tocado: o schema é a
    // primeira porta, e um `device_uuid` que não é UUID jamais vira linha.
    const malformada = await req.post(`${BASE}/api/agent/enroll`, {
      data: { enrollment_token: 'inv_0123456789abcdef', device: { device_uuid: 'nao-e-uuid' } },
    })
    ok(malformada.status() === 400, 'inscrição com identidade malformada responde 400')

    const vazia = await req.post(`${BASE}/api/agent/enroll`, { data: {} })
    ok(vazia.status() === 400, 'e inscrição sem nada também')

    /*
     * A consulta de versão com as variáveis de publicação ausentes responde 204
     * (nada a fazer), e não um erro. É o estado NORMAL de quem não ligou a
     * autoatualização — e é o estado seguro: o inseguro seria um endpoint que,
     * por falta de configuração, respondesse "baixe este arquivo" apontando para
     * lugar nenhum.
     */
    for (const rota of ['/api/agent/metrics', '/api/agent/remote-id']) {
      const r = await req.post(BASE + rota, { data: {} })
      ok(r.status() === 401, `${rota} sem token responde 401`)
    }

    const versao = await req.get(`${BASE}/api/agent/version`)
    ok(
      versao.status() === 204,
      `sem publicação, a consulta de versão responde 204 (veio ${versao.status()})`,
    )

    // GET na ingestão não existe: ela altera dados. Um GET seria pré-buscado por
    // navegador, por antivírus de rede ou por quem passasse o link num aplicativo
    // de mensagem.
    const get = await req.get(`${BASE}/api/agent/inventory`)
    ok(get.status() === 405, `GET na ingestão responde 405 (veio ${get.status()})`)

    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 10. A rota de entrada dos canais ===')
  // ---------------------------------------------------------------------------
  /*
   * Uma rota só, pública, para todos os canais — é por ela que a Meta, o Bitrix24
   * e o N8N entregam. Três comportamentos dela são decisões, e não detalhes:
   *
   *  - token desconhecido responde 404 e NADA mais (sem dizer se o canal existe,
   *    está pausado ou tem outro tipo);
   *  - o aperto de mão do WhatsApp só vale para canal de WhatsApp, senão a rota
   *    viraria um refletor de qualquer texto que alguém pusesse em `hub.challenge`;
   *  - GET não ingere nada, porque GET é pré-buscado por navegador, por antivírus
   *    de rede e por aplicativo de mensagem.
   */
  {
    const ctx = await b.newContext()
    const req = ctx.request
    const TOKEN_FALSO = 'f'.repeat(64)

    const post = await req.post(`${BASE}/api/canais/${TOKEN_FALSO}`, { data: {} })
    ok(post.status() === 404, `canal inexistente responde 404 (veio ${post.status()})`)

    const corpo = await post.text()
    ok(
      !/pausado|whatsapp|bitrix|n8n|secret|token/i.test(corpo),
      'e o corpo do 404 não conta nada sobre canal nenhum',
    )

    // O aperto de mão da Meta num token que não existe: 404, não o challenge.
    const handshake = await req.get(
      `${BASE}/api/canais/${TOKEN_FALSO}?hub.mode=subscribe&hub.verify_token=${TOKEN_FALSO}&hub.challenge=1234`,
    )
    ok(handshake.status() === 404, `aperto de mão em canal inexistente responde 404 (veio ${handshake.status()})`)
    ok(
      !(await handshake.text()).includes('1234'),
      'e NÃO devolve o challenge: a rota não é um refletor',
    )

    // Token de tamanho errado nem chega ao banco.
    const curto = await req.post(`${BASE}/api/canais/abc`, { data: {} })
    ok(curto.status() === 404, `token de tamanho errado responde 404 (veio ${curto.status()})`)

    const get = await req.get(`${BASE}/api/canais/${TOKEN_FALSO}`)
    ok(get.status() === 404, `GET sem aperto de mão responde 404 (veio ${get.status()})`)

    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 11. A rota de exportação ===')
  // ---------------------------------------------------------------------------
  /*
   * A exportação é gerada no SERVIDOR de propósito (LG-11), para o arquivo
   * respeitar o escopo de RLS de quem pediu em vez de exportar as 50 linhas que o
   * navegador carregou. Isso torna a rota um leitor de dados, e duas coisas
   * precisam valer sempre:
   *
   *  - sem sessão, ela não entrega nada;
   *  - `recurso` é chave de um catálogo fechado, nunca nome de tabela vindo da
   *    URL — senão `/api/exportar/profiles` viraria um leitor genérico do banco.
   */
  {
    const ctx = await b.newContext()
    const req = ctx.request

    for (const recurso of ['trilha', 'telefonia', 'custodia']) {
      const r = await req.get(`${BASE}/api/exportar/${recurso}`, { maxRedirects: 0 })
      ok(
        r.status() === 307 || r.status() === 302 || r.status() === 401 || r.status() === 403,
        `/api/exportar/${recurso} sem sessão não entrega o arquivo (veio ${r.status()})`,
      )
      const corpo = await r.text()
      ok(!corpo.includes(';'), `e não devolve CSV nenhum para ${recurso}`)
    }

    // Nome de tabela na URL não vira exportação.
    for (const invencao of ['profiles', 'tenants', 'ai_settings']) {
      const r = await req.get(`${BASE}/api/exportar/${invencao}`, { maxRedirects: 0 })
      ok(
        r.status() !== 200,
        `/api/exportar/${invencao} não é um recurso (veio ${r.status()})`,
      )
    }

    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 12. As telas do módulo continuam atrás do login ===')
  // ---------------------------------------------------------------------------
  // O contrário da seção 9: as ROTAS do agente são públicas, as TELAS não são.
  // Liberar o prefixo `/api/agent` no guarda de sessão não pode ter aberto o
  // módulo junto.
  {
    const ctx = await b.newContext()
    const p = await ctx.newPage()
    for (const rota of [
      '/inventario/agentes',
      '/inventario/software',
      '/base',
      '/catalogo',
      '/portal',
      '/conversas',
      '/conversas/canais',
      '/ia',
      '/auditoria',
      '/auditoria/trabalhos',
      '/sla/horarios',
      '/projetos',
      '/financeiro/orcamento',
    ]) {
      await p.goto(BASE + rota, { waitUntil: 'networkidle' })
      ok(p.url().includes('/login'), `${rota}: visitante é mandado para o login`)
    }
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
