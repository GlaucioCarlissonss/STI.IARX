import { cache } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import type { Profile, Tenant, UserRole } from '@/lib/types'
import { PERMISSION_CATALOG, ROLE_RANK, can } from '@/lib/permissions'

export interface SessionContext {
  userId: string
  profile: Profile
  tenant: Tenant | null
  /**
   * Chaves concedidas ao perfil de acesso da pessoa.
   *
   * Carregado junto do perfil, dentro do mesmo `cache()`: a matriz é lida uma
   * vez por requisição, não uma vez por botão.
   */
  permissions: ReadonlySet<string>
}

/**
 * Contexto da sessão, memoizado por requisição.
 *
 * `cache()` garante uma única ida ao banco mesmo quando vários Server
 * Components pedem o perfil na mesma renderização — sem isso, o layout e cada
 * página fariam a consulta separadamente.
 */
export const getSessionContext = cache(async (): Promise<SessionContext | null> => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select(
      'id, tenant_id, role, full_name, email, phone, is_active, last_seen_at, access_profile_id',
    )
    .eq('id', user.id)
    .maybeSingle<Profile>()

  if (!profile) return null

  const [{ data: tenant }, { data: grants }] = await Promise.all([
    profile.tenant_id
      ? supabase
          .from('tenants')
          .select('id, name, slug, sla_warning_pct, sla_critical_pct, auto_close_after_days')
          .eq('id', profile.tenant_id)
          .maybeSingle<Tenant>()
      : Promise.resolve({ data: null }),
    profile.access_profile_id
      ? supabase
          .from('permission_grants')
          .select('permission_key')
          .eq('profile_id', profile.access_profile_id)
      : Promise.resolve({ data: null }),
  ])

  return {
    userId: user.id,
    profile,
    tenant,
    permissions: grants
      ? new Set(grants.map((g) => g.permission_key))
      : permissionsFromRole(profile.role),
  }
})

/**
 * Conjunto de permissões derivado apenas do papel.
 *
 * Rede de segurança para quem não tem perfil de acesso atribuído — o
 * `super_admin`, que é papel da operação da plataforma, e qualquer linha que
 * escape das triggers de provisionamento. Concede tudo que o papel alcança, que
 * é exatamente o comportamento anterior aos perfis: sem isso, um `super_admin`
 * logaria e não veria tela nenhuma.
 */
function permissionsFromRole(role: UserRole): ReadonlySet<string> {
  const rank = ROLE_RANK[role]
  return new Set(
    PERMISSION_CATALOG.filter((p) => ROLE_RANK[p.minBaseRole] <= rank).map((p) => p.key),
  )
}

/** Igual ao anterior, mas redireciona para o login em vez de devolver null. */
export async function requireSession(): Promise<SessionContext> {
  const ctx = await getSessionContext()
  if (!ctx) redirect('/login')
  return ctx
}

/**
 * Exige um dos papéis informados.
 *
 * Esta checagem é de UX — evita mostrar uma tela que o usuário não pode usar.
 * A barreira de verdade é o RLS: mesmo que alguém chegue à rota, o banco não
 * devolve linha nenhuma fora do seu escopo.
 */
export async function requireRole(roles: UserRole[]): Promise<SessionContext> {
  const ctx = await requireSession()
  if (!roles.includes(ctx.profile.role)) redirect('/painel')
  return ctx
}

/**
 * Gate de TELA: exige a permissão de consulta e devolve o contexto.
 *
 * Redireciona em vez de mostrar 403 porque a pessoa chegou aqui pelo menu ou por
 * um link antigo — mandá-la para o painel é mais útil que uma parede.
 */
export async function requireScreen(viewPermission: string): Promise<SessionContext> {
  const ctx = await requireSession()
  if (!can(ctx.permissions, viewPermission)) redirect('/painel')
  return ctx
}

/**
 * Gate de AÇÃO, para o topo de cada Server Action.
 *
 * Devolve `{ error }` em vez de redirecionar: a ação responde a um formulário, e
 * um redirect no meio de um `useActionState` engoliria a mensagem. O texto é
 * deliberadamente igual ao de "registro não encontrado" das ações de escrita —
 * quem não tem permissão não deve conseguir distinguir "não pode" de "não
 * existe", que é como se enumera o que existe do outro lado.
 */
export async function requirePermission(
  permission: string,
): Promise<{ ctx: SessionContext } | { error: string }> {
  const ctx = await requireSession()
  if (!can(ctx.permissions, permission)) {
    return { error: 'Sem permissão para esta ação.' }
  }
  return { ctx }
}

/** Açúcar para componentes de servidor: `if (await allowed('...'))`. */
export async function allowed(permission: string): Promise<boolean> {
  const ctx = await getSessionContext()
  return ctx ? can(ctx.permissions, permission) : false
}

export function canManageConfig(role: UserRole): boolean {
  return role === 'super_admin' || role === 'admin'
}

export function canManageRecords(role: UserRole): boolean {
  return role === 'super_admin' || role === 'admin' || role === 'gestor'
}

export function canWorkTickets(role: UserRole): boolean {
  return role === 'super_admin' || role === 'admin' || role === 'gestor' || role === 'atendente'
}

/**
 * Marca presença do atendente. Alimenta o contador "atendentes online" do
 * painel de TV (RF-DSH-02) sem exigir um canal de presença dedicado: a própria
 * navegação no sistema já é o sinal de que a pessoa está trabalhando.
 */
export async function touchPresence(userId: string): Promise<void> {
  const supabase = await createClient()
  await supabase.from('profiles').update({ last_seen_at: new Date().toISOString() }).eq('id', userId)
}
