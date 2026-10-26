import { describe, expect, it } from 'vitest'
import { Consulta, lerFiltroDoPostgrest, lerListaEntreParenteses, separarNoTopo } from './consulta'
import type { Relacao } from './relacoes'

/**
 * O que estes testes protegem
 * ---------------------------
 * O SQL gerado, sem banco. Três classes de erro moram aqui, e as três são
 * silenciosas:
 *
 *  - valor interpolado em vez de parametrizado (injeção, e erro de aspas);
 *  - embute no sentido errado — objeto onde a tela espera lista, e a tela
 *    mostra vazio sem reclamar;
 *  - `!inner` tratado como junção à esquerda, que devolve linhas que a tela
 *    não deveria mostrar.
 */

const RELACOES: Relacao[] = [
  {
    nome: 'tickets_requester_id_fkey',
    tabelaOrigem: 'tickets',
    colunasOrigem: ['requester_id'],
    tabelaDestino: 'profiles',
    colunasDestino: ['id'],
  },
  {
    nome: 'tickets_assignee_id_fkey',
    tabelaOrigem: 'tickets',
    colunasOrigem: ['assignee_id'],
    tabelaDestino: 'profiles',
    colunasDestino: ['id'],
  },
  {
    nome: 'fk_comment_ticket',
    tabelaOrigem: 'ticket_comments',
    colunasOrigem: ['ticket_id'],
    tabelaDestino: 'tickets',
    colunasDestino: ['id'],
  },
  {
    nome: 'fk_ticket_queue',
    tabelaOrigem: 'tickets',
    colunasOrigem: ['queue_id'],
    tabelaDestino: 'queues',
    colunasDestino: ['id'],
  },
]

function nova(tabela: string): Consulta {
  const c = new Consulta(async () => ({ rows: [], relacoes: RELACOES }), tabela)
  c.relacoesEmCache = RELACOES
  return c
}

describe('leitura simples', () => {
  it('monta select, where e order', () => {
    const { sql, params } = nova('tickets')
      .select('id, title')
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(10)
      .montarParaTeste()

    expect(sql).toContain('select t."id" as "id", t."title" as "title"')
    expect(sql).toContain('from "public"."tickets" t')
    expect(sql).toContain('where t."status" = $1')
    expect(sql).toContain('order by t."created_at" desc')
    expect(sql).toContain('limit 10')
    expect(params).toEqual(['open'])
  })

  it('NUNCA interpola valor no SQL', () => {
    /*
     * O valor abaixo é o que um campo de busca entrega quando alguém testa a
     * aplicação. Interpolar faria isto virar SQL; parametrizar faz virar texto.
     */
    const veneno = "x'; drop table tickets; --"
    const { sql, params } = nova('tickets').select('id').eq('title', veneno).montarParaTeste()
    expect(sql).not.toContain('drop table')
    expect(params).toEqual([veneno])
  })

  it('recusa identificador que não é identificador', () => {
    // A coluna vem do código, não do usuário — mas um erro de digitação com
    // aspas produziria SQL quebrado em vez de uma mensagem clara.
    expect(() => nova('tickets').select('id').eq('a"b', 1).montarParaTeste()).toThrow()
  })

  it('range vira limit e offset', () => {
    const { sql } = nova('tickets').select('id').range(20, 39).montarParaTeste()
    expect(sql).toContain('limit 20')
    expect(sql).toContain('offset 20')
  })

  it('is null não vira parâmetro', () => {
    // `x = $1` com $1 nulo NUNCA é verdadeiro: `null = null` é nulo, não
    // verdadeiro. Este é o erro que faz um filtro de "sem responsável" devolver
    // lista vazia para sempre.
    const { sql, params } = nova('tickets').select('id').is('assignee_id', null).montarParaTeste()
    expect(sql).toContain('t."assignee_id" is null')
    expect(params).toHaveLength(0)
  })

  it('in com lista vazia não traz nada, e não quebra', () => {
    const { sql, params } = nova('tickets').select('id').in('id', []).montarParaTeste()
    expect(sql).toContain('= any($1)')
    expect(params[0]).toEqual([])
  })
})

describe('embutes', () => {
  it('chave na tabela de fora vira OBJETO', () => {
    const { sql } = nova('tickets')
      .select('id, autor:requester_id(full_name)')
      .montarParaTeste()
    expect(sql).toContain('to_jsonb(sub)')
    expect(sql).toContain('"profiles"')
    expect(sql).toContain('."id" = t."requester_id"')
  })

  it('chave na tabela de dentro vira LISTA, com vazio em vez de nulo', () => {
    /*
     * A tela faz `(x ?? []).map(...)`. Devolver `null` quebraria ali; devolver
     * `[]` simplesmente não desenha nada, que é o comportamento certo para "não
     * há comentários".
     */
    const { sql } = nova('tickets').select('id, ticket_comments(body)').montarParaTeste()
    expect(sql).toContain('jsonb_agg(sub)')
    expect(sql).toContain(`'[]'::jsonb`)
  })

  it('duas chaves para a mesma tabela é ambiguidade DECLARADA', () => {
    /*
     * `tickets` aponta para `profiles` por `requester_id` e por `assignee_id`.
     * Escolher uma seria escolher errado metade das vezes, em silêncio — e o
     * sintoma seria o nome do solicitante aparecendo no lugar do responsável.
     */
    expect(() => nova('tickets').select('profiles(full_name)').montarParaTeste()).toThrow(
      /2 chaves/,
    )
  })

  it('a dica de constraint desempata', () => {
    const { sql } = nova('tickets')
      .select('resp:profiles!tickets_assignee_id_fkey(full_name)')
      .montarParaTeste()
    expect(sql).toContain('t."assignee_id"')
  })

  it('!inner vira EXISTS no where, não junção à esquerda', () => {
    const { sql } = nova('tickets').select('id, queues!inner(name)').montarParaTeste()
    expect(sql).toContain('exists (select 1 from "public"."queues"')
    expect(sql.indexOf('where')).toBeGreaterThan(0)
  })

  it('embute dentro de embute', () => {
    const { sql } = nova('ticket_comments')
      .select('body, chamado:tickets(fila:queues(name))')
      .montarParaTeste()
    expect(sql).toContain('"tickets"')
    expect(sql).toContain('"queues"')
  })
})

describe('escrita', () => {
  it('insert só devolve linha quando o código pede', () => {
    /*
     * É o que sustenta a regra desta base: RLS negando um insert devolve zero
     * linhas, e o código confere `data.length`. Sem `returning`, não haveria o
     * que conferir.
     */
    const sem = nova('tickets').insert({ title: 'x' }).montarParaTeste()
    expect(sem.sql).not.toContain('returning')

    const com = nova('tickets').insert({ title: 'x' }).select('id').montarParaTeste()
    expect(com.sql).toContain('returning t."id" as "id"')
  })

  it('insert usa "as t" — sem o AS é erro de sintaxe', () => {
    /*
     * O PostgreSQL aceita `update tabela t set` e `delete from tabela t`, mas
     * recusa `insert into tabela t (...)` com 42601. O alias existe para o
     * `returning` poder dizer `t."id"`, e a diferença entre os três comandos
     * não aparece em nenhum lugar a não ser aqui.
     */
    const { sql } = nova('tickets').insert({ title: 'x' }).select('id').montarParaTeste()
    expect(sql).toContain('insert into "public"."tickets" as t (')
  })

  it('insert em lote usa a UNIÃO das colunas', () => {
    // Um lote em que a segunda linha traz um campo que a primeira não tinha é
    // comum. Usar só as chaves da primeira perderia o campo em silêncio.
    const { sql, params } = nova('tickets')
      .insert([{ a: 1 }, { a: 2, b: 3 }])
      .montarParaTeste()
    expect(sql).toContain('"a", "b"')
    expect(params).toEqual([1, null, 2, 3])
  })

  it('update monta set com parâmetros', () => {
    const { sql, params } = nova('tickets')
      .update({ status: 'closed' })
      .eq('id', 'abc')
      .select('id')
      .montarParaTeste()
    expect(sql).toContain('set "status" = $1')
    expect(sql).toContain('where t."id" = $2')
    expect(params).toEqual(['closed', 'abc'])
  })

  it('upsert declara o alvo do conflito', () => {
    const { sql } = nova('ai_settings')
      .upsert({ tenant_id: 'a', enabled: true }, { onConflict: 'tenant_id' })
      .montarParaTeste()
    expect(sql).toContain('on conflict ("tenant_id") do update set')
  })

  it('delete sem filtro continua sendo delete sem filtro', () => {
    // Não se inventa uma trava aqui: o RLS é quem decide o alcance, e inventar
    // um `where false` esconderia um erro de código em vez de mostrá-lo.
    const { sql } = nova('email_outbox').delete().montarParaTeste()
    expect(sql).toBe('delete from "public"."email_outbox" t')
  })
})

describe('a linguagem de filtro do PostgREST', () => {
  it('separa por vírgula respeitando parênteses', () => {
    expect(separarNoTopo('a.is.null,b.in.(1,2,3),c.eq.4')).toEqual([
      'a.is.null',
      'b.in.(1,2,3)',
      'c.eq.4',
    ])
  })

  it('lê lista com e sem aspas', () => {
    expect(lerListaEntreParenteses('("resolved","closed")')).toEqual(['resolved', 'closed'])
    expect(lerListaEntreParenteses('(a,b)')).toEqual(['a', 'b'])
    expect(lerListaEntreParenteses('()')).toEqual([])
  })

  it('lê coluna, operador e valor', () => {
    expect(lerFiltroDoPostgrest('client_id.is.null')).toEqual({
      coluna: 'client_id',
      op: 'is',
      valor: null,
    })
    expect(lerFiltroDoPostgrest('client_id.eq.abc')).toEqual({
      coluna: 'client_id',
      op: 'eq',
      valor: 'abc',
    })
  })

  it('or() do escopo por cliente vira um OR de verdade', () => {
    /*
     * É a consulta que decide o que um usuário com foco em cliente enxerga:
     * "o que é dele, mais o que é de todo mundo". Virar AND aqui esconderia
     * metade dos registros da tela, sem erro nenhum.
     */
    const { sql } = nova('it_assets')
      .select('id')
      .or('client_id.is.null,client_id.eq.abc')
      .montarParaTeste()
    expect(sql).toContain('(t."client_id" is null or t."client_id" = $1)')
  })

  it('not in vira negação da lista', () => {
    const { sql, params } = nova('tickets')
      .select('id')
      .not('status', 'in', '("resolved","closed")')
      .montarParaTeste()
    expect(sql).toContain('not (t."status" = any($1))')
    expect(params[0]).toEqual(['resolved', 'closed'])
  })
})
