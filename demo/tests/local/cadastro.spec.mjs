/*
 * Cadastro público: empresa em avaliação e confirmação de e-mail (0060).
 *
 * Por que esta suíte existe
 * -------------------------
 * É a primeira porta que ESCREVE no banco sem ninguém autenticado. Tudo o que
 * ela faz de errado é feito por estranhos, em escala, sem ninguém olhando.
 *
 * As asserções que mais importam não são as do caminho feliz — são as duas que
 * garantem que a tela **não conta nada a quem está sondando**: a resposta é
 * idêntica para e-mail novo e para e-mail que já tem conta, e o aviso de "você
 * já tem conta" vai por e-mail, sem token nenhum dentro.
 *
 * Como rodar: ver `telas.spec.mjs`.
 */
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const BASE = 'http://127.0.0.1:3177'
const SENHA = 'senha-de-teste-bem-longa'

const psql = (q) =>
  execSync(`PGPASSWORD=postgres psql -At -h 127.0.0.1 -p 5433 -U postgres -d sti_iarx_dev -c "${q}"`)
    .toString()
    .trim()

let falhas = 0
const ok = (c, m) => {
  if (!c) falhas++
  console.log(`${c ? '  ok  ' : '  FALHOU '} ${m}`)
}

/* E-mail por execução: o cadastro é, por desenho, irrepetível com o mesmo
   endereço. Reaproveitá-lo faria a segunda execução testar outro caminho. */
const EMAIL = `fulana+${Date.now()}@padaria-de-teste.com.br`

psql(`delete from public.request_throttle`)

const b = await chromium.launch()

async function cadastrar(email) {
  const ctx = await b.newContext()
  const p = await ctx.newPage()
  await p.goto(`${BASE}/criar-conta`, { waitUntil: 'networkidle' })
  await p.fill('input[name="nome"]', 'Fulana de Tal')
  await p.fill('input[name="empresa"]', 'Padaria de Teste')
  await p.fill('input[name="email"]', email)
  await p.fill('input[name="senha"]', SENHA)
  await p.click('button[type="submit"]')
  await p.waitForTimeout(2500)
  const texto = (await p.locator('body').innerText()).replace(/\s+/g, ' ').trim()
  await ctx.close()
  return texto
}

async function entrar(email, senha) {
  const ctx = await b.newContext()
  const p = await ctx.newPage()
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await p.fill('input[name="email"]', email)
  await p.fill('input[name="password"]', senha)
  await p.click('button[type="submit"]')
  await p.waitForTimeout(3200)
  const r = { caminho: new URL(p.url()).pathname, texto: await p.locator('body').innerText() }
  await ctx.close()
  return r
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. O cadastro cria empresa em avaliação ===')
// ---------------------------------------------------------------------------
const resposta = await cadastrar(EMAIL)
ok(/link de confirma[çc][ãa]o j[áa] est[áa] a caminho/i.test(resposta), 'a tela confirma o envio')

const empresa = psql(
  `select status||'|'||trial_ends_on from public.tenants where id=(select tenant_id from public.profiles where email='${EMAIL}')`,
)
ok(empresa.startsWith('trial|'), `a empresa nasce em avaliação (${empresa})`)
ok(
  empresa.split('|')[1] === psql(`select (current_date + app.parametro_numerico('trial_days',90))::text`),
  'com o prazo que o PARÂMETRO diz, e não um número cravado no código',
)
ok(psql(`select role from public.profiles where email='${EMAIL}'`) === 'admin',
  'quem se cadastra é o administrador da própria empresa')
ok(psql(`select is_active::text from public.profiles where email='${EMAIL}'`) === 'false',
  'e a conta nasce INATIVA: existir não é poder entrar')

// ---------------------------------------------------------------------------
console.log('\n=== 2. Não entra antes de confirmar — e ouve o conselho certo ===')
// ---------------------------------------------------------------------------
{
  const r = await entrar(EMAIL, SENHA)
  ok(r.caminho === '/login', 'fica na entrada')
  /*
   * "Ainda não confirmou" e "foi desativada" são o mesmo `is_active = false` e
   * precisam de conselhos OPOSTOS. Mandar quem acabou de se cadastrar procurar
   * o administrador o tranca atrás de um administrador que é ele mesmo.
   */
  ok(/confirme o seu e-mail/i.test(r.texto),
    'a mensagem manda abrir o e-mail, e NÃO procurar o administrador')
  ok(!/procure o administrador/i.test(r.texto), 'o conselho de conta desativada não aparece aqui')
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. O link confirma, e a conta passa a entrar ===')
// ---------------------------------------------------------------------------
const corpo = psql(
  `select replace(body_text,chr(10),' ') from public.email_outbox where kind='email_confirm' and to_email='${EMAIL}'`,
)
const token = (corpo.match(/confirmar-email\/([a-f0-9]{64})/) || [])[1]
ok(!!token, 'o e-mail traz o link de confirmação')

{
  const ctx = await b.newContext()
  const p = await ctx.newPage()
  await p.goto(`${BASE}/confirmar-email/${token}`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(1200)
  ok(/E-mail confirmado/i.test(await p.locator('body').innerText()), 'o link confirma')
  await ctx.close()
}
ok(psql(`select is_active::text from public.profiles where email='${EMAIL}'`) === 'true',
  'a conta ficou ativa')

{
  const r = await entrar(EMAIL, SENHA)
  ok(r.caminho === '/painel', `agora entra (${r.caminho})`)
}

{
  const ctx = await b.newContext()
  const p = await ctx.newPage()
  await p.goto(`${BASE}/confirmar-email/${token}`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(1000)
  ok(/sem validade/i.test(await p.locator('body').innerText()), 'e o mesmo link não serve de novo')
  await ctx.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. E-mail que JÁ TEM conta: a tela não conta nada ===')
// ---------------------------------------------------------------------------
const empresasAntes = psql(`select count(*) from public.tenants`)
const resposta2 = await cadastrar(EMAIL)

ok(resposta2 === resposta, 'a resposta é IDÊNTICA à de um e-mail novo')
ok(psql(`select count(*) from public.tenants`) === empresasAntes, 'e nenhuma empresa nova foi criada')
ok(
  psql(`select count(*) from public.email_outbox where kind='signup_existing' and to_email='${EMAIL}'`) === '1',
  'o aviso vai pelo E-MAIL, que é o único canal onde a diferença pode aparecer',
)
ok(
  psql(`select (body_text !~ '[a-f0-9]{64}')::text from public.email_outbox where kind='signup_existing' and to_email='${EMAIL}'`) === 'true',
  'e esse aviso não leva token: link de senha para quem não pediu seria a arma que ele deveria impedir',
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. Devolver o banco ao estado em que estava ===')
// ---------------------------------------------------------------------------
psql(`delete from public.email_outbox where to_email='${EMAIL}'`)
psql(`delete from public.tenants where id=(select tenant_id from public.profiles where email='${EMAIL}')`)
psql(`delete from auth.users where lower(email)='${EMAIL.toLowerCase()}'`)
psql(`delete from public.request_throttle`)
ok(psql(`select count(*) from public.profiles where email='${EMAIL}'`) === '0',
  'a empresa de teste foi removida, com tudo que pendia dela')

await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
