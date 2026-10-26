/**
 * O analisador do `select` do PostgREST.
 *
 * ## Por que isto existe
 *
 * O app inteiro conversa com o banco pela forma do cliente Supabase:
 * `.from('tickets').select('id, author:profiles(full_name)')`. Essa string não
 * é SQL — é a linguagem de seleção do PostgREST, com aninhamento, apelido,
 * dica de chave estrangeira e junção interna.
 *
 * Para o app rodar contra um PostgreSQL direto, sem Supabase, alguém precisa
 * entender essa string. É este arquivo.
 *
 * ## Por que o analisador é separado do gerador de SQL
 *
 * Porque ele é a única metade que dá para testar sem banco nenhum. Erro de
 * análise aqui vira coluna faltando ou junção errada três camadas adiante, e
 * depurar isso pela consulta final custa muito mais caro que uma asserção sobre
 * a árvore.
 *
 * ## O que ele NÃO faz
 *
 * Não valida se a tabela ou a coluna existem — isso é com o banco, que já
 * responde com erro claro. Aqui só se resolve a forma.
 */

/** Um campo pedido: coluna simples ou embute de outra tabela. */
export type Campo = Coluna | Embute

export interface Coluna {
  tipo: 'coluna'
  /** Nome no banco. */
  nome: string
  /** Apelido pedido com `apelido:coluna`. */
  apelido: string | null
}

export interface Embute {
  tipo: 'embute'
  /**
   * O alvo escrito pela pessoa. Pode ser o nome da tabela (`profiles`), o nome
   * da COLUNA de chave estrangeira (`decided_by`) ou o nome da própria
   * constraint (`kb_articles_author_id_fkey`). O PostgREST aceita os três, e o
   * app usa os três.
   */
  alvo: string
  /** Apelido pedido com `apelido:tabela(...)`. */
  apelido: string | null
  /** Dica depois de `!`, como em `tickets!fk_algo(...)`. */
  dica: string | null
  /** `!inner`: linha sem correspondência some do resultado. */
  interno: boolean
  campos: Campo[]
}

export interface ErroDeSelecao {
  erro: string
}

/** O nome pelo qual o campo aparece no JSON devolvido. */
export function nomeDeSaida(campo: Campo): string {
  if (campo.tipo === 'coluna') return campo.apelido ?? campo.nome
  return campo.apelido ?? campo.alvo
}

/**
 * Analisa a string de seleção.
 *
 * A gramática, na prática:
 *
 *     lista   := campo (',' campo)*
 *     campo   := [apelido ':'] alvo ['!' dica] [ '(' lista ')' ]
 *
 * O caractere que decide tudo é o parêntese: com ele, é embute; sem ele, é
 * coluna. E a vírgula só separa no nível de fora — `a(b,c),d` são DOIS campos,
 * não três. É por isso que não dá para usar `split(',')`, que foi a primeira
 * tentativa e quebrou em todo embute com mais de uma coluna.
 */
export function analisarSelecao(texto: string): Campo[] | ErroDeSelecao {
  const limpo = (texto ?? '').trim()
  if (limpo === '' || limpo === '*') {
    return [{ tipo: 'coluna', nome: '*', apelido: null }]
  }

  const estado = { pos: 0, texto: limpo }
  const campos = lerLista(estado)
  if ('erro' in campos) return campos

  if (estado.pos < limpo.length) {
    return { erro: `sobra na seleção a partir de "${limpo.slice(estado.pos)}"` }
  }
  return campos.lista
}

interface Estado {
  pos: number
  texto: string
}

function lerLista(e: Estado): { lista: Campo[] } | ErroDeSelecao {
  const lista: Campo[] = []

  for (;;) {
    pularEspaco(e)
    const campo = lerCampo(e)
    if ('erro' in campo) return campo
    lista.push(campo.campo)

    pularEspaco(e)
    if (e.texto[e.pos] === ',') {
      e.pos += 1
      continue
    }
    return { lista }
  }
}

function lerCampo(e: Estado): { campo: Campo } | ErroDeSelecao {
  const primeiro = lerIdentificador(e)
  if (primeiro === '') {
    return { erro: `esperava um nome de campo na posição ${e.pos}` }
  }

  let apelido: string | null = null
  let alvo = primeiro

  pularEspaco(e)
  if (e.texto[e.pos] === ':') {
    e.pos += 1
    pularEspaco(e)
    apelido = primeiro
    alvo = lerIdentificador(e)
    if (alvo === '') return { erro: `apelido "${apelido}" sem campo depois dos dois-pontos` }
  }

  /* A dica vem depois de `!`. Pode ser o nome de uma constraint, ou `inner`.
     As duas coisas convivem: `tabela!fk_x!inner(...)` é válido no PostgREST. */
  let dica: string | null = null
  let interno = false
  pularEspaco(e)
  while (e.texto[e.pos] === '!') {
    e.pos += 1
    const palavra = lerIdentificador(e)
    if (palavra === 'inner') interno = true
    else if (palavra === 'left') interno = false
    else if (palavra !== '') dica = palavra
    pularEspaco(e)
  }

  if (e.texto[e.pos] === '(') {
    e.pos += 1
    const dentro = lerLista(e)
    if ('erro' in dentro) return dentro
    pularEspaco(e)
    if (e.texto[e.pos] !== ')') {
      return { erro: `falta fechar o parêntese de "${alvo}"` }
    }
    e.pos += 1
    return { campo: { tipo: 'embute', alvo, apelido, dica, interno, campos: dentro.lista } }
  }

  if (dica || interno) {
    /* `tabela!inner` sem parênteses não pede coluna nenhuma da outra tabela:
       é só um filtro de existência. O app não usa essa forma, e aceitá-la
       calado produziria uma coluna chamada "tabela" que não existe. */
    return { erro: `"${alvo}" tem dica de junção mas não pede campo nenhum` }
  }

  return { campo: { tipo: 'coluna', nome: alvo, apelido } }
}

function pularEspaco(e: Estado): void {
  while (e.pos < e.texto.length && /\s/.test(e.texto[e.pos]!)) e.pos += 1
}

function lerIdentificador(e: Estado): string {
  const inicio = e.pos
  while (e.pos < e.texto.length && /[A-Za-z0-9_*]/.test(e.texto[e.pos]!)) e.pos += 1
  return e.texto.slice(inicio, e.pos)
}
