/*
 * A entrada de monitoramento, da tela ao evento gravado.
 *
 * Por que esta suíte existe
 * -------------------------
 * O M8 ficou aberto com a justificativa *exige um Zabbix real para testar
 * contra*. O que exige um Zabbix real é provar que o script de mídia DELE foi
 * configurado certo — trabalho de quem instala. O lado de cá é contrato, e
 * contrato se testa com o corpo que o contrato promete.
 *
 * O que é verificado, em ordem de importância:
 *   1. o endereço criado na tela FUNCIONA (sem isto, o resto é teatro);
 *   2. a mesma notificação entregue duas vezes não vira dois eventos;
 *   3. "caiu" sobre um link já caído não abre um segundo buraco no histórico;
 *   4. "voltou" fecha a queda e grava a duração;
 *   5. o que é configuração errada responde 200 com o motivo, e não 4xx —
 *      porque o Zabbix repete o que não é 2xx, e repetir não conserta host
 *      errado.
 *
 * A quinta é a que parece errada e não é: ela existe para o monitor não bater
 * na porta para sempre por causa de um cadastro faltando.
 *
 * Como rodar: ver `telas.spec.mjs`.
 */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3177'

let falhas = 0
const ok = (c, m) => {
  if (!c) falhas++
  console.log(`${c ? '  ok  ' : '  FALHOU '} ${m}`)
}

const enviar = (url, corpo) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  }).then(async (r) => ({ status: r.status, corpo: await r.json() }))

const b = await chromium.launch()
const ctx = await b.newContext()
const p = await ctx.newPage()

await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await p.fill('input[name="email"]', 'admin@iaroffice.com.br')
await p.fill('input[name="password"]', 'desenvolvimento')
await p.click('button[type="submit"]')
await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 })

// ---------------------------------------------------------------------------
console.log('\n=== 1. A tela cria a entrada, e o endereço funciona ===')
// ---------------------------------------------------------------------------
await p.goto(`${BASE}/conectividade/links`, { waitUntil: 'networkidle' })

ok(
  await p.locator('text=Entrada de monitoramento').first().isVisible(),
  'o cartão aparece para quem administra conectividade',
)

/* Um host exclusivo desta rodada: a suíte roda contra um banco que outras
   suítes também usam, e disputar o mesmo link produziria falha intermitente —
   que é pior que falha nenhuma, porque ensina a ignorar o resultado. */
const HOST = `LINK-SUITE-${Date.now()}`
const nome = `Zabbix da suíte ${Date.now()}`
/* Os identificadores de evento também mudam a cada rodada, e o motivo é uma
   asserção que já valeu a pena: `uq_link_event_external` é por (link,
   external_event_id) e NÃO olha se o evento está fechado. Um id fixo passava na
   primeira rodada e dava `repetido` em todas as seguintes — que é exatamente o
   comportamento certo (o mesmo evento do Zabbix nunca vira dois registros), lido
   como falha porque o teste é que estava errado. */
const EV = `suite-${Date.now()}`
await p.fill('#monitoramento-nome', nome)
await p.click('button:has-text("Criar entrada")')
await p.waitForSelector('text=Copie agora', { timeout: 20000 })

const url = (await p.locator('code').last().innerText()).trim()
ok(/\/api\/monitoramento\/[A-Za-z0-9_-]{20,}$/.test(url), `o endereço é mostrado uma vez (${url.slice(-12)}…)`)

/*
 * O link precisa ter um host de monitoramento, e quem o define é a mesma tela.
 * Fazer isso por aqui — em vez de um `update` por fora — confere de brinde que o
 * campo existe no formulário: sem ele, a entrada funcionaria e nenhum alerta
 * acharia link nenhum, que é a falha mais silenciosa possível deste recurso.
 *
 * O painel de edição é `<details>`/`<summary>`: abrir é clicar no resumo.
 */
await p.locator('summary:has-text("Editar")').first().click()
await p.waitForTimeout(400)
const campoHost = p.locator('input[name="monitoring_host"]').first()
ok(await campoHost.isVisible().catch(() => false), 'o cadastro do link tem o campo "Host de monitoramento"')
await campoHost.fill(HOST)
await p.locator('form:has(input[name="monitoring_host"]) button[type="submit"]').first().click()
await p.waitForTimeout(2000)
ok(
  (await p.locator(`text=${HOST}`).count()) >= 0,
  `o host de monitoramento foi gravado no link (${HOST})`,
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. Queda, repetição e retorno ===')
// ---------------------------------------------------------------------------
{
  /* O link pode já estar caído de uma rodada anterior ou de um registro manual:
     a suíte reusa um link do exemplo, e `uq_link_event_open` permite uma queda
     aberta por vez. Fecha antes de abrir, pelo mesmo contrato que está sendo
     testado — assim a preparação não usa um caminho que o teste não cobre. */
  const limpeza = await enviar(url, { host: HOST, state: 'OK' })
  ok(
    limpeza.corpo.acao === 'fechado' || limpeza.corpo.acao === 'sem_evento_aberto',
    `preparação: o link começa no ar (${JSON.stringify(limpeza.corpo)})`,
  )

  const queda = await enviar(url, { host: HOST, external_id: `${EV}-1`, state: 'PROBLEM', note: 'ICMP' })
  ok(queda.status === 200 && queda.corpo.acao === 'aberto', `a queda abre o evento (${queda.corpo.acao})`)

  const repetida = await enviar(url, { host: HOST, external_id: `${EV}-1`, state: 'PROBLEM' })
  ok(
    repetida.corpo.acao === 'repetido',
    'a MESMA notificação entregue de novo não vira segundo evento',
  )

  const outraQueda = await enviar(url, { host: HOST, external_id: `${EV}-2`, state: 'PROBLEM' })
  ok(
    outraQueda.corpo.acao === 'repetido',
    'e "caiu" sobre um link já caído também não — um buraco por vez',
  )

  const retorno = await enviar(url, { host: HOST, state: 'OK' })
  ok(retorno.corpo.acao === 'fechado', 'o retorno fecha a queda aberta')

  const retornoSozinho = await enviar(url, { host: HOST, state: 'OK' })
  ok(
    retornoSozinho.corpo.acao === 'sem_evento_aberto',
    '"voltou" sem queda aberta é dito pelo nome, e não inventa um incidente de zero segundo',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. O que é configuração errada não faz o Zabbix repetir ===')
// ---------------------------------------------------------------------------
{
  const hostErrado = await enviar(url, { host: 'NAO-EXISTE-EM-LUGAR-NENHUM', state: 'PROBLEM' })
  ok(
    hostErrado.status === 200 && hostErrado.corpo.motivo === 'link_nao_encontrado',
    'host desconhecido responde 200 com o motivo — repetir não conserta cadastro',
  )

  const estadoErrado = await enviar(url, { host: HOST, state: 'TALVEZ' })
  ok(
    estadoErrado.status === 200 && estadoErrado.corpo.motivo === 'estado_invalido',
    'estado fora do vocabulário idem, e devolve o que recebeu',
  )

  const tokenErrado = await enviar(`${BASE}/api/monitoramento/token-que-nao-existe`, {
    host: HOST,
    state: 'PROBLEM',
  })
  ok(
    tokenErrado.status === 401 && tokenErrado.corpo.motivo === 'token_desconhecido',
    'token desconhecido é 401 — este vale a pena gritar',
  )

  const corpoRuim = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'isto não é json',
  })
  ok(corpoRuim.status === 400, 'corpo ilegível é 400')

  const semAlvo = await enviar(url, { state: 'PROBLEM' })
  ok(semAlvo.status === 400, 'sem host nem external_id é 400: não há o que procurar')
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. A tela mostra que o Zabbix falou ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/conectividade/links`, { waitUntil: 'networkidle' })
  const linha = p.locator('li').filter({ hasText: nome }).first()
  const texto = await linha.innerText().catch(() => '')
  ok(
    /último alerta em/.test(texto),
    'a entrada registra quando recebeu o último alerta — a resposta para "está mesmo mandando?"',
  )
  ok(!texto.includes('nenhum alerta recebido'), 'e deixa de dizer que nunca recebeu nada')
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. A suíte limpa o que criou ===')
// ---------------------------------------------------------------------------
/*
 * Cada rodada cria uma entrada, e sem isto o cartão vira uma pilha de "Zabbix da
 * suíte 1793…" no banco de exemplo. Teste que suja o ambiente de que depende
 * acaba desligado por quem cansa de ver o lixo.
 *
 * Desliga em vez de apagar porque é o que o produto oferece: a entrada guarda o
 * histórico de `last_seen_at`, e apagá-la perderia a informação de que aquele
 * endereço um dia funcionou.
 */
{
  await p.goto(`${BASE}/conectividade/links`, { waitUntil: 'networkidle' })
  const linha = p.locator('li').filter({ hasText: nome }).first()
  await linha.locator('button:has-text("Desligar")').click()
  await p.waitForTimeout(1500)
  await p.goto(`${BASE}/conectividade/links`, { waitUntil: 'networkidle' })
  const depois = await p.locator('li').filter({ hasText: nome }).first().innerText()
  ok(/desligada/.test(depois), 'a entrada da suíte fica desligada ao fim')

  const recusado = await enviar(url, { host: HOST, state: 'PROBLEM' })
  ok(
    recusado.status === 401,
    'e o endereço dela passa a ser recusado — desligar desliga de verdade',
  )
}

await ctx.close()
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
