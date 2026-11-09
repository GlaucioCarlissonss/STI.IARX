import { createClient } from '@/lib/supabase/server'
import { escopoDeCliente, porCliente } from '@/lib/data/escopo'
import { allowed } from '@/lib/session'
import { getBranches, getBusinessHours, getCategories, getClients, getPriorities } from '@/lib/data/lookups'
import { formatMinutes } from '@/lib/format'
import type { Category, Priority, SlaContract } from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import { EditCategoryForm, NewCategoryForm } from './category-forms'
import { EditPriorityForm, NewPriorityForm } from './priority-forms'
import { EditSlaContractForm, NewSlaContractForm } from './sla-contract-forms'
import { EditSlaDefinitionForm, NewSlaDefinitionForm } from './sla-definition-forms'
import { SELECT_DE_DEFINICAO, type DefinitionRow } from './linhas'

/** Os quatro cadastros que moram em /sla. */
export const TIPOS_DE_SLA = ['categoria', 'prioridade', 'contrato', 'definicao'] as const
export type TipoDeSla = (typeof TIPOS_DE_SLA)[number]

/** `?tipo=` chega do endereço: valida contra a lista, não contra a fé. */
export function lerTipo(valor: string | undefined): TipoDeSla | undefined {
  return TIPOS_DE_SLA.find((t) => t === valor)
}

/**
 * A gaveta de /sla — quatro cadastros numa tela só.
 *
 * ## Por que quatro e não quatro telas
 *
 * Porque categoria, prioridade, contrato e definição só fazem sentido juntos:
 * a definição amarra os três outros, e separar em quatro rotas faria quem
 * configura SLA navegar em círculo para montar uma única regra de prazo.
 *
 * O que a Fase 5 desfaz aqui é outra coisa: esta tela tinha DEZ `<details>` —
 * um por categoria, um por categoria filha, um por prioridade, um por contrato,
 * um por definição e mais quatro de cadastro — todos abrindo formulário dentro
 * de um cartão de 23rem dentro de uma grade de duas colunas. Um formulário de
 * contrato de SLA tem sete campos; nenhum deles cabia.
 *
 * ## Por que cada modo consulta só o seu
 *
 * A tela já faz onze consultas para montar compliance e as quatro listas.
 * Carregar clientes, filiais, horários, categorias e prioridades a cada
 * abertura de gaveta — inclusive quando se abre uma PRIORIDADE, que não usa
 * nenhum desses — repetiria esse custo sem necessidade. Cada ramo abaixo
 * carrega o que o seu formulário pede, e nada além.
 */
export async function GavetaDeSla({
  tipo,
  id,
  novo,
  fechar,
}: {
  tipo: TipoDeSla
  id?: string
  novo?: boolean
  fechar: string
}) {
  if (!id && !novo) return null

  const supabase = await createClient()

  if (tipo === 'categoria') {
    const [podeCriar, podeEditar] = await Promise.all([
      allowed('sla.categorias.criar'),
      allowed('sla.categorias.editar'),
    ])
    if (novo ? !podeCriar : !podeEditar) return null

    /* Só as de primeiro nível podem ser mãe: a hierarquia tem dois níveis, e
       oferecer uma filha como mãe produziria um neto que o banco recusa. */
    const { data: categorias } = await supabase
      .from('ticket_categories')
      .select('id, parent_id, name, description, is_active')
      .order('name')
      .returns<Category[]>()

    const lista = categorias ?? []
    const topLevel = lista.filter((c) => c.parent_id === null)

    if (novo) {
      return (
        <Gaveta fechar={fechar} rotulo="Nova categoria">
          <CabecalhoDaGaveta
            titulo="Nova categoria"
            linha="Assunto do chamado, em até dois níveis"
            fechar={fechar}
          />
          <CorpoDaGaveta>
            <NewCategoryForm topLevel={topLevel} />
          </CorpoDaGaveta>
        </Gaveta>
      )
    }

    const categoria = lista.find((c) => c.id === id)
    if (!categoria) return null
    const mae = categoria.parent_id ? lista.find((c) => c.id === categoria.parent_id) : null

    return (
      <Gaveta fechar={fechar} rotulo={categoria.name}>
        <CabecalhoDaGaveta
          titulo={categoria.name}
          linha={mae ? `Dentro de ${mae.name}` : 'Categoria de primeiro nível'}
          fechar={fechar}
          selo={categoria.is_active ? <Badge tone="ok">Ativa</Badge> : <Badge>Inativa</Badge>}
        />
        <CorpoDaGaveta>
          <EditCategoryForm
            category={categoria}
            topLevel={topLevel.filter((c) => c.id !== categoria.id)}
          />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (tipo === 'prioridade') {
    const [podeCriar, podeEditar] = await Promise.all([
      allowed('sla.prioridades.criar'),
      allowed('sla.prioridades.editar'),
    ])
    if (novo ? !podeCriar : !podeEditar) return null

    if (novo) {
      return (
        <Gaveta fechar={fechar} rotulo="Nova prioridade">
          <CabecalhoDaGaveta
            titulo="Nova prioridade"
            linha="Peso, cor e ordem de exibição"
            fechar={fechar}
          />
          <CorpoDaGaveta>
            <NewPriorityForm />
          </CorpoDaGaveta>
        </Gaveta>
      )
    }

    const { data: prioridade } = await supabase
      .from('ticket_priorities')
      .select('id, key, label, weight, color, sort_order, is_active')
      .eq('id', id!)
      .maybeSingle<Priority>()

    if (!prioridade) return null

    return (
      <Gaveta fechar={fechar} rotulo={prioridade.label}>
        <CabecalhoDaGaveta
          titulo={prioridade.label}
          linha={`${prioridade.key} · peso ${prioridade.weight} · posição ${prioridade.sort_order}`}
          fechar={fechar}
          selo={prioridade.is_active ? <Badge tone="ok">Ativa</Badge> : <Badge>Inativa</Badge>}
        />
        <CorpoDaGaveta>
          <EditPriorityForm priority={prioridade} />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (tipo === 'contrato') {
    const [podeCriar, podeEditar, clients, branches, businessHours] = await Promise.all([
      allowed('sla.contratos.criar'),
      allowed('sla.contratos.editar'),
      getClients(),
      getBranches(),
      getBusinessHours(),
    ])
    if (novo ? !podeCriar : !podeEditar) return null
    const lookups = { clients, branches, businessHours }

    if (novo) {
      return (
        <Gaveta fechar={fechar} rotulo="Novo contrato de SLA">
          <CabecalhoDaGaveta
            titulo="Novo contrato de SLA"
            linha="Cliente, vigência e horário comercial"
            fechar={fechar}
          />
          <CorpoDaGaveta>
            <NewSlaContractForm {...lookups} />
          </CorpoDaGaveta>
        </Gaveta>
      )
    }

    const { data: contrato } = await supabase
      .from('sla_contracts')
      .select('id, client_id, branch_id, name, business_hours_id, valid_from, valid_to, is_active, notes')
      .eq('id', id!)
      .maybeSingle<SlaContract>()

    if (!contrato) return null
    const cliente = clients.find((c) => c.id === contrato.client_id)

    return (
      <Gaveta fechar={fechar} rotulo={contrato.name}>
        <CabecalhoDaGaveta
          titulo={contrato.name}
          linha={cliente ? (cliente.trade_name ?? cliente.legal_name) : 'Cliente removido'}
          fechar={fechar}
          selo={contrato.is_active ? <Badge tone="ok">Ativo</Badge> : <Badge>Inativo</Badge>}
        />
        <CorpoDaGaveta>
          <EditSlaContractForm contract={contrato} {...lookups} />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  /* Definição. */
  const [podeCriar, podeEditar, escopo, categories, priorities, businessHours] = await Promise.all([
    allowed('sla.definicoes.criar'),
    allowed('sla.definicoes.editar'),
    escopoDeCliente(),
    getCategories(),
    getPriorities(),
    getBusinessHours(),
  ])
  if (novo ? !podeCriar : !podeEditar) return null

  /* `sla_contracts.client_id` é NOT NULL: todo contrato tem dono, então aqui é
     `porCliente` e não a variante que inclui nulos. */
  const { data: contracts } = await porCliente(
    supabase
      .from('sla_contracts')
      .select('id, client_id, branch_id, name, business_hours_id, valid_from, valid_to, is_active, notes')
      .order('name'),
    escopo,
  ).returns<SlaContract[]>()

  const lookups = {
    contracts: contracts ?? [],
    categories,
    priorities,
    businessHours,
  }

  if (novo) {
    return (
      <Gaveta fechar={fechar} rotulo="Nova definição de SLA">
        <CabecalhoDaGaveta
          titulo="Nova definição de SLA"
          linha="Contrato + categoria + prioridade → prazos"
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <NewSlaDefinitionForm {...lookups} />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  const { data: definicao } = await supabase
    .from('sla_definitions')
    .select(SELECT_DE_DEFINICAO)
    .eq('id', id!)
    .maybeSingle<DefinitionRow>()

  if (!definicao) return null

  return (
    <Gaveta fechar={fechar} rotulo="Definição de SLA">
      <CabecalhoDaGaveta
        titulo={`${definicao.priority?.label ?? '—'} · ${definicao.category?.name ?? 'todas as categorias'}`}
        linha={`${definicao.contract?.name ?? 'Padrão do tenant'} · 1ª resposta ${formatMinutes(
          definicao.first_response_minutes,
        )} · resolução ${formatMinutes(definicao.resolution_minutes)}`}
        fechar={fechar}
        selo={definicao.is_active ? <Badge tone="ok">Ativa</Badge> : <Badge>Inativa</Badge>}
      />
      <CorpoDaGaveta>
        <EditSlaDefinitionForm definition={definicao} {...lookups} />
      </CorpoDaGaveta>
    </Gaveta>
  )
}
