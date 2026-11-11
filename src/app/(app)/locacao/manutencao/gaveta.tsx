import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { formatCurrency, formatDate } from '@/lib/format'
import { ticketStatusLabel } from '@/lib/i18n'
import type {
  FieldServiceCost,
  Profile,
  TicketLaborEntry,
  TicketPartUsed,
  TicketStatus,
} from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import { situacaoDaAlcada, TIPO_DO_ATENDIMENTO, QUEM_PAGA } from '@/lib/locacao/rotulos'
import {
  AbrirAtendimentoForm,
  ApontarHorasForm,
  ApontarPecaForm,
  AprovarCustoForm,
  EditarCampoForm,
  MoverAtendimentoForm,
  RemoverApontamentoForm,
  RevogarAprovacaoForm,
} from './forms'

/**
 * O atendimento de campo na gaveta.
 *
 * A ordem das seções é a ordem do trabalho: primeiro o custo (que é o que se
 * quer saber antes de qualquer decisão), depois o apontamento, depois o
 * fechamento. A alçada aparece junto do custo — e não enterrada no fim —
 * porque é ela que diz se o fechamento vai passar.
 */
export async function GavetaDeManutencao({
  id,
  novo,
  fechar,
}: {
  id?: string
  novo?: boolean
  fechar: string
}) {
  const [podeAbrir, podeAtender, podeAprovar] = await Promise.all([
    allowed('locacao.manutencao.abrir'),
    allowed('locacao.manutencao.atender'),
    allowed('locacao.manutencao.aprovar'),
  ])

  const supabase = await createClient()

  if (novo) {
    if (!podeAbrir) return null
    /* Consultas planas, e o modelo resolvido em memória: o driver do modo local
       (docs/22) fala o dialeto do PostgREST sem o recurso de embutir relação —
       `equipment_models(name)` voltaria vazio e o seletor mostraria o
       patrimônio sem o modelo, que é justamente o que identifica a peça. */
    const [{ data: equipamentos }, { data: modelos }, { data: prioridades }] = await Promise.all([
      supabase
        .from('rental_equipment')
        .select('id, asset_tag, status, model_id')
        .is('deleted_at', null)
        .order('asset_tag')
        .returns<{ id: string; asset_tag: string; status: string; model_id: string }[]>(),
      supabase
        .from('equipment_models')
        .select('id, name')
        .returns<{ id: string; name: string }[]>(),
      supabase
        .from('ticket_priorities')
        .select('id, label')
        .eq('is_active', true)
        .order('weight', { ascending: false })
        .returns<{ id: string; label: string }[]>(),
    ])
    const nomeDoModelo = new Map((modelos ?? []).map((m) => [m.id, m.name]))

    return (
      <Gaveta fechar={fechar} rotulo="Abrir atendimento de campo">
        <CabecalhoDaGaveta
          titulo="Abrir atendimento de campo"
          linha="Vira um chamado na fila de campo — com SLA e histórico"
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <AbrirAtendimentoForm
            equipamentos={(equipamentos ?? []).map((e) => ({
              id: e.id,
              asset_tag: e.asset_tag,
              modelo: nomeDoModelo.get(e.model_id) ?? 'modelo removido',
              situacao: e.status,
            }))}
            prioridades={(prioridades ?? []).map((p) => ({ id: p.id, name: p.label }))}
          />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!id) return null

  const { data: campo } = await supabase
    .from('ticket_field_service')
    .select(
      'ticket_id, equipment_id, contract_item_id, kind, cost_limit, approved_by, approved_at, approval_note, billable_to',
    )
    .eq('ticket_id', id)
    .maybeSingle<{
      ticket_id: string
      equipment_id: string
      contract_item_id: string | null
      kind: 'corrective' | 'preventive' | 'installation' | 'removal'
      cost_limit: number | null
      approved_by: string | null
      approved_at: string | null
      approval_note: string | null
      billable_to: 'provider' | 'client'
    }>()

  if (!campo) return null

  const [{ data: ticket }, { data: custo }, { data: horas }, { data: pecas }, { data: equipamento }] =
    await Promise.all([
      supabase
        .from('tickets')
        .select('id, ticket_number, title, description, status, created_at')
        .eq('id', id)
        .maybeSingle<{
          id: string
          ticket_number: number
          title: string
          description: string | null
          status: TicketStatus
          created_at: string
        }>(),
      supabase
        .from('vw_field_service_cost')
        .select('ticket_id, labor_cost, parts_cost, total_cost, total_hours')
        .eq('ticket_id', id)
        .maybeSingle<FieldServiceCost>(),
      supabase
        .from('ticket_labor_entries')
        .select('id, ticket_id, technician_id, worked_on, hours, hourly_rate, amount, notes')
        .eq('ticket_id', id)
        .order('worked_on', { ascending: false })
        .returns<TicketLaborEntry[]>(),
      supabase
        .from('ticket_parts_used')
        .select('id, ticket_id, description, quantity, unit_cost, amount')
        .eq('ticket_id', id)
        .order('created_at')
        .returns<TicketPartUsed[]>(),
      supabase
        .from('rental_equipment')
        .select('id, asset_tag, status, model_id')
        .eq('id', campo.equipment_id)
        .maybeSingle<{ id: string; asset_tag: string; status: string; model_id: string }>(),
    ])

  if (!ticket) return null

  const [{ data: destinos }, { data: tecnicos }, { data: aprovador }, { data: modelo }] =
    await Promise.all([
    supabase
      .from('ticket_status_transitions')
      .select('to_status')
      .eq('from_status', ticket.status)
      .returns<{ to_status: TicketStatus }[]>(),
    supabase
      .from('profiles')
      .select('id, full_name')
      .in('role', ['admin', 'gestor', 'atendente'])
      .eq('is_active', true)
      .order('full_name')
      .returns<Pick<Profile, 'id' | 'full_name'>[]>(),
    campo.approved_by
      ? supabase
          .from('profiles')
          .select('id, full_name')
          .eq('id', campo.approved_by)
          .maybeSingle<Pick<Profile, 'id' | 'full_name'>>()
      : Promise.resolve({ data: null }),
    equipamento
      ? supabase
          .from('equipment_models')
          .select('name')
          .eq('id', equipamento.model_id)
          .maybeSingle<{ name: string }>()
      : Promise.resolve({ data: null }),
  ])

  const total = Number(custo?.total_cost ?? 0)
  const alcada = situacaoDaAlcada(campo.cost_limit, total, campo.approved_at)
  const tipo = TIPO_DO_ATENDIMENTO[campo.kind]

  return (
    <Gaveta fechar={fechar} rotulo={`Atendimento #${ticket.ticket_number}`}>
      <CabecalhoDaGaveta
        titulo={`#${ticket.ticket_number} · ${ticket.title}`}
        linha={`${equipamento?.asset_tag ?? 'equipamento'} · ${modelo?.name ?? ''}`}
        fechar={fechar}
        selo={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={tipo.tone}>{tipo.label}</Badge>
            <Badge tone="info">{ticketStatusLabel[ticket.status]}</Badge>
          </span>
        }
      />

      <CorpoDaGaveta>
        {/* 1. O custo — e a alçada junto dele, que é o que decide o fechamento. */}
        <section data-testid="custo-do-atendimento">
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Custo</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[var(--color-ink-3)]">Mão de obra</dt>
            <dd className="text-right tabular-nums">
              {formatCurrency(Number(custo?.labor_cost ?? 0))}
              <span className="ml-1 text-xs text-[var(--color-ink-3)]">
                ({Number(custo?.total_hours ?? 0).toLocaleString('pt-BR')}h)
              </span>
            </dd>
            <dt className="text-[var(--color-ink-3)]">Peças</dt>
            <dd className="text-right tabular-nums">
              {formatCurrency(Number(custo?.parts_cost ?? 0))}
            </dd>
            <dt className="font-semibold text-[var(--color-ink)]">Total</dt>
            <dd className="text-right text-base font-bold tabular-nums">{formatCurrency(total)}</dd>
          </dl>

          <div className="mt-3 rounded-lg border border-[var(--color-border)] px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge tone={alcada.tone}>{alcada.label}</Badge>
              <span className="text-xs tabular-nums text-[var(--color-ink-3)]">
                {campo.cost_limit === null
                  ? 'sem teto definido'
                  : `teto ${formatCurrency(Number(campo.cost_limit))}`}
              </span>
            </div>
            <p className="mt-1 text-xs text-[var(--color-ink-3)]">
              {alcada.estado === 'estourou'
                ? 'O fechamento está travado: o banco recusa resolver este atendimento enquanto o custo não for aprovado.'
                : alcada.estado === 'aprovado'
                  ? `Aprovado por ${aprovador?.full_name ?? 'alguém que saiu'}${
                      campo.approved_at ? ` em ${formatDate(campo.approved_at)}` : ''
                    }.${campo.approval_note ? ` "${campo.approval_note}"` : ''}`
                  : alcada.estado === 'sem_teto'
                    ? 'Sem alçada, nada trava — ausência de teto é ausência de teto, e não um teto zero.'
                    : 'Dentro do teto: o fechamento passa sem aprovação.'}
            </p>
          </div>

          {podeAprovar && alcada.estado === 'estourou' && (
            <div className="mt-3">
              <AprovarCustoForm ticketId={ticket.id} custo={formatCurrency(total)} />
            </div>
          )}
          {podeAprovar && alcada.estado === 'aprovado' && (
            <div className="mt-3">
              <RevogarAprovacaoForm ticketId={ticket.id} />
            </div>
          )}
        </section>

        {/* 2. O detalhe de onde o custo veio. */}
        <section className="border-t border-[var(--color-border)] pt-4">
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
            Apontamentos ({(horas ?? []).length + (pecas ?? []).length})
          </h3>
          {(horas ?? []).length === 0 && (pecas ?? []).length === 0 ? (
            <p className="text-sm text-[var(--color-ink-3)]">
              Nada apontado ainda. O custo de um atendimento é a soma do que foi lançado — não há
              campo de “custo total” para digitar.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {(horas ?? []).map((h) => (
                <div
                  key={h.id}
                  data-testid="apontamento-de-hora"
                  className="rounded-lg border border-[var(--color-border)] px-3 py-2"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm text-[var(--color-ink)]">
                      {Number(h.hours).toLocaleString('pt-BR')}h em {formatDate(h.worked_on)}
                    </span>
                    <span className="text-sm font-semibold tabular-nums">
                      {formatCurrency(Number(h.amount))}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-[var(--color-ink-3)]">
                      Mão de obra · {formatCurrency(Number(h.hourly_rate))}/h
                      {h.notes && ` · ${h.notes}`}
                    </p>
                    {podeAtender && (
                      <RemoverApontamentoForm id={h.id} ticketId={ticket.id} tipo="hora" />
                    )}
                  </div>
                </div>
              ))}
              {(pecas ?? []).map((p) => (
                <div
                  key={p.id}
                  data-testid="apontamento-de-peca"
                  className="rounded-lg border border-[var(--color-border)] px-3 py-2"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm text-[var(--color-ink)]">{p.description}</span>
                    <span className="text-sm font-semibold tabular-nums">
                      {formatCurrency(Number(p.amount))}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-[var(--color-ink-3)]">
                      Peça · {Number(p.quantity).toLocaleString('pt-BR')} ×{' '}
                      {formatCurrency(Number(p.unit_cost))}
                    </p>
                    {podeAtender && (
                      <RemoverApontamentoForm id={p.id} ticketId={ticket.id} tipo="peca" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {podeAtender && (
          <>
            <section className="border-t border-[var(--color-border)] pt-4">
              <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Apontar horas</h3>
              <ApontarHorasForm ticketId={ticket.id} tecnicos={tecnicos ?? []} />
            </section>
            <section className="border-t border-[var(--color-border)] pt-4">
              <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Apontar peça</h3>
              <ApontarPecaForm ticketId={ticket.id} />
            </section>
          </>
        )}

        {/* 3. Mover o chamado, sem sair da tela de campo. */}
        {podeAtender && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
              Situação: {ticketStatusLabel[ticket.status]}
            </h3>
            <MoverAtendimentoForm
              ticketId={ticket.id}
              destinos={(destinos ?? []).map((d) => ({
                status: d.to_status,
                label: ticketStatusLabel[d.to_status] ?? d.to_status,
              }))}
            />
          </section>
        )}

        <section className="border-t border-[var(--color-border)] pt-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[var(--color-ink-3)]">Quem paga</dt>
            <dd className="text-right font-medium">{QUEM_PAGA[campo.billable_to]}</dd>
            <dt className="text-[var(--color-ink-3)]">Alocação</dt>
            <dd className="text-right font-medium">
              {campo.contract_item_id ? (
                <Link
                  href={'/locacao/contratos' as Route}
                  className="text-[var(--color-brand-ink)] hover:underline"
                >
                  em contrato
                </Link>
              ) : (
                'na base (sem contrato)'
              )}
            </dd>
            <dt className="text-[var(--color-ink-3)]">Chamado</dt>
            <dd className="text-right font-medium">
              <Link
                href={`/tickets/${ticket.id}` as Route}
                data-testid="ir-para-o-chamado"
                className="text-[var(--color-brand-ink)] hover:underline"
              >
                abrir #{ticket.ticket_number}
              </Link>
            </dd>
          </dl>
        </section>

        {podeAtender && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
              Tipo, pagador e alçada
            </h3>
            <EditarCampoForm
              ticketId={ticket.id}
              kind={campo.kind}
              billableTo={campo.billable_to}
              costLimit={campo.cost_limit === null ? null : Number(campo.cost_limit)}
            />
          </section>
        )}

        {ticket.description && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <p className="whitespace-pre-wrap text-sm text-[var(--color-ink-2)]">
              {ticket.description}
            </p>
          </section>
        )}
      </CorpoDaGaveta>
    </Gaveta>
  )
}
