/*
 * CAPTURAS DO MANUAL DO USUÁRIO — a aplicação de verdade, por papel.
 *
 * Por que não reaproveita a varredura de telas
 * --------------------------------------------
 * `telas.spec.mjs` abre cada rota e confere que ela responde. É a pergunta
 * certa para uma suíte e a errada para um manual: o manual não documenta
 * ROTAS, documenta o que a pessoa faz — e metade do que ela faz acontece
 * depois de um clique, dentro de uma gaveta que rota nenhuma alcança.
 *
 * Por isso aqui cada captura declara o PAPEL de quem vê e, quando precisa, o
 * passo que leva ao momento certo. É também o motivo de as capturas serem da
 * janela visível e não da página inteira: num manual, a imagem precisa ser do
 * tamanho da tela de quem lê, não de um rolo de 3000px.
 *
 * Uso:  node scripts/capturar-manual.mjs <pasta-de-saida>
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:3177'
const SENHA = 'desenvolvimento'
const SAIDA = process.argv[2]
mkdirSync(SAIDA, { recursive: true })

const PESSOAS = {
  admin: 'admin@iaroffice.com.br',
  gestor: 'gestor@iaroffice.com.br',
  atendente: 'ana.atendente@iaroffice.com.br',
  solicitante: 'carla.solicitante@meridiano.com.br',
}

/*
 * A LISTA DE CAPTURAS.
 *
 * `passo` é opcional e recebe a página: é onde se abre a gaveta, se aplica o
 * filtro, se rola até o bloco. O que ele NÃO faz é gravar nada — um manual que
 * altera o banco ao ser gerado produziria uma imagem diferente a cada execução.
 */
const CAPTURAS = [
  // --- Entrar -------------------------------------------------------------
  { nome: 'entrar', papel: null, rota: '/login' },
  { nome: 'recuperar-senha', papel: null, rota: '/recuperar-senha' },
  { nome: 'planos', papel: null, rota: '/planos' },
  { nome: 'criar-conta', papel: null, rota: '/criar-conta' },

  // --- Quem pede ajuda ----------------------------------------------------
  { nome: 'portal', papel: 'solicitante', rota: '/portal' },
  { nome: 'abrir-chamado', papel: 'solicitante', rota: '/tickets/novo' },
  { nome: 'base-de-conhecimento', papel: 'solicitante', rota: '/base' },
  { nome: 'meus-chamados', papel: 'solicitante', rota: '/tickets' },

  // --- Quem atende --------------------------------------------------------
  { nome: 'lista-de-chamados', papel: 'atendente', rota: '/tickets' },
  {
    nome: 'gaveta-do-chamado', papel: 'atendente', rota: '/tickets',
    /* A gaveta é o centro do trabalho de quem atende, e nenhuma rota a
       alcança: ela abre sobre a lista. `.first()` e não um elemento guardado —
       "Element is not attached to the DOM" MATA o roteiro em vez de falhá-lo. */
    passo: async (p) => {
      await p.locator('[data-testid="abrir-chamado"]').first().click()
    },
    /* Clicar na LINHA só marcava a seleção, e a captura saía idêntica à da
       lista. O `espera` existe por isso: sem ele o manual publica a tela
       errada com toda a confiança do mundo. */
    espera: '[role="dialog"], aside, [data-testid="gaveta"]',
  },
  { nome: 'filas', papel: 'atendente', rota: '/filas' },

  // --- Quem responde pelo resultado ---------------------------------------
  { nome: 'visao-geral', papel: 'gestor', rota: '/painel' },
  { nome: 'sla-e-prazos', papel: 'gestor', rota: '/sla' },
  { nome: 'satisfacao', papel: 'gestor', rota: '/satisfacao' },
  { nome: 'visao-de-resultado', papel: 'gestor', rota: '/resultado' },
  { nome: 'orcamento-de-ti', papel: 'gestor', rota: '/financeiro/orcamento' },

  // --- Inventário ---------------------------------------------------------
  { nome: 'inventario', papel: 'gestor', rota: '/inventario' },
  { nome: 'agentes', papel: 'gestor', rota: '/inventario/agentes' },
  { nome: 'links-de-internet', papel: 'gestor', rota: '/conectividade/links' },

  // --- Locação ------------------------------------------------------------
  { nome: 'frota', papel: 'admin', rota: '/locacao/frota' },
  { nome: 'contratos', papel: 'admin', rota: '/locacao/contratos' },
  { nome: 'medicoes', papel: 'admin', rota: '/locacao/medicoes' },
  { nome: 'faturamento', papel: 'admin', rota: '/locacao/faturamento' },
  { nome: 'pecas-e-estoque', papel: 'admin', rota: '/locacao/pecas' },

  // --- Administração ------------------------------------------------------
  { nome: 'usuarios', papel: 'admin', rota: '/usuarios' },
  { nome: 'perfis-de-acesso', papel: 'admin', rota: '/perfis' },
  { nome: 'convites', papel: 'admin', rota: '/usuarios/convites' },
  { nome: 'assinatura', papel: 'admin', rota: '/assinatura' },
  { nome: 'trilha-de-alteracoes', papel: 'admin', rota: '/auditoria' },
  { nome: 'avisos-enviados', papel: 'admin', rota: '/auditoria/avisos' },
  { nome: 'planilhas', papel: 'admin', rota: '/sistema/planilhas' },

  // --- O que quase ninguém vê, e por isso precisa estar no manual ---------
  {
    nome: 'paleta-de-comandos', papel: 'gestor', rota: '/painel',
    passo: async (p) => {
      await p.keyboard.press('Control+k')
      /* Esperar o campo RECEBER O FOCO, e não só existir: digitar antes disso
         manda as letras para a tela de trás, e a paleta aparece vazia. Foi
         exatamente esse defeito que deixou a suíte `paleta` vermelha só nas
         varreduras completas. */
      await p.locator('[data-testid="paleta-busca"], [role="dialog"] input').first().waitFor()
      await p.locator('[data-testid="paleta-busca"], [role="dialog"] input').first().fill('sla')
    },
    espera: '[role="dialog"]',
  },
  { nome: 'minha-conta', papel: 'gestor', rota: '/conta' },
]

const b = await chromium.launch()
const feitas = []
/* NÃO pode começar `null`: `null` é um papel válido aqui — é o visitante sem
   sessão, e a primeira captura é justamente a tela de entrada. Começando em
   `null`, o `if (papelAtual === papel)` iguala na primeira volta e o navegador
   nunca abre. Um símbolo não é igual a nada além de si mesmo. */
let papelAtual = Symbol('ainda-nao-entrou')
let ctx = null
let p = null

async function entrarComo(papel) {
  if (papelAtual === papel) return
  if (ctx) await ctx.close()
  ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  p = await ctx.newPage()
  papelAtual = papel
  if (!papel) return
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await p.fill('input[name="email"]', PESSOAS[papel])
  await p.fill('input[name="password"]', SENHA)
  await p.click('form button[type="submit"]')
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 })
}

for (const c of CAPTURAS) {
  await entrarComo(c.papel)
  const r = await p.goto(BASE + c.rota, { waitUntil: 'networkidle' }).catch(() => null)
  const status = r?.status() ?? 0

  /* Esperar a animação de entrada terminar. Capturar no meio do fade produz
     uma imagem com cores que não existem em nenhum quadro parado — é o mesmo
     defeito que fazia a conferência de contraste reprovar o que estava certo. */
  await p.evaluate(() =>
    Promise.all(
      document.getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  )
  if (c.passo) {
    /* SEM `catch`. A versão anterior registrava a falha e capturava assim
       mesmo: a gaveta não abria, a imagem saía igual à da lista, e o manual
       publicava a tela errada. Passo que falha derruba o roteiro. */
    await c.passo(p)
  }
  if (c.espera) {
    await p.locator(c.espera).first().waitFor({ state: 'visible', timeout: 10000 })
  }
  await p.waitForTimeout(400)

  const arquivo = `${c.nome}.png`
  await p.screenshot({ path: `${SAIDA}/${arquivo}` })
  feitas.push({ ...c, passo: undefined, arquivo, status })
  console.log(`  ${status}  ${String(c.papel ?? 'anônimo').padEnd(12)} ${c.rota.padEnd(28)} -> ${arquivo}`)
}

writeFileSync(`${SAIDA}/indice.json`, JSON.stringify(feitas, null, 2))
console.log(`\n${feitas.length} captura(s).`)
const ruins = feitas.filter((f) => f.papel !== null && f.status !== 200)
if (ruins.length) {
  console.log(`FALHOU: ${ruins.length} rota(s) não responderam 200: ${ruins.map((r) => r.rota).join(', ')}`)
}
await b.close()
process.exit(ruins.length === 0 ? 0 : 1)
