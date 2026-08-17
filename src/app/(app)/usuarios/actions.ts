'use server'

import { randomBytes } from 'crypto'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireSession, canManageConfig, requirePermission } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'
import { emptyToNull } from '@/lib/form-schemas'

const ROLES = ['admin', 'gestor', 'atendente', 'solicitante', 'visualizador'] as const

const updateSchema = z.object({
  user_id: z.string().uuid('Seleção inválida.'),
  role: z.enum(ROLES),
  branch_ids: z.array(z.string().uuid('Seleção inválida.')).default([]),
  is_active: z.boolean(),
})

/**
 * Atualiza papel e visibilidade por filial (RF-USR-02).
 *
 * `super_admin` não aparece na lista de papéis atribuíveis de propósito: é
 * papel da operação da plataforma, e a trigger `trg_profiles_no_escalation`
 * rejeitaria a concessão de qualquer forma.
 */
export async function updateUserAccess(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('usuarios.usuarios.editar_acesso')
  if ('error' in gate) return gate
  if (!canManageConfig(profile.role)) {
    return { error: 'Apenas administradores podem alterar acessos.' }
  }

  const parsed = updateSchema.safeParse({
    user_id: formData.get('user_id'),
    role: formData.get('role'),
    branch_ids: formData.getAll('branch_ids').filter((v): v is string => typeof v === 'string' && v !== ''),
    is_active: formData.get('is_active') === 'on',
  })

  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  // A trigger de auditoria só barra ESCALONAMENTO — rebaixar ou desativar a
  // própria conta passaria por ela normalmente. Barrado aqui também, não só
  // escondendo o formulário na UI: sem isso, um admin sozinho no tenant podia
  // se trancar do lado de fora com dois cliques e sem confirmação.
  if (parsed.data.user_id === profile.id) {
    return { error: 'Você não pode alterar o próprio papel ou acesso — peça a outro administrador.' }
  }

  const supabase = await createClient()

  const { error: profileError } = await supabase
    .from('profiles')
    .update({ role: parsed.data.role, is_active: parsed.data.is_active })
    .eq('id', parsed.data.user_id)

  if (profileError) return { error: profileError.message }

  // Substituição completa do conjunto de filiais: apagar e reinserir é mais
  // simples e mais seguro do que calcular o diff, e o volume é de dezenas de
  // linhas no pior caso.
  const { error: deleteError } = await supabase
    .from('user_branches')
    .delete()
    .eq('user_id', parsed.data.user_id)

  if (deleteError) return { error: deleteError.message }

  if (parsed.data.branch_ids.length > 0) {
    const { error: insertError } = await supabase.from('user_branches').insert(
      parsed.data.branch_ids.map((branchId, index) => ({
        user_id: parsed.data.user_id,
        branch_id: branchId,
        tenant_id: profile.tenant_id,
        is_primary: index === 0,
      })),
    )
    if (insertError) return { error: insertError.message }
  }

  revalidatePath('/usuarios')
  return { success: 'Acesso atualizado.' }
}

const createUserSchema = z.object({
  full_name: z.string().trim().min(2, 'Informe o nome completo.'),
  email: z.string().trim().email('Informe um e-mail válido.'),
  phone: emptyToNull,
  role: z.enum(ROLES),
  branch_ids: z.array(z.string().uuid('Seleção inválida.')).default([]),
})

/** 20 caracteres hexadecimais — entropia de sobra para uma senha de uso único. */
function generateTemporaryPassword(): string {
  return randomBytes(10).toString('hex')
}

/**
 * Cria a conta de um atendente novo (RF-USR-01).
 *
 * Diferente de `updateUserAccess`, aqui não existe ainda uma linha em
 * `auth.users` — por isso, e só por isso, este é o segundo uso de
 * `service_role` sancionado pelo ADR-011 ("provisionamento de usuário").
 * O restante do fluxo (inserir em `profiles`/`user_branches`) continua pelo
 * cliente de sessão, para passar pelo RLS normalmente.
 *
 * A senha devolvida no `success` é de uso único: não fica gravada em lugar
 * nenhum além de `auth.users` (com hash, como qualquer senha), e esta é a
 * única vez que ela aparece em texto claro. Quem a recebe deve trocá-la em
 * "Minha conta" no primeiro acesso.
 */
export async function createUserAccount(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  const gate = await requirePermission('usuarios.usuarios.criar')
  if ('error' in gate) return gate
  if (!canManageConfig(profile.role)) {
    return { error: 'Apenas administradores podem criar usuários.' }
  }

  const parsed = createUserSchema.safeParse({
    full_name: formData.get('full_name'),
    email: formData.get('email'),
    phone: formData.get('phone'),
    role: formData.get('role'),
    branch_ids: formData
      .getAll('branch_ids')
      .filter((v): v is string => typeof v === 'string' && v !== ''),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const { full_name, email, phone, role, branch_ids } = parsed.data
  const tempPassword = generateTemporaryPassword()

  const admin = createAdminClient()
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { full_name },
  })

  if (createError) {
    if (createError.code === 'email_exists') {
      return { error: 'Já existe uma conta com este e-mail nesta plataforma.' }
    }
    return { error: createError.message }
  }

  const supabase = await createClient()
  const { error: profileError } = await supabase.from('profiles').insert({
    id: created.user.id,
    tenant_id: profile.tenant_id,
    role,
    full_name,
    email,
    phone,
  })

  if (profileError) {
    // Sem isto, o e-mail ficaria travado para sempre em `auth.users` sem
    // nenhum perfil correspondente — nem esta tela nem nenhuma outra teria
    // como corrigir ou tentar de novo com o mesmo e-mail.
    await admin.auth.admin.deleteUser(created.user.id)
    if (profileError.code === '23505') {
      return { error: 'Já existe um usuário com este e-mail neste tenant.' }
    }
    return { error: profileError.message }
  }

  if (branch_ids.length > 0) {
    const { error: branchError } = await supabase.from('user_branches').insert(
      branch_ids.map((branchId, index) => ({
        user_id: created.user.id,
        branch_id: branchId,
        tenant_id: profile.tenant_id,
        is_primary: index === 0,
      })),
    )
    if (branchError) return { error: branchError.message }
  }

  revalidatePath('/usuarios')
  return {
    success: `Usuário criado. Senha temporária (informe com segurança e peça para trocar em "Minha conta" no primeiro acesso): ${tempPassword}`,
  }
}
