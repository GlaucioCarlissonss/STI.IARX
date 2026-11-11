import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { formatCurrency, formatDate } from '@/lib/format'
import type { Part, PartMovement, PartStock } from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import {
  descreverMovimentoDePeca,
  formatarQuantidade,
  MOVIMENTO_DE_PECA,
  NIVEL_DO_ESTOQUE,
} from '@/lib/locacao/rotulos'
import { MovimentoForm, PecaForm, PoliticaForm, TransferenciaForm } from './forms'

/**
 * A peça na gaveta — com o razão à vista.
 *
 * Os movimentos não são um apêndice: eles são a explicação do saldo. Mostrar o
 * número sem a lista que o produz é pedir que a pessoa acredite, e acreditar é
 * o que ela para de fazer na primeira divergência.
 */
export async function GavetaDePeca({
  parte,
  deposito,
  novo,
  fechar,
}: {
  parte?: string
  deposito?: string
  novo?: boolean
  fechar: string
}) {
  const [podeGerenciar, podeMovimentar] = await Promise.all([
    allowed('locacao.pecas.gerenciar'),
    allowed('locacao.pecas.movimentar'),
  ])

  const supabase = await createClient()

  const { data: fabricantes } = await supabase
    .from('equipment_manufacturers')
    .select('id, name')
    .is('deleted_at', null)
    .order('name')
    .returns<{ id: string; name: string }[]>()

  if (novo) {
    if (!podeGerenciar) return null
    return (
      <Gaveta fechar={fechar} rotulo="Cadastrar peça">
        <CabecalhoDaGaveta
          titulo="Cadastrar peça"
          linha="O saldo virá dos movimentos, não deste formulário"
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <PecaForm fabricantes={fabricantes ?? []} />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!parte) return null

  const { data: peca } = await supabase
    .from('parts')
    .select('id, sku, name, manufacturer_id, unit, category, average_cost, notes, is_active')
    .eq('id', parte)
    .is('deleted_at', null)
    .maybeSingle<Part>()

  if (!peca) return null

  const [{ data: linhas }, { data: depositos }] = await Promise.all([
    supabase
      .from('vw_part_stock')
      .select(
        'part_id, sku, name, unit, category, average_cost, is_active, depot_id, depot_name, quantity, last_movement_at, min_quantity, max_quantity, lead_time_days, suggested_purchase, level, stock_value',
      )
      .eq('part_id', parte)
      .order('depot_name')
      .returns<PartStock[]>(),
    supabase
      .from('rental_depots')
      .select('id, name')
      .is('deleted_at', null)
      .eq('is_active', true)
      .order('name')
      .returns<{ id: string; name: string }[]>(),
  ])

  /* O depósito em foco: o pedido na URL, ou o primeiro que a peça ocupa. Sem um
     escolhido, a gaveta não saberia de qual saldo está falando. */
  const emFoco = (linhas ?? []).find((l) => l.depot_id === deposito) ?? (linhas ?? [])[0]

  const LIMITE_DE_MOVIMENTOS = 20

  /*
   * O total vem junto da página.
   *
   * A lista é limitada — um estoque com anos de uso traria milhares de linhas —,
   * mas a tela afirma que o saldo é a soma dos movimentos. Mostrar vinte sem
   * dizer que são os vinte ÚLTIMOS transforma essa afirmação em algo que não
   * fecha: a pessoa soma o que vê, dá outro número, e desconfia do saldo. O
   * corte é legítimo; escondê-lo não é.
   */
  /* O recorte por depósito é da CONSULTA, e não de um filtro em memória:
     filtrar depois do `limit` faria os vinte últimos da peça inteira virarem
     cinco do depósito em foco, e o resto sumiria sem aviso. */
  const [{ data: movimentos }, { count: totalDeMovimentos }] = emFoco
    ? await Promise.all([
        supabase
          .from('part_movements')
          .select(
            'id, part_id, depot_id, kind, quantity, unit_cost, ticket_id, purchase_order_id, inventory_count_id, transfer_depot_id, notes, created_at',
          )
          .eq('part_id', parte)
          .eq('depot_id', emFoco.depot_id)
          .order('created_at', { ascending: false })
          .limit(LIMITE_DE_MOVIMENTOS)
          .returns<PartMovement[]>(),
        supabase
          .from('part_movements')
          .select('id', { count: 'exact', head: true })
          .eq('part_id', parte)
          .eq('depot_id', emFoco.depot_id),
      ])
    : /* Peça sem saldo e sem política em depósito nenhum: não há foco, e
         consultar o razão de um depósito inexistente só gastaria uma viagem
         ao banco para voltar vazio. */
      [{ data: [] as PartMovement[] }, { count: 0 }]

  const doFoco = movimentos ?? []
  const cortados = Math.max((totalDeMovimentos ?? doFoco.length) - doFoco.length, 0)
  const nivel = emFoco ? NIVEL_DO_ESTOQUE[emFoco.level] : null

  return (
    <Gaveta fechar={fechar} rotulo={`${peca.sku} — ${peca.name}`}>
      <CabecalhoDaGaveta
        titulo={`${peca.sku} · ${peca.name}`}
        linha={`${emFoco?.depot_name ?? 'sem depósito'} · ${peca.category ?? 'sem categoria'} · custo médio ${formatCurrency(Number(peca.average_cost))}`}
        fechar={fechar}
        selo={nivel ? <Badge tone={nivel.tone}>{nivel.label}</Badge> : undefined}
      />

      <CorpoDaGaveta>
        {emFoco && (
          <section data-testid="saldo-da-peca">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Saldo</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-[var(--color-ink-3)]">Em estoque</dt>
              <dd className="text-right text-base font-bold tabular-nums">
                {formatarQuantidade(Number(emFoco.quantity), peca.unit)}
              </dd>
              <dt className="text-[var(--color-ink-3)]">Mínimo / máximo</dt>
              <dd className="text-right font-medium tabular-nums">
                {emFoco.min_quantity === null
                  ? 'sem política'
                  : `${Number(emFoco.min_quantity)} / ${Number(emFoco.max_quantity)}`}
              </dd>
              <dt className="text-[var(--color-ink-3)]">Sugestão de compra</dt>
              <dd
                className={`text-right font-medium tabular-nums ${
                  Number(emFoco.suggested_purchase ?? 0) > 0 ? 'text-[var(--color-breach-ink)]' : ''
                }`}
              >
                {emFoco.suggested_purchase === null
                  ? '—'
                  : formatarQuantidade(Number(emFoco.suggested_purchase), peca.unit)}
              </dd>
              <dt className="text-[var(--color-ink-3)]">Valor em estoque</dt>
              <dd className="text-right font-medium tabular-nums">
                {formatCurrency(Number(emFoco.stock_value))}
              </dd>
            </dl>
            {Number(emFoco.suggested_purchase ?? 0) > 0 && (
              <p className="mt-2 rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-xs text-[var(--color-warn-ink)]">
                A sugestão é <strong>máximo − saldo</strong>, e aparece porque o saldo furou o
                mínimo. Comprar até o máximo, e não até o mínimo, é o que evita comprar de novo na
                semana seguinte.
              </p>
            )}
          </section>
        )}

        {(linhas ?? []).length > 1 && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Nos depósitos</h3>
            <div className="flex flex-col gap-1.5">
              {(linhas ?? []).map((l) => {
                const n = NIVEL_DO_ESTOQUE[l.level]
                return (
                  <Link
                    key={l.depot_id}
                    href={`/locacao/pecas?aberto=${peca.id}&deposito=${l.depot_id}` as Route}
                    className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm ${
                      l.depot_id === emFoco?.depot_id
                        ? 'border-[var(--color-brand)] bg-[var(--color-surface)]'
                        : 'border-[var(--color-border)]'
                    }`}
                  >
                    <span>{l.depot_name}</span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums">
                        {formatarQuantidade(Number(l.quantity), peca.unit)}
                      </span>
                      <Badge tone={n.tone}>{n.label}</Badge>
                    </span>
                  </Link>
                )
              })}
            </div>
          </section>
        )}

        <section className="border-t border-[var(--color-border)] pt-4">
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
            Movimentos ({doFoco.length})
          </h3>
          {doFoco.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-3)]">
              Nenhum movimento neste depósito. O saldo é a soma desta lista — por isso ele é zero.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {doFoco.map((m) => {
                const tipo = MOVIMENTO_DE_PECA[m.kind]
                return (
                  <div
                    key={m.id}
                    data-testid="movimento-de-peca"
                    className="rounded-lg border border-[var(--color-border)] px-3 py-2"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm text-[var(--color-ink)]">{tipo.label}</span>
                      <span
                        className={`text-sm font-semibold tabular-nums ${
                          Number(m.quantity) > 0
                            ? 'text-[var(--color-ok-ink)]'
                            : 'text-[var(--color-breach-ink)]'
                        }`}
                      >
                        {descreverMovimentoDePeca({
                          kind: m.kind,
                          quantity: Number(m.quantity),
                          unidade: peca.unit,
                        })}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--color-ink-3)]">
                      {formatDate(m.created_at)}
                      {m.unit_cost !== null && ` · ${formatCurrency(Number(m.unit_cost))}/un`}
                      {m.notes && ` · ${m.notes}`}
                    </p>
                  </div>
                )
              })}
            </div>
          )}
          {cortados > 0 && (
            <p className="mt-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-ink-2)]">
              Mostrando os <strong>{doFoco.length} mais recentes</strong> de{' '}
              {(totalDeMovimentos ?? 0).toLocaleString('pt-BR')} movimentos neste depósito. Somar só
              o que está na tela dá outro número — o saldo acima é a soma de todos.
            </p>
          )}
          <p className="mt-2 text-xs text-[var(--color-ink-3)]">
            O razão não se edita nem se apaga. Errou? Lance o movimento contrário — os dois ficam à
            vista, que é o que torna o saldo explicável.
          </p>
        </section>

        {podeMovimentar && emFoco && (
          <>
            <section className="border-t border-[var(--color-border)] pt-4">
              <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
                Lançar movimento em {emFoco.depot_name}
              </h3>
              <MovimentoForm partId={peca.id} depotId={emFoco.depot_id} />
            </section>
            <section className="border-t border-[var(--color-border)] pt-4">
              <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Transferir</h3>
              <TransferenciaForm
                partId={peca.id}
                depotId={emFoco.depot_id}
                depositos={depositos ?? []}
              />
            </section>
          </>
        )}

        {podeGerenciar && emFoco && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
              Política em {emFoco.depot_name}
            </h3>
            <PoliticaForm
              partId={peca.id}
              depotId={emFoco.depot_id}
              min={emFoco.min_quantity === null ? null : Number(emFoco.min_quantity)}
              max={emFoco.max_quantity === null ? null : Number(emFoco.max_quantity)}
              prazo={emFoco.lead_time_days}
            />
          </section>
        )}

        {podeGerenciar && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Ficha da peça</h3>
            <PecaForm peca={peca} fabricantes={fabricantes ?? []} />
          </section>
        )}
      </CorpoDaGaveta>
    </Gaveta>
  )
}
