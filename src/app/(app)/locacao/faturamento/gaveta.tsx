import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { getClients } from '@/lib/data/lookups'
import { formatCurrency, formatDate } from '@/lib/format'
import type { RentalContract, RentalInvoice, RentalInvoiceItem } from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import {
  competenciaParaExibicao,
  ESTADO_DA_FATURA,
  TIPO_DA_LINHA,
} from '@/lib/locacao/rotulos'
import { CancelarFaturaForm, EmitirFaturaForm, GerarFaturaForm } from './forms'

/**
 * A fatura na gaveta — com a memória de cálculo à vista.
 *
 * Cada linha mostra de onde o número saiu: quantos dias, qual leitura inicial e
 * final. É o que permite responder "por que R$ 4.800 de excedente?" sem abrir o
 * banco — e é a diferença entre uma fatura que se confere e uma que se aceita.
 */
export async function GavetaDeFatura({
  id,
  novo,
  fechar,
}: {
  id?: string
  novo?: boolean
  fechar: string
}) {
  const [podeFaturar, podeCancelar] = await Promise.all([
    allowed('locacao.faturamento.faturar'),
    allowed('locacao.faturamento.cancelar'),
  ])

  const supabase = await createClient()

  if (novo) {
    if (!podeFaturar) return null
    const [{ data: contratos }, clientes] = await Promise.all([
      supabase
        .from('rental_contracts')
        .select(
          'id, client_id, code, status, starts_on, ends_on, billing_day, default_franchise, default_excess_price, adjustment_index, adjustment_month, notes',
        )
        .in('status', ['active', 'suspended'])
        .is('deleted_at', null)
        .order('code')
        .returns<RentalContract[]>(),
      getClients(),
    ])
    const nome = new Map(clientes.map((c) => [c.id, c.trade_name ?? c.legal_name]))
    /* O padrão é o mês PASSADO: faturar o mês corrente antes de ele acabar
       cobraria dias que ainda não aconteceram. */
    const anterior = new Date()
    anterior.setDate(1)
    anterior.setMonth(anterior.getMonth() - 1)

    return (
      <Gaveta fechar={fechar} rotulo="Gerar fatura">
        <CabecalhoDaGaveta
          titulo="Gerar fatura"
          linha="Contrato + medições do período = prévia"
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <GerarFaturaForm
            competenciaPadrao={anterior.toISOString().slice(0, 7)}
            contratos={(contratos ?? []).map((c) => ({
              ...c,
              cliente: nome.get(c.client_id) ?? 'cliente removido',
            }))}
          />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!id) return null

  const { data: fatura } = await supabase
    .from('rental_invoices')
    .select(
      'id, contract_id, client_id, number, competence, status, issued_on, due_on, total, receivable_id, notes',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle<RentalInvoice>()

  if (!fatura) return null

  const [{ data: itens }, clientes] = await Promise.all([
    supabase
      .from('rental_invoice_items')
      .select(
        'id, invoice_id, contract_item_id, equipment_id, kind, description, quantity, unit_price, amount, meter_from, meter_to, days',
      )
      .eq('invoice_id', id)
      .order('kind')
      .returns<RentalInvoiceItem[]>(),
    getClients(),
  ])

  const cliente = clientes.find((c) => c.id === fatura.client_id)
  const estado = ESTADO_DA_FATURA[fatura.status]
  const somaDasLinhas = (itens ?? []).reduce((s, i) => s + Number(i.amount), 0)

  return (
    <Gaveta fechar={fechar} rotulo={`Fatura ${fatura.number}`}>
      <CabecalhoDaGaveta
        titulo={fatura.number}
        linha={`${cliente?.trade_name ?? cliente?.legal_name ?? 'cliente'} · competência ${competenciaParaExibicao(
          fatura.competence,
        )}`}
        fechar={fechar}
        selo={<Badge tone={estado.tone}>{estado.label}</Badge>}
      />

      <CorpoDaGaveta>
        <section>
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
            Linhas ({(itens ?? []).length})
          </h3>
          <div className="flex flex-col gap-2">
            {(itens ?? []).map((i) => (
              <div
                key={i.id}
                data-testid="linha-da-fatura"
                className="rounded-lg border border-[var(--color-border)] px-3 py-2"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm text-[var(--color-ink)]">{i.description}</span>
                  <span className="text-sm font-semibold tabular-nums">
                    {formatCurrency(Number(i.amount))}
                  </span>
                </div>
                {/* A memória de cálculo: é o que permite responder "por quê?"
                    sem abrir o banco. */}
                <p className="text-xs text-[var(--color-ink-3)]">
                  {TIPO_DA_LINHA[i.kind] ?? i.kind} · {Number(i.quantity)} ×{' '}
                  {formatCurrency(Number(i.unit_price))}
                  {i.days !== null && ` · ${i.days} dia(s)`}
                  {i.meter_from !== null &&
                    i.meter_to !== null &&
                    ` · medidor ${Number(i.meter_from)} → ${Number(i.meter_to)}`}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-baseline justify-between border-t border-[var(--color-border)] pt-3">
            <span className="text-sm font-semibold text-[var(--color-ink)]">Total</span>
            <span className="text-lg font-bold tabular-nums text-[var(--color-ink)]">
              {formatCurrency(Number(fatura.total))}
            </span>
          </div>
          {/* A conferência que o gatilho garante, dita em voz alta. */}
          <p className="mt-1 text-xs text-[var(--color-ink-3)]">
            {Math.abs(somaDasLinhas - Number(fatura.total)) < 0.005
              ? 'O total é a soma das linhas — garantido pelo banco, não calculado aqui.'
              : `Divergência de ${formatCurrency(somaDasLinhas - Number(fatura.total))} entre o total e a soma das linhas.`}
          </p>
        </section>

        <section className="border-t border-[var(--color-border)] pt-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[var(--color-ink-3)]">Emitida em</dt>
            <dd className="text-right font-medium">
              {fatura.issued_on ? formatDate(fatura.issued_on) : '—'}
            </dd>
            <dt className="text-[var(--color-ink-3)]">Vence em</dt>
            <dd className="text-right font-medium">
              {fatura.due_on ? formatDate(fatura.due_on) : '—'}
            </dd>
            <dt className="text-[var(--color-ink-3)]">Título a receber</dt>
            <dd className="text-right font-medium">
              {fatura.receivable_id ? (
                <Link
                  href={`/financeiro/titulos-a-receber?aberto=${fatura.receivable_id}` as Route}
                  className="text-[var(--color-brand-ink)] hover:underline"
                >
                  abrir no financeiro
                </Link>
              ) : (
                'ainda não gerado'
              )}
            </dd>
          </dl>
        </section>

        {podeFaturar && fatura.status === 'draft' && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Emitir</h3>
            <EmitirFaturaForm id={fatura.id} total={Number(fatura.total)} />
          </section>
        )}

        {podeCancelar && fatura.status !== 'cancelled' && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
              {fatura.status === 'draft' ? 'Descartar' : 'Cancelar'}
            </h3>
            <CancelarFaturaForm id={fatura.id} emitida={fatura.status === 'issued'} />
          </section>
        )}

        {fatura.notes && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <p className="whitespace-pre-wrap text-sm text-[var(--color-ink-2)]">{fatura.notes}</p>
          </section>
        )}
      </CorpoDaGaveta>
    </Gaveta>
  )
}
