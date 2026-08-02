import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import type { Branch, Category, Client, Priority, Profile, Queue } from '@/lib/types'

/**
 * Listas de apoio usadas por formulários e filtros.
 *
 * Memoizadas por requisição: uma tela de ticket pede prioridades, filas,
 * categorias e atendentes, e vários componentes pedem as mesmas listas.
 * Todas passam por RLS, então já vêm restritas ao tenant e ao escopo do usuário.
 */

export const getPriorities = cache(async (): Promise<Priority[]> => {
  const supabase = await createClient()
  const { data } = await supabase
    .from('ticket_priorities')
    .select('id, key, label, weight, color, sort_order')
    .eq('is_active', true)
    .order('sort_order')
  return data ?? []
})

export const getQueues = cache(async (): Promise<Queue[]> => {
  const supabase = await createClient()
  const { data } = await supabase
    .from('queues')
    .select('id, name, slug, description, is_system_default, is_active')
    .is('deleted_at', null)
    .eq('is_active', true)
    .order('is_system_default', { ascending: false })
    .order('name')
  return data ?? []
})

export const getCategories = cache(async (): Promise<Category[]> => {
  const supabase = await createClient()
  const { data } = await supabase
    .from('ticket_categories')
    .select('id, parent_id, name')
    .eq('is_active', true)
    .order('name')
  return data ?? []
})

export const getBranches = cache(async (): Promise<Branch[]> => {
  const supabase = await createClient()
  const { data } = await supabase
    .from('branches')
    .select('id, client_id, name, code, city, state, timezone, is_active')
    .is('deleted_at', null)
    .order('name')
  return data ?? []
})

export const getClients = cache(async (): Promise<Client[]> => {
  const supabase = await createClient()
  const { data } = await supabase
    .from('clients')
    .select('id, legal_name, trade_name, cnpj, status')
    .is('deleted_at', null)
    .order('legal_name')
  return data ?? []
})

/** Perfis que podem receber atribuição de ticket. */
export const getAgents = cache(async (): Promise<Profile[]> => {
  const supabase = await createClient()
  const { data } = await supabase
    .from('profiles')
    .select('id, tenant_id, role, full_name, email, phone, is_active, last_seen_at')
    .eq('is_active', true)
    .in('role', ['atendente', 'gestor', 'admin'])
    .order('full_name')
  return data ?? []
})

/**
 * Categorias em dois níveis, prontas para um <select> com <optgroup>.
 * Fazer isso na UI espalharia a mesma reconstrução de árvore por várias telas.
 */
export function groupCategories(categories: Category[]) {
  const parents = categories.filter((c) => c.parent_id === null)
  return parents.map((parent) => ({
    ...parent,
    children: categories.filter((c) => c.parent_id === parent.id),
  }))
}
