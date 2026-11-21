/*
 * A VIGÊNCIA DA ASSINATURA, pela tela.
 *
 * `tenants.status` existia desde a 0001 e ninguém o lia: avaliação vencida,
 * empresa suspensa e empresa cancelada funcionavam exatamente como uma ativa.
 * Para quem vai vender o sistema, esse era o maior defeito possível — toda
 * empresa que se cadastrasse usaria para sempre, de graça.
 *
 * A regra tem DOIS lados, e esta suíte cobra os dois:
 *
 *  · fora de vigência **não escreve** — senão não há como cobrar;
 *  · fora de vigência **continua lendo** — tirar o acesso ao próprio histórico
 *    de quem atrasou uma fatura é reter dado alheio como garantia, e isso não é
 *    cobrança, é outra coisa.
 *
 * A segunda metade é a que se perde quando alguém "simplifica" a regra para
 * "suspenso não entra". Por isso ela tem mais asserções que a primeira.
 *
 * Esta suíte SUSPENDE a empresa do exemplo e a devolve no `finally`. Deixar o
 * ambiente suspenso faria todas as suítes seguintes falharem por um motivo que
 * não é o delas.
 *
 * Como rodar: ver `telas.spec.mjs`.
 */
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const BASE = 'http://127.0.0.1:3177'
const TENANT = 'a0000000-0000-4000-8000-000000000001'

let falhas = 0
const ok = (c, m) => {
  if (!c) falhas++
  console.log(`${c ? '  ok  ' : '  FALHOU '} ${m}`)
}

const psql = (q) =>
  execSync(`PGPASSWORD=postgres psql -At -h 127.0.0.1 -p 5433 -U postgres -d sti_iarx_dev -c "${q}"`)
    .toString()
    .trim()

const situacao = (status, prazo) =>
  psql(
    `update public.tenants set status='${status}', trial_ends_on=${prazo ? `'${prazo}'` : 'null'} where id='${TENANT}'`,
  )

/*
 * Abrir chamado é o cadastro mais comum do produto — se a tranca falhasse em
 * algum lugar, falharia aqui primeiro.
 *
 * O botão é procurado pelo TEXTO. `form button[type="submit"]` pegava o
 * "Aplicar" `sr-only` da moldura do aplicativo, e o formulário nunca era
 * enviado: a asserção reprovava com a tranca funcionando.
 */
async function tentarAbrirChamado(p, titulo) {
  await p.goto(`${BASE}/tickets/novo`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(500)
  await p.fill('input[name="title"]', titulo)
  const d = p.locator('textarea[name="description"]')
  if (await d.count()) await d.fill('Lançado pela suíte de vigência.')
  await p.locator('button:has-text("Abrir ticket")').first().click()
  await p.waitForTimeout(2500)
  return (await p.locator('main').innerText()).replace(/\s+/g, ' ')
}

const b = await chromium.launch()

async function entrar() {
  const ctx = await b.newContext()
  const p = await ctx.newPage()
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await p.fill('input[name="email"]', 'admin@iaroffice.com.br')
  await p.fill('input[name="password"]', 'desenvolvimento')
  await p.click('button[type="submit"]')
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 })
  return { ctx, p }
}

try {
  // ---------------------------------------------------------------------------
  console.log('\n=== 1. O preparo: a empresa começa ativa ===')
  // ---------------------------------------------------------------------------
  situacao('active', null)
  ok(psql(`select status from public.tenants where id='${TENANT}'`) === 'active',
    'o preparo deixou a empresa ativa')

  {
    const { ctx, p } = await entrar()
    await p.goto(`${BASE}/assinatura`, { waitUntil: 'networkidle' })
    const t = await p.locator('main').innerText()
    ok(/Ativa/.test(t), 'a tela de assinatura mostra "Ativa"')
    ok(!/suspenso/i.test(t), 'e não fala em bloqueio nenhum')
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 2. Suspensa: NÃO escreve ===')
  // ---------------------------------------------------------------------------
  situacao('suspended', null)
  {
    const { ctx, p } = await entrar()

    const resposta = await tentarAbrirChamado(p, 'Chamado da suíte de vigência')
    ok(/fora de vig[êe]ncia/i.test(resposta), 'o cadastro é recusado dizendo que é a assinatura')

    /*
     * A RECUSA PRECISA DIZER O QUE CONTINUA FUNCIONANDO.
     *
     * Sem isso, quem é barrado supõe que perdeu o acesso aos próprios dados — e
     * a primeira ligação é para perguntar se o histórico sumiu. Uma recusa que
     * vira beco sem saída é defeito, mesmo estando certa.
     */
    ok(/consultar/i.test(resposta) && /exportar/i.test(resposta),
      'e diz que consultar e exportar continuam liberados')
    ok(/assinatura/i.test(resposta), 'e aponta para onde ver a situação')

    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 3. Suspensa: CONTINUA lendo — a metade que se perde ===')
  // ---------------------------------------------------------------------------
  {
    const { ctx, p } = await entrar()

    ok(new URL(p.url()).pathname === '/painel', 'quem é da empresa suspensa continua ENTRANDO')

    /* Quatro telas de módulos diferentes: se a tranca tivesse ido parar no
       lugar errado — no proxy, no layout, na sessão — ela derrubaria todas, e
       uma só não mostraria isso. */
    for (const [rota, marca] of [
      ['/tickets', 'Tickets'],
      ['/inventario', 'Inventário'],
      ['/financeiro/titulos-a-pagar', 'Títulos a pagar'],
      ['/auditoria', 'Trilha'],
    ]) {
      await p.goto(BASE + rota, { waitUntil: 'networkidle' })
      await p.waitForTimeout(400)
      const t = await p.locator('main').innerText()
      ok(t.includes(marca) && t.length > 300, `${rota} abre e mostra o conteúdo`)
    }

    await p.goto(`${BASE}/assinatura`, { waitUntil: 'networkidle' })
    const a = (await p.locator('main').innerText()).replace(/\s+/g, ' ')
    ok(/Suspensa/.test(a), 'a tela de assinatura mostra "Suspensa"')
    ok(/Nada foi apagado/i.test(a), 'e afirma que nada foi apagado')
    ok(/Hist[óo]rico/.test(a), 'com o histórico de como se chegou aqui')

    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 4. Avaliação vencida vale o mesmo que suspensa ===')
  // ---------------------------------------------------------------------------
  /* O caso que o banco confere sozinho, sem depender do job: entre o
     vencimento e a próxima execução do agendador, a empresa não pode continuar
     escrevendo. Um agendador parado daria uso ilimitado sem ninguém notar. */
  const ontem = new Date(Date.now() - 864e5).toISOString().slice(0, 10)
  situacao('trial', ontem)
  {
    const { ctx, p } = await entrar()
    const r = await tentarAbrirChamado(p, 'Chamado com avaliação vencida')
    ok(/fora de vig[êe]ncia/i.test(r),
      'avaliação vencida ontem já recusa, sem esperar o job')
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 5. O último dia da avaliação vale inteiro ===')
  // ---------------------------------------------------------------------------
  /* Ninguém combina "até dia 10" querendo dizer "até o dia 9". Comparar com
     instante em vez de data tiraria o acesso às 00h01 do dia do vencimento. */
  const hoje = new Date().toISOString().slice(0, 10)
  situacao('trial', hoje)
  {
    const { ctx, p } = await entrar()
    await p.goto(`${BASE}/assinatura`, { waitUntil: 'networkidle' })
    const t = (await p.locator('main').innerText()).replace(/\s+/g, ' ')
    ok(/Em avalia[çc][ãa]o/.test(t), 'no último dia a empresa ainda está em avaliação')
    ok(!/suspenso/i.test(t), 'e o cadastro continua liberado')
    await ctx.close()
  }
} finally {
  // ---------------------------------------------------------------------------
  console.log('\n=== 6. Devolver o ambiente ===')
  // ---------------------------------------------------------------------------
  /* No `finally`: uma asserção que estoura no meio não pode deixar a empresa do
     exemplo suspensa para todas as suítes seguintes. */
  situacao('active', null)
  ok(psql(`select status from public.tenants where id='${TENANT}'`) === 'active',
    'a empresa voltou a ficar ativa')
  await b.close()
}

console.log(falhas ? `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM` : '\nTODAS AS ASSERÇÕES PASSARAM')
process.exit(falhas === 0 ? 0 : 1)
