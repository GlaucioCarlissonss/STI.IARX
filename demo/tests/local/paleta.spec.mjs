/*
 * A paleta de comandos e o menu de celular — Fase 1 da revisão de usabilidade.
 *
 * Por que esta suíte existe
 * -------------------------
 * A paleta é atalho de teclado, busca em rede e navegação, as três coisas que
 * quebram em silêncio: o atalho deixa de disparar porque outro componente
 * passou a escutar a tecla, a busca devolve o resultado da letra anterior, e o
 * Enter navega para o item errado quando a lista muda debaixo do cursor.
 *
 * E tem uma asserção que não é de interface, é de SEGURANÇA: a busca não pode
 * virar a porta dos fundos de telas que a pessoa não alcança pelo menu. Quem
 * recorta por tenant é o RLS; quem recorta por módulo é a permissão granular, e
 * é ela que está testada aqui.
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
 * Abre a paleta e ESPERA ela existir.
 *
 * O atalho é um listener de `keydown` registrado pelo React: antes da
 * hidratação ele não existe, e a tecla cai no vazio. Isso vale para qualquer
 * atalho de qualquer aplicação — não é defeito, é o custo de JavaScript. O que
 * seria defeito é um teste que pressiona cedo demais e chama de falha.
 *
 * A segunda tentativa cobre a corrida; se nem assim abrir, aí é defeito de
 * verdade e a asserção seguinte reprova.
 */
async function abrirPaleta(pagina) {
  /*
   * Três tentativas e oito segundos cada, e não duas de três.
   *
   * A versão anterior falhava de vez em quando — sempre dentro da bateria
   * completa, nunca sozinha. Não era corrida de hidratação: era o servidor
   * atendendo vinte suítes seguidas e levando mais de três segundos para
   * responder. Com a suíte isolada passando quatro vezes em quatro, o veredito
   * "defeito da paleta" estaria errado.
   *
   * Prazo curto num teste de interface não torna o teste mais rigoroso — torna
   * o resultado dependente de quanto a máquina estava ocupada, e um verde que
   * depende disso não significa nada. O rigor está na asserção seguinte, que
   * reprova se a paleta não abrir de jeito nenhum.
   */
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    await pagina.keyboard.press('Control+k')
    try {
      await pagina.waitForSelector('[data-testid="paleta"]', { timeout: 8000 })
      return true
    } catch {
      await pagina.waitForTimeout(600)
    }
  }
  return false
}

const itens = (p) =>
  p.$$eval('[data-escolhido]', (ns) => ns.map((n) => n.innerText.replace(/\n+/g, ' · ').trim()))

/**
 * Digita e espera a resposta CHEGAR, em vez de esperar um tempo.
 *
 * A busca tem 350ms de espera antes de sair mais a ida ao servidor. Com os
 * 500ms fixos que estavam aqui, a asserção de "acha a tela pelo nome"
 * reprovava em duas execuções de cada três — e o campo tinha o texto certo, a
 * resposta é que ainda não tinha voltado. Falha por corrida é pior que falha
 * por defeito: ensina a ignorar a suíte.
 */
async function buscar(pagina, texto, condicao = (r) => r.length > 0, limite = 8000) {
  /*
   * O FOCO, ANTES DE DIGITAR — e foi isto que reprovou na varredura completa.
   *
   * `abrirPaleta()` espera o CONTÊINER aparecer, não o campo receber foco. O
   * foco é posto depois da montagem, e numa varredura inteira o `type()`
   * disparava antes disso: as teclas iam para lugar nenhum e a paleta ficava
   * mostrando a lista PADRÃO.
   *
   * A reprovação dizia "não achou Fluxo de caixa", o que parecia busca lenta ou
   * recorte errado. O diagnóstico que a suíte passou a imprimir mostrou os 12
   * itens da lista de campo vazio — Visão geral, Portal, Tickets… —, e aí ficou
   * claro que a busca nunca tinha rodado.
   *
   * Clicar no campo é o que garante o foco sem depender de quando o autofoco
   * acontece. Esperar um tempo fixo trocaria uma corrida por outra.
   */
  const campo = pagina.locator('[data-testid="paleta"] input')
  await campo.waitFor({ state: 'visible', timeout: 8000 })
  await campo.click()
  await pagina.keyboard.type(texto)
  const t0 = Date.now()
  let r = []
  while (Date.now() - t0 < limite) {
    r = await itens(pagina)
    if (condicao(r)) return r
    await pagina.waitForTimeout(100)
  }
  return r
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. O atalho abre de qualquer tela ===')
// ---------------------------------------------------------------------------
const { ctx, p } = await entrar('admin@iaroffice.com.br')
{
  ok(
    await p.locator('[data-testid="abrir-paleta"]').isVisible(),
    'a caixa de busca aparece no cabeçalho — atalho que ninguém descobre é segredo',
  )

  for (const rota of ['/painel', '/tickets', '/financeiro/titulos-a-pagar']) {
    await p.goto(BASE + rota, { waitUntil: 'networkidle' })
    ok(await abrirPaleta(p), `abre em ${rota}`)
    await p.keyboard.press('Escape')
    await p.waitForTimeout(200)
    ok(!(await p.locator('[data-testid="paleta"]').isVisible()), `e Esc fecha em ${rota}`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. Telas, ações e registros na mesma caixa ===')
// ---------------------------------------------------------------------------
{
  await abrirPaleta(p)
  /*
   * A CONDIÇÃO DA ESPERA É A MESMA DA ASSERÇÃO, e isso não é zelo.
   *
   * Aqui estava a condição padrão (`r.length > 0`), que devolve assim que
   * QUALQUER resultado aparece. A asserção, porém, cobra um resultado
   * específico — a tela com o grupo ao lado. Sob carga, um render intermediário
   * satisfazia a espera antes de a linha certa chegar, e a asserção reprovava
   * com a paleta funcionando perfeitamente.
   *
   * Foi assim que esta suíte reprovou numa varredura completa e passou sozinha:
   * o sintoma de uma espera que mede outra coisa, e não o de um defeito.
   */
  const temATela = (r) => r.some((x) => /Fluxo de caixa/.test(x) && /Financeiro/.test(x))
  const r = await buscar(p, 'fluxo', temATela)
  /*
   * QUANDO ESTA REPROVAR, ELA DIZ O QUE VIU.
   *
   * Esta asserção reprova na varredura COMPLETA (duas de duas) e passa em todo
   * recorte menor que se tentou: sozinha, sob carga de quatro suítes em
   * paralelo, logo depois de `esferas`, e depois das cinco que a antecedem na
   * ordem. O que ainda não foi reproduzido é a sequência inteira contra um
   * servidor de vida longa.
   *
   * Sem esta linha, o relatório diz apenas "FALHOU" e a investigação recomeça
   * do zero a cada varredura — quarenta minutos para produzir a mesma frase.
   * Com ela, a próxima reprovação entrega a lista que a paleta devolveu, que é
   * o dado que falta: se vier vazia, a busca não voltou; se vier cheia sem a
   * tela, o recorte mudou.
   *
   * Afrouxar a asserção faria o vermelho sumir sem explicar nada, e um verde
   * que não se entende não é melhor que um vermelho que não se entende.
   */
  if (!temATela(r)) {
    console.log(`         a paleta devolveu ${r.length} item(ns): ${JSON.stringify(r).slice(0, 500)}`)
  }
  ok(temATela(r), 'acha a tela pelo nome, com o grupo ao lado para dar contexto')

  await p.fill('[data-testid="paleta"] input', '')
  const comRegistro = await buscar(p, 'servidor', (r) => r.some((x) => /#\d+\s+Servidor/.test(x)))
  ok(
    comRegistro.some((x) => /#\d+\s+Servidor/.test(x)),
    'acha o CHAMADO pelo título, sem passar pela tela de tickets',
  )
  ok(
    comRegistro.some((x) => /Aberto/.test(x)),
    'e mostra o estado na língua da tela, não `open` do banco',
  )

  /* O número puro é como as pessoas se referem ao chamado no telefone. */
  await p.fill('[data-testid="paleta"] input', '')
  const porNumero = await buscar(p, '5', (r) => r.some((x) => /#5\s/.test(x)))
  ok(
    porNumero.some((x) => /#5\s/.test(x)),
    'número puro acha o chamado pelo NÚMERO',
  )

  await p.keyboard.press('Escape')
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. Teclado: anda, abre, e não trava no fim ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/painel`, { waitUntil: 'networkidle' })
  await abrirPaleta(p)
  await p.keyboard.type('satisfa')
  await p.waitForTimeout(500)

  const escolhido = () =>
    p.$eval('[data-escolhido="1"]', (n) => n.innerText.replace(/\n+/g, ' · ').trim())
  const primeiro = await escolhido()
  await p.keyboard.press('ArrowDown')
  await p.waitForTimeout(150)
  /* Com um resultado só, descer volta nele mesmo — a lista é cíclica de
     propósito: travar no fim parece defeito. */
  ok((await escolhido()) !== null, `a seta anda sem travar (de "${primeiro}")`)

  await p.keyboard.press('Enter')
  await p.waitForTimeout(1200)
  ok(new URL(p.url()).pathname === '/satisfacao', 'Enter abre a tela escolhida')
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. A busca NÃO é porta dos fundos ===')
// ---------------------------------------------------------------------------
{
  /*
   * Diego é Operador Financeiro: no exemplo, o único perfil que NÃO alcança
   * inventário, chamados nem clientes. A busca não pode entregar o que o menu
   * esconde — é a asserção que impede a paleta de virar um vazamento com cara
   * de conveniência.
   *
   * A escolha do perfil importa e já custou uma correção: a primeira versão
   * deste teste usou a Solicitante, supondo que ela não visse inventário. Ela
   * VÊ — o perfil Solicitante tem leitura de ativos no exemplo. O teste
   * reprovava um código correto, que é o pior tipo de teste: ele teria levado a
   * "consertar" o que não estava quebrado.
   */
  const { ctx: c2, p: p2 } = await entrar('diego.financeiro@iaroffice.com.br')
  ok(await abrirPaleta(p2), 'a paleta abre para o Operador Financeiro também')

  await p2.keyboard.type('dell')
  await p2.waitForTimeout(900)
  const r = await itens(p2)
  ok(
    !r.some((x) => /PAT-|Latitude/i.test(x)),
    `quem não vê inventário não recebe ATIVO na busca (viu: ${r.join(' | ') || 'nada'})`,
  )

  await p2.fill('[data-testid="paleta"] input', '')
  await p2.keyboard.type('servidor')
  await p2.waitForTimeout(900)
  const r2 = await itens(p2)
  ok(
    !r2.some((x) => /#\d+/.test(x)),
    `nem CHAMADO, que ele também não alcança (viu: ${r2.join(' | ') || 'nada'})`,
  )

  await p2.fill('[data-testid="paleta"] input', '')
  await p2.keyboard.type('invent')
  await p2.waitForTimeout(500)
  ok(
    !(await itens(p2)).some((x) => /Inventário de TI/.test(x)),
    'nem a TELA de inventário, que o menu dele não mostra',
  )

  /* E a prova de que a paleta não está só vazia para ele: o que é dele, aparece. */
  await p2.fill('[data-testid="paleta"] input', '')
  await p2.keyboard.type('banc')
  await p2.waitForTimeout(500)
  ok(
    (await itens(p2)).some((x) => /Contas bancárias/.test(x)),
    'mas o que é do financeiro aparece — a paleta recorta, não apaga',
  )
  await c2.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. Celular: gaveta no lugar da tira ===')
// ---------------------------------------------------------------------------
{
  const cel = await b.newContext({
    viewport: { width: 390, height: 844 },
    storageState: await ctx.storageState(),
  })
  const pc = await cel.newPage()
  await pc.goto(`${BASE}/tickets`, { waitUntil: 'networkidle' })
  await pc.waitForTimeout(500)

  ok(
    (await pc.locator('nav.fixed.inset-x-0.bottom-0').count()) === 0,
    'a tira horizontal de 30 itens não existe mais',
  )

  await pc.locator('[data-testid="abrir-menu-celular"]').click()
  await pc.waitForTimeout(400)
  ok(await pc.locator('[data-testid="gaveta-menu"]').isVisible(), 'a gaveta abre')
  /* O número não é fixo desde as esferas (0047): uma empresa com os dois
     negócios tem um grupo a mais que uma com um só. O que o teste cobra é o que
     ele sempre quis dizer — que o celular mostra os MESMOS grupos do desktop,
     porque é o mesmo componente e não uma cópia. */
  const noCelular = await pc.$$eval('[data-testid="gaveta-menu"] summary', (ns) =>
    ns.map((n) => n.innerText.trim()),
  )
  const noDesktop = await p.$$eval('nav[aria-label="Navegação principal"] summary', (ns) =>
    ns.map((n) => n.innerText.trim()),
  )
  ok(
    noCelular.length > 0 && noCelular.join('|') === noDesktop.join('|'),
    `com os MESMOS ${noDesktop.length} grupos do desktop — um componente, não uma cópia`,
  )

  /* Navegar é a tarefa: a gaveta sai da frente sozinha. */
  await pc.locator('[data-testid="gaveta-menu"] a[href="/painel"]').first().click()
  await pc.waitForTimeout(1200)
  ok(
    !(await pc.locator('[data-testid="gaveta-menu"]').isVisible()),
    'e fecha ao escolher um destino, em vez de tapar a tela nova',
  )
  await cel.close()
}

await ctx.close()
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
