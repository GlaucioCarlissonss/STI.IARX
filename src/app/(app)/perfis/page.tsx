import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { roleLabel } from '@/lib/i18n'
import { comParametros } from '@/lib/data/endereco'
import type { AccessProfile } from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui'
import { GavetaDePerfil } from './gaveta'

export const metadata: Metadata = { title: 'Perfis de acesso' }

export default async function PerfisPage({
  searchParams,
}: {
  searchParams: Promise<{ aberto?: string; novo?: string }>
}) {
  const params = await searchParams
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
  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/perfis', params, mudancas)
  const gavetaAberta = Boolean(params.aberto || params.novo)

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && (
        <GavetaDePerfil
          id={params.aberto}
          novo={Boolean(params.novo)}
          fechar={endereco({ aberto: null, novo: null })}
        />
      )}

      <PageHeader
        title="Perfis de acesso"
        description="Cada perfil combina um papel base (o teto do que ele consegue fazer) com a matriz de permissões módulo → tela → ação. Sem o módulo, nada dentro dele; com o módulo, cada tela e ação ainda precisa ser marcada."
        action={
          podeCriar && (
            <Link
              href={endereco({ novo: '1' }) as Route}
              data-testid="novo-registro"
              className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
            >
              Novo perfil
            </Link>
          )
        }
      />

      {/* Dois por linha em vez de uma coluna estreita ao lado de um formulário:
          o cartão do perfil é curto — nome, teto e duas contagens — e empilhado
          em coluna única sobrava metade da tela em branco. */}
      <div className="grid gap-4 xl:grid-cols-2">
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
                <div className="mt-4">
                  <Link
                    href={endereco({ aberto: p.id }) as Route}
                    data-testid="abrir-registro"
                    className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-sm font-medium text-[var(--color-brand-ink)] hover:bg-[var(--color-surface-2)]"
                  >
                    Permissões e dados
                  </Link>
                </div>
              )}
            </Card>
          )
        })}
      </div>
    </div>
  )
}
