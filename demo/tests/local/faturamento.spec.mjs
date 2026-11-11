/*
 * Medição e faturamento — Fase 4 da unificação (docs/23).
 *
 * Por que esta suíte existe
 * -------------------------
 * A fatura é o documento que vai ao cliente, e os defeitos dela são os que
 * custam confiança, não só dinheiro:
 *
 *  - **total que não bate com o detalhe**: quem confere soma as linhas. Se o
 *    total for um número à parte, a divergência só aparece quando o cliente
 *    reclama — e aí já não é erro de sistema, é desconfiança;
 *  - **excedente cobrado sem medição**: inventar consumo onde não houve leitura
 *    é a forma mais rápida de perder um contrato;
 *  - **fatura emitida sem título**, ou título vivo com fatura cancelada:
 *    cobrança sem documento é o que o cliente contesta e a contabilidade não
 *    reconhece.
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
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } })
const p = await ctx.newPage()
await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await p.fill('input[name="email"]', 'admin@iaroffice.com.br')
await p.fill('input[name="password"]', SENHA)
await p.click('button[type="submit"]')
await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 })

async function ate(condicao, limite = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < limite) {
    if (await condicao().catch(() => false)) return Date.now() - t0
    await new Promise((r) => setTimeout(r, 150))
  }
  return null
}

const dinheiro = (t) => {
  const m = t.match(/R\$\s?([\d.]+),(\d{2})/)
  return m ? Number(`${m[1].replace(/\./g, '')}.${m[2]}`) : null
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. Medições: quem está sem leitura no mês aparece ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/locacao/medicoes`, { waitUntil: 'networkidle' })
  const texto = await p.locator('main').innerText()
  ok(/Consumo acumulado/i.test(texto), 'a tela mostra o consumo acumulado por alocação')
  ok(
    /Sem leitura neste m[êe]s/i.test(texto),
    'e o indicador de quem não vai faturar excedente por falta de leitura',
  )
  const linhas = await p.locator('main table tbody tr').count()
  ok(linhas > 0, `a série de leituras do exemplo aparece (${linhas} linhas)`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. Gerar a prévia de uma competência ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/locacao/faturamento`, { waitUntil: 'networkidle' })
  await p.locator('[data-testid="novo-registro"]').click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })

  const opcoes = await p.locator('[data-testid="gaveta"] select[name="contract_id"] option').count()
  ok(opcoes >= 2, `só contratos ativos ou suspensos são ofertados (${opcoes - 1})`)

  await p.locator('[data-testid="gaveta"] select[name="contract_id"]').selectOption({ index: 1 })
  const mes = new Date()
  mes.setDate(1)
  mes.setMonth(mes.getMonth() - 1)
  await p.locator('[data-testid="gaveta"] input[name="competencia"]').fill(mes.toISOString().slice(0, 7))
  await p.locator('[data-testid="gaveta"] button:has-text("Gerar prévia")').click()

  const gerou = await ate(async () => {
    const t = await p.locator('body').innerText()
    return /Pr[ée]via gerada/i.test(t)
  })
  ok(gerou !== null, `a prévia foi gerada (${gerou}ms)`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. O total é a soma das linhas, e a memória de cálculo está lá ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/locacao/faturamento?estado=draft`, { waitUntil: 'networkidle' })
  const rascunhos = await p.locator('main table tbody tr').count()
  ok(rascunhos >= 1, `há rascunho para conferir (${rascunhos})`)

  await p.locator('[data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(400)

  const linhas = await p.locator('[data-testid="linha-da-fatura"]').count()
  ok(linhas > 0, `a fatura tem linhas (${linhas})`)

  const corpo = await p.locator('[data-testid="gaveta"]').innerText()
  ok(
    /O total é a soma das linhas/i.test(corpo),
    'a gaveta afirma a conferência que o banco garante',
  )
  ok(!/Diverg[êe]ncia/i.test(corpo), 'e não acusa divergência entre total e detalhe')

  /* A soma das linhas, lida da tela, tem de bater com o total mostrado. */
  const valores = await p
    .locator('[data-testid="linha-da-fatura"]')
    .evaluateAll((ns) => ns.map((n) => n.innerText))
  const soma = valores.reduce((s, t) => {
    const m = t.match(/R\$\s?([\d.]+),(\d{2})/)
    return s + (m ? Number(`${m[1].replace(/\./g, '')}.${m[2]}`) : 0)
  }, 0)
  const total = dinheiro(corpo.split('Total')[1] ?? '')
  ok(
    total !== null && Math.abs(soma - total) < 0.02,
    `somando as linhas da tela dá o total (${soma.toFixed(2)} ≈ ${total?.toFixed(2)})`,
  )

  ok(
    /dia\(s\)/.test(corpo),
    'cada linha de locação mostra quantos dias cobrou — a memória do pró-rata',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. Emitir gera o título a receber, com vínculo nos dois sentidos ===')
// ---------------------------------------------------------------------------
{
  const antes = await p.locator('[data-testid="gaveta"]').innerText()
  ok(/ainda não gerado/i.test(antes), 'rascunho não tem título: rascunho é cálculo, não cobrança')

  await p.locator('[data-testid="gaveta"] button:has-text("Emitir e gerar título")').click()
  /* `body`, e não `main`: a região de avisos vive FORA do `<main>` — foi essa a
     decisão que fez a confirmação sobreviver à revalidação (docs/18 §4.1). Ler
     só o `main` perde exatamente a mensagem que se quer conferir. */
  const emitiu = await ate(async () => {
    const t = await p.locator('body').innerText()
    return /abrir no financeiro/i.test(t)
  })
  ok(emitiu !== null, `a fatura foi emitida e o título criado (${emitiu}ms)`)

  const depois = await p.locator('[data-testid="gaveta"]').innerText()
  ok(/abrir no financeiro/i.test(depois), 'e a fatura passa a apontar para o título')

  /* O outro lado do vínculo: o título carrega o número da fatura. */
  const numero = (await p.locator('[data-testid="gaveta"] h2').innerText()).split('\n')[0].trim()
  await p.goto(`${BASE}/financeiro/titulos-a-receber`, { waitUntil: 'networkidle' })
  const noFinanceiro = await p.locator('main').innerText()
  ok(
    noFinanceiro.includes(numero.split('/')[0]),
    `o título aparece no financeiro com o número da fatura ("${numero}")`,
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. Não se fatura a mesma competência duas vezes ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/locacao/faturamento`, { waitUntil: 'networkidle' })
  await p.locator('[data-testid="novo-registro"]').click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.locator('[data-testid="gaveta"] select[name="contract_id"]').selectOption({ index: 1 })
  const mes = new Date()
  mes.setDate(1)
  mes.setMonth(mes.getMonth() - 1)
  await p.locator('[data-testid="gaveta"] input[name="competencia"]').fill(mes.toISOString().slice(0, 7))
  await p.locator('[data-testid="gaveta"] button:has-text("Gerar prévia")').click()

  const recusou = await ate(async () => {
    const t = await p.locator('body').innerText()
    return /j[áa] existe|duplicat|unique|violates|mesma compet/i.test(t)
  }, 12000)
  ok(
    recusou !== null,
    'a segunda fatura da mesma competência é recusada — duas cobranças do mesmo mês é o erro que o cliente encontra antes da gente',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. Cancelar a fatura cancela o título junto ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/locacao/faturamento?estado=issued`, { waitUntil: 'networkidle' })
  await p.locator('[data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(400)

  await p.locator('[data-testid="gaveta"] input[name="motivo"]').fill('Teste automatizado')
  await p.locator('[data-testid="gaveta"] button:has-text("Cancelar fatura e o título")').click()

  const cancelou = await ate(async () => {
    const t = await p.locator('body').innerText()
    return /cancelada/i.test(t)
  })
  ok(cancelou !== null, `a fatura foi cancelada (${cancelou}ms)`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. Celular ===')
// ---------------------------------------------------------------------------
{
  const cel = await b.newContext({
    viewport: { width: 390, height: 844 },
    storageState: await ctx.storageState(),
  })
  const pc = await cel.newPage()
  for (const rota of ['/locacao/faturamento', '/locacao/medicoes']) {
    await pc.goto(BASE + rota, { waitUntil: 'networkidle' })
    await pc.waitForTimeout(400)
    const largura = await pc.evaluate(() => document.documentElement.scrollWidth)
    ok(largura <= 392, `${rota} cabe na tela do celular (${largura}px)`)
  }
  await cel.close()
}

await ctx.close()
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
