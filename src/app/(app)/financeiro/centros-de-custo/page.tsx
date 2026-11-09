import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { getBranches } from '@/lib/data/lookups'
import { comParametros } from '@/lib/data/endereco'
import type { CostCenter } from '@/lib/types'
import { Badge, EmptyState, PageHeader } from '@/components/ui'
import { GavetaDeCentro } from './gaveta'

export const metadata: Metadata = { title: 'Centros de custo' }

export default async function CentrosDeCustoPage({
  searchParams,
}: {
  searchParams: Promise<{ aberto?: string; novo?: string }>
}) {
  const params = await searchParams
  await requireScreen('financeiro.centros_custo.ver')
  const [podeEditar, podeCriar] = await Promise.all([
    allowed('financeiro.centros_custo.editar'),
    allowed('financeiro.centros_custo.criar'),
  ])

  const supabase = await createClient()
  const [{ data: centers }, branches] = await Promise.all([
    supabase
      .from('cost_centers')
      .select('id, parent_id, code, name, description, branch_id, is_active')
      .order('code')
      .returns<CostCenter[]>(),
    getBranches(),
  ])

  const list = centers ?? []
  const branchName = new Map(branches.map((b) => [b.id, b.name]))
  const filhosDe = (id: string | null) => list.filter((c) => c.parent_id === id)

  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/financeiro/centros-de-custo', params, mudancas)

  const linha = (c: CostCenter, nivel: number) => (
    <div key={c.id} style={{ marginLeft: `${(nivel - 1) * 1.25}rem` }}>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2">
        <div className="min-w-0">
          <span className="font-mono text-xs text-[var(--color-ink-3)]">{c.code}</span>{' '}
          <span className="font-medium text-[var(--color-ink)]">{c.name}</span>
          <p className="text-xs text-[var(--color-ink-3)]">
            {c.branch_id ? (branchName.get(c.branch_id) ?? 'filial removida') : 'Global'}
            {c.description ? ` · ${c.description}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {c.is_active ? <Badge tone="ok">Ativo</Badge> : <Badge>Inativo</Badge>}
          {podeEditar && (
            <Link
              href={endereco({ aberto: c.id }) as Route}
              data-testid="abrir-registro"
              className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-sm font-medium text-[var(--color-brand-ink)] hover:bg-[var(--color-surface-2)]"
            >
              Editar
            </Link>
          )}
        </div>
      </div>
      {filhosDe(c.id).map((f) => linha(f, nivel + 1))}
    </div>
  )

  const gavetaAberta = Boolean(params.aberto || params.novo)

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && (
        <GavetaDeCentro
          id={params.aberto}
          novo={Boolean(params.novo)}
          fechar={endereco({ aberto: null, novo: null })}
        />
      )}

      <PageHeader
        title="Centros de custo"
        description="Dimensão de rateio dos lançamentos financeiros, em até 3 níveis. Um centro sem filial vale para todo o tenant; com filial, permite cobrar o custo por unidade."
        action={
          podeCriar && (
            <Link
              href={endereco({ novo: '1' }) as Route}
              data-testid="novo-registro"
              className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
            >
              Novo centro de custo
            </Link>
          )
        }
      />

      {/* A árvore ocupa a tela inteira: ela é larga por natureza — código,
          nome, filial, descrição e o recuo de três níveis — e era justamente
          ela que dividia a largura com o formulário de cadastro. */}
      <div className="flex flex-col gap-2">
        {list.length === 0 && (
          <EmptyState
            title="Nenhum centro de custo cadastrado"
            description="Sem centro de custo, os lançamentos financeiros não têm como ser rateados por área."
          />
        )}
        {filhosDe(null).map((c) => linha(c, 1))}
      </div>
    </div>
  )
}
