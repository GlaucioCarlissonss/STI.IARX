import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen } from '@/lib/session'
import { formatCurrency, formatDate, formatMonth } from '@/lib/format'
import type { CashFlowBucket, CostCenter } from '@/lib/types'
import { Badge, Card, EmptyState, Field, PageHeader, StatTile, Table, Td, inputClass } from '@/components/ui'

export const metadata: Metadata = { title: 'Fluxo de caixa' }

/**
 * Projeção de caixa — o que já está lançado, nada além disso.
 *
 * A conta inteira mora em `public.cash_flow_projection()` (migração 0021), e não
 * aqui: "qual situação conta como previsto" é regra financeira, e no banco ela é
 * provada por asserção contra PostgreSQL real. Esta página formata e explica.
 *
 * O que a tela recusa a fazer, e diz: projetar TENDÊNCIA. Não há histórico de
 * pagamento nesta base (`payables.paid_on` está vazio), então média de atraso ou
 * previsão de faturamento seriam número inventado com casa decimal — que parece
 * mais confiável do que número nenhum, e é pior.
 */

/** Períodos oferecidos. O banco ainda assim limita a 36 meses. */
const PERIODOS = [6, 12, 24] as const

function paraNumero(valor: string | undefined, padrao: number): number {
  const n = Number(valor)
  return Number.isFinite(n) ? n : padrao
}

export default async function FluxoDeCaixaPage({
  searchParams,
}: {
  searchParams: Promise<{ meses?: string; inadimplencia?: string; filial?: string; centro?: string }>
}) {
  const params = await searchParams
  await requireScreen('financeiro.fluxo_caixa.ver')

  const meses = PERIODOS.includes(paraNumero(params.meses, 12) as (typeof PERIODOS)[number])
    ? paraNumero(params.meses, 12)
    : 12
  const inadimplencia = Math.min(Math.max(paraNumero(params.inadimplencia, 0), 0), 100)
  const filial = params.filial || null
  const centro = params.centro || null

  const supabase = await createClient()
  const hoje = new Date().toISOString().slice(0, 10)

  const [{ data: projecao, error }, { data: filiais }, { data: centros }, { data: rascunhos }] =
    await Promise.all([
      /* Sem `.returns<CashFlowBucket[]>()`: para `rpc()` o cliente gerado infere um
         objeto único e recusa o molde de array. O tipo é aplicado logo abaixo, na
         desestruturação — mesma garantia, sem lutar com o inferidor. */
      supabase.rpc('cash_flow_projection', {
        p_months: meses,
        p_delinquency_rate: inadimplencia,
        p_branch_id: filial,
        p_cost_center_id: centro,
      }),
      supabase.from('branches').select('id, name').eq('is_active', true).order('name'),
      supabase
        .from('cost_centers')
        .select('id, parent_id, code, name, description, branch_id, is_active')
        .eq('is_active', true)
        .order('code')
        .returns<CostCenter[]>(),
      // Títulos comprometidos que vencem DEPOIS do horizonte. Não entram na
      // projeção, e por isso mesmo precisam aparecer: some da tabela e vira
      // dinheiro que ninguém viu.
      supabase
        .from('payables')
        .select('amount, due_on')
        .is('deleted_at', null)
        .in('status', ['pending_approval', 'approved', 'scheduled'])
        .returns<{ amount: number; due_on: string }[]>(),
    ])

  const baldes = (projecao ?? []) as CashFlowBucket[]
  const ultimo = baldes.at(-1)
  const fimHorizonte = ultimo?.bucket_start ?? hoje

  const saldoD0 = baldes.length > 0 ? Number(baldes[0]!.running_balance) - Number(baldes[0]!.net) : 0
  const totalEntradas = baldes.reduce((s, b) => s + Number(b.inflow), 0)
  const totalSaidas = baldes.reduce((s, b) => s + Number(b.outflow), 0)
  const primeiroNegativo = baldes.find((b) => Number(b.running_balance) < 0)

  // `bucket_start` é o primeiro dia do mês; um título que vence dentro do último
  // mês do horizonte já está na projeção, então o corte é o mês seguinte.
  const alemDoHorizonte = (rascunhos ?? []).filter((t) => {
    const inicioUltimoMes = fimHorizonte.slice(0, 7)
    return t.due_on.slice(0, 7) > inicioUltimoMes
  })
  const totalAlem = alemDoHorizonte.reduce((s, t) => s + Number(t.amount), 0)

  const vencidoNoPrimeiro = baldes[0] ? Number(baldes[0].overdue_outflow ?? 0) : 0

  const dinheiro = (valor: number) => (
    <span
      className={`tabular-nums ${valor < 0 ? 'text-[var(--color-breach-ink)]' : 'text-[var(--color-ink)]'}`}
    >
      {valor < 0 ? `− ${formatCurrency(Math.abs(valor))}` : formatCurrency(valor)}
    </span>
  )

  return (
    <>
      <PageHeader
        title="Fluxo de caixa"
        description="Projeção sobre os títulos já lançados. Não há estimativa de tendência aqui: o que aparece é compromisso registrado."
      />

      {error && (
        <div className="mb-6">
          <EmptyState
            title="Não foi possível montar a projeção"
            description={error.message}
          />
        </div>
      )}

      <Card title="Recorte" className="mb-6">
        {/* `method="get"` sem JavaScript: os filtros ficam na barra de endereço,
            então o recorte pode ser guardado nos favoritos e mandado para outra
            pessoa — que é o que se faz com um número de caixa. */}
        <form method="get" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Horizonte" htmlFor="meses">
            <select id="meses" name="meses" defaultValue={String(meses)} className={inputClass}>
              {PERIODOS.map((m) => (
                <option key={m} value={m}>
                  {m} meses
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Inadimplência presumida (%)"
            htmlFor="inadimplencia"
            hint="Aplicada só sobre os recebíveis. 0 = todos entram integralmente."
          >
            <input
              id="inadimplencia"
              name="inadimplencia"
              type="number"
              min={0}
              max={100}
              step="0.1"
              defaultValue={inadimplencia}
              className={inputClass}
            />
          </Field>

          <Field label="Filial" htmlFor="filial">
            <select id="filial" name="filial" defaultValue={filial ?? ''} className={inputClass}>
              <option value="">Todas</option>
              {(filiais ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Centro de custo" htmlFor="centro">
            <select id="centro" name="centro" defaultValue={centro ?? ''} className={inputClass}>
              <option value="">Todos</option>
              {(centros ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="sm:col-span-2 xl:col-span-4">
            <button
              type="submit"
              className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-white"
            >
              Aplicar
            </button>
          </div>
        </form>
      </Card>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Saldo hoje"
          value={formatCurrency(saldoD0)}
          hint="contas bancárias, sem lançamentos futuros"
          tone={saldoD0 < 0 ? 'breach' : 'ok'}
        />
        <StatTile
          label="A receber no horizonte"
          value={formatCurrency(totalEntradas)}
          hint={inadimplencia > 0 ? `líquido de ${inadimplencia}% de inadimplência` : 'valor integral'}
        />
        <StatTile label="A pagar no horizonte" value={formatCurrency(totalSaidas)} />
        <StatTile
          label="Primeiro mês negativo"
          value={primeiroNegativo ? formatMonth(primeiroNegativo.bucket_start) : 'nenhum'}
          hint={
            primeiroNegativo
              ? formatCurrency(Number(primeiroNegativo.running_balance))
              : 'o saldo projetado não fica negativo no período'
          }
          tone={primeiroNegativo ? 'breach' : 'ok'}
        />
      </div>

      {/* Os avisos são aritmética, não limiar inventado: um diz que a soma fica
          negativa, o outro só relata onde o dinheiro se concentra. */}
      <div className="mb-6 flex flex-col gap-2">
        {primeiroNegativo && (
          <p className="rounded-lg bg-[var(--color-breach-soft)] px-4 py-3 text-sm text-[var(--color-breach-ink)]">
            O saldo projetado fica negativo em <strong>{formatMonth(primeiroNegativo.bucket_start)}</strong>,
            chegando a {formatCurrency(Number(primeiroNegativo.running_balance))}.
          </p>
        )}
        {vencidoNoPrimeiro > 0 && (
          <p className="rounded-lg bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn-ink)]">
            {formatCurrency(vencidoNoPrimeiro)} do mês atual já está <strong>vencido</strong> — é atraso,
            não previsão.
          </p>
        )}
        {totalAlem > 0 && (
          <p className="rounded-lg bg-[var(--color-neutral-soft)] px-4 py-3 text-sm text-[var(--color-neutral-ink)]">
            {formatCurrency(totalAlem)} em {alemDoHorizonte.length} título(s) vence depois do horizonte de{' '}
            {meses} meses e não está na tabela abaixo.
          </p>
        )}
      </div>

      {baldes.length === 0 ? (
        <EmptyState
          title="Nada a projetar"
          description="Não há título a pagar comprometido nem título a receber em aberto no recorte escolhido."
        />
      ) : (
        <Table head={['Período', 'Entradas', 'Saídas', 'Resultado', 'Saldo projetado', 'Maior dia de saída']}>
          {baldes.map((b) => {
            const saida = Number(b.outflow)
            const pico = Number(b.peak_day_outflow)
            const fatia = saida > 0 ? Math.round((pico / saida) * 100) : 0
            return (
              <tr key={b.bucket_start}>
                <Td className="font-semibold">
                  {formatMonth(b.bucket_start)}
                  {Number(b.overdue_outflow ?? 0) > 0 && (
                    <span className="ml-2">
                      <Badge tone="warn">inclui vencidos</Badge>
                    </span>
                  )}
                </Td>
                <Td className="tabular-nums">
                  {formatCurrency(Number(b.inflow))}
                  <span className="ml-2 text-xs text-[var(--color-ink-3)]">
                    {b.receivables_count} tít.
                  </span>
                </Td>
                <Td className="tabular-nums">
                  {formatCurrency(saida)}
                  <span className="ml-2 text-xs text-[var(--color-ink-3)]">{b.payables_count} tít.</span>
                </Td>
                <Td>{dinheiro(Number(b.net))}</Td>
                <Td>{dinheiro(Number(b.running_balance))}</Td>
                <Td className="text-sm text-[var(--color-ink-2)]">
                  {b.peak_day
                    ? `${formatDate(b.peak_day)} — ${formatCurrency(pico)} (${fatia}% do mês)`
                    : '—'}
                </Td>
              </tr>
            )
          })}
        </Table>
      )}

      <p className="mt-4 text-sm text-[var(--color-ink-3)]">
        Entram títulos a pagar aguardando aprovação, aprovados e agendados, e títulos a receber em
        aberto. Ficam de fora rascunhos, reprovados, cancelados e tudo que já foi pago ou recebido —
        estes últimos porque já estão no saldo, e contá-los de novo seria contar o mesmo dinheiro duas
        vezes. Limite de crédito não é caixa e não entra em lugar nenhum desta conta.
      </p>
    </>
  )
}
