/*
 * O menu que abre e fecha.
 *
 * Por que esta suíte existe
 * -------------------------
 * Acordeão é das poucas coisas de interface que falham de um jeito convincente:
 * o grupo não abre, a setinha não gira, a preferência não volta — e a tela
 * continua parecendo certa. Nada disso aparece em teste unitário, porque o
 * comportamento é do navegador (`<details>`), não do React.
 *
 * As quatro propriedades testadas aqui são exatamente as que, se quebrarem,
 * transformam o acordeão num estorvo:
 *   1. clicar abre, clicar de novo fecha;
 *   2. a setinha gira junto — ela é a única pista visual do estado;
 *   3. o que foi fechado continua fechado depois de recarregar;
 *   4. o grupo da tela atual abre sozinho, mesmo tendo sido fechado antes.
 *
 * A quarta é a que o acordeão quase sempre erra: sem ela, navegar para uma tela
 * esconde justamente onde você está.
 *
 * Como rodar: ver `telas.spec.mjs`.
 */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3177'
const SENHA = 'desenvolvimento'

let falhas = 0
const ok = (c, m) => {
  if (!c) falhas++
  console.log(`${c ? '  ok  ' : '  FALHOU '} ${m}`)
}

const b = await chromium.launch()
const ctx = await b.newContext()
const p = await ctx.newPage()

await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await p.fill('input[name="email"]', 'admin@iaroffice.com.br')
await p.fill('input[name="password"]', SENHA)
await p.click('button[type="submit"]')
await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 })

const grupo = (nome) => p.locator('details').filter({ has: p.locator(`summary:text-is("${nome}")`) })

// ---------------------------------------------------------------------------
console.log('\n=== 1. Os grupos existem e chegam abertos ===')
// ---------------------------------------------------------------------------
{
  const esperados = [
    'Atendimento',
    'Autoatendimento',
    'Gestão',
    'Inventário e monitoramento',
    'Financeiro',
    'Clientes e contratos',
    'Integrações',
    'Administração',
  ]
  for (const nome of esperados) {
    ok((await grupo(nome).count()) === 1, `o grupo "${nome}" está no menu`)
  }

  /* Primeira visita mostra tudo: um menu que chega fechado obriga a caçar antes
     de conhecer. */
  ok(
    await grupo('Financeiro').evaluate((e) => e.open),
    'na primeira visita o grupo chega ABERTO',
  )

  /* Aparece duas vezes: na barra lateral e na tira compacta de celular, que
     convivem no mesmo HTML e se revezam por media query. */
  const visaoGeral = p.locator('a[href="/painel"]')
  ok((await visaoGeral.count()) >= 1, 'Visão geral está no menu')
  ok(
    (await visaoGeral.first().isVisible()) &&
      (await visaoGeral.first().evaluate((e) => e.closest('details') === null)),
    'e fica FORA de qualquer grupo recolhível: o que é destino de todo mundo não pode depender de abrir gaveta',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. Clicar fecha; clicar de novo abre ===')
// ---------------------------------------------------------------------------
{
  const financeiro = grupo('Financeiro')
  const resumo = financeiro.locator('summary')
  const itemDentro = financeiro.locator('a[href="/financeiro/titulos-a-pagar"]')

  ok(await itemDentro.isVisible(), 'com o grupo aberto, o item de dentro se vê')

  await resumo.click()
  await p.waitForTimeout(200)
  ok(!(await financeiro.evaluate((e) => e.open)), 'o clique FECHA o grupo')
  ok(!(await itemDentro.isVisible()), 'e o item de dentro some')

  await resumo.click()
  await p.waitForTimeout(200)
  ok(await financeiro.evaluate((e) => e.open), 'o clique de novo ABRE')
  ok(await itemDentro.isVisible(), 'e o item volta')
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. A setinha gira — é a única pista do estado ===')
// ---------------------------------------------------------------------------
{
  const financeiro = grupo('Financeiro')
  const seta = financeiro.locator('summary svg[aria-hidden="true"]').first()

  /* `rotate`, e não `transform`: o Tailwind v4 usa a propriedade CSS `rotate`
     para `rotate-90`, e `transform` fica em `none`. Medir a propriedade errada
     reprovava uma setinha que girava na cara de quem olhasse. */
  const giro = () => seta.evaluate((e) => getComputedStyle(e).rotate)

  const giroAberto = await giro()
  await financeiro.locator('summary').click()
  await p.waitForTimeout(400)
  const giroFechado = await giro()

  ok(giroAberto === '90deg', 'aberta, a setinha aponta para baixo (90°)')
  ok(giroAberto !== giroFechado, 'e a rotação muda ao fechar')
  ok(giroFechado === 'none' || giroFechado === '0deg',
    'fechada, a setinha aponta para o lado')
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. O que foi fechado continua fechado ===')
// ---------------------------------------------------------------------------
{
  // O Financeiro ficou fechado no passo 3.
  await p.reload({ waitUntil: 'networkidle' })
  await p.waitForTimeout(500)
  ok(
    !(await grupo('Financeiro').evaluate((e) => e.open)),
    'depois de recarregar, o grupo fechado continua fechado',
  )
  ok(
    await grupo('Atendimento').evaluate((e) => e.open),
    'e o que não foi mexido continua aberto',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. O grupo da tela atual abre sozinho ===')
// ---------------------------------------------------------------------------
{
  /*
   * É a propriedade que um acordeão de menu quase sempre erra. O Financeiro
   * está fechado por escolha da pessoa; ao ENTRAR numa tela dele, ele precisa
   * abrir — estar numa tela e não ver onde ela fica é pior que desrespeitar a
   * preferência.
   */
  await p.goto(`${BASE}/financeiro/titulos-a-pagar`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(500)

  ok(
    await grupo('Financeiro').evaluate((e) => e.open),
    'ao entrar numa tela do grupo, ele abre mesmo tendo sido fechado',
  )
  ok(
    await grupo('Financeiro').locator('a[href="/financeiro/titulos-a-pagar"]').isVisible(),
    'e o item da tela atual está visível',
  )

  // Sai da tela: a preferência volta a valer.
  await p.goto(`${BASE}/painel`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(500)
  ok(
    !(await grupo('Financeiro').evaluate((e) => e.open)),
    'saindo do grupo, a preferência de quem usa volta a valer',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. Teclado e leitor de tela ===')
// ---------------------------------------------------------------------------
{
  const atendimento = grupo('Atendimento')
  const resumo = atendimento.locator('summary')

  await resumo.focus()
  await p.keyboard.press('Enter')
  await p.waitForTimeout(200)
  ok(!(await atendimento.evaluate((e) => e.open)), 'Enter no cabeçalho fecha o grupo')

  await p.keyboard.press('Enter')
  await p.waitForTimeout(200)
  ok(await atendimento.evaluate((e) => e.open), 'e abre de novo')

  /* `<details>` dá `aria-expanded` sozinho. Escrevê-lo à mão seria duplicar —
     e duplicar estado acessível é como ele passa a mentir. */
  const temNome = await atendimento
    .locator('ul[aria-label="Atendimento"]')
    .count()
  ok(temNome === 1, 'a lista do grupo tem nome acessível próprio')
}

await ctx.close()
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
