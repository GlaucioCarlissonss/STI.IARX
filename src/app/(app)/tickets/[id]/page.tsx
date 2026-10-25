import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, canWorkTickets, allowed } from '@/lib/session'
import { getAgents, getQueues } from '@/lib/data/lookups'
import { formatDateTime, formatMinutes, formatRelative, formatTimeRemaining } from '@/lib/format'
import { changeSourceLabel, ticketFieldLabel, ticketStatusLabel } from '@/lib/i18n'
import type { EnrichedTicket, TicketComment, TicketHistoryEntry } from '@/lib/types'
import { Badge, Card, PriorityBadge, SlaBadge, StatusBadge } from '@/components/ui'
import { TicketActions } from './ticket-actions'
import { CommentForm } from './comment-form'
import { Attachments, type AttachmentRecord } from '@/components/attachments'
import { SugestoesDaBase, type Sugestao } from './sugestoes'
import { PainelDeIA, type SugestaoNaTela } from './painel-de-ia'
import { PainelDeAprovacao, type AprovacaoNaTela } from './aprovacao'
import {
  VinculosDoChamado,
  type AtivoVinculado,
  type LinhaVinculada,
} from './vinculos'
import { porQueNaoPosso } from '@/lib/ia/regras'
import { EXPLICACAO_DA_INDISPONIBILIDADE, type ConfigDeIA } from '@/lib/ia/tipos'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const supabase = await createClient()
  const { data } = await supabase
    .from('vw_tickets_enriched')
    .select('ticket_number, title')
    .eq('id', id)
    .maybeSingle()

  return { title: data ? `#${data.ticket_number} · ${data.title}` : 'Ticket' }
}

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { profile } = await requireScreen('helpdesk.tickets.ver')
  const supabase = await createClient()

  const { data: ticket } = await supabase
    .from('vw_tickets_enriched')
    .select('*')
    .eq('id', id)
    .maybeSingle<EnrichedTicket>()

  // RLS já filtrou o que o usuário não pode ver: "não encontrado" aqui significa
  // tanto inexistente quanto fora do escopo — e não vazamos qual dos dois.
  if (!ticket) notFound()

  const isAgent = canWorkTickets(profile.role)
  const podeEscreverNaBase = await allowed('autoatendimento.base.escrever')
  /* Duas permissões, e a distinção tem uso: quem só tem `ver` lê as sugestões e
     o registro de quem aceitou o quê — auditoria — sem poder gastar dinheiro
     pedindo mais nem decidir no lugar de quem atende. */
  const podeVincular = await allowed('helpdesk.tickets.vincular')
  const podeVerIA = await allowed('ia.sugestoes.ver')
  const podeUsarIA = await allowed('ia.sugestoes.usar')
  const podeAprovar = await allowed('autoatendimento.catalogo.aprovar')

  const [
    { data: comments },
    { data: attachments },
    { data: history },
    { data: transitions },
    queues,
    agents,
    { data: sugestoesBrutas },
    { data: artigoExistente },
    { data: configDeIA },
    { data: sugestoesDeIA },
    { data: ativosVinculados },
    { data: linhasVinculadas },
    { data: pausas },
    { data: candidatosAtivos },
    { data: candidatosLinhas },
    { data: aprovacao },
  ] =
    await Promise.all([
      supabase
        .from('ticket_comments')
        .select('id, ticket_id, author_id, body, visibility, created_at, author:profiles(full_name, role)')
        .eq('ticket_id', id)
        .is('deleted_at', null)
        .order('created_at', { ascending: true })
        .returns<TicketComment[]>(),
      supabase
        .from('ticket_attachments')
        .select('id, storage_path, file_name, mime_type, size_bytes, created_at, kind')
        .eq('ticket_id', id)
        .order('created_at', { ascending: false })
        .returns<AttachmentRecord[]>(),
      supabase
        .from('ticket_history')
        .select('id, field, old_value, new_value, change_source, created_at, actor_id')
        .eq('ticket_id', id)
        .order('created_at', { ascending: false })
        .limit(60)
        .returns<TicketHistoryEntry[]>(),
      supabase
        .from('ticket_status_transitions')
        .select('to_status')
        .eq('from_status', ticket.status),
      getQueues(),
      getAgents(),
      /* Artigos que podem resolver este chamado. A função é `security invoker`:
         quem não enxerga o chamado recebe lista vazia, sem vazar nem o fato de
         ele existir. */
      supabase.rpc('kb_sugestoes', { p_ticket_id: id, p_limite: 3 }),
      /* Este chamado já virou artigo? Evita a dupla: o botão some e o link para
         o artigo aparece. */
      supabase
        .from('kb_articles')
        .select('id, title')
        .eq('source_ticket_id', id)
        .is('deleted_at', null)
        .limit(1)
        .returns<{ id: string; title: string }[]>(),
      /* A configuração de IA é lida junto com o resto porque o painel precisa
         saber, antes de desenhar qualquer botão, se o recurso está ligado — e
         uma segunda ida ao banco depois da renderização faria o painel piscar. */
      podeVerIA
        ? supabase.rpc('ai_config_utilizavel').maybeSingle<ConfigDeIA>()
        : Promise.resolve({ data: null }),
      podeVerIA
        ? supabase
            .from('vw_ai_suggestions')
            .select(
              'id, kind, payload, status, model, custo_centavos, created_at, acted_at, requested_by_name, acted_by_name',
            )
            .eq('ticket_id', id)
            .order('created_at', { ascending: false })
            .limit(20)
            .returns<SugestaoNaTela[]>()
        : Promise.resolve({ data: [] }),
      /* As duas tabelas de vínculo existem desde a 0004 e nenhuma tela jamais
         escreveu nelas — o README afirmava "vínculo com tickets" desde a
         primeira versão. */
      supabase
        .from('ticket_assets')
        .select('asset_id, asset:it_assets(id, asset_tag, brand, model, asset_type, status)')
        .eq('ticket_id', id)
        .returns<AtivoVinculado[]>(),
      supabase
        .from('ticket_telecom_lines')
        .select('line_id, line:telecom_lines(id, phone_number, carrier)')
        .eq('ticket_id', id)
        .returns<LinhaVinculada[]>(),
      /* O histórico de pausa do relógio. A pausa é automática desde a 0006 (a
         trigger abre quando o chamado entra em espera e fecha quando sai), e o
         chamado mostrava só o distintivo "pausado" — sem dizer desde quando nem
         por quê. */
      supabase
        .from('sla_pauses')
        .select('id, reason, started_at, ended_at')
        .eq('ticket_id', id)
        .order('started_at', { ascending: false })
        .limit(20)
        .returns<{ id: string; reason: string; started_at: string; ended_at: string | null }[]>(),
      /*
       * Os candidatos a vínculo, restritos à FILIAL do chamado.
       *
       * `it_assets` e `telecom_lines` são por filial, não por cliente — e um
       * ambiente com trinta filiais tem milhares de ativos. Oferecer todos num
       * `select` seria uma lista inutilizável e um payload grande em cada
       * abertura de chamado. Chamado sem filial não oferece nada, e a tela diz
       * isso em vez de parecer quebrada.
       */
      isAgent && ticket.branch_id
        ? supabase
            .from('it_assets')
            .select('id, asset_tag, brand, model, asset_type')
            .eq('branch_id', ticket.branch_id)
            .is('deleted_at', null)
            .order('asset_tag', { nullsFirst: false })
            .limit(300)
            .returns<
              {
                id: string
                asset_tag: string | null
                brand: string | null
                model: string | null
                asset_type: string
              }[]
            >()
        : Promise.resolve({ data: [] }),
      isAgent && ticket.branch_id
        ? supabase
            .from('telecom_lines')
            .select('id, phone_number')
            .eq('branch_id', ticket.branch_id)
            .is('deleted_at', null)
            .order('phone_number')
            .limit(300)
            .returns<{ id: string; phone_number: string }[]>()
        : Promise.resolve({ data: [] }),
      /* A aprovação do pedido, quando houver. `maybeSingle` porque é no máximo
         uma: `uq_service_approval_ticket` garante um pedido por chamado. */
      supabase
        .from('service_approvals')
        .select(
          'status, requested_at, decided_at, motivo, pedinte:requested_by(full_name), decisor:decided_by(full_name), servico:service_id(name, aprovador_profile_id, perfil:aprovador_profile_id(name))',
        )
        .eq('ticket_id', id)
        .maybeSingle<{
          status: 'pendente' | 'aprovado' | 'recusado'
          requested_at: string
          decided_at: string | null
          motivo: string | null
          pedinte: { full_name: string } | null
          decisor: { full_name: string } | null
          servico: { name: string; perfil: { name: string } | null } | null
        }>(),
    ])

  const allowedStatuses = (transitions ?? []).map((t) => t.to_status as EnrichedTicket['status'])
  /* O cliente Supabase não tem o tipo desta função (ela nasceu na 0033 e os
     tipos gerados não a conhecem). O molde é o da própria função, e está
     declarado em `sugestoes.tsx`. */
  const sugestoes = (sugestoesBrutas ?? []) as unknown as Sugestao[]

  /* O que já está vinculado sai da lista de candidatos: oferecer de novo daria
     um erro de chave duplicada por um clique que a tela convidou a dar. */
  const jaVinculados = new Set((ativosVinculados ?? []).map((a) => a.asset_id))
  const jaVinculadas = new Set((linhasVinculadas ?? []).map((l) => l.line_id))
  const ativosDisponiveis = (candidatosAtivos ?? []).filter((a) => !jaVinculados.has(a.id))
  const linhasDisponiveis = (candidatosLinhas ?? []).filter((l) => !jaVinculadas.has(l.id))

  /* Por que a IA não está disponível — calculado no SERVIDOR, porque é aqui que
     dá para olhar `process.env` e saber se a variável nomeada na configuração
     existe de fato. O navegador não tem como saber isso, e "ligada mas sem a
     variável" é o erro de configuração mais comum. */
  const motivoDeIndisponibilidade = podeVerIA
    ? porQueNaoPosso(configDeIA ?? null, 'resposta')
    : null

  return (
    <>
      <div className="mb-6">
        <p className="font-mono text-sm text-[var(--color-ink-3)]">#{ticket.ticket_number}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-[var(--color-ink)]">
          {ticket.title}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <StatusBadge status={ticket.status} />
          <PriorityBadge label={ticket.priority_label} color={ticket.priority_color} />
          <SlaBadge state={ticket.resolution_state} />
          {ticket.is_paused && <Badge tone="warn">Relógio de SLA pausado</Badge>}
          {ticket.sla_coverage === 'uncovered' && (
            <Badge tone="neutral">Sem SLA configurado para esta combinação</Badge>
          )}
          {ticket.source_system && (
            <Badge tone="info">
              Origem: {ticket.source_system}
              {ticket.external_id ? ` #${ticket.external_id}` : ''}
            </Badge>
          )}
        </div>
      </div>

      {/*
        O painel de IA fica DEPOIS das sugestões da base, e não antes.

        A base é determinística, gratuita e já tem a resposta de um problema que
        alguém resolveu. A IA é probabilística e custa por clique. Oferecer a IA
        primeiro ensinaria a equipe a pular a base — e a base deixaria de ser
        alimentada, que é o único jeito de ela servir para alguma coisa.
      */}
      {/* A aprovação vem ANTES de tudo que é de atendimento: enquanto ela está
          pendente, não há atendimento a fazer — e o painel diz isso em vez de
          deixar a equipe procurar por que o chamado não anda. */}
      {aprovacao && (
        <PainelDeAprovacao
          ticketId={id}
          podeDecidir={podeAprovar}
          aprovacao={
            {
              status: aprovacao.status,
              requested_at: aprovacao.requested_at,
              requested_by_name: aprovacao.pedinte?.full_name ?? null,
              decided_at: aprovacao.decided_at,
              decided_by_name: aprovacao.decisor?.full_name ?? null,
              motivo: aprovacao.motivo,
              servico: aprovacao.servico?.name ?? 'O serviço pedido',
              perfil_exigido: aprovacao.servico?.perfil?.name ?? null,
            } satisfies AprovacaoNaTela
          }
        />
      )}

      {isAgent && podeVerIA && (
        <PainelDeIA
          ticketId={id}
          sugestoes={sugestoesDeIA ?? []}
          podeUsar={podeUsarIA}
          disponivel={
            motivoDeIndisponibilidade
              ? { pode: false, motivo: EXPLICACAO_DA_INDISPONIBILIDADE[motivoDeIndisponibilidade] }
              : { pode: true }
          }
          recursos={{
            resposta: configDeIA?.sugerir_resposta ?? false,
            triagem: configDeIA?.sugerir_triagem ?? false,
            artigo: configDeIA?.redigir_artigo ?? false,
          }}
          resolvido={ticket.status === 'resolved' || ticket.status === 'closed'}
        />
      )}

      {/*
        As sugestões vêm ANTES do corpo do chamado, e só para quem atende.

        É o fechamento do ciclo: o artigo escrito a partir de um chamado volta a
        aparecer no chamado seguinte parecido. Enterrá-las embaixo do histórico
        faria ninguém as ver — e uma sugestão que ninguém vê é o mesmo que uma
        base de conhecimento que ninguém lê.
      */}
      {isAgent && (
        <SugestoesDaBase
          sugestoes={sugestoes}
          ticketId={id}
          podeEscrever={podeEscreverNaBase}
          artigoDoChamado={(artigoExistente ?? [])[0] ?? null}
          resolvido={ticket.status === 'resolved' || ticket.status === 'closed'}
        />
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card title="Descrição">
            {ticket.description ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-ink)]">
                {ticket.description}
              </p>
            ) : (
              <p className="text-sm italic text-[var(--color-ink-3)]">Sem descrição.</p>
            )}
          </Card>

          <Card title={`Comentários (${comments?.length ?? 0})`}>
            <ul className="flex flex-col gap-4">
              {(comments ?? []).map((c) => (
                <li
                  key={c.id}
                  className={`rounded-lg border p-4 ${
                    c.visibility === 'internal'
                      ? 'border-[var(--color-warn-ink)]/25 bg-[var(--color-warn-soft)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
                  }`}
                >
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-[var(--color-ink)]">
                      {c.author?.full_name ?? 'Sistema'}
                    </span>
                    {c.visibility === 'internal' && <Badge tone="warn">Interno</Badge>}
                    <span className="text-xs text-[var(--color-ink-3)]">
                      {formatDateTime(c.created_at)}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-[var(--color-ink)]">{c.body}</p>
                </li>
              ))}
              {(comments ?? []).length === 0 && (
                <li className="text-sm italic text-[var(--color-ink-3)]">
                  Nenhum comentário ainda.
                </li>
              )}
            </ul>

            <div className="mt-5 border-t border-[var(--color-border)] pt-5">
              <CommentForm ticketId={ticket.id} canPostInternal={isAgent} />
            </div>
          </Card>

          {/* Equipamento e linha logo depois dos comentários, e só para quem
              atende: é durante o atendimento que se descobre de qual máquina o
              problema é, e esse é o único instante em que marcar custa um
              clique. */}
          {isAgent && (
            <VinculosDoChamado
              ticketId={id}
              ativos={ativosVinculados ?? []}
              linhas={linhasVinculadas ?? []}
              ativosDisponiveis={ativosDisponiveis}
              linhasDisponiveis={linhasDisponiveis}
              podeVincular={podeVincular}
            />
          )}

          {/* Até esta rodada `ticket_attachments` existia sem nenhum caminho de
              upload: anexar arquivo a um ticket era impossível. */}
          <Attachments
            entity="tickets"
            entityId={ticket.id}
            records={attachments ?? []}
            title="Anexos do ticket"
          />

          <Card title="Histórico">
            {/* O teto de 60 é antigo e fica; o que faltava era dizê-lo. A
                ordem é decrescente, então o que o corte esconde num ticket
                longo é a abertura — justamente a parte que alguém procura
                quando volta ao histórico. */}
            {(history ?? []).length >= 60 && (
              <p className="mb-2 text-xs text-[var(--color-ink-3)]">
                Mostrando os 60 eventos mais recentes.
              </p>
            )}
            <ol className="flex flex-col gap-2.5">
              {(history ?? []).map((h) => (
                <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                  <span className="text-xs tabular-nums text-[var(--color-ink-3)]">
                    {formatDateTime(h.created_at)}
                  </span>
                  <span className="font-medium text-[var(--color-ink)]">
                    {ticketFieldLabel[h.field] ?? h.field}
                  </span>
                  <span className="text-[var(--color-ink-2)]">
                    {h.field === 'status'
                      ? `${ticketStatusLabel[h.old_value as EnrichedTicket['status']] ?? h.old_value ?? '—'} → ${
                          ticketStatusLabel[h.new_value as EnrichedTicket['status']] ?? h.new_value
                        }`
                      : h.field === 'queue_transfer_reason'
                        ? `motivo: ${h.new_value}`
                        : `${h.old_value ?? '—'} → ${h.new_value ?? '—'}`}
                  </span>
                  <Badge tone="neutral">{changeSourceLabel[h.change_source] ?? h.change_source}</Badge>
                </li>
              ))}
              {(history ?? []).length === 0 && (
                <li className="text-sm italic text-[var(--color-ink-3)]">Sem alterações registradas.</li>
              )}
            </ol>
          </Card>
        </div>

        <aside className="flex flex-col gap-6">
          <Card title="SLA">
            <dl className="flex flex-col gap-3 text-sm">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                  Primeira resposta
                </dt>
                <dd className="mt-0.5 flex items-center gap-2">
                  <SlaBadge state={ticket.response_state} />
                  <span className="text-[var(--color-ink-2)]">
                    {ticket.responded_at
                      ? formatDateTime(ticket.responded_at)
                      : `vence ${formatDateTime(ticket.response_due_at)}`}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                  Resolução
                </dt>
                <dd className="mt-0.5 flex items-center gap-2">
                  <SlaBadge state={ticket.resolution_state} />
                  <span className="text-[var(--color-ink-2)]">
                    {ticket.resolved_at
                      ? formatDateTime(ticket.resolved_at)
                      : `vence ${formatDateTime(ticket.resolution_due_at)}`}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                  Tempo restante
                </dt>
                <dd
                  className={`mt-0.5 text-lg font-bold tabular-nums ${
                    (ticket.minutes_to_resolution_due ?? 0) < 0
                      ? 'text-[var(--color-breach-ink)]'
                      : 'text-[var(--color-ink)]'
                  }`}
                >
                  {ticket.is_paused
                    ? 'Pausado'
                    : formatTimeRemaining(ticket.minutes_to_resolution_due)}
                </dd>
              </div>
              {(ticket.paused_minutes ?? 0) > 0 && (
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                    Tempo pausado
                  </dt>
                  <dd className="mt-0.5 text-[var(--color-ink-2)]">
                    {formatMinutes(ticket.paused_minutes)} de expediente
                  </dd>
                </div>
              )}
            </dl>

            {/*
              Desde quando, e por quê.

              A pausa é automática desde a migração 0006: a trigger abre quando o
              chamado entra em estado de espera e fecha quando sai, creditando só
              os minutos que caíram dentro do expediente. A tela mostrava o
              distintivo "pausado" e o total — e não dizia DESDE QUANDO nem POR
              QUÊ, que é o que alguém quer saber ao ver um prazo que não anda.

              Não há botão de pausar: criar um segundo caminho brigaria com a
              trigger pelo índice único de pausa aberta.
            */}
            {(pausas ?? []).length > 0 && (
              <details className="mt-4 border-t border-[var(--color-border)] pt-3">
                <summary className="cursor-pointer text-xs text-[var(--color-ink-2)]">
                  {(pausas ?? []).length} pausa(s) do relógio
                </summary>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {(pausas ?? []).map((p) => (
                    <li key={p.id} className="text-xs text-[var(--color-ink-2)]">
                      <span className="font-medium text-[var(--color-ink)]">
                        {ticketStatusLabel[p.reason as EnrichedTicket['status']] ?? p.reason}
                      </span>
                      <br />
                      {formatDateTime(p.started_at)} →{' '}
                      {p.ended_at ? (
                        formatDateTime(p.ended_at)
                      ) : (
                        <span className="text-[var(--color-warn-ink)]">em aberto</span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-[var(--color-ink-3)]">
                  O relógio para sozinho quando o chamado entra em espera. Só conta como pausa o
                  tempo que caiu dentro do expediente.
                </p>
              </details>
            )}
          </Card>

          {isAgent && (
            <Card title="Ações">
              <TicketActions
                ticketId={ticket.id}
                currentQueueId={ticket.queue_id}
                currentAssigneeId={ticket.assignee_id}
                allowedStatuses={allowedStatuses}
                queues={queues}
                agents={agents}
              />
            </Card>
          )}

          <Card title="Detalhes">
            <dl className="flex flex-col gap-2.5 text-sm">
              <Detail label="Fila" value={ticket.queue_name} />
              <Detail
                label="Categoria"
                value={
                  ticket.category_name
                    ? `${ticket.category_parent_name ? `${ticket.category_parent_name} › ` : ''}${ticket.category_name}`
                    : '—'
                }
              />
              <Detail label="Cliente" value={ticket.client_name ?? '—'} />
              <Detail label="Filial" value={ticket.branch_name ?? '—'} />
              <Detail label="Solicitante" value={ticket.requester_name ?? '—'} />
              <Detail label="Atendente" value={ticket.assignee_name ?? 'Não atribuído'} />
              <Detail label="Fornecedor" value={ticket.supplier_name ?? '—'} />
              <Detail
                label="Aberto em"
                value={`${formatDateTime(ticket.created_at)} (${formatRelative(ticket.created_at)})`}
              />
              {ticket.reopened_count > 0 && (
                <Detail label="Reaberturas" value={String(ticket.reopened_count)} />
              )}
              {ticket.tags.length > 0 && (
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                    Tags
                  </dt>
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {ticket.tags.map((tag) => (
                      <Badge key={tag} tone="neutral">
                        {tag}
                      </Badge>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
          </Card>
        </aside>
      </div>
    </>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[var(--color-ink-3)]">{label}</dt>
      <dd className="text-right font-medium text-[var(--color-ink)]">{value}</dd>
    </div>
  )
}
