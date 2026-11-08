import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { getAgents } from '@/lib/data/lookups'
import { formatDateTime, formatRelative } from '@/lib/format'
import { ticketStatusLabel } from '@/lib/i18n'
import type { EnrichedTicket, TicketComment, TicketStatus } from '@/lib/types'
import { Gaveta } from '@/components/gaveta'
import { EdicaoNaLinha } from '@/components/edicao-na-linha'
import { PriorityBadge, StatusBadge } from '@/components/ui'
import { CommentForm } from './[id]/comment-form'

/**
 * O conteúdo da gaveta: o chamado, sem sair da lista.
 *
 * ## Por que é componente de SERVIDOR
 *
 * Porque assim ele usa as mesmas consultas, o mesmo cliente de sessão e as
 * mesmas conferências de permissão da tela inteira. A alternativa — uma rota
 * de API devolvendo o chamado em JSON para o navegador montar — criaria uma
 * segunda porta para os mesmos dados, e duas portas para a mesma coisa é como
 * se abre um buraco: a nova esquece uma conferência que a velha fazia.
 *
 * ## O que ela NÃO tenta ser
 *
 * A página inteira. Aqui ficam as quatro coisas que respondem "o que é isto e
 * o que eu faço agora": cabeçalho, estado editável, conversa e resposta.
 * Anexos, vínculos, sugestões de IA, trilha e aprovação continuam em
 * `/tickets/[id]`, que não mudou — e o link para lá está sempre à vista.
 *
 * ## `notFound` silencioso
 *
 * Um `?aberto=` com id inexistente, ou de um chamado que o RLS não deixa ler,
 * não derruba a tela: a gaveta simplesmente não aparece e a lista continua. É
 * um parâmetro de URL, e parâmetro de URL é digitável.
 */
export async function GavetaDoChamado({
  id,
  fechar,
}: {
  id: string
  /** Endereço da mesma lista sem o parâmetro da gaveta. */
  fechar: string
}) {
  const supabase = await createClient()

  /* Sem filtro de `deleted_at`: a view já exclui o que foi apagado, e ela não
     expõe a coluna — pedir por ela devolvia erro, e erro aqui é a gaveta não
     abrir, em silêncio. A mesma consulta da lista é a referência. */
  const { data: ticket } = await supabase
    .from('vw_tickets_enriched')
    .select('*')
    .eq('id', id)
    .maybeSingle<EnrichedTicket>()

  if (!ticket) return null

  const [{ data: comentarios }, { data: transicoes }, agentes, podeStatus, podeAtribuir, podeComentar, podeInterno] =
    await Promise.all([
      supabase
        .from('ticket_comments')
        .select('id, ticket_id, author_id, body, visibility, created_at, author:profiles(full_name, role)')
        .eq('ticket_id', id)
        .is('deleted_at', null)
        .order('created_at', { ascending: true })
        .limit(30)
        .returns<TicketComment[]>(),
      supabase.from('ticket_status_transitions').select('to_status').eq('from_status', ticket.status),
      getAgents(),
      allowed('helpdesk.tickets.mudar_status'),
      allowed('helpdesk.tickets.atribuir'),
      allowed('helpdesk.tickets.comentar'),
      allowed('helpdesk.tickets.comentar_interno'),
    ])

  /* A lista de status oferecida é a que o BANCO aceita a partir do estado
     atual (ADR-007). Oferecer uma transição que a trigger recusa é prometer o
     que não se cumpre — e a recusa chegaria depois do clique. */
  const statusPossiveis = [
    { valor: ticket.status, rotulo: ticketStatusLabel[ticket.status] },
    ...(transicoes ?? []).map((t) => {
      const s = t.to_status as TicketStatus
      return { valor: s, rotulo: ticketStatusLabel[s] }
    }),
  ]

  const atendentes = [
    { valor: '', rotulo: 'Não atribuído' },
    ...agentes.map((a) => ({ valor: a.id, rotulo: a.full_name })),
  ]

  return (
    <Gaveta fechar={fechar} rotulo={`Chamado ${ticket.ticket_number}`}>
      <header className="border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex items-start gap-3">
          <p className="min-w-0 flex-1 text-xs text-[var(--color-ink-3)]">
            <span className="font-mono">#{ticket.ticket_number}</span> ·{' '}
            {[ticket.category_parent_name, ticket.category_name].filter(Boolean).join(' › ') ||
              'Sem categoria'}{' '}
            · aberto {formatRelative(ticket.created_at)}
          </p>
          <Link
            href={fechar as Route}
            aria-label="Fechar a gaveta"
            data-testid="fechar-gaveta"
            className="rounded-lg border border-[var(--color-border)] px-2 py-0.5 text-sm text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]"
          >
            ✕
          </Link>
        </div>

        <h2 className="mt-1 text-lg font-bold leading-snug text-[var(--color-ink)]">
          {ticket.title}
        </h2>

        <div className="mt-2.5 flex flex-wrap items-center gap-2 text-sm">
          <Campo nome="Status">
            <EdicaoNaLinha
              ticketId={ticket.id}
              campo="status"
              valor={ticket.status}
              opcoes={statusPossiveis}
              rotulo={`Status do chamado ${ticket.ticket_number}`}
              podeEditar={podeStatus && statusPossiveis.length > 1}
            >
              <StatusBadge status={ticket.status} />
            </EdicaoNaLinha>
          </Campo>

          <Campo nome="Atendente">
            <EdicaoNaLinha
              ticketId={ticket.id}
              campo="atendente"
              valor={ticket.assignee_id ?? ''}
              opcoes={atendentes}
              rotulo={`Atendente do chamado ${ticket.ticket_number}`}
              podeEditar={podeAtribuir}
            >
              <span className="text-sm font-medium text-[var(--color-ink)]">
                {ticket.assignee_name ?? 'ninguém'}
              </span>
            </EdicaoNaLinha>
          </Campo>

          <Campo nome="Prioridade">
            <PriorityBadge label={ticket.priority_label} color={ticket.priority_color} />
          </Campo>

          <Campo nome="Fila">
            <span className="text-sm text-[var(--color-ink)]">{ticket.queue_name}</span>
          </Campo>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 pb-6 pt-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
          Conversa
        </h3>

        {ticket.description && (
          <article className="mb-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
            <p className="mb-1 text-xs text-[var(--color-ink-3)]">
              {ticket.requester_name ?? 'Solicitante'} · abertura
            </p>
            <p className="whitespace-pre-wrap text-sm text-[var(--color-ink)]">
              {ticket.description}
            </p>
          </article>
        )}

        {(comentarios ?? []).map((c) => (
          <article
            key={c.id}
            className={`mb-2 rounded-lg border p-3 ${
              c.visibility === 'internal'
                ? 'border-[var(--color-warn-soft)] bg-[var(--color-warn-soft)]'
                : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
            }`}
          >
            <p className="mb-1 text-xs text-[var(--color-ink-3)]">
              {c.author?.full_name ?? 'Alguém'}
              {c.visibility === 'internal' && ' · nota interna'} · {formatDateTime(c.created_at)}
            </p>
            <p className="whitespace-pre-wrap text-sm text-[var(--color-ink)]">{c.body}</p>
          </article>
        ))}

        {podeComentar && (
          <div className="mt-3">
            <CommentForm ticketId={ticket.id} canPostInternal={podeInterno} />
          </div>
        )}
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] px-4 py-2.5 text-sm">
        {/* A página inteira continua sendo o lugar de tudo o que não cabe aqui
            — e o link de e-mail aponta para ela, não para isto. */}
        <Link
          href={`/tickets/${ticket.id}` as Route}
          className="font-semibold text-[var(--color-brand-ink)] hover:underline"
        >
          Abrir em página inteira ↗
        </Link>
        <span className="hidden text-xs text-[var(--color-ink-3)] lg:inline">
          J K passam de chamado · Esc fecha
        </span>
      </footer>
    </Gaveta>
  )
}

function Campo({ nome, children }: { nome: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1">
      <span className="text-xs text-[var(--color-ink-3)]">{nome}:</span>
      {children}
    </span>
  )
}
