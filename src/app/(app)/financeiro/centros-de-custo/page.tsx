import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { getBranches } from '@/lib/data/lookups'
import type { CostCenter } from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui'
import { EditPanel } from '@/components/edit-panel'
import { EditCostCenterForm, NewCostCenterForm } from './forms'

export const metadata: Metadata = { title: 'Centros de custo' }

export default async function CentrosDeCustoPage() {
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

  // Só nível 1 e 2 podem receber filho: o banco recusa o 4º nível, e oferecer um
  // pai impossível no seletor produziria erro depois do clique.
  const nivelDe = (c: CostCenter): number => {
    let n = 1
    let atual = c.parent_id
    while (atual) {
      n += 1
      atual = list.find((x) => x.id === atual)?.parent_id ?? null
    }
    return n
  }
  const paisPossiveis = list.filter((c) => nivelDe(c) < 3)

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
            <EditPanel title={`Editar ${c.name}`}>
              <EditCostCenterForm center={c} centers={paisPossiveis} branches={branches} />
            </EditPanel>
          )}
        </div>
      </div>
      {filhosDe(c.id).map((f) => linha(f, nivel + 1))}
    </div>
  )

  return (
    <>
      <PageHeader
        title="Centros de custo"
        description="Dimensão de rateio dos lançamentos financeiros, em até 3 níveis. Um centro sem filial vale para todo o tenant; com filial, permite cobrar o custo por unidade."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="flex flex-col gap-2">
          {list.length === 0 && (
            <EmptyState
              title="Nenhum centro de custo cadastrado"
              description="Sem centro de custo, os lançamentos financeiros não têm como ser rateados por área."
            />
          )}
          {filhosDe(null).map((c) => linha(c, 1))}
        </div>

        {podeCriar && (
          <Card title="Novo centro de custo">
            <NewCostCenterForm centers={paisPossiveis} branches={branches} />
          </Card>
        )}
      </div>
    </>
  )
}
