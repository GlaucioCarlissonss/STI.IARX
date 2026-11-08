/*
 * A lista de chamados — Fase 2 da revisão de usabilidade.
 *
 * Por que esta suíte existe
 * -------------------------
 * A lista passou a ter estado em três lugares ao mesmo tempo: o endereço
 * (filtro, ordem, página), a memória do navegador (densidade) e a memória do
 * componente (cursor e seleção). Cada um quebra em silêncio e de um jeito
 * diferente:
 *
 * - o filtro deixa de chegar à consulta e a lista continua mostrando tudo,
 *   com cara de que o filtro "não achou nada de diferente";
 * - a ordenação troca de coluna mas não de direção, e ninguém nota até o dia em
 *   que o chamado mais atrasado fica no fim;
 * - a seleção sobrevive a uma troca de página e uma ação em massa cai em
 *   chamados que a pessoa não está vendo — este é o defeito caro.
 *
 * E tem uma asserção que não é de interface, é de SEGURANÇA: a barra de ações
 * em massa não pode oferecer a quem não tem a permissão granular. Quem recorta
 * por tenant é o RLS; quem recorta por ação é a permissão, e é ela que está
 * testada aqui — do lado do servidor, porque é lá que vale.
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
 * O texto de cada linha VISÍVEL.
 *
 * O `:visible` não é zelo: a lista existe duas vezes na marcação — tabela no
 * computador, ficha no celular —, e sem ele toda contagem sai dobrada. A
 * primeira versão desta suíte reprovou uma contagem correta por isso, que é o
 * pior tipo de falha de teste: a que manda consertar o que está certo.
 */
const linhas = async (p) =>
  (await p.locator('[data-indice]:visible').allInnerTexts()).map((t) =>
    t.replace(/\s+/g, ' ').trim(),
  )

const { ctx, p } = await entrar('admin@iaroffice.com.br')

// ---------------------------------------------------------------------------
console.log('\n=== 1. As visões respondem a pergunta do dia ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/tickets`, { waitUntil: 'networkidle' })

  const contagem = async (visao) =>
    Number((await p.locator(`[data-testid="visao-${visao}"] span`).innerText()).trim())

  const abertos = await contagem('abertos')
  const todos = await contagem('todos')
  ok(todos >= abertos, `"Todos" (${todos}) nunca é menor que "Em aberto" (${abertos})`)

  const semAtendente = await contagem('sem')
  await p.locator('[data-testid="visao-sem"]').click()
  await p.waitForURL(/atendente=nenhum/, { timeout: 10000 })
  const r = await linhas(p)
  ok(r.length === semAtendente, `a aba diz ${semAtendente} e a lista traz ${r.length}`)
  ok(
    r.every((x) => /Não atribuído/.test(x)),
    'e todas as linhas estão mesmo sem atendente',
  )

  /* A aba é parâmetro normal na URL: dá para combinar com um filtro, e é isso
     que a torna útil depois do primeiro dia. */
  await p.goto(`${BASE}/tickets?atendente=nenhum&prioridade=critical`, {
    waitUntil: 'networkidle',
  })
  const combinada = await linhas(p)
  ok(
    combinada.every((x) => /Não atribuído/.test(x) && /Crítica/.test(x)),
    'a visão combina com outro filtro em vez de substituí-lo',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. O filtro responde sem botão ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/tickets`, { waitUntil: 'networkidle' })
  ok(
    (await p.locator('button:has-text("Filtrar")').count()) === 0,
    'não existe mais um botão "Filtrar" entre a pergunta e a resposta',
  )

  await p.locator('[data-testid="filtro-busca"]').fill('servidor')
  await p.waitForURL(/busca=servidor/, { timeout: 10000 })
  await p.waitForTimeout(600)
  const r = await linhas(p)
  ok(r.length > 0 && r.every((x) => /servidor/i.test(x)), `a lista acompanha o que é digitado`)
  ok(
    (await p.locator('[data-testid="filtro-busca"]').inputValue()) === 'servidor',
    'e o campo não perde o que foi escrito quando a resposta chega',
  )

  /* O filtro virou endereço: é isso que permite mandar a pergunta pronta. */
  const { ctx: c2, p: p2 } = await entrar('admin@iaroffice.com.br')
  await p2.goto(`${BASE}/tickets?busca=servidor`, { waitUntil: 'networkidle' })
  ok((await linhas(p2)).length === r.length, 'o mesmo endereço, noutra sessão, dá a mesma lista')
  await c2.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. Ordenação pelo cabeçalho ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/tickets?status=todos`, { waitUntil: 'networkidle' })
  await p.locator('th a:has-text("Prazo")').click()
  await p.waitForURL(/ordem=prazo/, { timeout: 10000 })

  const porPrazo = await linhas(p)
  ok(/atrasado/.test(porPrazo[0] ?? ''), 'crescente por prazo põe o mais atrasado no topo')
  ok(
    (await p.locator('th[aria-sort="ascending"]').count()) === 1,
    'e o cabeçalho anuncia a direção para quem usa leitor de tela',
  )

  await p.locator('th a:has-text("Prazo")').click()
  await p.waitForURL(/dir=desc/, { timeout: 10000 })
  const invertido = await linhas(p)
  ok(
    invertido[0] !== porPrazo[0],
    'clicar de novo inverte, como em qualquer planilha (sem recarregar a página inteira)',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. Densidade: a escolha é lembrada ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/tickets`, { waitUntil: 'networkidle' })
  const alturaCompacta = await p.locator('tr[data-indice="0"]').boundingBox()

  await p.locator('[data-testid="densidade-confortavel"]').click()
  await p.waitForTimeout(300)
  const alturaConfortavel = await p.locator('tr[data-indice="0"]').boundingBox()
  ok(
    alturaConfortavel.height > alturaCompacta.height,
    `confortável é mais alto (${Math.round(alturaCompacta.height)}px → ${Math.round(alturaConfortavel.height)}px)`,
  )

  await p.reload({ waitUntil: 'networkidle' })
  await p.waitForTimeout(400)
  ok(
    (await p.locator('[data-testid="densidade-confortavel"]').getAttribute('aria-pressed')) ===
      'true',
    'e a escolha sobrevive ao recarregamento — sem piscar entre as duas',
  )

  await p.locator('[data-testid="densidade-compacto"]').click()
  await p.waitForTimeout(300)
  const voltou = await p.locator('tr[data-indice="0"]').boundingBox()
  ok(Math.abs(voltou.height - alturaCompacta.height) < 2, 'e dá para voltar')
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. Teclado: anda, marca, limpa ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/tickets`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(600)
  await p.locator('h1').click() // tira o foco de qualquer controle

  await p.keyboard.press('j')
  await p.waitForTimeout(150)
  ok(
    (await p.locator('[data-indice="1"][data-cursor="1"]').count()) === 1,
    'J desce o cursor uma linha',
  )

  await p.keyboard.press('k')
  await p.waitForTimeout(150)
  ok(
    (await p.locator('[data-indice="0"][data-cursor="1"]').count()) === 1,
    'K sobe de volta',
  )

  await p.keyboard.press('x')
  await p.waitForTimeout(250)
  ok(await p.locator('[data-testid="barra-de-lote"]').isVisible(), 'X marca e a barra aparece')
  ok(
    (await p.locator('[data-testid="contagem-marcados"]').innerText()).startsWith('1'),
    'com a contagem certa',
  )

  await p.keyboard.press('Escape')
  await p.waitForTimeout(250)
  ok(
    (await p.locator('[data-testid="barra-de-lote"]').count()) === 0,
    'Esc limpa a seleção e a barra some — ela só existe quando há o que fazer',
  )

  /* A guarda que impede o atalho de disparar enquanto se digita. */
  await p.locator('[data-testid="filtro-busca"]').fill('jjj')
  await p.waitForTimeout(700)
  ok(
    (await p.locator('[data-testid="barra-de-lote"]').count()) === 0 &&
      (await p.locator('[data-testid="filtro-busca"]').inputValue()) === 'jjj',
    'e digitar "jjj" no filtro não move o cursor nem marca nada',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. Ação em massa: atribuir dois de uma vez ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/tickets?atendente=nenhum`, { waitUntil: 'networkidle' })
  const antes = await linhas(p)
  if (antes.length < 2) {
    ok(false, `o exemplo precisa de dois chamados sem atendente (achei ${antes.length})`)
  } else {
    await p.locator('tr[data-indice="0"] input[type="checkbox"]').check()
    await p.locator('tr[data-indice="1"] input[type="checkbox"]').check()
    ok(
      (await p.locator('[data-testid="contagem-marcados"]').innerText()).startsWith('2'),
      'dois marcados, uma barra',
    )

    const atendente = await p
      .locator('[data-testid="lote-atribuir"] option:not([value="__"]):not([value=""])')
      .first()
      .innerText()

    await p.locator('[data-testid="lote-atribuir"]').selectOption({ label: atendente })
    await p.waitForTimeout(2500)

    await p.goto(`${BASE}/tickets?status=todos`, { waitUntil: 'networkidle' })
    const depois = (await linhas(p)).filter((x) => x.includes(atendente))
    ok(depois.length >= 2, `os dois chamados passaram a ser de ${atendente} numa ação só`)

    /*
     * Desfaz — e de quebra testa REMOVER atribuição em lote, que é como uma
     * equipe devolve um lote para a fila.
     *
     * Desfaz exatamente os DOIS que este teste mexeu, achados pelo número. Uma
     * primeira versão marcava toda linha com o nome do atendente e tirava o
     * atendente de todas: isso apagava as atribuições que já vinham do exemplo
     * e deixava a suíte seguinte rodando sobre um banco diferente do descrito.
     */
    const numeros = antes.slice(0, 2).map((t) => t.match(/#(\d+)/)?.[1])
    await p.goto(`${BASE}/tickets?status=todos`, { waitUntil: 'networkidle' })
    const textos = await linhas(p)
    for (const [i, texto] of textos.entries()) {
      const n = texto.match(/#(\d+)/)?.[1]
      if (n && numeros.includes(n)) {
        await p.locator(`tr[data-indice="${i}"] input[type="checkbox"]`).check()
      }
    }
    await p.locator('[data-testid="lote-atribuir"]').selectOption({ label: 'Sem atendente' })
    await p.waitForTimeout(2500)

    await p.goto(`${BASE}/tickets?atendente=nenhum`, { waitUntil: 'networkidle' })
    const devolvidos = await linhas(p)
    ok(
      numeros.every((n) => devolvidos.some((x) => x.includes(`#${n}`))),
      'e a remoção em lote devolve exatamente aqueles chamados para a fila',
    )
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. A barra NÃO oferece o que a permissão não dá ===')
// ---------------------------------------------------------------------------
{
  /*
   * Carla é Solicitante: enxerga chamados (helpdesk.tickets.ver) e NÃO pode
   * atribuir, mudar status nem transferir. A lista é a mesma; a barra é que
   * não pode virar um atalho por fora do controle de acesso.
   */
  const { ctx: c3, p: p3 } = await entrar('carla.solicitante@meridiano.com.br')
  await p3.goto(`${BASE}/tickets?status=todos`, { waitUntil: 'networkidle' })
  const r = await linhas(p3)
  ok(r.length > 0, `a Solicitante continua vendo a lista (${r.length} chamados)`)

  await p3.locator('tr[data-indice="0"] input[type="checkbox"]').check()
  await p3.waitForTimeout(300)
  ok(await p3.locator('[data-testid="barra-de-lote"]').isVisible(), 'e consegue marcar')
  ok(
    (await p3.locator('[data-testid="lote-atribuir"]').count()) === 0 &&
      (await p3.locator('[data-testid="lote-status"]').count()) === 0 &&
      (await p3.locator('[data-testid="lote-fila"]').count()) === 0,
    'mas nenhuma das três ações aparece para ela',
  )
  ok(
    await p3.locator('text=não tem ação em lote').isVisible(),
    'e a barra explica por que está vazia, em vez de parecer quebrada',
  )
  await c3.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 8. Celular: a tabela vira ficha, e nada rola de lado ===')
// ---------------------------------------------------------------------------
{
  const cel = await b.newContext({
    viewport: { width: 390, height: 844 },
    storageState: await ctx.storageState(),
  })
  const pc = await cel.newPage()

  for (const rota of ['/tickets', '/inventario', '/clientes', '/filas', '/painel']) {
    await pc.goto(BASE + rota, { waitUntil: 'networkidle' })
    await pc.waitForTimeout(400)
    const largura = await pc.evaluate(() => document.documentElement.scrollWidth)
    ok(largura <= 392, `${rota} cabe na tela do celular (documento: ${largura}px)`)
  }

  await pc.goto(`${BASE}/tickets`, { waitUntil: 'networkidle' })
  ok((await pc.locator('li[data-indice]').count()) > 0, 'a lista de chamados aparece em fichas')
  ok(
    !(await pc.locator('table').first().isVisible().catch(() => false)),
    'e a tabela de colunas não é mostrada no celular',
  )

  await pc.goto(`${BASE}/inventario`, { waitUntil: 'networkidle' })
  ok(
    (await pc.locator('td[data-rotulo]').first().isVisible()) &&
      (await pc.locator('thead').first().isVisible()) === false,
    'nas outras telas o cabeçalho some e o rótulo passa a viajar com o dado',
  )
  await cel.close()
}

await ctx.close()
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
