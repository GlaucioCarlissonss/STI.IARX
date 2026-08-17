'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession, requirePermission } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'
import { recordId } from '@/lib/schemas/cadastros'
import { emptyToNull } from '@/lib/form-schemas'
import { PERMISSION_KEYS, unreachableForRole, withAncestors } from '@/lib/permissions'
import type { UserRole } from '@/lib/types'

const NOT_AFFECTED = 'Não foi possível salvar: registro não encontrado ou sem permissão.'

/** `super_admin` fora: é papel da operação da plataforma, não do ambiente do cliente. */
const BASE_ROLES = ['admin', 'gestor', 'atendente', 'solicitante', 'visualizador'] as const

const profileSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome do perfil.'),
  description: emptyToNull,
  base_role: z.enum(BASE_ROLES),
})

export async function createAccessProfile(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('usuarios.perfis.criar')
  if ('error' in gate) return gate

  const parsed = profileSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('access_profiles')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) {
    if (error.code === '23505') return { error: 'Já existe um perfil com este nome.' }
    return { error: error.message }
  }

  revalidatePath('/perfis')
  return { success: 'Perfil criado. Marque as permissões dele abaixo.' }
}

export async function updateAccessProfile(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSession()
  const gate = await requirePermission('usuarios.perfis.editar')
  if ('error' in gate) return gate

  const id = recordId.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const parsed = profileSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('access_profiles')
    .update(parsed.data)
    .eq('id', id.data)
    .select('id')

  if (error) {
    if (error.code === '23505') return { error: 'Já existe um perfil com este nome.' }
    // A trigger `trg_access_profiles_guard_system` protege perfil de sistema.
    if (error.code === '42501') {
      return { error: 'Perfil de sistema só aceita mudança de situação (ativo/inativo).' }
    }
    return { error: error.message }
  }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/perfis')
  return { success: 'Perfil atualizado.' }
}

export async function setAccessProfileActive(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSession()
  const gate = await requirePermission('usuarios.perfis.inativar')
  if ('error' in gate) return gate

  const parsed = z
    .object({ id: recordId, is_active: z.enum(['true', 'false']) })
    .safeParse({ id: formData.get('id'), is_active: formData.get('is_active') })
  if (!parsed.success) return { error: 'Situação inválida.' }

  const isActive = parsed.data.is_active === 'true'

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('access_profiles')
    .update({ is_active: isActive })
    .eq('id', parsed.data.id)
    .select('id')

  if (error) return { error: error.message }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/perfis')
  revalidatePath('/usuarios')
  return { success: isActive ? 'Perfil reativado.' : 'Perfil inativado.' }
}

/**
 * Grava a matriz de permissões de um perfil.
 *
 * Substituição completa do conjunto (apaga e reinsere) em vez de diff: o volume
 * é de ~108 linhas no pior caso, e calcular diferença abriria a porta para o
 * estado intermediário em que o perfil fica sem o grant do módulo e, por
 * herança, perde tudo por um instante.
 *
 * Duas correções acontecem no servidor, não na UI:
 *
 *   1. `withAncestors` fecha o conjunto — marcar uma ação implica marcar a tela
 *      e o módulo. Sem isso o administrador salvaria uma ação órfã, veria o
 *      checkbox marcado, e o operador continuaria sem o botão.
 *   2. `unreachableForRole` recusa a gravação inteira quando alguma chave está
 *      acima do teto do perfil, com a lista do que está fora — em vez de deixar
 *      a trigger do banco derrubar a transação com uma chave por vez.
 */
export async function saveProfileGrants(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('usuarios.perfis.editar')
  if ('error' in gate) return gate

  const id = recordId.safeParse(formData.get('profile_id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const marcadas = formData
    .getAll('perm')
    .filter((v): v is string => typeof v === 'string' && PERMISSION_KEYS.includes(v))

  const supabase = await createClient()
  const { data: alvo } = await supabase
    .from('access_profiles')
    .select('id, base_role, is_active')
    .eq('id', id.data)
    .maybeSingle<{ id: string; base_role: UserRole; is_active: boolean }>()

  if (!alvo) return { error: NOT_AFFECTED }

  const chaves = withAncestors(marcadas)
  const foraDoTeto = unreachableForRole(chaves, alvo.base_role)
  if (foraDoTeto.length > 0) {
    return {
      error:
        `Estas permissões exigem papel base acima de "${alvo.base_role}" e não podem ser ` +
        `concedidas a este perfil: ${foraDoTeto.join(', ')}.`,
    }
  }

  const { error: delError } = await supabase
    .from('permission_grants')
    .delete()
    .eq('profile_id', id.data)
  if (delError) return { error: delError.message }

  if (chaves.length > 0) {
    const { error: insError } = await supabase.from('permission_grants').insert(
      chaves.map((permission_key) => ({
        tenant_id: profile.tenant_id,
        profile_id: id.data,
        permission_key,
      })),
    )
    if (insError) return { error: insError.message }
  }

  revalidatePath('/perfis')
  return {
    success:
      chaves.length === 0
        ? 'Perfil salvo sem nenhuma permissão — quem usa este perfil não verá tela alguma.'
        : `${chaves.length} permissão(ões) gravada(s).`,
  }
}

/**
 * Atribui perfil de acesso a um usuário.
 *
 * Separada de `updateUserAccess` porque a trigger do banco recusa a
 * auto-atribuição, e misturar as duas coisas faria a mensagem de erro apontar
 * para o campo errado.
 */
export async function setUserAccessProfile(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('usuarios.usuarios.editar_acesso')
  if ('error' in gate) return gate

  const parsed = z
    .object({ user_id: recordId, profile_id: z.string() })
    .safeParse({ user_id: formData.get('user_id'), profile_id: formData.get('profile_id') ?? '' })
  if (!parsed.success) return { error: 'Seleção inválida.' }

  if (parsed.data.user_id === profile.id) {
    return { error: 'Você não pode alterar o seu próprio perfil de acesso — peça a outro administrador.' }
  }

  const novo = parsed.data.profile_id === '' ? null : parsed.data.profile_id

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('profiles')
    .update({ access_profile_id: novo })
    .eq('id', parsed.data.user_id)
    .select('id')

  if (error) {
    if (error.code === '42501') {
      return { error: 'Você não pode alterar o seu próprio perfil de acesso.' }
    }
    return { error: error.message }
  }
  if (!updated?.length) return { error: NOT_AFFECTED }

  revalidatePath('/usuarios')
  return { success: 'Perfil de acesso atualizado.' }
}
