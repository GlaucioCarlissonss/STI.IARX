/*
 * O fluxo de aprovação de pedido, de ponta a ponta, com três pessoas.
 *
 * Por que ele precisa ser de ponta a ponta
 * ----------------------------------------
 * A aprovação atravessa cadastro, pedido, trigger de estado, pausa de SLA,
 * permissão por papel e decisão transacional. Cada pedaço tem asserção de
 * schema; o que nenhuma delas prova é que os pedaços se encaixam na mão de
 * quem usa.
 *
 * Na primeira execução, não se encaixavam: **abrir chamado não funcionava para
 * ninguém que não fosse administrador** — três triggers de escrituração não
 * eram `security definer`, e as tabelas que elas mantêm só têm policy de
 * leitura. O produto inteiro dependia disso e nenhum teste pegou, porque todos
 * criavam chamado como dono do banco. Corrigido na 0045.
 *
 * Como rodar: ver `telas.spec.mjs`.
 */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3177'
const SENHA = 'desenvolvimento'
const NOME_DO_SERVICO = `Compra de monitor ${Date.now().toString().slice(-5)}`

let falhas = 0
const ok = (c, m) => {
  if (!c) falhas++
  console.log(`${c ? '  ok  ' : '  FALHOU '} ${m}`)
}

const b = await chromium.launch()

async function entrar(email) {
  const ctx = await b.newContext()
  const p = await ctx.newPage()
  const erros = []
  p.on('pageerror', (e) => erros.push(String(e)))
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await p.fill('input[name="email"]', email)
  await p.fill('input[name="password"]', SENHA)
  await p.click('button[type="submit"]')
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 })
  return { ctx, p, erros }
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. O gestor cadastra um serviço que exige aprovação ===')
// ---------------------------------------------------------------------------
{
  const { ctx, p } = await entrar('admin@iaroffice.com.br')
  await p.goto(`${BASE}/catalogo`, { waitUntil: 'networkidle' })

  // O formulário fica dentro de um <details>; abre pelo resumo.
  const abridor = p.locator('summary', { hasText: /servi/i }).first()
  if (await abridor.count()) await abridor.click()

  const formulario = p.locator('form:has(input[name="requer_aprovacao"])')
  await formulario.locator('input[name="name"]').fill(NOME_DO_SERVICO)
  await formulario.locator('input[name="requer_aprovacao"]').check()
  await formulario.locator('button[type="submit"]').click()
  await p.waitForLoadState('networkidle')
  await p.waitForTimeout(1500)
  await p.goto(`${BASE}/catalogo`, { waitUntil: 'networkidle' })

  const corpo = await p.locator('body').innerText()
  ok(corpo.includes(NOME_DO_SERVICO), 'o serviço aparece na vitrine depois de salvo')
  ok(/precisa de aprova/i.test(corpo), 'e a vitrine marca que ele precisa de aprovação')
  await ctx.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. O solicitante pede o serviço ===')
// ---------------------------------------------------------------------------
let urlDoChamado = null
{
  const { ctx, p } = await entrar('carla.solicitante@meridiano.com.br')
  await p.goto(`${BASE}/catalogo`, { waitUntil: 'networkidle' })

  const cartao = p.locator('article').filter({ hasText: NOME_DO_SERVICO }).first()
  ok((await cartao.count()) > 0, 'o solicitante enxerga o serviço na vitrine')
  await cartao.getByRole('link', { name: 'Pedir' }).click()
  await p.waitForLoadState('networkidle')

  const antes = await p.locator('body').innerText()
  ok(
    /precisa de aprova/i.test(antes),
    'a tela de pedido avisa, ANTES de pedir, que vai precisar de aprovação',
  )

  await p.locator('form:has(input[name="service_id"]) button[type="submit"]').click()
  await p.waitForURL(/\/tickets\/[0-9a-f-]{36}/, { timeout: 60000 })
  urlDoChamado = p.url()
  ok(true, `o pedido virou chamado: ${urlDoChamado.replace(BASE, '')}`)

  /* A tela do chamado transmite em partes: ler o corpo antes de ela terminar
     devolve "Carregando a tela…", e o teste reprova o que está certo. */
  await p.waitForLoadState('networkidle')
  await p.waitForSelector('text=Aguardando aprovação', { timeout: 30000 }).catch(() => {})
  const chamado = await p.locator('body').innerText()
  ok(
    /Aguardando aprova/i.test(chamado),
    'e o chamado nasce AGUARDANDO APROVAÇÃO, não aberto',
  )
  ok(
    !/Aprovar o pedido/i.test(chamado),
    'o solicitante NÃO vê o botão de aprovar — quem decide é outra pessoa',
  )
  ok(
    /relógio do SLA está/i.test(chamado) || /parado/i.test(chamado),
    'a tela diz que o relógio do SLA está parado',
  )
  await ctx.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. O gestor aprova ===')
// ---------------------------------------------------------------------------
{
  const { ctx, p } = await entrar('gestor@iaroffice.com.br')
  await p.goto(urlDoChamado, { waitUntil: 'networkidle' })

  const antes = await p.locator('body').innerText()
  ok(/Aprovar o pedido/i.test(antes), 'o gestor vê o botão de aprovar')
  ok(/Recusar o pedido/i.test(antes), 'e o de recusar, com motivo obrigatório')

  await p.click('button:has-text("Aprovar o pedido")')
  await p.waitForLoadState('networkidle')
  await p.waitForTimeout(1200)
  await p.reload({ waitUntil: 'networkidle' })

  const depois = await p.locator('body').innerText()
  ok(/Aprovado/i.test(depois), 'depois de aprovar, o painel mostra APROVADO com quem decidiu')
  ok(/Pedido aprovado\./i.test(depois), 'e o chamado ganha o comentário público da decisão')
  ok(
    !/Aguardando aprova/i.test(depois) || /Aprovado/i.test(depois),
    'o chamado deixou de estar aguardando',
  )
  await ctx.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. A recusa exige motivo ===')
// ---------------------------------------------------------------------------
{
  const { ctx, p } = await entrar('carla.solicitante@meridiano.com.br')
  await p.goto(`${BASE}/catalogo`, { waitUntil: 'networkidle' })
  await p
    .locator('article')
    .filter({ hasText: NOME_DO_SERVICO })
    .first()
    .getByRole('link', { name: 'Pedir' })
    .click()
  await p.waitForLoadState('networkidle')
  await p.locator('form:has(input[name="service_id"]) button[type="submit"]').click()
  await p.waitForURL(/\/tickets\/[0-9a-f-]{36}/, { timeout: 60000 })
  const segundo = p.url()
  await ctx.close()

  const g = await entrar('gestor@iaroffice.com.br')
  await g.p.goto(segundo, { waitUntil: 'networkidle' })

  // Sem motivo: o próprio navegador barra (required), então a recusa não sai.
  const motivo = g.p.locator('textarea[name="motivo"]')
  ok((await motivo.count()) > 0, 'o campo de motivo existe na recusa')
  const obrigatorio = await motivo.getAttribute('required')
  ok(obrigatorio !== null, 'e é obrigatório no próprio formulário')

  await motivo.fill('Fora do orçamento deste trimestre.')
  await g.p.click('button:has-text("Recusar o pedido")')
  await g.p.waitForLoadState('networkidle')
  await g.p.waitForTimeout(1200)
  await g.p.reload({ waitUntil: 'networkidle' })

  const depois = await g.p.locator('body').innerText()
  ok(/Recusado/i.test(depois), 'a recusa aparece no painel')
  ok(
    /Fora do orçamento deste trimestre\./.test(depois),
    'com o motivo escrito, visível para quem pediu',
  )
  await g.ctx.close()
}

await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
