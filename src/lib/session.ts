import { cache } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import type { Profile, Tenant, UserRole } from '@/lib/types'

export interface SessionContext {
  userId: string
  profile: Profile
  tenant: Tenant | null
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
    .select('id, tenant_id, role, full_name, email, phone, is_active, last_seen_at')
    .eq('id', user.id)
    .maybeSingle<Profile>()

  if (!profile) return null

  const { data: tenant } = profile.tenant_id
    ? await supabase
        .from('tenants')
        .select('id, name, slug, sla_warning_pct, sla_critical_pct, auto_close_after_days')
        .eq('id', profile.tenant_id)
        .maybeSingle<Tenant>()
    : { data: null }

  return { userId: user.id, profile, tenant }
})

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
