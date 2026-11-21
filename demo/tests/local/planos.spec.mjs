/*
 * Os planos — a página de onde sai a decisão de criar conta.
 *
 * Duas coisas importam aqui, e a segunda mais que a primeira:
 *
 *  1. ela abre SEM SESSÃO. Esconder o preço atrás do cadastro faz a pessoa
 *     fechar a aba — e exigir conta para saber quanto custa é pedir que ela se
 *     comprometa antes de saber com o quê;
 *
 *  2. ela NÃO PROMETE COBRANÇA. Este sistema não emite boleto, não integra
 *     adquirente e não guarda cartão. Um botão "Assinar" levando a um
 *     formulário de cartão prometeria o que não existe, e o primeiro cliente
 *     descobriria no primeiro vencimento.
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
const ctx = await b.newContext()
const p = await ctx.newPage()

// ---------------------------------------------------------------------------
console.log('\n=== 1. Abre sem sessão ===')
// ---------------------------------------------------------------------------
const r = await p.goto(`${BASE}/planos`, { waitUntil: 'networkidle' })
ok(r?.status() === 200, `responde 200 sem cookie nenhum (${r?.status()})`)
ok(new URL(p.url()).pathname === '/planos', 'e não é redirecionada para o login')

const texto = (await p.locator('body').innerText()).replace(/\s+/g, ' ')

// ---------------------------------------------------------------------------
console.log('\n=== 2. Diz o preço e o que entra ===')
// ---------------------------------------------------------------------------
ok(/Essencial/.test(texto) && /Gest[ãa]o/.test(texto) && /Loca[çc][ãa]o/.test(texto),
  'os três planos aparecem')
ok(/R\$\s?249/.test(texto), 'com preço em reais, e não "consulte"')
ok(/90 dias de avalia[çc][ãa]o/.test(texto), 'e a avaliação de 90 dias anunciada')

/* O limite precisa ser dito ANTES, não descoberto ao convidar o décimo
   primeiro. "Sem limite" e "até N" são informações diferentes e as duas
   aparecem. */
ok(/At[ée] 10 usu[áa]rios/.test(texto), 'o limite de usuários é dito na página')
ok(/sem limite/i.test(texto), 'e o plano sem teto diz que não tem')

// ---------------------------------------------------------------------------
console.log('\n=== 3. O que a página NÃO promete ===')
// ---------------------------------------------------------------------------
/*
 * A asserção negativa é a que protege o produto de si mesmo. Se alguém um dia
 * acrescentar "Assinar agora" com um formulário de cartão, é aqui que aparece.
 */
ok(!/cart[ãa]o de cr[ée]dito|n[úu]mero do cart[ãa]o|forma de pagamento/i.test(texto),
  'não pede cartão — o sistema não cobra')
ok(/n[ãa]o emite boleto/i.test(texto) || /n[ãa]o guarda cart[ãa]o/i.test(texto),
  'e diz isso com todas as letras, em vez de deixar supor')

ok(/continua.*(entrando|consultando)/i.test(texto) && /nada [ée] apagado/i.test(texto),
  'e explica o que acontece quando a avaliação acaba')

// ---------------------------------------------------------------------------
console.log('\n=== 4. Leva para onde de fato acontece ===')
// ---------------------------------------------------------------------------
const botao = p.locator('a:has-text("Começar a avaliação")').first()
ok(await botao.count() > 0, 'o botão existe')
await botao.click()
await p.waitForTimeout(1200)
ok(new URL(p.url()).pathname === '/criar-conta',
  'e leva para a criação de conta, não para um checkout que não existe')

// ---------------------------------------------------------------------------
console.log('\n=== 5. A entrada aponta para os planos ===')
// ---------------------------------------------------------------------------
await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
const link = p.locator('a[href="/planos"]')
ok(await link.count() > 0, 'a tela de entrada tem o link para os planos')

await b.close()
console.log(falhas ? `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM` : '\nTODAS AS ASSERÇÕES PASSARAM')
process.exit(falhas === 0 ? 0 : 1)
