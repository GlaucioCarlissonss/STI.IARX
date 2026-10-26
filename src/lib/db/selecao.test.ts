import { describe, expect, it } from 'vitest'
import { analisarSelecao, nomeDeSaida, type Campo, type Embute } from './selecao'

/**
 * O que estes testes protegem
 * ---------------------------
 * Todas as 333 chamadas de `.select()` do app passam por aqui. Um erro de
 * análise não aparece como erro: aparece como coluna que some do resultado, ou
 * como junção que multiplica linhas — três camadas adiante, numa tela, sem
 * nada apontando para a causa.
 *
 * As strings usadas aqui são copiadas de telas reais deste repositório.
 */

const ok = (texto: string): Campo[] => {
  const r = analisarSelecao(texto)
  if ('erro' in r) throw new Error(`não deveria falhar: ${r.erro}`)
  return r
}

describe('colunas simples', () => {
  it('lê uma lista separada por vírgula', () => {
    const campos = ok('id, name, created_at')
    expect(campos).toHaveLength(3)
    expect(campos.map((c) => nomeDeSaida(c))).toEqual(['id', 'name', 'created_at'])
  })

  it('aceita espaço e quebra de linha em volta', () => {
    expect(ok('  id ,\n  name  ')).toHaveLength(2)
  })

  it('vazio e asterisco pedem tudo', () => {
    expect(ok('')[0]).toEqual({ tipo: 'coluna', nome: '*', apelido: null })
    expect(ok('*')[0]!.tipo).toBe('coluna')
  })

  it('entende apelido de coluna', () => {
    const [c] = ok('rotulo:label')
    expect(c).toEqual({ tipo: 'coluna', nome: 'label', apelido: 'rotulo' })
    expect(nomeDeSaida(c!)).toBe('rotulo')
  })
})

describe('embutes', () => {
  it('lê o embute mais comum do app', () => {
    const campos = ok('id, author:profiles(full_name, role)')
    expect(campos).toHaveLength(2)
    const e = campos[1] as Embute
    expect(e.tipo).toBe('embute')
    expect(e.alvo).toBe('profiles')
    expect(e.apelido).toBe('author')
    expect(e.campos.map((c) => nomeDeSaida(c))).toEqual(['full_name', 'role'])
  })

  it('a vírgula de DENTRO não separa campos de fora', () => {
    /*
     * Foi a primeira tentativa, com `split(',')`, e quebrou em todo embute com
     * mais de uma coluna: `a(b,c),d` virava três campos, e `c)` virava uma
     * coluna inexistente.
     */
    const campos = ok('asset:it_assets(asset_tag, brand, model), created_at')
    expect(campos).toHaveLength(2)
    expect((campos[0] as Embute).campos).toHaveLength(3)
    expect(nomeDeSaida(campos[1]!)).toBe('created_at')
  })

  it('aceita embute dentro de embute', () => {
    // Vem da tela de conversas, e é a forma mais profunda usada no app.
    const [e] = ok('conversa:channel_conversations(contato:channel_contacts(external_id))')
    const externo = e as Embute
    const interno = externo.campos[0] as Embute
    expect(externo.alvo).toBe('channel_conversations')
    expect(interno.tipo).toBe('embute')
    expect(interno.alvo).toBe('channel_contacts')
    expect(nomeDeSaida(interno.campos[0]!)).toBe('external_id')
  })

  it('entende o embute pelo nome da CONSTRAINT', () => {
    // `kb_articles_author_id_fkey(full_name)`: quando há duas FKs para a mesma
    // tabela, o nome da tabela não basta — e o app usa essa forma.
    const [e] = ok('kb_articles_author_id_fkey(full_name)')
    expect((e as Embute).alvo).toBe('kb_articles_author_id_fkey')
  })

  it('entende o embute pelo nome da COLUNA de chave estrangeira', () => {
    // `decisor:decided_by(full_name)` — usado na tela de aprovação de pedido.
    const [e] = ok('decisor:decided_by(full_name)')
    expect((e as Embute).alvo).toBe('decided_by')
    expect((e as Embute).apelido).toBe('decisor')
  })

  it('marca !inner, que muda o resultado e não só a consulta', () => {
    /*
     * `!inner` descarta a linha de fora quando não há correspondência. É a
     * diferença entre "todos os chamados" e "os chamados que têm conversa" — e
     * tratar os dois como junção à esquerda devolveria linhas que a tela não
     * deveria mostrar.
     */
    const [e] = ok('tickets!inner(ticket_number, title, client_id)')
    expect((e as Embute).interno).toBe(true)
    expect((e as Embute).dica).toBeNull()
  })

  it('separa a dica de constraint do !inner', () => {
    const [e] = ok('t:tickets!fk_algo!inner(id)')
    expect((e as Embute).dica).toBe('fk_algo')
    expect((e as Embute).interno).toBe(true)
  })
})

describe('erros', () => {
  it('parêntese sem fechar é erro, e diz de quem', () => {
    const r = analisarSelecao('id, author:profiles(full_name')
    expect('erro' in r).toBe(true)
    expect((r as { erro: string }).erro).toContain('profiles')
  })

  it('apelido sem campo depois é erro', () => {
    expect('erro' in analisarSelecao('author:')).toBe(true)
  })

  it('dica de junção sem campos é recusada', () => {
    // Aceitar calado produziria uma coluna chamada "tickets", que não existe.
    expect('erro' in analisarSelecao('tickets!inner')).toBe(true)
  })

  it('sobra no fim é erro, em vez de ser ignorada', () => {
    expect('erro' in analisarSelecao('id)')).toBe(true)
  })
})
