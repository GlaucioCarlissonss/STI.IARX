import { describe, expect, it } from 'vitest'
import { BOM, cabecalhosDeCsv, montarCsv, nomeDoArquivo } from './exportacao'

/**
 * A exportação carrega texto escrito por terceiros — título de chamado, nome de
 * cliente, mensagem de WhatsApp — para dentro de um programa que executa
 * fórmulas. É por isso que o teste de injeção é o primeiro aqui.
 */

interface Linha {
  titulo: string
  minutos: number | null
  ativo: boolean
}

const colunas = [
  { titulo: 'Título', valor: (l: Linha) => l.titulo },
  { titulo: 'Minutos', valor: (l: Linha) => l.minutos },
  { titulo: 'Ativo', valor: (l: Linha) => l.ativo },
]

describe('injeção de fórmula', () => {
  it('neutraliza célula que começa com = + - @', () => {
    /*
     * `=cmd|'/c calc'!A1` numa célula roda um comando na máquina de quem abre o
     * arquivo no Excel. O conteúdo vem de campo livre preenchido por terceiros,
     * então isto não é hipótese — é o cenário normal de um chamado aberto por
     * WhatsApp.
     */
    for (const perigoso of ['=1+1', '+1', '-1', '@SUM(A1)', '\t=1']) {
      const csv = montarCsv([{ titulo: perigoso, minutos: 1, ativo: true }], colunas)
      const campo = csv.split('\r\n')[1]!.split(';')[0]!
      expect(campo.startsWith("'") || campo.startsWith('"\'')).toBe(true)
    }
  })

  it('e não estraga texto normal', () => {
    const csv = montarCsv([{ titulo: 'Impressora parou', minutos: 1, ativo: true }], colunas)
    expect(csv).toContain('Impressora parou')
    expect(csv).not.toContain("'Impressora")
  })
})

describe('o formato que o Excel brasileiro entende', () => {
  it('separa com ponto e vírgula, não com vírgula', () => {
    // Com vírgula, o Excel pt-BR abre tudo na primeira coluna: ele lê vírgula
    // como separador DECIMAL.
    const csv = montarCsv([{ titulo: 'a', minutos: 2, ativo: false }], colunas)
    expect(csv.split('\r\n')[0]).toBe(`${BOM}Título;Minutos;Ativo`)
  })

  it('começa com BOM', () => {
    // Sem ele, o Excel abre UTF-8 como Latin-1 e todo acento vira caractere
    // estranho. É o motivo nº 1 de "a exportação veio toda errada".
    expect(montarCsv([], colunas).startsWith(BOM)).toBe(true)
  })

  it('decimal com vírgula', () => {
    const csv = montarCsv([{ titulo: 'a', minutos: 1.5, ativo: true }], colunas)
    expect(csv).toContain(';1,5;')
  })

  it('booleano em português', () => {
    const csv = montarCsv([{ titulo: 'a', minutos: 0, ativo: false }], colunas)
    expect(csv.trim().endsWith('não')).toBe(true)
  })

  it('termina as linhas com CRLF', () => {
    const csv = montarCsv([{ titulo: 'a', minutos: 0, ativo: true }], colunas)
    expect(csv.endsWith('\r\n')).toBe(true)
  })
})

describe('escape', () => {
  it('põe entre aspas quem tem separador, aspas ou quebra de linha', () => {
    // Descrição de chamado tem quebra de linha com frequência, e sem aspas ela
    // parte a planilha ao meio.
    const csv = montarCsv(
      [{ titulo: 'linha 1\nlinha 2; com ponto e vírgula e "aspas"', minutos: 0, ativo: true }],
      colunas,
    )
    expect(csv).toContain('"linha 1\nlinha 2; com ponto e vírgula e ""aspas"""')
  })

  it('nulo vira célula vazia, não "null"', () => {
    const csv = montarCsv([{ titulo: 'a', minutos: null, ativo: true }], colunas)
    expect(csv).toContain('a;;sim')
  })
})

describe('cabeçalho e nome', () => {
  it('o cabeçalho sai em português, na ordem declarada', () => {
    /*
     * Colunas explícitas, e não `Object.keys`: a ordem das chaves de um objeto do
     * PostgREST não é contratual, e uma planilha com `resolution_due_at` na
     * primeira linha não é exportação, é despejo.
     */
    expect(montarCsv([], colunas).split('\r\n')[0]).toContain('Título;Minutos;Ativo')
  })

  it('o arquivo leva a data', () => {
    // Sem data vira `relatorio.csv` cinco vezes na pasta de downloads.
    expect(nomeDoArquivo('trilha')).toMatch(/^trilha-\d{4}-\d{2}-\d{2}\.csv$/)
  })

  it('o download não é guardado em cache', () => {
    // Ele reflete o escopo de RLS de quem pediu: servir de cache entregaria o
    // arquivo de uma pessoa para outra.
    const h = cabecalhosDeCsv('trilha') as Record<string, string>
    expect(h['cache-control']).toBe('no-store')
    expect(h['content-disposition']).toContain('attachment')
  })
})

describe('lista vazia', () => {
  it('gera só o cabeçalho, e não um arquivo quebrado', () => {
    // Exportar uma lista filtrada que não achou nada é caso normal. O arquivo
    // com só o cabeçalho diz "procurei e não havia".
    const csv = montarCsv([], colunas)
    expect(csv).toBe(`${BOM}Título;Minutos;Ativo\r\n`)
  })
})
