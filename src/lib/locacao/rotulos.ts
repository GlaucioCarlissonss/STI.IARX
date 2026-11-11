import type { EquipmentStatus, MeterKind } from '@/lib/types'

/**
 * Os dez estados do equipamento, em português e com tom.
 *
 * O tom não é enfeite: ele é o que faz a lista responder "está tudo bem?" antes
 * de ser lida palavra por palavra. Verde é base alocável e operação; âmbar é
 * parado por decisão nossa; vermelho é perda.
 */
export const ESTADO_DO_EQUIPAMENTO: Record<
  EquipmentStatus,
  { label: string; tone: 'ok' | 'warn' | 'crit' | 'breach' | 'info' | 'neutral' }
> = {
  available: { label: 'Disponível', tone: 'ok' },
  reserved: { label: 'Reservado', tone: 'info' },
  in_transit_out: { label: 'Em trânsito (entrega)', tone: 'info' },
  rented: { label: 'Locado', tone: 'ok' },
  in_transit_back: { label: 'Em trânsito (retorno)', tone: 'info' },
  inspection: { label: 'Em inspeção', tone: 'warn' },
  maintenance: { label: 'Em manutenção', tone: 'warn' },
  blocked: { label: 'Bloqueado', tone: 'crit' },
  lost: { label: 'Extraviado', tone: 'breach' },
  written_off: { label: 'Baixado', tone: 'neutral' },
}

/**
 * A ordem em que os estados aparecem num seletor.
 *
 * É a ordem do CICLO, não a alfabética: quem procura segue o caminho da
 * máquina — sai da base, vai, volta, conserta. Alfabética poria "Baixado"
 * antes de "Disponível", que é o fim antes do começo.
 */
export const ESTADOS_NA_ORDEM: EquipmentStatus[] = [
  'available',
  'reserved',
  'in_transit_out',
  'rented',
  'in_transit_back',
  'inspection',
  'maintenance',
  'lost',
  'written_off',
]

/** Rótulo do medidor, e a unidade que acompanha o número. */
export const MEDIDOR: Record<MeterKind, { label: string; unidade: string }> = {
  none: { label: 'Sem medidor', unidade: '' },
  hours: { label: 'Horímetro', unidade: 'h' },
  cycles: { label: 'Ciclos', unidade: 'ciclos' },
  distance: { label: 'Odômetro', unidade: 'km' },
}

export const DEPOSITO_KIND: Record<string, string> = {
  warehouse: 'Galpão',
  workshop: 'Oficina',
  transit: 'Trânsito',
}

/** Leitura com a unidade — ou o traço de quem não mede nada. */
export function formatarMedidor(kind: MeterKind, leitura: number): string {
  if (kind === 'none') return '—'
  const n = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(leitura)
  return `${n} ${MEDIDOR[kind].unidade}`.trim()
}

/**
 * O que a movimentação diz, em uma linha.
 *
 * O histórico é escrito pelo gatilho, em colunas; quem lê quer frase. Montar a
 * frase aqui, e não no SQL, mantém o banco guardando FATO e a tela cuidando de
 * linguagem — que é o que permite traduzir sem migração.
 */
export function descreverMovimento(m: {
  kind: string
  from_status: string | null
  to_status: string | null
  meter_reading: number | null
  notes: string | null
}): string {
  if (m.kind === 'status') {
    const para = ESTADO_DO_EQUIPAMENTO[m.to_status as EquipmentStatus]?.label ?? m.to_status ?? '—'
    if (!m.from_status) return m.notes ?? `Entrou como ${para}`
    const de = ESTADO_DO_EQUIPAMENTO[m.from_status as EquipmentStatus]?.label ?? m.from_status
    return `${de} → ${para}`
  }
  if (m.kind === 'depot') return 'Mudou de depósito'
  if (m.kind === 'meter') {
    const n = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(
      m.meter_reading ?? 0,
    )
    return `Leitura registrada: ${n}`
  }
  if (m.kind === 'block') return m.notes ?? 'Bloqueio alterado'
  return m.notes ?? 'Anotação'
}
