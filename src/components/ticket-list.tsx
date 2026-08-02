import Link from 'next/link'
import type { Route } from 'next'
import type { EnrichedTicket } from '@/lib/types'
import { PriorityBadge, SlaBadge, StatusBadge, Table, Td } from './ui'
import { formatRelative, formatTimeRemaining } from '@/lib/format'

/** Tabela de tickets reutilizada pela listagem geral e pela visão de fila. */
export function TicketList({ tickets }: { tickets: EnrichedTicket[] }) {
  return (
    <Table head={['#', 'Título', 'Status', 'Prioridade', 'Fila', 'Filial', 'Atendente', 'SLA', 'Prazo']}>
      {tickets.map((t) => (
        <tr key={t.id} className="hover:bg-[var(--color-surface-2)]">
          <Td className="font-mono text-xs text-[var(--color-ink-3)]">#{t.ticket_number}</Td>
          <Td>
            <Link
              href={`/tickets/${t.id}` as Route}
              className="font-medium text-[var(--color-brand-ink)] hover:underline"
            >
              {t.title}
            </Link>
            <p className="mt-0.5 text-xs text-[var(--color-ink-3)]">
              {t.category_parent_name ? `${t.category_parent_name} › ` : ''}
              {t.category_name ?? 'Sem categoria'} · aberto {formatRelative(t.created_at)}
              {t.source_system && (
                <>
                  {' · '}
                  <span className="font-medium">via {t.source_system}</span>
                </>
              )}
            </p>
          </Td>
          <Td>
            <StatusBadge status={t.status} />
          </Td>
          <Td>
            <PriorityBadge label={t.priority_label} color={t.priority_color} />
          </Td>
          <Td className="text-[var(--color-ink-2)]">{t.queue_name}</Td>
          <Td className="text-[var(--color-ink-2)]">{t.branch_name ?? '—'}</Td>
          <Td className="text-[var(--color-ink-2)]">{t.assignee_name ?? 'Não atribuído'}</Td>
          <Td>
            <SlaBadge state={t.resolution_state} />
          </Td>
          <Td
            className={`tabular-nums ${
              (t.minutes_to_resolution_due ?? 0) < 0
                ? 'font-semibold text-[var(--color-breach-ink)]'
                : 'text-[var(--color-ink-2)]'
            }`}
          >
            {t.is_paused ? 'pausado' : formatTimeRemaining(t.minutes_to_resolution_due)}
          </Td>
        </tr>
      ))}
    </Table>
  )
}
