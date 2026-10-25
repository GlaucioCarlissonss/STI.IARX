'use server'

import { randomBytes, createHash } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { optionalUuid, uuid } from '@/lib/schemas/campos'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'

const canalSchema = z.object({
  name: z.string().trim().min(2, 'Dê um nome ao canal (ex.: WhatsApp da matriz).').max(120),
  kind: z.enum(['whatsapp', 'email', 'bitrix24', 'n8n']),
  secret_ref: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .regex(
          /^[A-Z][A-Z0-9_]{2,60}$/,
          'Aqui vai o NOME da variável de ambiente (ex.: WHATSAPP_TOKEN_MATRIZ), nunca o valor.',
        ),
    ])
    .transform((v) => (v === '' ? null : v)),
  config: z.string().trim(),
  default_queue_id: optionalUuid,
  default_priority_id: optionalUuid,
  default_client_id: optionalUuid,
  abre_chamado: z.coerce.boolean(),
})

export interface CanalActionState extends ActionState {
  /** O token em claro. Só existe nesta resposta — depois, só o hash. */
  plainToken?: string
}

/**
 * Liga um canal.
 *
 * ## O que esta ação NÃO aceita
 *
 * O valor de nenhuma credencial. `secret_ref` é o **nome** de uma variável de
 * ambiente, e o schema recusa qualquer coisa que não tenha a cara de um
 * identificador em maiúsculas — inclusive, e principalmente, um token de acesso
 * da Meta, que começa com `EAA` e tem 200 caracteres.
 *
 * É o ADR-009 aplicado: o banco guarda a referência, o ambiente guarda o valor. A
 * mensagem de erro diz isso em português, porque quem está preenchendo o
 * formulário acabou de copiar o token do painel da Meta e vai tentar colá-lo
 * aqui.
 */
export async function salvarCanal(
  _prev: CanalActionState,
  formData: FormData,
): Promise<CanalActionState> {
  const gate = await permitirEscrita('canais.canais.gerenciar', {
    papel: 'config',
    mensagem: 'Sem permissão para configurar canais.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = canalSchema.safeParse({
    name: formData.get('name'),
    kind: formData.get('kind'),
    secret_ref: formData.get('secret_ref') ?? '',
    config: formData.get('config') ?? '{}',
    default_queue_id: formData.get('default_queue_id'),
    default_priority_id: formData.get('default_priority_id'),
    default_client_id: formData.get('default_client_id'),
    abre_chamado: formData.get('abre_chamado') === 'on',
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  let config: unknown
  try {
    config = JSON.parse(parsed.data.config || '{}')
  } catch {
    return { error: 'A configuração não é um JSON válido.' }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { error: 'A configuração precisa ser um objeto JSON.' }
  }

  /*
   * A mesma regra do `secret_ref` vale para os campos de `config` que terminam em
   * `_ref`: eles também são NOMES de variáveis. Sem esta conferência, o App
   * Secret da Meta entraria em `config.app_secret_ref` como valor — e `config` é
   * lido por qualquer administrador, aparece em backup e em export de suporte.
   */
  for (const [chave, valor] of Object.entries(config)) {
    if (chave.endsWith('_ref') && typeof valor === 'string') {
      if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(valor)) {
        return {
          error: `"${chave}" é o NOME de uma variável de ambiente (ex.: META_APP_SECRET), nunca o valor dela.`,
        }
      }
    }
  }

  if (parsed.data.abre_chamado && (!parsed.data.default_queue_id || !parsed.data.default_priority_id)) {
    /* O banco também recusa (CHECK `channel_abre_precisa_de_destino`), mas a
       mensagem dele fala de constraint. Esta diz o que fazer. */
    return {
      error: 'Canal que abre chamado precisa de fila e prioridade: sem elas, a mensagem se perderia.',
    }
  }

  /*
   * 32 bytes em hexa. O token vai na URL que o provedor chama, então ele É a
   * credencial de entrada — e, no caso do N8N e do e-mail, é a ÚNICA (nenhum dos
   * dois assina). Por isso o tamanho não é negociável.
   */
  const plain = randomBytes(32).toString('hex')
  const hash = createHash('sha256').update(plain).digest('hex')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('channels')
    .insert({
      tenant_id: profile.tenant_id,
      name: parsed.data.name,
      kind: parsed.data.kind,
      inbound_token_hash: hash,
      secret_ref: parsed.data.secret_ref,
      config,
      default_queue_id: parsed.data.default_queue_id,
      default_priority_id: parsed.data.default_priority_id,
      default_client_id: parsed.data.default_client_id,
      abre_chamado: parsed.data.abre_chamado,
      created_by: profile.id,
    })
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/conversas/canais')
  return {
    success: 'Canal criado. Copie a URL agora — ela não aparece de novo.',
    plainToken: plain,
  }
}

const estadoSchema = z.object({
  channel_id: uuid,
  status: z.enum(['ativo', 'pausado']),
})

/**
 * Pausa ou religa um canal.
 *
 * Pausar não desliga o webhook: a rota continua respondendo **200** e descartando
 * a mensagem. É deliberado — a Meta desinscreve um webhook que devolve erro
 * repetidamente, e aí religar exigiria refazer a configuração dela. Pausado
 * significa "não processe", não "estou quebrado".
 */
export async function mudarEstadoDoCanal(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('canais.canais.gerenciar', {
    papel: 'config',
    mensagem: 'Sem permissão para configurar canais.',
  })
  if ('error' in gate) return gate

  const parsed = estadoSchema.safeParse({
    channel_id: formData.get('channel_id'),
    status: formData.get('status'),
  })
  if (!parsed.success) return { error: 'Canal inválido.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('channels')
    .update({ status: parsed.data.status })
    .eq('id', parsed.data.channel_id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/conversas/canais')
  return {
    success:
      parsed.data.status === 'pausado'
        ? 'Canal pausado. As mensagens continuam sendo aceitas e descartadas — o webhook do provedor não é desligado.'
        : 'Canal religado.',
  }
}

const contatoSchema = z.object({
  contact_id: uuid,
  profile_id: optionalUuid,
  client_id: optionalUuid,
  branch_id: optionalUuid,
  display_name: z
    .string()
    .trim()
    .max(200)
    .transform((v) => (v === '' ? null : v)),
  bloqueado: z.coerce.boolean(),
})

/**
 * Diz de quem é o número.
 *
 * É a ação que tira o chamado do anonimato. Um contato sem pessoa e sem cliente
 * abre chamado sem SLA, sem pesquisa de satisfação e fora do painel da empresa
 * certa — e isso é silencioso: o chamado funciona, só está no lugar errado.
 *
 * Classificar é trabalho de quem ATENDE, não de quem administra: é na conversa
 * que se descobre quem é o número. Por isso a permissão é
 * `canais.conversas.responder`, e não `canais.canais.gerenciar`.
 */
export async function classificarContato(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('canais.conversas.responder', {
    mensagem: 'Sem permissão para classificar contatos.',
  })
  if ('error' in gate) return gate

  const parsed = contatoSchema.safeParse({
    contact_id: formData.get('contact_id'),
    profile_id: formData.get('profile_id'),
    client_id: formData.get('client_id'),
    branch_id: formData.get('branch_id'),
    display_name: formData.get('display_name') ?? '',
    bloqueado: formData.get('bloqueado') === 'on',
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const { contact_id, ...valores } = parsed.data
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('channel_contacts')
    .update(valores)
    .eq('id', contact_id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  /* 'layout' e não a página: a classificação é feita DENTRO da conversa, e
     revalidar só `/conversas` deixaria a tela onde a pessoa está mostrando o
     valor antigo — ela salvaria de novo achando que não funcionou. */
  revalidatePath('/conversas', 'layout')
  return {
    success: valores.bloqueado
      ? 'Contato bloqueado. As mensagens continuam sendo registradas e não abrem mais chamado.'
      : 'Contato classificado. Os próximos chamados dele já nascem no lugar certo.',
  }
}
