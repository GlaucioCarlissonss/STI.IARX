import { analisarSelecao, nomeDeSaida, type Campo, type Embute } from './selecao'
import { resolverLigacao, type Relacao, type TiposDeColuna } from './relacoes'

/**
 * O construtor de consulta: a forma do cliente Supabase, sobre SQL puro.
 *
 * ## O contrato
 *
 * O app não sabe que isto existe. Ele continua escrevendo
 * `.from('tickets').select('id').eq('status', 'open')` e recebendo
 * `{ data, error }` — e `error` traz `code` e `message`, que é exatamente o que
 * `mensagemDeErro()` já lê. O SQLSTATE do PostgreSQL chega inteiro, então
 * `23505` continua virando "já existe um registro com estes dados".
 *
 * ## O que NÃO muda em relação ao Supabase
 *
 * O RLS. Cada consulta roda numa transação com `set local role` e
 * `set local request.jwt.claims` — as mesmas policies, as mesmas funções
 * `app.current_tenant_id()`, o mesmo comportamento de negação (zero linhas em
 * leitura e escrita; exceção no `with check` do insert).
 *
 * Isto importa mais que parecer: um dublê que ignorasse o RLS deixaria o app
 * funcionando local e falhando em produção — ou, pior, passando em teste local
 * algo que o RLS negaria.
 */

export interface ErroDeBanco {
  code?: string
  message: string
  details?: string | null
  hint?: string | null
}

export interface Resultado<T> {
  data: T | null
  error: ErroDeBanco | null
  count?: number | null
}

export interface LinhaQualquer {
  [coluna: string]: unknown
}

export interface Esquema {
  relacoes: Relacao[]
  tipos: TiposDeColuna
}

export type Executor = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: LinhaQualquer[]; relacoes: Relacao[] }>

type Operacao = 'select' | 'insert' | 'update' | 'upsert' | 'delete' | 'rpc'

interface Condicao {
  sql: (ctx: Contexto, prefixo: string) => string
}

/** Acumula parâmetros para `$1, $2, …` — nunca interpolação de valor. */
class Contexto {
  params: unknown[] = []
  param(valor: unknown): string {
    this.params.push(valor)
    return `$${this.params.length}`
  }
}

function ident(nome: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nome)) {
    throw new Error(`identificador inválido: ${nome}`)
  }
  return `"${nome}"`
}

export class Consulta<T = LinhaQualquer[]> implements PromiseLike<Resultado<T>> {
  private operacao: Operacao = 'select'
  private selecao = '*'
  private comRetorno = true
  private condicoes: Condicao[] = []
  private ordenacao: { coluna: string; asc: boolean; nullsFirst?: boolean }[] = []
  private limite: number | null = null
  private deslocamento = 0
  private carga: LinhaQualquer | LinhaQualquer[] | null = null
  private conflito: string | null = null
  private modo: 'muitos' | 'um' | 'talvezUm' = 'muitos'
  private contar: 'exact' | null = null
  private soCabecalho = false

  constructor(
    private readonly executor: Executor,
    private readonly tabela: string,
    private readonly esquema = 'public',
    private readonly argsRpc: LinhaQualquer | null = null,
    /*
     * Carrega o mapa de chaves estrangeiras ANTES de compilar. Não dá para
     * fazer isso no `from()`, que é síncrono na forma do Supabase, nem depois
     * de compilar, que é quando o mapa é necessário. Fica aqui, no único ponto
     * assíncrono do caminho.
     */
    private readonly preparar: (() => Promise<Esquema>) | null = null,
  ) {}

  /* ---------------------------------------------------------------- leitura */

  select(colunas = '*', opcoes?: { count?: 'exact'; head?: boolean }): this {
    if (this.operacao === 'select' || this.operacao === 'rpc') {
      this.selecao = colunas
    } else {
      /* Depois de um insert/update/delete, `select()` é a cláusula RETURNING.
         É o que faz `.insert(x).select('id')` devolver o id gravado — e o que
         o app usa para saber se o RLS deixou a escrita passar. */
      this.selecao = colunas
      this.comRetorno = true
    }
    if (opcoes?.count) this.contar = opcoes.count
    if (opcoes?.head) this.soCabecalho = true
    return this
  }

  /* ---------------------------------------------------------------- escrita */

  insert(valores: LinhaQualquer | LinhaQualquer[]): this {
    this.operacao = 'insert'
    this.carga = valores
    this.comRetorno = false
    return this
  }

  upsert(valores: LinhaQualquer | LinhaQualquer[], opcoes?: { onConflict?: string }): this {
    this.operacao = 'upsert'
    this.carga = valores
    this.conflito = opcoes?.onConflict ?? null
    this.comRetorno = false
    return this
  }

  update(valores: LinhaQualquer): this {
    this.operacao = 'update'
    this.carga = valores
    this.comRetorno = false
    return this
  }

  delete(): this {
    this.operacao = 'delete'
    this.comRetorno = false
    return this
  }

  /* ---------------------------------------------------------------- filtros */

  private comparar(coluna: string, op: string, valor: unknown): this {
    this.condicoes.push({
      sql: (ctx, p) => `${p}${ident(coluna)} ${op} ${ctx.param(valor)}`,
    })
    return this
  }

  eq(coluna: string, valor: unknown): this {
    return this.comparar(coluna, '=', valor)
  }
  neq(coluna: string, valor: unknown): this {
    return this.comparar(coluna, '<>', valor)
  }
  gt(coluna: string, valor: unknown): this {
    return this.comparar(coluna, '>', valor)
  }
  gte(coluna: string, valor: unknown): this {
    return this.comparar(coluna, '>=', valor)
  }
  lt(coluna: string, valor: unknown): this {
    return this.comparar(coluna, '<', valor)
  }
  lte(coluna: string, valor: unknown): this {
    return this.comparar(coluna, '<=', valor)
  }
  like(coluna: string, padrao: string): this {
    return this.comparar(coluna, 'like', padrao)
  }
  ilike(coluna: string, padrao: string): this {
    return this.comparar(coluna, 'ilike', padrao)
  }

  is(coluna: string, valor: null | boolean): this {
    this.condicoes.push({
      sql: (_ctx, p) => `${p}${ident(coluna)} is ${valor === null ? 'null' : String(valor)}`,
    })
    return this
  }

  in(coluna: string, valores: readonly unknown[]): this {
    this.condicoes.push({
      sql: (ctx, p) => `${p}${ident(coluna)} = any(${ctx.param([...valores])})`,
    })
    return this
  }

  contains(coluna: string, valores: readonly unknown[] | string): this {
    this.condicoes.push({
      sql: (ctx, p) => `${p}${ident(coluna)} @> ${ctx.param(valores)}`,
    })
    return this
  }

  /** `.not('status', 'in', '("a","b")')` e `.not('x', 'is', null)`. */
  not(coluna: string, op: string, valor: unknown): this {
    this.condicoes.push({
      sql: (ctx, p) => `not (${condicaoSimples(ctx, p, coluna, op, valor)})`,
    })
    return this
  }

  /** A linguagem de filtro do PostgREST: `col.is.null,col.eq.valor`. */
  or(expressao: string): this {
    this.condicoes.push({
      sql: (ctx, p) => {
        const partes = separarNoTopo(expressao).map((parte) => {
          const lido = lerFiltroDoPostgrest(parte)
          if ('erro' in lido) throw new Error(lido.erro)
          return condicaoSimples(ctx, p, lido.coluna, lido.op, lido.valor)
        })
        return `(${partes.join(' or ')})`
      },
    })
    return this
  }

  match(criterio: LinhaQualquer): this {
    for (const [coluna, valor] of Object.entries(criterio)) this.eq(coluna, valor)
    return this
  }

  filter(coluna: string, op: string, valor: unknown): this {
    this.condicoes.push({ sql: (ctx, p) => condicaoSimples(ctx, p, coluna, op, valor) })
    return this
  }

  textSearch(coluna: string, consulta: string, opcoes?: { type?: string; config?: string }): this {
    const funcao =
      opcoes?.type === 'websearch'
        ? 'websearch_to_tsquery'
        : opcoes?.type === 'plain'
          ? 'plainto_tsquery'
          : 'to_tsquery'
    this.condicoes.push({
      sql: (ctx, p) => {
        const cfg = opcoes?.config ? `${ctx.param(opcoes.config)}::regconfig, ` : ''
        return `${p}${ident(coluna)} @@ ${funcao}(${cfg}${ctx.param(consulta)})`
      },
    })
    return this
  }

  /* ------------------------------------------------------------- ordenação */

  order(coluna: string, opcoes?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this.ordenacao.push({
      coluna,
      asc: opcoes?.ascending ?? true,
      nullsFirst: opcoes?.nullsFirst,
    })
    return this
  }

  limit(n: number): this {
    this.limite = n
    return this
  }

  range(de: number, ate: number): this {
    this.deslocamento = de
    this.limite = ate - de + 1
    return this
  }

  /* ----------------------------------------------------------------- forma */

  /* Genéricos como no cliente do Supabase: `maybeSingle<T>()` é a forma usada
     em 7 telas, e sem o parâmetro de tipo o chamador perde a tipagem do
     resultado exatamente onde ela mais ajuda. */
  single<U = T>(): Consulta<U> {
    this.modo = 'um'
    return this as unknown as Consulta<U>
  }
  maybeSingle<U = T>(): Consulta<U> {
    this.modo = 'talvezUm'
    return this as unknown as Consulta<U>
  }
  /** Só tipagem; o Supabase também não faz nada em tempo de execução. */
  returns<U>(): Consulta<U> {
    return this as unknown as Consulta<U>
  }

  /* -------------------------------------------------------------- execução */

  then<R1 = Resultado<T>, R2 = never>(
    aoResolver?: ((valor: Resultado<T>) => R1 | PromiseLike<R1>) | null,
    aoRejeitar?: ((motivo: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.executar().then(aoResolver, aoRejeitar)
  }

  private async executar(): Promise<Resultado<T>> {
    try {
      if (this.preparar) {
        const esquema = await this.preparar()
        this.relacoesEmCache = esquema.relacoes
        this.tiposEmCache = esquema.tipos
      }
      const ctx = new Contexto()
      const { sql } = this.montar(ctx)
      this.ultimoSql = sql
      const { rows, relacoes } = await this.executor(sql, ctx.params)

      // Embutes são montados em SQL; aqui só resta a forma do resultado.
      void relacoes

      const total = this.contar
        ? Number((rows[0]?.['__total'] as string | undefined) ?? rows.length)
        : null
      for (const linha of rows) delete linha['__total']

      if (this.soCabecalho) return { data: null as T, error: null, count: total }

      if (this.modo === 'muitos') {
        return { data: rows as T, error: null, count: total }
      }
      if (rows.length === 0) {
        if (this.modo === 'talvezUm') return { data: null, error: null, count: total }
        return {
          data: null,
          error: { code: 'PGRST116', message: 'nenhuma linha devolvida' },
          count: total,
        }
      }
      if (rows.length > 1 && this.modo === 'um') {
        return {
          data: null,
          error: { code: 'PGRST116', message: 'mais de uma linha devolvida' },
          count: total,
        }
      }
      return { data: rows[0] as T, error: null, count: total }
    } catch (e) {
      const erro = e as { code?: string; message?: string; detail?: string; hint?: string }
      /* O erro vai para o log do servidor com o SQL que o causou. A aplicação
         traduz o código numa frase para a pessoa e ESCONDE o resto, que é
         certo — mas em desenvolvimento, sem este registro, a investigação
         começa adivinhando. */
      console.error('[db]', erro.code, erro.message, '\n  sql:', this.ultimoSql)
      return {
        data: null,
        error: {
          code: erro.code,
          message: erro.message ?? String(e),
          details: erro.detail ?? null,
          hint: erro.hint ?? null,
        },
      }
    }
  }

  /** Visível para teste: o SQL e os parâmetros, sem ir ao banco. */
  montarParaTeste(): { sql: string; params: unknown[] } {
    const ctx = new Contexto()
    const { sql } = this.montar(ctx)
    return { sql, params: ctx.params }
  }

  private montar(ctx: Contexto): { sql: string } {
    const alvo = `${ident(this.esquema)}.${ident(this.tabela)}`

    if (this.operacao === 'rpc') {
      const args = Object.entries(this.argsRpc ?? {})
      const lista = args.map(([nome, valor]) => `${ident(nome)} => ${ctx.param(valor)}`).join(', ')
      /* `select *` sobre a função: devolve a tabela quando ela é `returns
         table`, e uma coluna só quando é escalar — que é o mesmo que o
         PostgREST entrega. */
      return { sql: `select * from ${alvo}(${lista})` }
    }

    /*
     * A ordem de montagem segue a ordem do SQL, e isso não é estética: os
     * parâmetros são numerados na ordem em que são criados. Montar o `where`
     * antes do `set` produziria `set x = $2 where y = $1` — que funciona, e que
     * ninguém consegue ler num log.
     *
     * E tem um motivo mais forte: compilar a SELEÇÃO é o que descobre os
     * `!inner`, que viram condição no `where`. Montar o `where` primeiro
     * perderia essas condições em silêncio, e `!inner` passaria a se comportar
     * como junção à esquerda.
     */
    if (this.operacao === 'select') {
      const colunas = this.compilarSelecao(ctx, 't', this.tabela)
      const extra = this.contar ? `, count(*) over() as "__total"` : ''
      const onde = this.compilarOnde(ctx)
      const ordem = this.compilarOrdem('t.')
      const fim = this.compilarPaginacao()
      return { sql: `select ${colunas}${extra} from ${alvo} t${onde}${ordem}${fim}` }
    }

    if (this.operacao === 'delete') {
      const onde = this.compilarOnde(ctx)
      const retorno = this.compilarRetorno(ctx)
      return { sql: `delete from ${alvo} t${onde}${retorno}` }
    }

    if (this.operacao === 'update') {
      const sets = Object.entries(this.carga as LinhaQualquer)
        .map(([col, val]) => `${ident(col)} = ${ctx.param(this.valorParaColuna(col, val))}`)
        .join(', ')
      const onde = this.compilarOnde(ctx)
      const retorno = this.compilarRetorno(ctx)
      return { sql: `update ${alvo} t set ${sets}${onde}${retorno}` }
    }

    // insert e upsert
    const linhas = Array.isArray(this.carga) ? this.carga : [this.carga as LinhaQualquer]
    if (linhas.length === 0) return { sql: `select 1 where false` }

    /* As colunas são a UNIÃO das chaves de todas as linhas: um lote em que a
       segunda linha traz um campo que a primeira não tinha é comum (importação
       de títulos, por exemplo), e usar só as chaves da primeira perderia o
       campo em silêncio. */
    const colunas = [...new Set(linhas.flatMap((l) => Object.keys(l)))]
    const valores = linhas
      .map(
        (l) =>
          `(${colunas.map((c) => ctx.param(this.valorParaColuna(c, l[c] ?? null))).join(', ')})`,
      )
      .join(', ')

    let conflito = ''
    if (this.operacao === 'upsert') {
      const alvoConflito = this.conflito
        ? `(${this.conflito
            .split(',')
            .map((c) => ident(c.trim()))
            .join(', ')})`
        : ''
      const atualiza = colunas.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ')
      conflito = ` on conflict ${alvoConflito} do update set ${atualiza}`
    }

    const retorno = this.compilarRetorno(ctx)
    return {
      sql:
        /* `as t`, e não `t` solto: o PostgreSQL aceita alias sem `as` em
           `update` e `delete`, mas NÃO em `insert` — ali é erro de sintaxe
           (42601). O alias existe para o `returning` poder dizer `t."id"`. */
        `insert into ${alvo} as t (${colunas.map(ident).join(', ')}) values ${valores}` +
        `${conflito}${retorno}`,
    }
  }

  private compilarOnde(ctx: Contexto): string {
    if (this.condicoes.length === 0) return ''
    return ' where ' + this.condicoes.map((c) => c.sql(ctx, 't.')).join(' and ')
  }

  private compilarRetorno(ctx: Contexto): string {
    if (!this.comRetorno) return ''
    return ` returning ${this.compilarSelecao(ctx, 't', this.tabela)}`
  }

  private compilarOrdem(prefixo: string): string {
    if (this.ordenacao.length === 0) return ''
    const partes = this.ordenacao.map((o) => {
      const dir = o.asc ? 'asc' : 'desc'
      const nulos =
        o.nullsFirst === undefined ? '' : o.nullsFirst ? ' nulls first' : ' nulls last'
      return `${prefixo}${ident(o.coluna)} ${dir}${nulos}`
    })
    return ` order by ${partes.join(', ')}`
  }

  private compilarPaginacao(): string {
    let fim = ''
    if (this.limite !== null) fim += ` limit ${Number(this.limite)}`
    if (this.deslocamento) fim += ` offset ${Number(this.deslocamento)}`
    return fim
  }

  private compilarSelecao(ctx: Contexto, alias: string, tabela: string): string {
    const campos = analisarSelecao(this.selecao)
    if ('erro' in campos) throw new Error(`seleção inválida: ${campos.erro}`)
    return compilarCampos(ctx, campos, alias, tabela, this.relacoesEmCache, 0, this.condicoes)
  }

  /** Preenchidos pelo cliente antes de executar — ver `cliente.ts`. */
  relacoesEmCache: Relacao[] = []
  tiposEmCache: TiposDeColuna = new Map()
  private ultimoSql = ''

  /**
   * O valor como o PostgreSQL espera recebê-lo nesta coluna.
   *
   * Só uma conversão acontece aqui, e ela é obrigatória: objeto ou array de
   * JavaScript indo para coluna `json`/`jsonb` precisa virar TEXTO JSON. O
   * driver `pg`, sozinho, escreveria `{a,b}` — a sintaxe de array do
   * PostgreSQL —, e `jsonb_typeof` disso não é `array`.
   */
  private valorParaColuna(coluna: string, valor: unknown): unknown {
    if (valor === null || valor === undefined) return null
    const tipo = this.tiposEmCache.get(this.tabela)?.get(coluna)
    if ((tipo === 'jsonb' || tipo === 'json') && typeof valor === 'object') {
      return JSON.stringify(valor)
    }
    return valor
  }
}

/* ------------------------------------------------------------------ embutes */

function compilarCampos(
  ctx: Contexto,
  campos: Campo[],
  alias: string,
  tabela: string,
  relacoes: Relacao[],
  nivel: number,
  condicoesDeFora: Condicao[],
): string {
  const partes: string[] = []

  for (const campo of campos) {
    if (campo.tipo === 'coluna') {
      if (campo.nome === '*') {
        partes.push(`${alias}.*`)
      } else {
        partes.push(`${alias}.${ident(campo.nome)} as ${ident(nomeDeSaida(campo))}`)
      }
      continue
    }
    partes.push(compilarEmbute(ctx, campo, alias, tabela, relacoes, nivel, condicoesDeFora))
  }

  return partes.join(', ')
}

function compilarEmbute(
  ctx: Contexto,
  embute: Embute,
  aliasDeFora: string,
  tabelaDeFora: string,
  relacoes: Relacao[],
  nivel: number,
  condicoesDeFora: Condicao[],
): string {
  const ligacao = resolverLigacao(relacoes, tabelaDeFora, embute.alvo, embute.dica)
  if ('erro' in ligacao) throw new Error(ligacao.erro)

  const aliasDentro = `e${nivel}_${partesSeguras(embute.apelido ?? embute.alvo)}`
  const juncao = ligacao.colunasDeFora
    .map(
      (col, i) =>
        `${aliasDentro}.${ident(ligacao.colunasDeDentro[i]!)} = ${aliasDeFora}.${ident(col)}`,
    )
    .join(' and ')

  const internas = compilarCampos(
    ctx,
    embute.campos,
    aliasDentro,
    ligacao.tabela,
    relacoes,
    nivel + 1,
    condicoesDeFora,
  )

  const base =
    `select ${internas} from "public".${ident(ligacao.tabela)} ${aliasDentro} where ${juncao}`

  /*
   * `!inner` precisa descartar a linha de FORA, e um subselect no `select` não
   * consegue fazer isso — ele só devolveria nulo. A condição de existência vai
   * para o `where` de fora, que é onde ela tem efeito.
   */
  if (embute.interno) {
    condicoesDeFora.push({
      sql: () => `exists (select 1 from "public".${ident(ligacao.tabela)} ${aliasDentro}_x where ${
        ligacao.colunasDeFora
          .map(
            (col, i) =>
              `${aliasDentro}_x.${ident(ligacao.colunasDeDentro[i]!)} = ${aliasDeFora}.${ident(col)}`,
          )
          .join(' and ')
      })`,
    })
  }

  if (ligacao.cardinalidade === 'um') {
    return `(select to_jsonb(sub) from (${base} limit 1) sub) as ${ident(
      embute.apelido ?? embute.alvo,
    )}`
  }
  /* Lista vazia, e não nulo: a tela faz `(x ?? []).map(...)`, e `null` ali
     quebraria onde uma lista vazia simplesmente não desenha nada. */
  return `coalesce((select jsonb_agg(sub) from (${base}) sub), '[]'::jsonb) as ${ident(
    embute.apelido ?? embute.alvo,
  )}`
}

function partesSeguras(nome: string): string {
  return nome.replace(/[^A-Za-z0-9_]/g, '_')
}

/* ------------------------------------------------- linguagem de filtro */

function condicaoSimples(
  ctx: Contexto,
  prefixo: string,
  coluna: string,
  op: string,
  valor: unknown,
): string {
  const campo = `${prefixo}${ident(coluna)}`
  switch (op) {
    case 'is':
      return `${campo} is ${valor === null ? 'null' : String(valor)}`
    case 'in': {
      const lista = Array.isArray(valor) ? valor : lerListaEntreParenteses(String(valor))
      return `${campo} = any(${ctx.param(lista)})`
    }
    case 'eq':
      return `${campo} = ${ctx.param(valor)}`
    case 'neq':
      return `${campo} <> ${ctx.param(valor)}`
    case 'gt':
      return `${campo} > ${ctx.param(valor)}`
    case 'gte':
      return `${campo} >= ${ctx.param(valor)}`
    case 'lt':
      return `${campo} < ${ctx.param(valor)}`
    case 'lte':
      return `${campo} <= ${ctx.param(valor)}`
    case 'like':
      return `${campo} like ${ctx.param(valor)}`
    case 'ilike':
      return `${campo} ilike ${ctx.param(valor)}`
    default:
      throw new Error(`operador de filtro não suportado: ${op}`)
  }
}

/** `("resolved","closed")` e `(a,b,c)` viram lista. */
export function lerListaEntreParenteses(texto: string): string[] {
  const dentro = texto.trim().replace(/^\(/, '').replace(/\)$/, '')
  if (dentro.trim() === '') return []
  return dentro.split(',').map((p) => p.trim().replace(/^"(.*)"$/, '$1'))
}

/** Separa por vírgula respeitando parênteses — `a.in.(1,2),b.eq.3` são DOIS. */
export function separarNoTopo(texto: string): string[] {
  const partes: string[] = []
  let profundidade = 0
  let atual = ''
  for (const ch of texto) {
    if (ch === '(') profundidade += 1
    if (ch === ')') profundidade -= 1
    if (ch === ',' && profundidade === 0) {
      partes.push(atual)
      atual = ''
      continue
    }
    atual += ch
  }
  if (atual.trim() !== '') partes.push(atual)
  return partes.map((p) => p.trim()).filter((p) => p !== '')
}

export function lerFiltroDoPostgrest(
  parte: string,
): { coluna: string; op: string; valor: unknown } | { erro: string } {
  const primeiro = parte.indexOf('.')
  if (primeiro <= 0) return { erro: `filtro sem coluna: "${parte}"` }
  const segundo = parte.indexOf('.', primeiro + 1)
  if (segundo < 0) return { erro: `filtro sem valor: "${parte}"` }

  const coluna = parte.slice(0, primeiro)
  const op = parte.slice(primeiro + 1, segundo)
  const cru = parte.slice(segundo + 1)

  if (op === 'is') return { coluna, op, valor: cru === 'null' ? null : cru === 'true' }
  if (op === 'in') return { coluna, op, valor: lerListaEntreParenteses(cru) }
  return { coluna, op, valor: cru }
}
