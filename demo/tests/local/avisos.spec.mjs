/*
 * A resposta da tela depois da escrita — Fase 4 da revisão de usabilidade.
 *
 * Por que esta suíte existe
 * -------------------------
 * Ela nasceu de um defeito MEDIDO, não suposto: publicar um comentário gravava
 * no banco e a tela não dizia nada — a confirmação nunca aparecia, o texto
 * continuava no campo e a conversa não mudava. Da cadeira de quem atende isso
 * é indistinguível de "não funcionou", e a reação natural é clicar de novo, o
 * que põe dois comentários iguais no chamado do cliente.
 *
 * A causa era estrutural: a mensagem vivia dentro do componente que a
 * revalidação da própria ação recria. Ou seja, quanto mais a ação acertava em
 * atualizar a tela, mais certo era que a confirmação sumisse. Um defeito assim
 * volta sozinho na próxima refatoração se não houver teste.
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

/**
 * Espera uma condição virar verdadeira, devolvendo quanto tempo levou.
 *
 * As asserções desta suíte observam o efeito de uma REVALIDAÇÃO: a ação
 * responde, o servidor manda a árvore nova e só então a tela muda. Conferir
 * logo depois do aviso reprova por corrida, não por defeito — e um teste que
 * falha uma vez em três é um teste que as pessoas aprendem a ignorar.
 */
async function ate(condicao, limite = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < limite) {
    if (await condicao()) return Date.now() - t0
    await new Promise((r) => setTimeout(r, 120))
  }
  return null
}

const { ctx, p } = await entrar('admin@iaroffice.com.br')

// ---------------------------------------------------------------------------
console.log('\n=== 1. Publicar um comentário: confirma, limpa e aparece ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/tickets`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(800)
  await p.locator('tr[data-indice="0"] [data-testid="abrir-chamado"]').click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 10000 })

  const texto = `Verificação automática ${Date.now()}`
  await p.fill('[data-testid="gaveta"] textarea[name="body"]', texto)
  await p.locator('[data-testid="gaveta"] button[type="submit"]').click()

  await p.waitForSelector('[data-testid="aviso-ok"]', { timeout: 10000 })
  ok(true, 'a confirmação aparece — e sobrevive à revalidação que a ação dispara')

  await p.waitForTimeout(400)
  ok(
    (await p.locator('[data-testid="gaveta"] textarea[name="body"]').inputValue()) === '',
    'o campo limpa, porque campo cheio é a pista mais forte de que "não foi"',
  )

  const levou = await ate(async () =>
    (await p.locator('[data-testid="gaveta"]').innerText()).includes(texto),
  )
  ok(levou !== null, `e o comentário entra na conversa sozinho (${levou}ms), sem recarregar`)

  /* Confirmação some sozinha: ela já cumpriu o papel e não pode virar entulho. */
  await p.waitForTimeout(5600)
  ok(
    (await p.locator('[data-testid="aviso-ok"]').count()) === 0,
    'a confirmação sai de cena sozinha depois de alguns segundos',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. O erro FICA até alguém fechar ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/tickets?status=abertos`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(700)

  /* "Aguardando solicitante" não é transição válida a partir de "Aberto" (a
     máquina de estados vive no banco, ADR-007). O lote inteiro é recusado. */
  await p.locator('tr[data-indice="0"] input[type="checkbox"]').check()
  await p.waitForSelector('[data-testid="barra-de-lote"]')
  await p.locator('[data-testid="lote-status"]').selectOption('waiting_requester')

  await p.waitForSelector('[data-testid="aviso-erro"]', { timeout: 10000 })
  const msg = await p.locator('[data-testid="aviso-erro"]').innerText()
  ok(true, `a recusa vira aviso de erro ("${msg.replace(/\s+/g, ' ').slice(0, 60)}…")`)

  await p.waitForTimeout(6500)
  ok(
    (await p.locator('[data-testid="aviso-erro"]').count()) === 1,
    'e NÃO some sozinho — mensagem de erro que desaparece é mensagem que ninguém leu',
  )

  await p.locator('[data-testid="aviso-erro"] button[aria-label="Fechar o aviso"]').click()
  await p.waitForTimeout(300)
  ok((await p.locator('[data-testid="aviso-erro"]').count()) === 0, 'mas fecha quando se pede')
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. Desfazer uma atribuição em lote ===')
// ---------------------------------------------------------------------------
{
  /*
   * O teste PREPARA o próprio cenário em vez de depender do exemplo: tira o
   * atendente de dois chamados, atribui, confere e desfaz. Uma versão anterior
   * contava com "dois chamados sem atendente" vindos do seed — e passou a
   * falhar assim que outra execução atribuiu os dois. Teste que depende do
   * estado que ele mesmo não criou falha por motivo errado.
   */
  await p.goto(`${BASE}/tickets?status=todos`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(700)
  await p.locator('tr[data-indice="0"] input[type="checkbox"]').check()
  await p.locator('tr[data-indice="1"] input[type="checkbox"]').check()
  await p.locator('[data-testid="lote-atribuir"]').selectOption({ label: 'Sem atendente' })
  await p.waitForSelector('[data-testid="aviso-ok"]', { timeout: 10000 })
  await p.waitForTimeout(1200)

  await p.goto(`${BASE}/tickets?atendente=nenhum`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(700)
  const semAtendente = await p.locator('tr[data-indice]:visible').count()
  ok(semAtendente >= 2, `cenário preparado: ${semAtendente} chamado(s) sem atendente`)

  await p.locator('tr[data-indice="0"] input[type="checkbox"]').check()
  await p.locator('tr[data-indice="1"] input[type="checkbox"]').check()
  const nome = await p
    .locator('[data-testid="lote-atribuir"] option:not([value="__"]):not([value=""])')
    .first()
    .innerText()
  await p.locator('[data-testid="lote-atribuir"]').selectOption({ label: nome })

  await p.waitForSelector('[data-testid="desfazer"]', { timeout: 10000 })
  ok(true, 'o aviso traz "desfazer" — reversível não precisa de "tem certeza?" antes')

  /* A confirmação sobrevive mesmo quando o lote ESVAZIA a lista filtrada e o
     componente que disparou a ação deixa de existir. Foi o caso que fez esta
     parte ser reescrita. */
  /*
   * Vinte segundos, e o tempo vai impresso — porque ele é o sintoma de um
   * defeito que ainda não está fechado. Medido de dentro da página, com um
   * MutationObserver: depois do lote, a contagem de linhas às vezes troca em
   * ~100ms e às vezes só aos ~15040ms, que é quando o `RealtimeRefresh`
   * periódico passa. Ou seja: nesses casos quem conserta a tela é o relógio, e
   * não a ação. O `router.refresh()` acrescentado em `lista-de-tickets.tsx`
   * aumentou muito a fatia dos ~100ms, mas não eliminou a outra — ver
   * `docs/18`. Um prazo curto aqui reprovaria por um defeito conhecido, e um
   * prazo sem medição esconderia que ele existe.
   */
  const sairam = await ate(
    async () => (await p.locator('tr[data-indice]:visible').count()) === semAtendente - 2,
    20000,
  )
  ok(sairam !== null, `os dois saíram da visão "sem atendente" (${sairam}ms)`)

  /*
   * E o desfazer AINDA está lá. Esta asserção nasceu de uma reprovação: a
   * revalidação da lista filtrada levou 4961ms, e o aviso de sucesso saía de
   * cena aos 5000ms — a janela para desfazer fechava no instante em que a tela
   * terminava de mudar. Por isso um aviso com desfazer agora fica 15 segundos.
   */
  ok(
    (await p.locator('[data-testid="desfazer"]').count()) === 1,
    `o "desfazer" continua na tela depois de a lista terminar de mudar (${sairam}ms)`,
  )

  await p.locator('[data-testid="desfazer"]').click()
  const voltaram = await ate(async () => {
    await p.goto(`${BASE}/tickets?atendente=nenhum`, { waitUntil: 'networkidle' })
    return (await p.locator('tr[data-indice]:visible').count()) === semAtendente
  }, 12000)
  ok(voltaram !== null, `desfazer devolveu os dois para a fila (${semAtendente} de novo)`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. O fio de progresso acende enquanto navega ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/tickets`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(700)
  ok((await p.locator('[data-testid="progresso"]').count()) === 1, 'o fio existe no layout')
  ok(
    (await p.locator('[data-testid="progresso"][data-navegando]').count()) === 0,
    'e fica apagado quando não há nada em curso',
  )

  /* Acender é questão de milissegundos: o laço confere a cada 40ms enquanto o
     filtro navega. A navegação medida leva 110–250ms, então há tempo. */
  await p.locator('[data-testid="filtro-busca"]').fill('servidor')
  let acendeu = false
  for (let i = 0; i < 40; i++) {
    if ((await p.locator('[data-testid="progresso"][data-navegando]').count()) > 0) {
      acendeu = true
      break
    }
    await p.waitForTimeout(40)
  }
  ok(acendeu, 'filtrar acende o fio enquanto a lista nova vem')

  await p.waitForTimeout(1500)
  ok(
    (await p.locator('[data-testid="progresso"][data-navegando]').count()) === 0,
    'e ele apaga quando a tela chega',
  )
}

await ctx.close()
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
