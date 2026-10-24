'use server'

import { randomBytes, createHash } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { optionalUuid } from '@/lib/schemas/campos'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'

const inscricaoSchema = z.object({
  name: z.string().trim().min(3, 'Dê um nome ao lote (ex.: Notebooks da filial de Londrina).'),
  branch_id: optionalUuid,
  max_uses: z
    .union([z.literal(''), z.coerce.number().int().positive().max(10_000)])
    .transform((v) => (v === '' ? null : v))
    .nullable(),
  dias: z.coerce.number().int().min(1).max(365).default(30),
})

export interface InscricaoActionState extends ActionState {
  /** O token em claro. Só existe nesta resposta — depois disso, só o hash. */
  plainToken?: string
}

/**
 * Emite um token de inscrição para um lote de máquinas.
 *
 * ## Por que o prazo é obrigatório e o padrão é 30 dias
 *
 * Um token de inscrição sem validade é uma credencial permanente num arquivo de
 * configuração que vai ficar numa pasta de rede, num script de GPO e no histórico
 * do terminal de quem instalou. Trinta dias cobre folgadamente uma implantação
 * — e a implantação seguinte emite outro, que custa um clique.
 *
 * O campo existe no formulário, então quem precisa de mais pode pedir mais; o que
 * não existe é a opção "nunca vence". Ela seria escolhida por ser a mais cômoda, e
 * é a única que não dá para desfazer depois que o token circulou.
 */
export async function emitirTokenDeInscricao(
  _prev: InscricaoActionState,
  formData: FormData,
): Promise<InscricaoActionState> {
  const gate = await permitirEscrita('inventario.agentes.gerenciar', {
    mensagem: 'Sem permissão para inscrever máquinas.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = inscricaoSchema.safeParse({
    name: formData.get('name'),
    branch_id: formData.get('branch_id'),
    max_uses: formData.get('max_uses') ?? '',
    dias: formData.get('dias') ?? 30,
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  /*
   * 32 bytes em hexa, com prefixo. O prefixo não é enfeite: ele é o que permite a
   * quem vê a string num log ou num script reconhecer o que é — e, mais útil que
   * isso, permite a uma varredura de segredo em repositório encontrá-la.
   */
  const plain = `inv_${randomBytes(32).toString('hex')}`
  const hash = createHash('sha256').update(plain).digest('hex')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('agent_enrollments')
    .insert({
      tenant_id: profile.tenant_id,
      name: parsed.data.name,
      token_hash: hash,
      branch_id: parsed.data.branch_id,
      max_uses: parsed.data.max_uses,
      expires_at: new Date(Date.now() + parsed.data.dias * 86_400_000).toISOString(),
      created_by: profile.id,
    })
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/inventario/agentes')
  return {
    success: 'Token emitido. Copie agora — ele não aparece de novo.',
    plainToken: plain,
  }
}

export async function revogarTokenDeInscricao(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('inventario.agentes.gerenciar', {
    mensagem: 'Sem permissão para revogar tokens.',
  })
  if ('error' in gate) return gate

  const id = formData.get('enrollment_id')
  if (typeof id !== 'string' || id === '') return { error: 'Token inválido.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('agent_enrollments')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/inventario/agentes')
  return {
    success: 'Token revogado. As máquinas já inscritas continuam funcionando — elas têm o token delas.',
  }
}

/**
 * Tira uma máquina da frota.
 *
 * O token dela para de valer no mesmo instante, e ela **não se reinscreve
 * sozinha** (a função `agent_enroll` recusa máquina revogada, e há asserção de
 * schema para isso). É o que torna esta ação útil para notebook roubado: sem a
 * recusa, bastaria reinstalar o agente para desfazer a decisão.
 *
 * O que ela NÃO faz é apagar o ativo nem o histórico de inventário. A máquina
 * sumiu do parque; o que se sabia sobre ela continua sendo o que se sabia, e é
 * justamente o que o seguro e o boletim de ocorrência vão pedir.
 */
export async function revogarMaquina(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('inventario.agentes.gerenciar', {
    mensagem: 'Sem permissão para revogar máquinas.',
  })
  if ('error' in gate) return gate

  const id = formData.get('device_id')
  if (typeof id !== 'string' || id === '') return { error: 'Máquina inválida.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('agent_devices')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/inventario/agentes')
  return {
    success:
      'Máquina revogada. O agente dela para de ser aceito, e reinstalar não a traz de volta. O ativo e o histórico continuam no inventário.',
  }
}

/**
 * Fecha um alerta à mão.
 *
 * O alerta se fecha sozinho quando a condição deixa de valer — o disco esvazia,
 * a máquina volta a falar, o serviço sobe. Esta ação existe para o caso em que a
 * condição foi resolvida de outro jeito, ou em que alguém quer limpar a lista
 * enquanto trata do problema.
 *
 * **Ela não silencia nada.** Se a condição continuar valendo, o trabalho agendado
 * abre o alerta de novo no ciclo seguinte — e avisa de novo, porque reabrir é um
 * acontecimento novo. Um botão que silenciasse um problema real transformaria o
 * módulo de alerta num módulo de esconder alerta, que é a pior coisa que se pode
 * fazer com um recurso cujo valor inteiro é avisar.
 */
export async function fecharAlerta(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('inventario.agentes.gerenciar', {
    mensagem: 'Sem permissão para fechar alertas.',
  })
  if ('error' in gate) return gate

  const id = formData.get('alerta_id')
  if (typeof id !== 'string' || id === '') return { error: 'Alerta inválido.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('agent_alerts')
    .update({ fechado_em: new Date().toISOString() })
    .eq('id', id)
    .is('fechado_em', null)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  /*
   * Zero linhas aqui cobre dois casos — sem permissão (negação do RLS) e alerta
   * já fechado por outra pessoa ou pelo próprio trabalho. A mensagem genérica
   * serve aos dois, e o segundo é o mais comum: dois técnicos olhando a mesma
   * tela.
   */
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/inventario/agentes')
  return { success: 'Alerta fechado. Se a condição continuar valendo, ele volta a abrir.' }
}
