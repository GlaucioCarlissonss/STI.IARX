import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { comParametros } from '@/lib/data/endereco'
import { formatCurrency } from '@/lib/format'
import type { PartStock } from '@/lib/types'
import { Badge, EmptyState, FaixaDeIndicadores, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { FiltrosDeLista } from '@/components/filtros-de-lista'
import { formatarQuantidade, NIVEL_DO_ESTOQUE } from '@/lib/locacao/rotulos'
import { GavetaDePeca } from './gaveta'

export const metadata: Metadata = { title: 'Peças e estoque' }

export default async function PecasPage({
  searchParams,
}: {
  searchParams: Promise<{
    nivel?: string
    deposito?: string
    busca?: string
    aberto?: string
    novo?: string
  }>
}) {
  const params = await searchParams
  await requireScreen('locacao.pecas.ver')
  const podeGerenciar = await allowed('locacao.pecas.gerenciar')

  const supabase = await createClient()
  const [{ data: estoque }, { data: depositos }] = await Promise.all([
    supabase
      .from('vw_part_stock')
      .select(
        'part_id, sku, name, unit, category, average_cost, is_active, depot_id, depot_name, quantity, last_movement_at, min_quantity, max_quantity, lead_time_days, suggested_purchase, level, stock_value',
      )
      .order('sku')
      .returns<PartStock[]>(),
    supabase
      .from('rental_depots')
      .select('id, name')
      .is('deleted_at', null)
      .eq('is_active', true)
      .order('name')
      .returns<{ id: string; name: string }[]>(),
  ])

  const linhas = estoque ?? []

  const termo = params.busca?.trim().toLowerCase() ?? ''
  const filtrada = linhas.filter((l) => {
    if (params.deposito && l.depot_id !== params.deposito) return false
    if (params.nivel === 'repor' && !['abaixo', 'zerado'].includes(l.level)) return false
    if (params.nivel && params.nivel !== 'repor' && l.level !== params.nivel) return false
    if (termo) {
      const alvo = `${l.sku} ${l.name} ${l.category ?? ''}`.toLowerCase()
      if (!alvo.includes(termo)) return false
    }
    return true
  })

  const aRepor = linhas.filter((l) => l.level === 'abaixo' || l.level === 'zerado')
  const valor = linhas.reduce((s, l) => s + Number(l.stock_value), 0)
  const pecasDistintas = new Set(linhas.map((l) => l.part_id)).size
  /* Sem giro = sem movimento há 90 dias. É capital parado, e o número só tem
     sentido ao lado do valor em estoque — por isso os dois ficam na mesma
     faixa. */
  const corte = new Date()
  corte.setDate(corte.getDate() - 90)
  /* `new Date(...)` em volta do carimbo, e não comparação de texto: no modo
     local o driver `pg` entrega `timestamptz` como Date, e no Supabase vem
     string — comparar sem normalizar funcionaria num ambiente e não no outro. */
  const semGiro = linhas.filter(
    (l) => l.last_movement_at && new Date(l.last_movement_at).getTime() < corte.getTime(),
  ).length

  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/locacao/pecas', params, mudancas)
  const gavetaAberta = Boolean(params.aberto || params.novo)

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && (
        <GavetaDePeca
          parte={params.aberto}
          deposito={params.deposito}
          novo={Boolean(params.novo)}
          fechar={endereco({ aberto: null, novo: null })}
        />
      )}

      <PageHeader
        title="Peças e estoque"
        description="O saldo é a soma dos movimentos — nunca digitado. Abaixo do mínimo, a peça entra na reposição; o consumo vem do atendimento de campo."
        action={
          podeGerenciar && (
            <Link
              href={endereco({ novo: '1', aberto: null }) as Route}
              data-testid="novo-registro"
              className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
            >
              Cadastrar peça
            </Link>
          )
        }
      />

      <FaixaDeIndicadores>
        <StatTile
          label="A repor"
          value={aRepor.length}
          hint="abaixo do mínimo ou zeradas"
          tone={aRepor.length > 0 ? 'crit' : 'ok'}
        />
        <StatTile label="Peças no catálogo" value={pecasDistintas} hint={`em ${depositos?.length ?? 0} depósito(s)`} />
        <StatTile label="Valor em estoque" value={formatCurrency(valor)} hint="a custo médio" />
        <StatTile
          label="Sem giro há 90 dias"
          value={semGiro}
          hint="capital parado"
          tone={semGiro > 0 ? 'warn' : 'neutral'}
        />
      </FaixaDeIndicadores>

      <FiltrosDeLista
        base="/locacao/pecas"
        params={params}
        placeholder="SKU, nome ou categoria…"
        filtros={[
          {
            nome: 'deposito',
            rotulo: 'Depósito',
            valor: params.deposito ?? '',
            opcoes: [
              { valor: '', rotulo: 'Todos os depósitos' },
              ...(depositos ?? []).map((d) => ({ valor: d.id, rotulo: d.name })),
            ],
          },
          {
            nome: 'nivel',
            rotulo: 'Nível',
            valor: params.nivel ?? '',
            opcoes: [
              { valor: '', rotulo: 'Qualquer nível' },
              { valor: 'repor', rotulo: 'A repor (abaixo ou zerada)' },
              { valor: 'no_limite', rotulo: 'No limite' },
              { valor: 'em_nivel', rotulo: 'Em nível' },
              { valor: 'sem_politica', rotulo: 'Sem política' },
            ],
          },
        ]}
      />

      {filtrada.length === 0 ? (
        <EmptyState
          title={linhas.length === 0 ? 'Nenhuma peça com saldo ou política' : 'Nada com esse recorte'}
          description={
            linhas.length === 0
              ? 'Cadastre a primeira peça e lance uma entrada: o saldo nasce do movimento, não do cadastro.'
              : 'Troque o depósito ou o nível.'
          }
        />
      ) : (
        <Table
          label="Peças em estoque"
          head={['SKU', 'Peça', 'Depósito', 'Saldo', 'Mín/Máx', 'Situação']}
        >
          {filtrada.map((l) => {
            const nivel = NIVEL_DO_ESTOQUE[l.level]
            return (
              <tr key={`${l.part_id}-${l.depot_id}`}>
                <Td className="font-mono text-xs">
                  <Link
                    href={
                      endereco({ aberto: l.part_id, deposito: l.depot_id, novo: null }) as Route
                    }
                    data-testid="abrir-registro"
                    className="font-semibold text-[var(--color-brand-ink)] hover:underline"
                  >
                    {l.sku}
                  </Link>
                </Td>
                <Td className="font-medium text-[var(--color-ink)]">{l.name}</Td>
                <Td className="text-[var(--color-ink-2)]">{l.depot_name}</Td>
                <Td className="tabular-nums font-medium">
                  {formatarQuantidade(Number(l.quantity), l.unit)}
                </Td>
                <Td className="tabular-nums text-[var(--color-ink-2)]">
                  {l.min_quantity === null
                    ? '—'
                    : `${Number(l.min_quantity)} / ${Number(l.max_quantity)}`}
                </Td>
                <Td>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={nivel.tone}>{nivel.label}</Badge>
                    {Number(l.suggested_purchase ?? 0) > 0 && (
                      <Badge tone="info" testid="sugestao-de-compra">
                        comprar {Number(l.suggested_purchase)}
                      </Badge>
                    )}
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
