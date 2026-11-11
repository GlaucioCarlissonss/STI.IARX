import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { formatCurrency, formatDate } from '@/lib/format'
import type { Part, PartStock, PurchaseOrder, PurchaseOrderItem } from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import { ESTADO_DA_ORDEM, formatarQuantidade, progressoDaOrdem } from '@/lib/locacao/rotulos'
import {
  ItemForm,
  MoverOrdemForm,
  NotaForm,
  OrdemForm,
  ReceberForm,
  RemoverItemForm,
} from './forms'

export async function GavetaDeCompra({
  id,
  novo,
  fechar,
}: {
  id?: string
  novo?: boolean
  fechar: string
}) {
  const [podeGerenciar, podeReceber, podeFaturar] = await Promise.all([
    allowed('locacao.compras.gerenciar'),
    allowed('locacao.compras.receber'),
    allowed('locacao.compras.faturar'),
  ])

  const supabase = await createClient()

  const [{ data: fornecedores }, { data: depositos }] = await Promise.all([
    supabase
      .from('suppliers')
      .select('id, name')
      .is('deleted_at', null)
      .order('name')
      .returns<{ id: string; name: string }[]>(),
    supabase
      .from('rental_depots')
      .select('id, name')
      .is('deleted_at', null)
      .eq('is_active', true)
      .order('name')
      .returns<{ id: string; name: string }[]>(),
  ])

  if (novo) {
    if (!podeGerenciar) return null
    /* O número sugerido é OC-ano-sequencial, e é só sugestão: a numeração do
       fornecedor pode mandar outra coisa, e impor a nossa obrigaria a pessoa a
       apagar antes de digitar. */
    const { count } = await supabase
      .from('purchase_orders')
      .select('id', { count: 'exact', head: true })
    const sugerido = `OC-${new Date().getFullYear()}-${String((count ?? 0) + 1).padStart(3, '0')}`

    return (
      <Gaveta fechar={fechar} rotulo="Nova ordem de compra">
        <CabecalhoDaGaveta
          titulo="Nova ordem de compra"
          linha="Nasce como rascunho, sem itens"
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <OrdemForm
            fornecedores={fornecedores ?? []}
            depositos={depositos ?? []}
            codigoSugerido={sugerido}
          />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!id) return null

  const { data: ordem } = await supabase
    .from('purchase_orders')
    .select(
      'id, supplier_id, depot_id, code, status, expected_on, total, invoice_ref, payable_id, notes',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle<PurchaseOrder>()

  if (!ordem) return null

  const [{ data: itens }, { data: pecas }, { data: estoque }] = await Promise.all([
    supabase
      .from('purchase_order_items')
      .select('id, order_id, part_id, quantity, unit_price, amount, received_quantity')
      .eq('order_id', id)
      .order('created_at')
      .returns<PurchaseOrderItem[]>(),
    supabase
      .from('parts')
      .select('id, sku, name, manufacturer_id, unit, category, average_cost, notes, is_active')
      .is('deleted_at', null)
      .eq('is_active', true)
      .order('sku')
      .returns<Part[]>(),
    supabase
      .from('vw_part_stock')
      .select('part_id, depot_id, suggested_purchase')
      .eq('depot_id', ordem.depot_id)
      .returns<Pick<PartStock, 'part_id' | 'depot_id' | 'suggested_purchase'>[]>(),
  ])

  const porPeca = new Map((pecas ?? []).map((p) => [p.id, p]))
  const sugestao = new Map(
    (estoque ?? []).map((e) => [e.part_id, Number(e.suggested_purchase ?? 0)]),
  )
  const linhas = itens ?? []
  const estado = ESTADO_DA_ORDEM[ordem.status]
  const progresso = progressoDaOrdem(linhas)
  const fornecedor = (fornecedores ?? []).find((f) => f.id === ordem.supplier_id)
  const deposito = (depositos ?? []).find((d) => d.id === ordem.depot_id)
  const editavel = ordem.status === 'draft' || ordem.status === 'sent'
  const recebivel = ordem.status === 'sent' || ordem.status === 'partial'

  return (
    <Gaveta fechar={fechar} rotulo={`Ordem ${ordem.code}`}>
      <CabecalhoDaGaveta
        titulo={ordem.code}
        linha={`${fornecedor?.name ?? 'sem fornecedor'} · entrada em ${deposito?.name ?? '—'}`}
        fechar={fechar}
        selo={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={estado.tone}>{estado.label}</Badge>
            {ordem.payable_id && <Badge tone="info">título gerado</Badge>}
          </span>
        }
      />

      <CorpoDaGaveta>
        <section data-testid="itens-da-ordem">
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
            Itens ({linhas.length})
          </h3>
          {linhas.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-3)]">
              Ordem sem item nenhum. O total é a soma das linhas — por isso ele está zerado.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {linhas.map((i) => {
                const peca = porPeca.get(i.part_id)
                const falta = Number(i.quantity) - Number(i.received_quantity)
                return (
                  <div
                    key={i.id}
                    data-testid="item-da-ordem"
                    className="rounded-lg border border-[var(--color-border)] px-3 py-2"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm text-[var(--color-ink)]">
                        {peca?.sku} · {peca?.name ?? 'peça removida'}
                      </span>
                      <span className="text-sm font-semibold tabular-nums">
                        {formatCurrency(Number(i.amount))}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--color-ink-3)]">
                      {peca ? formatarQuantidade(Number(i.quantity), peca.unit) : Number(i.quantity)}{' '}
                      × {formatCurrency(Number(i.unit_price))} ·{' '}
                      {falta === 0 ? (
                        <span className="text-[var(--color-ok-ink)]">tudo recebido</span>
                      ) : (
                        <>
                          recebido {Number(i.received_quantity)} de {Number(i.quantity)}
                        </>
                      )}
                    </p>
                    <div className="mt-2 flex flex-wrap items-end gap-3">
                      {podeReceber && recebivel && falta > 0 && (
                        <ReceberForm itemId={i.id} falta={falta} />
                      )}
                      {podeGerenciar && editavel && Number(i.received_quantity) === 0 && (
                        <RemoverItemForm id={i.id} />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="mt-3 flex items-baseline justify-between border-t border-[var(--color-border)] pt-3">
            <span className="text-sm font-semibold text-[var(--color-ink)]">Total</span>
            <span className="text-lg font-bold tabular-nums text-[var(--color-ink)]">
              {formatCurrency(Number(ordem.total))}
            </span>
          </div>
          {linhas.length > 0 && (
            <p className="mt-1 text-xs text-[var(--color-ink-3)]">
              {Math.round(progresso * 100)}% recebido, medido em quantidade — não em número de
              linhas. O total é a soma das linhas, garantido pelo banco.
            </p>
          )}
        </section>

        {podeGerenciar && editavel && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
              Acrescentar item
            </h3>
            <ItemForm
              orderId={ordem.id}
              pecas={(pecas ?? []).map((p) => ({
                id: p.id,
                sku: p.sku,
                name: p.name,
                sugestao: sugestao.get(p.id) ?? 0,
              }))}
            />
          </section>
        )}

        <section className="border-t border-[var(--color-border)] pt-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[var(--color-ink-3)]">Entrega prevista</dt>
            <dd className="text-right font-medium">
              {ordem.expected_on ? formatDate(ordem.expected_on) : '—'}
            </dd>
            <dt className="text-[var(--color-ink-3)]">Nota fiscal</dt>
            <dd className="text-right font-medium">{ordem.invoice_ref ?? 'ainda não registrada'}</dd>
            <dt className="text-[var(--color-ink-3)]">Título a pagar</dt>
            <dd className="text-right font-medium">
              {ordem.payable_id ? (
                <Link
                  href={`/financeiro/titulos-a-pagar?aberto=${ordem.payable_id}` as Route}
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

        {podeFaturar && !ordem.payable_id && ordem.status !== 'cancelled' && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Nota fiscal</h3>
            {Number(ordem.total) > 0 ? (
              <NotaForm id={ordem.id} total={formatCurrency(Number(ordem.total))} />
            ) : (
              <p className="text-sm text-[var(--color-ink-3)]">
                Ordem sem valor não gera título a pagar.
              </p>
            )}
          </section>
        )}

        {podeGerenciar && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Situação</h3>
            <div className="flex flex-wrap gap-2">
              {ordem.status === 'draft' && linhas.length > 0 && (
                <MoverOrdemForm id={ordem.id} status="sent" />
              )}
              {ordem.status === 'sent' && <MoverOrdemForm id={ordem.id} status="draft" />}
              {ordem.status !== 'cancelled' && ordem.status !== 'received' && (
                <MoverOrdemForm id={ordem.id} status="cancelled" />
              )}
            </div>
            {ordem.status === 'draft' && linhas.length === 0 && (
              <p className="mt-2 text-xs text-[var(--color-ink-3)]">
                Acrescente ao menos um item para poder enviar: ordem vazia não pede nada.
              </p>
            )}
          </section>
        )}

        {podeGerenciar && editavel && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Dados da ordem</h3>
            <OrdemForm
              ordem={ordem}
              fornecedores={fornecedores ?? []}
              depositos={depositos ?? []}
            />
          </section>
        )}
      </CorpoDaGaveta>
    </Gaveta>
  )
}
