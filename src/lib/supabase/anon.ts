import { createClient } from '@supabase/supabase-js'
import { modoLocal } from '@/lib/db/modo'
import { criarClienteAnonimo } from '@/lib/db/cliente'

/**
 * Cliente anônimo, sem sessão e sem cookie.
 *
 * Existe para as rotas que o **agente de inventário** chama. Ele não é uma
 * pessoa: não tem login, não tem cookie e nunca vai ter. O que ele tem é um
 * token da própria máquina, e quem valida esse token são as funções
 * `public.agent_enroll` e `public.agent_ingest_inventory`, no banco.
 *
 * ## Por que não `createAdminClient()`
 *
 * Seria o caminho mais curto e seria o errado. A chave de serviço ignora o RLS
 * inteiro; usá-la aqui significaria que um defeito nesta rota — um `tenant_id`
 * vindo do corpo da requisição, por exemplo — viraria acesso à base toda. Com o
 * cliente anônimo, a única coisa que esta rota consegue fazer é chamar as duas
 * funções que recebem o token, e elas derivam o tenant do token. Não há
 * parâmetro de tenant para alguém falsificar.
 *
 * É também o motivo de a Onda 2 **não** acrescentar um quarto uso de
 * `service_role` ao ADR-011.
 *
 * ## Por que não `lib/supabase/server`
 *
 * Aquele lê cookies, e cookie em requisição de agente é ruído: não há navegador,
 * não há sessão a renovar, e um `Set-Cookie` na resposta só confundiria quem
 * fosse depurar. Este não toca em cookie nenhum.
 */
function clienteAnonimo() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}

export function createAnonClient(): ReturnType<typeof clienteAnonimo> {
  if (modoLocal()) {
    return criarClienteAnonimo() as unknown as ReturnType<typeof clienteAnonimo>
  }

  return clienteAnonimo()
}
