import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { allowed, requireScreen } from '@/lib/session'
import { getAgents, getPriorities, getQueues } from '@/lib/data/lookups'
import { escopoDeCliente, porClienteOuGeral } from '@/lib/data/escopo'
import { lerPagina, paginar } from '@/lib/data/paginacao'
import { comParametros } from '@/lib/data/endereco'
import { ORDENS_DE_TICKET, lerOrdem, proximaDirecao } from '@/lib/data/ordenacao'
import { paraIlike } from '@/lib/data/ilike'
import { slaStateLabel, ticketStatusLabel } from '@/lib/i18n'
import { formatRelative, formatTimeRemaining } from '@/lib/format'
import type { EnrichedTicket, TicketStatus } from '@/lib/types'
import {
  ListaDeTickets,
  type CabecalhoOrdenavel,
  type TicketDaLista,
} from '@/components/lista-de-tickets'
import { FiltrosDeLista } from '@/components/filtros-de-lista'
import { GavetaDoChamado } from './gaveta-do-chamado'
import { EmptyState, PageHeader, Pager } from '@/components/ui'

export const metadata: Metadata = { title: 'Tickets' }

const OPEN_STATUSES: TicketStatus[] = [
  'open',
  'triage',
  'assigned',
  'in_progress',
  'waiting_requester',
  'waiting_third_party',
]

const EM_RISCO = ['warning', 'critical', 'breached']

/* A assinatura de índice é o que permite passar `params` inteiro para quem monta
   endereço sem copiar campo a campo — e é ela que faz um parâmetro novo chegar
   aos links de ordenação e paginação sem nenhuma alteração ali. */
interface Params extends Record<string, string | undefined> {
  status?: string
  fila?: string
  prioridade?: string
  atendente?: string
  sla?: string
  busca?: string
  /** O chamado aberto na gaveta, ao lado da lista. */
  aberto?: string
  ordem?: string
  dir?: string
  pagina?: string
}

/**
 * O mínimo que o construtor de consulta precisa expor para receber os filtros.
 *
 * Mesma conversão estrutural de `escopo.ts` e `paginacao.ts`, pelo mesmo
 * motivo: o tipo do `PostgrestFilterBuilder` é condicional sobre o schema
 * inteiro e atravessá-lo por um genérico estoura o compilador em `TS2589`.
 * Todos estes métodos devolvem `this` no postgrest-js, então a conversão
 * descreve o que de fato acontece em execução.
 */
interface Filtravel {
  eq(coluna: string, valor: unknown): Filtravel
  in(coluna: string, valores: readonly unknown[]): Filtravel
  is(coluna: string, valor: null): Filtravel
  ilike(coluna: string, padrao: string): Filtravel
}

/**
 * Os filtros da tela, num lugar só.
 *
 * Eles são aplicados tanto na consulta da lista quanto nas contagens das abas.
 * Escritos duas vezes, divergiriam: a aba diria "12" e a lista mostraria outra
 * coisa, e ninguém saberia qual das duas está certa.
 */
function aplicarFiltros<T>(consulta: T, p: Params, meuId: string): T {
  let q = consulta as Filtravel

  // "Em aberto" é o padrão: quem abre a tela quer trabalhar, não navegar
  // histórico.
  if (!p.status || p.status === 'abertos') q = q.in('status', OPEN_STATUSES)
  else if (p.status !== 'todos') q = q.eq('status', p.status)

  if (p.fila) q = q.eq('queue_slug', p.fila)
  if (p.prioridade) q = q.eq('priority_key', p.prioridade)
  if (p.busca) q = q.ilike('title', paraIlike(p.busca))

  if (p.atendente === 'eu') q = q.eq('assignee_id', meuId)
  else if (p.atendente === 'nenhum') q = q.is('assignee_id', null)
  else if (p.atendente) q = q.eq('assignee_id', p.atendente)

  if (p.sla === 'risco') q = q.in('resolution_state', EM_RISCO)

  return q as T
}

/**
 * As visões: a pergunta do dia a um clique de distância.
 *
 * Elas NÃO são um estado novo — cada aba é um conjunto de parâmetros normais na
 * URL. Isso tem três consequências que um `?visao=meus` não teria: a aba pode
 * ser combinada com qualquer filtro ("meus, da fila de infraestrutura"), o
 * endereço continua explicando a si mesmo, e não existe um segundo caminho de
 * filtragem no servidor para manter em dia com o primeiro.
 */
const VISOES: { chave: string; rotulo: string; params: Params }[] = [
  { chave: 'abertos', rotulo: 'Em aberto', params: {} },
  { chave: 'meus', rotulo: 'Meus', params: { atendente: 'eu' } },
  { chave: 'sem', rotulo: 'Sem atendente', params: { atendente: 'nenhum' } },
  { chave: 'risco', rotulo: 'SLA em risco', params: { sla: 'risco' } },
  { chave: 'todos', rotulo: 'Todos', params: { status: 'todos' } },
]

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<Params>
}) {
  const params = await searchParams
  const { profile } = await requireScreen('helpdesk.tickets.ver')

  const supabase = await createClient()
  const [queues, priorities, agents, escopo, podeAtribuir, podeStatus, podeTransferir] =
    await Promise.all([
      getQueues(),
      getPriorities(),
      getAgents(),
      escopoDeCliente(),
      allowed('helpdesk.tickets.atribuir'),
      allowed('helpdesk.tickets.mudar_status'),
      allowed('helpdesk.tickets.transferir'),
    ])

  const pagina = lerPagina(params.pagina)
  const ordem = lerOrdem(ORDENS_DE_TICKET, params.ordem, params.dir, 'score')

  /*
   * A máquina de estados inteira, numa consulta só.
   *
   * A edição na linha precisa saber, para CADA chamado, quais status o banco
   * aceita a partir do estado dele (ADR-007). Perguntar por linha seriam
   * cinquenta consultas; a tabela toda tem algumas dezenas de registros e cabe
   * num mapa. O que não dá é manter uma cópia da máquina de estados no
   * JavaScript: ela divergiria da trigger, e a tela ofereceria transições que
   * a escrita recusa.
   */
  const { data: transicoes } = await supabase
    .from('ticket_status_transitions')
    .select('from_status, to_status')
    .returns<{ from_status: TicketStatus; to_status: TicketStatus }[]>()

  const destinos = new Map<TicketStatus, TicketStatus[]>()
  for (const t of transicoes ?? []) {
    destinos.set(t.from_status, [...(destinos.get(t.from_status) ?? []), t.to_status])
  }

  const base = () =>
    porClienteOuGeral(supabase.from('vw_tickets_enriched').select('*', { count: 'exact' }), escopo)

  const query = aplicarFiltros(base(), params, profile.id)
    .order(ordem.coluna, { ascending: ordem.asc, nullsFirst: false })
    // Desempate estável: sem ele, dois tickets com o mesmo valor na coluna
    // ordenada podem trocar de lugar entre uma página e outra, e um deles
    // aparece duas vezes enquanto o outro não aparece nunca.
    .order('id')

  /*
   * As contagens das abas saem com `head: true`: o PostgREST devolve só o
   * número, sem uma linha de dado. São cinco viagens curtas ao banco em
   * paralelo, e é o que permite a aba dizer "8 sem atendente" sem que ninguém
   * precise clicar para descobrir.
   */
  const contagens = await Promise.all(
    VISOES.map(async (v) => {
      const { count } = await aplicarFiltros(
        porClienteOuGeral(
          supabase.from('vw_tickets_enriched').select('id', { count: 'exact', head: true }),
          escopo,
        ),
        { ...params, ...zerarVisao(), ...v.params },
        profile.id,
      )
      return count ?? 0
    }),
  )

  const { data, error, count } = await paginar(query, pagina).returns<EnrichedTicket[]>()
  const tickets = data ?? []
  const total = count ?? 0

  const visaoAtiva = qualVisao(params)

  const colunas: { chave: string | null; rotulo: string }[] = [
    { chave: 'numero', rotulo: '#' },
    { chave: 'titulo', rotulo: 'Título' },
    { chave: 'status', rotulo: 'Status' },
    { chave: 'prioridade', rotulo: 'Prioridade' },
    { chave: 'fila', rotulo: 'Fila' },
    { chave: 'atendente', rotulo: 'Atendente' },
    { chave: 'prazo', rotulo: 'Prazo' },
  ]

  const cabecalhos: CabecalhoOrdenavel[] = colunas.map((c) => ({
    chave: c.chave ?? c.rotulo,
    rotulo: c.rotulo,
    href: c.chave
      ? comParametros('/tickets', params, {
          ordem: c.chave,
          dir: proximaDirecao(ORDENS_DE_TICKET, ordem, c.chave),
        })
      : null,
    ativa: c.chave === ordem.chave,
    asc: c.chave === ordem.chave ? ordem.asc : true,
  }))

  const linhas: TicketDaLista[] = tickets.map((t) => ({
    id: t.id,
    numero: t.ticket_number,
    titulo: t.title,
    categoria: [t.category_parent_name, t.category_name ?? 'Sem categoria']
      .filter(Boolean)
      .join(' › '),
    abertura: `${formatRelative(t.created_at)}${t.branch_name ? ` · ${t.branch_name}` : ''}`,
    status: t.status,
    prioridadeLabel: t.priority_label,
    prioridadeCor: t.priority_color,
    fila: t.queue_name,
    filial: t.branch_name ?? '—',
    atendente: t.assignee_name,
    atendenteId: t.assignee_id,
    statusPossiveis: [
      { valor: t.status, rotulo: ticketStatusLabel[t.status] },
      ...(destinos.get(t.status) ?? []).map((s) => ({ valor: s, rotulo: ticketStatusLabel[s] })),
    ],
    slaEstado: t.resolution_state,
    slaRotulo: slaStateLabel[t.resolution_state ?? 'no_sla'],
    prazo: t.is_paused ? 'pausado' : formatTimeRemaining(t.minutes_to_resolution_due),
    atrasado: (t.minutes_to_resolution_due ?? 0) < 0,
  }))

  return (
    /* Com a gaveta aberta no computador, a tela ganha margem do tamanho dela:
       a gaveta é `fixed`, e sem a margem ela cobriria as últimas colunas da
       lista — justamente as de prazo, que é o que se está comparando. No
       celular não há margem, porque lá ela sobe por cima mesmo. */
    <div className={params.aberto ? 'lg:pr-[35rem]' : undefined}>
      {params.aberto && (
        <GavetaDoChamado
          id={params.aberto}
          fechar={comParametros('/tickets', params, {
            aberto: null,
            pagina: params.pagina ?? null,
          })}
        />
      )}

      <PageHeader
        title="Tickets"
        description={
          ordem.chave === 'score'
            ? 'Ordenados por score de priorização: criticidade, prazo de SLA e tempo de espera.'
            : 'Clique no cabeçalho de uma coluna para mudar a ordem.'
        }
        action={
          <Link
            href="/tickets/novo"
            className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
          >
            Abrir ticket
          </Link>
        }
      />

      <nav
        aria-label="Visões da lista"
        className="mb-3 flex gap-1 overflow-x-auto border-b border-[var(--color-border)]"
      >
        {VISOES.map((v, i) => {
          const ativa = v.chave === visaoAtiva
          return (
            <Link
              key={v.chave}
              href={comParametros('/tickets', params, { ...zerarVisao(), ...v.params }) as Route}
              aria-current={ativa ? 'page' : undefined}
              data-testid={`visao-${v.chave}`}
              className={`flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm ${
                ativa
                  ? 'border-[var(--color-brand)] font-semibold text-[var(--color-brand-ink)]'
                  : 'border-transparent text-[var(--color-ink-2)] hover:text-[var(--color-ink)]'
              }`}
            >
              {v.rotulo}
              <span
                className={`rounded-full px-1.5 text-xs tabular-nums ${
                  ativa
                    ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand-ink)]'
                    : 'bg-[var(--color-surface-3)] text-[var(--color-ink-2)]'
                }`}
              >
                {contagens[i]}
              </span>
            </Link>
          )
        })}
      </nav>

      <FiltrosDeLista
        base="/tickets"
        params={params}
        placeholder="Filtrar por título…"
        filtros={[
          {
            nome: 'status',
            rotulo: 'Status',
            valor: params.status ?? 'abertos',
            opcoes: [
              { valor: 'abertos', rotulo: 'Em aberto' },
              { valor: 'todos', rotulo: 'Todos' },
              ...Object.entries(ticketStatusLabel).map(([valor, rotulo]) => ({ valor, rotulo })),
            ],
          },
          {
            nome: 'fila',
            rotulo: 'Fila',
            valor: params.fila ?? '',
            opcoes: [
              { valor: '', rotulo: 'todas' },
              ...queues.map((q) => ({ valor: q.slug, rotulo: q.name })),
            ],
          },
          {
            nome: 'prioridade',
            rotulo: 'Prioridade',
            valor: params.prioridade ?? '',
            opcoes: [
              { valor: '', rotulo: 'todas' },
              ...priorities.map((p) => ({ valor: p.key, rotulo: p.label })),
            ],
          },
          {
            nome: 'atendente',
            rotulo: 'Atendente',
            valor: params.atendente ?? '',
            opcoes: [
              { valor: '', rotulo: 'todos' },
              { valor: 'eu', rotulo: 'eu' },
              { valor: 'nenhum', rotulo: 'sem atendente' },
              ...agents.map((a) => ({ valor: a.id, rotulo: a.full_name })),
            ],
          },
        ]}
      />

      {/* `error.message` NÃO entra aqui: numa falha de banco ele traz nome de
          tabela e de coluna, e quem está procurando um ticket não tem o que
          fazer com isso. Mesma regra de `mensagemDeErro` e de `error.tsx`. */}
      {error ? (
        <EmptyState
          title="Não foi possível carregar os tickets"
          description="Tente de novo em instantes. Se continuar, avise o suporte."
        />
      ) : tickets.length === 0 ? (
        <EmptyState
          title="Nenhum ticket encontrado"
          description="Ajuste os filtros ou abra um novo ticket."
          action={
            <Link
              href="/tickets"
              className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold"
            >
              Limpar os filtros
            </Link>
          }
        />
      ) : (
        <>
          {/* A `key` deriva da consulta: trocou o filtro, a ordem ou a página,
              o React monta a lista de novo e cursor e seleção nascem limpos.
              Sem isso seria preciso um efeito zerando estado — mais código para
              o mesmo fim, e um que se esquece de zerar o campo novo. */}
          <ListaDeTickets
            key={`${visaoAtiva}|${params.status ?? ''}|${params.fila ?? ''}|${params.prioridade ?? ''}|${params.atendente ?? ''}|${params.sla ?? ''}|${params.busca ?? ''}|${ordem.chave}|${ordem.asc}|${pagina.numero}`}
            tickets={linhas}
            cabecalhos={cabecalhos}
            atendentes={agents.map((a) => ({ valor: a.id, rotulo: a.full_name }))}
            filas={queues.map((q) => ({ valor: q.id, rotulo: q.name }))}
            permissoes={{
              atribuir: podeAtribuir,
              status: podeStatus,
              transferir: podeTransferir,
            }}
            base="/tickets"
            params={params}
            aberto={params.aberto ?? null}
          />
          <Pager
            pagina={pagina.numero}
            total={total}
            tamanho={pagina.tamanho}
            base="/tickets"
            params={params}
          />
        </>
      )}
    </div>
  )
}

/** Os parâmetros que uma aba redefine. Trocar de aba não herda a aba anterior. */
function zerarVisao(): Params {
  return { status: undefined, atendente: undefined, sla: undefined }
}

/** Qual aba está acesa, deduzida dos parâmetros — não há estado paralelo. */
function qualVisao(p: Params): string {
  if (p.sla === 'risco') return 'risco'
  if (p.atendente === 'eu') return 'meus'
  if (p.atendente === 'nenhum') return 'sem'
  if (p.status === 'todos') return 'todos'
  if (!p.status || p.status === 'abertos') return 'abertos'
  return ''
}
