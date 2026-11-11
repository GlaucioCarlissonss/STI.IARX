/*
 * O ciclo de planilha — Fase 7 da unificação (docs/23).
 *
 * Por que esta suíte existe
 * -------------------------
 * A promessa central do importador é uma frase que a tela escreve: "nada é
 * gravado antes da conferência". É uma promessa fácil de quebrar por
 * conveniência — basta alguém achar que gravar "só as linhas certas" na
 * conferência economiza um passo. A §3 conta os clientes antes e depois de
 * conferir, justamente para que essa quebra apareça.
 *
 * A segunda coisa que ela guarda é a UTILIDADE da recusa. Um importador que
 * diz "7 recusadas" e nada mais obriga a pessoa a refazer a planilha inteira —
 * e aí a escolha entre atualizar e pular passa a valer para 312 linhas em vez
 * de 7. Por isso a §4 lê o motivo de cada recusa, e a §7 baixa o arquivo de
 * correção e confere que ele traz a linha original e o porquê.
 *
 * Como rodar: ver `telas.spec.mjs`.
 */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3177'
const SENHA = 'desenvolvimento'
const SUFIXO = String(Date.now()).slice(-6)

/**
 * Um CNPJ VÁLIDO, diferente a cada execução.
 *
 * Os dois precisam ser verdade ao mesmo tempo. Válido, porque o sistema confere
 * o dígito e recusar um número inventado é o comportamento certo — a primeira
 * versão desta suíte usou números de fantasia e reprovou acusando o validador.
 * Diferente a cada execução, porque o CNPJ é a CHAVE: reenviar o mesmo número
 * faz a linha virar "atualiza", e a §4 ficaria contando novas que não há.
 */
function cnpjValido(semente) {
  const doze = String(semente).padStart(12, '0').slice(-12)
  const dv = (base, pesos) => {
    const soma = base.split('').reduce((s, c, i) => s + Number(c) * pesos[i], 0)
    const r = soma % 11
    return r < 2 ? 0 : 11 - r
  }
  const d1 = dv(doze, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  const d2 = dv(doze + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  const c = `${doze}${d1}${d2}`
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`
}

const BASE_CNPJ = Number(SUFIXO) * 100
const CNPJ = {
  padaria: cnpjValido(BASE_CNPJ + 1),
  aurora: cnpjValido(BASE_CNPJ + 2),
  metal: cnpjValido(BASE_CNPJ + 3),
  semRazao: cnpjValido(BASE_CNPJ + 4),
  situacao: cnpjValido(BASE_CNPJ + 5),
  /* Este existe para ser recusado: o último dígito é trocado de propósito. */
  invalido: cnpjValido(BASE_CNPJ + 6).replace(/\d$/, (d) => String((Number(d) + 1) % 10)),
}

/** Uma data de leitura que esta execução ainda não usou. */
const DIA_DA_LEITURA = `${String((Number(SUFIXO) % 28) + 1).padStart(2, '0')}/${String((Number(SUFIXO) % 12) + 1).padStart(2, '0')}/20${20 + (Number(SUFIXO) % 6)}`

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

const corpo = (p) => p.locator('body').innerText()

/** Clica no link e lê o arquivo que o navegador baixou. */
const baixar = async (p, seletor) => {
  const [download] = await Promise.all([
    p.waitForEvent('download', { timeout: 20000 }),
    p.locator(seletor).first().click(),
  ])
  const caminho = await download.path()
  const { readFile } = await import('node:fs/promises')
  return caminho ? readFile(caminho, 'utf8') : ''
}

const esperarTexto = async (p, re, limite = 20000) => {
  const t0 = Date.now()
  let ultimo = ''
  while (Date.now() - t0 < limite) {
    ultimo = await corpo(p)
    if (re.test(ultimo)) return ultimo
    await p.waitForTimeout(150)
  }
  return ultimo
}

/** Quantos clientes a lista mostra — é o número que a §3 compara. */
const contarClientes = async (p) => {
  await p.goto(`${BASE}/clientes`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(400)
  return p.locator('[data-testid="abrir-registro"]').count()
}

/** Envia um CSV montado aqui, sem passar por arquivo em disco. */
const enviar = async (p, recurso, nome, conteudo, conflito = 'update') => {
  await p.goto(`${BASE}/sistema/planilhas`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(300)
  await p.selectOption('#pl-recurso', recurso)
  await p.selectOption('#pl-conflito', conflito)
  await p.setInputFiles('#pl-arquivo', {
    name: nome,
    mimeType: 'text/csv',
    buffer: Buffer.from(conteudo, 'utf8'),
  })
  await p.locator('form:has(#pl-arquivo) button[type="submit"]').click()
}

const { ctx, p } = await entrar('admin@iaroffice.com.br')

// ---------------------------------------------------------------------------
console.log('\n=== 1. A tela existe e oferece os modelos ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/sistema/planilhas`, { waitUntil: 'networkidle' })
  const modelos = await p.locator('[data-testid="baixar-modelo"]').count()
  ok(modelos >= 5, `há ${modelos} modelos para baixar — a resposta de "qual é o formato?"`)

  const texto = await corpo(p)
  ok(
    /nada é gravado antes da conferência/i.test(texto),
    'a tela diz, por escrito, que conferir não grava',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. O modelo traz o cabeçalho e a linha de dicas ===')
// ---------------------------------------------------------------------------
{
  /* Baixado pelo LINK, e não por `page.request`: o caminho da pessoa passa
     pelos cookies do navegador, e foi exatamente aí que a primeira versão
     desta suíte se enganou — ela leu a página de login achando que era CSV e
     declarou alegremente "o modelo baixa (200)". */
  const csv = await baixar(p, '[data-testid="baixar-modelo"]')
  ok(csv.length > 0, `o modelo baixa (${csv.length} bytes)`)
  const [cabecalho, dicas] = csv.replace(/^﻿/, '').split('\r\n')
  ok(/CNPJ/.test(cabecalho) && /Razão social/.test(cabecalho), 'o cabeçalho traz as colunas')
  ok(/APAGUE ESTA LINHA/.test(dicas), 'e a linha de dicas se identifica como descartável')
  ok(/CHAVE/.test(dicas), 'dizendo qual coluna é a chave')
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. Conferir NÃO grava — é a promessa central ===')
// ---------------------------------------------------------------------------
{
  const antes = await contarClientes(p)

  /*
   * Três linhas boas e três problemáticas, de propósito: a prévia precisa
   * mostrar as duas naturezas na mesma tela.
   *
   * Os CNPJs são VÁLIDOS de verdade (dígito verificador conferido), menos o da
   * linha que existe para ser recusada por isso. A primeira versão deste teste
   * usava números inventados e reprovou acusando o validador — que estava
   * certo. Inventar dado de teste que o sistema recusa é o jeito mais rápido
   * de culpar o código pelo teste.
   */
  const csv = [
    'CNPJ;Razão social;Nome fantasia;Situação',
    `${CNPJ.padaria};Padaria do Vale ${SUFIXO};Padaria;ativo`,
    `${CNPJ.aurora};Transportes Aurora ${SUFIXO};Aurora;ativo`,
    `${CNPJ.metal};Metalúrgica Sul ${SUFIXO};Metal Sul;ativo`,
    `${CNPJ.invalido};CNPJ com dígito errado;;ativo`,
    `${CNPJ.semRazao};;Sem razão social;ativo`,
    `${CNPJ.situacao};Situação inexistente ${SUFIXO};;pendente`,
  ].join('\n')

  await enviar(p, 'clientes', `clientes-${SUFIXO}.csv`, csv)
  const texto = await esperarTexto(p, /Planilha conferida/i)
  ok(/Planilha conferida: 6 linha\(s\)/.test(texto), 'a conferência lê as 6 linhas')
  ok(/Nada foi gravado ainda/i.test(texto), 'e diz que nada foi gravado')

  const depois = await contarClientes(p)
  ok(
    depois === antes,
    `e de fato não gravou: ${antes} clientes antes, ${depois} depois da conferência`,
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. A prévia diz, linha a linha, o que vai acontecer ===')
// ---------------------------------------------------------------------------
let LOTE = ''
{
  await p.goto(`${BASE}/sistema/planilhas`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(300)
  await p.locator('[data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(400)
  LOTE = new URL(p.url()).searchParams.get('aberto') ?? ''

  const resumo = await p.locator('[data-testid="resumo-da-importacao"]').innerText()
  ok(/Linhas no arquivo\s*6/.test(resumo.replace(/\n/g, ' ')), 'o resumo conta 6 linhas')
  ok(/Recusadas\s*3/.test(resumo.replace(/\n/g, ' ')), 'três recusadas')
  ok(/Entram novas\s*3/.test(resumo.replace(/\n/g, ' ')), 'e três que entram novas')

  const gaveta = await p.locator('[data-testid="gaveta"]').innerText()
  ok(/dígito verificador/i.test(gaveta), 'a recusa do CNPJ diz que o dígito não confere')
  ok(/Razão social é obrigatório/i.test(gaveta), 'a da razão social diz qual campo faltou')
  ok(
    /Use: ativo, inativo, prospecto/i.test(gaveta),
    'e a da situação lista os valores aceitos, em vez de só recusar',
  )

  const linhas = await p.locator('[data-testid="linha-da-importacao"]').count()
  ok(linhas === 6, `as ${linhas} linhas aparecem, com as recusadas na frente`)

  const primeira = await p.locator('[data-testid="linha-da-importacao"]').first().innerText()
  ok(/recusada/i.test(primeira), 'a primeira da lista é uma recusada — é o que se quer ver')
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. As 3 recusadas não impedem as 3 boas ===')
// ---------------------------------------------------------------------------
{
  const antes = await contarClientes(p)

  await p.goto(`${BASE}/sistema/planilhas?aberto=${LOTE}`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(400)
  await p.locator('[data-testid="gaveta"] button:has-text("Aplicar 3 linha(s)")').click()
  const texto = await esperarTexto(p, /Importação aplicada/i)
  ok(/3 criada\(s\)/.test(texto), `o retorno diz quantas entraram ("${texto.match(/Importação aplicada[^\n]*/)?.[0] ?? ''}")`)

  const depois = await contarClientes(p)
  ok(depois === antes + 3, `a lista de clientes vai de ${antes} para ${depois}`)

  const lista = await corpo(p)
  ok(
    new RegExp(`Padaria do Vale ${SUFIXO}`).test(lista),
    'e o cliente da planilha está lá, pelo nome',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. Reenviar o MESMO arquivo não duplica ===')
// ---------------------------------------------------------------------------
{
  const antes = await contarClientes(p)
  const csv = [
    'CNPJ;Razão social;Nome fantasia',
    `${CNPJ.padaria};Padaria do Vale ${SUFIXO} (corrigida);Padaria`,
  ].join('\n')

  await enviar(p, 'clientes', `reenvio-${SUFIXO}.csv`, csv)
  await esperarTexto(p, /Planilha conferida/i)

  await p.goto(`${BASE}/sistema/planilhas`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(300)
  await p.locator('[data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(400)

  const resumo = await p.locator('[data-testid="resumo-da-importacao"]').innerText().then((t) => t.replace(/\n/g, ' '))
  ok(/Atualizam\s*1/.test(resumo), 'a linha cujo CNPJ já existe aparece como ATUALIZA, não como nova')
  ok(/Entram novas\s*0/.test(resumo), 'e nenhuma entra nova — é o que impede o segundo clique duplicar')

  await p.locator('[data-testid="gaveta"] button:has-text("Aplicar 1 linha(s)")').click()
  await esperarTexto(p, /Importação aplicada/i)

  const depois = await contarClientes(p)
  ok(depois === antes, `a contagem não mudou: ${antes} antes, ${depois} depois`)

  const lista = await corpo(p)
  ok(
    new RegExp(`Padaria do Vale ${SUFIXO} \\(corrigida\\)`).test(lista),
    'mas o nome foi atualizado — ela atualizou em vez de criar',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. O arquivo de correção traz a linha original e o motivo ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/sistema/planilhas?aberto=${LOTE}`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(500)
  const csv = (await baixar(p, '[data-testid="baixar-recusadas"]')).replace(/^﻿/, '')
  ok(csv.length > 0, `o arquivo das recusadas baixa (${csv.length} bytes)`)
  const linhas = csv.trim().split('\r\n')
  ok(linhas.length === 4, `traz as 3 recusadas mais o cabeçalho (${linhas.length} linhas)`)
  ok(/Linha original/.test(linhas[0]), 'com o número da linha no arquivo que a pessoa tem aberto')
  ok(/Motivo da recusa/.test(linhas[0]), 'e com a coluna de motivo')
  ok(/dígito verificador/.test(csv), 'o motivo vem escrito, e não um código')
  ok(csv.includes(CNPJ.invalido), 'e o conteúdo original da linha está preservado')
}

// ---------------------------------------------------------------------------
console.log('\n=== 8. Pular é uma escolha, e ela vale ===')
// ---------------------------------------------------------------------------
{
  const csv = [
    'CNPJ;Razão social',
    `${CNPJ.padaria};Nome que NÃO deve entrar ${SUFIXO}`,
  ].join('\n')

  await enviar(p, 'clientes', `pular-${SUFIXO}.csv`, csv, 'skip')
  await esperarTexto(p, /Planilha conferida/i)

  await p.goto(`${BASE}/sistema/planilhas`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(300)
  await p.locator('[data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(400)

  const resumo = await p.locator('[data-testid="resumo-da-importacao"]').innerText().then((t) => t.replace(/\n/g, ' '))
  ok(/Puladas\s*1/.test(resumo), 'escolhendo pular, a linha existente é pulada')

  /* Preso à GAVETA: o cabeçalho tem um botão "Aplicar" escondido (o seletor de
     empresa em foco), e `button:has-text("Aplicar")` solto pegava aquele. */
  await p.locator('[data-testid="gaveta"] button:has-text("Aplicar")').first().click()
  const texto = await esperarTexto(p, /Nada a aplicar|Importação aplicada/i)
  ok(/Nada a aplicar/i.test(texto), 'e aplicar não grava nada')

  await p.goto(`${BASE}/clientes`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(400)
  ok(
    !new RegExp(`Nome que NÃO deve entrar ${SUFIXO}`).test(await corpo(p)),
    'o nome da planilha pulada não aparece — pular pulou de verdade',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 9. Erro de planilha é dito antes de ler as linhas ===')
// ---------------------------------------------------------------------------
{
  /* Sem a coluna-chave, 300 linhas produziriam 300 recusas iguais e afogariam
     a única mensagem que resolve o problema. */
  await enviar(p, 'clientes', `sem-chave-${SUFIXO}.csv`, 'Razão social;Fantasia\nAcme;Acme')
  const texto = await esperarTexto(p, /não tem a coluna/i)
  ok(/não tem a coluna “CNPJ”/i.test(texto), 'a planilha sem a coluna-chave é recusada por inteiro')
  ok(/cabeçalho enviado foi/i.test(texto), 'e a mensagem mostra o cabeçalho que veio')

  await enviar(p, 'clientes', `vazia-${SUFIXO}.csv`, 'CNPJ;Razão social')
  ok(
    /só tem o cabeçalho/i.test(await esperarTexto(p, /só tem o cabeçalho/i)),
    'planilha só com cabeçalho é dita pelo nome',
  )

  await enviar(p, 'clientes', `planilha-${SUFIXO}.xlsx`, 'qualquer coisa')
  ok(
    /Salvar como/i.test(await esperarTexto(p, /Salvar como/i)),
    'e o .xlsx é recusado ANTES de ler, com a instrução de como converter',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 10. Leitura de medidor: o volume de verdade ===')
// ---------------------------------------------------------------------------
{
  const csv = [
    'Patrimônio;Data da leitura;Leitura',
    `EQP-0412;${DIA_DA_LEITURA};9.500`,
    `EQP-0501;${DIA_DA_LEITURA};3.200`,
    `EQP-INEXISTENTE;${DIA_DA_LEITURA};100`,
    'EQP-0412;31/02/2026;9.700',
  ].join('\n')

  await enviar(p, 'leituras', `leituras-${SUFIXO}.csv`, csv)
  await esperarTexto(p, /Planilha conferida/i)

  await p.goto(`${BASE}/sistema/planilhas`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(300)
  await p.locator('[data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
  await p.waitForTimeout(400)

  const gaveta = await p.locator('[data-testid="gaveta"]').innerText()
  ok(
    /não há equipamento com “EQP-INEXISTENTE”/i.test(gaveta),
    'o patrimônio que não existe é recusado dizendo o que se procurou',
  )
  ok(/a data “31\/02\/2026” não existe/i.test(gaveta), 'e a data impossível não é "consertada" em silêncio')

  const resumo = await p.locator('[data-testid="resumo-da-importacao"]').innerText().then((t) => t.replace(/\n/g, ' '))
  ok(/Entram novas\s*2/.test(resumo), 'as duas leituras boas entram')

  await p.locator('[data-testid="gaveta"] button:has-text("Aplicar 2 linha(s)")').click()
  await esperarTexto(p, /Importação aplicada/i)

  await p.goto(`${BASE}/locacao/medicoes`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(600)
  ok(/EQP-0412/.test(await corpo(p)), 'e a medição aparece na tela de medições')
}

// ---------------------------------------------------------------------------
console.log('\n=== 11. Quem não administra não importa ===')
// ---------------------------------------------------------------------------
{
  const { ctx: c2, p: p2 } = await entrar('gestor@iaroffice.com.br')
  await p2.goto(`${BASE}/sistema/planilhas`, { waitUntil: 'networkidle' })
  await p2.waitForTimeout(500)

  const destino = new URL(p2.url()).pathname
  if (destino === '/sistema/planilhas') {
    ok(
      (await p2.locator('#pl-arquivo').count()) === 0,
      'o gestor pode ver o histórico, mas não recebe o formulário de envio',
    )
  } else {
    ok(true, `o gestor nem alcança a tela (foi para ${destino})`)
  }
  await c2.close()
}

await ctx.close()
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
