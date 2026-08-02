import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Cliente Supabase para Server Components e Server Actions.
 *
 * Usa o JWT do usuário logado, portanto TODA consulta passa pelo RLS — é essa
 * a garantia de isolamento entre tenants (ADR-002). Nenhum código de aplicação
 * deve filtrar `tenant_id` manualmente: se a policy falhar, o dado não aparece,
 * em vez de aparecer por acidente.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // Server Components não podem gravar cookies. O middleware já cuida
            // da renovação da sessão, então ignorar aqui é seguro.
          }
        },
      },
    },
  )
}
