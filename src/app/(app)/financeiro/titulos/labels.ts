import type { PayableStatus, ReceivableStatus } from '@/lib/types'

/**
 * Rótulos e tom de cor das situações.
 *
 * Fora do módulo `'use server'` de propósito: arquivo com `'use server'` só pode
 * exportar função assíncrona, então constante compartilhada tem de morar aqui.
 */
export const PAYABLE_STATUS: Record<
  PayableStatus,
  { label: string; tone: 'ok' | 'warn' | 'crit' | 'breach' | 'neutral' | 'info' }
> = {
  draft: { label: 'Rascunho', tone: 'neutral' },
  pending_approval: { label: 'Aguardando aprovação', tone: 'warn' },
  approved: { label: 'Aprovado', tone: 'info' },
  rejected: { label: 'Reprovado', tone: 'breach' },
  scheduled: { label: 'Agendado', tone: 'info' },
  paid: { label: 'Pago', tone: 'ok' },
  cancelled: { label: 'Cancelado', tone: 'neutral' },
}

export const RECEIVABLE_STATUS: Record<
  ReceivableStatus,
  { label: string; tone: 'ok' | 'warn' | 'neutral' | 'info' }
> = {
  draft: { label: 'Rascunho', tone: 'neutral' },
  open: { label: 'Aberto', tone: 'info' },
  received: { label: 'Recebido', tone: 'ok' },
  cancelled: { label: 'Cancelado', tone: 'neutral' },
}

export const ATTACHMENT_KINDS = [
  { value: 'nfe', label: 'Nota fiscal' },
  { value: 'boleto', label: 'Boleto' },
  { value: 'receipt', label: 'Comprovante de pagamento' },
  { value: 'contract', label: 'Contrato' },
  { value: 'other', label: 'Outro' },
] as const

/** Dias até o vencimento. Negativo = vencido. */
export function diasAteVencer(dueOn: string): number {
  const hoje = new Date()
  hoje.setHours(0, 0, 0, 0)
  const venc = new Date(`${dueOn}T12:00:00`)
  return Math.round((venc.getTime() - hoje.getTime()) / 86_400_000)
}

/**
 * Como o vencimento deve ser lido.
 *
 * Situação encerrada (pago, cancelado) não recebe alerta de atraso: um título
 * pago com dois dias de atraso não é um problema aberto, e pintá-lo de vermelho
 * competiria com o que ainda precisa de ação.
 */
export function tomDoVencimento(
  dueOn: string,
  encerrado: boolean,
): { texto: string; tone: 'ok' | 'warn' | 'crit' | 'breach' | 'neutral' } {
  if (encerrado) return { texto: '—', tone: 'neutral' }
  const dias = diasAteVencer(dueOn)
  if (dias < 0) return { texto: `${Math.abs(dias)} dia(s) em atraso`, tone: 'breach' }
  if (dias === 0) return { texto: 'vence hoje', tone: 'crit' }
  if (dias <= 7) return { texto: `vence em ${dias} dia(s)`, tone: 'warn' }
  return { texto: `vence em ${dias} dia(s)`, tone: 'ok' }
}
