import { describe, expect, it } from 'vitest'
import { enderecoDaPagina, lerPagina, TAMANHO_PADRAO, totalDePaginas } from './paginacao'

/**
 * A paginação mexe em duas coisas que quebram em silêncio.
 *
 * A primeira é o `?pagina=` da barra de endereço, que qualquer pessoa pode
 * editar e qualquer link pode trazer torto. Uma exceção ali derrubaria a tela
 * inteira por causa de um número malformado.
 *
 * A segunda é a preservação dos filtros entre páginas: ir para a página 2 de
 * uma busca e receber a página 2 da lista inteira parece defeito do FILTRO, não
 * da paginação — e é o tipo de coisa que ninguém reporta direito.
 */

describe('lerPagina', () => {
  it('sem parâmetro, é a primeira página e o recorte começa no zero', () => {
    const p = lerPagina(undefined)
    expect(p).toEqual({ numero: 1, de: 0, ate: TAMANHO_PADRAO - 1, tamanho: TAMANHO_PADRAO })
  })

  it('a página 3 recorta a terceira faixa, inclusive nos dois extremos', () => {
    const p = lerPagina('3', 50)
    expect(p.numero).toBe(3)
    expect(p.de).toBe(100)
    // `.range()` do PostgREST é inclusivo no fim: 100–149 são 50 linhas, não 51.
    expect(p.ate).toBe(149)
    expect(p.ate - p.de + 1).toBe(50)
  })

  it.each([
    ['texto', 'abc'],
    ['vazio', ''],
    ['zero', '0'],
    ['negativo', '-3'],
    ['fracionário', '2.5'],
  ])('%s cai na primeira página em vez de estourar', (_nome, bruto) => {
    expect(lerPagina(bruto).numero).toBe(1)
  })

  it.each([
    ['decimal gigante', '99999999999'],
    // `Number('1e9')` é 1000000000, um inteiro válido — não é entrada
    // malformada, é um número grande demais. Por isso ele é LIMITADO, e não
    // tratado como lixo: o tratamento certo depende de qual dos dois é.
    ['notação científica', '1e9'],
  ])('%s é limitado, e a consulta volta vazia em vez de travar', (_nome, bruto) => {
    /*
     * Sem o teto, `?pagina=99999999999` viraria um `offset` que o Postgres
     * precisa percorrer antes de descobrir que não há nada — uma varredura
     * completa provocada por quem só editou a URL.
     */
    const p = lerPagina(bruto)
    expect(p.numero).toBe(100_000)
    expect(Number.isSafeInteger(p.de)).toBe(true)
  })
})

describe('totalDePaginas', () => {
  it('arredonda para cima — 101 registros em páginas de 50 são 3 páginas', () => {
    expect(totalDePaginas(101, 50)).toBe(3)
  })

  it('exato não cria página vazia a mais', () => {
    expect(totalDePaginas(100, 50)).toBe(2)
  })

  it('lista vazia ainda é uma página, e não zero', () => {
    // "página 1 de 0" seria absurdo na tela.
    expect(totalDePaginas(0, 50)).toBe(1)
  })
})

describe('enderecoDaPagina', () => {
  it('preserva os filtros ao trocar de página', () => {
    const url = enderecoDaPagina('/tickets', { status: 'abertos', busca: 'internet' }, 2)
    expect(url).toContain('status=abertos')
    expect(url).toContain('busca=internet')
    expect(url).toContain('pagina=2')
  })

  it('a primeira página não carrega o parâmetro — é o endereço que se copia', () => {
    expect(enderecoDaPagina('/tickets', { status: 'abertos' }, 1)).toBe('/tickets?status=abertos')
  })

  it('sem filtro nenhum, a primeira página é o endereço limpo', () => {
    expect(enderecoDaPagina('/inventario', {}, 1)).toBe('/inventario')
  })

  it('descarta o `pagina` que veio nos parâmetros, em vez de duplicá-lo', () => {
    const url = enderecoDaPagina('/tickets', { pagina: '7', busca: 'x' }, 2)
    expect(url.match(/pagina=/g)).toHaveLength(1)
    expect(url).toContain('pagina=2')
  })

  it('ignora filtro vazio — `?fila=` não é um filtro, é ruído no endereço', () => {
    expect(enderecoDaPagina('/tickets', { fila: '', busca: 'x' }, 1)).toBe('/tickets?busca=x')
  })

  it('escapa o que a pessoa digitou na busca', () => {
    // Sem escapar, uma busca por "a&b=c" viraria dois parâmetros e o filtro
    // voltaria diferente do que foi digitado.
    const url = enderecoDaPagina('/tickets', { busca: 'a&b=c' }, 2)
    expect(url).toContain('busca=a%26b%3Dc')
    expect(new URL(url, 'http://x').searchParams.get('busca')).toBe('a&b=c')
  })
})
