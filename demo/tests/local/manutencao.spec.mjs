/*
 * Manutenção em campo — Fase 5 da unificação com o LTI (docs/23).
 *
 * Por que esta suíte existe
 * -------------------------
 * A decisão de produto que esta fase implementa é que a ordem de serviço da
 * locação **é um chamado**. O jeito de essa decisão se desfazer na prática não é
 * alguém mudar de ideia: é a tela de campo virar uma segunda lista de trabalho
 * pendente, desconectada da primeira. Por isso a §1 cobra que o atendimento
 * tenha número de chamado e caminho de volta para `/tickets`.
 *
 * A segunda coisa que esta suíte guarda é a DIREÇÃO da alçada. O erro fácil —
 * e caro — seria travar o apontamento: o técnico que não consegue lançar a peça
 * que já instalou simplesmente não a lança, e o custo real some do sistema em
 * vez de aparecer pedindo aprovação. A §3 aponta acima do teto de propósito e
 * exige que isso seja aceito; a §4 exige que o FECHAMENTO seja recusado.
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

/* Aviso e erro são desenhados FORA de `<main>` — ler `main` aqui devolveria
   vazio e a asserção falharia por lugar, não por comportamento. Foi o que
   aconteceu com a suíte da Fase 4. */
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

const { ctx, p } = await entrar('admin@iaroffice.com.br')

// ---------------------------------------------------------------------------
console.log('\n=== 1. O atendimento é um CHAMADO, e a tela prova isso ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/locacao/manutencao`, { waitUntil: 'networkidle' })

  const linhas = await p.locator('[data-testid="abrir-registro"]').count()
  ok(linhas >= 2, `a lista traz os ${linhas} atendimentos do exemplo`)

  const numeros = await p.$$eval('[data-testid="abrir-registro"]', (ns) =>
    ns.map((n) => n.innerText.trim()),
  )
  ok(
    numeros.every((n) => /^#\d+$/.test(n)),
    `cada atendimento é identificado por número de chamado (${numeros.join(', ')})`,
  )

  const texto = await corpo(p)
  ok(/acima da alçada/i.test(texto), 'o que estourou a alçada tem selo na lista')
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. O custo é SOMADO do detalhe, e não digitado ===')
// ---------------------------------------------------------------------------
{
  /* O chamado caro é o primeiro da lista — #ordenada por número decrescente, e
     os dois do exemplo nascem juntos. Abrimos pelo selo para não depender da
     ordem. */
  await p.locator('tr:has-text("baixa pureza") [data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(400)

  const custo = await p.locator('[data-testid="custo-do-atendimento"]').innerText()
  ok(/300,00/.test(custo), `a mão de obra aparece pela soma dos apontamentos (${/300,00/.test(custo)})`)
  ok(/220,00/.test(custo), 'a peça aparece pela soma dos apontamentos')
  ok(/520,00/.test(custo), 'e o total é a soma das duas — 300 + 220')
  ok(/400,00/.test(custo), 'o teto da alçada é mostrado junto do custo, e não escondido')

  const horas = await p.locator('[data-testid="apontamento-de-hora"]').count()
  const pecas = await p.locator('[data-testid="apontamento-de-peca"]').count()
  ok(horas === 1 && pecas === 1, `o detalhe está à vista: ${horas} hora(s) e ${pecas} peça(s)`)

  ok(
    (await p.locator('[data-testid="ir-para-o-chamado"]').count()) === 1,
    'e há caminho para o chamado — campo e helpdesk são a mesma lista',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. Apontar ACIMA da alçada é permitido ===')
// ---------------------------------------------------------------------------
{
  await p.fill('#mp-desc', 'Peça da suíte de navegador')
  await p.fill('#mp-qtd', '2')
  await p.fill('#mp-custo', '45')
  await p.locator('form:has(#mp-desc) button[type="submit"]').click()

  const texto = await esperarTexto(p, /Peça registrada/i)
  ok(/Peça registrada/i.test(texto), 'o lançamento acima do teto é aceito, e não recusado')

  await esperarTexto(p, /610,00/)
  const custo = await p.locator('[data-testid="custo-do-atendimento"]').innerText()
  ok(/610,00/.test(custo), `o custo sobe para 610,00 e fica VISÍVEL (${custo.replace(/\n/g, ' · ')})`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. Fechar acima da alçada é recusado, com o número no erro ===')
// ---------------------------------------------------------------------------
{
  const botao = p.locator('form:has(input[name="status"][value="resolved"]) button[type="submit"]')
  ok((await botao.count()) === 1, 'a tela oferece "Resolvido" — é transição legal do estado atual')

  await botao.click()
  /* A mensagem é lida do AVISO, e não do corpo inteiro: a descrição da própria
     tela contém a palavra "alçada", e casar com ela daria uma asserção que
     passa mesmo quando a recusa não chega. Foi o que aconteceu na primeira
     execução — o teste dizia "ok" lendo o texto do cabeçalho. */
  const aviso = p
    .locator('form:has(input[name="status"][value="resolved"]) [role="alert"]')
    .first()
  await aviso.waitFor({ timeout: 20000 }).catch(() => {})
  const texto = await aviso.innerText().catch(() => '')
  ok(/alçada/i.test(texto), `a recusa fala de alçada, e não de "erro ao salvar" ("${texto.slice(0, 90)}")`)
  ok(
    /610/.test(texto) && /400/.test(texto),
    'e carrega os dois números — o custo e o teto — que é o que permite decidir',
  )

  await p.reload({ waitUntil: 'networkidle' })
  await p.waitForTimeout(400)
  const depois = await p.locator('[data-testid="gaveta"]').innerText()
  ok(/Em andamento/i.test(depois), 'e o atendimento continua aberto: nada ficou pela metade')
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. Aprovado, o MESMO fechamento passa ===')
// ---------------------------------------------------------------------------
{
  const aprovar = p.locator('form:has(input[name="approval_note"]) button[type="submit"]')
  ok((await aprovar.count()) === 1, 'o administrador vê o botão de aprovar')
  await p.fill('input[name="approval_note"]', 'Aprovado pela suíte')
  await aprovar.click()

  const texto = await esperarTexto(p, /Custo aprovado/i)
  ok(/Custo aprovado/i.test(texto), 'a aprovação é registrada')

  await p.reload({ waitUntil: 'networkidle' })
  await p.waitForTimeout(400)
  const gaveta = await p.locator('[data-testid="gaveta"]').innerText()
  ok(
    /610,00/.test(gaveta),
    'e NÃO apagou o custo: aprovar é autorizar o gasto, não esconder o número',
  )
  ok(/Aprovado pela suíte/.test(gaveta), 'a justificativa fica no atendimento')

  await p
    .locator('form:has(input[name="status"][value="resolved"]) button[type="submit"]')
    .first()
    .click()
  const depois = await esperarTexto(p, /atualizado|Resolvido/i)
  ok(/atualizado|Resolvido/i.test(depois), 'e o mesmo fechamento, agora, passa')
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. Abrir um atendimento cria chamado de verdade ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/locacao/manutencao`, { waitUntil: 'networkidle' })
  const antes = await p.locator('[data-testid="abrir-registro"]').count()

  await p.locator('[data-testid="novo-registro"]').click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(300)

  await p.selectOption('#ms-equip', { index: 1 })
  await p.selectOption('#ms-kind', 'preventive')
  await p.fill('#ms-titulo', 'Preventiva aberta pela suíte de navegador')
  await p.fill('#ms-alcada', '150')
  await p.locator('form:has(#ms-titulo) button[type="submit"]').click()

  const texto = await esperarTexto(p, /aberto na fila de campo/i)
  ok(/aberto na fila de campo/i.test(texto), 'o retorno diz em que fila o chamado nasceu')

  await p.goto(`${BASE}/locacao/manutencao`, { waitUntil: 'networkidle' })
  const depois = await p.locator('[data-testid="abrir-registro"]').count()
  ok(depois === antes + 1, `a lista passou de ${antes} para ${depois} atendimentos`)

  /* O teste que a decisão de produto exige: o chamado existe no HELPDESK, e não
     só nesta tela. Se um dia o campo virar uma lista paralela, esta cai. */
  await p.goto(`${BASE}/tickets?busca=Preventiva aberta pela suíte`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(600)
  const naLista = await corpo(p)
  ok(
    /Preventiva aberta pela suíte/i.test(naLista),
    'e o mesmo atendimento aparece na lista de chamados — uma fila só',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. Aprovar é de quem não gasta — e a matriz é quem impõe ===')
// ---------------------------------------------------------------------------
{
  /*
   * A separação "quem gasta não autoriza o gasto" não é um `if` na tela: é o
   * teto de papel base do catálogo de permissões. Num perfil de ATENDENTE, a
   * caixa de `aprovar` nem é marcável — e é isso que esta seção cobra, porque
   * um `if` se esquece de escrever e um teto no catálogo vale em todo lugar,
   * inclusive no RLS.
   */
  await p.goto(`${BASE}/perfis`, { waitUntil: 'networkidle' })
  /* Os perfis são cartões, e não linhas de tabela: o link certo é o que está
     DENTRO do cartão que fala de "Operador de TI". Clicar no primeiro abriria
     outro perfil e a asserção falaria de outra coisa. */
  await p
    .locator('section', { hasText: 'Operador de TI' })
    .locator('[data-testid="abrir-registro"]')
    .first()
    .click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(500)

  const titulo = await p.locator('[data-testid="gaveta"]').innerText()
  ok(/Operador de TI/.test(titulo), 'a gaveta aberta é a do perfil de atendente')

  const atender = p.locator('input[name="perm"][value="locacao.manutencao.atender"]')
  const aprovar = p.locator('input[name="perm"][value="locacao.manutencao.aprovar"]')
  ok((await atender.count()) === 1, 'a matriz oferece a chave de apontar')
  ok((await aprovar.count()) === 1, 'e a de aprovar aparece junto, para ser VISTA')
  ok(!(await atender.isDisabled()), 'apontar é concedível a um perfil de atendente')
  ok(
    await aprovar.isDisabled(),
    'aprovar NÃO é: exige papel base gestor, e o catálogo recusa antes da tela',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 8. Sem a chave, a tela NEGA — não devolve lista vazia ===')
// ---------------------------------------------------------------------------
{
  /*
   * A diferença entre "não pode" e "não há" é a falha mais cara deste projeto:
   * um `?? []` transforma erro de permissão em frota vazia, e quem vê conclui
   * que o cadastro sumiu. A atendente não tem chave nenhuma de locação, e o que
   * ela precisa encontrar é outra tela — nunca esta, vazia.
   */
  const { ctx: c2, p: p2 } = await entrar('ana.atendente@iaroffice.com.br')
  await p2.goto(`${BASE}/locacao/manutencao`, { waitUntil: 'networkidle' })
  await p2.waitForTimeout(500)
  const destino = new URL(p2.url()).pathname
  ok(
    destino !== '/locacao/manutencao',
    `quem não tem a chave é levado para uma tela que alcança (foi para ${destino})`,
  )

  const texto = await p2.locator('body').innerText()
  ok(
    !/Nenhum atendimento de campo/i.test(texto),
    'e em nenhum momento vê "nenhum atendimento" — que seria mentir sobre o que existe',
  )
  await c2.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 9. O estado do exemplo volta como estava ===')
// ---------------------------------------------------------------------------
{
  /*
   * Uma suíte que deixa rastro passa na primeira execução e reprova na segunda
   * — e quem a encontra assim culpa o código, não o teste. O que esta seção
   * desfaz é exatamente o que as §3 a §5 fizeram: a peça lançada, a aprovação
   * dada e o fechamento. O chamado aberto na §6 fica, porque a §6 compara a
   * lista consigo mesma e não com um número fixo.
   */
  await p.goto(`${BASE}/locacao/manutencao`, { waitUntil: 'networkidle' })
  await p.locator('tr:has-text("baixa pureza") [data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(400)

  await p
    .locator('[data-testid="apontamento-de-peca"]:has-text("suíte de navegador") button[type="submit"]')
    .first()
    .click()
  await esperarTexto(p, /Peça removida/i)

  await p.reload({ waitUntil: 'networkidle' })
  await p.waitForTimeout(400)
  const revogar = p.locator('form:has(input[name="ticket_id"]) button:has-text("Revogar aprovação")')
  if ((await revogar.count()) > 0) {
    await revogar.first().click()
    await esperarTexto(p, /Aprovação revogada/i)
    await p.reload({ waitUntil: 'networkidle' })
    await p.waitForTimeout(400)
  }

  const reabrir = p.locator('form:has(input[name="status"][value="in_progress"]) button[type="submit"]')
  if ((await reabrir.count()) > 0) {
    await reabrir.first().click()
    await esperarTexto(p, /atualizado/i)
    await p.reload({ waitUntil: 'networkidle' })
    await p.waitForTimeout(400)
  }

  const gaveta = await p.locator('[data-testid="gaveta"]').innerText()
  ok(/520,00/.test(gaveta), 'o custo volta aos 520,00 do exemplo')
  ok(/Acima da alçada/.test(gaveta), 'e o atendimento volta a estar travado, como o seed o deixa')
  ok(/Em andamento/.test(gaveta), 'com o chamado aberto de novo')
}

await ctx.close()
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
