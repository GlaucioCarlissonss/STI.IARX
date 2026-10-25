'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'
import { CAMPOS_DE_TICKET, TRANSFORMACOES, lerMapaDeValores } from '@/lib/integrations/regras'

const uuid = z.string().uuid()

const regraSchema = z.object({
  integration_id: uuid,
  source_path: z
    .string()
    .trim()
    .min(1, 'O caminho de origem é obrigatório.')
    .max(200)
    /* Notação por ponto, com índice de array. O motor (`getByPath`) não entende
       nada além disso, e um caminho com colchetes falharia em silêncio: o campo
       viria vazio e o chamado nasceria incompleto. */
    .regex(
      /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/,
      'Use notação por ponto, como data.FIELDS_AFTER.TITLE. Índice de lista é um número: tags.0',
    ),
  target_field: z.enum(CAMPOS_DE_TICKET),
  transform: z.enum(TRANSFORMACOES),
  value_map: z.string().max(4000).optional(),
  default_value: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? v : null)),
  is_required: z.coerce.boolean(),
})

/**
 * Cria ou atualiza uma regra de mapeamento.
 *
 * ## O que ela recusa, e por quê
 *
 * `transform = 'value_map'` sem mapa de valores. É o erro que não dá erro: o
 * motor procura o valor na tabela de-para, não encontra nada porque a tabela
 * está vazia, e cai no `default_value` — que também costuma estar vazio. O
 * resultado é um chamado com o campo em branco, a partir do próximo evento, sem
 * nenhuma linha de log dizendo que algo deu errado.
 */
export async function salvarRegraDeMapeamento(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('integracoes.hub.mapear', {
    papel: 'config',
    mensagem: 'Sem permissão para editar o mapeamento.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = regraSchema.safeParse({
    integration_id: formData.get('integration_id'),
    source_path: formData.get('source_path'),
    target_field: formData.get('target_field'),
    transform: formData.get('transform'),
    value_map: formData.get('value_map') ?? '',
    default_value: formData.get('default_value') ?? '',
    is_required: formData.get('is_required') === 'on',
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }
  const d = parsed.data

  const mapa = lerMapaDeValores(d.value_map ?? '')
  if ('erro' in mapa) return { error: mapa.erro }

  if (d.transform === 'value_map' && Object.keys(mapa.valores).length === 0) {
    return {
      error:
        'Transformação "de-para" sem nenhum par de valores. Ela não daria erro: o campo viria em branco em todo chamado novo.',
    }
  }
  if (d.transform === 'constant' && !d.default_value) {
    return { error: 'Transformação "constante" precisa do valor constante no campo padrão.' }
  }

  const supabase = await createClient()
  const regraId = formData.get('regra_id')

  const linha = {
    tenant_id: profile.tenant_id,
    integration_id: d.integration_id,
    source_path: d.source_path,
    target_field: d.target_field,
    transform: d.transform,
    value_map: mapa.valores,
    default_value: d.default_value,
    is_required: d.is_required,
    updated_at: new Date().toISOString(),
  }

  const { data, error } =
    typeof regraId === 'string' && regraId
      ? await supabase.from('integration_mappings').update(linha).eq('id', regraId).select('id')
      : await supabase.from('integration_mappings').insert(linha).select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath(`/integracoes/${d.integration_id}`)
  return {
    success:
      'Regra salva, e uma versão do mapeamento inteiro foi gravada — dá para voltar a ela.',
  }
}

export async function removerRegraDeMapeamento(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('integracoes.hub.mapear', {
    papel: 'config',
    mensagem: 'Sem permissão para editar o mapeamento.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({ regra_id: uuid, integration_id: uuid })
    .safeParse({
      regra_id: formData.get('regra_id'),
      integration_id: formData.get('integration_id'),
    })
  if (!parsed.success) return { error: 'Regra inválida.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('integration_mappings')
    .delete()
    .eq('id', parsed.data.regra_id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath(`/integracoes/${parsed.data.integration_id}`)
  return { success: 'Regra removida. A versão anterior continua no histórico.' }
}

/**
 * Volta o mapeamento para uma versão anterior.
 *
 * A troca inteira acontece dentro de `integracao_restaurar_mapeamento()`, no
 * banco. Fazer `delete` e `insert` daqui, em duas chamadas, deixaria uma janela
 * com o mapeamento **vazio** — e uma integração recebendo evento nesse instante
 * criaria chamado sem campo nenhum.
 */
export async function restaurarMapeamento(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('integracoes.hub.mapear', {
    papel: 'config',
    mensagem: 'Sem permissão para restaurar o mapeamento.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({ integration_id: uuid, version: z.coerce.number().int().min(1) })
    .safeParse({
      integration_id: formData.get('integration_id'),
      version: formData.get('version'),
    })
  if (!parsed.success) return { error: 'Versão inválida.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('integracao_restaurar_mapeamento', {
    p_integration_id: parsed.data.integration_id,
    p_version: parsed.data.version,
  })

  if (error) return { error: mensagemDeErro(error) }

  revalidatePath(`/integracoes/${parsed.data.integration_id}`)
  return {
    success: `Mapeamento restaurado da versão ${parsed.data.version}: ${data ?? 0} regra(s). A restauração também virou versão.`,
  }
}
