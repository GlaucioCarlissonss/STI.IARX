/*
 * Convites: entrar numa empresa que já existe (0061).
 *
 * Por que esta suíte existe
 * -------------------------
 * Convite é criação de acesso. Quem convida decide quem entra na empresa, e um
 * erro aqui não é incômodo: é alguém dentro do sistema de outra gente.
 *
 * As duas asserções que mais importam não são do caminho feliz:
 *
 *  - **gestor não convida para administrador.** Sem isso, auto-promoção fica a
 *    um passo: convide-se como admin num endereço seu e escolha a senha.
 *  - **a tela não conta se o e-mail já tem conta.** Dizer isso transformaria o
 *    formulário num verificador de contas da instalação inteira — um
 *    administrador descobriria, um e-mail por vez, quem mais usa o produto,
 *    inclusive em outras empresas.
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

const CONVIDADO = `convidada+${Date.now()}@exemplo-teste.com.br`

/*
 * O formulário de convite, e não "o primeiro submit da página": a moldura do
 * aplicativo tem um botão `sr-only` de filtro antes dele. Um seletor solto
 * clicaria naquele — foi exatamente o que aconteceu na primeira execução.
 */
const FORM = 'form:has(select[name="role"])'

async function convidar(p, email, papel) {
  await p.goto(`${BASE}/usuarios/convites`, { waitUntil: 'networkidle' })
  await p.fill(`${FORM} input[name="email"]`, email)
  await p.selectOption(`${FORM} select[name="role"]`, papel)
  await p.click(`${FORM} button:has-text("Convidar")`)
  await p.waitForTimeout(2500)
  return (await p.locator('main').innerText()).replace(/\s+/g, ' ')
}

psql(`delete from public.request_throttle`)

const b = await chromium.launch()

async function comoAdmin() {
  const ctx = await b.newContext()
  const p = await ctx.newPage()
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await p.fill('input[name="email"]', 'admin@iaroffice.com.br')
  await p.fill('input[name="password"]', 'desenvolvimento')
  await p.click('button[type="submit"]')
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 })
  return { ctx, p }
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. O administrador convida ===')
// ---------------------------------------------------------------------------
const { ctx: ctxAdmin, p: pAdmin } = await comoAdmin()
await pAdmin.goto(`${BASE}/usuarios/convites`, { waitUntil: 'networkidle' })
ok(/Convites/i.test(await pAdmin.locator('main').innerText()), 'a tela de convites abre')

const respostaConvite = await convidar(pAdmin, CONVIDADO, 'atendente')
ok(/convite j[áa] est[áa] a caminho/i.test(respostaConvite), 'a tela confirma o envio')
ok(psql(`select count(*) from public.email_outbox where kind='invite' and to_email='${CONVIDADO}'`) === '1',
  'e o e-mail entra na caixa de saída')

// ---------------------------------------------------------------------------
console.log('\n=== 2. E-mail que JÁ TEM conta: resposta idêntica ===')
// ---------------------------------------------------------------------------
const respostaExistente = await convidar(pAdmin, 'gestor@iaroffice.com.br', 'atendente')
ok(/convite j[áa] est[áa] a caminho/i.test(respostaExistente),
  'a resposta é a MESMA — a tela não revela quem já tem conta')
ok(psql(`select count(*) from public.invites where lower(email)='gestor@iaroffice.com.br'`) === '0',
  'e nenhum convite foi criado para quem já tem conta')

// ---------------------------------------------------------------------------
console.log('\n=== 3. O convite aparece na lista, com prazo ===')
// ---------------------------------------------------------------------------
await pAdmin.goto(`${BASE}/usuarios/convites`, { waitUntil: 'networkidle' })
const lista = await pAdmin.locator('main').innerText()
ok(lista.includes(CONVIDADO), 'o convidado aparece na lista')
ok(/aguardando/i.test(lista), 'com a situação de quem ainda não entrou')

// ---------------------------------------------------------------------------
console.log('\n=== 4. O link cria a conta, já ativa ===')
// ---------------------------------------------------------------------------
const corpo = psql(
  `select replace(body_text,chr(10),' ') from public.email_outbox where kind='invite' and to_email='${CONVIDADO}'`,
)
const token = (corpo.match(/convite\/([a-f0-9]{64})/) || [])[1]
ok(!!token, 'o e-mail traz o link do convite')

{
  const ctx = await b.newContext()
  const p = await ctx.newPage()
  await p.goto(`${BASE}/convite/${token}`, { waitUntil: 'networkidle' })
  const t = await p.locator('body').innerText()
  /* A tela precisa dizer PARA ONDE a pessoa está entrando antes de pedir senha:
     um formulário que não diz de qual empresa é um que ninguém deveria
     preencher. */
  ok(/IAR Office/i.test(t), 'a tela diz para qual empresa é o convite')

  /* O e-mail mora no `value` de um input, que não entra no innerText — e é
     justamente o atributo que importa aqui: ele vem do convite e não pode ser
     trocado, senão qualquer convite viraria cadastro livre para outro
     endereço. */
  const campo = p.locator('#email-convidado')
  ok((await campo.inputValue()) === CONVIDADO, 'e traz o e-mail convidado no formulário')
  ok(await campo.isDisabled(), 'que não é editável')

  await p.fill('input[name="nome"]', 'Convidada de Teste')
  await p.fill('input[name="senha"]', SENHA)
  await p.click('form button[type="submit"]')
  await p.waitForTimeout(2500)
  ok(/Conta criada/i.test(await p.locator('body').innerText()), 'a conta é criada')
  await ctx.close()
}

ok(psql(`select is_active::text from public.profiles where email='${CONVIDADO}'`) === 'true',
  'e nasce ATIVA: o link já chegou no e-mail, que é a mesma prova da confirmação')
ok(psql(`select role from public.profiles where email='${CONVIDADO}'`) === 'atendente',
  'com o papel que o convite dizia')

// ---------------------------------------------------------------------------
console.log('\n=== 5. Entra, e o link não serve de novo ===')
// ---------------------------------------------------------------------------
{
  const ctx = await b.newContext()
  const p = await ctx.newPage()
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await p.fill('input[name="email"]', CONVIDADO)
  await p.fill('input[name="password"]', SENHA)
  await p.click('button[type="submit"]')
  await p.waitForTimeout(3200)
  ok(new URL(p.url()).pathname === '/painel', 'a pessoa convidada entra')
  await ctx.close()
}

{
  const ctx = await b.newContext()
  const p = await ctx.newPage()
  await p.goto(`${BASE}/convite/${token}`, { waitUntil: 'networkidle' })
  ok(/sem validade/i.test(await p.locator('body').innerText()), 'o mesmo convite não serve duas vezes')
  await ctx.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. Gestor NÃO convida para administrador ===')
// ---------------------------------------------------------------------------
/*
 * A asserção de segurança desta suíte. Sem a trava, auto-promoção fica a um
 * passo: convide-se como admin num endereço seu e escolha a senha.
 */
{
  const ctx = await b.newContext()
  const p = await ctx.newPage()
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await p.fill('input[name="email"]', 'gestor@iaroffice.com.br')
  await p.fill('input[name="password"]', 'desenvolvimento')
  await p.click('button[type="submit"]')
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 })
  await p.goto(`${BASE}/usuarios/convites`, { waitUntil: 'networkidle' })

  const alcanca = /Convidar algu[ée]m/i.test(await p.locator('main').innerText())
  if (alcanca) {
    const r = await convidar(p, `tentativa+${Date.now()}@exemplo-teste.com.br`, 'admin')
    ok(/acima do seu/i.test(r), 'gestor é recusado ao tentar convidar para administrador')
  } else {
    ok(true, 'gestor não alcança o formulário de convite (a chave é só do administrador)')
  }
  await ctx.close()
}

/*
 * E a trava no banco, afirmada direto — porque hoje a tela NUNCA chega nela.
 *
 * `usuarios.convites.criar` só existe no papel de administrador, e
 * `guard_grant_within_base_role` impede conceder a chave a um perfil de base
 * `gestor`. Então o `role_rank` da 0061 é cinto sobre suspensório: só alcançável
 * por quem chamar a função com a chave de serviço.
 *
 * Cinto que ninguém testa é cinto que arrebenta no dia em que a chave mudar de
 * papel. Esta asserção existe para que esse dia tenha um teste vermelho.
 */
{
  const gestor = psql(`select id from public.profiles where email='gestor@iaroffice.com.br'`)
  const tenant = psql(`select tenant_id from public.profiles where email='gestor@iaroffice.com.br'`)
  let recusou = false
  try {
    execSync(
      `PGPASSWORD=postgres psql -At -h 127.0.0.1 -p 5433 -U postgres -d sti_iarx_dev -v ON_ERROR_STOP=1 ` +
        `-c "select app.convidar_para_empresa('${tenant}'::uuid, 'escalada@exemplo-teste.com.br', 'admin', '${gestor}'::uuid)"`,
      { stdio: 'pipe' },
    )
  } catch (e) {
    recusou = /acima do seu/i.test(String(e.stderr))
  }
  ok(recusou, 'a função recusa um gestor convidando para administrador')
  ok(psql(`select count(*) from public.invites where email='escalada@exemplo-teste.com.br'`) === '0',
    'e nenhum convite sobra da tentativa')
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. Revogar tira o link do ar ===')
// ---------------------------------------------------------------------------
const OUTRO = `revogada+${Date.now()}@exemplo-teste.com.br`
await convidar(pAdmin, OUTRO, 'solicitante')

const corpo2 = psql(
  `select replace(body_text,chr(10),' ') from public.email_outbox where kind='invite' and to_email='${OUTRO}'`,
)
const token2 = (corpo2.match(/convite\/([a-f0-9]{64})/) || [])[1]

await pAdmin.goto(`${BASE}/usuarios/convites`, { waitUntil: 'networkidle' })
await pAdmin.locator(`tr:has-text("${OUTRO}") button:has-text("Revogar")`).first().click()
await pAdmin.waitForTimeout(2000)

{
  const ctx = await b.newContext()
  const p = await ctx.newPage()
  await p.goto(`${BASE}/convite/${token2}`, { waitUntil: 'networkidle' })
  ok(/sem validade/i.test(await p.locator('body').innerText()),
    'revogar derruba o link que já estava na caixa de alguém')
  await ctx.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 8. Devolver o banco ao estado em que estava ===')
// ---------------------------------------------------------------------------
psql(`delete from public.email_outbox where kind='invite'`)
psql(`delete from public.invites where email like '%@exemplo-teste.com.br'`)
psql(`delete from public.profiles where email='${CONVIDADO}'`)
psql(`delete from auth.users where lower(email)='${CONVIDADO.toLowerCase()}'`)
psql(`delete from public.request_throttle`)
ok(psql(`select count(*) from public.profiles where email='${CONVIDADO}'`) === '0',
  'a conta de teste foi removida')

await ctxAdmin.close()
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
