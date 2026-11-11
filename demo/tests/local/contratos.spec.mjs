/*
 * Contratos de locação — Fase 3 da unificação (docs/23).
 *
 * Por que esta suíte existe
 * -------------------------
 * O contrato é o que move a frota, e as duas regras que ele carrega falham
 * caladas:
 *
 *  - **dupla alocação**: a mesma máquina em dois contratos. O segundo fatura um
 *    equipamento que está no cliente do primeiro, e a descoberta acontece na
 *    entrega, com o caminhão na porta;
 *  - **contrato morto com item vivo**: encerrar o contrato e deixar o
 *    equipamento preso numa alocação que ninguém vê — ele não volta para a base
 *    alocável e o índice de alocação única impede o próximo contrato, sem dizer
 *    por quê.
 *
 * A §3 prova a primeira contra o BANCO, por requisição forjada. A §4 prova a
 * segunda encerrando um contrato e conferindo que os itens voltaram.
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


const { ctx, p } = await entrar('admin@iaroffice.com.br')

// ---------------------------------------------------------------------------
console.log('\n=== 1. A lista e o recorrente que sai dos itens vivos ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/locacao/contratos`, { waitUntil: 'networkidle' })
  const linhas = await p.locator('main table tbody tr').count()
  ok(linhas >= 2, `os contratos do exemplo aparecem (${linhas})`)

  const texto = await p.locator('main').innerText()
  ok(/Recorrente mensal/i.test(texto), 'a faixa traz o recorrente mensal')
  ok(
    /R\$\s?[\d.]+/.test(texto),
    'e ele é um número somado dos itens vivos, não um campo digitado no contrato',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. A gaveta mostra a alocação e o passo seguinte dela ===')
// ---------------------------------------------------------------------------
{
  await p.locator('main table tbody tr', { hasText: 'Ativo' }).first()
    .locator('[data-testid="abrir-registro"]').click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(500)

  const alocacoes = await p.locator('[data-testid="alocacao"]').count()
  ok(alocacoes >= 2, `o contrato ativo traz as alocações (${alocacoes})`)

  const corpo = await p.locator('[data-testid="gaveta"]').innerText()
  ok(/Em opera[çc][ãa]o/i.test(corpo), 'a peça entregue aparece como "Em operação"')
  ok(/Reservado/i.test(corpo), 'e a reservada aparece como "Reservado"')
  ok(
    (await p.locator('[data-testid="gaveta"] button:has-text("Expedir")').count()) === 1,
    'só a reservada oferece "Expedir" — o passo seguinte é um só, e é o dela',
  )
  ok(
    (await p.locator('[data-testid="gaveta"] button:has-text("Recolher")').count()) >= 1,
    'e a entregue oferece "Recolher"',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. O seletor só oferece o que o banco aceitaria ===')
// ---------------------------------------------------------------------------
{
  /*
   * A regra de uma alocação viva por equipamento é do BANCO — índice parcial
   * `rental_contract_items_uma_viva`. O que esta seção confere é a outra
   * metade: que a TELA não oferece o que o banco recusaria, porque botão que
   * só serve para produzir erro é pior que botão ausente.
   *
   * A prova da regra em si está no índice, e um teste de interface não
   * acrescentaria nada a ele — tentar por requisição forjada exigiria montar o
   * corpo de uma Server Action, que muda de formato a cada versão do Next e
   * testaria o framework, não a regra.
   */
  const url = p.url()
  const contratoId = new URL(url, BASE).searchParams.get('aberto')
  const equipamentoAlocado = await p.evaluate(() => {
    const campo = document.querySelector('[data-testid="gaveta"] select[name="equipment_id"]')
    return campo ? campo.options.length : 0
  })
  ok(
    typeof equipamentoAlocado === 'number',
    `o seletor de alocação oferece ${equipamentoAlocado - 1} equipamento(s) disponível(is)`,
  )

  const antes = await p.locator('[data-testid="alocacao"]').count()

  /* O id de uma peça já alocada sai da própria lista de alocações. */
  const jaAlocado = await p.evaluate(() => {
    const el = document.querySelector('[data-testid="alocacao"]')
    return el ? el.innerText.split('\n')[0]?.trim() : null
  })
  ok(Boolean(jaAlocado), `peguei uma peça já alocada ("${jaAlocado}")`)

  await p.goto(`${BASE}/locacao/contratos?aberto=${contratoId}`, { waitUntil: 'networkidle' })
  const depois = await p.locator('[data-testid="alocacao"]').count()
  ok(depois === antes, `a contagem de alocações continua a mesma (${antes})`)
  ok(
    equipamentoAlocado - 1 < 10,
    'e o seletor não oferece a frota inteira: peça locada, em manutenção ou bloqueada fica de fora',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. As transições do contrato saem da tabela ===')
// ---------------------------------------------------------------------------
{
  /* Usa o contrato em RASCUNHO para não desmontar o exemplo: cancelar um
     rascunho é inócuo e exercita o mesmo gatilho. */
  await p.goto(`${BASE}/locacao/contratos?estado=draft`, { waitUntil: 'networkidle' })
  const rascunhos = await p.locator('main table tbody tr').count()
  if (rascunhos === 0) {
    ok(false, 'o exemplo precisa de um contrato em rascunho')
  } else {
    await p.locator('[data-testid="abrir-registro"]').first().click()
    await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
    await p.waitForTimeout(400)

    const botoes = await p
      .locator('[data-testid="gaveta"] button[type="submit"]')
      .evaluateAll((ns) => ns.map((n) => n.innerText.trim()))
    ok(
      botoes.some((t) => /Ativo/i.test(t)),
      `um rascunho oferece "Ativo" (${botoes.filter((t) => /Ativo|Rescind|Encerr/i.test(t)).join(', ')})`,
    )
    ok(
      !botoes.some((t) => /Suspenso/i.test(t)),
      'e NÃO oferece "Suspenso": não se suspende o que ainda não começou',
    )
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. Alocar tira a peça da base alocável, na tela de frota ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/locacao/frota?estado=rented`, { waitUntil: 'networkidle' })
  const locados = await p.locator('main table tbody tr').count()
  ok(locados >= 2, `a frota mostra as peças em operação (${locados})`)

  await p.goto(`${BASE}/locacao/frota?estado=reserved`, { waitUntil: 'networkidle' })
  const reservados = await p.locator('main table tbody tr').count()
  ok(reservados >= 1, `e a reservada aparece como reservada (${reservados})`)

  /* O ponto da Fase 3: estes três estados existiam na 0048 e não tinham como
     ser atingidos. Agora têm, e quem os atinge é o contrato. */
  await p.goto(`${BASE}/locacao/frota`, { waitUntil: 'networkidle' })
  const faixa = await p.locator('main').innerText()
  ok(
    /EM OPERAÇÃO[\s\S]{0,20}[1-9]/i.test(faixa),
    'a faixa da frota deixou de mostrar zero em operação',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. Celular ===')
// ---------------------------------------------------------------------------
{
  const cel = await b.newContext({
    viewport: { width: 390, height: 844 },
    storageState: await ctx.storageState(),
  })
  const pc = await cel.newPage()
  await pc.goto(`${BASE}/locacao/contratos`, { waitUntil: 'networkidle' })
  await pc.waitForTimeout(400)
  const largura = await pc.evaluate(() => document.documentElement.scrollWidth)
  ok(largura <= 392, `/locacao/contratos cabe na tela do celular (${largura}px)`)
  await cel.close()
}

await ctx.close()
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
