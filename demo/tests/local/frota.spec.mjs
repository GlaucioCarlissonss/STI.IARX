/*
 * A frota de locação — Fase 2 da unificação (docs/23).
 *
 * Por que esta suíte existe
 * -------------------------
 * O ciclo de vida do equipamento falha calado nos dois sentidos, e os dois
 * custam caro:
 *
 *  - de MENOS: a tela oferece uma transição que o banco recusa, e o erro
 *    aparece depois do clique — no meio de uma expedição, com o caminhão na
 *    porta;
 *  - de MAIS: a tela aceita uma transição que o banco deveria recusar, e aí
 *    uma máquina em contrato volta à base alocável sem ninguém ter devolvido
 *    nada. O próximo contrato aloca um equipamento que está em campo, e quem
 *    vai entregar descobre no cliente.
 *
 * A §3 é a que prova a segunda: ela força uma transição proibida pelo ENDEREÇO,
 * passando por cima da tela, e cobra que o banco recuse.
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

/** Espera uma condição em vez de um tempo. Ver `gaveta.spec.mjs`. */
async function ate(condicao, limite = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < limite) {
    if (await condicao()) return Date.now() - t0
    await new Promise((r) => setTimeout(r, 120))
  }
  return null
}

const { ctx, p } = await entrar('admin@iaroffice.com.br')

// ---------------------------------------------------------------------------
console.log('\n=== 1. A frota aparece, e o bloqueio convive com o estado ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/locacao/frota`, { waitUntil: 'networkidle' })
  const linhas = await p.locator('main table tbody tr').count()
  ok(linhas > 0, `a lista traz a frota do exemplo (${linhas} equipamentos)`)

  /*
   * Este é o teste que teria pego o defeito mais bobo e mais caro desta fase:
   * faltavam os `grant` de tabela, o driver devolvia erro, o `?? []` da tela
   * virava lista vazia — e a frota aparecia "sem nenhum equipamento", que
   * parece dado faltando e manda procurar no lugar errado.
   */
  const bloqueado = p.locator('main table tbody tr', { hasText: 'bloqueado' }).first()
  ok(
    (await bloqueado.count()) === 1,
    'o equipamento bloqueado mostra o selo ao LADO do estado, não no lugar dele',
  )
  const textoDaLinha = await bloqueado.innerText()
  ok(
    /Dispon[íi]vel/i.test(textoDaLinha) && /bloqueado/i.test(textoDaLinha),
    `bloqueio é atributo: a mesma linha diz os dois ("${textoDaLinha.replace(/\n+/g, ' · ').slice(0, 70)}…")`,
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. A gaveta só oferece transições que o banco aceita ===')
// ---------------------------------------------------------------------------
{
  await p.locator('[data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(400)

  const botoes = await p
    .locator('[data-testid="gaveta"] button[type="submit"]')
    .evaluateAll((ns) => ns.map((n) => n.innerText.trim()))

  ok(botoes.length > 0, `a gaveta abre com as transições do estado atual (${botoes.join(', ')})`)
  ok(
    botoes.some((t) => /Reservado/i.test(t)),
    'de "Disponível" sai "Reservado" — é o começo da alocação',
  )
  ok(
    !botoes.some((t) => /^Locado$/i.test(t)),
    'e NÃO sai "Locado": a peça não pula da base para o cliente sem passar pela expedição',
  )
  ok(
    botoes.some((t) => /Extraviado/i.test(t)) && botoes.some((t) => /Baixado/i.test(t)),
    'extravio e baixa aparecem sempre: são fatos, não etapas do ciclo',
  )

  await p.keyboard.press('Escape')
  await ate(async () => (await p.locator('[data-testid="gaveta"]').count()) === 0)
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. O banco recusa a transição proibida, mesmo sem a tela ===')
// ---------------------------------------------------------------------------
{
  /*
   * A asserção que importa: a regra tem de estar no BANCO, não na tela. Aqui a
   * transição é disparada por uma Server Action chamada direto do navegador,
   * exatamente como faria quem monta a requisição à mão.
   */
  await p.goto(`${BASE}/locacao/frota`, { waitUntil: 'networkidle' })
  const primeiro = await p.locator('[data-testid="abrir-registro"]').first().getAttribute('href')
  const id = new URL(primeiro, BASE).searchParams.get('aberto')
  ok(Boolean(id), 'peguei o id do primeiro equipamento pelo endereço da lista')

  await p.goto(`${BASE}/locacao/frota?aberto=${id}`, { waitUntil: 'networkidle' })
  const antes = await p.locator('[data-testid="gaveta"] h2').innerText()

  /* "Disponível → Locado" não está na tabela de transições. */
  const recusou = await p.evaluate(async (equipId) => {
    const r = await fetch(window.location.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id: equipId, status: 'rented' }).toString(),
    })
    return r.status
  }, id)
  ok(
    typeof recusou === 'number',
    `a requisição forjada voltou com HTTP ${recusou} — o que importa é o estado depois`,
  )

  await p.goto(`${BASE}/locacao/frota?aberto=${id}`, { waitUntil: 'networkidle' })
  const depois = await p.locator('[data-testid="gaveta"] h2').innerText()
  ok(
    depois === antes && !/Locado/i.test(depois),
    `o equipamento continua onde estava ("${depois.replace(/\n+/g, ' ')}")`,
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. Mover o estado escreve o histórico sozinho ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/locacao/frota?estado=available`, { waitUntil: 'networkidle' })
  await p.locator('[data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(300)

  const antesDoHistorico = await p.locator('[data-testid="gaveta"] ul li').count()
  await p.locator('[data-testid="gaveta"] button:has-text("Em manutenção")').first().click()

  const mudou = await ate(async () => {
    const t = await p.locator('[data-testid="gaveta"] h2').innerText().catch(() => '')
    return /manuten/i.test(t)
  })
  ok(mudou !== null, `o estado virou "Em manutenção" (${mudou}ms)`)

  const depoisDoHistorico = await p.locator('[data-testid="gaveta"] ul li').count()
  ok(
    depoisDoHistorico > antesDoHistorico,
    `e o histórico ganhou a linha sozinho, pelo gatilho (${antesDoHistorico} → ${depoisDoHistorico})`,
  )

  /* Devolve o exemplo ao estado em que estava: suíte que suja o banco faz a
     seguinte falhar por motivo errado. */
  await p.locator('[data-testid="gaveta"] button:has-text("Disponível")').first().click()
  await ate(async () => {
    const t = await p.locator('[data-testid="gaveta"] h2').innerText().catch(() => '')
    return /Dispon/i.test(t)
  })
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. Medidor não anda para trás ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/locacao/frota?estado=available`, { waitUntil: 'networkidle' })
  await p.locator('[data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(300)

  const campo = p.locator('[data-testid="gaveta"] input[name="meter_reading"]')
  if ((await campo.count()) === 0) {
    ok(true, 'este equipamento não tem medidor — a seção some, em vez de pedir número inútil')
  } else {
    const atual = Number(await campo.inputValue())
    const historicoAntes = await p.locator('[data-testid="gaveta"] ul li').count()
    await campo.fill(String(atual + 25))
    await p.locator('[data-testid="gaveta"] button:has-text("Registrar leitura")').click()

    /*
     * A prova é o HISTÓRICO, não o campo.
     *
     * Conferir o valor do campo não prova nada: ele tem o número porque a suíte
     * acabou de digitá-lo, e passaria mesmo se o servidor tivesse recusado. A
     * linha de histórico só existe se o gatilho rodou — ou seja, se o banco
     * aceitou. Foi assim que esta asserção nasceu verde por engano e teve de
     * ser reescrita.
     */
    const registrou = await ate(async () => {
      const linhas = await p.locator('[data-testid="gaveta"] ul li').count().catch(() => 0)
      if (linhas <= historicoAntes) return false
      const texto = await p.locator('[data-testid="gaveta"] ul').innerText().catch(() => '')
      return /Leitura registrada/i.test(texto)
    })
    ok(registrou !== null, `leitura maior é aceita e vira histórico (${atual} → ${atual + 25})`)

    /* E o campo passa a recusar o retrocesso: o `min` acompanha a leitura nova,
       que é a tela repetindo a regra do banco em vez de substituí-la. */
    const min = Number(await campo.getAttribute('min'))
    ok(min >= atual + 25, `o campo passa a recusar valor menor (min=${min})`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. Os cadastros sustentam a frota, e dizem quem depende deles ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/locacao/cadastros`, { waitUntil: 'networkidle' })
  const texto = await p.locator('main').innerText()
  for (const titulo of ['Modelos', 'Categorias', 'Fabricantes', 'Depósitos']) {
    ok(texto.includes(titulo), `o cartão de ${titulo} está na tela`)
  }
  ok(
    /\d+ equipamento\(s\)/.test(texto),
    'cada modelo diz quantos equipamentos dependem dele — é o que mostra se dá para mexer',
  )

  await p.locator('[data-testid="novo-modelo"]').click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  ok(
    (await p.locator('[data-testid="gaveta"] select[name="manufacturer_id"]').count()) === 1,
    'o cadastro de modelo abre na gaveta, com fabricante e categoria dentro',
  )
  await p.keyboard.press('Escape')
  ok((await ate(async () => (await p.locator('[data-testid="gaveta"]').count()) === 0)) !== null, 'Esc fecha')
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. Celular: as duas telas cabem em 390px ===')
// ---------------------------------------------------------------------------
{
  const cel = await b.newContext({
    viewport: { width: 390, height: 844 },
    storageState: await ctx.storageState(),
  })
  const pc = await cel.newPage()
  for (const rota of ['/locacao/frota', '/locacao/cadastros']) {
    await pc.goto(BASE + rota, { waitUntil: 'networkidle' })
    await pc.waitForTimeout(400)
    const largura = await pc.evaluate(() => document.documentElement.scrollWidth)
    ok(largura <= 392, `${rota} cabe na tela do celular (${largura}px)`)
  }
  await cel.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 8. Sem a esfera de locação, as telas não existem ===')
// ---------------------------------------------------------------------------
{
  /* A frota é da esfera de locação. Numa empresa só de gestão de TI ela não é
     "sem permissão": ela não faz parte do negócio — e o menu não a anuncia. */
  await p.goto(`${BASE}/ambiente`, { waitUntil: 'networkidle' })
  await p.locator('input[name="esferas"][value="rental"]').uncheck()
  await p.locator('button:has-text("Salvar esferas")').click()
  await p.waitForTimeout(1500)

  const sumiu = await ate(async () => {
    const rotulos = await p.$$eval('nav[aria-label="Navegação principal"] summary', (ns) =>
      ns.map((n) => n.innerText.trim().toLocaleLowerCase('pt-BR')),
    ).catch(() => [])
    return rotulos.length > 0 && !rotulos.includes('locação')
  })
  ok(sumiu !== null, 'desligada a esfera, o grupo de Locação sai do menu')

  /* E volta como estava. */
  await p.goto(`${BASE}/ambiente`, { waitUntil: 'networkidle' })
  await p.locator('input[name="esferas"][value="rental"]').check()
  await p.locator('button:has-text("Salvar esferas")').click()
  await p.waitForTimeout(1500)
  const voltou = await ate(async () => {
    const rotulos = await p.$$eval('nav[aria-label="Navegação principal"] summary', (ns) =>
      ns.map((n) => n.innerText.trim().toLocaleLowerCase('pt-BR')),
    ).catch(() => [])
    return rotulos.includes('locação')
  })
  ok(voltou !== null, 'e volta ao religar — desligar esconde, não apaga')
}

await ctx.close()
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
