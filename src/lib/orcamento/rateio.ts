/**
 * Parcelamento, recorrência e a aritmética de dinheiro do orçamento.
 *
 * ## Por que isto existe em TypeScript se já existe em SQL
 *
 * `app.ratear_valor()` divide o total no banco, e é ela que vale na gravação. A
 * versão daqui serve à **prévia**: a tela mostra as parcelas antes de gravar, e
 * fazer isso com uma ida ao servidor por tecla digitada seria lento e inútil.
 *
 * As duas precisam concordar, e concordam porque a regra é simples o bastante
 * para ser escrita duas vezes sem divergir — e porque há teste dos dois lados.
 */

/**
 * Divide um total em parcelas cuja soma fecha **exatamente** no total.
 *
 * 100,00 em 3 não é 33,33 três vezes: é 33,34 + 33,33 + 33,33. O resto vai nas
 * primeiras parcelas, que é a convenção comercial brasileira — e, mais
 * importante, é o que faz a soma do parcelamento bater com o valor do contrato.
 * Um centavo de diferença por contrato, em cem contratos, é o tipo de erro que
 * ninguém encontra depois.
 *
 * Trabalha em centavos inteiros internamente. Em JavaScript isso não é
 * preciosismo: `0.1 + 0.2` é `0.30000000000000004`, e somar cem parcelas em
 * ponto flutuante erra o total de verdade.
 */
export function ratear(total: number, parcelas: number): number[] {
  if (!Number.isFinite(total) || total < 0) return []
  if (!Number.isInteger(parcelas) || parcelas < 1) return []

  const centavos = Math.round(total * 100)
  const base = Math.floor(centavos / parcelas)
  const resto = centavos - base * parcelas

  return Array.from({ length: parcelas }, (_, i) => (base + (i < resto ? 1 : 0)) / 100)
}

/** Soma uma lista de valores sem erro de ponto flutuante. */
export function somar(valores: readonly number[]): number {
  return valores.reduce((s, v) => s + Math.round(v * 100), 0) / 100
}

/**
 * As competências que uma recorrência ocupa.
 *
 * `ate` nulo significa **em aberto**, e aí a projeção vai até o horizonte
 * pedido: encerrar um contrato é cadastrar a vigência dele, e supor uma data que
 * ninguém informou inventaria o fim de contratos em vigor.
 *
 * O teto de 120 meses é o mesmo do cronograma, e pelo mesmo motivo: um ano
 * digitado errado geraria milhares de linhas.
 */
export const MAXIMO_DE_OCORRENCIAS = 120

export function ocorrenciasDaRecorrencia(
  de: string,
  ate: string | null,
  horizonte: string,
): string[] {
  const fim = ate && ate < horizonte ? ate : horizonte
  if (fim < de) return []

  const [a1, m1] = de.slice(0, 7).split('-').map(Number)
  const [a2, m2] = fim.slice(0, 7).split('-').map(Number)
  const total = Math.min((a2! - a1!) * 12 + (m2! - m1!) + 1, MAXIMO_DE_OCORRENCIAS)

  return Array.from({ length: total }, (_, i) => {
    const absoluto = a1! * 12 + (m1! - 1) + i
    const ano = Math.floor(absoluto / 12)
    const mes = String((absoluto % 12) + 1).padStart(2, '0')
    return `${ano}-${mes}-01`
  })
}

export const ROTULO_DA_NATUREZA: Record<string, string> = {
  fixa: 'Fixa (recorrente)',
  pontual_unica: 'Pontual',
  pontual_parcelada: 'Parcelada',
}

export const ROTULO_DA_CLASSIFICACAO: Record<string, string> = {
  despesa: 'Despesa',
  investimento: 'Investimento',
}

export const ROTULO_DA_ORIGEM: Record<string, string> = {
  manual: 'lançado na tela',
  planilha: 'importado de planilha',
  projecao: 'projeção',
  titulo_a_pagar: 'título a pagar',
}

/**
 * Quanto do custo de uma filial é **pago por outra**.
 *
 * Sem esta leitura, a matriz que centraliza as licenças de seis filiais aparece
 * como a unidade cara e as filiais que consomem aparecem baratas: o número está
 * certo e a leitura, errada. É a melhor ideia do financeiro do GSTI.
 *
 * O rateio aqui é **igualitário entre as beneficiadas**, e isso é uma escolha,
 * não uma verdade: dividir por cabeça é o que dá para fazer sem pedir um peso
 * por filial que ninguém tem. A tela diz que é assim.
 */
export function ratearEntreBeneficiadas(
  valor: number,
  quantidade: number,
): { porFilial: number; sobra: number } {
  if (quantidade < 1) return { porFilial: 0, sobra: valor }
  const partes = ratear(valor, quantidade)
  return { porFilial: partes[0] ?? 0, sobra: 0 }
}

/** Reais como a tela escreve. */
export function emReais(valor: number): string {
  return valor.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
  })
}
