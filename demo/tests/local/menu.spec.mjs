/*
 * A sanfona do menu: um grupo aberto de cada vez.
 *
 * Por que esta suíte existe
 * -------------------------
 * Sanfona é das poucas coisas de interface que falham de um jeito convincente:
 * o grupo não abre, o anterior não fecha, a setinha não gira, a escolha não
 * volta — e a tela continua parecendo certa. Nada disso aparece em teste
 * unitário, porque o comportamento é do navegador (`<details>`) e do contexto
 * compartilhado, não de um componente isolado.
 *
 * As cinco propriedades testadas aqui são exatamente as que, se quebrarem,
 * transformam a sanfona num estorvo:
 *   1. abrir um fecha o outro — é o que faz dela sanfona, e não acordeão solto;
 *   2. clicar no que está aberto fecha tudo;
 *   3. a setinha gira junto — é a única pista visual do estado;
 *   4. a escolha continua valendo depois de recarregar;
 *   5. o grupo da tela atual abre sozinho, e numa tela sem grupo o último
 *      aberto continua aberto.
 *
 * A quinta é a que a sanfona quase sempre erra, e erra pior que o acordeão
 * livre: sem ela, navegar esconde onde você está e não sobra nenhum outro grupo
 * aberto para dar contexto.
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

const lateral = p.locator('nav[aria-label="Navegação principal"]').first()
const grupo = (nome) => lateral.locator('details').filter({ has: p.locator(`summary:text-is("${nome}")`) })
const aberto = (nome) => grupo(nome).evaluate((e) => e.open)

/** Quantos grupos estão abertos agora — a asserção central da sanfona. */
const abertos = () =>
  lateral.evaluate((n) =>
    [...n.querySelectorAll('details')].filter((d) => d.open).map((d) => d.querySelector('summary').textContent.trim()),
  )

const GRUPOS = [
  'Atendimento',
  'Autoatendimento',
  'Gestão',
  'Financeiro',
  'Inventário e monitoramento',
  'Clientes e contratos',
  'Integrações',
  'Administração',
]

// ---------------------------------------------------------------------------
console.log('\n=== 1. Os grupos existem, e só um chega aberto ===')
// ---------------------------------------------------------------------------
{
  for (const nome of GRUPOS) {
    ok((await grupo(nome).count()) === 1, `o grupo "${nome}" está no menu`)
  }

  /* Primeira visita, numa tela que não pertence a grupo nenhum: abre o primeiro.
     Sanfona não tem como "chegar toda aberta", e chegar toda fechada obrigaria a
     caçar antes de conhecer. */
  const quais = await abertos()
  ok(quais.length === 1, `na primeira visita há exatamente UM grupo aberto (havia ${quais.length})`)
  ok(quais[0] === 'Atendimento', `e é o primeiro da barra (era "${quais[0]}")`)

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
console.log('\n=== 2. Abrir um FECHA o outro ===')
// ---------------------------------------------------------------------------
{
  const itemDentro = grupo('Financeiro').locator('a[href="/financeiro/titulos-a-pagar"]')

  await grupo('Financeiro').locator('summary').click()
  await p.waitForTimeout(250)

  ok(await aberto('Financeiro'), 'o clique abre o grupo')
  ok(!(await aberto('Atendimento')), 'e FECHA o que estava aberto — é isto que faz dela sanfona')
  ok((await abertos()).length === 1, 'nunca há dois abertos ao mesmo tempo')
  ok(await itemDentro.isVisible(), 'o item de dentro se vê')

  /* O caso que o guarda de eco do `onToggle` protege: sem ele, o fechamento
     automático do grupo anterior seria lido como "a pessoa fechou tudo" e
     desfaria a abertura que acabou de acontecer. Três trocas seguidas é o
     suficiente para o laço aparecer, se existir. */
  for (const nome of ['Integrações', 'Gestão', 'Administração']) {
    await grupo(nome).locator('summary').click()
    await p.waitForTimeout(200)
    const quais = await abertos()
    ok(
      quais.length === 1 && quais[0] === nome,
      `trocando para "${nome}", ele fica sozinho aberto (abertos: ${quais.join(', ') || 'nenhum'})`,
    )
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. Clicar no que está aberto fecha tudo ===')
// ---------------------------------------------------------------------------
{
  await grupo('Administração').locator('summary').click()
  await p.waitForTimeout(250)
  ok(!(await aberto('Administração')), 'o clique de novo fecha o grupo')
  ok((await abertos()).length === 0, 'e a sanfona fica toda fechada — quem fecha manda')
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. A setinha gira — é a única pista do estado ===')
// ---------------------------------------------------------------------------
{
  const financeiro = grupo('Financeiro')
  const seta = financeiro.locator('summary svg[aria-hidden="true"]').first()

  /* `rotate`, e não `transform`: o Tailwind v4 usa a propriedade CSS `rotate`
     para `rotate-90`, e `transform` fica em `none`. Medir a propriedade errada
     reprovava uma setinha que girava na cara de quem olhasse. */
  const giro = () => seta.evaluate((e) => getComputedStyle(e).rotate)

  const giroFechado = await giro()
  await financeiro.locator('summary').click()
  await p.waitForTimeout(400)
  const giroAberto = await giro()

  ok(giroAberto === '90deg', 'aberta, a setinha aponta para baixo (90°)')
  ok(giroAberto !== giroFechado, 'e a rotação muda ao fechar')
  ok(
    giroFechado === 'none' || giroFechado === '0deg',
    'fechada, a setinha aponta para o lado',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. A escolha continua valendo depois de recarregar ===')
// ---------------------------------------------------------------------------
{
  // O Financeiro ficou aberto no passo 4, na mesma tela.
  await p.reload({ waitUntil: 'networkidle' })
  await p.waitForTimeout(500)
  const quais = await abertos()
  ok(quais.length === 1 && quais[0] === 'Financeiro', 'depois de recarregar, o grupo escolhido continua aberto')
  ok(!(await aberto('Atendimento')), 'e o padrão da primeira visita não volta por cima da escolha')
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. O grupo da tela atual abre sozinho ===')
// ---------------------------------------------------------------------------
{
  /*
   * É a propriedade que uma sanfona de menu quase sempre erra. A escolha de
   * quem usa foi "Atendimento", feita na Visão geral; ao ENTRAR numa tela do
   * Financeiro, é o Financeiro que precisa estar aberto — estar numa tela e não
   * ver onde ela fica é pior que repetir a última escolha.
   */
  await grupo('Atendimento').locator('summary').click()
  await p.waitForTimeout(250)

  await p.goto(`${BASE}/financeiro/titulos-a-pagar`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(500)

  const quais = await abertos()
  ok(quais.length === 1 && quais[0] === 'Financeiro', 'ao entrar numa tela do grupo, ELE abre')
  ok(!(await aberto('Atendimento')), 'e o grupo da escolha anterior fecha')
  ok(
    await grupo('Financeiro').locator('a[href="/financeiro/titulos-a-pagar"]').isVisible(),
    'o item da tela atual está visível',
  )

  /* Regra 3: numa tela que não pertence a grupo nenhum não há quem dispute, e o
     que estava aberto continua aberto. Sem isto, ir à "Minha conta" fecharia a
     barra inteira e obrigaria a abrir uma gaveta para ir a qualquer lugar. */
  await grupo('Integrações').locator('summary').click()
  await p.waitForTimeout(250)
  await p.goto(`${BASE}/conta`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(500)

  const naConta = await abertos()
  ok(
    naConta.length === 1 && naConta[0] === 'Integrações',
    `numa tela sem grupo, o último aberto continua aberto (abertos: ${naConta.join(', ') || 'nenhum'})`,
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. Teclado e leitor de tela ===')
// ---------------------------------------------------------------------------
{
  const atendimento = grupo('Atendimento')
  const resumo = atendimento.locator('summary')

  await resumo.focus()
  await p.keyboard.press('Enter')
  await p.waitForTimeout(250)
  ok(await atendimento.evaluate((e) => e.open), 'Enter no cabeçalho abre o grupo')
  ok(!(await aberto('Integrações')), 'e fecha o anterior, igual ao clique')

  await p.keyboard.press('Enter')
  await p.waitForTimeout(250)
  ok(!(await atendimento.evaluate((e) => e.open)), 'Enter de novo fecha')

  /* `<details>` dá `aria-expanded` sozinho. Escrevê-lo à mão seria duplicar —
     e duplicar estado acessível é como ele passa a mentir. */
  const temNome = await atendimento.locator('ul[aria-label="Atendimento"]').count()
  ok(temNome === 1, 'a lista do grupo tem nome acessível próprio')
}

await ctx.close()
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
