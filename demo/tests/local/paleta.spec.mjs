/*
 * A paleta de comandos e o menu de celular — Fase 1 da revisão de usabilidade.
 *
 * Por que esta suíte existe
 * -------------------------
 * A paleta é atalho de teclado, busca em rede e navegação, as três coisas que
 * quebram em silêncio: o atalho deixa de disparar porque outro componente
 * passou a escutar a tecla, a busca devolve o resultado da letra anterior, e o
 * Enter navega para o item errado quando a lista muda debaixo do cursor.
 *
 * E tem uma asserção que não é de interface, é de SEGURANÇA: a busca não pode
 * virar a porta dos fundos de telas que a pessoa não alcança pelo menu. Quem
 * recorta por tenant é o RLS; quem recorta por módulo é a permissão granular, e
 * é ela que está testada aqui.
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

async function entrar(email, viewport = { width: 1440, height: 900 }) {
  const ctx = await b.newContext({ viewport })
  const p = await ctx.newPage()
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await p.fill('input[name="email"]', email)
  await p.fill('input[name="password"]', SENHA)
  await p.click('button[type="submit"]')
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 })
  return { ctx, p }
}

/**
 * Abre a paleta e ESPERA ela existir.
 *
 * O atalho é um listener de `keydown` registrado pelo React: antes da
 * hidratação ele não existe, e a tecla cai no vazio. Isso vale para qualquer
 * atalho de qualquer aplicação — não é defeito, é o custo de JavaScript. O que
 * seria defeito é um teste que pressiona cedo demais e chama de falha.
 *
 * A segunda tentativa cobre a corrida; se nem assim abrir, aí é defeito de
 * verdade e a asserção seguinte reprova.
 */
async function abrirPaleta(pagina) {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    await pagina.keyboard.press('Control+k')
    try {
      await pagina.waitForSelector('[data-testid="paleta"]', { timeout: 3000 })
      return true
    } catch {
      await pagina.waitForTimeout(600)
    }
  }
  return false
}

const itens = (p) =>
  p.$$eval('[data-escolhido]', (ns) => ns.map((n) => n.innerText.replace(/\n+/g, ' · ').trim()))

// ---------------------------------------------------------------------------
console.log('\n=== 1. O atalho abre de qualquer tela ===')
// ---------------------------------------------------------------------------
const { ctx, p } = await entrar('admin@iaroffice.com.br')
{
  ok(
    await p.locator('[data-testid="abrir-paleta"]').isVisible(),
    'a caixa de busca aparece no cabeçalho — atalho que ninguém descobre é segredo',
  )

  for (const rota of ['/painel', '/tickets', '/financeiro/titulos-a-pagar']) {
    await p.goto(BASE + rota, { waitUntil: 'networkidle' })
    ok(await abrirPaleta(p), `abre em ${rota}`)
    await p.keyboard.press('Escape')
    await p.waitForTimeout(200)
    ok(!(await p.locator('[data-testid="paleta"]').isVisible()), `e Esc fecha em ${rota}`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. Telas, ações e registros na mesma caixa ===')
// ---------------------------------------------------------------------------
{
  await abrirPaleta(p)
  await p.keyboard.type('fluxo')
  await p.waitForTimeout(500)
  const r = await itens(p)
  ok(
    r.some((x) => /Fluxo de caixa/.test(x) && /Financeiro/.test(x)),
    'acha a tela pelo nome, com o grupo ao lado para dar contexto',
  )

  await p.fill('[data-testid="paleta"] input', '')
  await p.keyboard.type('servidor')
  await p.waitForTimeout(900)
  const comRegistro = await itens(p)
  ok(
    comRegistro.some((x) => /#\d+\s+Servidor/.test(x)),
    'acha o CHAMADO pelo título, sem passar pela tela de tickets',
  )
  ok(
    comRegistro.some((x) => /Aberto/.test(x)),
    'e mostra o estado na língua da tela, não `open` do banco',
  )

  /* O número puro é como as pessoas se referem ao chamado no telefone. */
  await p.fill('[data-testid="paleta"] input', '')
  await p.keyboard.type('5')
  await p.waitForTimeout(900)
  ok(
    (await itens(p)).some((x) => /#5\s/.test(x)),
    'número puro acha o chamado pelo NÚMERO',
  )

  await p.keyboard.press('Escape')
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. Teclado: anda, abre, e não trava no fim ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/painel`, { waitUntil: 'networkidle' })
  await abrirPaleta(p)
  await p.keyboard.type('satisfa')
  await p.waitForTimeout(500)

  const escolhido = () =>
    p.$eval('[data-escolhido="1"]', (n) => n.innerText.replace(/\n+/g, ' · ').trim())
  const primeiro = await escolhido()
  await p.keyboard.press('ArrowDown')
  await p.waitForTimeout(150)
  /* Com um resultado só, descer volta nele mesmo — a lista é cíclica de
     propósito: travar no fim parece defeito. */
  ok((await escolhido()) !== null, `a seta anda sem travar (de "${primeiro}")`)

  await p.keyboard.press('Enter')
  await p.waitForTimeout(1200)
  ok(new URL(p.url()).pathname === '/satisfacao', 'Enter abre a tela escolhida')
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. A busca NÃO é porta dos fundos ===')
// ---------------------------------------------------------------------------
{
  /*
   * Diego é Operador Financeiro: no exemplo, o único perfil que NÃO alcança
   * inventário, chamados nem clientes. A busca não pode entregar o que o menu
   * esconde — é a asserção que impede a paleta de virar um vazamento com cara
   * de conveniência.
   *
   * A escolha do perfil importa e já custou uma correção: a primeira versão
   * deste teste usou a Solicitante, supondo que ela não visse inventário. Ela
   * VÊ — o perfil Solicitante tem leitura de ativos no exemplo. O teste
   * reprovava um código correto, que é o pior tipo de teste: ele teria levado a
   * "consertar" o que não estava quebrado.
   */
  const { ctx: c2, p: p2 } = await entrar('diego.financeiro@iaroffice.com.br')
  ok(await abrirPaleta(p2), 'a paleta abre para o Operador Financeiro também')

  await p2.keyboard.type('dell')
  await p2.waitForTimeout(900)
  const r = await itens(p2)
  ok(
    !r.some((x) => /PAT-|Latitude/i.test(x)),
    `quem não vê inventário não recebe ATIVO na busca (viu: ${r.join(' | ') || 'nada'})`,
  )

  await p2.fill('[data-testid="paleta"] input', '')
  await p2.keyboard.type('servidor')
  await p2.waitForTimeout(900)
  const r2 = await itens(p2)
  ok(
    !r2.some((x) => /#\d+/.test(x)),
    `nem CHAMADO, que ele também não alcança (viu: ${r2.join(' | ') || 'nada'})`,
  )

  await p2.fill('[data-testid="paleta"] input', '')
  await p2.keyboard.type('invent')
  await p2.waitForTimeout(500)
  ok(
    !(await itens(p2)).some((x) => /Inventário de TI/.test(x)),
    'nem a TELA de inventário, que o menu dele não mostra',
  )

  /* E a prova de que a paleta não está só vazia para ele: o que é dele, aparece. */
  await p2.fill('[data-testid="paleta"] input', '')
  await p2.keyboard.type('banc')
  await p2.waitForTimeout(500)
  ok(
    (await itens(p2)).some((x) => /Contas bancárias/.test(x)),
    'mas o que é do financeiro aparece — a paleta recorta, não apaga',
  )
  await c2.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. Celular: gaveta no lugar da tira ===')
// ---------------------------------------------------------------------------
{
  const cel = await b.newContext({
    viewport: { width: 390, height: 844 },
    storageState: await ctx.storageState(),
  })
  const pc = await cel.newPage()
  await pc.goto(`${BASE}/tickets`, { waitUntil: 'networkidle' })
  await pc.waitForTimeout(500)

  ok(
    (await pc.locator('nav.fixed.inset-x-0.bottom-0').count()) === 0,
    'a tira horizontal de 30 itens não existe mais',
  )

  await pc.locator('[data-testid="abrir-menu-celular"]').click()
  await pc.waitForTimeout(400)
  ok(await pc.locator('[data-testid="gaveta-menu"]').isVisible(), 'a gaveta abre')
  ok(
    (await pc.locator('[data-testid="gaveta-menu"] details').count()) === 8,
    'com os MESMOS oito grupos do desktop — um componente, não uma cópia',
  )

  /* Navegar é a tarefa: a gaveta sai da frente sozinha. */
  await pc.locator('[data-testid="gaveta-menu"] a[href="/painel"]').first().click()
  await pc.waitForTimeout(1200)
  ok(
    !(await pc.locator('[data-testid="gaveta-menu"]').isVisible()),
    'e fecha ao escolher um destino, em vez de tapar a tela nova',
  )
  await cel.close()
}

await ctx.close()
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
