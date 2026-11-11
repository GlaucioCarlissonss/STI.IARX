/*
 * Peças, estoque e compras — Fase 6 da unificação com o LTI (docs/23).
 *
 * Por que esta suíte existe
 * -------------------------
 * A propriedade que torna um estoque auditável é que o saldo NÃO é um campo: é
 * o acumulado do razão. Essa propriedade se perde de um jeito silencioso — basta
 * alguém acrescentar um caminho que escreve o saldo sem lançar movimento, e a
 * partir daí o número continua parecendo certo e deixa de ser explicável.
 *
 * Então a §2 não confere "o saldo está correto": ela confere que o saldo MUDA
 * pelo movimento e que a lista de movimentos explica o número mostrado. E a §3
 * cobra a recusa do saldo negativo, que é a trava que impede o sistema de
 * operar sobre uma mentira aritmética.
 *
 * Como rodar: ver `telas.spec.mjs`.
 */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3177'
const SENHA = 'desenvolvimento'

/*
 * Repetir sem recriar o banco: o problema e a saída.
 *
 * O razão é IMUTÁVEL de propósito — nada aqui pode apagar o que lançou. Então a
 * suíte faz as duas coisas que sobram: o que ela cria (ordem, nota, contagem)
 * leva um sufixo único, e o que ela MOVE ela devolve no fim, lançando o
 * movimento contrário. O estoque volta ao número do exemplo; o histórico guarda
 * a ida e a volta, que é exatamente o que um razão deve fazer.
 *
 * Sem isso a suíte passaria na primeira execução e reprovaria na segunda — e
 * quem a encontrasse assim culparia o código, não o teste.
 */
const SUFIXO = String(Date.now()).slice(-6)

let falhas = 0
const ok = (c, m) => {
  if (!c) falhas++
  console.log(`${c ? '  ok  ' : '  FALHOU '} ${m}`)
}

const b = await chromium.launch()

async function entrar(email) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await p.fill('input[name="email"]', email)
  await p.fill('input[name="password"]', SENHA)
  await p.click('button[type="submit"]')
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 })
  return { ctx, p }
}

/* Aviso e erro vivem FORA de `<main>` — ler `main` devolveria vazio. */
const corpo = (p) => p.locator('body').innerText()

const esperarTexto = async (p, re, limite = 15000) => {
  const t0 = Date.now()
  let ultimo = ''
  while (Date.now() - t0 < limite) {
    ultimo = await corpo(p)
    if (re.test(ultimo)) return ultimo
    await p.waitForTimeout(150)
  }
  return ultimo
}

/**
 * Abre a peça NO DEPÓSITO pedido.
 *
 * O depósito importa. Clicar no primeiro resultado parecia bastar enquanto a
 * peça morava num lugar só — mas a transferência da §5 cria uma linha nova, e
 * a partir da segunda execução o "primeiro" passou a ser outro depósito, com
 * outro saldo. Sete asserções reprovaram falando da peça errada.
 */
const abrirPeca = async (p, sku, deposito = 'Base Matriz') => {
  await p.goto(`${BASE}/locacao/pecas?busca=${sku}`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(300)
  await p
    .locator(`tr:has-text("${deposito}")`)
    .first()
    .locator('[data-testid="abrir-registro"]')
    .click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(400)
}

/** Saldo lido da LINHA daquele depósito, e não do corpo inteiro da página. */
const saldoNaLinha = async (p, deposito) => {
  const linha = p.locator(`tr:has-text("${deposito}")`).first()
  if ((await linha.count()) === 0) return null
  /* Qualquer unidade: a peça define a dela (un, par, kg…), e fixar "un" aqui
     faria o teste reprovar no dia em que o cadastro mudasse de unidade — que é
     exatamente o que aconteceu quando o exemplo passou a falar da frota real. */
  const m = (await linha.innerText()).match(/(\d+(?:,\d+)?)\s*(?:un|par|m|kg|L|cx)\b/)
  return m ? Number(m[1].replace(',', '.')) : null
}

const { ctx, p } = await entrar('admin@iaroffice.com.br')

// ---------------------------------------------------------------------------
console.log('\n=== 1. A lista separa quem precisa de compra de quem não precisa ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/locacao/pecas`, { waitUntil: 'networkidle' })

  const linhas = await p.locator('[data-testid="abrir-registro"]').count()
  ok(linhas >= 4, `a lista traz as ${linhas} linhas de peça × depósito do exemplo`)

  const texto = await corpo(p)
  ok(/Abaixo do mínimo/i.test(texto), 'quem furou o mínimo é dito por escrito, e não só por cor')
  ok(/Zerado/i.test(texto), 'e quem está zerado também')
  ok(/Em nível/i.test(texto), 'e quem está em nível aparece junto, para haver comparação')

  const sugestoes = await p.locator('[data-testid="sugestao-de-compra"]').count()
  ok(sugestoes >= 2, `${sugestoes} linha(s) já chegam com a quantidade a comprar calculada`)

  /* A mesma peça em dois depósitos, com mínimos diferentes: é o ponto da
     política ser por peça E depósito. */
  await p.goto(`${BASE}/locacao/pecas?busca=PC-0014`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(300)
  const doisDepositos = await p.locator('[data-testid="abrir-registro"]').count()
  ok(doisDepositos === 2, 'a mesma peça aparece uma vez por depósito')
  const comparativo = await corpo(p)
  ok(
    /6 \/ 16/.test(comparativo) && /2 \/ 6/.test(comparativo),
    'com mínimos diferentes em cada um — o da oficina não é o do galpão',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. O saldo é a soma dos movimentos, e a gaveta mostra a conta ===')
// ---------------------------------------------------------------------------
{
  await abrirPeca(p, 'PC-0031', 'Base Matriz')

  const saldo = await p.locator('[data-testid="saldo-da-peca"]').innerText()
  ok(/\b2 par\b/.test(saldo), `o saldo da peneira é 2 par (${saldo.split('\n').slice(0, 4).join(' · ')})`)
  ok(/8 \/ 24/.test(saldo), 'o mínimo e o máximo aparecem junto do saldo')
  ok(/\b22 par\b/.test(saldo), 'e a sugestão é 22 — máximo (24) menos saldo (2), não mínimo menos saldo')

  /*
   * O razão CRESCE a cada execução — ele é imutável, e a §13 devolve o saldo
   * lançando o contrário, não apagando. Então o que se confere aqui são os três
   * movimentos do exemplo, pelo que cada um diz; contar o total reprovaria por
   * histórico acumulado, que é falha do teste e não do código.
   */
  const movimentos = await p.locator('[data-testid="movimento-de-peca"]').count()
  ok(movimentos >= 3, `o razão tem ${movimentos} movimentos, e explica o saldo linha a linha`)

  const gaveta = await p.locator('[data-testid="gaveta"]').innerText()
  ok(/\+5 par/.test(gaveta), 'a entrada traz o sinal escrito, e não só a cor')
  ok(/−2 par/.test(gaveta) && /−1 par/.test(gaveta), 'as saídas também')
  ok(
    /Consumo em atendimento/i.test(gaveta),
    'o consumo diz de onde veio — a baixa nasceu do apontamento de campo',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. Saldo negativo é recusado, com o número no erro ===')
// ---------------------------------------------------------------------------
{
  await p.selectOption('#mv-dir', 'ajuste_menos')
  await p.fill('#mv-qtd', '99')
  await p.fill('#mv-notas', 'Tentativa da suíte')
  await p.locator('form:has(#mv-dir) button[type="submit"]').click()

  const erro = await p
    .locator('form:has(#mv-dir) [role="alert"]')
    .first()
    .innerText()
    .catch(() => '')
  ok(/negativo/i.test(erro), `a recusa fala em saldo negativo ("${erro.slice(0, 80)}")`)
  ok(/PC-0031/.test(erro), 'e nomeia a peça, em vez de dizer só "erro ao salvar"')

  await p.reload({ waitUntil: 'networkidle' })
  await p.waitForTimeout(400)
  const depois = await p.locator('[data-testid="saldo-da-peca"]').innerText()
  ok(/\b2 par\b/.test(depois), 'e o saldo não se mexeu: a recusa não deixou estado pela metade')
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. Lançar movimento muda o saldo — e o razão explica a mudança ===')
// ---------------------------------------------------------------------------
{
  const antesDoLancamento = await p.locator('[data-testid="movimento-de-peca"]').count()
  await p.selectOption('#mv-dir', 'entrada')
  await p.fill('#mv-qtd', '10')
  await p.fill('#mv-custo', '200')
  await p.fill('#mv-notas', 'Entrada da suíte')
  await p.locator('form:has(#mv-dir) button[type="submit"]').click()

  const texto = await esperarTexto(p, /Movimento lançado/i)
  ok(/Movimento lançado/i.test(texto), 'o lançamento é aceito')

  await p.reload({ waitUntil: 'networkidle' })
  await p.waitForTimeout(500)
  const saldo = await p.locator('[data-testid="saldo-da-peca"]').innerText()
  ok(/\b12 par\b/.test(saldo), 'o saldo vai de 2 para 12 — ninguém digitou 12 em lugar nenhum')
  ok(
    /\b12 par\b/.test(saldo) && !/\b22 par\b/.test(saldo),
    'e a sugestão de compra some: 12 passou do mínimo de 8',
  )

  const movimentos = await p.locator('[data-testid="movimento-de-peca"]').count()
  ok(
    movimentos === antesDoLancamento + 1,
    `o razão ganhou exatamente uma linha (${antesDoLancamento} → ${movimentos}) — a mudança tem origem escrita`,
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. Transferência move de lugar sem mudar o total ===')
// ---------------------------------------------------------------------------
{
  await p.selectOption('#tr-dest', { index: 0 })
  const destino = await p.locator('#tr-dest option:checked').innerText()
  await p.fill('#tr-qtd', '4')
  await p.locator('form:has(#tr-dest) button[type="submit"]').click()

  const texto = await esperarTexto(p, /Transferência concluída/i)
  ok(/Transferência concluída/i.test(texto), `a transferência para ${destino.trim()} é aceita`)

  await p.goto(`${BASE}/locacao/pecas?busca=PC-0031`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(500)
  ok((await saldoNaLinha(p, 'Base Matriz')) === 8, 'a origem fica com 8')
  ok(
    (await saldoNaLinha(p, 'Base Campinas')) === 4,
    'e o destino com 4 — o total continua 12, só mudou de lugar',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. A ordem de compra: total somado, recebimento parcial ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/locacao/compras`, { waitUntil: 'networkidle' })
  const ordens = await p.locator('[data-testid="abrir-registro"]').count()
  ok(ordens >= 2, `a lista traz as ${ordens} ordens do exemplo`)

  const texto = await corpo(p)
  ok(/Recebida em parte/i.test(texto), 'o recebimento parcial tem nome próprio na lista')
  ok(/% recebido/.test(texto), 'e o quanto já chegou aparece em porcentagem')

  /* Pelo CÓDIGO, e não pelo estado: a ordem que esta suíte cria também fica
     "Recebida em parte", e a partir da segunda execução ela passou a ser a
     primeira da lista — as asserções falavam da ordem errada. */
  await p.goto(`${BASE}/locacao/compras?busca=OC-2026-013`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(300)
  await p.locator('[data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(400)

  const itens = await p.locator('[data-testid="item-da-ordem"]').count()
  ok(itens === 2, `a ordem do exemplo tem ${itens} itens`)

  const gaveta = await p.locator('[data-testid="gaveta"]').innerText()
  ok(/recebido 5 de 8/i.test(gaveta), 'uma linha mostra 5 de 8 recebidos')
  ok(/recebido 0 de 4/i.test(gaveta), 'e a outra, 0 de 4 — fechar a ordem aqui perderia isso')
  /* Sem o "R$ " na frente: `Intl.NumberFormat` separa o símbolo com espaço NÃO
     separável (U+00A0), e um espaço comum no padrão nunca casa. */
  ok(/3\.971,20/.test(gaveta), 'o total é a soma das linhas (3.112,00 + 859,20)')
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. Uma ordem própria: criar, enviar e receber em parte ===')
// ---------------------------------------------------------------------------
// A ordem é criada pela suíte, e não a do exemplo: receber muda estoque e
// estado, e consumir o exemplo faria a execução seguinte encontrar outro ponto
// de partida.
const ORDEM = `OC-SUITE-${SUFIXO}`
{
  await p.goto(`${BASE}/locacao/compras`, { waitUntil: 'networkidle' })
  await p.locator('[data-testid="novo-registro"]').click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(300)

  await p.fill('#oc-code', ORDEM)
  await p.selectOption('#oc-dep', { label: 'Base Matriz' })
  await p.locator('form:has(#oc-code) button[type="submit"]').click()
  ok(/criada como rascunho/i.test(await esperarTexto(p, /criada como rascunho/i)),
    `a ordem ${ORDEM} nasce como rascunho`)

  await p.goto(`${BASE}/locacao/compras?busca=${ORDEM}`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(300)
  await p.locator('[data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(400)

  const vazia = await p.locator('[data-testid="gaveta"]').innerText()
  ok(/Acrescente ao menos um item/i.test(vazia),
    'ordem sem item não pode ser enviada, e a tela diz por quê')

  await p.selectOption('#it-peca', { index: 1 })
  await p.fill('#it-qtd', '6')
  await p.fill('#it-preco', '100')
  await p.locator('form:has(#it-peca) button[type="submit"]').click()
  await esperarTexto(p, /Item acrescentado/i)

  await p.reload({ waitUntil: 'networkidle' })
  await p.waitForTimeout(500)
  const comItem = await p.locator('[data-testid="gaveta"]').innerText()
  ok(/600,00/.test(comItem), 'o total aparece sozinho: 6 × 100, somado pelo banco')

  await p.locator('button:has-text("Enviar ao fornecedor")').click()
  ok(/enviada ao fornecedor/i.test(await esperarTexto(p, /enviada ao fornecedor/i)),
    'com item, a ordem pode ser enviada')
}

// ---------------------------------------------------------------------------
console.log('\n=== 8. Receber dá entrada no estoque de verdade ===')
// ---------------------------------------------------------------------------
let PECA_RECEBIDA = ''
let SALDO_ANTES = 0
{
  await p.reload({ waitUntil: 'networkidle' })
  await p.waitForTimeout(500)

  const linha = p.locator('[data-testid="item-da-ordem"]').first()
  PECA_RECEBIDA = ((await linha.innerText()).match(/PC-\d+/) ?? [''])[0]
  ok(PECA_RECEBIDA !== '', `a linha é da peça ${PECA_RECEBIDA}`)

  await p.goto(`${BASE}/locacao/pecas?busca=${PECA_RECEBIDA}`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(400)
  SALDO_ANTES = (await saldoNaLinha(p, 'Base Matriz')) ?? 0

  await p.goto(`${BASE}/locacao/compras?busca=${ORDEM}`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(300)
  await p.locator('[data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(400)

  const campo = p.locator('[data-testid="item-da-ordem"]').first().locator('input[name="quantity"]')
  ok((await campo.getAttribute('max')) === '6', 'o campo só aceita até o que falta (6)')
  ok((await campo.inputValue()) === '6', 'e já vem preenchido com o que falta, para conferir')

  /*
   * A trava do "receber a mais" é do CAMPO, e é onde ela deve estar: o
   * navegador recusa antes de a ação sair. O guarda do servidor continua lá e
   * continua necessário — ele é o que vale para quem manda a requisição à mão —,
   * mas quem o exercita é o banco, não o navegador. A primeira versão desta
   * seção digitava 9, esperava a recusa do servidor e lia uma mensagem vazia,
   * porque o formulário nunca chegou a ser enviado.
   */
  await campo.fill('9')
  await p.locator('[data-testid="item-da-ordem"]').first()
    .locator('button[type="submit"]:has-text("Receber")').click()
  await p.waitForTimeout(500)
  ok(!(await campo.evaluate((n) => n.checkValidity())),
    'com 9 em uma linha de 6, o campo fica inválido e o envio não acontece')

  await campo.fill('2')
  await p.locator('[data-testid="item-da-ordem"]').first()
    .locator('button[type="submit"]:has-text("Receber")').click()
  const texto = await esperarTexto(p, /segue com entrega pendente|está completa/i)
  ok(/segue com entrega pendente/i.test(texto),
    'recebendo 2 de 6, o retorno diz que a ordem AINDA tem pendência')

  await p.goto(`${BASE}/locacao/pecas?busca=${PECA_RECEBIDA}`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(500)
  const depois = (await saldoNaLinha(p, 'Base Matriz')) ?? 0
  ok(depois === SALDO_ANTES + 2,
    `o saldo sobe de ${SALDO_ANTES} para ${depois} — receber é estoque, não um número na ordem`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 9. A NF gera o título a pagar que já existe ===')
// ---------------------------------------------------------------------------
const NOTA = `NF-SUITE-${SUFIXO}`
{
  await p.goto(`${BASE}/locacao/compras?busca=${ORDEM}`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(300)
  await p.locator('[data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(400)

  const antes = await p.locator('[data-testid="gaveta"]').innerText()
  ok(/ainda não gerado/i.test(antes), 'antes da NF, a ordem não tem título')

  await p.fill('input[name="invoice_ref"]', NOTA)
  await p.locator('form:has(input[name="invoice_ref"]) button[type="submit"]').click()
  ok(/título a pagar criado/i.test(await esperarTexto(p, /título a pagar criado/i)),
    'o retorno confirma o título no financeiro')

  await p.reload({ waitUntil: 'networkidle' })
  await p.waitForTimeout(500)
  const depois = await p.locator('[data-testid="gaveta"]').innerText()
  ok(new RegExp(NOTA).test(depois), 'a nota fica registrada na ordem')
  ok(/abrir no financeiro/i.test(depois), 'e há caminho para o título — um financeiro só')

  /* O teste que a decisão exige: o título existe no financeiro que já havia, e
     não numa segunda contabilidade dentro da locação. */
  await p.goto(`${BASE}/financeiro/titulos-a-pagar?busca=${NOTA}`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(600)
  ok(new RegExp(NOTA).test(await corpo(p)),
    'e o mesmo título aparece em Títulos a pagar — não há financeiro paralelo')
}

// ---------------------------------------------------------------------------
console.log('\n=== 10. A contagem: congela o esperado e vira ajuste ===')
// ---------------------------------------------------------------------------
const CONTAGEM = `CT-SUITE-${SUFIXO}`
let PECA_AJUSTADA = ''
{
  await p.goto(`${BASE}/locacao/contagens`, { waitUntil: 'networkidle' })
  await p.locator('[data-testid="novo-registro"]').click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(300)

  await p.selectOption('#ct-dep', { label: 'Base Matriz' })
  await p.fill('#ct-code', CONTAGEM)
  await p.locator('form:has(#ct-code) button[type="submit"]').click()

  const texto = await esperarTexto(p, /aberta com/i)
  ok(/aberta com \d+ peça/i.test(texto), `a contagem nasce com as peças do depósito (${texto.match(/aberta com \d+ peça\(s\)/i)?.[0] ?? ''})`)

  await p.goto(`${BASE}/locacao/contagens?busca=${CONTAGEM}`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(300)
  await p.locator('[data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(400)

  const itens = await p.locator('[data-testid="item-da-contagem"]').count()
  ok(itens >= 2, `${itens} peça(s) a conferir, com o esperado congelado`)

  /* Fechar com item em branco é recusado: ajustar pela metade registraria perda
     na peça contada e silêncio na não contada. */
  const aviso = await p.locator('[data-testid="gaveta"]').innerText()
  ok(
    /Faltam \d+ peça\(s\) sem lançamento/i.test(aviso),
    'com item em branco, a tela nem oferece o fechamento — e diz por quê',
  )

  // Conta tudo certo, menos uma peça, que some uma unidade.
  const campos = await p.locator('[data-testid="item-da-contagem"]').all()
  for (let i = 0; i < campos.length; i++) {
    const esperado = await campos[i].innerText()
    const n = Number((esperado.match(/Esperado ([\d,.]+)/) ?? [])[1]?.replace(',', '.') ?? '0')
    if (i === 0) PECA_AJUSTADA = (esperado.match(/PC-\d+/) ?? [''])[0]
    await campos[i].locator('input[name="counted_quantity"]').fill(String(i === 0 ? n - 1 : n))
    await campos[i].locator('button[type="submit"]').click()
    await esperarTexto(p, /Contagem lançada/i)
    await p.waitForTimeout(250)
  }

  await p.reload({ waitUntil: 'networkidle' })
  await p.waitForTimeout(500)
  const pronta = await p.locator('[data-testid="resumo-da-contagem"]').innerText()
  ok(/Divergentes\n?1/.test(pronta.replace(/\s+/g, '\n')), 'o resumo acusa 1 divergência')

  await p.locator('button:has-text("Fechar e gerar ajustes")').click()
  const fechou = await esperarTexto(p, /viraram ajustes/i)
  ok(/viraram ajustes/i.test(fechou), 'fechar transforma a diferença em ajuste no razão')
}

// ---------------------------------------------------------------------------
console.log('\n=== 11. O ajuste aparece no razão da peça, com esperado e contado ===')
// ---------------------------------------------------------------------------
{
  await abrirPeca(p, PECA_AJUSTADA, 'Base Matriz')
  const gaveta = await p.locator('[data-testid="gaveta"]').innerText()
  ok(/Ajuste de inventário/i.test(gaveta), 'o ajuste está na lista de movimentos')
  ok(
    new RegExp(CONTAGEM).test(gaveta),
    `com a contagem que o originou (${CONTAGEM}) — a diferença não foi apagada do saldo`,
  )
  ok(
    /esperado/i.test(gaveta) && /contado/i.test(gaveta),
    'e com o esperado e o contado escritos, que é o que responde "por que sumiu?"',
  )

  /*
   * A lista de movimentos é limitada — um estoque com anos de uso traria
   * milhares de linhas. O que não pode é a tela afirmar "o saldo é a soma
   * destes movimentos" e mostrar só uma parte em silêncio: quem somasse o que
   * vê daria outro número e desconfiaria do saldo.
   *
   * Esta asserção vale nos dois sentidos: quando a lista cabe, não há recado
   * nenhum; quando não cabe, o recado existe e diz quantos ficaram de fora.
   */
  const total = Number((gaveta.match(/Movimentos \((\d+)\)/) ?? ['', '0'])[1])
  const avisou = /Mostrando os \d+ mais recentes de [\d.]+ movimentos/.test(gaveta)
  ok(
    total < 20 ? !avisou : avisou,
    total < 20
      ? `a lista cabe inteira (${total}) e a tela não inventa um aviso`
      : `a lista foi cortada em ${total} e a tela diz quantos ficaram de fora`,
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 12. Quem não gerencia não vê os botões que gastam ===')
// ---------------------------------------------------------------------------
{
  /*
   * A matriz é quem impõe a separação, e é nela que esta asserção olha: num
   * perfil de ATENDENTE, `compras.receber` é concedível e `compras.faturar`
   * não. Receber é conferir a entrega; faturar é criar dinheiro a pagar.
   */
  await p.goto(`${BASE}/perfis`, { waitUntil: 'networkidle' })
  await p
    .locator('section', { hasText: 'Operador de TI' })
    .locator('[data-testid="abrir-registro"]')
    .first()
    .click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(500)

  const receber = p.locator('input[name="perm"][value="locacao.compras.receber"]')
  const faturar = p.locator('input[name="perm"][value="locacao.compras.faturar"]')
  const fechar = p.locator('input[name="perm"][value="locacao.contagens.fechar"]')

  ok(!(await receber.isDisabled()), 'receber mercadoria é concedível a um perfil de atendente')
  ok(await faturar.isDisabled(), 'registrar NF não é: exige gestor, porque vira dinheiro a pagar')
  ok(await fechar.isDisabled(), 'e fechar contagem também não — o ajuste é perda reconhecida')
}

// ---------------------------------------------------------------------------
console.log('\n=== 13. O estoque volta ao número do exemplo ===')
// ---------------------------------------------------------------------------
{
  /*
   * Devolver é LANÇAR O CONTRÁRIO, nunca apagar — o razão é imutável, e é essa
   * imutabilidade que o §2 verifica. Então o histórico fica com a ida e a
   * volta, o saldo volta ao do seed, e a execução seguinte encontra o mesmo
   * ponto de partida.
   *
   * O que a suíte moveu: +10 de entrada e −4 de transferência no PC-0031 (§4 e
   * §5), +2 do recebimento (§8) e a diferença de 1 do ajuste de contagem (§10).
   */
  const devolver = async (sku, deposito, direcao, quantidade, motivo) => {
    await p.goto(`${BASE}/locacao/pecas?busca=${sku}`, { waitUntil: 'networkidle' })
    await p.waitForTimeout(300)
    const linha = p.locator(`tr:has-text("${deposito}")`).first()
    if ((await linha.count()) === 0) return false
    await linha.locator('[data-testid="abrir-registro"]').click()
    await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
    await p.waitForTimeout(400)
    await p.selectOption('#mv-dir', direcao)
    await p.fill('#mv-qtd', String(quantidade))
    await p.fill('#mv-notas', motivo)
    await p.locator('form:has(#mv-dir) button[type="submit"]').click()
    await esperarTexto(p, /Movimento lançado/i)
    return true
  }

  await devolver('PC-0031', 'Base Campinas', 'ajuste_menos', 4, 'Desfaz a transferência da suíte')
  await devolver('PC-0031', 'Base Matriz', 'ajuste_menos', 6, 'Desfaz a entrada da suíte')
  if (PECA_RECEBIDA) {
    await devolver(PECA_RECEBIDA, 'Base Matriz', 'ajuste_menos', 2, 'Desfaz o recebimento da suíte')
  }
  if (PECA_AJUSTADA) {
    await devolver(PECA_AJUSTADA, 'Base Matriz', 'ajuste_mais', 1, 'Desfaz o ajuste da suíte')
  }

  await p.goto(`${BASE}/locacao/pecas?busca=PC-0031`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(500)
  ok((await saldoNaLinha(p, 'Base Matriz')) === 2, 'a peneira volta aos 2 par do exemplo')
  ok(/Abaixo do mínimo/i.test(await corpo(p)), 'e volta a constar como abaixo do mínimo')

  await p.goto(`${BASE}/locacao/pecas?busca=PC-0014`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(500)
  ok((await saldoNaLinha(p, 'Base Matriz')) === 12, 'a bateria volta aos 12 un da Base Matriz')
}

await ctx.close()
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
