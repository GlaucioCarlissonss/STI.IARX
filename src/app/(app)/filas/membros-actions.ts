'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { uuid } from '@/lib/schemas/campos'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'

/**
 * Membros de fila.
 *
 * ## O que a tabela significa, e o que ela NÃO significa
 *
 * `queue_members` diz **quem trabalha nesta fila** — e era a última lacuna de
 * interface que o roadmap (docs/06, M1) ainda marcava como pendente. A tabela
 * está no banco desde a migração 0004, com RLS e auditoria, e nenhuma tela
 * jamais escreveu nela.
 *
 * Ela **não é autorização**: o RLS de `tickets` não lê `queue_members`, e
 * ninguém deixa de ver um chamado por não ser membro. Prometer o contrário seria
 * o pior tipo de erro — uma restrição que a tela sugere e o banco não aplica.
 *
 * O que ela é: a lista de quem a operação considera responsável pela fila. Serve
 * para saber a quem atribuir, para medir carga por pessoa e para a pergunta
 * "quem cuida disso quando o Jorge entra de férias".
 *
 * ## Por que `helpdesk.filas.editar` e não uma chave nova
 *
 * Quem configura uma fila configura quem trabalha nela — são o mesmo ato
 * administrativo, feito pela mesma pessoa na mesma tela. Uma chave só para
 * membros daria ao catálogo mais um item e a ninguém mais um poder.
 */

const membroSchema = z.object({
  queue_id: uuid,
  user_id: uuid,
  is_lead: z.coerce.boolean(),
})

export async function adicionarMembro(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('helpdesk.filas.editar', {
    mensagem: 'Sem permissão para alterar a equipe da fila.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = membroSchema.safeParse({
    queue_id: formData.get('queue_id'),
    user_id: formData.get('user_id'),
    is_lead: formData.get('is_lead') === 'on',
  })
  if (!parsed.success) return { error: 'Escolha quem acrescentar.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('queue_members')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })
    .select('queue_id')

  if (error) {
    if (error.code === '23505') return { error: 'Essa pessoa já está na fila.' }
    return { error: mensagemDeErro(error) }
  }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/filas')
  return { success: 'Pessoa acrescentada à fila.' }
}

export async function removerMembro(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('helpdesk.filas.editar', {
    mensagem: 'Sem permissão para alterar a equipe da fila.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({ queue_id: uuid, user_id: uuid })
    .safeParse({ queue_id: formData.get('queue_id'), user_id: formData.get('user_id') })
  if (!parsed.success) return { error: 'Membro inválido.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('queue_members')
    .delete()
    .eq('queue_id', parsed.data.queue_id)
    .eq('user_id', parsed.data.user_id)
    .select('queue_id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/filas')
  return {
    success:
      'Pessoa removida da fila. Os chamados dela continuam atribuídos — sair da fila não desatribui nada.',
  }
}

/** Promove ou rebaixa o responsável. */
export async function alternarLideranca(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('helpdesk.filas.editar', {
    mensagem: 'Sem permissão para alterar a equipe da fila.',
  })
  if ('error' in gate) return gate

  const parsed = membroSchema.safeParse({
    queue_id: formData.get('queue_id'),
    user_id: formData.get('user_id'),
    is_lead: formData.get('is_lead') === 'on',
  })
  if (!parsed.success) return { error: 'Membro inválido.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('queue_members')
    .update({ is_lead: parsed.data.is_lead })
    .eq('queue_id', parsed.data.queue_id)
    .eq('user_id', parsed.data.user_id)
    .select('queue_id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/filas')
  return {
    success: parsed.data.is_lead ? 'Marcada como responsável.' : 'Deixou de ser responsável.',
  }
}
