/*
 * O QUE A TELA DIZ QUANDO O BANCO ESTÁ FORA.
 *
 * Esta suíte existe por causa de um defeito que só aparece com o PostgreSQL
 * parado — e que por isso nenhuma outra suíte pegaria. Eu o encontrei por
 * acidente, ao subir o servidor com o cluster derrubado.
 *
 * ## O que esta suíte DISCRIMINA, e o que ela só guarda
 *
 * Medido removendo o conserto e rodando-a: **três asserções** ficam vermelhas —
 * as da seção 2 que exigem a mensagem nomear a causa, inocentar a conta e
 * apontar quem resolve. Sem o conserto a tela mostra o erro genérico ("O
 * sistema não conseguiu abrir"), que é honesto e insuficiente: quem não
 * consegue entrar vai desconfiar da própria senha.
 *
 * As asserções NEGATIVAS da seção 2 e a seção 3 inteira **passam sem o
 * conserto**, e isso está escrito aqui de propósito. Elas não provam o
 * conserto: elas guardam contra a volta do defeito que eu vi uma vez e não
 * consegui reproduzir sob demanda — o sistema dizendo "esta conta está
 * desativada" quando o banco é que estava fora. Aquele caminho depende de qual
 * consulta falha primeiro, e some quando outra falha antes.
 *
 * Guarda que passa hoje não é guarda inútil; é guarda que ainda não foi
 * necessária. O que seria desonesto é contá-la como prova.
 *
 * ## Esta suíte PARA O BANCO, e isso é o ponto dela
 *
 * Não há como provar o comportamento sem produzir a condição. O `finally`
 * religa o cluster aconteça o que acontecer — inclusive se uma asserção
 * estourar no meio —, e a última seção confere que ele voltou: uma suíte que
 * deixa o ambiente quebrado é pior que uma suíte ausente, porque tudo o que
 * rodar depois dela falha por um motivo que não é o seu.
 *
 * Como rodar: ver `telas.spec.mjs`. Precisa de permissão para `pg_ctlcluster`.
 */
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const BASE = 'http://127.0.0.1:3177'

let falhas = 0
const ok = (c, m) => {
  if (!c) falhas++
  console.log(`${c ? '  ok  ' : '  FALHOU '} ${m}`)
}

const cluster = (acao) => {
  try {
    execSync(`pg_ctlcluster 16 main ${acao}`, { stdio: 'pipe' })
  } catch {
    /* `start` num cluster já de pé, e `stop` num já parado, saem diferente de
       zero. Nenhum dos dois é falha: o estado desejado é o que importa. */
  }
}
const bancoResponde = () => {
  try {
    execSync('pg_isready -h 127.0.0.1 -p 5433', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const b = await chromium.launch()

try {
  // -------------------------------------------------------------------------
  console.log('\n=== 1. O preparo: o banco está de pé antes de derrubá-lo ===')
  // -------------------------------------------------------------------------
  /* Conferir o preparo ANTES de medir. Se o banco já estivesse fora, tudo
     abaixo passaria sem provar nada — e o verde diria que o conserto funciona
     quando na verdade ninguém o exercitou. */
  ok(bancoResponde(), 'o banco responde no início')
  /* PARAR AQUI se o preparo falhou, em vez de seguir medindo.
     Sem isto, a suíte continua com o banco já fora e as seções seguintes
     "passam" sem terem exercitado a transição que elas existem para provar —
     ou morrem no meio, como esta morreu da primeira vez. */
  if (!bancoResponde()) throw new Error('preparo falhou: o banco não está de pé')

  {
    const ctx = await b.newContext()
    const p = await ctx.newPage()
    await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
    await p.fill('input[name="email"]', 'admin@iaroffice.com.br')
    await p.fill('input[name="password"]', 'desenvolvimento')
    await p.click('button[type="submit"]')
    await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 })
    ok(new URL(p.url()).pathname === '/painel', 'e com ele de pé a entrada funciona')
    await ctx.close()
  }

  // -------------------------------------------------------------------------
  console.log('\n=== 2. Com o banco fora, o login NÃO acusa a senha ===')
  // -------------------------------------------------------------------------
  cluster('stop')
  ok(!bancoResponde(), 'o banco foi derrubado')

  {
    const ctx = await b.newContext()
    const p = await ctx.newPage()
    await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
    await p.fill('input[name="email"]', 'admin@iaroffice.com.br')
    await p.fill('input[name="password"]', 'desenvolvimento')
    await p.click('button[type="submit"]')
    await p.waitForTimeout(4000)

    const texto = (await p.locator('body').innerText()).replace(/\s+/g, ' ')

    /*
     * A ASSERÇÃO QUE DEFINE O CONSERTO. Ela é negativa de propósito: o defeito
     * não era a ausência de uma frase boa, era a presença de uma frase falsa.
     */
    ok(
      !/senha incorret|E-mail ou senha/i.test(texto),
      'não diz "e-mail ou senha incorretos" — a senha estava certa',
    )
    ok(
      !/conta est[áa] desativada/i.test(texto),
      'nem que a conta está desativada — ela está ativa',
    )
    ok(
      /n[ãa]o conseguiu falar com o banco/i.test(texto),
      'diz que não alcançou o banco de dados',
    )
    ok(
      /n[ãa]o é problema da sua conta/i.test(texto),
      'e tira a culpa da conta, para a pessoa não ir tentar outra senha',
    )
    ok(
      /quem cuida do servidor/i.test(texto),
      'e aponta quem pode resolver, em vez do administrador da empresa',
    )

    /* O que NÃO pode aparecer: topologia. Ela vive no log, que é onde serve. */
    ok(
      !/5433|127\.0\.0\.1|ECONNREFUSED|postgres/i.test(texto),
      'sem host, porta nem nome de banco na tela',
    )
    await ctx.close()
  }

  // -------------------------------------------------------------------------
  console.log('\n=== 3. Quem já estava dentro não é acusado de estar desativado ===')
  // -------------------------------------------------------------------------
  /*
   * O outro caminho do mesmo defeito. Aqui a sessão existe: o cookie é válido e
   * a conta está ativa. O que falha é LER o perfil — e isso virava
   * "conta desativada", encerrando a sessão de quem não tinha feito nada.
   */
  {
    const ctx = await b.newContext()
    const p = await ctx.newPage()

    /* A sessão é criada com o banco de pé, e só depois ele cai — que é
       exatamente a sequência real: a pessoa estava trabalhando quando o banco
       caiu. */
    cluster('start')
    for (let i = 0; i < 30 && !bancoResponde(); i++) execSync('sleep 1')
    ok(bancoResponde(), 'o banco volta para a sessão ser criada')

    await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
    await p.fill('input[name="email"]', 'admin@iaroffice.com.br')
    await p.fill('input[name="password"]', 'desenvolvimento')
    await p.click('button[type="submit"]')
    await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 })

    cluster('stop')
    await p.goto(`${BASE}/tickets`, { waitUntil: 'domcontentloaded' }).catch(() => null)
    await p.waitForTimeout(3000)

    const texto = (await p.locator('body').innerText()).replace(/\s+/g, ' ')
    ok(
      !/conta est[áa] desativada/i.test(texto),
      'a queda do banco não é relatada como conta desativada',
    )
    /* E a sessão SOBREVIVE: encerrar o acesso de quem está trabalhando por
       causa de uma queda de infraestrutura é punir a pessoa por um problema que
       não é dela — e, quando o banco voltar, ela teria de entrar de novo. */
    ok(
      !/motivo=inativa/.test(p.url()),
      'e a pessoa não é expulsa para a tela de entrada',
    )
    await ctx.close()
  }
} finally {
  // ---------------------------------------------------------------------------
  console.log('\n=== 4. Devolver o ambiente ===')
  // ---------------------------------------------------------------------------
  /* No `finally`, e não no fim do corpo: uma asserção que estoura no meio não
     pode deixar o banco parado para todas as suítes seguintes. */
  cluster('start')
  let voltou = false
  for (let i = 0; i < 30; i++) {
    if (bancoResponde()) {
      voltou = true
      break
    }
    execSync('sleep 1')
  }
  ok(voltou, 'o banco voltou a responder')
  await b.close()
}

console.log(falhas ? `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM` : '\nTODAS AS ASSERÇÕES PASSARAM')
process.exit(falhas === 0 ? 0 : 1)
