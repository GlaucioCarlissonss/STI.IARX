import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { getClients } from '@/lib/data/lookups'
import { comParametros } from '@/lib/data/endereco'
import { formatCurrency, formatDate } from '@/lib/format'
import type { RentalInvoice } from '@/lib/types'
import { Badge, EmptyState, FaixaDeIndicadores, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { FiltrosDeLista } from '@/components/filtros-de-lista'
import { competenciaParaExibicao, ESTADO_DA_FATURA } from '@/lib/locacao/rotulos'
import { GavetaDeFatura } from './gaveta'

export const metadata: Metadata = { title: 'Faturamento da locação' }

export default async function FaturamentoPage({
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
  await requireScreen('locacao.faturamento.ver')
  const podeFaturar = await allowed('locacao.faturamento.faturar')

  const supabase = await createClient()
  const [{ data: faturas }, clientes] = await Promise.all([
    supabase
      .from('rental_invoices')
      .select(
        'id, contract_id, client_id, number, competence, status, issued_on, due_on, total, receivable_id, notes',
      )
      .is('deleted_at', null)
      .order('competence', { ascending: false })
      .returns<RentalInvoice[]>(),
    getClients(),
  ])

  const lista = faturas ?? []
  const nome = new Map(clientes.map((c) => [c.id, c.trade_name ?? c.legal_name]))

  const termo = params.busca?.trim().toLowerCase() ?? ''
  const filtrada = lista.filter((f) => {
    if (params.estado && f.status !== params.estado) return false
    if (params.cliente && f.client_id !== params.cliente) return false
    if (termo) {
      const alvo = `${f.number} ${nome.get(f.client_id) ?? ''}`.toLowerCase()
      if (!alvo.includes(termo)) return false
    }
    return true
  })

  const rascunhos = lista.filter((f) => f.status === 'draft')
  const emitidas = lista.filter((f) => f.status === 'issued')
  /* Só o que foi EMITIDO entra no faturado: rascunho é cálculo, e somá-lo daria
     um número que a contabilidade não reconhece. */
  const faturado = emitidas.reduce((s, f) => s + Number(f.total), 0)
  const mesCorrente = new Date().toISOString().slice(0, 7)
  const doMes = emitidas
    .filter((f) => f.competence.slice(0, 7) === mesCorrente)
    .reduce((s, f) => s + Number(f.total), 0)

  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/locacao/faturamento', params, mudancas)
  const gavetaAberta = Boolean(params.aberto || params.novo)

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && (
        <GavetaDeFatura
          id={params.aberto}
          novo={Boolean(params.novo)}
          fechar={endereco({ aberto: null, novo: null })}
        />
      )}

      <PageHeader
        title="Faturamento da locação"
        description="A fatura é calculada do contrato mais as medições do período — nunca digitada. Emitir gera o título a receber no financeiro."
        action={
          podeFaturar && (
            <Link
              href={endereco({ novo: '1', aberto: null }) as Route}
              data-testid="novo-registro"
              className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
            >
              Gerar fatura
            </Link>
          )
        }
      />

      <FaixaDeIndicadores>
        <StatTile
          label="Rascunhos"
          value={rascunhos.length}
          hint="calculados, ainda não cobram"
          tone={rascunhos.length > 0 ? 'warn' : 'neutral'}
        />
        <StatTile label="Emitidas" value={emitidas.length} hint="com título a receber" tone="ok" />
        <StatTile label="Faturado total" value={formatCurrency(faturado)} hint="só o que foi emitido" />
        <StatTile
          label={`Competência ${competenciaParaExibicao(`${mesCorrente}-01`)}`}
          value={formatCurrency(doMes)}
          hint="emitido no mês corrente"
        />
      </FaixaDeIndicadores>

      <FiltrosDeLista
        base="/locacao/faturamento"
        params={params}
        placeholder="Número da fatura ou cliente…"
        filtros={[
          {
            nome: 'estado',
            rotulo: 'Estado',
            valor: params.estado ?? '',
            opcoes: [
              { valor: '', rotulo: 'Qualquer estado' },
              ...(Object.keys(ESTADO_DA_FATURA) as (keyof typeof ESTADO_DA_FATURA)[]).map((s) => ({
                valor: s,
                rotulo: ESTADO_DA_FATURA[s].label,
              })),
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
          title={lista.length === 0 ? 'Nenhuma fatura ainda' : 'Nada com esse recorte'}
          description={
            lista.length === 0
              ? 'Gere a prévia de uma competência: ela nasce como rascunho, com a memória de cálculo em cada linha, e só cobra quando é emitida.'
              : 'Troque o estado ou o cliente.'
          }
        />
      ) : (
        <Table
          label="Faturas de locação"
          head={['Fatura', 'Cliente', 'Competência', 'Vence', 'Total', 'Estado']}
        >
          {filtrada.map((f) => {
            const estado = ESTADO_DA_FATURA[f.status]
            return (
              <tr key={f.id}>
                <Td className="font-mono text-xs">
                  <Link
                    href={endereco({ aberto: f.id, novo: null }) as Route}
                    data-testid="abrir-registro"
                    className="font-semibold text-[var(--color-brand-ink)] hover:underline"
                  >
                    {f.number}
                  </Link>
                </Td>
                <Td className="font-medium text-[var(--color-ink)]">
                  {nome.get(f.client_id) ?? 'cliente removido'}
                </Td>
                <Td className="tabular-nums text-[var(--color-ink-2)]">
                  {competenciaParaExibicao(f.competence)}
                </Td>
                <Td className="tabular-nums text-[var(--color-ink-2)]">
                  {f.due_on ? formatDate(f.due_on) : '—'}
                </Td>
                <Td className="tabular-nums font-medium">{formatCurrency(Number(f.total))}</Td>
                <Td>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={estado.tone}>{estado.label}</Badge>
                    {f.receivable_id && <Badge tone="info">título gerado</Badge>}
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
