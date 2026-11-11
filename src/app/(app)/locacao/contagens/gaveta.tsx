import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { formatDate } from '@/lib/format'
import type { InventoryCount, InventoryCountItem, Part } from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import { ESTADO_DA_CONTAGEM, formatarQuantidade } from '@/lib/locacao/rotulos'
import {
  AbrirContagemForm,
  CancelarContagemForm,
  FecharContagemForm,
  LancarContagemForm,
} from './forms'

export async function GavetaDeContagem({
  id,
  novo,
  fechar,
}: {
  id?: string
  novo?: boolean
  fechar: string
}) {
  const [podeContar, podeFechar] = await Promise.all([
    allowed('locacao.contagens.contar'),
    allowed('locacao.contagens.fechar'),
  ])

  const supabase = await createClient()

  if (novo) {
    if (!podeContar) return null
    const [{ data: depositos }, { count }] = await Promise.all([
      supabase
        .from('rental_depots')
        .select('id, name')
        .is('deleted_at', null)
        .eq('is_active', true)
        .order('name')
        .returns<{ id: string; name: string }[]>(),
      supabase.from('inventory_counts').select('id', { count: 'exact', head: true }),
    ])

    return (
      <Gaveta fechar={fechar} rotulo="Abrir contagem">
        <CabecalhoDaGaveta
          titulo="Abrir contagem"
          linha="Congela o esperado de cada peça do depósito"
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <AbrirContagemForm
            depositos={depositos ?? []}
            codigoSugerido={`CT-${new Date().getFullYear()}-${String((count ?? 0) + 1).padStart(2, '0')}`}
          />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!id) return null

  const { data: contagem } = await supabase
    .from('inventory_counts')
    .select('id, depot_id, code, status, counted_on, closed_at, closed_by, notes')
    .eq('id', id)
    .maybeSingle<InventoryCount>()

  if (!contagem) return null

  const [{ data: itens }, { data: deposito }, { data: pecas }] = await Promise.all([
    supabase
      .from('inventory_count_items')
      .select('id, count_id, part_id, expected_quantity, counted_quantity')
      .eq('count_id', id)
      .returns<InventoryCountItem[]>(),
    supabase
      .from('rental_depots')
      .select('name')
      .eq('id', contagem.depot_id)
      .maybeSingle<{ name: string }>(),
    supabase
      .from('parts')
      .select('id, sku, name, manufacturer_id, unit, category, average_cost, notes, is_active')
      .is('deleted_at', null)
      .returns<Part[]>(),
  ])

  const porPeca = new Map((pecas ?? []).map((p) => [p.id, p]))
  const linhas = (itens ?? []).sort((a, b) =>
    (porPeca.get(a.part_id)?.sku ?? '').localeCompare(porPeca.get(b.part_id)?.sku ?? ''),
  )
  const pendentes = linhas.filter((i) => i.counted_quantity === null).length
  const divergentes = linhas.filter(
    (i) => i.counted_quantity !== null && Number(i.counted_quantity) !== Number(i.expected_quantity),
  )
  const estado = ESTADO_DA_CONTAGEM[contagem.status]
  const aberta = contagem.status === 'open'

  return (
    <Gaveta fechar={fechar} rotulo={`Contagem ${contagem.code}`}>
      <CabecalhoDaGaveta
        titulo={contagem.code}
        linha={`${deposito?.name ?? 'depósito'} · ${formatDate(contagem.counted_on)}`}
        fechar={fechar}
        selo={<Badge tone={estado.tone}>{estado.label}</Badge>}
      />

      <CorpoDaGaveta>
        <section data-testid="resumo-da-contagem">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[var(--color-ink-3)]">Peças a conferir</dt>
            <dd className="text-right font-medium tabular-nums">{linhas.length}</dd>
            <dt className="text-[var(--color-ink-3)]">Sem lançamento</dt>
            <dd
              className={`text-right font-medium tabular-nums ${
                pendentes > 0 ? 'text-[var(--color-warn-ink)]' : ''
              }`}
            >
              {pendentes}
            </dd>
            <dt className="text-[var(--color-ink-3)]">Divergentes</dt>
            <dd
              className={`text-right font-medium tabular-nums ${
                divergentes.length > 0 ? 'text-[var(--color-breach-ink)]' : ''
              }`}
            >
              {divergentes.length}
            </dd>
          </dl>
          {contagem.closed_at && (
            <p className="mt-2 text-xs text-[var(--color-ink-3)]">
              Fechada em {formatDate(contagem.closed_at)}. As diferenças viraram ajustes no razão —
              abra a peça em Estoque para ver o movimento.
            </p>
          )}
        </section>

        <section className="border-t border-[var(--color-border)] pt-4">
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
            Itens ({linhas.length})
          </h3>
          {linhas.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-3)]">
              O depósito não tinha peça com saldo quando a contagem foi aberta.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {linhas.map((i) => {
                const peca = porPeca.get(i.part_id)
                const dif =
                  i.counted_quantity === null
                    ? null
                    : Number(i.counted_quantity) - Number(i.expected_quantity)
                return (
                  <div
                    key={i.id}
                    data-testid="item-da-contagem"
                    className="rounded-lg border border-[var(--color-border)] px-3 py-2"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm text-[var(--color-ink)]">
                        {peca?.sku} · {peca?.name ?? 'peça removida'}
                      </span>
                      {dif !== null && (
                        <span
                          className={`text-sm font-semibold tabular-nums ${
                            dif === 0
                              ? 'text-[var(--color-ok-ink)]'
                              : 'text-[var(--color-breach-ink)]'
                          }`}
                        >
                          {dif === 0 ? 'confere' : `${dif > 0 ? '+' : '−'}${Math.abs(dif)}`}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--color-ink-3)]">
                      Esperado{' '}
                      {peca
                        ? formatarQuantidade(Number(i.expected_quantity), peca.unit)
                        : Number(i.expected_quantity)}
                      {i.counted_quantity === null
                        ? ' · ainda não contado'
                        : ` · contado ${Number(i.counted_quantity)}`}
                    </p>
                    {podeContar && aberta && (
                      <div className="mt-2">
                        <LancarContagemForm
                          id={i.id}
                          atual={i.counted_quantity === null ? null : Number(i.counted_quantity)}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {aberta && podeFechar && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Fechar</h3>
            <FecharContagemForm id={contagem.id} pendentes={pendentes} />
          </section>
        )}

        {aberta && podeContar && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Descartar</h3>
            <CancelarContagemForm id={contagem.id} />
            <p className="mt-2 text-xs text-[var(--color-ink-3)]">
              Cancelar não ajusta nada: o estoque fica exatamente como estava.
            </p>
          </section>
        )}

        {contagem.notes && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <p className="whitespace-pre-wrap text-sm text-[var(--color-ink-2)]">
              {contagem.notes}
            </p>
          </section>
        )}
      </CorpoDaGaveta>
    </Gaveta>
  )
}
