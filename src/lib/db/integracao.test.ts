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
})
