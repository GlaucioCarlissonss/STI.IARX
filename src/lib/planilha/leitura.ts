/**
 * Ler uma planilha que veio de fora.
 *
 * ## Por que um leitor escrito à mão, e não uma biblioteca
 *
 * `papaparse` resolveria isto com uma linha. O que ele traria junto é 45 KB e
 * uma superfície de configuração para um problema que, aqui, tem fronteiras
 * estreitas: arquivo pequeno, enviado por uma pessoa logada, lido em memória e
 * descartado. O módulo de exportação tomou a mesma decisão pelo mesmo motivo —
 * e é o par dele que está sendo escrito aqui.
 *
 * O que este leitor PRECISA acertar, e acerta:
 *
 *  - **campo entre aspas com separador dentro** — `"Silva, João"` é uma coluna;
 *  - **aspas escapadas** — `""` dentro de um campo entre aspas é uma aspa;
 *  - **quebra de linha dentro do campo** — descrição de chamado tem, e sem isso
 *    a planilha parte ao meio;
 *  - **CRLF e LF** no mesmo arquivo, porque Excel e LibreOffice divergem;
 *  - **BOM**, que o Excel põe e que vira um caractere invisível grudado no
 *    primeiro cabeçalho — e faz "Razão Social" nunca casar com nada.
 *
 * O que ele deliberadamente NÃO faz: XLSX. Abrir `.xlsx` exige uma biblioteca
 * que descompacta ZIP e lê XML; enquanto "Salvar como CSV" resolve, o peso não
 * se justifica. A tela diz isso em vez de aceitar o arquivo e falhar depois.
 */

/** O separador: ponto e vírgula primeiro, porque é o do Excel em português. */
const SEPARADORES = [';', ',', '\t'] as const

/**
 * Descobre o separador contando ocorrências FORA de aspas na primeira linha.
 *
 * Contar sem olhar as aspas elegeria a vírgula em `"Silva, João";"Rua A, 10"` —
 * e aí o arquivo inteiro sai com as colunas trocadas, que é um erro que a
 * pessoa só percebe depois de importar.
 */
export function descobrirSeparador(texto: string): string {
  const primeira = texto.split(/\r?\n/, 1)[0] ?? ''
  let melhor = ';'
  let maior = -1
  for (const sep of SEPARADORES) {
    let conta = 0
    let dentro = false
    for (let i = 0; i < primeira.length; i++) {
      const c = primeira[i]
      if (c === '"') {
        if (dentro && primeira[i + 1] === '"') i++
        else dentro = !dentro
      } else if (c === sep && !dentro) conta++
    }
    if (conta > maior) {
      maior = conta
      melhor = sep
    }
  }
  return melhor
}

/**
 * Desfaz a neutralização de fórmula que a NOSSA exportação aplica.
 *
 * `exportacao.ts` prefixa com apóstrofo toda célula que começa com `=`, `+`,
 * `-`, `@`, tab ou CR, para que o Excel não execute `=cmd|'/c calc'!A1` na
 * máquina de quem abre. Isso é certo na ida — e, sem desfazer na volta, o ciclo
 * exportar → corrigir → importar devolveria `'-3` onde havia `-3`, e um
 * telefone `'+55 11…` com um apóstrofo grudado para sempre.
 *
 * Só o apóstrofo seguido de um desses caracteres é removido. Um nome que
 * legitimamente comece com apóstrofo — `'t Hooft` — não é tocado, porque o `t`
 * não está na lista.
 */
export function desfazerNeutralizacao(valor: string): string {
  return /^'[=+\-@\t\r]/.test(valor) ? valor.slice(1) : valor
}

export interface PlanilhaLida {
  cabecalho: string[]
  /** Cada linha com o número que ela tem NO ARQUIVO (cabeçalho é 1). */
  linhas: { numero: number; celulas: string[] }[]
  separador: string
}

export class PlanilhaInvalida extends Error {}

/** Quantas linhas um lote aceita. Ver o comentário em `lerCsv`. */
export const MAX_LINHAS = 5000

/**
 * Quebra o texto em linhas e células.
 *
 * O limite de 5 mil linhas não é arbitrário: a conferência monta uma prévia
 * linha a linha e a grava, e um arquivo de cem mil linhas transformaria a
 * "conferência" numa espera de minutos com um navegador parado. Acima disso o
 * caminho honesto é dividir o arquivo — e a tela diz isso, em vez de aceitar e
 * travar.
 */
export function lerCsv(texto: string): PlanilhaLida {
  /* O BOM vira um caractere invisível grudado no primeiro cabeçalho, e faz
     "Razão Social" não casar com "Razão Social". */
  const limpo = texto.replace(/^﻿/, '')
  const separador = descobrirSeparador(limpo)

  const linhas: string[][] = []
  let celula = ''
  let linha: string[] = []
  let dentroDeAspas = false

  for (let i = 0; i < limpo.length; i++) {
    const c = limpo[i]

    if (dentroDeAspas) {
      if (c === '"') {
        if (limpo[i + 1] === '"') {
          celula += '"'
          i++
        } else dentroDeAspas = false
      } else celula += c
      continue
    }

    if (c === '"') {
      dentroDeAspas = true
    } else if (c === separador) {
      linha.push(celula)
      celula = ''
    } else if (c === '\n' || c === '\r') {
      /* CRLF conta como UMA quebra: tratar o \n do \r\n como linha nova
         produziria uma linha em branco entre todas as linhas do arquivo. */
      if (c === '\r' && limpo[i + 1] === '\n') i++
      linha.push(celula)
      linhas.push(linha)
      celula = ''
      linha = []
    } else {
      celula += c
    }
  }
  /* A última linha costuma não terminar em quebra. Descartá-la perderia
     exatamente um registro — e seria o registro que ninguém procura. */
  if (celula !== '' || linha.length > 0) {
    linha.push(celula)
    linhas.push(linha)
  }

  /* Linha totalmente vazia é lixo de fim de arquivo, não registro. */
  const uteis = linhas.filter((l) => l.some((c) => c.trim() !== ''))
  if (uteis.length === 0) throw new PlanilhaInvalida('A planilha está vazia.')

  const cabecalho = uteis[0].map((c) => desfazerNeutralizacao(c.trim()))
  if (cabecalho.every((c) => c === '')) {
    throw new PlanilhaInvalida('A primeira linha precisa ser o cabeçalho com os nomes das colunas.')
  }

  const corpo = uteis.slice(1)
  if (corpo.length === 0) {
    throw new PlanilhaInvalida('A planilha só tem o cabeçalho — não há linha para importar.')
  }
  if (corpo.length > MAX_LINHAS) {
    throw new PlanilhaInvalida(
      `A planilha tem ${corpo.length.toLocaleString('pt-BR')} linhas, e o limite por envio é ${MAX_LINHAS.toLocaleString('pt-BR')}. Divida o arquivo.`,
    )
  }

  return {
    cabecalho,
    separador,
    /* +2: o cabeçalho é a linha 1 do arquivo, e o corpo começa na 2. É o número
       que a pessoa vai procurar quando abrir a planilha para corrigir. */
    linhas: corpo.map((celulas, i) => ({
      numero: i + 2,
      celulas: celulas.map((c) => desfazerNeutralizacao(c.trim())),
    })),
  }
}

/**
 * Casa o cabeçalho do arquivo com os campos que o recurso espera.
 *
 * A comparação ignora acento, caixa e espaço porque "Razão Social", "razao
 * social" e "RAZAO_SOCIAL" são a mesma coluna para quem montou a planilha — e
 * exigir a grafia exata faz a pessoa casar tudo à mão na primeira vez e
 * desistir na segunda.
 */
export function normalizarTitulo(titulo: string): string {
  return titulo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

/**
 * Sugestão de de-para: para cada campo do recurso, qual coluna do arquivo.
 *
 * Devolve apenas o que reconheceu. O que não casou fica para a pessoa apontar —
 * adivinhar por posição ("a terceira coluna deve ser o CNPJ") acerta no exemplo
 * e erra no arquivo de verdade.
 */
export function sugerirDePara(
  cabecalho: readonly string[],
  campos: readonly { nome: string; titulo: string; sinonimos?: readonly string[] }[],
): Record<string, number> {
  const normalizado = cabecalho.map(normalizarTitulo)
  const mapa: Record<string, number> = {}

  for (const campo of campos) {
    const alvos = [campo.titulo, campo.nome, ...(campo.sinonimos ?? [])].map(normalizarTitulo)
    const indice = normalizado.findIndex((t) => t !== '' && alvos.includes(t))
    if (indice >= 0) mapa[campo.nome] = indice
  }
  return mapa
}
