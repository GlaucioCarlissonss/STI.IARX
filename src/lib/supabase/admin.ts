import { createClient } from '@supabase/supabase-js'
import { modoLocal } from '@/lib/db/modo'
import { criarClienteDeServico } from '@/lib/db/cliente'

/**
 * Cliente com `service_role` — IGNORA COMPLETAMENTE O RLS.
 *
 * Só existem dois usos legítimos no app (ADR-011):
 *   1. `/tv/[token]` — a TV não tem sessão; o token de exibição define o escopo
 *      e o filtro por tenant passa a ser responsabilidade explícita do código.
 *   2. Provisionamento de usuário/tenant no fluxo administrativo.
 *
 * Toda consulta feita com este cliente PRECISA filtrar `tenant_id` à mão.
 * Se você não consegue justificar por que o cliente de sessão não serve,
 * então ele serve — use `lib/supabase/server`.
 */
function clienteDeServico(chave: string) {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, chave, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export function createAdminClient(): ReturnType<typeof clienteDeServico> {
  /* Em modo local o papel `service_role` existe no PostgreSQL com `bypassrls`,
     exatamente como no Supabase — então o aviso acima continua valendo
     inteiro, e não há chave de serviço para guardar. */
  if (modoLocal()) {
    return criarClienteDeServico() as unknown as ReturnType<typeof clienteDeServico>
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY ausente. Necessária para o painel de TV e integrações.',
    )
  }

  return clienteDeServico(serviceKey)
}
