import { afterAll, describe, expect, it } from 'vitest'
import { criarClienteDeServico } from './cliente'
import { obterPool } from './conexao'

/**
 * O driver local contra um PostgreSQL de VERDADE.
 *
 * ## Por que estes testes precisam existir
 *
 * Os testes de `consulta.test.ts` conferem a string de SQL. Eles passaram com
 * `insert into tabela t (...)`, que o PostgreSQL recusa com erro de sintaxe —
 * porque nenhum deles chegou perto de um banco.
 *
 * Erro de sintaxe, tipo de coluna errado e junção impossível só aparecem na
 * execução. Esta suíte executa.
 *
 * ## Por que ela se desliga sozinha
 *
 * `DATABASE_URL` ausente = sem banco para falar. Em vez de falhar, ela não
 * roda: a suíte unitária precisa continuar rodando em qualquer máquina, e um
 * teste que exige infraestrutura não pode derrubar quem só queria rodar
 * `npm test`.
 *
 *     bash scripts/preparar-banco-local.sh
 *     DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/sti_iarx_dev npm test
 */

const URL_DO_BANCO = process.env.DATABASE_URL
const comBanco = URL_DO_BANCO ? describe : describe.skip

comBanco('o driver local contra o PostgreSQL', () => {
  const db = criarClienteDeServico()

  afterAll(async () => {
    await obterPool().end()
  })

  it('lê uma tabela', async () => {
    const { data, error } = await db.from('tenants').select('id, name').limit(1)
    expect(error).toBeNull()
    expect(Array.isArray(data)).toBe(true)
  })

  it('resolve embute para UM (objeto)', async () => {
    const { data, error } = await db
      .from('service_catalog')
      .select('id, name, category:ticket_categories(name), queue:queues(name)')
      .limit(1)
    expect(error).toBeNull()
    expect(Array.isArray(data)).toBe(true)
  })

  it('resolve embute para MUITOS (lista, nunca nulo)', async () => {
    const { data, error } = await db
      .from('tickets')
      .select('id, ticket_comments(body)')
      .limit(1)
      .returns<{ id: string; ticket_comments: unknown[] }[]>()
    expect(error).toBeNull()
    if (data && data.length > 0) expect(Array.isArray(data[0]!.ticket_comments)).toBe(true)
  })

  it('devolve número onde o PostgREST devolveria número', async () => {
    /* `numeric` e `int8` chegam como string no `pg`. A tela faz `.toFixed()`
       neles — e foi assim que três telas quebraram na primeira execução. */
    const { data } = await db
      .from('tenants')
      .select('sla_warning_pct, attachment_quota_mb')
      .limit(1)
      .returns<{ sla_warning_pct: unknown; attachment_quota_mb: unknown }[]>()
    if (data?.[0]) {
      expect(typeof data[0].sla_warning_pct).toBe('number')
      expect(typeof data[0].attachment_quota_mb).toBe('number')
    }
  })

  it('devolve data como TEXTO, não como Date', async () => {
    // `competencia.slice(0, 7)` quebra num `Date`, e competência é `date`.
    const { data } = await db
      .from('it_cost_entries')
      .select('competence')
      .limit(1)
      .returns<{ competence: unknown }[]>()
    if (data?.[0]) expect(typeof data[0].competence).toBe('string')
  })

  it('escreve e devolve a linha gravada', async () => {
    const { data } = await db.from('tenants').select('id').limit(1)
    const tenant = (data as { id: string }[] | null)?.[0]
    expect(tenant).toBeTruthy()

    const { data: criada, error } = await db
      .from('ticket_categories')
      .insert({ tenant_id: tenant!.id, name: `Teste do driver ${Date.now()}` })
      .select('id, name')
      .returns<{ id: string; name: string }[]>()

    expect(error).toBeNull()
    expect(criada?.[0]?.id).toBeTruthy()

    if (criada?.[0]) {
      const { data: apagado } = await db
        .from('ticket_categories')
        .delete()
        .eq('id', criada[0].id)
        .select('id')
      expect(apagado?.length).toBe(1)
    }
  })

  it('grava jsonb como JSON, e não como array do PostgreSQL', async () => {
    /*
     * `['a']` vira `{a}` se o driver tratar como array do PostgreSQL — e
     * `jsonb_typeof('{a}')` não é `array`. Foi o que impediu o cadastro de
     * serviço de funcionar.
     */
    const { data: linhas } = await db.from('tenants').select('id').limit(1)
    const tenant = (linhas as { id: string }[] | null)?.[0]
    const campos = [{ chave: 'x', rotulo: 'X', tipo: 'texto', obrigatorio: false }]

    const { data, error } = await db
      .from('service_catalog')
      .insert({ tenant_id: tenant!.id, name: `Teste jsonb ${Date.now()}`, campos })
      .select('id, campos')
      .returns<{ id: string; campos: unknown[] }[]>()

    expect(error).toBeNull()
    expect(Array.isArray(data?.[0]?.campos)).toBe(true)

    if (data?.[0]) await db.from('service_catalog').delete().eq('id', data[0].id).select('id')
  })

  it('chama função com argumentos nomeados', async () => {
    const { data: linhas } = await db.from('clients').select('id').limit(1)
    const cliente = (linhas as { id: string }[] | null)?.[0]
    if (!cliente) return

    const hoje = new Date()
    const competencia = `${hoje.getUTCFullYear()}-${String(hoje.getUTCMonth() + 1).padStart(2, '0')}-01`
    const { data, error } = await db
      .rpc('gestao_resultado', { p_client_id: cliente.id, p_competence: competencia })
      .maybeSingle<{ gasto_mes: unknown }>()

    expect(error).toBeNull()
    expect(data).not.toBeNull()
  })

  it('o filtro OR do escopo por cliente vira OR de verdade', async () => {
    const { error } = await db
      .from('receivables')
      .select('id')
      .or('client_id.is.null,client_id.eq.00000000-0000-4000-8000-000000000000')
      .limit(1)
    expect(error).toBeNull()
  })

  it('not in funciona com a sintaxe do PostgREST', async () => {
    const { error } = await db
      .from('tickets')
      .select('id')
      .not('status', 'in', '("resolved","closed")')
      .limit(1)
    expect(error).toBeNull()
  })

  /* ------------------------------------------------------------------------
   * As lacunas que `docs/22` listava — conferidas uma a uma, em vez de
   * repetidas de memória. Duas já não eram lacunas.
   * --------------------------------------------------------------------- */

  it('conta o total com `head`, sem trazer linha', async () => {
    const { data, error, count } = await db
      .from('tickets')
      .select('id', { count: 'exact', head: true })
    expect(error).toBeNull()
    expect(data).toBeNull()
    expect(typeof count).toBe('number')
    expect(count).toBeGreaterThan(0)
  })

  /*
   * O caso que erra calado se ninguém olhar: `count(*) over()` não devolve
   * LINHA nenhuma quando nada casa, então um total lido da primeira linha
   * viraria `null` — e `null` numa paginação não é "zero", é "não sei", que a
   * tela mostra como vazio sem dizer que está vazio.
   */
  it('conta zero quando nada casa, e zero não é nulo', async () => {
    const { error, count } = await db
      .from('tickets')
      .select('id', { count: 'exact', head: true })
      .eq('title', 'titulo-que-nao-existe-em-lugar-nenhum')
    expect(error).toBeNull()
    expect(count).toBe(0)
  })

  it('conta o total ANTES do limite, que é o ponto de contar', async () => {
    const { data, count } = await db
      .from('tickets')
      .select('id', { count: 'exact' })
      .limit(1)
    expect(data).toHaveLength(1)
    expect(count).toBeGreaterThan(1)
  })

  /*
   * Filtro sobre tabela embutida é do PostgREST e não existe aqui. O que se
   * exige é que ele FALHE DIZENDO ISSO: antes, virava uma coluna chamada
   * "ticket_comments.id" e o PostgreSQL respondia "column does not exist",
   * mandando quem lê procurar um erro de digitação que não existe.
   */
  /*
   * Levanta exceção, e não `{ error }`, de propósito: isto não é condição de
   * execução, é erro de programação — a consulta nunca vai funcionar, em
   * nenhuma linha de dado. Devolver `{ error }` o faria descer pelo mesmo
   * caminho de "não encontrei", e a tela mostraria lista vazia para um defeito
   * de código. A exceção aparece onde foi escrita.
   */
  it('recusa filtro sobre tabela embutida com erro que se entende', () => {
    expect(() =>
      db
        .from('tickets')
        .select('id, ticket_comments(id)')
        .eq('ticket_comments.id', '00000000-0000-0000-0000-000000000000'),
    ).toThrowError(/tabela embutida.+docs\/22/s)
  })

  it('recusa `csv` e `explain` pelo nome, em vez de "não é uma função"', async () => {
    const consulta = db.from('tickets').select('id') as unknown as {
      csv: () => unknown
      explain: () => unknown
    }
    expect(() => consulta.csv()).toThrowError(/csv/i)
    expect(() => consulta.explain()).toThrowError(/explain/i)
  })

  /*
   * Função escalar: o PostgREST entrega o VALOR, não uma linha com uma coluna.
   *
   * Isto ficou sem teste — e sem funcionar — até a 0046, porque toda função que
   * o app chamava era `returns table`. Quando a primeira escalar chegou, o
   * sintoma foi uma rota devolvendo 200 para token inválido: o código lia
   * `data.motivo` num array.
   */
  it('devolve o VALOR de uma função escalar, não uma linha com uma coluna', async () => {
    const { data, error } = await db.rpc('link_event_ingest', {
      p_token: 'token-que-nao-existe',
      p_host: 'qualquer',
      p_external_id: null,
      p_state: 'PROBLEM',
      p_at: null,
      p_note: null,
    })
    expect(error).toBeNull()
    expect(Array.isArray(data)).toBe(false)
    expect((data as { motivo?: string }).motivo).toBe('token_desconhecido')
  })

  it('continua devolvendo LISTA para função que devolve tabela', async () => {
    const { data, error } = await db.rpc('channel_por_token', { p_token: 'nao-existe' })
    expect(error).toBeNull()
    expect(Array.isArray(data)).toBe(true)
  })
})
