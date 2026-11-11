import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { comParametros } from '@/lib/data/endereco'
import { formatDate } from '@/lib/format'
import type { InventoryCount, InventoryCountItem } from '@/lib/types'
import { Badge, EmptyState, FaixaDeIndicadores, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { FiltrosDeLista } from '@/components/filtros-de-lista'
import { ESTADO_DA_CONTAGEM } from '@/lib/locacao/rotulos'
import { GavetaDeContagem } from './gaveta'

export const metadata: Metadata = { title: 'Contagens de inventário' }

export default async function ContagensPage({
  searchParams,
}: {
  searchParams: Promise<{
    estado?: string
    deposito?: string
    busca?: string
    aberto?: string
    novo?: string
  }>
}) {
  const params = await searchParams
  await requireScreen('locacao.contagens.ver')
  const podeContar = await allowed('locacao.contagens.contar')

  const supabase = await createClient()
  const [{ data: contagens }, { data: itens }, { data: depositos }] = await Promise.all([
    supabase
      .from('inventory_counts')
      .select('id, depot_id, code, status, counted_on, closed_at, closed_by, notes')
      .order('counted_on', { ascending: false })
      .returns<InventoryCount[]>(),
    supabase
      .from('inventory_count_items')
      .select('id, count_id, part_id, expected_quantity, counted_quantity')
      .returns<InventoryCountItem[]>(),
    supabase
      .from('rental_depots')
      .select('id, name')
      .is('deleted_at', null)
      .order('name')
      .returns<{ id: string; name: string }[]>(),
  ])

  const lista = contagens ?? []
  const nome = new Map((depositos ?? []).map((d) => [d.id, d.name]))

  const porContagem = new Map<string, InventoryCountItem[]>()
  for (const i of itens ?? []) {
    const atual = porContagem.get(i.count_id) ?? []
    atual.push(i)
    porContagem.set(i.count_id, atual)
  }

  const resumo = (c: InventoryCount) => {
    const linhas = porContagem.get(c.id) ?? []
    const pendentes = linhas.filter((i) => i.counted_quantity === null).length
    const divergentes = linhas.filter(
      (i) =>
        i.counted_quantity !== null &&
        Number(i.counted_quantity) !== Number(i.expected_quantity),
    ).length
    return { total: linhas.length, pendentes, divergentes }
  }

  const termo = params.busca?.trim().toLowerCase() ?? ''
  const filtrada = lista.filter((c) => {
    if (params.estado && c.status !== params.estado) return false
    if (params.deposito && c.depot_id !== params.deposito) return false
    if (termo) {
      const alvo = `${c.code} ${nome.get(c.depot_id) ?? ''}`.toLowerCase()
      if (!alvo.includes(termo)) return false
    }
    return true
  })

  const abertas = lista.filter((c) => c.status === 'open')
  const pendentes = abertas.reduce((s, c) => s + resumo(c).pendentes, 0)
  const fechadas = lista.filter((c) => c.status === 'closed')
  const comDiferenca = fechadas.filter((c) => resumo(c).divergentes > 0).length

  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/locacao/contagens', params, mudancas)
  const gavetaAberta = Boolean(params.aberto || params.novo)

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && (
        <GavetaDeContagem
          id={params.aberto}
          novo={Boolean(params.novo)}
          fechar={endereco({ aberto: null, novo: null })}
        />
      )}

      <PageHeader
        title="Contagens de inventário"
        description="Abrir congela o esperado; fechar transforma cada diferença em um movimento de ajuste, com o esperado e o contado escritos. Nada é apagado."
        action={
          podeContar && (
            <Link
              href={endereco({ novo: '1', aberto: null }) as Route}
              data-testid="novo-registro"
              className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
            >
              Abrir contagem
            </Link>
          )
        }
      />

      <FaixaDeIndicadores>
        <StatTile
          label="Em contagem"
          value={abertas.length}
          hint="depósitos sendo conferidos"
          tone={abertas.length > 0 ? 'warn' : 'neutral'}
        />
        <StatTile
          label="Peças a contar"
          value={pendentes}
          hint="sem lançamento nas contagens abertas"
          tone={pendentes > 0 ? 'warn' : 'ok'}
        />
        <StatTile label="Fechadas" value={fechadas.length} hint="já viraram ajuste" tone="ok" />
        <StatTile
          label="Fechadas com diferença"
          value={comDiferenca}
          hint="perda ou sobra reconhecida"
          tone={comDiferenca > 0 ? 'crit' : 'ok'}
        />
      </FaixaDeIndicadores>

      <FiltrosDeLista
        base="/locacao/contagens"
        params={params}
        placeholder="Código ou depósito…"
        filtros={[
          {
            nome: 'estado',
            rotulo: 'Estado',
            valor: params.estado ?? '',
            opcoes: [
              { valor: '', rotulo: 'Qualquer estado' },
              ...(Object.keys(ESTADO_DA_CONTAGEM) as (keyof typeof ESTADO_DA_CONTAGEM)[]).map(
                (s) => ({ valor: s, rotulo: ESTADO_DA_CONTAGEM[s].label }),
              ),
            ],
          },
          {
            nome: 'deposito',
            rotulo: 'Depósito',
            valor: params.deposito ?? '',
            opcoes: [
              { valor: '', rotulo: 'Todos os depósitos' },
              ...(depositos ?? []).map((d) => ({ valor: d.id, rotulo: d.name })),
            ],
          },
        ]}
      />

      {filtrada.length === 0 ? (
        <EmptyState
          title={lista.length === 0 ? 'Nenhuma contagem ainda' : 'Nada com esse recorte'}
          description={
            lista.length === 0
              ? 'Abra a primeira: o esperado de cada peça é congelado na abertura, e o que divergir vira ajuste quando você fechar.'
              : 'Troque o estado ou o depósito.'
          }
        />
      ) : (
        <Table
          label="Contagens de inventário"
          head={['Código', 'Depósito', 'Data', 'Itens', 'Diferenças', 'Situação']}
        >
          {filtrada.map((c) => {
            const estado = ESTADO_DA_CONTAGEM[c.status]
            const r = resumo(c)
            return (
              <tr key={c.id}>
                <Td className="font-mono text-xs">
                  <Link
                    href={endereco({ aberto: c.id, novo: null }) as Route}
                    data-testid="abrir-registro"
                    className="font-semibold text-[var(--color-brand-ink)] hover:underline"
                  >
                    {c.code}
                  </Link>
                </Td>
                <Td className="font-medium text-[var(--color-ink)]">
                  {nome.get(c.depot_id) ?? 'depósito removido'}
                </Td>
                <Td className="tabular-nums text-[var(--color-ink-2)]">
                  {formatDate(c.counted_on)}
                </Td>
                <Td className="tabular-nums text-[var(--color-ink-2)]">
                  {r.total}
                  {r.pendentes > 0 && (
                    <span className="ml-1 text-xs text-[var(--color-warn-ink)]">
                      · {r.pendentes} a contar
                    </span>
                  )}
                </Td>
                <Td className="tabular-nums font-medium">
                  {c.status === 'open' && r.pendentes > 0 ? '—' : r.divergentes}
                </Td>
                <Td>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={estado.tone}>{estado.label}</Badge>
                    {c.status === 'closed' && r.divergentes > 0 && (
                      <Badge tone="crit" testid="selo-de-diferenca">
                        {r.divergentes} ajuste(s)
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
