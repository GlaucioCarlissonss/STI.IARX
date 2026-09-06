/**
 * Formatação pt-BR. Usa `Intl` nativo em vez de biblioteca de datas: o app
 * precisa de meia dúzia de formatos, e o painel de TV se beneficia de não
 * carregar mais JavaScript do que o necessário.
 */

const LOCALE = 'pt-BR'

export function formatDateTime(value: string | Date | null | undefined, timeZone?: string): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat(LOCALE, {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(value))
}

export function formatDate(value: string | Date | null | undefined, timeZone?: string): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'short', timeZone }).format(new Date(value))
}

/**
 * Rótulo curto de mês: "nov/26".
 *
 * A data vem do banco como `date` pura ("2026-11-01"). `new Date('2026-11-01')`
 * seria interpretada como meia-noite UTC e, num fuso a oeste, voltaria como
 * outubro — o mês inteiro deslocado numa tela de projeção financeira. Por isso a
 * string é quebrada e a data é montada no fuso local.
 */
export function formatMonth(value: string | null | undefined): string {
  if (!value) return '—'
  const [ano, mes] = value.split('-').map(Number)
  if (!ano || !mes) return '—'
  return new Intl.DateTimeFormat(LOCALE, { month: 'short', year: '2-digit' }).format(
    new Date(ano, mes - 1, 1),
  )
}

export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'BRL' }).format(value)
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat(LOCALE).format(value)
}

/**
 * Duração em minutos → "2h 15min". Aceita negativo para prazo já vencido, caso
 * em que o chamador decide se prefixa com "há" ou "-".
 */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '—'

  const total = Math.round(Math.abs(minutes))
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const mins = total % 60

  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  // Só mostra minutos quando a escala é pequena — "3d 4h 12min" é ruído numa TV.
  if (mins > 0 && days === 0) parts.push(`${mins}min`)

  return parts.length > 0 ? parts.join(' ') : '0min'
}

/** Tempo restante até o prazo, já com o sinal indicando atraso. */
export function formatTimeRemaining(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—'
  const formatted = formatMinutes(minutes)
  return minutes < 0 ? `atrasado ${formatted}` : formatted
}

export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return '—'

  const date = new Date(value)
  const diffMs = date.getTime() - Date.now()
  const diffMin = Math.round(diffMs / 60000)
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' })

  const abs = Math.abs(diffMin)
  if (abs < 60) return rtf.format(diffMin, 'minute')
  if (abs < 1440) return rtf.format(Math.round(diffMin / 60), 'hour')
  return rtf.format(Math.round(diffMin / 1440), 'day')
}

export function formatCnpj(value: string | null | undefined): string {
  if (!value) return '—'
  const digits = value.replace(/\D/g, '')
  if (digits.length !== 14) return value
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?'
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}
