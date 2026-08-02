'use client'

import { createBrowserClient } from '@supabase/ssr'

/**
 * Cliente de navegador. Usado apenas para o canal Realtime do dashboard
 * (RNF-08); as leituras de dados acontecem no servidor.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
