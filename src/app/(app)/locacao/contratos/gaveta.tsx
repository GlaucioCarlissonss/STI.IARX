import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { getClients } from '@/lib/data/lookups'
import { formatCurrency, formatDate } from '@/lib/format'
import type {
  OperationLocation,
  RentalAllocation,
  RentalContract,
} from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import {
  ESTADO_DA_ALOCACAO,
  ESTADO_DO_CONTRATO,
  formatarMedidor,
} from '@/lib/locacao/rotulos'
import {
  AlocarForm,
  ContratoForm,
  LocalForm,
  MoverContratoForm,
  PassoDaAlocacaoForm,
} from './forms'

/**
 * O contrato na gaveta — e a vida da alocação dentro dele.
 *
 * ## Por que os passos da alocação moram aqui, e não na frota
 *
 * Porque expedir, entregar e recolher são atos do CONTRATO: eles têm data,
 * leitura e destino, e os três só fazem sentido em relação a um cliente e a um
 * local. Na frota, o mesmo equipamento aparece com o estado resultante — que é
 * o que interessa a quem olha a frota.
 */
export async function GavetaDeContrato({
  id,
  novo,
  fechar,
}: {
  id?: string
  novo?: boolean
  fechar: string
}) {
  const [podeCriar, podeEditar, podeAlocar, podeMover] = await Promise.all([
    allowed('locacao.contratos.criar'),
    allowed('locacao.contratos.editar'),
    allowed('locacao.contratos.alocar'),
    allowed('locacao.contratos.mover'),
  ])

  const supabase = await createClient()

  if (novo) {
    if (!podeCriar) return null
    const clientes = await getClients()
    return (
      <Gaveta fechar={fechar} rotulo="Novo contrato de locação">
        <CabecalhoDaGaveta
          titulo="Novo contrato"
          linha="Nasce como rascunho — alocar e faturar só depois de ativar"
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <ContratoForm clientes={clientes} />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!id) return null

  const { data: contrato } = await supabase
    .from('rental_contracts')
    .select(
      'id, client_id, code, status, starts_on, ends_on, billing_day, default_franchise, default_excess_price, adjustment_index, adjustment_month, notes',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle<RentalContract>()

  if (!contrato) return null

  const [clientes, { data: alocacoes }, { data: transicoes }, { data: locais }] = await Promise.all([
    getClients(),
    supabase
      .from('vw_rental_allocations')
      .select(
        'id, contract_id, contract_code, contract_status, client_id, equipment_id, asset_tag, equipment_status, meter_kind, meter_reading, model_name, operation_location_id, location_name, status, monthly_price, franchise, excess_price, delivered_on, returned_on, meter_at_delivery, meter_at_return',
      )
      .eq('contract_id', id)
      .order('asset_tag')
      .returns<RentalAllocation[]>(),
    supabase
      .from('rental_contract_status_transitions')
      .select('from_status, to_status, description')
      .eq('from_status', contrato.status)
      .returns<{ from_status: string; to_status: string; description: string | null }[]>(),
    supabase
      .from('operation_locations')
      .select('id, client_id, branch_id, name, address_line, contact_name, contact_phone, notes, is_active')
      .eq('client_id', contrato.client_id)
      .is('deleted_at', null)
      .order('name')
      .returns<OperationLocation[]>(),
  ])

  /* Só o que pode entrar em contrato: disponível e sem alocação viva. O banco
     recusaria o resto, e oferecer o que será recusado é desenhar um botão para
     produzir erro. */
  const { data: disponiveis } = await supabase
    .from('rental_equipment')
    .select('id, asset_tag, model_id, status')
    .eq('status', 'available')
    .is('deleted_at', null)
    .order('asset_tag')
    .returns<{ id: string; asset_tag: string; model_id: string; status: string }[]>()

  const { data: modelos } = await supabase
    .from('equipment_models')
    .select('id, name, monthly_price')
    .is('deleted_at', null)
    .returns<{ id: string; name: string; monthly_price: number | null }[]>()

  const modeloPorId = new Map((modelos ?? []).map((m) => [m.id, m]))
  const cliente = clientes.find((c) => c.id === contrato.client_id)
  const estado = ESTADO_DO_CONTRATO[contrato.status]
  const vivas = (alocacoes ?? []).filter((a) => a.status === 'reserved' || a.status === 'delivered')
  const mensal = vivas.reduce((s, a) => s + Number(a.monthly_price), 0)

  return (
    <Gaveta fechar={fechar} rotulo={`Contrato ${contrato.code}`}>
      <CabecalhoDaGaveta
        titulo={contrato.code}
        linha={`${cliente?.trade_name ?? cliente?.legal_name ?? 'cliente removido'} · ${formatDate(
          contrato.starts_on,
        )} → ${contrato.ends_on ? formatDate(contrato.ends_on) : 'indeterminado'}`}
        fechar={fechar}
        selo={<Badge tone={estado.tone}>{estado.label}</Badge>}
      />

      <CorpoDaGaveta>
        <section>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[var(--color-ink-3)]">Itens em operação</dt>
            <dd className="text-right font-medium tabular-nums">{vivas.length}</dd>
            <dt className="text-[var(--color-ink-3)]">Recorrente mensal</dt>
            <dd className="text-right font-medium tabular-nums">{formatCurrency(mensal)}</dd>
            <dt className="text-[var(--color-ink-3)]">Fecha no dia</dt>
            <dd className="text-right font-medium tabular-nums">{contrato.billing_day}</dd>
            <dt className="text-[var(--color-ink-3)]">Reajuste</dt>
            <dd className="text-right font-medium">
              {contrato.adjustment_index ?? '—'}
              {contrato.adjustment_month ? ` · mês ${contrato.adjustment_month}` : ''}
            </dd>
          </dl>
        </section>

        {podeMover && (transicoes ?? []).length > 0 && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Estado do contrato</h3>
            <MoverContratoForm
              id={contrato.id}
              destinos={(transicoes ?? []).map((t) => ({
                status: t.to_status,
                rotulo: t.description,
              }))}
            />
            <p className="mt-2 text-xs text-[var(--color-ink-3)]">
              Encerrar ou rescindir devolve os itens automaticamente — sem isso o equipamento
              ficaria preso numa alocação viva de um contrato morto.
            </p>
          </section>
        )}

        <section className="border-t border-[var(--color-border)] pt-4">
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
            Equipamentos alocados {(alocacoes ?? []).length > 0 && `(${(alocacoes ?? []).length})`}
          </h3>

          {(alocacoes ?? []).length === 0 ? (
            <p className="mb-3 text-sm italic text-[var(--color-ink-3)]">
              Nenhum equipamento alocado ainda.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {(alocacoes ?? []).map((a) => {
                const st = ESTADO_DA_ALOCACAO[a.status]
                return (
                  <div
                    key={a.id}
                    data-testid="alocacao"
                    className="rounded-lg border border-[var(--color-border)] px-3 py-2"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-[var(--color-ink)]">
                        <span className="font-mono text-xs text-[var(--color-ink-3)]">
                          {a.asset_tag}
                        </span>{' '}
                        {a.model_name}
                      </span>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>
                    <p className="text-xs text-[var(--color-ink-3)]">
                      {a.location_name ?? 'sem local'} · {formatCurrency(a.monthly_price)}/mês
                      {a.franchise !== null && ` · franquia ${a.franchise}`}
                      {a.delivered_on && ` · entregue em ${formatDate(a.delivered_on)}`}
                      {a.meter_kind !== 'none' &&
                        ` · ${formatarMedidor(a.meter_kind, a.meter_reading)}`}
                    </p>
                    {podeAlocar && contrato.status === 'active' && (
                      <div className="mt-2">
                        <PassoDaAlocacaoForm alocacao={a} />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {podeAlocar && contrato.status === 'active' && (
            <div className="mt-3 border-t border-[var(--color-border)] pt-3">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                Alocar mais um
              </h4>
              <AlocarForm
                contratoId={contrato.id}
                locais={locais ?? []}
                franquiaPadrao={contrato.default_franchise}
                excedentePadrao={contrato.default_excess_price}
                disponiveis={(disponiveis ?? []).map((e) => ({
                  id: e.id,
                  asset_tag: e.asset_tag,
                  nome: modeloPorId.get(e.model_id)?.name ?? 'modelo removido',
                  preco: modeloPorId.get(e.model_id)?.monthly_price ?? null,
                }))}
              />
            </div>
          )}

          {podeAlocar && contrato.status !== 'active' && (
            <p className="mt-3 rounded-lg bg-[var(--color-brand-soft)] px-3 py-2 text-xs text-[var(--color-brand-ink)]">
              Contrato em <strong>{estado.label.toLowerCase()}</strong> não recebe alocação. Ative-o
              para reservar equipamento — é o ato que tira a peça da base alocável.
            </p>
          )}
        </section>

        {podeEditar && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
              Locais de operação deste cliente {(locais ?? []).length > 0 && `(${(locais ?? []).length})`}
            </h3>
            {(locais ?? []).length > 0 && (
              <ul className="mb-3 flex flex-col gap-1.5">
                {(locais ?? []).map((l) => (
                  <li key={l.id} className="text-sm text-[var(--color-ink-2)]">
                    <strong className="text-[var(--color-ink)]">{l.name}</strong>
                    {l.address_line ? ` — ${l.address_line}` : ''}
                  </li>
                ))}
              </ul>
            )}
            <LocalForm clientId={contrato.client_id} />
          </section>
        )}

        {podeEditar && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Ficha do contrato</h3>
            <ContratoForm contrato={contrato} clientes={clientes} />
          </section>
        )}
      </CorpoDaGaveta>
    </Gaveta>
  )
}
