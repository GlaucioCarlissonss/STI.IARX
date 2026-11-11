/*
 * A gaveta e a edição na linha — Fase 3 da revisão de usabilidade.
 *
 * Por que esta suíte existe
 * -------------------------
 * A Fase 3 acrescenta dois mecanismos que falham de um jeito convincente, que é
 * o pior tipo de falha:
 *
 *  - **A gaveta** vive no endereço. Se o parâmetro deixar de chegar à consulta,
 *    a tela continua funcionando e simplesmente não abre nada — sem erro, sem
 *    sintoma, e a pessoa conclui que "o chamado sumiu".
 *  - **A edição otimista** mostra o valor novo antes da resposta do servidor.
 *    Se a reversão quebrar, a tela passa a dizer "salvo" para o que o banco
 *    recusou. É o defeito mais caro possível numa lista de chamados: a pessoa
 *    segue o dia acreditando num estado que não existe.
 *
 * A asserção §4 é a que prova a volta honesta, e ela força uma transição que a
 * máquina de estados do banco recusa — de propósito.
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

const tituloDaGaveta = (p) => p.locator('[data-testid="gaveta"] h2').innerText()

/**
 * Espera a gaveta sumir.
 *
 * Esperar um tempo fixo reprovava a tela de links por ela ser a mais pesada do
 * grupo: a gaveta fechava, mas depois do prazo do teste. Falha por corrida é
 * pior que falha por defeito — ensina a desconfiar da suíte.
 *
 * ## O que este prazo pegou
 *
 * Com oito segundos, /sla e /conectividade/links reprovavam uma execução em
 * cada três, sempre nesta asserção. Subir para vinte não resolveu — e foi isso
 * que entregou o defeito: quando falha, a gaveta não fecha em vinte segundos
 * nem em um minuto, e o ENDEREÇO não muda. O `push` do roteador se perdia, e a
 * tecla não fazia nada. A correção está em `components/gaveta.tsx` (fechar
 * insiste três vezes); o que resta aqui é o prazo folgado, para que uma
 * lentidão real não seja confundida com aquele defeito, e o tempo decorrido
 * impresso quando passar de três segundos.
 */
async function gavetaFecha(pagina, limite = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < limite) {
    if ((await pagina.locator('[data-testid="gaveta"]').count()) === 0) {
      const ms = Date.now() - t0
      if (ms > 3000) console.log(`         (a gaveta levou ${ms}ms para fechar)`)
      return true
    }
    await pagina.waitForTimeout(120)
  }
  return false
}

const { ctx, p } = await entrar('admin@iaroffice.com.br')

// ---------------------------------------------------------------------------
console.log('\n=== 1. A gaveta abre ao lado, e é um endereço ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/tickets`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(600)

  const primeiro = await p.locator('tr[data-indice="0"] [data-testid="abrir-chamado"]').innerText()
  await p.locator('tr[data-indice="0"] [data-testid="abrir-chamado"]').click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 10000 })

  ok(/aberto=/.test(p.url()), 'abrir um chamado vira parâmetro no endereço')
  ok((await tituloDaGaveta(p)).startsWith(primeiro.slice(0, 20)), 'e a gaveta traz o chamado certo')
  ok(
    (await p.locator('tr[data-indice="0"][data-aberto="1"]').count()) === 1,
    'a linha correspondente fica marcada como aberta',
  )
  ok(
    (await p.locator('[data-testid="gaveta"] a:has-text("página inteira")').count()) === 1,
    'e o caminho para a página inteira continua à vista',
  )

  /* O endereço é a prova de que isso se manda para outra pessoa. */
  const endereco = p.url()
  const { ctx: c2, p: p2 } = await entrar('admin@iaroffice.com.br')
  await p2.goto(endereco, { waitUntil: 'networkidle' })
  await p2.waitForSelector('[data-testid="gaveta"]', { timeout: 10000 })
  ok((await tituloDaGaveta(p2)) === (await tituloDaGaveta(p)), 'o mesmo link abre a mesma gaveta')
  await c2.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. Esc fecha, e a lista continua onde estava ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/tickets?status=todos`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(500)
  const antes = await p.locator('tr[data-indice]:visible').count()

  await p.locator('tr[data-indice="1"] [data-testid="abrir-chamado"]').click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 10000 })

  await p.keyboard.press('Escape')
  await p.waitForTimeout(900)
  ok((await p.locator('[data-testid="gaveta"]').count()) === 0, 'Esc fecha a gaveta')
  ok(!/aberto=/.test(p.url()), 'e tira o parâmetro do endereço')
  ok(/status=todos/.test(p.url()), 'sem levar embora o filtro que estava aplicado')
  ok(
    (await p.locator('tr[data-indice]:visible').count()) === antes,
    'a lista continua a mesma — fechar não é recomeçar',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. Com a gaveta aberta, J e K trocam o chamado ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/tickets?status=todos`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(500)
  await p.locator('tr[data-indice="0"] [data-testid="abrir-chamado"]').click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 10000 })
  const primeiro = await tituloDaGaveta(p)

  await p.keyboard.press('j')
  await p.waitForTimeout(1500)
  const segundo = await tituloDaGaveta(p)
  ok(segundo !== primeiro, `J passa para o próximo sem fechar ("${primeiro}" → "${segundo}")`)

  await p.keyboard.press('k')
  await p.waitForTimeout(1500)
  ok((await tituloDaGaveta(p)) === primeiro, 'e K volta')

  /* A triagem só existe porque a lista NÃO perde o contexto. */
  ok(
    (await p.locator('tr[data-indice]:visible').count()) > 1,
    'a lista continua visível ao lado durante a triagem',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. Edição na linha: aplica, e desfaz quando o banco recusa ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/tickets?status=todos`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(600)

  /* a) O caminho que funciona: atribuir pela própria linha. */
  const seletor = p.locator('tr[data-indice="0"] [data-testid="editar-atendente"]')
  const nome = await p
    .locator('tr[data-indice="0"] [data-testid="editar-atendente"] option:not([value=""])')
    .first()
    .innerText()
  await seletor.selectOption({ label: nome })
  await p.waitForTimeout(2500)
  await p.reload({ waitUntil: 'networkidle' })
  await p.waitForTimeout(600)
  ok(
    (await p.locator('tr[data-indice="0"]').innerText()).includes(nome),
    `atribuir na linha grava mesmo (${nome})`,
  )

  /* b) O caminho que recusa. A máquina de estados do banco (ADR-007) só aceita
        as transições da tabela; o seletor da linha oferece apenas essas, então
        para provar a VOLTA é preciso forçar uma proibida — é o que faz este
        trecho, injetando a opção no DOM, exatamente como faria quem editasse a
        página pelo inspetor. A tela tem que recusar e desfazer. */
  const statusSel = p.locator('tr[data-indice="0"] [data-testid="editar-status"]')
  const antes = await p.locator('tr[data-indice="0"] [data-testid="editar-status"]').inputValue()
  const proibido = antes === 'resolved' ? 'triage' : 'resolved'

  await p.evaluate(
    ([valor]) => {
      const s = document.querySelector('tr[data-indice="0"] [data-testid="editar-status"]')
      const o = document.createElement('option')
      o.value = valor
      o.textContent = valor
      s.appendChild(o)
    },
    [proibido],
  )
  await statusSel.selectOption(proibido)
  await p.waitForTimeout(2500)

  const erro = p.locator('tr[data-indice="0"] [data-testid="erro-edicao"]')
  ok(await erro.isVisible(), 'uma transição proibida produz mensagem de erro na própria linha')
  ok(
    (await statusSel.inputValue()) === antes,
    `e o valor VOLTA ao que era (${antes}) — nunca fica um "salvo" que não salvou`,
  )

  await p.reload({ waitUntil: 'networkidle' })
  await p.waitForTimeout(600)
  ok(
    (await p.locator('tr[data-indice="0"] [data-testid="editar-status"]').inputValue()) === antes,
    'e o banco confirma: nada foi gravado',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. Quem não pode editar vê TEXTO, não controle inerte ===')
// ---------------------------------------------------------------------------
{
  /* Carla é Solicitante: vê chamados, não atribui nem muda status. */
  const { ctx: c3, p: p3 } = await entrar('carla.solicitante@meridiano.com.br')
  await p3.goto(`${BASE}/tickets?status=todos`, { waitUntil: 'networkidle' })
  await p3.waitForTimeout(600)

  ok((await p3.locator('tr[data-indice]:visible').count()) > 0, 'a Solicitante vê a lista')
  ok(
    (await p3.locator('[data-testid="editar-status"]').count()) === 0 &&
      (await p3.locator('[data-testid="editar-atendente"]').count()) === 0,
    'e nenhum seletor de edição aparece para ela',
  )
  ok(
    (await p3.locator('select[disabled]').count()) === 0,
    'nem desabilitado — controle inerte não explica nada e ainda rouba tabulação',
  )

  await p3.locator('tr[data-indice="0"] [data-testid="abrir-chamado"]').click()
  await p3.waitForSelector('[data-testid="gaveta"]', { timeout: 10000 })
  ok(
    (await p3.locator('[data-testid="gaveta"] [data-testid="editar-status"]').count()) === 0,
    'a gaveta dela também não oferece o que a permissão não dá',
  )
  await c3.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. Celular: a gaveta sobe de baixo ===')
// ---------------------------------------------------------------------------
{
  const cel = await b.newContext({
    viewport: { width: 390, height: 844 },
    storageState: await ctx.storageState(),
  })
  const pc = await cel.newPage()
  await pc.goto(`${BASE}/tickets`, { waitUntil: 'networkidle' })
  await pc.waitForTimeout(600)

  await pc.locator('li[data-indice="0"] [data-testid="abrir-chamado"]').click()
  await pc.waitForSelector('[data-testid="gaveta"]', { timeout: 10000 })
  await pc.waitForTimeout(400)

  const caixa = await pc.locator('[data-testid="gaveta"]').boundingBox()
  ok(caixa.width >= 380, 'no celular ela ocupa a largura inteira')
  ok(
    caixa.y > 844 * 0.15,
    `e sobe de baixo, deixando a lista à vista por cima (topo em ${Math.round(caixa.y)}px de 844)`,
  )
  ok(
    (await pc.evaluate(() => document.documentElement.scrollWidth)) <= 392,
    'e nada passa a rolar de lado por causa dela',
  )
  await cel.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. Inventário: a mesma gaveta, no lugar do formulário fixo ===')
// ---------------------------------------------------------------------------
{
  await p.goto(`${BASE}/inventario`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(600)

  /* O formulário de cadastro ocupava uma coluna de 23rem, aberta o dia todo. */
  ok(
    (await p.locator('text=Novo ativo').count()) > 0 &&
      (await p.locator('input[name="asset_tag"]').count()) === 0,
    'o cadastro virou botão: nenhum campo de formulário ocupa a tela por padrão',
  )

  const colunas = await p.locator('table thead th').count()
  ok(colunas === 7, `a tabela usa a largura inteira (${colunas} colunas visíveis)`)

  await p.locator('[data-testid="abrir-ativo"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 10000 })
  ok(/aberto=/.test(p.url()), 'abrir um ativo também é endereço')
  ok(
    (await p.locator('[data-testid="gaveta"] h3:has-text("Custódia")').count()) === 1,
    'e a gaveta traz ficha e custódia do ativo',
  )

  await p.keyboard.press('Escape')
  await p.waitForTimeout(900)
  ok((await p.locator('[data-testid="gaveta"]').count()) === 0, 'Esc fecha')

  await p.locator('[data-testid="novo-ativo"]').click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 10000 })
  ok(
    (await p.locator('[data-testid="gaveta"] input[name="asset_tag"]').count()) === 1,
    'e "Novo ativo" abre o cadastro na mesma gaveta',
  )

  /* Quem só consulta não recebe o botão nem a gaveta de cadastro. */
  const { ctx: c4, p: p4 } = await entrar('ana.atendente@iaroffice.com.br')
  await p4.goto(`${BASE}/inventario`, { waitUntil: 'networkidle' })
  await p4.waitForTimeout(600)
  const temBotao = (await p4.locator('[data-testid="novo-ativo"]').count()) > 0
  await p4.goto(`${BASE}/inventario?novo=1`, { waitUntil: 'networkidle' })
  await p4.waitForTimeout(600)
  const abriu = (await p4.locator('[data-testid="gaveta"]').count()) > 0
  ok(
    temBotao === abriu,
    `botão e gaveta de cadastro concordam com a permissão (botão: ${temBotao}, gaveta: ${abriu})`,
  )
  await c4.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 8. O mesmo padrão nas telas migradas ===')
// ---------------------------------------------------------------------------
{
  /*
   * Fase 5: as telas que tinham uma coluna de formulário aberta o tempo todo
   * passam a ter botão + gaveta. O que este bloco confere em cada uma é o que
   * define o padrão: nenhum campo de formulário ocupando a tela por padrão, o
   * botão de criar abrindo a gaveta, Esc fechando, e nada rolando de lado no
   * celular.
   */
  /* [rota, campo que só pode existir dentro da gaveta, testid do botão].
     O terceiro item só muda em /sla, que tem QUATRO cadastros na mesma tela e
     por isso um botão por cartão em vez de um no cabeçalho. */
  const telas = [
    ['/financeiro/titulos-a-pagar', 'input[name="description"]'],
    ['/financeiro/titulos-a-receber', 'input[name="description"]'],
    ['/financeiro/contas-bancarias', 'input[name="name"]'],
    ['/financeiro/centros-de-custo', 'input[name="code"]'],
    ['/clientes', 'input[name="legal_name"]'],
    ['/fornecedores', 'input[name="name"]'],
    ['/telefonia', 'input[name="phone_number"]'],
    ['/conectividade/links', 'select[name="branch_id"]'],
    ['/perfis', 'select[name="base_role"]'],
    ['/filas', 'input[name="slug"]'],
    ['/sla', 'input[name="weight"]', 'novo-prioridade'],
  ]

  for (const [rota, campo, testid = 'novo-registro'] of telas) {
    await p.goto(BASE + rota, { waitUntil: 'networkidle' })
    /* Espera o botão em vez de um tempo fixo: numa execução logo depois do
       build, a primeira visita a cada rota ainda paga a compilação sob demanda
       e passava do prazo — falha de ambiente lida como falha de produto. */
    const temBotao = await p
      .waitForSelector(`[data-testid="${testid}"]`, { timeout: 20000 })
      .then(() => true)
      .catch(() => false)

    ok(
      (await p.locator(`main ${campo}`).count()) === 0,
      `${rota}: nenhum formulário ocupando a tela por padrão`,
    )
    ok(temBotao, `${rota}: o cadastro virou botão`)

    await p.locator(`[data-testid="${testid}"]`).first().click()
    /* 20s, e não 10: abrir o cadastro é uma navegação que o servidor atende, e
       nas telas pesadas (contas bancárias, links) ela passa dos dez segundos
       quando a suíte roda em sequência com as outras. Prazo curto aqui reprova
       por lentidão conhecida, não por defeito. */
    await p.waitForSelector('[data-testid="gaveta"]', { timeout: 20000 })
    ok(
      (await p.locator(`[data-testid="gaveta"] ${campo}`).count()) === 1,
      `${rota}: e o botão abre o cadastro na gaveta`,
    )

    await p.keyboard.press('Escape')
    ok(await gavetaFecha(p), `${rota}: Esc fecha`)
  }

  /*
   * /filas tem DOIS registros na mesma tela — a fila e a regra de roteamento —
   * e foi por isso que a gaveta ganhou quatro modos. O que se confere aqui é
   * que abrir um fecha o outro: dois painéis abertos ao mesmo tempo seria a
   * volta do idioma que a Fase 5 tirou.
   */
  await p.goto(`${BASE}/filas`, { waitUntil: 'networkidle' })
  await p.locator('[data-testid="abrir-registro"]').first().click()
  await p.waitForSelector('[data-testid="gaveta"]', { timeout: 10000 })
  const filaAberta = await tituloDaGaveta(p)
  await p.locator('[data-testid="abrir-regra"]').first().click()
  await p.waitForTimeout(600)
  const regraAberta = await tituloDaGaveta(p)
  ok(
    (await p.locator('[data-testid="gaveta"]').count()) === 1 && filaAberta !== regraAberta,
    `/filas: abrir a regra troca o conteúdo da gaveta da fila (${filaAberta} → ${regraAberta})`,
  )
  await p.keyboard.press('Escape')
  ok(await gavetaFecha(p), '/filas: Esc fecha a gaveta da regra')
}

// ---------------------------------------------------------------------------
console.log('\n=== 8.1 Integração: a regra e a versão saíram da célula ===')
// ---------------------------------------------------------------------------
{
  /*
   * O editor da regra de mapeamento abria dentro da ÚLTIMA CÉLULA da tabela —
   * nove campos na largura de uma coluna chamada "Ações" — e o histórico
   * oferecia "voltar a esta versão" mostrando só a contagem de regras. As duas
   * asserções abaixo cobrem exatamente isso: o formulário saiu da célula, e a
   * versão agora é lida antes de ser restaurada.
   */
  await p.goto(`${BASE}/integracoes`, { waitUntil: 'networkidle' })
  const rota = await p
    .locator('a[href^="/integracoes/"]')
    .first()
    .getAttribute('href')

  if (!rota) {
    ok(false, 'nenhuma integração cadastrada para conferir')
  } else {
    await p.goto(BASE + rota, { waitUntil: 'networkidle' })
    ok(
      (await p.locator('main input[name="source_path"]').count()) === 0,
      'integração: nenhum editor de regra aberto na tabela',
    )

    await p.locator('[data-testid="abrir-regra"]').first().click()
    await p.waitForSelector('[data-testid="gaveta"]', { timeout: 10000 })
    ok(
      (await p.locator('[data-testid="gaveta"] input[name="source_path"]').count()) === 1,
      'integração: a regra abre na gaveta, com o caminho de origem dentro',
    )
    ok(
      (await p.locator('[data-testid="gaveta"] button:has-text("Remover")').count()) === 1,
      'integração: e a remoção mora junto da regra que ela apaga',
    )
    await p.keyboard.press('Escape')
    ok(await gavetaFecha(p), 'integração: Esc fecha a gaveta da regra')

    /* O histórico só oferece "voltar" nas versões que NÃO são a atual: com uma
       versão só, não há o que restaurar, e a ausência do link é o acerto. */
    const versoes = await p.locator('[data-testid="abrir-versao"]').count()
    if (versoes > 0) {
      await p.locator('[data-testid="abrir-versao"]').first().click()
      await p.waitForSelector('[data-testid="gaveta"]', { timeout: 10000 })
      const regrasListadas = await p.locator('[data-testid="gaveta"] ul li').count()
      ok(
        regrasListadas > 0,
        `integração: a versão mostra as ${regrasListadas} regras antes do botão de restaurar`,
      )
      ok(
        (await p.locator('[data-testid="gaveta"] button:has-text("Restaurar")').count()) === 1,
        'integração: e o botão de restaurar está depois delas',
      )
      await p.keyboard.press('Escape')
      ok(await gavetaFecha(p), 'integração: Esc fecha a gaveta da versão')
    } else {
      ok(true, 'integração: histórico com uma versão só não oferece restauração')
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 9. Celular: as telas migradas também cabem ===')
// ---------------------------------------------------------------------------
{
  const cel = await b.newContext({
    viewport: { width: 390, height: 844 },
    storageState: await ctx.storageState(),
  })
  const pc = await cel.newPage()
  for (const rota of [
    '/financeiro/titulos-a-pagar',
    '/financeiro/titulos-a-receber',
    '/financeiro/contas-bancarias',
    '/financeiro/centros-de-custo',
    '/clientes',
    '/fornecedores',
    '/telefonia',
    '/conectividade/links',
    '/perfis',
    '/filas',
    '/sla',
  ]) {
    await pc.goto(BASE + rota, { waitUntil: 'networkidle' })
    await pc.waitForTimeout(400)
    const largura = await pc.evaluate(() => document.documentElement.scrollWidth)
    ok(largura <= 392, `${rota} cabe na tela do celular (${largura}px)`)
  }
  await cel.close()
}

await ctx.close()
await b.close()
console.log(falhas === 0 ? '\nTODAS AS ASSERÇÕES PASSARAM' : `\n${falhas} ASSERÇÃO(ÕES) FALHOU/FALHARAM`)
process.exit(falhas === 0 ? 0 : 1)
