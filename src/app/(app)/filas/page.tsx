import { Fragment } from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { escopoDeCliente, porClienteOuGeral } from '@/lib/data/escopo'
import { requireScreen, allowed } from '@/lib/session'
import { getBranches } from '@/lib/data/lookups'
import type { EnrichedTicket, Queue, QueueRule } from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader, Table, Td } from '@/components/ui'
import { EditPanel } from '@/components/edit-panel'
import {
  EditRuleForm,
  NewRuleForm,
  type CategoryOption,
  type PriorityOption,
  type QueueOption,
} from './rule-forms'
import { EditQueueForm, NewQueueForm } from './queue-forms'

/**
 * Origens aceitas na condição de roteamento.
 *
 * Lista fechada e curta de propósito: `tickets.source_system` é texto livre, mas
 * oferecer um campo aberto aqui criaria regra que depende de alguém digitar
 * exatamente o mesmo valor que a integração grava — e um acento de diferença
 * faria a regra nunca casar, em silêncio.
 */
const ORIGENS = ['bitrix24', 'api', 'email'] as const

export const metadata: Metadata = { title: 'Filas' }

export default async function FilasPage() {
  await requireScreen('helpdesk.filas.ver')
  const [podeConfigurar, podeCriarFila, podeEditarFila, podeInativarFila] = await Promise.all([
    allowed('helpdesk.filas.configurar_regras'),
    allowed('helpdesk.filas.criar'),
    allowed('helpdesk.filas.editar'),
    allowed('helpdesk.filas.inativar'),
  ])
  const supabase = await createClient()
  const escopo = await escopoDeCliente()

  const [
    { data: queues }, { data: openTickets }, { data: rules },
    { data: categories }, { data: priorities }, branches,
  ] = await Promise.all([
    supabase
      .from('queues')
      .select(
        'id, name, slug, description, is_system_default, is_active, weight_criticality, weight_deadline, weight_age',
      )
      .is('deleted_at', null)
      /* Inativas continuam na lista, marcadas: some-las esconderia justamente a
         fila que alguém precisa reativar, e os tickets que ficaram nela. */
      .order('is_system_default', { ascending: false })
      .order('name')
      .returns<Queue[]>(),
    // Uma consulta só, agregada em memória: são poucas filas, e assim evitamos
    // N+1 (uma contagem por fila) que o dashboard pagaria a cada refresh.
    /* A FILA em si não é do cliente — é estrutura de atendimento do tenant, e
       por isso `queues` e `queue_rules` ficam de fora do foco. O que entra é a
       contagem de tickets, para que o número ao lado do nome da fila conte a
       mesma história que a lista de /tickets. */
    porClienteOuGeral(
      supabase
        .from('vw_tickets_enriched')
        .select('queue_slug, resolution_state, priority_weight')
        .not('status', 'in', '("resolved","closed")'),
      escopo,
    ).returns<Pick<EnrichedTicket, 'queue_slug' | 'resolution_state' | 'priority_weight'>[]>(),
    /* A lista de regras aparece para quem tem `helpdesk.filas.ver`: saber por que
       o seu ticket caiu nesta fila é informação de trabalho, não configuração.
       Só os controles de escrita exigem `configurar_regras`. */
    supabase
      .from('queue_rules')
      .select('id, queue_id, name, conditions, sort_order, is_active')
      .order('sort_order')
      .returns<QueueRule[]>(),
    supabase
      .from('ticket_categories')
      .select('id, name, parent_id')
      .eq('is_active', true)
      .order('name')
      .returns<CategoryOption[]>(),
    supabase
      .from('ticket_priorities')
      .select('key, label')
      .eq('is_active', true)
      .order('sort_order')
      .returns<PriorityOption[]>(),
    getBranches(),
  ])

  const tickets = openTickets ?? []
  const listaRegras = rules ?? []
  const listaFilas = queues ?? []
  const filas: QueueOption[] = listaFilas.map((q) => ({ id: q.id, name: q.name }))
  const abrePainelFila = podeEditarFila || podeInativarFila
  const lookups = {
    queues: filas,
    categories: categories ?? [],
    priorities: priorities ?? [],
    branches,
    sources: [...ORIGENS],
  }
  const nomeFila = new Map(filas.map((q) => [q.id, q.name]))
  const nomeCategoria = new Map((categories ?? []).map((c) => [c.id, c.name]))
  const nomeFilial = new Map(branches.map((b) => [b.id, b.name]))
  const rotuloPrioridade = new Map((priorities ?? []).map((p) => [p.key, p.label]))

  /** As condições em linguagem de gente, na ordem em que a função as avalia. */
  const descreve = (r: QueueRule) => {
    const partes: string[] = []
    if (r.conditions.category_id) {
      partes.push(`categoria ${nomeCategoria.get(r.conditions.category_id) ?? '—'} (ou filha)`)
    }
    if (r.conditions.priority_key) {
      partes.push(`prioridade ${rotuloPrioridade.get(r.conditions.priority_key) ?? r.conditions.priority_key}`)
    }
    if (r.conditions.branch_id) {
      partes.push(`filial ${nomeFilial.get(r.conditions.branch_id) ?? '—'}`)
    }
    if (r.conditions.source_system) partes.push(`origem ${r.conditions.source_system}`)
    return partes.length > 0 ? partes.join(' e ') : 'sem condição — não roteia nada'
  }

  return (
    <>
      <PageHeader
        title="Filas"
        description="Cada fila ordena por score: criticidade, urgência de prazo e tempo de espera."
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {listaFilas.map((q) => {
          const inQueue = tickets.filter((t) => t.queue_slug === q.slug)
          const breached = inQueue.filter((t) => t.resolution_state === 'breached').length
          const atRisk = inQueue.filter((t) =>
            ['warning', 'critical'].includes(t.resolution_state ?? ''),
          ).length
          const critical = inQueue.filter((t) => t.priority_weight >= 80).length

          return (
            <Card key={q.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/filas/${q.slug}` as Route}
                    className="text-base font-semibold text-[var(--color-brand-ink)] hover:underline"
                  >
                    {q.name}
                  </Link>
                  {q.description && (
                    <p className="mt-0.5 text-xs text-[var(--color-ink-3)]">{q.description}</p>
                  )}
                </div>
                <span className="flex flex-none gap-1.5">
                  {q.is_system_default && <Badge tone="info">Padrão</Badge>}
                  {!q.is_active && <Badge>Inativa</Badge>}
                </span>
              </div>

              <p className="mt-4 text-3xl font-bold tabular-nums text-[var(--color-ink)]">
                {inQueue.length}
                <span className="ml-1.5 text-sm font-medium text-[var(--color-ink-3)]">
                  em aberto
                </span>
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                {breached > 0 && <Badge tone="breach">{breached} estourado(s)</Badge>}
                {atRisk > 0 && <Badge tone="warn">{atRisk} em risco</Badge>}
                {critical > 0 && <Badge tone="crit">{critical} crítico(s)</Badge>}
                {breached === 0 && atRisk === 0 && <Badge tone="ok">Prazos sob controle</Badge>}
              </div>

              {/* Os pesos ficam à vista: é a única coisa que distingue duas filas
                  com a mesma lista de tickets, e até aqui só existiam no banco. */}
              <p className="mt-3 text-xs text-[var(--color-ink-3)]">
                Score: criticidade {q.weight_criticality} · prazo {q.weight_deadline} · espera{' '}
                {q.weight_age}
              </p>

              {abrePainelFila && (
                <div className="mt-3">
                  <EditPanel title={`Editar ${q.name}`}>
                    <EditQueueForm queue={q} podeInativar={podeInativarFila} />
                  </EditPanel>
                </div>
              )}
            </Card>
          )
        })}
      </div>

      {podeCriarFila && (
        <div className="mt-6 max-w-2xl">
          <Card title="Nova fila">
            <NewQueueForm />
          </Card>
        </div>
      )}

      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-[var(--color-ink)]">
            Regras de roteamento
          </h2>
          <span className="text-sm text-[var(--color-ink-3)]">
            {listaRegras.filter((r) => r.is_active).length} ativa(s) de {listaRegras.length}
          </span>
        </div>

        <p className="mb-3 max-w-[70ch] text-sm text-[var(--color-ink-2)]">
          Ao criar um ticket <strong>sem fila escolhida</strong>, a primeira regra ativa que
          casar decide o destino. Nenhuma casando, o ticket vai para a fila padrão. Quem
          escolhe a fila na tela manda — a regra não sobrepõe escolha explícita.
        </p>

        {listaRegras.length > 0 ? (
          <Table head={['Ordem', 'Regra', 'Quando', 'Vai para', 'Situação']}>
            {listaRegras.map((r) => (
              <Fragment key={r.id}>
                <tr>
                  <Td className="tabular-nums text-[var(--color-ink-3)]">{r.sort_order}</Td>
                  <Td className="font-medium text-[var(--color-ink)]">{r.name}</Td>
                  <Td className="text-[var(--color-ink-2)]">{descreve(r)}</Td>
                  <Td className="text-[var(--color-ink-2)]">{nomeFila.get(r.queue_id) ?? '—'}</Td>
                  <Td>
                    {r.is_active ? <Badge tone="ok">Ativa</Badge> : <Badge>Desativada</Badge>}
                  </Td>
                </tr>
                {podeConfigurar && (
                  <tr>
                    <Td className="bg-[var(--color-surface-2)]" colSpan={5}>
                      <EditPanel title={`Editar ${r.name}`}>
                        <EditRuleForm rule={r} {...lookups} />
                      </EditPanel>
                    </Td>
                  </tr>
                )}
              </Fragment>
            ))}
          </Table>
        ) : (
          <EmptyState
            title="Nenhuma regra de roteamento"
            description="Sem regra, todo ticket sem fila escolhida cai na fila padrão."
          />
        )}

        {podeConfigurar && (
          <div className="mt-4 max-w-2xl">
            <Card title="Nova regra">
              <NewRuleForm {...lookups} />
            </Card>
          </div>
        )}
      </section>
    </>
  )
}
