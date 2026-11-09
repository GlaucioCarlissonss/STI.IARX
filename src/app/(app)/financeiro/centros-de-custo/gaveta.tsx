import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { getBranches } from '@/lib/data/lookups'
import type { CostCenter } from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import { EditCostCenterForm, NewCostCenterForm } from './forms'

/**
 * O centro de custo na gaveta.
 *
 * A árvore de centros é larga por natureza — código, nome, filial, descrição e
 * o recuo dos três níveis. Era justamente ela que dividia a tela com uma coluna
 * de 23rem de formulário, e por isso a descrição aparecia cortada.
 *
 * O nível máximo é regra do BANCO, não da tela: só nível 1 e 2 podem receber
 * filho, e é por isso que o seletor de pai recebe a lista já filtrada —
 * oferecer um pai impossível produziria erro depois do clique.
 */
export async function GavetaDeCentro({
  id,
  novo,
  fechar,
}: {
  id?: string
  novo?: boolean
  fechar: string
}) {
  const [podeEditar, podeCriar, branches] = await Promise.all([
    allowed('financeiro.centros_custo.editar'),
    allowed('financeiro.centros_custo.criar'),
    getBranches(),
  ])

  const supabase = await createClient()
  const { data: centers } = await supabase
    .from('cost_centers')
    .select('id, parent_id, code, name, description, branch_id, is_active')
    .order('code')
    .returns<CostCenter[]>()

  const lista = centers ?? []
  const nivelDe = (c: CostCenter): number => {
    let n = 1
    let atual = c.parent_id
    while (atual) {
      n += 1
      atual = lista.find((x) => x.id === atual)?.parent_id ?? null
    }
    return n
  }
  const paisPossiveis = lista.filter((c) => nivelDe(c) < 3)

  if (novo) {
    if (!podeCriar) return null
    return (
      <Gaveta fechar={fechar} rotulo="Novo centro de custo">
        <CabecalhoDaGaveta
          titulo="Novo centro de custo"
          linha="Dimensão de rateio dos lançamentos"
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <NewCostCenterForm centers={paisPossiveis} branches={branches} />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!id) return null
  const centro = lista.find((c) => c.id === id)
  if (!centro || !podeEditar) return null

  const filial = branches.find((b) => b.id === centro.branch_id)

  return (
    <Gaveta fechar={fechar} rotulo={centro.name}>
      <CabecalhoDaGaveta
        titulo={centro.name}
        linha={`${centro.code} · ${filial ? filial.name : 'Global'} · nível ${nivelDe(centro)}`}
        fechar={fechar}
        selo={centro.is_active ? <Badge tone="ok">Ativo</Badge> : <Badge>Inativo</Badge>}
      />
      <CorpoDaGaveta>
        <EditCostCenterForm
          center={centro}
          centers={paisPossiveis.filter((c) => c.id !== centro.id)}
          branches={branches}
        />
      </CorpoDaGaveta>
    </Gaveta>
  )
}
