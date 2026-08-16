import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireRole, canManageConfig } from '@/lib/session'
import { getBranches } from '@/lib/data/lookups'
import { roleLabel } from '@/lib/i18n'
import { formatDateTime } from '@/lib/format'
import type { Profile } from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui'
import { UserAccessForm } from './user-access-form'
import { NewUserForm } from './new-user-form'

export const metadata: Metadata = { title: 'Usuários' }

const ONLINE_WINDOW_MS = 5 * 60_000

/**
 * IDs de quem esteve ativo nos últimos 5 minutos.
 *
 * Fica fora do componente porque ler o relógio durante a renderização é
 * impuro — o mesmo render poderia produzir resultados diferentes. Aqui o
 * instante é capturado uma vez, e o componente só consome o conjunto pronto.
 */
function onlineUserIds(users: Profile[]): Set<string> {
  const cutoff = Date.now() - ONLINE_WINDOW_MS
  return new Set(
    users
      .filter((u) => u.last_seen_at && new Date(u.last_seen_at).getTime() >= cutoff)
      .map((u) => u.id),
  )
}

export default async function UsuariosPage() {
  const { profile } = await requireRole(['super_admin', 'admin', 'gestor'])
  const supabase = await createClient()

  const [{ data: users }, { data: links }, branches] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, tenant_id, role, full_name, email, phone, is_active, last_seen_at')
      .order('full_name')
      .returns<Profile[]>(),
    supabase.from('user_branches').select('user_id, branch_id, is_primary'),
    getBranches(),
  ])

  const branchesByUser = new Map<string, string[]>()
  for (const link of links ?? []) {
    branchesByUser.set(link.user_id, [...(branchesByUser.get(link.user_id) ?? []), link.branch_id])
  }

  const editable = canManageConfig(profile.role)
  const online = onlineUserIds(users ?? [])

  return (
    <>
      <PageHeader
        title="Usuários"
        description="Papel e visibilidade por filial. Um atendente vinculado a várias filiais enxerga os tickets e ativos de todas elas."
      />

      {!editable && (
        <p className="mb-4 text-sm text-[var(--color-ink-2)]">
          Você tem acesso de leitura. Apenas administradores alteram papéis e filiais.
        </p>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="grid gap-4 lg:grid-cols-2">
          {(users ?? []).length === 0 && <EmptyState title="Nenhum usuário encontrado" />}

          {(users ?? []).map((u) => {
            const assigned = branchesByUser.get(u.id) ?? []
            const isOnline = online.has(u.id)

            return (
              <Card key={u.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-[var(--color-ink)]">{u.full_name}</h2>
                    <p className="text-xs text-[var(--color-ink-3)]">{u.email}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {isOnline && <Badge tone="ok">Online</Badge>}
                    {!u.is_active && <Badge tone="breach">Inativo</Badge>}
                    <Badge tone="info">{roleLabel[u.role]}</Badge>
                  </div>
                </div>

                <p className="mt-2 text-xs text-[var(--color-ink-2)]">
                  {u.role === 'gestor' || u.role === 'admin' || u.role === 'super_admin'
                    ? 'Enxerga todas as filiais do tenant.'
                    : assigned.length === 0
                      ? 'Nenhuma filial vinculada — não enxerga tickets de filial alguma.'
                      : `${assigned.length} filial(is) vinculada(s).`}
                </p>
                <p className="mt-1 text-xs text-[var(--color-ink-3)]">
                  Última atividade: {formatDateTime(u.last_seen_at)}
                </p>

                {editable && u.role !== 'super_admin' && u.id !== profile.id && (
                  <div className="mt-4 border-t border-[var(--color-border)] pt-4">
                    <UserAccessForm
                      userId={u.id}
                      currentRole={u.role}
                      isActive={u.is_active}
                      assignedBranchIds={assigned}
                      branches={branches}
                    />
                  </div>
                )}
                {editable && u.id === profile.id && (
                  // A trigger de auditoria só barra ESCALONAMENTO de papel —
                  // rebaixar a si mesmo ou desativar a própria conta passa, e um
                  // admin sozinho no tenant ficaria trancado do lado de fora sem
                  // caminho de volta pela própria aplicação.
                  <p className="mt-4 border-t border-[var(--color-border)] pt-4 text-xs text-[var(--color-ink-3)]">
                    Este é o seu usuário — para mudar seu próprio papel ou acesso, peça a outro administrador.
                  </p>
                )}
              </Card>
            )
          })}
        </div>

        {editable && (
          <Card title="Novo usuário">
            <NewUserForm branches={branches} />
          </Card>
        )}
      </div>
    </>
  )
}
