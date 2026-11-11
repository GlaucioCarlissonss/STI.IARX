import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { comParametros } from '@/lib/data/endereco'
import { formatCurrency, formatDate } from '@/lib/format'
import type { PurchaseOrder, PurchaseOrderItem } from '@/lib/types'
import { Badge, EmptyState, FaixaDeIndicadores, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { FiltrosDeLista } from '@/components/filtros-de-lista'
import { ESTADO_DA_ORDEM, progressoDaOrdem } from '@/lib/locacao/rotulos'
import { GavetaDeCompra } from './gaveta'

export const metadata: Metadata = { title: 'Ordens de compra' }

export default async function ComprasPage({
  searchParams,
}: {
  searchParams: Promise<{
    estado?: string
    fornecedor?: string
    busca?: string
    aberto?: string
    novo?: string
  }>
}) {
  const params = await searchParams
  await requireScreen('locacao.compras.ver')
  const podeGerenciar = await allowed('locacao.compras.gerenciar')

  const supabase = await createClient()
  const [{ data: ordens }, { data: itens }, { data: fornecedores }] = await Promise.all([
    supabase
      .from('purchase_orders')
      .select(
        'id, supplier_id, depot_id, code, status, expected_on, total, invoice_ref, payable_id, notes',
      )
      .is('deleted_at', null)
      .order('code', { ascending: false })
      .returns<PurchaseOrder[]>(),
    supabase
      .from('purchase_order_items')
      .select('id, order_id, part_id, quantity, unit_price, amount, received_quantity')
      .returns<PurchaseOrderItem[]>(),
    supabase
      .from('suppliers')
      .select('id, name')
      .is('deleted_at', null)
      .order('name')
      .returns<{ id: string; name: string }[]>(),
  ])

  const lista = ordens ?? []
  const nome = new Map((fornecedores ?? []).map((f) => [f.id, f.name]))
  const porOrdem = new Map<string, PurchaseOrderItem[]>()
  for (const i of itens ?? []) {
    const atual = porOrdem.get(i.order_id) ?? []
    atual.push(i)
    porOrdem.set(i.order_id, atual)
  }

  const termo = params.busca?.trim().toLowerCase() ?? ''
  const filtrada = lista.filter((o) => {
    if (params.estado && o.status !== params.estado) return false
    if (params.fornecedor && o.supplier_id !== params.fornecedor) return false
    if (termo) {
      const alvo = `${o.code} ${nome.get(o.supplier_id ?? '') ?? ''}`.toLowerCase()
      if (!alvo.includes(termo)) return false
    }
    return true
  })

  const emAberto = lista.filter((o) => o.status === 'sent' || o.status === 'partial')
  const emTransito = emAberto.reduce((s, o) => s + Number(o.total), 0)
  /* Recebida sem NF é a situação que custa dinheiro em silêncio: a peça já está
     no estoque e o fornecedor ainda não entrou no fluxo de caixa. */
  const semNota = lista.filter((o) => o.status === 'received' && !o.payable_id)
  const hoje = new Date().toISOString().slice(0, 10)
  const atrasadas = emAberto.filter((o) => o.expected_on && o.expected_on < hoje)

  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/locacao/compras', params, mudancas)
  const gavetaAberta = Boolean(params.aberto || params.novo)

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && (
        <GavetaDeCompra
          id={params.aberto}
          novo={Boolean(params.novo)}
          fechar={endereco({ aberto: null, novo: null })}
        />
      )}

      <PageHeader
        title="Ordens de compra"
        description="Receber dá entrada no estoque; registrar a NF gera o título a pagar no financeiro que já existe. Recebimento parcial é o caso normal, não a exceção."
        action={
          podeGerenciar && (
            <Link
              href={endereco({ novo: '1', aberto: null }) as Route}
              data-testid="novo-registro"
              className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
            >
              Nova ordem
            </Link>
          )
        }
      />

      <FaixaDeIndicadores>
        <StatTile
          label="Aguardando entrega"
          value={emAberto.length}
          hint={`${formatCurrency(emTransito)} em trânsito`}
          tone={emAberto.length > 0 ? 'warn' : 'neutral'}
        />
        <StatTile
          label="Recebidas sem NF"
          value={semNota.length}
          hint="sem título a pagar"
          tone={semNota.length > 0 ? 'crit' : 'ok'}
        />
        <StatTile
          label="Em atraso"
          value={atrasadas.length}
          hint="passaram da data prevista"
          tone={atrasadas.length > 0 ? 'crit' : 'ok'}
        />
        <StatTile label="Ordens no total" value={lista.length} hint="todas as situações" />
      </FaixaDeIndicadores>

      <FiltrosDeLista
        base="/locacao/compras"
        params={params}
        placeholder="Número da ordem ou fornecedor…"
        filtros={[
          {
            nome: 'estado',
            rotulo: 'Estado',
            valor: params.estado ?? '',
            opcoes: [
              { valor: '', rotulo: 'Qualquer estado' },
              ...(Object.keys(ESTADO_DA_ORDEM) as (keyof typeof ESTADO_DA_ORDEM)[]).map((s) => ({
                valor: s,
                rotulo: ESTADO_DA_ORDEM[s].label,
              })),
            ],
          },
          {
            nome: 'fornecedor',
            rotulo: 'Fornecedor',
            valor: params.fornecedor ?? '',
            opcoes: [
              { valor: '', rotulo: 'Qualquer fornecedor' },
              ...(fornecedores ?? []).map((f) => ({ valor: f.id, rotulo: f.name })),
            ],
          },
        ]}
      />

      {filtrada.length === 0 ? (
        <EmptyState
          title={lista.length === 0 ? 'Nenhuma ordem de compra' : 'Nada com esse recorte'}
          description={
            lista.length === 0
              ? 'Crie a primeira: ela nasce como rascunho, e o que estiver abaixo do mínimo já chega sugerido na hora de escolher a peça.'
              : 'Troque o estado ou o fornecedor.'
          }
        />
      ) : (
        <Table
          label="Ordens de compra"
          head={['Ordem', 'Fornecedor', 'Itens', 'Total', 'Prevista', 'Situação']}
        >
          {filtrada.map((o) => {
            const estado = ESTADO_DA_ORDEM[o.status]
            const linhas = porOrdem.get(o.id) ?? []
            const progresso = progressoDaOrdem(linhas)
            const atrasada = Boolean(
              o.expected_on && o.expected_on < hoje && (o.status === 'sent' || o.status === 'partial'),
            )
            return (
              <tr key={o.id}>
                <Td className="font-mono text-xs">
                  <Link
                    href={endereco({ aberto: o.id, novo: null }) as Route}
                    data-testid="abrir-registro"
                    className="font-semibold text-[var(--color-brand-ink)] hover:underline"
                  >
                    {o.code}
                  </Link>
                </Td>
                <Td className="font-medium text-[var(--color-ink)]">
                  {nome.get(o.supplier_id ?? '') ?? 'sem fornecedor'}
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {linhas.length} peça(s)
                  {linhas.length > 0 && progresso > 0 && progresso < 1 && (
                    <span className="ml-1 text-xs text-[var(--color-warn-ink)]">
                      · {Math.round(progresso * 100)}% recebido
                    </span>
                  )}
                </Td>
                <Td className="tabular-nums font-medium">{formatCurrency(Number(o.total))}</Td>
                <Td className="tabular-nums text-[var(--color-ink-2)]">
                  {o.expected_on ? formatDate(o.expected_on) : '—'}
                </Td>
                <Td>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={estado.tone}>{estado.label}</Badge>
                    {atrasada && <Badge tone="crit" testid="selo-de-atraso">em atraso</Badge>}
                    {o.status === 'received' && !o.payable_id && (
                      <Badge tone="crit" testid="selo-sem-nf">sem NF</Badge>
                    )}
                    {o.payable_id && <Badge tone="info">título gerado</Badge>}
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
