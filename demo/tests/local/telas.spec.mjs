/*
 * Varredura das telas autenticadas, no MODO LOCAL.
 *
 * Por que esta suíte existe
 * -------------------------
 * `aplicacao.spec.mjs` cobre só rota pública, e a justificativa escrita lá era
 * honesta: "as telas autenticadas dependem de um Supabase acessível, que este
 * ambiente não tem. Fingir uma sessão aqui testaria o dublê, não o sistema."
 *
 * O modo local removeu a premissa. Não há dublê: há PostgreSQL de verdade, com
 * as mesmas migrações, as mesmas policies e a mesma sessão passando por
 * `set local role` e `request.jwt.claims`. Então as telas autenticadas passaram
 * a ser testáveis — e, na primeira execução, seis delas quebravam.
 *
 * O que ela pegou na estreia
 * --------------------------
 *  · três telas quebradas por `numeric` chegando como string e `timestamptz`
 *    como `Date` (o PostgREST entrega JSON; o driver `pg`, tipos nativos);
 *  · `/resultado` com erro de hidratação por `<title>` dentro de SVG — o React
 *    19 trata `<title>` como metadado de documento e o iça para o `<head>`;
 *  · duas telas tentando abrir WebSocket contra um Supabase que não existe.
 *
 * Como rodar
 * ----------
 *   bash scripts/preparar-banco-local.sh
 *   npm run build && npx next start -p 3177 &
 *   node demo/tests/local/telas.spec.mjs
 *
 * `/mapas` depende de ladrilho de `server.arcgisonline.com`. Em ambiente sem
 * saída para a internet ele falha, e isso é do ambiente, não da tela.
 */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3177'

const ROTAS = [
  '/painel',
  '/portal',
  '/resultado',
  '/tickets',
  '/tickets/novo',
  '/filas',
  '/sla',
  '/sla/horarios',
  '/satisfacao',
  '/base',
  '/catalogo',
  '/conversas',
  '/conversas/canais',
  '/projetos',
  '/financeiro/titulos-a-pagar',
  '/financeiro/titulos-a-receber',
  '/financeiro/contas-bancarias',
  '/financeiro/centros-de-custo',
  '/financeiro/fluxo-de-caixa',
  '/financeiro/orcamento',
  '/inventario',
  '/inventario/agentes',
  '/inventario/software',
  '/telefonia',
  '/conectividade/links',
  '/mapas',
  '/clientes',
  '/fornecedores',
  '/integracoes',
  '/usuarios',
  '/perfis',
  '/tv',
  '/ia',
  '/auditoria',
  '/auditoria/trabalhos',
  '/ambiente',
  '/conta',
]

const b = await chromium.launch()
const ctx = await b.newContext()
const p = await ctx.newPage()

const problemas = []
let consoleErros = []
p.on('console', (m) => {
  if (m.type() === 'error') consoleErros.push(m.text())
})
p.on('pageerror', (e) => consoleErros.push(String(e)))

await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await p.fill('input[name="email"]', process.env.USUARIO ?? 'admin@iaroffice.com.br')
await p.fill('input[name="password"]', 'desenvolvimento')
await p.click('button[type="submit"]')
await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 })

for (const rota of ROTAS) {
  consoleErros = []
  let status = 0
  const resposta = await p.goto(BASE + rota, { waitUntil: 'networkidle' }).catch(() => null)
  status = resposta?.status() ?? 0
  const corpo = await p.locator('body').innerText()

  const quebrou =
    status >= 500 ||
    /Application error|Erro inesperado|Unhandled Runtime Error|Something went wrong/i.test(corpo)
  const vazio = corpo.trim().length < 200

  if (quebrou || vazio || consoleErros.length) {
    problemas.push({
      rota,
      status,
      quebrou,
      vazio,
      erros: consoleErros.slice(0, 3),
      trecho: corpo.split('\n').filter((l) => l.trim()).slice(0, 6).join(' | '),
    })
    console.log(`FALHOU ${rota} (${status})`)
    if (consoleErros.length) console.log('        ' + consoleErros[0]?.slice(0, 300))
  } else {
    console.log(`  ok   ${rota} (${status})`)
  }
}

console.log(`\n${problemas.length} rota(s) com problema de ${ROTAS.length}.`)
for (const x of problemas) {
  console.log(`\n--- ${x.rota} ---`)
  console.log(x.trecho.slice(0, 400))
  for (const e of x.erros) console.log('  erro: ' + e.slice(0, 400))
}

await b.close()
process.exit(problemas.length === 0 ? 0 : 1)
