/*
 * As esferas de negócio — Fase 1 da unificação com o LTI (docs/23).
 *
 * Por que esta suíte existe
 * -------------------------
 * A esfera decide o que EXISTE no menu de uma empresa, e isso falha de um jeito
 * silencioso nos dois sentidos:
 *
 *  - de menos: ligar a esfera e o menu não mudar — a pessoa conclui que marcar
 *    a caixa não surtiu efeito, e marca de novo;
 *  - de mais: desligar a esfera e a tela continuar alcançável por endereço, ou
 *    a chave de permissão continuar concedível — aí a escolha virou enfeite.
 *
 * O caso mais perigoso é o §4: desligar as duas esferas deixaria a empresa sem
 * tela nenhuma, inclusive sem a tela onde se desfaz o engano. O banco recusa, a
 * ação recusa antes, e esta suíte cobra as duas recusas.
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
 * Rótulos dos grupos da barra lateral, na ordem em que aparecem.
 *
 * Em minúsculas porque `innerText` respeita `text-transform`, e o cabeçalho do
 * grupo é desenhado em caixa alta: comparar com o rótulo do código devolveria
 * falso em todas as linhas, por motivo de CSS.
 */
const gruposDoMenu = async (p) => {
  /* Trocar o foco recarrega a página inteira (é o único mecanismo que não se
     perde — ver `seletor-de-esfera.tsx`). Ler o menu no meio desse
     recarregamento derruba o contexto do navegador, e isso é a suíte correndo
     junto com a aplicação, não defeito dela: devolve lista vazia e tenta de
     novo no próximo giro. */
  try {
    const rotulos = await p.$$eval('nav[aria-label="Navegação principal"] summary', (ns) =>
      ns.map((n) => n.innerText.trim()),
    )
    return rotulos.map((r) => r.toLocaleLowerCase('pt-BR'))
  } catch {
    return []
  }
}

const tem = (grupos, rotulo) => grupos.includes(rotulo.toLocaleLowerCase('pt-BR'))

/**
 * Espera o menu chegar na forma esperada, em vez de esperar um tempo.
 *
 * Trocar o foco é uma Server Action que revalida o layout inteiro: o clique
 * volta quando o servidor responde, e não em um prazo que o teste possa
 * adivinhar. Esperar 900ms reprovava a PRIMEIRA troca e passava nas seguintes —
 * falha por corrida, que é a que ensina a desconfiar da suíte.
 */
async function ateOMenu(p, condicao, limite = 15000) {
  const t0 = Date.now()
  let ultimo = []
  while (Date.now() - t0 < limite) {
    ultimo = await gruposDoMenu(p)
    if (condicao(ultimo)) return ultimo
    await p.waitForTimeout(150)
  }
  return ultimo
}

/** Marca/desmarca as esferas na tela de preferências e salva. */
async function definirEsferas(p, quais) {
  await p.goto(`${BASE}/ambiente`, { waitUntil: 'networkidle' })
  for (const e of ['management', 'rental']) {
    const caixa = p.locator(`input[name="esferas"][value="${e}"]`)
    if (quais.includes(e)) await caixa.check()
    else await caixa.uncheck()
  }
  await p.locator('button:has-text("Salvar esferas")').click()
  /* A ação revalida o layout; o menu é a prova de que ela chegou. */
  await p.waitForTimeout(400)
  await ateOMenu(p, (g) => (quais.includes('management') ? tem(g, 'Gestão') : !tem(g, 'Gestão')))
}

const { ctx, p } = await entrar('admin@iaroffice.com.br')

// ---------------------------------------------------------------------------
console.log('\n=== 1. Com as duas esferas, o seletor existe e o menu é a união ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/painel`, { waitUntil: 'networkidle' })
  const grupos = await gruposDoMenu(p)
  ok(tem(grupos, 'Locação'), `o grupo de Locação está no menu (${grupos.length} grupos)`)
  ok(
    tem(grupos, 'Inventário e monitoramento') && tem(grupos, 'Gestão'),
    'e os grupos de governança continuam lá — a empresa faz os dois negócios',
  )
  ok(
    (await p.locator('[data-testid="foco-da-esfera"]').count()) === 1,
    'o seletor de foco aparece, porque há escolha a fazer',
  )

  /*
   * O módulo de locação nasceu só com promessas (Fase 1) e foi ganhando telas
   * de verdade a cada fase. O que continua valendo — e é o que este teste
   * guarda — é a distinção entre as duas coisas no mesmo menu: tela que existe
   * é link, tela que virá tem selo. Contar um número fixo reprovaria a cada
   * fase entregue, que é falha por progresso.
   */
  await p.locator('nav[aria-label="Navegação principal"] summary:has-text("LOCAÇÃO")').click()
  await p.waitForTimeout(300)
  const comLink = await p
    .locator('nav[aria-label="Navegação principal"] a[href^="/locacao/"]')
    .count()
  const previstas = await p
    .locator('nav[aria-label="Navegação principal"] [data-previsto="1"]')
    .count()
  ok(comLink > 0, `o grupo de locação tem ${comLink} tela(s) de verdade`)
  ok(previstas > 0, `e ${previstas} ainda marcada(s) como previstas, com selo`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. O foco encurta o menu, e não esconde o acesso ===')
// ---------------------------------------------------------------------------
{
  await p.locator('[data-testid="foco-da-esfera"] button:has-text("Gestão de TI")').click()
  const comGestao = await ateOMenu(p, (g) => !tem(g, 'Locação'))
  ok(!tem(comGestao, 'Locação'), 'focando gestão, o grupo de locação sai do menu')
  ok(tem(comGestao, 'Inventário e monitoramento'), 'e o inventário continua')

  await p.locator('[data-testid="foco-da-esfera"] button:has-text("Locação e serviços")').click()
  const comLocacao = await ateOMenu(p, (g) => tem(g, 'Locação'))
  ok(tem(comLocacao, 'Locação'), 'focando locação, o grupo de locação entra')
  ok(
    !tem(comLocacao, 'Inventário e monitoramento') && !tem(comLocacao, 'Gestão'),
    'e os de governança saem',
  )

  /*
   * O ponto que separa foco de permissão: a tela some do MENU e continua
   * alcançável. Se um dia o foco passar a negar acesso, esta asserção cai — e
   * ela cai antes de alguém descobrir pelo suporte.
   */
  await p.goto(`${BASE}/inventario`, { waitUntil: 'networkidle' })
  ok(
    new URL(p.url()).pathname === '/inventario',
    'o endereço de uma tela fora do foco continua abrindo — foco não é permissão',
  )

  await p.goto(`${BASE}/painel`, { waitUntil: 'networkidle' })
  await p.locator('[data-testid="foco-da-esfera"] button:has-text("As duas")').click()
  const voltou = await ateOMenu(p, (g) => tem(g, 'Locação') && tem(g, 'Gestão'))
  ok(tem(voltou, 'Locação') && tem(voltou, 'Gestão'), 'voltando para "As duas", tudo volta')
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. Desligar uma esfera tira as telas e as chaves ===')
// ---------------------------------------------------------------------------
{
  await definirEsferas(p, ['rental'])

  const grupos = await gruposDoMenu(p)
  ok(
    !tem(grupos, 'Inventário e monitoramento') && !tem(grupos, 'Gestão'),
    'sem a esfera de gestão, os grupos dela somem do menu',
  )
  ok(tem(grupos, 'Locação'), 'e o de locação fica')
  ok(
    (await p.locator('[data-testid="foco-da-esfera"]').count()) === 0,
    'o seletor de foco some: com uma esfera só, não há escolha a fazer',
  )

  /* A matriz de permissão obedece à mesma regra: chave que não governa tela
     nenhuma é configuração morta. */
  await p.goto(`${BASE}/perfis`, { waitUntil: 'networkidle' })
  await p.locator('[data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(500)
  const modulos = await p.$$eval('[data-testid="gaveta"] details summary', (ns) =>
    ns.map((n) => n.innerText.trim()),
  )
  ok(
    modulos.length > 0 && !modulos.some((m) => /Invent/i.test(m)),
    `a matriz não oferece o módulo de inventário (${modulos.length} módulos listados)`,
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. Desligar as duas é recusado, com motivo ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/ambiente`, { waitUntil: 'networkidle' })
  await p.locator('input[name="esferas"][value="management"]').uncheck()
  await p.locator('input[name="esferas"][value="rental"]').uncheck()
  await p.locator('button:has-text("Salvar esferas")').click()
  await p.waitForTimeout(1200)

  const erro = await p.locator('form:has(input[name="esferas"]) [role="alert"], [data-testid="aviso-erro"]').first().innerText().catch(() => '')
  ok(/ao menos uma esfera/i.test(erro), `a recusa explica o motivo ("${erro.slice(0, 60)}…")`)

  await p.reload({ waitUntil: 'networkidle' })
  const aindaLigada = await p.locator('input[name="esferas"][value="rental"]').isChecked()
  ok(aindaLigada, 'e nada foi salvo: a empresa continua com a esfera que tinha')
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. O estado do exemplo volta como estava ===')
// ---------------------------------------------------------------------------
{
  await definirEsferas(p, ['management', 'rental'])
  const grupos = await gruposDoMenu(p)
  ok(
    tem(grupos, 'Locação') && tem(grupos, 'Inventário e monitoramento'),
    'as duas esferas religadas, e o menu volta inteiro',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. Quem não administra o ambiente não recebe promessas ===')
// ---------------------------------------------------------------------------
{
  const { ctx: c2, p: p2 } = await entrar('ana.atendente@iaroffice.com.br')
  await p2.goto(`${BASE}/painel`, { waitUntil: 'networkidle' })
  const grupos = await gruposDoMenu(p2)
  ok(
    !tem(grupos, 'Locação'),
    'o atendente não vê o grupo de locação enquanto ele só tem telas previstas',
  )
  await c2.close()
}

await ctx.close()
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
