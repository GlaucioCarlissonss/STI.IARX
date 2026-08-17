import type { ReactNode } from 'react'
import { getSessionContext } from '@/lib/session'
import { can } from '@/lib/permissions'

/**
 * Renderiza os filhos só se a sessão tiver a permissão.
 *
 * É Server Component: a decisão acontece no servidor e o HTML do botão nunca é
 * enviado a quem não pode usá-lo. A alternativa de client component receberia a
 * matriz inteira no bundle — expondo a estrutura de permissões de todo mundo
 * para inspecionar no navegador, em troca de nada.
 *
 * **Isto não é a barreira.** A barreira é o `requirePermission()` na Server
 * Action e o RLS no banco. Este componente só evita mostrar um caminho que
 * termina em erro; esconder o botão sem proteger a ação seria segurança por
 * obscuridade, e é justamente o furo que a revisão desta rodada fechou em
 * `branch-geo-panel.tsx`.
 */
export async function Can({
  perm,
  fallback = null,
  children,
}: {
  perm: string
  /** O que mostrar no lugar. Útil para explicar a ausência em vez de só sumir. */
  fallback?: ReactNode
  children: ReactNode
}) {
  const ctx = await getSessionContext()
  if (!ctx || !can(ctx.permissions, perm)) return <>{fallback}</>
  return <>{children}</>
}
