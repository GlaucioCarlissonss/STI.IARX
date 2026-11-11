import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { comParametros } from '@/lib/data/endereco'
import { formatCurrency, formatDate } from '@/lib/format'
import { ticketStatusLabel } from '@/lib/i18n'
import type { FieldServiceCost, FieldServiceKind, TicketStatus } from '@/lib/types'
import { Badge, EmptyState, FaixaDeIndicadores, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { FiltrosDeLista } from '@/components/filtros-de-lista'
import { situacaoDaAlcada, TIPO_DO_ATENDIMENTO } from '@/lib/locacao/rotulos'
import { GavetaDeManutencao } from './gaveta'

export const metadata: Metadata = { title: 'Manutenção em campo' }

const ABERTOS: TicketStatus[] = [
  'open',
  'triage',
  'assigned',
  'in_progress',
  'waiting_requester',
  'waiting_third_party',
  'waiting_approval',
]

export default async function ManutencaoPage({
  searchParams,
}: {
  searchParams: Promise<{
    tipo?: string
    situacao?: string
    busca?: string
    aberto?: string
    novo?: string
  }>
}) {
  const params = await searchParams
  await requireScreen('locacao.manutencao.ver')
  const podeAbrir = await allowed('locacao.manutencao.abrir')

  const supabase = await createClient()

  /*
   * A extensão de campo é a LISTA; o chamado é o detalhe que a acompanha.
   *
   * Na direção inversa — partir de `tickets` e filtrar pela fila de campo — a
   * lista passaria a depender de um chamado estar na fila certa, e um chamado
   * movido de fila por engano sumiria daqui enquanto continua sendo um
   * atendimento de campo. O vínculo é a tabela 1:1, e não o nome da fila.
   */
  const { data: campos } = await supabase
    .from('ticket_field_service')
    .select(
      'ticket_id, equipment_id, contract_item_id, kind, cost_limit, approved_at, billable_to',
    )
    .returns<
      {
        ticket_id: string
        equipment_id: string
        contract_item_id: string | null
        kind: FieldServiceKind
        cost_limit: number | null
        approved_at: string | null
        billable_to: 'provider' | 'client'
      }[]
    >()

  const base = campos ?? []
  const ids = base.map((c) => c.ticket_id)
  const equipIds = [...new Set(base.map((c) => c.equipment_id))]

  const [{ data: tickets }, { data: custos }, { data: equipamentos }] = await Promise.all([
    ids.length
      ? supabase
          .from('tickets')
          .select('id, ticket_number, title, status, created_at')
          .in('id', ids)
          .is('deleted_at', null)
          .returns<
            { id: string; ticket_number: number; title: string; status: TicketStatus; created_at: string }[]
          >()
      : Promise.resolve({ data: [] }),
    ids.length
      ? supabase
          .from('vw_field_service_cost')
          .select('ticket_id, labor_cost, parts_cost, total_cost, total_hours')
          .in('ticket_id', ids)
          .returns<FieldServiceCost[]>()
      : Promise.resolve({ data: [] }),
    equipIds.length
      ? supabase
          .from('rental_equipment')
          .select('id, asset_tag')
          .in('id', equipIds)
          .returns<{ id: string; asset_tag: string }[]>()
      : Promise.resolve({ data: [] }),
  ])

  const porTicket = new Map((tickets ?? []).map((t) => [t.id, t]))
  const porCusto = new Map((custos ?? []).map((c) => [c.ticket_id, c]))
  const tag = new Map((equipamentos ?? []).map((e) => [e.id, e.asset_tag]))

  const linhas = base
    .map((c) => {
      const t = porTicket.get(c.ticket_id)
      if (!t) return null
      const total = Number(porCusto.get(c.ticket_id)?.total_cost ?? 0)
      return {
        ...c,
        numero: t.ticket_number,
        titulo: t.title,
        status: t.status,
        abertoEm: t.created_at,
        etiqueta: tag.get(c.equipment_id) ?? 'equipamento removido',
        total,
        alcada: situacaoDaAlcada(c.cost_limit, total, c.approved_at),
      }
    })
    .filter((l): l is NonNullable<typeof l> => l !== null)
    .sort((a, b) => b.numero - a.numero)

  const termo = params.busca?.trim().toLowerCase() ?? ''
  const filtrada = linhas.filter((l) => {
    if (params.tipo && l.kind !== params.tipo) return false
    if (params.situacao === 'abertos' && !ABERTOS.includes(l.status)) return false
    if (params.situacao === 'fechados' && ABERTOS.includes(l.status)) return false
    if (params.situacao === 'travados' && l.alcada.estado !== 'estourou') return false
    if (termo) {
      const alvo = `#${l.numero} ${l.titulo} ${l.etiqueta}`.toLowerCase()
      if (!alvo.includes(termo)) return false
    }
    return true
  })

  const abertos = linhas.filter((l) => ABERTOS.includes(l.status))
  const travados = linhas.filter((l) => l.alcada.estado === 'estourou')
  const custoAberto = abertos.reduce((s, l) => s + l.total, 0)
  const doCliente = linhas.filter((l) => l.billable_to === 'client')

  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/locacao/manutencao', params, mudancas)
  const gavetaAberta = Boolean(params.aberto || params.novo)

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && (
        <GavetaDeManutencao
          id={params.aberto}
          novo={Boolean(params.novo)}
          fechar={endereco({ aberto: null, novo: null })}
        />
      )}

      <PageHeader
        title="Manutenção em campo"
        description="A ordem de serviço da locação é um chamado, em fila própria — com apontamento de horas, peça consumida e alçada de custo. “O que está aberto” continua tendo um lugar só."
        action={
          podeAbrir && (
            <Link
              href={endereco({ novo: '1', aberto: null }) as Route}
              data-testid="novo-registro"
              className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
            >
              Abrir atendimento
            </Link>
          )
        }
      />

      <FaixaDeIndicadores>
        <StatTile label="Em aberto" value={abertos.length} hint="atendimentos não concluídos" />
        <StatTile
          label="Travados na alçada"
          value={travados.length}
          hint="custo acima do teto, sem aprovação"
          tone={travados.length > 0 ? 'crit' : 'ok'}
        />
        <StatTile
          label="Custo em aberto"
          value={formatCurrency(custoAberto)}
          hint="mão de obra + peças do que está aberto"
        />
        <StatTile
          label="A cobrar do cliente"
          value={doCliente.length}
          hint="mau uso ou fora do contrato"
          tone={doCliente.length > 0 ? 'warn' : 'neutral'}
        />
      </FaixaDeIndicadores>

      <FiltrosDeLista
        base="/locacao/manutencao"
        params={params}
        placeholder="Número, título ou patrimônio…"
        filtros={[
          {
            nome: 'tipo',
            rotulo: 'Tipo',
            valor: params.tipo ?? '',
            opcoes: [
              { valor: '', rotulo: 'Qualquer tipo' },
              ...(Object.keys(TIPO_DO_ATENDIMENTO) as FieldServiceKind[]).map((k) => ({
                valor: k,
                rotulo: TIPO_DO_ATENDIMENTO[k].label,
              })),
            ],
          },
          {
            nome: 'situacao',
            rotulo: 'Situação',
            valor: params.situacao ?? '',
            opcoes: [
              { valor: '', rotulo: 'Qualquer situação' },
              { valor: 'abertos', rotulo: 'Em aberto' },
              { valor: 'travados', rotulo: 'Travados na alçada' },
              { valor: 'fechados', rotulo: 'Concluídos' },
            ],
          },
        ]}
      />

      {filtrada.length === 0 ? (
        <EmptyState
          title={linhas.length === 0 ? 'Nenhum atendimento de campo' : 'Nada com esse recorte'}
          description={
            linhas.length === 0
              ? 'Abra o primeiro: ele nasce como chamado na fila de campo, e o custo passa a ser a soma do que for apontado.'
              : 'Troque o tipo ou a situação.'
          }
        />
      ) : (
        <Table
          label="Atendimentos de campo"
          head={['Nº', 'Atendimento', 'Equipamento', 'Tipo', 'Aberto em', 'Custo', 'Situação']}
        >
          {filtrada.map((l) => {
            const tipo = TIPO_DO_ATENDIMENTO[l.kind]
            return (
              <tr key={l.ticket_id}>
                <Td className="font-mono text-xs">
                  <Link
                    href={endereco({ aberto: l.ticket_id, novo: null }) as Route}
                    data-testid="abrir-registro"
                    className="font-semibold text-[var(--color-brand-ink)] hover:underline"
                  >
                    #{l.numero}
                  </Link>
                </Td>
                <Td className="font-medium text-[var(--color-ink)]">{l.titulo}</Td>
                <Td className="font-mono text-xs text-[var(--color-ink-2)]">{l.etiqueta}</Td>
                <Td>
                  <Badge tone={tipo.tone}>{tipo.label}</Badge>
                </Td>
                <Td className="tabular-nums text-[var(--color-ink-2)]">{formatDate(l.abertoEm)}</Td>
                <Td className="tabular-nums font-medium">{formatCurrency(l.total)}</Td>
                <Td>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="info">{ticketStatusLabel[l.status]}</Badge>
                    {l.alcada.estado === 'estourou' && (
                      <Badge tone="breach" testid="selo-de-alcada">
                        acima da alçada
                      </Badge>
                    )}
                    {l.alcada.estado === 'aprovado' && <Badge tone="ok">custo aprovado</Badge>}
                    {l.billable_to === 'client' && <Badge tone="warn">cobrar do cliente</Badge>}
                  </span>
                </Td>
              </tr>
            )
          })}
        </Table>
      )}
    </div>
  )
}
