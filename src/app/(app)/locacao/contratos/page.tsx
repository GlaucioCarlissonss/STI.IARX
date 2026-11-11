import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { getClients } from '@/lib/data/lookups'
import { comParametros } from '@/lib/data/endereco'
import { formatCurrency, formatDate } from '@/lib/format'
import type { RentalAllocation, RentalContract } from '@/lib/types'
import { Badge, EmptyState, FaixaDeIndicadores, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { FiltrosDeLista } from '@/components/filtros-de-lista'
import { ESTADO_DO_CONTRATO } from '@/lib/locacao/rotulos'
import { GavetaDeContrato } from './gaveta'

export const metadata: Metadata = { title: 'Contratos de locação' }

/** Vence em até 60 dias: é a janela em que renovar ainda é decisão, e não corrida. */
const DIAS_DE_AVISO = 60

export default async function ContratosPage({
  searchParams,
}: {
  searchParams: Promise<{
    estado?: string
    cliente?: string
    busca?: string
    aberto?: string
    novo?: string
  }>
}) {
  const params = await searchParams
  await requireScreen('locacao.contratos.ver')
  const podeCriar = await allowed('locacao.contratos.criar')

  const supabase = await createClient()
  const [{ data: contratos }, { data: alocacoes }, clientes] = await Promise.all([
    supabase
      .from('rental_contracts')
      .select(
        'id, client_id, code, status, starts_on, ends_on, billing_day, default_franchise, default_excess_price, adjustment_index, adjustment_month, notes',
      )
      .is('deleted_at', null)
      .order('code', { ascending: false })
      .returns<RentalContract[]>(),
    supabase
      .from('vw_rental_allocations')
      .select(
        'id, contract_id, contract_code, contract_status, client_id, equipment_id, asset_tag, equipment_status, meter_kind, meter_reading, model_name, operation_location_id, location_name, status, monthly_price, franchise, excess_price, delivered_on, returned_on, meter_at_delivery, meter_at_return',
      )
      .returns<RentalAllocation[]>(),
    getClients(),
  ])

  const lista = contratos ?? []
  const clientePorId = new Map(clientes.map((c) => [c.id, c.trade_name ?? c.legal_name]))

  /* Itens VIVOS por contrato: reservado e entregue. Devolvido e cancelado são
     história, e contá-los faria o recorrente de um contrato crescer a cada
     troca de equipamento. */
  const vivasPorContrato = new Map<string, RentalAllocation[]>()
  for (const a of alocacoes ?? []) {
    if (a.status !== 'reserved' && a.status !== 'delivered') continue
    vivasPorContrato.set(a.contract_id, [...(vivasPorContrato.get(a.contract_id) ?? []), a])
  }

  const hoje = new Date()
  const limite = new Date(hoje.getTime() + DIAS_DE_AVISO * 86400000)
  const venceEmBreve = (c: RentalContract) =>
    c.status === 'active' && c.ends_on !== null && new Date(`${c.ends_on}T00:00:00`) <= limite

  const termo = params.busca?.trim().toLowerCase() ?? ''
  const filtrada = lista.filter((c) => {
    if (params.estado === 'vencendo' ? !venceEmBreve(c) : params.estado && c.status !== params.estado) {
      return false
    }
    if (params.cliente && c.client_id !== params.cliente) return false
    if (termo) {
      const alvo = `${c.code} ${clientePorId.get(c.client_id) ?? ''}`.toLowerCase()
      if (!alvo.includes(termo)) return false
    }
    return true
  })

  const ativos = lista.filter((c) => c.status === 'active')
  const recorrente = ativos.reduce(
    (s, c) => s + (vivasPorContrato.get(c.id) ?? []).reduce((t, a) => t + Number(a.monthly_price), 0),
    0,
  )
  const emOperacao = (alocacoes ?? []).filter((a) => a.status === 'delivered').length
  const aExpedir = (alocacoes ?? []).filter((a) => a.status === 'reserved').length

  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/locacao/contratos', params, mudancas)
  const gavetaAberta = Boolean(params.aberto || params.novo)

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && (
        <GavetaDeContrato
          id={params.aberto}
          novo={Boolean(params.novo)}
          fechar={endereco({ aberto: null, novo: null })}
        />
      )}

      <PageHeader
        title="Contratos de locação"
        description="Cada contrato aloca equipamentos a um local do cliente e define como o consumo vira cobrança: preço acordado, franquia e excedente."
        action={
          podeCriar && (
            <Link
              href={endereco({ novo: '1', aberto: null }) as Route}
              data-testid="novo-registro"
              className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
            >
              Novo contrato
            </Link>
          )
        }
      />

      <FaixaDeIndicadores>
        <StatTile label="Contratos ativos" value={ativos.length} hint={`${emOperacao} itens em operação`} tone="ok" />
        <StatTile
          label="Vencendo em 60 dias"
          value={lista.filter(venceEmBreve).length}
          hint="renovação ou devolução"
          tone={lista.filter(venceEmBreve).length > 0 ? 'warn' : 'neutral'}
        />
        <StatTile label="Recorrente mensal" value={formatCurrency(recorrente)} hint="soma dos itens vivos" />
        <StatTile
          label="A expedir"
          value={aExpedir}
          hint="reservado e ainda na base"
          tone={aExpedir > 0 ? 'warn' : 'neutral'}
        />
      </FaixaDeIndicadores>

      <FiltrosDeLista
        base="/locacao/contratos"
        params={params}
        placeholder="Número do contrato ou cliente…"
        filtros={[
          {
            nome: 'estado',
            rotulo: 'Estado',
            valor: params.estado ?? '',
            opcoes: [
              { valor: '', rotulo: 'Qualquer estado' },
              ...(Object.keys(ESTADO_DO_CONTRATO) as (keyof typeof ESTADO_DO_CONTRATO)[]).map(
                (s) => ({ valor: s, rotulo: ESTADO_DO_CONTRATO[s].label }),
              ),
              { valor: 'vencendo', rotulo: 'Vencendo em 60 dias' },
            ],
          },
          {
            nome: 'cliente',
            rotulo: 'Cliente',
            valor: params.cliente ?? '',
            opcoes: [
              { valor: '', rotulo: 'Qualquer cliente' },
              ...clientes.map((c) => ({ valor: c.id, rotulo: c.trade_name ?? c.legal_name })),
            ],
          },
        ]}
      />

      {filtrada.length === 0 ? (
        <EmptyState
          title={lista.length === 0 ? 'Nenhum contrato de locação' : 'Nada com esse recorte'}
          description={
            lista.length === 0
              ? 'O contrato é o que tira o equipamento da base alocável e o põe em operação — e é dele que sai a fatura.'
              : 'Troque o estado ou o cliente para ver outros contratos.'
          }
        />
      ) : (
        <Table
          label="Contratos de locação"
          head={['Contrato', 'Cliente', 'Vigência', 'Itens', 'Mensal', 'Estado']}
        >
          {filtrada.map((c) => {
            const vivas = vivasPorContrato.get(c.id) ?? []
            const mensal = vivas.reduce((s, a) => s + Number(a.monthly_price), 0)
            const estado = ESTADO_DO_CONTRATO[c.status]
            return (
              <tr key={c.id}>
                <Td className="font-mono text-xs">
                  <Link
                    href={endereco({ aberto: c.id, novo: null }) as Route}
                    data-testid="abrir-registro"
                    className="font-semibold text-[var(--color-brand-ink)] hover:underline"
                  >
                    {c.code}
                  </Link>
                </Td>
                <Td className="font-medium text-[var(--color-ink)]">
                  {clientePorId.get(c.client_id) ?? 'cliente removido'}
                </Td>
                <Td className="tabular-nums text-[var(--color-ink-2)]">
                  {formatDate(c.starts_on)} → {c.ends_on ? formatDate(c.ends_on) : 'indeterminado'}
                </Td>
                <Td className="tabular-nums">{vivas.length}</Td>
                <Td className="tabular-nums">{formatCurrency(mensal)}</Td>
                <Td>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={estado.tone}>{estado.label}</Badge>
                    {venceEmBreve(c) && <Badge tone="warn">vence em breve</Badge>}
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
