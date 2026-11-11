import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen } from '@/lib/session'
import { formatDate } from '@/lib/format'
import type { MeterReading, RentalAllocation } from '@/lib/types'
import { EmptyState, FaixaDeIndicadores, PageHeader, StatTile, Table, Td, Badge } from '@/components/ui'
import { FiltrosDeLista } from '@/components/filtros-de-lista'
import { formatarMedidor, MEDIDOR } from '@/lib/locacao/rotulos'

export const metadata: Metadata = { title: 'Medições e consumo' }

/**
 * A série de leituras, e o consumo que sai dela.
 *
 * ## Por que esta tela não registra leitura
 *
 * Porque leitura se registra ONDE a máquina está: na gaveta do equipamento, na
 * frota, e nos passos de entrega e recolhimento do contrato. Uma tela de
 * digitação em massa pareceria prática e seria a porta para o erro mais caro
 * daqui — número digitado na linha errada, que vira excedente cobrado do
 * cliente errado.
 *
 * O que ela faz é responder duas perguntas que nenhuma outra responde: **quem
 * está sem leitura no mês** (e portanto não vai faturar excedente) e **quanto
 * cada peça rodou desde a entrega**.
 */
export default async function MedicoesPage({
  searchParams,
}: {
  searchParams: Promise<{ equipamento?: string; busca?: string }>
}) {
  const params = await searchParams
  await requireScreen('locacao.medicoes.ver')

  const supabase = await createClient()
  const [{ data: leituras }, { data: alocacoes }] = await Promise.all([
    supabase
      .from('meter_readings')
      .select('id, equipment_id, contract_item_id, reading, read_on, source, notes, created_at')
      .order('read_on', { ascending: false })
      .limit(200)
      .returns<MeterReading[]>(),
    supabase
      .from('vw_rental_allocations')
      .select(
        'id, contract_id, contract_code, contract_status, client_id, equipment_id, asset_tag, equipment_status, meter_kind, meter_reading, model_name, operation_location_id, location_name, status, monthly_price, franchise, excess_price, delivered_on, returned_on, meter_at_delivery, meter_at_return',
      )
      .eq('status', 'delivered')
      .returns<RentalAllocation[]>(),
  ])

  const emOperacao = (alocacoes ?? []).filter((a) => a.meter_kind !== 'none')
  const inicioDoMes = new Date()
  inicioDoMes.setDate(1)
  const corte = inicioDoMes.toISOString().slice(0, 10)

  const lidosNoMes = new Set(
    (leituras ?? []).filter((l) => l.read_on >= corte).map((l) => l.equipment_id),
  )
  const semLeitura = emOperacao.filter((a) => !lidosNoMes.has(a.equipment_id))

  const tagPorEquipamento = new Map(
    (alocacoes ?? []).map((a) => [a.equipment_id, `${a.asset_tag} — ${a.model_name}`]),
  )

  const termo = params.busca?.trim().toLowerCase() ?? ''
  const filtradas = (leituras ?? []).filter((l) => {
    if (params.equipamento && l.equipment_id !== params.equipamento) return false
    if (termo) {
      const alvo = (tagPorEquipamento.get(l.equipment_id) ?? '').toLowerCase()
      if (!alvo.includes(termo)) return false
    }
    return true
  })

  return (
    <div>
      <PageHeader
        title="Medições e consumo"
        description="A série de leituras do medidor. O consumo de um período é a diferença entre duas delas — e é ela que vira excedente na fatura."
      />

      <FaixaDeIndicadores>
        <StatTile label="Em operação com medidor" value={emOperacao.length} hint="peças que medem uso" />
        <StatTile
          label="Sem leitura neste mês"
          value={semLeitura.length}
          hint="não vão faturar excedente"
          tone={semLeitura.length > 0 ? 'breach' : 'ok'}
        />
        <StatTile label="Leituras registradas" value={(leituras ?? []).length} hint="últimas 200" />
        <StatTile
          label="Peças sem medidor"
          value={(alocacoes ?? []).filter((a) => a.meter_kind === 'none').length}
          hint="locam por tempo, não por uso"
        />
      </FaixaDeIndicadores>

      {semLeitura.length > 0 && (
        <div className="mb-6 rounded-xl border border-[var(--color-breach-ink)] bg-[var(--color-breach-soft)] p-4">
          <h2 className="text-sm font-semibold text-[var(--color-breach-ink)]">
            {semLeitura.length} equipamento(s) em operação sem leitura neste mês
          </h2>
          <p className="mt-1 text-sm text-[var(--color-ink-2)]">
            Sem leitura no período, o cálculo da fatura <strong>não cobra excedente</strong> — e
            isso é deliberado: &ldquo;não medimos&rdquo; e &ldquo;medimos e deu zero&rdquo; são
            fatos diferentes, e a fatura não deve dizer um pelo outro. Registre a leitura na gaveta
            do equipamento, na Frota.
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {semLeitura.map((a) => (
              <li key={a.id}>
                <Badge tone="breach">{a.asset_tag}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      <FiltrosDeLista
        base="/locacao/medicoes"
        params={params}
        placeholder="Patrimônio ou modelo…"
        filtros={[
          {
            nome: 'equipamento',
            rotulo: 'Equipamento',
            valor: params.equipamento ?? '',
            opcoes: [
              { valor: '', rotulo: 'Qualquer equipamento' },
              ...emOperacao.map((a) => ({ valor: a.equipment_id, rotulo: a.asset_tag })),
            ],
          },
        ]}
      />

      {filtradas.length === 0 ? (
        <EmptyState
          title="Nenhuma leitura registrada"
          description="A leitura se registra onde a máquina está: na gaveta do equipamento, na Frota, e nos passos de entrega e recolhimento do contrato."
        />
      ) : (
        <Table label="Leituras de medidor" head={['Quando', 'Equipamento', 'Leitura', 'Origem']}>
          {filtradas.map((l) => (
            <tr key={l.id}>
              <Td className="tabular-nums text-[var(--color-ink-2)]">{formatDate(l.read_on)}</Td>
              <Td className="font-medium text-[var(--color-ink)]">
                {tagPorEquipamento.get(l.equipment_id) ?? l.equipment_id.slice(0, 8)}
              </Td>
              <Td className="tabular-nums">{Number(l.reading).toLocaleString('pt-BR')}</Td>
              <Td className="text-[var(--color-ink-3)]">{ORIGEM[l.source] ?? l.source}</Td>
            </tr>
          ))}
        </Table>
      )}

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold text-[var(--color-ink)]">
          Consumo acumulado por alocação
        </h2>
        {emOperacao.length === 0 ? (
          <EmptyState title="Nenhuma peça com medidor em operação" />
        ) : (
          <Table
            label="Consumo por alocação"
            head={['Equipamento', 'Contrato', 'Na entrega', 'Agora', 'Rodou', 'Franquia']}
          >
            {emOperacao.map((a) => {
              const rodou = Number(a.meter_reading) - Number(a.meter_at_delivery ?? 0)
              return (
                <tr key={a.id}>
                  <Td className="font-medium text-[var(--color-ink)]">{a.asset_tag}</Td>
                  <Td className="font-mono text-xs text-[var(--color-ink-2)]">{a.contract_code}</Td>
                  <Td className="tabular-nums text-[var(--color-ink-2)]">
                    {a.meter_at_delivery !== null
                      ? Number(a.meter_at_delivery).toLocaleString('pt-BR')
                      : '—'}
                  </Td>
                  <Td className="tabular-nums">{formatarMedidor(a.meter_kind, Number(a.meter_reading))}</Td>
                  <Td className="tabular-nums font-medium">
                    {a.meter_at_delivery !== null
                      ? `${rodou.toLocaleString('pt-BR')} ${MEDIDOR[a.meter_kind].unidade}`
                      : 'sem base'}
                  </Td>
                  <Td className="tabular-nums text-[var(--color-ink-2)]">
                    {a.franchise !== null ? Number(a.franchise).toLocaleString('pt-BR') : '—'}
                  </Td>
                </tr>
              )
            })}
          </Table>
        )}
      </section>
    </div>
  )
}

const ORIGEM: Record<string, string> = {
  manual: 'digitada',
  import: 'importada',
  delivery: 'na entrega',
  return: 'no recolhimento',
  agent: 'agente',
}
