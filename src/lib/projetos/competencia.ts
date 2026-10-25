/**
 * Competência: o mês como unidade de tempo.
 *
 * ## Por que o cronograma é mensal
 *
 * Porque projeto de TI se planeja em meses. Um campo com precisão de dia que
 * ninguém preenche com precisão de dia produz um Gantt que mente: a barra
 * começa em 03/04 porque foi o dia em que alguém abriu o formulário, não porque
 * algo acontece no dia 3.
 *
 * ## Como ela é guardada
 *
 * No banco, `date` preso ao dia 1 (`app.eh_competencia`). No GSTI original é
 * texto `AAAA-MM`, porque o SQLite não tem tipo de mês — aqui dá para ter data
 * de verdade, e com ela a aritmética (`+ interval '1 month'`, diferença em
 * meses) vira SQL em vez de manipulação de string.
 *
 * Na tela, o formato é `MM/AAAA`, que é como se escreve competência em
 * português. A conversão mora aqui, nos dois sentidos, e em lugar nenhum mais.
 */

/** `2026-04-01` → `04/2026`. */
export function paraExibicao(iso: string | null | undefined): string {
  if (!iso) return ''
  const [ano, mes] = iso.slice(0, 7).split('-')
  return `${mes}/${ano}`
}

/**
 * `04/2026` ou `2026-04` → `2026-04-01`.
 *
 * Aceita os dois formatos porque o campo `<input type="month">` manda
 * `AAAA-MM` e a importação de planilha manda `MM/AAAA`. Devolve `null` para
 * qualquer coisa que não seja um mês válido — e a ação chamadora recusa, em vez
 * de gravar uma data que o banco interpretaria de outro jeito.
 */
export function paraInterno(valor: string | null | undefined): string | null {
  if (!valor) return null
  const texto = valor.trim()

  const iso = /^(\d{4})-(\d{2})$/.exec(texto)
  if (iso) return mesValido(iso[1]!, iso[2]!) ? `${iso[1]}-${iso[2]}-01` : null

  const completo = /^(\d{4})-(\d{2})-\d{2}$/.exec(texto)
  if (completo) return mesValido(completo[1]!, completo[2]!) ? `${completo[1]}-${completo[2]}-01` : null

  const brasileiro = /^(\d{1,2})\/(\d{4})$/.exec(texto)
  if (brasileiro) {
    const mes = brasileiro[1]!.padStart(2, '0')
    return mesValido(brasileiro[2]!, mes) ? `${brasileiro[2]}-${mes}-01` : null
  }

  return null
}

function mesValido(ano: string, mes: string): boolean {
  const a = Number(ano)
  const m = Number(mes)
  return a >= 1900 && a <= 2200 && m >= 1 && m <= 12
}

/** A competência corrente, no fuso em que o servidor roda. */
export function competenciaAtual(hoje: Date = new Date()): string {
  const ano = hoje.getUTCFullYear()
  const mes = String(hoje.getUTCMonth() + 1).padStart(2, '0')
  return `${ano}-${mes}-01`
}

/** Diferença em meses, com sinal. Negativo = `ate` é anterior a `de`. */
export function mesesEntre(de: string, ate: string): number {
  const [a1, m1] = de.slice(0, 7).split('-').map(Number)
  const [a2, m2] = ate.slice(0, 7).split('-').map(Number)
  return (a2! - a1!) * 12 + (m2! - m1!)
}

/** Soma meses a uma competência. */
export function somarMeses(competencia: string, meses: number): string {
  const [ano, mes] = competencia.slice(0, 7).split('-').map(Number)
  const total = (ano! * 12 + (mes! - 1)) + meses
  const novoAno = Math.floor(total / 12)
  const novoMes = String((total % 12) + 1).padStart(2, '0')
  return `${novoAno}-${novoMes}-01`
}

/**
 * A faixa de competências entre duas datas, inclusive nas duas pontas.
 *
 * É o eixo horizontal do Gantt. Tem teto de 120 meses (dez anos): um projeto
 * com fim planejado digitado errado — 2206 em vez de 2026 — geraria 2.160
 * colunas e travaria a renderização. O teto corta a faixa, e a tela diz que
 * cortou, em vez de parar de responder.
 */
export const MAXIMO_DE_MESES = 120

export function faixaDeMeses(de: string, ate: string): string[] {
  const total = Math.min(Math.max(mesesEntre(de, ate), 0) + 1, MAXIMO_DE_MESES)
  return Array.from({ length: total }, (_, i) => somarMeses(de, i))
}

/** `2026-04-01` → `abr`, para o cabeçalho do cronograma. */
const MESES_CURTOS = [
  'jan', 'fev', 'mar', 'abr', 'mai', 'jun',
  'jul', 'ago', 'set', 'out', 'nov', 'dez',
]

export function mesCurto(competencia: string): string {
  const mes = Number(competencia.slice(5, 7))
  return MESES_CURTOS[mes - 1] ?? ''
}

export function anoDe(competencia: string): string {
  return competencia.slice(0, 4)
}
