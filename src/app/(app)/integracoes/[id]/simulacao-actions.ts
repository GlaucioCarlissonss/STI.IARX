'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/session'
import { applyMapping, normalizeBitrixTask, type MappingRule } from '@/lib/integrations/mapping'

export interface ResultadoDaSimulacao {
  error?: string
  campos?: { campo: string; valor: string; regra: string }[]
  buscas?: {
    campo: string
    procurando: string
    valor: string
    achou: string | null
    /** Quando preenchido: o webhook desta integração NÃO resolve esta busca. */
    naoResolvida?: string
  }[]
  erros?: string[]
  faltando?: string[]
}

const schema = z.object({
  integration_id: z.string().uuid(),
  payload: z.string().trim().min(2, 'Cole o payload que o sistema de origem envia.').max(200_000),
})

/**
 * Mostra o que um payload produziria — sem criar nada.
 *
 * ## Por que esta tela existe
 *
 * Erro de mapeamento é invisível até o evento real chegar, e quando chega já é
 * tarde: o chamado foi criado com o campo errado, ou em branco, e ninguém
 * recebe erro nenhum. Um `target_field` inválido não falha, um de-para
 * incompleto não falha, um caminho de origem digitado errado não falha. Os três
 * produzem a mesma coisa: um chamado pela metade, a partir do próximo evento.
 *
 * ## A propriedade que torna isto confiável
 *
 * Ela chama **`applyMapping`** — exatamente a mesma função que as Edge Functions
 * executam ao receber o evento de verdade. Não é uma reimplementação "para
 * efeito de simulação": uma segunda implementação divergiria em semanas, e a
 * simulação passaria a atestar o que o sistema não faz. Esse é o pior defeito
 * possível numa ferramenta de conferência — ela dá confiança falsa.
 *
 * ## E o que ela não faz
 *
 * Não escreve. Nenhum chamado, nenhum evento, nenhuma linha de log. As buscas
 * por pessoa e por fila são `select`, feitas com a sessão de quem pediu, e
 * servem para responder a pergunta que o motor sozinho não responde: **esse
 * e-mail existe aqui?**
 */
export async function simularPayload(
  _prev: ResultadoDaSimulacao,
  formData: FormData,
): Promise<ResultadoDaSimulacao> {
  const gate = await requirePermission('integracoes.hub.ver')
  if ('error' in gate) return { error: gate.error }

  const parsed = schema.safeParse({
    integration_id: formData.get('integration_id'),
    payload: formData.get('payload'),
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  let bruto: unknown
  try {
    bruto = JSON.parse(parsed.data.payload)
  } catch (e) {
    return {
      error: `O payload não é JSON válido: ${e instanceof Error ? e.message : 'erro de sintaxe'}`,
    }
  }

  const supabase = await createClient()
  const { data: integracao } = await supabase
    .from('integrations')
    .select('id, source_system, config')
    .eq('id', parsed.data.integration_id)
    .maybeSingle<{ id: string; source_system: string; config: Record<string, unknown> | null }>()

  if (!integracao) return { error: 'Integração não encontrada.' }

  const { data: regras } = await supabase
    .from('integration_mappings')
    .select('source_path, target_field, transform, value_map, default_value, is_required')
    .eq('integration_id', parsed.data.integration_id)
    .order('target_field')
    .returns<MappingRule[]>()

  if (!regras || regras.length === 0) {
    return { error: 'Esta integração não tem nenhuma regra de mapeamento cadastrada.' }
  }

  /* O Bitrix24 mistura camelCase e UPPER_SNAKE entre endpoints, e o webhook real
     normaliza antes de mapear. A simulação faz o mesmo passo — senão ela diria
     que `TITLE` não foi encontrado num payload onde o campo se chama `title`, e
     mandaria a pessoa "corrigir" um mapeamento que estava certo. */
  const payload =
    integracao.source_system === 'bitrix24' && bruto && typeof bruto === 'object'
      ? normalizeBitrixTask(bruto as Record<string, unknown>)
      : bruto

  const resultado = applyMapping(payload, regras)

  /*
   * As buscas, e a parte que só uma simulação honesta mostra.
   *
   * `applyMapping` devolve "procure esta pessoa", e PARA AÍ. Quem resolve a
   * busca é o webhook — e os dois webhooks desta base resolvem conjuntos
   * DIFERENTES:
   *
   *   · o do Bitrix24 resolve as três (a de ID externo chamando a API do
   *     Bitrix para descobrir o e-mail, e a de fila pelo mapa de grupos
   *     guardado em `integrations.config`);
   *   · o genérico resolve apenas a de e-mail.
   *
   * Uma regra `queue_by_external_id` numa integração genérica, portanto, não dá
   * erro nenhum: o campo simplesmente não é preenchido, e o chamado cai na fila
   * padrão para sempre. É o tipo de coisa que ninguém descobre lendo o
   * mapeamento — e que aparece aqui em uma linha.
   */
  const ehBitrix = integracao.source_system === 'bitrix24'
  const mapaDeGrupos = ((integracao.config ?? {}) as Record<string, unknown>)
    .group_to_queue_slug as Record<string, string> | undefined

  const buscas: NonNullable<ResultadoDaSimulacao['buscas']> = []
  for (const l of resultado.lookups) {
    if (l.kind === 'user_by_email') {
      const { data } = await supabase
        .from('profiles')
        .select('full_name')
        .ilike('email', l.value)
        .maybeSingle<{ full_name: string }>()
      buscas.push({
        campo: l.target_field,
        procurando: 'pessoa pelo e-mail',
        valor: l.value,
        achou: data?.full_name ?? null,
      })
      continue
    }

    if (l.kind === 'queue_by_external_id') {
      if (!ehBitrix) {
        buscas.push({
          campo: l.target_field,
          procurando: 'fila pelo identificador',
          valor: l.value,
          achou: null,
          naoResolvida: 'O webhook genérico não resolve busca de fila — o campo fica em branco.',
        })
        continue
      }
      const slug = mapaDeGrupos?.[l.value]
      if (!slug) {
        buscas.push({
          campo: l.target_field,
          procurando: 'fila pelo identificador',
          valor: l.value,
          achou: null,
          naoResolvida: `O grupo ${l.value} não está em group_to_queue_slug, na configuração desta integração.`,
        })
        continue
      }
      const { data } = await supabase
        .from('queues')
        .select('name')
        .eq('slug', slug)
        .maybeSingle<{ name: string }>()
      buscas.push({
        campo: l.target_field,
        procurando: `fila pelo grupo (${l.value} → ${slug})`,
        valor: l.value,
        achou: data?.name ?? null,
      })
      continue
    }

    // user_by_external_id
    buscas.push({
      campo: l.target_field,
      procurando: 'pessoa pelo ID do sistema de origem',
      valor: l.value,
      achou: null,
      naoResolvida: ehBitrix
        ? 'O webhook pergunta o e-mail dessa pessoa ao Bitrix24 na hora do evento. Não dá para conferir aqui sem chamar a API.'
        : 'O webhook genérico não resolve ID externo de pessoa — o campo fica em branco.',
    })
  }

  const campos = Object.entries(resultado.fields).map(([campo, valor]) => ({
    campo,
    valor: Array.isArray(valor) ? valor.join(', ') : String(valor),
    regra: regras.find((r) => r.target_field === campo)?.source_path ?? '—',
  }))

  /* O que o mapeamento promete e este payload não entregou. É a pergunta que a
     pessoa realmente tem: "faltou alguma coisa?" — e ela não aparece nem em
     `fields` nem em `errors` quando a regra é opcional e o campo veio vazio. */
  const preenchidos = new Set(Object.keys(resultado.fields))
  const pendentes = new Set(resultado.lookups.map((l) => l.target_field))
  const faltando = regras
    .map((r) => r.target_field)
    .filter((c) => !preenchidos.has(c) && !pendentes.has(c))

  return {
    campos,
    buscas,
    erros: resultado.errors,
    faltando: [...new Set(faltando)],
  }
}
