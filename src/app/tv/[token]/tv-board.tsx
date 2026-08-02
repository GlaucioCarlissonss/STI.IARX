'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { DashboardMetrics, EnrichedTicket, SlaState } from '@/lib/types'
import { ticketStatusLabel } from '@/lib/i18n'
import { formatMinutes } from '@/lib/format'

/* ==========================================================================
   Painel de TV (RF-DSH)
   --------------------------------------------------------------------------
   Restrições de projeto que explicam as escolhas abaixo:
     · fica ligado por semanas sem ninguém tocar → nada de estado que acumule
     · é lido de 3 a 8 metros de distância      → tipografia enorme, alto contraste
     · não tem operador logado                  → atualização por tempo, não por ação
   ========================================================================== */

const stateColor: Record<SlaState, string> = {
  no_sla: 'var(--color-tv-ink-2)',
  ok: 'var(--color-tv-ok)',
  warning: 'var(--color-tv-warn)',
  critical: 'var(--color-tv-crit)',
  breached: 'var(--color-tv-breach)',
  met: 'var(--color-tv-ok)',
}

export function TvBoard({
  tenantName,
  layoutName,
  metrics,
  tickets,
  agentsOnline,
  agentsTotal,
  refreshSeconds,
  scopedToBranches,
}: {
  tenantName: string
  layoutName: string
  metrics: DashboardMetrics
  tickets: EnrichedTicket[]
  agentsOnline: number
  agentsTotal: number
  refreshSeconds: number
  scopedToBranches: boolean
}) {
  const router = useRouter()
  const [clock, setClock] = useState<string>('')
  const [lastSync, setLastSync] = useState<string>('')

  // Relógio só depois da montagem: renderizar hora no servidor causaria
  // divergência de hidratação, já que servidor e TV podem estar em fusos
  // diferentes.
  useEffect(() => {
    const tick = () =>
      setClock(
        new Intl.DateTimeFormat('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).format(new Date()),
      )
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  /*
   * Atualização periódica via `router.refresh()` (RF-DSH-04).
   *
   * Por que não Supabase Realtime aqui: o painel é anônimo por decisão de
   * arquitetura (ADR-006). O Realtime do Supabase autoriza `postgres_changes`
   * pelo RLS do JWT, e um cliente anônimo simplesmente não recebe eventos.
   * A alternativa seria embutir um JWT real na TV — exatamente a credencial
   * de longa duração que o ADR-006 evita. Os painéis autenticados, esses sim,
   * usam Realtime (ver components/realtime-refresh.tsx).
   */
  useEffect(() => {
    const interval = Math.min(Math.max(refreshSeconds, 10), 600) * 1000
    const id = setInterval(() => {
      router.refresh()
      setLastSync(new Intl.DateTimeFormat('pt-BR', { timeStyle: 'medium' }).format(new Date()))
    }, interval)
    return () => clearInterval(id)
  }, [router, refreshSeconds])

  const breached = metrics.sla_breached ?? 0

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--color-tv-bg)] text-[var(--color-tv-ink)]">
      <header className="flex shrink-0 items-baseline justify-between gap-6 border-b border-[var(--color-tv-border)] px-[2vw] py-[1.2vh]">
        <div className="min-w-0">
          <h1 className="truncate text-[clamp(1.1rem,2vw,2.2rem)] font-bold">{tenantName}</h1>
          <p className="truncate text-[clamp(0.7rem,1vw,1.1rem)] text-[var(--color-tv-ink-2)]">
            {layoutName}
            {scopedToBranches && ' · escopo por filial'}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[clamp(1.4rem,3vw,3.4rem)] font-bold tabular-nums leading-none">{clock}</p>
          <p className="text-[clamp(0.62rem,0.8vw,0.95rem)] text-[var(--color-tv-ink-2)]">
            {agentsOnline}/{agentsTotal} atendentes online
            {lastSync && ` · sincronizado ${lastSync}`}
          </p>
        </div>
      </header>

      <div className="grid shrink-0 grid-cols-2 gap-[0.6vw] px-[2vw] py-[1.4vh] md:grid-cols-3 xl:grid-cols-6">
        <Metric label="Em aberto" value={metrics.open_total} />
        <Metric label="Em andamento" value={metrics.in_progress_total} />
        <Metric label="Críticos" value={metrics.critical_total} color="var(--color-tv-crit)" />
        <Metric label="SLA em risco" value={metrics.sla_at_risk} color="var(--color-tv-warn)" />
        <Metric
          label="SLA estourado"
          value={breached}
          color="var(--color-tv-breach)"
          pulse={breached > 0}
        />
        <Metric
          label="Tempo médio"
          value={formatMinutes(metrics.avg_resolution_minutes_24h)}
          color="var(--color-tv-ok)"
        />
      </div>

      <main className="flex min-h-0 flex-1 flex-col px-[2vw] pb-[1.4vh]">
        <h2 className="tv-metric-label mb-[0.8vh] shrink-0 text-[var(--color-tv-ink-2)]">
          Fila de atendimento — ordenada por prioridade e prazo
        </h2>

        <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-[var(--color-tv-border)] bg-[var(--color-tv-panel)]">
          {tickets.length === 0 ? (
            <p className="grid h-full place-items-center text-[clamp(1.2rem,2.4vw,2.4rem)] font-semibold text-[var(--color-tv-ok)]">
              Nenhum ticket em aberto
            </p>
          ) : (
            <TicketMarquee tickets={tickets} />
          )}
        </div>
      </main>
    </div>
  )
}

function Metric({
  label,
  value,
  color,
  pulse,
}: {
  label: string
  value: number | string
  color?: string
  pulse?: boolean
}) {
  return (
    <div className="rounded-xl border border-[var(--color-tv-border)] bg-[var(--color-tv-panel)] px-[1vw] py-[1.1vh]">
      <p className="tv-metric-label text-[var(--color-tv-ink-2)]">{label}</p>
      <p
        className={`tv-metric-value mt-[0.4vh] ${pulse ? 'tv-pulse' : ''}`}
        style={{ color: color ?? 'var(--color-tv-ink)' }}
      >
        {value}
      </p>
    </div>
  )
}

/**
 * Rolagem automática da fila (RF-DSH-03).
 *
 * A lista só rola quando de fato não cabe na tela — animar 4 linhas num painel
 * vazio é irritante e não comunica nada. A lista é duplicada no DOM e a animação
 * percorre 50% da altura, o que produz um laço sem salto perceptível.
 */
function TicketMarquee({ tickets }: { tickets: EnrichedTicket[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [overflowing, setOverflowing] = useState(false)

  useEffect(() => {
    const check = () => {
      const container = containerRef.current
      const list = listRef.current
      if (!container || !list) return
      // list contém as duas cópias, por isso comparamos com metade da altura.
      setOverflowing(list.scrollHeight / 2 > container.clientHeight)
    }
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [tickets])

  // ~4,5s por linha: rápido o bastante para dar a volta, lento o bastante
  // para alguém conseguir ler ao passar pela sala.
  const duration = Math.max(tickets.length * 4.5, 20)

  return (
    <div ref={containerRef} className="h-full overflow-hidden">
      <ul
        ref={listRef}
        className={overflowing ? 'tv-autoscroll' : ''}
        style={{ ['--scroll-duration' as string]: `${duration}s` }}
      >
        {tickets.map((t) => (
          <TicketRow key={t.id} ticket={t} />
        ))}
        {/* Segunda cópia: só existe para fechar o laço da rolagem. */}
        {overflowing &&
          tickets.map((t) => <TicketRow key={`loop-${t.id}`} ticket={t} ariaHidden />)}
      </ul>
    </div>
  )
}

function TicketRow({ ticket, ariaHidden }: { ticket: EnrichedTicket; ariaHidden?: boolean }) {
  const state = ticket.resolution_state ?? 'no_sla'
  const color = stateColor[state]
  const late = (ticket.minutes_to_resolution_due ?? 0) < 0

  return (
    <li
      aria-hidden={ariaHidden}
      className="flex items-center gap-[1.2vw] border-b border-[var(--color-tv-border)] px-[1.2vw] py-[1.1vh]"
    >
      <span
        aria-hidden="true"
        className={`h-[3.2vh] w-[0.5vw] shrink-0 rounded-full ${state === 'breached' ? 'tv-pulse' : ''}`}
        style={{ background: color }}
      />

      <span className="tv-row-text w-[6vw] shrink-0 font-mono tabular-nums text-[var(--color-tv-ink-2)]">
        #{ticket.ticket_number}
      </span>

      <span className="tv-row-text min-w-0 flex-1 truncate font-semibold">{ticket.title}</span>

      <span
        className="tv-row-text w-[10vw] shrink-0 truncate font-semibold"
        style={{ color: ticket.priority_color }}
      >
        {ticket.priority_label}
      </span>

      <span className="tv-row-text w-[13vw] shrink-0 truncate text-[var(--color-tv-ink-2)]">
        {ticket.branch_name ?? '—'}
      </span>

      <span className="tv-row-text w-[12vw] shrink-0 truncate text-[var(--color-tv-ink-2)]">
        {ticket.assignee_name ?? 'Não atribuído'}
      </span>

      <span className="tv-row-text w-[11vw] shrink-0 truncate text-[var(--color-tv-ink-2)]">
        {ticketStatusLabel[ticket.status]}
      </span>

      <span
        className={`tv-row-text w-[9vw] shrink-0 text-right font-bold tabular-nums ${late ? 'tv-pulse' : ''}`}
        style={{ color }}
      >
        {ticket.is_paused ? 'pausado' : late ? `-${formatMinutes(ticket.minutes_to_resolution_due)}` : formatMinutes(ticket.minutes_to_resolution_due)}
      </span>
    </li>
  )
}
