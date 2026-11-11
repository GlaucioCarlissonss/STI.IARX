import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { comParametros } from '@/lib/data/endereco'
import { formatDate } from '@/lib/format'
import type {
  EquipmentCategory,
  EquipmentModel,
  RentalDepot,
  RentalEquipment,
} from '@/lib/types'
import { Badge, EmptyState, FaixaDeIndicadores, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { ESTADO_DO_EQUIPAMENTO, ESTADOS_NA_ORDEM, formatarMedidor } from '@/lib/locacao/rotulos'
import { FiltrosDeLista } from '@/components/filtros-de-lista'
import { GavetaDeEquipamento } from './gaveta'

export const metadata: Metadata = { title: 'Frota' }

/**
 * A frota de locação.
 *
 * ## Por que o bloqueio aparece ao lado do estado, e não no lugar dele
 *
 * Porque são fatos diferentes. O estado diz onde a máquina está no ciclo;
 * o bloqueio diz "não aloque". Uma peça **locada e bloqueada** é comum —
 * preventiva vencida em equipamento que continua faturando no cliente — e
 * mostrar só um dos dois esconderia metade da verdade de quem vai decidir o
 * próximo contrato.
 *
 * ## Por que não há coluna de cliente
 *
 * Porque nesta fase não há contrato: nada pode estar locado. A coluna
 * existiria vazia em todas as linhas, anunciando um dado que o sistema ainda
 * não tem como produzir. Ela chega na Fase 3, junto com a alocação que a
 * preenche.
 */
export default async function FrotaPage({
  searchParams,
}: {
  searchParams: Promise<{
    estado?: string
    categoria?: string
    deposito?: string
    busca?: string
    aberto?: string
    novo?: string
  }>
}) {
  const params = await searchParams
  await requireScreen('locacao.frota.ver')
  const [podeCriar] = await Promise.all([allowed('locacao.frota.criar')])

  const supabase = await createClient()
  const [{ data: equipamentos }, { data: modelos }, { data: categorias }, { data: depositos }] =
    await Promise.all([
      supabase
        .from('rental_equipment')
        .select(
          'id, asset_tag, serial_number, model_id, depot_id, status, blocked, block_reason, block_until, meter_kind, meter_reading, meter_read_at, acquisition_date, acquisition_value, invoice_ref, useful_life_months, notes',
        )
        .is('deleted_at', null)
        .order('asset_tag')
        .returns<RentalEquipment[]>(),
      supabase
        .from('equipment_models')
        .select('id, manufacturer_id, category_id, code, name, specs, monthly_price, daily_price, is_active')
        .is('deleted_at', null)
        .order('name')
        .returns<EquipmentModel[]>(),
      supabase
        .from('equipment_categories')
        .select('id, code, name, default_meter_kind, default_useful_life_months, is_active')
        .is('deleted_at', null)
        .order('name')
        .returns<EquipmentCategory[]>(),
      supabase
        .from('rental_depots')
        .select('id, name, code, kind, city, state, is_active')
        .is('deleted_at', null)
        .order('name')
        .returns<RentalDepot[]>(),
    ])

  const lista = equipamentos ?? []
  const modeloPorId = new Map((modelos ?? []).map((m) => [m.id, m]))
  const categoriaPorId = new Map((categorias ?? []).map((c) => [c.id, c]))
  const depositoPorId = new Map((depositos ?? []).map((d) => [d.id, d]))

  const categoriaDe = (e: RentalEquipment) => {
    const modelo = modeloPorId.get(e.model_id)
    return modelo ? categoriaPorId.get(modelo.category_id) : undefined
  }

  /*
   * O filtro roda em memória, e isso é escolha de tamanho, não de preguiça: a
   * frota de uma operação de locação é de centenas de peças, não de milhões, e
   * a tela já precisa dos modelos e categorias inteiros para montar os nomes.
   * Filtrar no banco exigiria um `join` por filtro e devolveria a mesma coisa.
   */
  const termo = params.busca?.trim().toLowerCase() ?? ''
  const filtrada = lista.filter((e) => {
    if (params.estado === 'bloqueado' ? !e.blocked : params.estado && e.status !== params.estado) {
      return false
    }
    if (params.categoria && categoriaDe(e)?.id !== params.categoria) return false
    if (params.deposito && e.depot_id !== params.deposito) return false
    if (termo) {
      const modelo = modeloPorId.get(e.model_id)
      const alvo = `${e.asset_tag} ${e.serial_number ?? ''} ${modelo?.name ?? ''}`.toLowerCase()
      if (!alvo.includes(termo)) return false
    }
    return true
  })

  const porEstado = (s: string) => lista.filter((e) => e.status === s).length
  const bloqueados = lista.filter((e) => e.blocked).length
  const perdidos = lista.filter((e) => e.status === 'lost' || e.status === 'written_off').length

  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/locacao/frota', params, mudancas)
  const gavetaAberta = Boolean(params.aberto || params.novo)

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && (
        <GavetaDeEquipamento
          id={params.aberto}
          novo={Boolean(params.novo)}
          fechar={endereco({ aberto: null, novo: null })}
        />
      )}

      <PageHeader
        title="Frota"
        description="O equipamento próprio destinado a locar: onde está, em que estado, e o que já aconteceu com ele."
        action={
          podeCriar && (
            <Link
              href={endereco({ novo: '1', aberto: null }) as Route}
              data-testid="novo-registro"
              className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
            >
              Novo equipamento
            </Link>
          )
        }
      />

      <FaixaDeIndicadores>
        <StatTile
          label="Disponível"
          value={porEstado('available')}
          hint="na base alocável"
          tone="ok"
        />
        <StatTile label="Em operação" value={porEstado('rented')} hint="locado em cliente" />
        <StatTile
          label="Em manutenção"
          value={porEstado('maintenance') + porEstado('inspection')}
          hint="oficina e inspeção"
          tone="warn"
        />
        <StatTile
          label="Fora da base alocável"
          value={bloqueados + perdidos}
          hint={`${bloqueados} bloqueado(s) · ${perdidos} perdido(s) ou baixado(s)`}
          tone={bloqueados + perdidos > 0 ? 'breach' : 'neutral'}
        />
      </FaixaDeIndicadores>

      {/* O mesmo componente da lista de chamados, e não uma segunda barra de
          filtros: o comportamento (navegar na hora, atraso só no texto, estado
          no endereço) já foi decidido uma vez. */}
      <FiltrosDeLista
        base="/locacao/frota"
        params={params}
        placeholder="Patrimônio, série ou modelo…"
        filtros={[
          {
            nome: 'estado',
            rotulo: 'Estado',
            valor: params.estado ?? '',
            opcoes: [
              { valor: '', rotulo: 'Qualquer estado' },
              ...ESTADOS_NA_ORDEM.map((s) => ({
                valor: s,
                rotulo: ESTADO_DO_EQUIPAMENTO[s].label,
              })),
              /* "Bloqueado" aqui é o ATRIBUTO, não o estado: é por ele que se
                 procura a peça que não pode ser alocada, independentemente de
                 onde ela esteja no ciclo. */
              { valor: 'bloqueado', rotulo: 'Bloqueado (atributo)' },
            ],
          },
          {
            nome: 'categoria',
            rotulo: 'Categoria',
            valor: params.categoria ?? '',
            opcoes: [
              { valor: '', rotulo: 'Qualquer categoria' },
              ...(categorias ?? []).map((c) => ({ valor: c.id, rotulo: c.name })),
            ],
          },
          {
            nome: 'deposito',
            rotulo: 'Depósito',
            valor: params.deposito ?? '',
            opcoes: [
              { valor: '', rotulo: 'Qualquer depósito' },
              ...(depositos ?? []).map((d) => ({ valor: d.id, rotulo: d.name })),
            ],
          },
        ]}
      />

      {filtrada.length === 0 ? (
        <EmptyState
          title={lista.length === 0 ? 'Nenhum equipamento cadastrado' : 'Nada com esse recorte'}
          description={
            lista.length === 0
              ? 'A frota começa no cadastro do equipamento — e ele precisa de um modelo, que vive em Modelos e categorias.'
              : 'Troque o estado, a categoria ou o depósito para ver outras peças.'
          }
        />
      ) : (
        <Table
          label="Frota de locação"
          head={['Patrimônio', 'Modelo', 'Categoria', 'Onde está', 'Estado', 'Medidor']}
        >
          {filtrada.map((e) => {
            const modelo = modeloPorId.get(e.model_id)
            const categoria = categoriaDe(e)
            const deposito = e.depot_id ? depositoPorId.get(e.depot_id) : undefined
            const estado = ESTADO_DO_EQUIPAMENTO[e.status]
            return (
              <tr key={e.id} data-estado={e.status}>
                <Td className="font-mono text-xs">
                  <Link
                    href={endereco({ aberto: e.id, novo: null }) as Route}
                    data-testid="abrir-registro"
                    className="font-semibold text-[var(--color-brand-ink)] hover:underline"
                  >
                    {e.asset_tag}
                  </Link>
                </Td>
                <Td className="font-medium text-[var(--color-ink)]">{modelo?.name ?? '—'}</Td>
                <Td className="text-[var(--color-ink-2)]">{categoria?.name ?? '—'}</Td>
                <Td className="text-[var(--color-ink-2)]">{deposito?.name ?? '—'}</Td>
                <Td>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={estado.tone}>{estado.label}</Badge>
                    {/* O bloqueio é atributo e convive com o estado: mostrar só
                        um dos dois esconderia metade da verdade. */}
                    {e.blocked && (
                      <span title={e.block_reason ?? undefined}>
                        <Badge tone="crit">bloqueado</Badge>
                      </span>
                    )}
                  </span>
                </Td>
                <Td className="tabular-nums text-[var(--color-ink-2)]">
                  {formatarMedidor(e.meter_kind, e.meter_reading)}
                  {e.meter_read_at && (
                    <span className="block text-xs text-[var(--color-ink-3)]">
                      lido em {formatDate(e.meter_read_at)}
                    </span>
                  )}
                </Td>
              </tr>
            )
          })}
        </Table>
      )}
    </div>
  )
}
