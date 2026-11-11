import { normalizarTitulo } from './leitura'
import type { CampoDeImportacao, RecursoDeImportacao } from './recursos'

/**
 * Conferir uma linha ANTES de gravar.
 *
 * Este módulo é puro de propósito: ele não fala com o banco, e por isso é o
 * único lugar do ciclo que dá para testar a sério sem subir nada. O que depende
 * do banco — existe cliente com este CNPJ? já há leitura nesta data? — fica na
 * ação, que é quem tem a sessão e o RLS.
 *
 * ## O princípio das mensagens
 *
 * Toda recusa diz **o que estava na célula** e **o que se esperava**. "Valor
 * inválido" obriga quem recebe a abrir a planilha, achar a linha e adivinhar;
 * "a data '31/02/2026' não existe" se resolve sem sair da tela.
 */

export interface ValorConferido {
  valor: unknown
  erro?: undefined
}
export interface ValorRecusado {
  valor?: undefined
  erro: string
}
export type Conferencia = ValorConferido | ValorRecusado

/**
 * O guarda que estreita o tipo — e por que `'erro' in r` não serve.
 *
 * Com `erro` declarado nos dois lados (opcional de um, obrigatório do outro), o
 * operador `in` não distingue: ele devolve `string | undefined`, e aí toda
 * mensagem de recusa precisaria de um `?? ''` que esconderia o caso em que ela
 * realmente faltou. Com o guarda, quem recusou tem `erro: string`.
 */
export function recusou(r: Conferencia): r is ValorRecusado {
  return r.erro !== undefined
}

const vazio = (texto: string) => texto.trim() === ''

/**
 * Data em pt-BR ou ISO.
 *
 * Aceita os dois porque a planilha vem dos dois jeitos: quem digita escreve
 * 31/12/2026, e quem exportou de outro sistema traz 2026-12-31. O que NÃO se
 * aceita é mês/dia/ano — 03/04 seria 3 de abril ou 4 de março conforme a
 * origem, e um sistema que adivinha isso erra em silêncio num dia por mês.
 */
export function conferirData(texto: string): Conferencia {
  const t = texto.trim()

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t)
  if (!iso && !br) {
    return { erro: `“${t}” não é uma data. Use 31/12/2026 ou 2026-12-31.` }
  }

  const [ano, mes, dia] = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : [Number(br![3]), Number(br![2]), Number(br![1])]

  /* O construtor de Date "conserta" 31/02 para 03/03 sem reclamar. Comparar as
     partes de volta é o que transforma esse conserto silencioso numa recusa. */
  const d = new Date(Date.UTC(ano, mes - 1, dia))
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    return { erro: `a data “${t}” não existe.` }
  }
  if (ano < 1900 || ano > 2200) {
    return { erro: `o ano ${ano} está fora do razoável — confira a data “${t}”.` }
  }

  return { valor: `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}` }
}

/**
 * Número em pt-BR ou en-US.
 *
 * `1.234,56` e `1234.56` são o mesmo número escrito por ferramentas
 * diferentes, e a planilha traz os dois. A regra para distinguir: se há
 * vírgula, ela é o decimal e o ponto é milhar; se não há vírgula, o ponto é
 * decimal **a menos que** separe grupos de três — `1.234` é mil duzentos e
 * trinta e quatro, e lê-lo como 1,234 dividiria o valor por mil sem avisar.
 */
export function conferirNumero(texto: string, inteiro = false): Conferencia {
  const t = texto.trim().replace(/\s/g, '').replace(/^R\$/i, '')
  if (t === '') return { erro: 'está em branco.' }

  let normalizado: string
  if (t.includes(',')) {
    normalizado = t.replace(/\./g, '').replace(',', '.')
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) {
    normalizado = t.replace(/\./g, '')
  } else {
    normalizado = t
  }

  const n = Number(normalizado)
  if (!Number.isFinite(n)) return { erro: `“${texto.trim()}” não é um número.` }
  if (inteiro && !Number.isInteger(n)) {
    return { erro: `“${texto.trim()}” precisa ser um número inteiro.` }
  }
  return { valor: n }
}

/** Opção escrita como a pessoa escreve: sem acento, sem caixa, sem pontuação. */
export function conferirOpcao(texto: string, campo: CampoDeImportacao): Conferencia {
  const alvo = normalizarTitulo(texto)
  for (const o of campo.opcoes ?? []) {
    if (o.rotulos.some((r) => normalizarTitulo(r) === alvo)) return { valor: o.valor }
  }
  const aceitos = (campo.opcoes ?? []).map((o) => o.rotulos[0]).join(', ')
  return { erro: `“${texto.trim()}” não é um valor aceito. Use: ${aceitos}.` }
}

export function conferirBooleano(texto: string, campo: CampoDeImportacao): Conferencia {
  const r = conferirOpcao(texto, campo)
  if (recusou(r)) return r
  return { valor: r.valor === 'true' }
}

/**
 * Confere uma célula contra o campo que ela deveria preencher.
 *
 * Campo de referência sai daqui com o TEXTO, não com o id: resolver "qual
 * cliente é este?" exige o banco, e acontece na ação. O que este módulo
 * garante é que o texto chegou lá preenchido quando era obrigatório.
 */
export function conferirCelula(texto: string, campo: CampoDeImportacao): Conferencia {
  const t = (texto ?? '').trim()

  if (vazio(t)) {
    if (campo.obrigatorio) return { erro: `${campo.titulo} é obrigatório.` }
    return { valor: null }
  }

  if (campo.max && t.length > campo.max) {
    return {
      erro: `${campo.titulo} tem ${t.length} caracteres, e o limite é ${campo.max}.`,
    }
  }

  switch (campo.tipo) {
    case 'data': {
      const r = conferirData(t)
      return recusou(r) ? { erro: `${campo.titulo}: ${r.erro}` } : r
    }
    case 'numero':
    case 'inteiro': {
      const r = conferirNumero(t, campo.tipo === 'inteiro')
      return recusou(r) ? { erro: `${campo.titulo}: ${r.erro}` } : r
    }
    case 'opcao': {
      const r = conferirOpcao(t, campo)
      return recusou(r) ? { erro: `${campo.titulo}: ${r.erro}` } : r
    }
    case 'booleano': {
      const r = conferirBooleano(t, campo)
      return recusou(r) ? { erro: `${campo.titulo}: ${r.erro}` } : r
    }
    case 'referencia':
      return { valor: t }
    default:
      return { valor: t }
  }
}

export interface LinhaConferida {
  numero: number
  /** Os valores já convertidos, por nome de coluna. */
  valores: Record<string, unknown>
  /** O texto cru, por título de coluna — é o que volta no arquivo de correção. */
  cru: Record<string, string>
  /** Os campos de referência, ainda como texto: a ação resolve. */
  referencias: Record<string, string>
  erros: string[]
}

/**
 * Confere a linha inteira e junta TODOS os erros dela.
 *
 * Parar no primeiro erro faria a pessoa corrigir uma coisa, reenviar, e
 * descobrir a segunda — três vezes por linha. Uma linha com três problemas diz
 * os três de uma vez.
 */
export function conferirLinha(
  recurso: RecursoDeImportacao,
  dePara: Readonly<Record<string, number>>,
  celulas: readonly string[],
  numero: number,
): LinhaConferida {
  const valores: Record<string, unknown> = {}
  const cru: Record<string, string> = {}
  const referencias: Record<string, string> = {}
  const erros: string[] = []

  for (const campo of recurso.campos) {
    const indice = dePara[campo.nome]
    const texto = indice === undefined ? '' : (celulas[indice] ?? '')
    cru[campo.titulo] = texto

    const r = conferirCelula(texto, campo)
    if (recusou(r)) {
      erros.push(r.erro)
      continue
    }
    if (campo.tipo === 'referencia') {
      if (r.valor !== null) referencias[campo.nome] = String(r.valor)
      continue
    }
    if (r.valor !== null) valores[campo.nome] = r.valor
  }

  return { numero, valores, cru, referencias, erros }
}

/**
 * O de-para cobre tudo o que é obrigatório?
 *
 * Conferido ANTES de ler as linhas: um arquivo de 300 linhas sem a coluna de
 * CNPJ produziria 300 recusas idênticas, e a mensagem útil — "falta casar a
 * coluna CNPJ" — ficaria afogada no meio delas.
 */
export function faltamObrigatorias(
  recurso: RecursoDeImportacao,
  dePara: Readonly<Record<string, number>>,
): string[] {
  return recurso.campos
    .filter((c) => (c.obrigatorio || c.chave) && dePara[c.nome] === undefined)
    .map((c) => c.titulo)
}

/** A chave natural da linha, em texto, para comparar com o que já existe. */
export function chaveDaLinha(recurso: RecursoDeImportacao, linha: LinhaConferida): string | null {
  const partes: string[] = []
  for (const campo of recurso.campos.filter((c) => c.chave)) {
    const bruto =
      campo.tipo === 'referencia' ? linha.referencias[campo.nome] : linha.valores[campo.nome]
    if (bruto === undefined || bruto === null || bruto === '') return null
    partes.push(String(bruto).trim().toLowerCase())
  }
  return partes.join('\u0000')
}

/**
 * Normaliza CNPJ e CPF para comparar: só os dígitos.
 *
 * A mesma empresa chega como `11.222.333/0001-44` numa planilha e
 * `11222333000144` noutra. Comparar o texto cru criaria o cliente duas vezes —
 * e o segundo seria "novo" para sempre.
 */
export function soDigitos(texto: string): string {
  return texto.replace(/\D/g, '')
}

/**
 * Confere o dígito verificador do CNPJ.
 *
 * Não é preciosismo: CNPJ é a chave de cliente, e um dígito trocado cria um
 * cliente novo que ninguém procura — ele some do relatório e reaparece como
 * duplicata meses depois. O cálculo é barato e a recusa é específica.
 */
export function conferirCnpj(texto: string): Conferencia {
  const d = soDigitos(texto)
  if (d.length !== 14) {
    return { erro: `“${texto.trim()}” não tem 14 dígitos — confira o CNPJ.` }
  }
  if (/^(\d)\1{13}$/.test(d)) return { erro: `“${texto.trim()}” não é um CNPJ válido.` }

  const digito = (base: string, pesos: readonly number[]) => {
    const soma = base.split('').reduce((s, c, i) => s + Number(c) * pesos[i], 0)
    const resto = soma % 11
    return resto < 2 ? 0 : 11 - resto
  }
  const p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  const p2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]

  if (digito(d.slice(0, 12), p1) !== Number(d[12]) || digito(d.slice(0, 13), p2) !== Number(d[13])) {
    return { erro: `o CNPJ “${texto.trim()}” tem dígito verificador inválido.` }
  }
  return { valor: d }
}
