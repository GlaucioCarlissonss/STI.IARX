/**
 * Exportação em CSV.
 *
 * ## A decisão que estava pendente (LG-11)
 *
 * Quatro módulos do roadmap pedem exportação e nenhum tinha. A lacuna
 * recomendava **gerar no servidor**, para que o arquivo respeite exatamente o
 * escopo de RLS de quem pediu e não dependa do que o navegador carregou — e é o
 * que está feito: a rota `/api/exportar/[recurso]` usa o cliente de sessão, as
 * mesmas policies de sempre, e o arquivo sai com as linhas que aquela pessoa
 * enxerga. Nem uma a mais.
 *
 * ## Por que CSV e não XLSX ou PDF
 *
 * XLSX exige biblioteca (`exceljs` pesa ~1 MB) e PDF exige duas — uma para
 * montar e outra para fontes. CSV abre no Excel, no LibreOffice e no Google
 * Sheets, não acrescenta dependência nenhuma, e é o formato que quem recebe
 * realmente usa: a planilha quase sempre vira outra planilha.
 *
 * Quando alguém pedir o PDF carimbado para um auditor, aí a biblioteca se
 * justifica. Hoje ela seria peso sem uso.
 *
 * ## Duas armadilhas do CSV que este módulo resolve
 *
 * **Separador.** O Excel em português lê vírgula como separador decimal, não de
 * coluna: um CSV com vírgula abre com tudo na primeira coluna. O separador aqui
 * é ponto e vírgula, que é o que o Excel pt-BR espera.
 *
 * **BOM.** Sem a marca de ordem de bytes, o Excel abre UTF-8 como Latin-1 e todo
 * acento vira caractere estranho. Três bytes resolvem, e a ausência deles é o
 * motivo nº 1 de "a exportação veio toda errada".
 */

/**
 * Neutraliza injeção de fórmula.
 *
 * Uma célula que começa com `=`, `+`, `-`, `@`, tab ou CR é interpretada pelo
 * Excel e pelo Sheets como **fórmula** — e `=cmd|'/c calc'!A1` roda um comando
 * na máquina de quem abre o arquivo. O conteúdo exportado daqui vem de campo
 * livre preenchido por terceiros (título de chamado, nome de cliente, comentário
 * de canal), então isto não é hipótese.
 *
 * A defesa é prefixar com apóstrofo: o Excel mostra o texto e não avalia nada.
 * Não é bonito e é o que existe — o formato não tem como marcar "isto é texto".
 */
function neutralizarFormula(texto: string): string {
  return /^[=+\-@\t\r]/.test(texto) ? `'${texto}` : texto
}

function celula(valor: unknown): string {
  if (valor === null || valor === undefined) return ''

  if (valor instanceof Date) return valor.toISOString()
  if (typeof valor === 'boolean') return valor ? 'sim' : 'não'
  if (typeof valor === 'number') {
    /* Decimal com vírgula, que é o que o Excel pt-BR entende como número. Com
       ponto, ele lê 1.5 como texto ou como 15, dependendo da versão. */
    return String(valor).replace('.', ',')
  }

  const texto =
    typeof valor === 'object' ? JSON.stringify(valor) : String(valor)
  const seguro = neutralizarFormula(texto)

  /* Aspas duplicadas e campo entre aspas sempre que houver separador, aspas ou
     quebra de linha. Descrição de chamado tem quebra de linha com frequência, e
     sem isto ela parte a planilha ao meio. */
  if (/[;"\n\r]/.test(seguro)) {
    return `"${seguro.replace(/"/g, '""')}"`
  }
  return seguro
}

/** Marca de ordem de bytes — sem ela o Excel abre UTF-8 como Latin-1. */
export const BOM = '﻿'

export interface ColunaExportada<T> {
  /** Cabeçalho, em português, como a pessoa vai ler na planilha. */
  titulo: string
  /** Como extrair o valor da linha. */
  valor: (linha: T) => unknown
}

/**
 * Monta o CSV inteiro.
 *
 * Recebe colunas explícitas, e não `Object.keys(linha)`, por dois motivos: a
 * ordem das chaves de um objeto vindo do PostgREST não é contratual, e o
 * cabeçalho precisa estar em português. Uma planilha com `resolution_due_at` na
 * primeira linha não é uma exportação, é um despejo.
 */
export function montarCsv<T>(linhas: readonly T[], colunas: readonly ColunaExportada<T>[]): string {
  const cabecalho = colunas.map((c) => celula(c.titulo)).join(';')
  const corpo = linhas.map((l) => colunas.map((c) => celula(c.valor(l))).join(';'))
  /* CRLF: é o que o Excel espera, e o LibreOffice aceita os dois. */
  return `${BOM}${[cabecalho, ...corpo].join('\r\n')}\r\n`
}

/**
 * Nome do arquivo, com a data.
 *
 * Com data porque exportação sem data vira `relatorio.csv` na pasta de
 * downloads, cinco vezes, e ninguém sabe qual é de quando.
 */
export function nomeDoArquivo(recurso: string): string {
  const hoje = new Date().toISOString().slice(0, 10)
  return `${recurso}-${hoje}.csv`
}

/** Cabeçalhos HTTP de um download de CSV. */
export function cabecalhosDeCsv(recurso: string): HeadersInit {
  return {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${nomeDoArquivo(recurso)}"`,
    /* A exportação reflete o banco no instante do pedido e o escopo de quem
       pediu — guardar em cache serviria o arquivo de uma pessoa para outra. */
    'cache-control': 'no-store',
  }
}
