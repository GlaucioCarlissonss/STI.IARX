import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { roleLabel } from '@/lib/i18n'
import type { AccessProfile } from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui'
import { EditPanel } from '@/components/edit-panel'
import { EditProfileForm, NewProfileForm, PermissionMatrix } from './profile-forms'

export const metadata: Metadata = { title: 'Perfis de acesso' }

export default async function PerfisPage() {
  await requireScreen('usuarios.perfis.ver')
  const [podeEditar, podeCriar] = await Promise.all([
    allowed('usuarios.perfis.editar'),
    allowed('usuarios.perfis.criar'),
  ])
  const supabase = await createClient()

  const [{ data: profiles }, { data: grants }, { data: users }] = await Promise.all([
    supabase
      .from('access_profiles')
      .select('id, name, description, base_role, is_system, system_key, is_active')
      .order('is_system', { ascending: false })
      .order('name')
      .returns<AccessProfile[]>(),
    supabase.from('permission_grants').select('profile_id, permission_key'),
    // Quantas pessoas usam cada perfil: inativar um perfil que ninguém usa é
    // trivial, inativar um com dez pessoas dentro muda o acesso de dez pessoas.
    supabase.from('profiles').select('access_profile_id'),
  ])

  const grantsByProfile = new Map<string, string[]>()
  for (const g of grants ?? []) {
    grantsByProfile.set(g.profile_id, [...(grantsByProfile.get(g.profile_id) ?? []), g.permission_key])
  }
  const usersByProfile = new Map<string, number>()
  for (const u of users ?? []) {
    if (u.access_profile_id) {
      usersByProfile.set(u.access_profile_id, (usersByProfile.get(u.access_profile_id) ?? 0) + 1)
    }
  }

  const list = profiles ?? []

  return (
    <>
      <PageHeader
        title="Perfis de acesso"
        description="Cada perfil combina um papel base (o teto do que ele consegue fazer) com a matriz de permissões módulo → tela → ação. Sem o módulo, nada dentro dele; com o módulo, cada tela e ação ainda precisa ser marcada."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="flex flex-col gap-4">
          {list.length === 0 && <EmptyState title="Nenhum perfil de acesso cadastrado" />}

          {list.map((p) => {
            const concedidas = grantsByProfile.get(p.id) ?? []
            const emUso = usersByProfile.get(p.id) ?? 0
            const acoes = concedidas.filter((k) => k.split('.').length === 3).length
            return (
              <Card key={p.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-[var(--color-ink)]">{p.name}</h2>
                    {p.description && (
                      <p className="mt-0.5 text-xs text-[var(--color-ink-3)]">{p.description}</p>
                    )}
                    <p className="mt-1 text-xs text-[var(--color-ink-2)]">
                      Teto: <strong>{roleLabel[p.base_role]}</strong> · {acoes} ação(ões) concedida(s)
                      {emUso > 0 ? ` · ${emUso} usuário(s)` : ' · nenhum usuário'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {p.is_system && <Badge tone="info">Sistema</Badge>}
                    {p.is_active ? <Badge tone="ok">Ativo</Badge> : <Badge>Inativo</Badge>}
                  </div>
                </div>

                {podeEditar && (
                  <div className="mt-4 flex flex-col gap-3">
                    <EditPanel label="Permissões" title={`Permissões de ${p.name}`}>
                      <PermissionMatrix profile={p} granted={concedidas} />
                    </EditPanel>
                    <EditPanel title={`Editar ${p.name}`}>
                      <EditProfileForm profile={p} />
                    </EditPanel>
                  </div>
                )}
              </Card>
            )
          })}
        </div>

        {podeCriar && (
          <Card title="Novo perfil">
            <NewProfileForm />
          </Card>
        )}
      </div>
    </>
  )
}
