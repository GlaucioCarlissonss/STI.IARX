'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'
import { credencialDaIA } from '@/lib/ia/tipos'

const configSchema = z.object({
  enabled: z.coerce.boolean(),
  model: z.string().trim().min(3).max(80),
  effort: z.enum(['low', 'medium', 'high']),
  secret_ref: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .regex(
          /^[A-Z][A-Z0-9_]{2,60}$/,
          'Aqui vai o NOME da variável de ambiente (ex.: ANTHROPIC_API_KEY), nunca a chave.',
        ),
    ])
    .transform((v) => (v === '' ? null : v)),
  sugerir_resposta: z.coerce.boolean(),
  sugerir_triagem: z.coerce.boolean(),
  redigir_artigo: z.coerce.boolean(),
  enviar_notas_internas: z.coerce.boolean(),
  /* Em reais de centavo, digitado em dólares inteiros — ninguém quer digitar
     "5000" para dizer cinquenta dólares. */
  limite_mensal_dolares: z.coerce.number().int().min(0).max(1000000),
})

/**
 * Salva a configuração de IA do tenant.
 *
 * ## O que esta ação recusa
 *
 * A chave. `secret_ref` é o **nome** de uma variável de ambiente, e o schema
 * recusa qualquer coisa que não tenha cara de identificador em maiúsculas —
 * inclusive, e principalmente, uma chave da Anthropic, que começa com `sk-ant-` e
 * tem cem caracteres. É o ADR-009 aplicado, igual aos canais (0034).
 *
 * ## E o que ela confere antes de deixar ligar
 *
 * Que a variável nomeada **existe de fato no servidor**. É a conferência que
 * economiza o chamado "liguei a IA e não funciona": sem ela, a configuração fica
 * aparentemente correta e todo pedido de sugestão volta com uma recusa genérica.
 */
export async function salvarConfigDeIA(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('ia.config.gerenciar', {
    papel: 'config',
    mensagem: 'Sem permissão para configurar a IA.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = configSchema.safeParse({
    enabled: formData.get('enabled') === 'on',
    model: formData.get('model'),
    effort: formData.get('effort'),
    secret_ref: formData.get('secret_ref') ?? '',
    sugerir_resposta: formData.get('sugerir_resposta') === 'on',
    sugerir_triagem: formData.get('sugerir_triagem') === 'on',
    redigir_artigo: formData.get('redigir_artigo') === 'on',
    enviar_notas_internas: formData.get('enviar_notas_internas') === 'on',
    limite_mensal_dolares: formData.get('limite_mensal_dolares') ?? 0,
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }
  const d = parsed.data

  if (d.enabled && !d.secret_ref) {
    /* O banco também recusa (CHECK `ia_ligada_tem_credencial`), mas a mensagem
       dele fala de constraint. Esta diz o que fazer. */
    return { error: 'Para ligar a IA é preciso informar a variável com a chave.' }
  }

  if (d.enabled && !credencialDaIA(d.secret_ref)) {
    return {
      error: `A variável "${d.secret_ref}" não existe no servidor (ou está vazia). Defina-a no ambiente antes de ligar a IA.`,
    }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('ai_settings')
    .upsert(
      {
        tenant_id: profile.tenant_id,
        enabled: d.enabled,
        model: d.model,
        effort: d.effort,
        secret_ref: d.secret_ref,
        sugerir_resposta: d.sugerir_resposta,
        sugerir_triagem: d.sugerir_triagem,
        redigir_artigo: d.redigir_artigo,
        enviar_notas_internas: d.enviar_notas_internas,
        limite_mensal_centavos: d.limite_mensal_dolares * 100,
        updated_at: new Date().toISOString(),
        updated_by: profile.id,
      },
      { onConflict: 'tenant_id' },
    )
    .select('tenant_id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/ia')
  return {
    success: d.enabled
      ? 'Configuração salva. A IA está ligada — cada sugestão pedida custa dinheiro.'
      : 'Configuração salva. A IA está desligada e nada é enviado a provedor nenhum.',
  }
}
