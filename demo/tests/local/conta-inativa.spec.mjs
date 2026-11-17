/*
 * Conta desativada não entra, e quem for desativado perde a sessão.
 *
 * Por que esta suíte existe
 * -------------------------
 * A tela de usuários oferece inativar alguém desde que existe, e até esta
 * entrega `is_active` era LIDO e nunca aplicado: quem fosse desativado
 * continuava entrando e trabalhando normalmente. Medi antes de consertar —
 * desativei uma conta do exemplo e ela chegou ao painel.
 *
 * É a diferença entre "tirei o acesso dessa pessoa" e "mudei um campo que não
 * faz nada", e quem clica em desativar acredita na primeira. Num desligamento
 * ou num incidente, a diferença é o sistema inteiro.
 *
 * O caso 3 é o que custou mais caro: consertar o login não bastava, porque quem
 * JÁ ESTAVA dentro seguia com um cookie que o proxy aceitava. A primeira versão
 * da correção produziu um laço de redirecionamento — o navegador parava em
 * ERR_TOO_MANY_REDIRECTS, que é tela de erro do navegador e não explica nada.
 *
 * Como rodar: ver `telas.spec.mjs`.
 */
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const BASE = 'http://127.0.0.1:3177'
const EMAIL = 'bruno.atendente@iaroffice.com.br'
const SENHA = 'desenvolvimento'

const psql = (q) =>
  execSync(`PGPASSWORD=postgres psql -At -h 127.0.0.1 -p 5433 -U postgres -d sti_iarx_dev -c "${q}"`)
    .toString()
    .trim()

let falhas = 0
const ok = (c, m) => {
  if (!c) falhas++
  console.log(`${c ? '  ok  ' : '  FALHOU '} ${m}`)
}

const ativar = (v) =>
  psql(`update public.profiles set is_active=${v} where lower(email)=lower('${EMAIL}')`)

/* Estado conhecido na entrada — é o que torna a suíte repetível. */
ativar(true)

const b = await chromium.launch()

async function entrar() {
  const ctx = await b.newContext()
  const p = await ctx.newPage()
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await p.fill('input[name="email"]', EMAIL)
  await p.fill('input[name="password"]', SENHA)
  await p.click('button[type="submit"]')
  await p.waitForTimeout(3000)
  return { ctx, p }
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. Conta ativa entra ===')
// ---------------------------------------------------------------------------
{
  const { ctx, p } = await entrar()
  ok(new URL(p.url()).pathname === '/painel', 'conta ativa chega ao painel')
  await ctx.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. Conta desativada não entra — e sabe por quê ===')
// ---------------------------------------------------------------------------
{
  ativar(false)
  const { ctx, p } = await entrar()
  ok(new URL(p.url()).pathname === '/login', 'fica na tela de entrada')
  /*
   * A mensagem aqui é ESPECÍFICA, e isso é seguro: neste ponto a senha já foi
   * conferida, então quem a lê provou ser o dono da conta. "E-mail ou senha
   * incorretos" mandaria a pessoa tentar de novo para sempre.
   */
  ok(
    /desativada/i.test(await p.locator('body').innerText()),
    'e a mensagem diz o motivo, em vez de "senha incorreta"',
  )
  await ctx.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. Desativado NO MEIO do trabalho perde a sessão ===')
// ---------------------------------------------------------------------------
{
  ativar(true)
  const { ctx, p } = await entrar()
  ok(new URL(p.url()).pathname === '/painel', 'entrou com a conta ativa')

  ativar(false)

  let erro = null
  try {
    await p.goto(`${BASE}/tickets`, { waitUntil: 'networkidle' })
  } catch (e) {
    erro = e.message
  }
  await p.waitForTimeout(800)

  /*
   * A asserção que pegou o defeito da primeira correção. Sem apagar o cookie,
   * o proxy insistia que havia sessão e devolvia para o painel, que devolvia
   * para o login, para sempre.
   */
  ok(!erro, erro ? `houve laço de redirecionamento: ${erro.slice(0, 50)}` : 'sem laço de redirecionamento')
  ok(new URL(p.url()).pathname === '/login', 'é devolvido para a entrada')
  ok(
    /desativada/i.test(await p.locator('body').innerText()),
    'e a tela explica, em vez de aparecer em branco no lugar do trabalho',
  )

  /* E o cookie foi mesmo apagado, não só ignorado nesta requisição. */
  await p.goto(`${BASE}/painel`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(600)
  ok(new URL(p.url()).pathname === '/login', 'o cookie foi apagado: tentar de novo não entra')
  await ctx.close()
}

ativar(true)
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
