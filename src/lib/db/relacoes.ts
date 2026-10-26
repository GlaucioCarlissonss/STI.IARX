import type { PoolClient } from 'pg'

/**
 * O mapa de chaves estrangeiras, que é o que torna o embute possível.
 *
 * ## Por que ele precisa vir do banco
 *
 * `author:profiles(full_name)` não diz por qual coluna a junção acontece. O
 * PostgREST descobre isso lendo as constraints — e a direção da chave decide se
 * o resultado é um OBJETO ou uma LISTA:
 *
 *   · a chave está na tabela de fora, apontando para a de dentro → objeto
 *     (todo chamado tem um autor);
 *   · a chave está na tabela de dentro, apontando para a de fora → lista
 *     (um chamado tem vários comentários).
 *
 * Errar essa direção não dá erro: devolve `{...}` onde a tela espera `[...]`, e
 * a tela mostra vazio.
 *
 * ## Por que fica em memória
 *
 * O schema não muda enquanto o processo vive. Consultar `information_schema` a
 * cada embute somaria uma ida ao banco por junção por requisição — numa tela
 * com quatro embutes, quatro consultas extras para montar a consulta.
 */

export interface Relacao {
  nome: string
  tabelaOrigem: string
  colunasOrigem: string[]
  tabelaDestino: string
  colunasDestino: string[]
}

let cache: Relacao[] | null = null

export async function carregarRelacoes(cliente: PoolClient): Promise<Relacao[]> {
  if (cache) return cache

  const { rows } = await cliente.query<{
    nome: string
    tabela_origem: string
    tabela_destino: string
    colunas_origem: string[]
    colunas_destino: string[]
  }>(`
    select
      c.conname                                    as nome,
      origem.relname                               as tabela_origem,
      destino.relname                              as tabela_destino,
      /* O ::text não é enfeite: attname é do tipo "name", e o driver pg não tem
         analisador para name[] — o resultado voltaria como a STRING
         "{category_id,tenant_id}", em que .map() não existe. Com text[] o
         driver devolve array de verdade. */
      array_agg(co.attname::text order by u.ord)   as colunas_origem,
      array_agg(cd.attname::text order by u.ord)   as colunas_destino
    from pg_constraint c
    join pg_class origem  on origem.oid  = c.conrelid
    join pg_class destino on destino.oid = c.confrelid
    join pg_namespace n   on n.oid = origem.relnamespace
    cross join lateral unnest(c.conkey, c.confkey) with ordinality as u(ok, dk, ord)
    join pg_attribute co on co.attrelid = c.conrelid  and co.attnum = u.ok
    join pg_attribute cd on cd.attrelid = c.confrelid and cd.attnum = u.dk
    where c.contype = 'f' and n.nspname = 'public'
    group by c.conname, origem.relname, destino.relname
  `)

  cache = rows.map((r) => ({
    nome: r.nome,
    tabelaOrigem: r.tabela_origem,
    colunasOrigem: r.colunas_origem,
    tabelaDestino: r.tabela_destino,
    colunasDestino: r.colunas_destino,
  }))
  return cache
}

/** Esquece o mapa. Usado pelos testes e depois de aplicar migração. */
export function esquecerRelacoes(): void {
  cache = null
}

export interface Ligacao {
  /** A tabela que o embute lê. */
  tabela: string
  /** `um` = objeto; `muitos` = lista. */
  cardinalidade: 'um' | 'muitos'
  /** Colunas da tabela de FORA usadas na junção. */
  colunasDeFora: string[]
  /** Colunas da tabela de DENTRO usadas na junção. */
  colunasDeDentro: string[]
}

/**
 * Descobre como ligar `tabelaDeFora` ao alvo escrito na seleção.
 *
 * O alvo pode ser três coisas, e o app usa as três:
 *   1. o nome de uma tabela (`profiles`);
 *   2. o nome de uma COLUNA de chave estrangeira (`decided_by`);
 *   3. o nome da própria constraint (`kb_articles_author_id_fkey`).
 *
 * A ordem de tentativa importa: constraint primeiro, porque é o único nome
 * inequívoco. Depois coluna, depois tabela — e quando a tabela aparece em mais
 * de uma chave, é ambíguo de verdade, e o erro diz como desempatar em vez de
 * escolher uma.
 */
export function resolverLigacao(
  relacoes: Relacao[],
  tabelaDeFora: string,
  alvo: string,
  dica: string | null,
): Ligacao | { erro: string } {
  const porNome = (nome: string) => relacoes.find((r) => r.nome === nome)

  // 1. Dica explícita, ou alvo que É o nome de uma constraint.
  const explicita = dica ? porNome(dica) : porNome(alvo)
  if (explicita) {
    if (explicita.tabelaOrigem === tabelaDeFora) {
      return {
        tabela: explicita.tabelaDestino,
        cardinalidade: 'um',
        colunasDeFora: explicita.colunasOrigem,
        colunasDeDentro: explicita.colunasDestino,
      }
    }
    if (explicita.tabelaDestino === tabelaDeFora) {
      return {
        tabela: explicita.tabelaOrigem,
        cardinalidade: 'muitos',
        colunasDeFora: explicita.colunasDestino,
        colunasDeDentro: explicita.colunasOrigem,
      }
    }
    return { erro: `a chave "${explicita.nome}" não liga "${tabelaDeFora}" a nada` }
  }

  // 2. O alvo é uma COLUNA de chave estrangeira da tabela de fora.
  const porColuna = relacoes.filter(
    (r) => r.tabelaOrigem === tabelaDeFora && r.colunasOrigem.length === 1 && r.colunasOrigem[0] === alvo,
  )
  if (porColuna.length === 1) {
    const r = porColuna[0]!
    return {
      tabela: r.tabelaDestino,
      cardinalidade: 'um',
      colunasDeFora: r.colunasOrigem,
      colunasDeDentro: r.colunasDestino,
    }
  }

  // 3. O alvo é o nome de uma tabela.
  const saindo = relacoes.filter(
    (r) => r.tabelaOrigem === tabelaDeFora && r.tabelaDestino === alvo,
  )
  const entrando = relacoes.filter(
    (r) => r.tabelaDestino === tabelaDeFora && r.tabelaOrigem === alvo,
  )

  const candidatas = [...saindo, ...entrando]
  if (candidatas.length === 0) {
    return { erro: `não há chave estrangeira entre "${tabelaDeFora}" e "${alvo}"` }
  }
  if (candidatas.length > 1) {
    /*
     * Duas chaves para a mesma tabela é o caso de `tickets.requester_id` e
     * `tickets.assignee_id` apontando para `profiles`. Escolher uma seria
     * escolher errado metade das vezes, em silêncio.
     */
    return {
      erro:
        `há ${candidatas.length} chaves entre "${tabelaDeFora}" e "${alvo}" ` +
        `(${candidatas.map((c) => c.nome).join(', ')}). ` +
        `Desempate pelo nome da coluna ou da constraint.`,
    }
  }

  const r = candidatas[0]!
  if (saindo.length === 1) {
    return {
      tabela: r.tabelaDestino,
      cardinalidade: 'um',
      colunasDeFora: r.colunasOrigem,
      colunasDeDentro: r.colunasDestino,
    }
  }
  return {
    tabela: r.tabelaOrigem,
    cardinalidade: 'muitos',
    colunasDeFora: r.colunasDestino,
    colunasDeDentro: r.colunasOrigem,
  }
}

/**
 * O tipo de cada coluna — e por que ele é necessário.
 *
 * O driver `pg` serializa um array de JavaScript como **array do PostgreSQL**:
 * `['a','b']` vira `{a,b}`. Isso é certo para `tickets.tags`, que é `text[]`, e
 * é errado para `service_catalog.campos`, que é `jsonb`. Os dois chegam aqui
 * como array de JavaScript, e nada os distingue a não ser o tipo da coluna.
 *
 * O PostgREST não tem esse problema porque fala JSON na entrada e deixa o
 * PostgreSQL converter. Aqui a conversão é nossa, então o tipo precisa ser
 * conhecido — e é por isso que este mapa existe.
 *
 * Foi encontrado do jeito mais caro: o formulário de cadastro de serviço
 * recusando com "violates check constraint", porque `jsonb_typeof('{}')` não é
 * `array`.
 */
export type TiposDeColuna = Map<string, Map<string, string>>

let cacheDeTipos: TiposDeColuna | null = null

export async function carregarTiposDeColuna(cliente: PoolClient): Promise<TiposDeColuna> {
  if (cacheDeTipos) return cacheDeTipos

  const { rows } = await cliente.query<{ tabela: string; coluna: string; tipo: string }>(`
    select c.relname as tabela, a.attname as coluna, t.typname as tipo
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_type t on t.oid = a.atttypid
     where n.nspname = 'public' and a.attnum > 0 and not a.attisdropped
       and c.relkind in ('r', 'v', 'm', 'p')
  `)

  const mapa: TiposDeColuna = new Map()
  for (const r of rows) {
    if (!mapa.has(r.tabela)) mapa.set(r.tabela, new Map())
    mapa.get(r.tabela)!.set(r.coluna, r.tipo)
  }
  cacheDeTipos = mapa
  return mapa
}

export function esquecerTipos(): void {
  cacheDeTipos = null
}
