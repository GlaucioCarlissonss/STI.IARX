/*
 * Redefinir a senha pelo link do e-mail (migração 0057).
 *
 * Por que esta suíte existe
 * -------------------------
 * Até a 0057, no modo local — que é o que a VPS roda —, "esqueci a senha" era
 * um no-op declarado: a tela confirmava o envio e nada saía. Com a porta
 * pública em `sti.iarx.com.br`, esse é o fluxo que mais gente vai usar sem
 * ninguém por perto, às onze da noite, já irritado.
 *
 * E é um fluxo que falha BEM: cada peça isolada parece correta. O token é
 * gerado, o e-mail é enfileirado, a tela abre. O que quebra é a emenda — o
 * caminho relativo que não vira link, o token que não bate, a senha que troca
 * mas não entra. Só o percurso inteiro prova.
 *
 * Por que esta é a única suíte que fala com o banco
 * -------------------------------------------------
 * As outras dezessete operam só pela tela, de propósito: testam o que uma
 * pessoa consegue fazer. Esta precisa ler o CORPO DO E-MAIL para achar o link,
 * e e-mail não está na tela de ninguém — `email_outbox` não tem interface (é
 * pendência conhecida). Ler o token por `psql` é a única forma de seguir o
 * percurso de quem recebeu a mensagem.
 *
 * Como rodar: ver `telas.spec.mjs`.
 */
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const BASE = 'http://127.0.0.1:3177'
const EMAIL = 'ana.atendente@iaroffice.com.br'
/* Fixa, e não aleatória: no fim a suíte entra com ela, e uma senha por execução
   deixaria a conta do exemplo com uma senha que ninguém sabe. */
const NOVA = 'senha-trocada-pelo-link'
const ORIGINAL = 'desenvolvimento'

const psql = (q) =>
  execSync(
    `PGPASSWORD=postgres psql -At -h 127.0.0.1 -p 5433 -U postgres -d sti_iarx_dev -c "${q}"`,
  )
    .toString()
    .trim()

let falhas = 0
const ok = (c, m) => {
  if (!c) falhas++
  console.log(`${c ? '  ok  ' : '  FALHOU '} ${m}`)
}

/*
 * IDEMPOTÊNCIA: a espera de um minuto entre pedidos (0057) faria a segunda
 * execução seguida não emitir nada, e a suíte falharia por motivo errado.
 * Limpar o que esta suíte mesma criou é o que a torna repetível — a lição da
 * `faturamento.spec.mjs`, que só rodava uma vez por banco.
 */
psql(`delete from public.email_outbox where kind = 'password_reset'`)
psql(
  `delete from public.auth_tokens where user_id in (select id from public.profiles where lower(email) = lower('${EMAIL}'))`,
)

const b = await chromium.launch()
const ctx = await b.newContext()
const p = await ctx.newPage()

// ---------------------------------------------------------------------------
console.log('\n=== 1. Pedir o link ===')
// ---------------------------------------------------------------------------
await p.goto(`${BASE}/recuperar-senha`, { waitUntil: 'networkidle' })
await p.fill('input[name="email"]', EMAIL)
await p.click('button[type="submit"]')
await p.waitForTimeout(2500)

const respostaComConta = (await p.locator('body').innerText()).replace(/\s+/g, ' ').trim()
/*
 * A frase EXATA da confirmação, e não um `/e-mail/i` genérico.
 *
 * A primeira versão desta asserção procurava `/enviamos|verifique|e-mail/i` —
 * e o rótulo "E-mail" do próprio formulário faz isso casar SEMPRE. Ela passou
 * verde enquanto a ação devolvia erro de configuração e nada era enviado, e o
 * defeito só apareceu duas asserções adiante. Asserção que não consegue falhar
 * é pior que asserção ausente: ela dá garantia onde não há nenhuma.
 */
ok(
  /link de redefini[çc][ãa]o j[áa] est[áa] a caminho/i.test(respostaComConta),
  'a tela confirma o envio com a frase da confirmação, e não com o rótulo do campo',
)
ok(
  psql(`select count(*) from public.email_outbox where kind='password_reset'`) === '1',
  'e o e-mail entra na caixa de saída, que já drena no agendador',
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. E-mail sem conta responde EXATAMENTE a mesma coisa ===')
// ---------------------------------------------------------------------------
/*
 * A asserção central de privacidade desta tela. Responder "não cadastrado" daria
 * a qualquer um um verificador de contas de graça: com uma lista de e-mails
 * vazados, descobre-se em minutos quais têm conta aqui — e onde vale a pena
 * tentar senha.
 */
await p.goto(`${BASE}/recuperar-senha`, { waitUntil: 'networkidle' })
await p.fill('input[name="email"]', 'nao-existe@lugar-nenhum.invalido')
await p.click('button[type="submit"]')
await p.waitForTimeout(2000)

const respostaSemConta = (await p.locator('body').innerText()).replace(/\s+/g, ' ').trim()
ok(respostaSemConta === respostaComConta, 'a resposta é IDÊNTICA — a tela não revela quem tem conta')
ok(
  psql(`select count(*) from public.email_outbox where kind='password_reset'`) === '1',
  'e nenhum e-mail novo foi enfileirado',
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. O que chegou no e-mail ===')
// ---------------------------------------------------------------------------
const corpo = psql(
  `select replace(body_text, chr(10), ' ') from public.email_outbox where kind='password_reset' limit 1`,
)
const token = (corpo.match(/nova-senha\/([a-f0-9]{64})/) || [])[1]
ok(!!token, 'o corpo traz o link com um token de 32 bytes')
/*
 * O corpo guardado traz o caminho RELATIVO, e isso é o desenho, não um defeito:
 * o banco não conhece o domínio, e inventar uma coluna para guardá-lo seria a
 * terceira cópia de uma configuração que já vive em `NEXT_PUBLIC_SITE_URL`.
 * Quem completa é a drenagem, no envio (`completarEnderecos`).
 *
 * Escrevi esta asserção primeiro esperando um link absoluto aqui, e ela falhou
 * apontando para a camada errada. A conversão está provada onde ela acontece:
 * `src/lib/mail/caixa-de-saida.test.ts`, que confere `/nova-senha/` virando
 * endereço completo. O que cabe afirmar aqui é que o caminho gravado é
 * exatamente o que aquela função sabe completar.
 */
ok(
  /(^|\s)\/nova-senha\/[a-f0-9]{64}/.test(corpo),
  'o caminho gravado é o relativo que a drenagem sabe completar no envio',
)
ok(
  psql(`select count(*) from public.auth_tokens where token_hash='${token}'`) === '0',
  'o token NÃO está em claro no banco: o que fica guardado é o sha256 dele',
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. Abrir o link e trocar a senha ===')
// ---------------------------------------------------------------------------
await p.goto(`${BASE}/nova-senha/${token}`, { waitUntil: 'networkidle' })
ok(/Criar nova senha/i.test(await p.locator('body').innerText()), 'o link abre o formulário')

await p.fill('input[name="password"]', NOVA)
await p.fill('input[name="confirm"]', NOVA)
await p.click('button[type="submit"]')
await p.waitForTimeout(2500)
ok(/Senha alterada/i.test(await p.locator('body').innerText()), 'a senha foi alterada')

// ---------------------------------------------------------------------------
console.log('\n=== 5. Uso único ===')
// ---------------------------------------------------------------------------
await p.goto(`${BASE}/nova-senha/${token}`, { waitUntil: 'networkidle' })
ok(
  /sem validade|não vale/i.test(await p.locator('body').innerText()),
  'o mesmo link não abre de novo — e o formulário some, em vez de falhar no envio',
)

await p.goto(`${BASE}/nova-senha/${'a'.repeat(64)}`, { waitUntil: 'networkidle' })
ok(
  /sem validade|não vale/i.test(await p.locator('body').innerText()),
  'token inventado é recusado com a MESMA tela — não se diz por que não vale',
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. A senha nova entra de verdade ===')
// ---------------------------------------------------------------------------
/* O passo que prova que não foi teatro: trocar a senha e não conseguir entrar
   com ela seria o pior desfecho possível, e nenhuma asserção anterior pegaria. */
await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await p.fill('input[name="email"]', EMAIL)
await p.fill('input[name="password"]', NOVA)
await p.click('button[type="submit"]')
await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }).catch(() => {})
ok(!p.url().includes('/login'), `entra com a senha nova (${new URL(p.url()).pathname})`)

// ---------------------------------------------------------------------------
console.log('\n=== 7. O limite por origem, e o cabeçalho forjado (0059) ===')
// ---------------------------------------------------------------------------
/*
 * A espera da 0057 é por CONTA. Esta parte prova o freio que faltava: por
 * ORIGEM — e, principalmente, que ele não se contorna.
 *
 * As requisições acima não têm `X-Forwarded-For`, então a origem é nula e nada
 * é limitado; aqui o cabeçalho é posto de propósito, imitando o Caddy.
 */
psql(`delete from public.request_throttle`)
psql(`delete from public.email_outbox where kind = 'password_reset'`)
psql(`delete from public.auth_tokens`)

const CONTAS = [
  'admin@iaroffice.com.br',
  'gestor@iaroffice.com.br',
  'ana.atendente@iaroffice.com.br',
  'bruno.atendente@iaroffice.com.br',
  'diego.financeiro@iaroffice.com.br',
  'elis.aprovadora@iaroffice.com.br',
  'carla.solicitante@meridiano.com.br',
]

/* O Caddy ACRESCENTA ao cabeçalho: o que o cliente mandou vem primeiro, o que
   ele próprio viu vem por último. `forjado` imita um visitante que tenta
   escolher a própria chave de limite. */
async function pedirDe(ipReal, email, forjado = null) {
  const c = await b.newContext({
    extraHTTPHeaders: { 'x-forwarded-for': forjado ? `${forjado}, ${ipReal}` : ipReal },
  })
  const pg = await c.newPage()
  await pg.goto(`${BASE}/recuperar-senha`, { waitUntil: 'networkidle' })
  await pg.fill('input[name="email"]', email)
  await pg.click('button[type="submit"]')
  await pg.waitForTimeout(800)
  await c.close()
}

const naFila = () =>
  Number(psql(`select count(*) from public.email_outbox where kind='password_reset'`))

for (const conta of CONTAS) await pedirDe('203.0.113.7', conta)
ok(
  naFila() === 5,
  `sete contas da mesma origem, cinco e-mails: o limite conta por ORIGEM (saíram ${naFila()})`,
)

psql(`delete from public.email_outbox where kind='password_reset'`)
psql(`delete from public.auth_tokens`)
await pedirDe('198.51.100.22', CONTAS[0])
ok(naFila() === 1, 'visitante de outra origem não herda o bloqueio')

/*
 * A ASSERÇÃO QUE JUSTIFICA O MÓDULO `src/lib/limite.ts`.
 *
 * `X-Forwarded-For` é lista, e pegar o PRIMEIRO item — o que quase toda
 * biblioteca faz por padrão, e o que parece certo — entregaria a chave do
 * limite a quem está sendo limitado: bastaria um valor novo por requisição.
 * A origem real aqui já estourou o limite acima.
 */
psql(`delete from public.email_outbox where kind='password_reset'`)
psql(`delete from public.auth_tokens`)
for (let i = 0; i < 6; i++) await pedirDe('203.0.113.7', CONTAS[i], `9.9.9.${i}`)
ok(
  naFila() === 0,
  `forjar o X-Forwarded-For NÃO contorna o limite (saíram ${naFila()}, esperado 0)`,
)

ok(
  psql(`select count(*) from public.request_throttle where origem ~ '^[0-9]{1,3}[.]'`) === '0',
  'e nenhum contador guarda algo com cara de IP — o banco nunca vê o endereço',
)

psql(`delete from public.request_throttle`)
psql(`delete from public.email_outbox where kind = 'password_reset'`)

// ---------------------------------------------------------------------------
console.log('\n=== 8. Devolver o exemplo ao estado em que estava ===')
// ---------------------------------------------------------------------------
/*
 * A conta do seed volta à senha de desenvolvimento. Sem isto, as outras suítes
 * — e qualquer pessoa abrindo o ambiente — encontrariam uma conta com senha
 * trocada por um teste.
 */
psql(
  `update auth.users set encrypted_password = crypt('${ORIGINAL}', gen_salt('bf')) where lower(email) = lower('${EMAIL}')`,
)
psql(`delete from public.email_outbox where kind = 'password_reset'`)

/*
 * Contexto NOVO, e não a mesma aba.
 *
 * O passo 6 deixou uma sessão aberta, e `/login` com sessão redireciona para o
 * painel — não há campo de e-mail para preencher. A primeira versão desta suíte
 * falhava exatamente aqui, com "waiting for input[name=email]", que parece
 * defeito da tela de login e é só uma aba já autenticada.
 */
const ctxLimpo = await b.newContext()
const pLimpa = await ctxLimpo.newPage()
await pLimpa.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await pLimpa.fill('input[name="email"]', EMAIL)
await pLimpa.fill('input[name="password"]', ORIGINAL)
await pLimpa.click('button[type="submit"]')
await pLimpa
  .waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 })
  .catch(() => {})
ok(!pLimpa.url().includes('/login'), 'a senha do exemplo foi restaurada')
await ctxLimpo.close()

await ctx.close()
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
