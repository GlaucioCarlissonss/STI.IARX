'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { optionalUuid, uuid } from '@/lib/schemas/campos'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { requirePermission, requireSession } from '@/lib/session'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import { camposSchema, lerCampos, validarPreenchimento } from '@/lib/catalogo/campos'
import type { ActionState } from '@/lib/actions/estado'

/**
 * Pedir um serviço do catálogo.
 *
 * ## O pedido vira um CHAMADO, e não um "pedido"
 *
 * Uma entidade própria para pedido teria o próprio estado, a própria fila e o
 * próprio SLA — e a operação passaria a olhar duas listas, uma delas sem o
 * ferramental que o chamado já tem (histórico, comentários, anexos, prazo,
 * pesquisa de satisfação). O pedido é um chamado que nasceu de um formulário.
 *
 * ## Por que o preço é resolvido no banco
 *
 * `service_preco_para_cliente` decide entre o preço de tabela, o negociado e o
 * incluído no contrato. Repetir essa escolha aqui faria o preço mostrado na
 * vitrine e o gravado no chamado divergirem no dia em que uma das duas mudasse —
 * e preço mostrado diferente do cobrado não é defeito de tela, é problema
 * comercial.
 */
export async function pedirServico(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('autoatendimento.catalogo.pedir')
  if ('error' in gate) return gate

  const serviceId = formData.get('service_id')
  const parsedId = z.string().uuid().safeParse(serviceId)
  if (!parsedId.success) return { error: 'Serviço inválido.' }

  const branchId = optionalUuid.safeParse(formData.get('branch_id'))
  const observacao = z
    .string()
    .trim()
    .max(20000)
    .optional()
    .safeParse(formData.get('observacao') ?? undefined)

  const supabase = await createClient()

  const { data: servico, error: erroServico } = await supabase
    .from('service_catalog')
    .select('id, name, description, queue_id, priority_id, campos, is_active, prazo_horas, category_id')
    .eq('id', parsedId.data)
    .maybeSingle<{
      id: string
      name: string
      description: string | null
      queue_id: string | null
      priority_id: string | null
      campos: unknown
      is_active: boolean
      prazo_horas: number | null
      category_id: string | null
    }>()

  if (erroServico) return { error: mensagemDeErro(erroServico) }
  if (!servico) return { error: 'Serviço não encontrado.' }
  if (!servico.is_active) {
    return { error: 'Este serviço não está mais disponível. Abra um chamado comum.' }
  }

  const campos = lerCampos(servico.campos)
  const preenchido = validarPreenchimento(campos, (chave) => {
    const v = formData.get(`campo_${chave}`)
    return typeof v === 'string' ? v : null
  })
  if (!preenchido.ok) return { error: preenchido.erro }

  /*
   * O cliente sai da FILIAL escolhida, e não do perfil: uma pessoa pode atender
   * mais de uma empresa, e o preço é do contrato da empresa que está pedindo.
   */
  let clientId: string | null = null
  if (branchId.success && branchId.data) {
    const { data: filial } = await supabase
      .from('branches')
      .select('client_id')
      .eq('id', branchId.data)
      .maybeSingle<{ client_id: string }>()
    clientId = filial?.client_id ?? null
  }

  const { data: precoLinha } = await supabase
    .rpc('service_preco_para_cliente', {
      p_service_id: servico.id,
      p_client_id: clientId,
    })
    .maybeSingle<{ preco: number | null; incluso: boolean }>()

  /* Incluído no contrato grava ZERO, e não nulo: zero é "foi pedido e não custa",
     nulo é "não havia preço". Os dois precisam continuar distinguíveis depois. */
  const preco = precoLinha?.incluso ? 0 : (precoLinha?.preco ?? null)

  const descricao = [
    servico.description ?? '',
    campos.length > 0
      ? '\n' +
        campos
          .map((c) => {
            const v = preenchido.valores[c.chave]
            const texto = typeof v === 'boolean' ? (v ? 'sim' : 'não') : (v ?? '—')
            return `${c.rotulo}: ${texto}`
          })
          .join('\n')
      : '',
    observacao.success && observacao.data ? `\n${observacao.data}` : '',
  ]
    .filter((p) => p.trim() !== '')
    .join('\n')

  const { data, error } = await supabase
    .from('tickets')
    .insert({
      tenant_id: profile.tenant_id,
      title: servico.name,
      description: descricao || null,
      priority_id: servico.priority_id,
      category_id: servico.category_id,
      // Fila nula é resolvida pela trigger, que aplica a fila padrão.
      queue_id: servico.queue_id,
      branch_id: branchId.success ? branchId.data : null,
      client_id: clientId,
      requester_id: profile.id,
      source: 'ui',
      change_source: 'ui',
      service_id: servico.id,
      service_fields: preenchido.valores,
      service_price: preco,
    })
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/tickets')
  revalidatePath('/portal')
  redirect(`/tickets/${data[0]!.id}`)
}

const servicoSchema = z.object({
  id: optionalUuid,
  name: z.string().trim().min(3, 'Dê um nome ao serviço.').max(120),
  description: z
    .string()
    .trim()
    .max(4000)
    .transform((v) => (v === '' ? null : v)),
  category_id: optionalUuid,
  queue_id: optionalUuid,
  priority_id: optionalUuid,
  preco: z
    .union([z.literal(''), z.coerce.number().min(0).max(9_999_999)])
    .transform((v) => (v === '' ? null : v)),
  unidade: z
    .union([z.literal(''), z.enum(['unidade', 'hora', 'mes', 'ponto', 'usuario'])])
    .transform((v) => (v === '' ? null : v)),
  prazo_horas: z
    .union([z.literal(''), z.coerce.number().int().min(1).max(2000)])
    .transform((v) => (v === '' ? null : v)),
  requer_aprovacao: z.coerce.boolean(),
  aprovador_profile_id: optionalUuid,
  is_active: z.coerce.boolean(),
  campos: z.string().trim(),
})

/** Cadastra ou edita um serviço da vitrine. */
export async function salvarServico(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('autoatendimento.catalogo.gerenciar', {
    mensagem: 'Sem permissão para cadastrar serviços.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = servicoSchema.safeParse({
    id: formData.get('id'),
    name: formData.get('name'),
    description: formData.get('description') ?? '',
    category_id: formData.get('category_id'),
    queue_id: formData.get('queue_id'),
    priority_id: formData.get('priority_id'),
    preco: formData.get('preco') ?? '',
    unidade: formData.get('unidade') ?? '',
    prazo_horas: formData.get('prazo_horas') ?? '',
    requer_aprovacao: formData.get('requer_aprovacao') === 'on',
    aprovador_profile_id: formData.get('aprovador_profile_id') ?? '',
    is_active: formData.get('is_active') === 'on',
    campos: formData.get('campos') ?? '[]',
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  /*
   * Os campos chegam como JSON digitado. Validar AQUI, e não só na renderização,
   * é o que impede um serviço de ir para a vitrine com um formulário quebrado —
   * e quem cadastrou descobriria pelo chamado que nunca chegou.
   */
  let campos: unknown
  try {
    campos = JSON.parse(parsed.data.campos || '[]')
  } catch {
    return { error: 'Os campos do formulário não são um JSON válido.' }
  }
  const camposOk = camposSchema.safeParse(campos)
  if (!camposOk.success) {
    const problema = camposOk.error.issues[0]
    return {
      error: `Campo do formulário inválido${problema?.path?.length ? ` (${problema.path.join('.')})` : ''}: ${problema?.message ?? 'formato inesperado'}.`,
    }
  }

  /* `campos` sai do espalhamento porque a versão validada (`camposOk.data`)
     entra no lugar — espalhar o texto cru gravaria uma string onde o banco
     espera `jsonb`. */
  const { id, campos: _textoCru, ...valores } = parsed.data
  void _textoCru
  const supabase = await createClient()
  const linha = { ...valores, campos: camposOk.data }

  if (id) {
    const { data, error } = await supabase
      .from('service_catalog')
      .update(linha)
      .eq('id', id)
      .select('id')
    if (error) return { error: mensagemDeErro(error) }
    if (!data || data.length === 0) return { error: NAO_AFETADO }
    revalidatePath('/catalogo')
    return { success: 'Serviço atualizado.' }
  }

  const { data, error } = await supabase
    .from('service_catalog')
    .insert({ ...linha, tenant_id: profile.tenant_id })
    .select('id')
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/catalogo')
  return { success: 'Serviço cadastrado. Ele já aparece na vitrine.' }
}

const precoSchema = z.object({
  service_id: uuid,
  client_id: uuid,
  incluso_no_contrato: z.coerce.boolean(),
  preco: z
    .union([z.literal(''), z.coerce.number().min(0).max(9_999_999)])
    .transform((v) => (v === '' ? null : v)),
})

/**
 * O preço deste serviço para este cliente.
 *
 * É o "incluídos automaticamente em contratos" do escopo. Sem isto o preço seria
 * o mesmo para todos, e a primeira negociação faria alguém manter uma planilha
 * paralela — que é onde o preço de verdade passaria a morar.
 */
export async function salvarPrecoDoCliente(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('autoatendimento.catalogo.gerenciar', {
    mensagem: 'Sem permissão para definir preços.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = precoSchema.safeParse({
    service_id: formData.get('service_id'),
    client_id: formData.get('client_id'),
    incluso_no_contrato: formData.get('incluso_no_contrato') === 'on',
    preco: formData.get('preco') ?? '',
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  // O banco recusa a contradição (CHECK `scc_incluso_nao_tem_preco`), mas a
  // mensagem dele fala de constraint. Esta fala de contrato.
  if (parsed.data.incluso_no_contrato && parsed.data.preco !== null) {
    return {
      error: 'Incluído no contrato e com preço são coisas diferentes: escolha uma.',
    }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('service_catalog_clients')
    .upsert(
      {
        tenant_id: profile.tenant_id,
        service_id: parsed.data.service_id,
        client_id: parsed.data.client_id,
        incluso_no_contrato: parsed.data.incluso_no_contrato,
        preco: parsed.data.preco,
      },
      { onConflict: 'service_id,client_id' },
    )
    .select('service_id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/catalogo')
  return { success: 'Preço definido para este cliente.' }
}
