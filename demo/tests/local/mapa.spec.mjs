/*
 * O mapa quando o ladrilho não vem.
 *
 * Por que esta suíte existe
 * -------------------------
 * O Leaflet não falha quando não alcança o servidor de ladrilhos: ele desenha o
 * fundo cinza e segue. Marcador aparece, escala existe, e a tela fica
 * indistinguível de um mapa carregando para sempre — o chamado abre contra a
 * tela errada.
 *
 * Duas asserções, e a segunda é a que dá valor à primeira:
 *   1. sem alcançar o servidor, a tela DIZ isso, e os pinos continuam;
 *   2. com o servidor respondendo, o aviso NÃO aparece.
 *
 * Sem a segunda, um aviso preso em "sempre visível" passaria pela primeira.
 *
 * Como rodar: ver `telas.spec.mjs`.
 */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3177'
const LADRILHOS = /(\.tile\.openstreetmap\.org|server\.arcgisonline\.com)/

/* PNG 1×1 transparente: é um ladrilho válido para o Leaflet, que só precisa que
   a imagem CARREGUE — o evento `tileload` não olha o conteúdo. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

let falhas = 0
const ok = (c, m) => {
  if (!c) falhas++
  console.log(`${c ? '  ok  ' : '  FALHOU '} ${m}`)
}

const b = await chromium.launch()

async function abrirMapa(servirLadrilhos) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
  const p = await ctx.newPage()

  await p.route(LADRILHOS, (rota) =>
    servirLadrilhos
      ? rota.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
      : rota.abort('connectionfailed'),
  )

  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await p.fill('input[name="email"]', 'admin@iaroffice.com.br')
  await p.fill('input[name="password"]', 'desenvolvimento')
  await p.click('button[type="submit"]')
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 })
  await p.goto(`${BASE}/mapas`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.leaflet-marker-icon', { timeout: 30000 })
  return { ctx, p }
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. Sem alcançar o servidor, a tela diz ===')
// ---------------------------------------------------------------------------
{
  const { ctx, p } = await abrirMapa(false)
  /* `.first()`: a tela tem QUATRO mapas — o principal e um por filial, para
     conferir se o pino caiu no endereço certo. Cada um avisa por conta, o que
     é o certo: o aviso pertence ao mapa, não à página. */
  const aviso = p.locator('[data-testid="mapa-sem-ladrilho"]').first()

  ok(
    await aviso.waitFor({ state: 'visible', timeout: 20000 }).then(() => true, () => false),
    'o aviso de ladrilho ausente aparece',
  )
  ok(
    (await aviso.innerText()).includes('não carregaram'),
    'e diz o que aconteceu, em vez de só sumir com o mapa',
  )

  /* A parte que importa: a tela continua servindo. Pino, balão e lista não
     dependem de ladrilho nenhum, e é por isso que o aviso é um aviso — não uma
     tela de erro no lugar do mapa. */
  ok((await p.locator('.leaflet-marker-icon').count()) > 0, 'os pinos continuam no mapa')
  await p.locator('.leaflet-marker-icon').first().click()
  ok(
    await p.locator('.leaflet-popup').first().isVisible().catch(() => false),
    'e o balão de uma filial ainda abre',
  )

  await ctx.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. Com o servidor respondendo, não há aviso ===')
// ---------------------------------------------------------------------------
{
  const { ctx, p } = await abrirMapa(true)
  await p.waitForTimeout(3000)

  ok(
    (await p.locator('[data-testid="mapa-sem-ladrilho"]').count()) === 0,
    'nenhum aviso quando os ladrilhos carregam — o limiar não dispara sozinho',
  )
  ok((await p.locator('.leaflet-tile-loaded').count()) > 0, 'e os ladrilhos de fato entraram')

  await ctx.close()
}

await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
