import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { getBranches } from '@/lib/data/lookups'
import type { Queue, QueueRule } from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import { EditQueueForm, NewQueueForm } from './queue-forms'
import {
  EditRuleForm,
  NewRuleForm,
  type CategoryOption,
  type PriorityOption,
} from './rule-forms'
import { ORIGENS } from './origens'

/**
 * A gaveta de /filas — quatro modos, dois registros.
 *
 * A tela tinha dois cadastros abertos o tempo todo ("Nova fila" e "Nova regra",
 * um cartão cada) e um `<details>` por fila mais um por regra. São dois tipos
 * de registro na mesma tela, e por isso a gaveta tem quatro modos em vez de
 * dois — mas continua sendo UMA gaveta: abrir uma regra fecha a fila que estava
 * aberta, porque não existe "editar a regra 3 da fila 2 ao mesmo tempo".
 *
 * ## Por que os lookups só são consultados no modo de regra
 *
 * Categoria, prioridade, filial e fila só aparecem no formulário de REGRA. No
 * modo de fila essas quatro consultas seriam trabalho jogado fora a cada
 * abertura — e a tela de filas já faz uma agregação de tickets em aberto.
 */
export async function GavetaDeFila({
  id,
  regra,
  novo,
  fechar,
}: {
  /** Fila aberta para edição. */
  id?: string
  /** Regra de roteamento aberta para edição. */
  regra?: string
  /** `fila` ou `regra` — qual cadastro abrir em branco. */
  novo?: string
  fechar: string
}) {
  const [podeCriarFila, podeEditarFila, podeInativarFila, podeConfigurar] = await Promise.all([
    allowed('helpdesk.filas.criar'),
    allowed('helpdesk.filas.editar'),
    allowed('helpdesk.filas.inativar'),
    allowed('helpdesk.filas.configurar_regras'),
  ])

  const supabase = await createClient()

  if (novo === 'fila') {
    if (!podeCriarFila) return null
    return (
      <Gaveta fechar={fechar} rotulo="Nova fila">
        <CabecalhoDaGaveta
          titulo="Nova fila"
          linha="Pesos do score de ordenação"
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <NewQueueForm />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  /* Regra — nova ou existente. Os lookups são os mesmos nos dois casos, então
     carregam juntos; a regra em si é a única consulta a mais. */
  if (novo === 'regra' || regra) {
    if (!podeConfigurar) return null

    const [{ data: queues }, { data: categories }, { data: priorities }, branches] =
      await Promise.all([
        supabase
          .from('queues')
          .select('id, name')
          .is('deleted_at', null)
          .order('name')
          .returns<{ id: string; name: string }[]>(),
        supabase
          .from('ticket_categories')
          .select('id, name, parent_id')
          .eq('is_active', true)
          .order('name')
          .returns<CategoryOption[]>(),
        supabase
          .from('ticket_priorities')
          .select('key, label')
          .eq('is_active', true)
          .order('sort_order')
          .returns<PriorityOption[]>(),
        getBranches(),
      ])

    const lookups = {
      queues: queues ?? [],
      categories: categories ?? [],
      priorities: priorities ?? [],
      branches,
      sources: [...ORIGENS],
    }

    if (novo === 'regra') {
      return (
        <Gaveta fechar={fechar} rotulo="Nova regra de roteamento">
          <CabecalhoDaGaveta
            titulo="Nova regra"
            linha="Condição → fila de destino"
            fechar={fechar}
          />
          <CorpoDaGaveta>
            <NewRuleForm {...lookups} />
          </CorpoDaGaveta>
        </Gaveta>
      )
    }

    const { data: aberta } = await supabase
      .from('queue_rules')
      .select('id, queue_id, name, conditions, sort_order, is_active')
      .eq('id', regra!)
      .maybeSingle<QueueRule>()

    if (!aberta) return null
    const destino = (queues ?? []).find((q) => q.id === aberta.queue_id)

    return (
      <Gaveta fechar={fechar} rotulo={aberta.name}>
        <CabecalhoDaGaveta
          titulo={aberta.name}
          linha={`Ordem ${aberta.sort_order} · vai para ${destino?.name ?? '—'}`}
          fechar={fechar}
          selo={aberta.is_active ? <Badge tone="ok">Ativa</Badge> : <Badge>Desativada</Badge>}
        />
        <CorpoDaGaveta>
          <EditRuleForm rule={aberta} {...lookups} />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!id) return null
  if (!podeEditarFila && !podeInativarFila) return null

  const { data: fila } = await supabase
    .from('queues')
    .select(
      'id, name, slug, description, is_system_default, is_active, weight_criticality, weight_deadline, weight_age',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle<Queue>()

  if (!fila) return null

  return (
    <Gaveta fechar={fechar} rotulo={fila.name}>
      <CabecalhoDaGaveta
        titulo={fila.name}
        linha={`${fila.slug} · score: criticidade ${fila.weight_criticality} · prazo ${fila.weight_deadline} · espera ${fila.weight_age}`}
        fechar={fechar}
        selo={
          <>
            {fila.is_system_default && <Badge tone="info">Padrão</Badge>}
            {fila.is_active ? <Badge tone="ok">Ativa</Badge> : <Badge>Inativa</Badge>}
          </>
        }
      />
      <CorpoDaGaveta>
        {fila.description && (
          <p className="text-sm text-[var(--color-ink-2)]">{fila.description}</p>
        )}
        <EditQueueForm queue={fila} podeInativar={podeInativarFila} />
      </CorpoDaGaveta>
    </Gaveta>
  )
}
