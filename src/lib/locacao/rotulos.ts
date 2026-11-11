import type {
  EquipmentStatus,
  FieldServiceKind,
  MeterKind,
  RentalContractStatus,
  RentalInvoiceStatus,
  RentalItemStatus,
} from '@/lib/types'

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

/* --------------------------------------------------------------------------
 * Contratos (0049)
 * ------------------------------------------------------------------------ */

export const ESTADO_DO_CONTRATO: Record<
  RentalContractStatus,
  { label: string; tone: 'ok' | 'warn' | 'breach' | 'info' | 'neutral' }
> = {
  draft: { label: 'Rascunho', tone: 'info' },
  active: { label: 'Ativo', tone: 'ok' },
  suspended: { label: 'Suspenso', tone: 'warn' },
  ended: { label: 'Encerrado', tone: 'neutral' },
  cancelled: { label: 'Rescindido', tone: 'breach' },
}

export const ESTADO_DA_ALOCACAO: Record<
  RentalItemStatus,
  { label: string; tone: 'ok' | 'warn' | 'breach' | 'info' | 'neutral' }
> = {
  reserved: { label: 'Reservado', tone: 'info' },
  delivered: { label: 'Em operação', tone: 'ok' },
  returned: { label: 'Devolvido', tone: 'neutral' },
  cancelled: { label: 'Cancelado', tone: 'neutral' },
}

/**
 * Quantos dias do mês a peça ficou em operação.
 *
 * É a conta do pró-rata, e ela mora aqui — em função pura, com teste — e não
 * dentro da tela: a Fase 4 vai precisar exatamente dela para faturar, e duas
 * implementações da mesma conta é como a fatura e a tela passam a discordar.
 *
 * Entrega no dia 20 de um mês de 30 cobra 11 dias (20 a 30, inclusive), e não
 * 10: o dia da entrega é dia de uso.
 */
export function diasEmOperacao(
  inicioDoMes: Date,
  fimDoMes: Date,
  entregue: string | null,
  devolvido: string | null,
): number {
  const dia = 86400000
  const de = entregue ? new Date(`${entregue}T00:00:00`) : inicioDoMes
  const ate = devolvido ? new Date(`${devolvido}T00:00:00`) : fimDoMes
  const comeco = de > inicioDoMes ? de : inicioDoMes
  const fim = ate < fimDoMes ? ate : fimDoMes
  if (fim < comeco) return 0
  return Math.round((fim.getTime() - comeco.getTime()) / dia) + 1
}

export const ESTADO_DA_FATURA: Record<
  RentalInvoiceStatus,
  { label: string; tone: 'ok' | 'warn' | 'breach' | 'info' | 'neutral' }
> = {
  draft: { label: 'Rascunho', tone: 'info' },
  issued: { label: 'Emitida', tone: 'ok' },
  cancelled: { label: 'Cancelada', tone: 'breach' },
}

export const TIPO_DA_LINHA: Record<string, string> = {
  rent: 'Locação',
  excess: 'Excedente',
  service: 'Serviço',
  part: 'Peça',
  discount: 'Desconto',
}

/* --------------------------------------------------------------------------
 * Manutenção em campo (0051)
 * ------------------------------------------------------------------------ */

export const TIPO_DO_ATENDIMENTO: Record<
  FieldServiceKind,
  { label: string; tone: 'ok' | 'warn' | 'breach' | 'info' | 'neutral'; resumo: string }
> = {
  corrective: {
    label: 'Corretiva',
    tone: 'warn',
    resumo: 'Quebrou e parou — o atendimento que o cliente abre.',
  },
  preventive: {
    label: 'Preventiva',
    tone: 'info',
    resumo: 'No calendário ou no medidor, antes de quebrar.',
  },
  installation: { label: 'Instalação', tone: 'ok', resumo: 'Entrega e ativação no local.' },
  removal: { label: 'Retirada', tone: 'neutral', resumo: 'Recolhimento ao fim da operação.' },
}

export const QUEM_PAGA: Record<'provider' | 'client', string> = {
  provider: 'Nós (garantia ou desgaste)',
  client: 'O cliente (mau uso ou fora do contrato)',
}

/**
 * Em que pé o custo está em relação à alçada.
 *
 * Três situações, e a do meio é a única que exige ação de alguém: o custo passou
 * do teto e ninguém autorizou. Devolver só um booleano "pode fechar?" perderia a
 * diferença entre "não tem teto" e "tem teto e já foi aprovado" — que é
 * exatamente o que a tela precisa dizer com palavras diferentes.
 */
export function situacaoDaAlcada(
  limite: number | null,
  custo: number,
  aprovadoEm: string | null,
): { estado: 'sem_teto' | 'dentro' | 'estourou' | 'aprovado'; label: string; tone: 'ok' | 'warn' | 'breach' | 'neutral' } {
  if (aprovadoEm) return { estado: 'aprovado', label: 'Custo aprovado', tone: 'ok' }
  if (limite === null) return { estado: 'sem_teto', label: 'Sem alçada definida', tone: 'neutral' }
  if (custo > limite) return { estado: 'estourou', label: 'Acima da alçada', tone: 'breach' }
  return { estado: 'dentro', label: 'Dentro da alçada', tone: 'ok' }
}

/** "2026-11-01" → "11/2026". A competência é mês, e lê-se como mês. */
export function competenciaParaExibicao(competencia: string): string {
  const [ano, mes] = competencia.split('-')
  return `${mes}/${ano}`
}
