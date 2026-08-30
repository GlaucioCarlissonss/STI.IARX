import Link from 'next/link'
import { requireSession, touchPresence } from '@/lib/session'
import { visibleNav, visibleNavGroups } from '@/lib/navigation'
import { CompactNav, SidebarNav } from '@/components/sidebar-nav'
import { roleLabel } from '@/lib/i18n'
import { initials } from '@/lib/format'
import { signOut } from '@/app/login/actions'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile, tenant, permissions } = await requireSession()

  // Presença para o contador do painel de TV (RF-DSH-02).
  await touchPresence(profile.id)

  /*
   * O menu e o destino pós-negação saem da MESMA lista (`src/lib/navigation.ts`).
   * Manter as duas coisas separadas já tinha custado um laço de redirect: o menu
   * escondia `/painel` de quem não podia vê-lo e o `requireScreen` mandava para
   * lá de todo jeito.
   */
  const grupos = visibleNavGroups(permissions)
  const planos = visibleNav(permissions)

  return (
    <div className="min-h-screen">
      <a href="#conteudo" className="skip-link">
        Pular para o conteúdo
      </a>

      <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto flex max-w-[110rem] items-center gap-4 px-4 py-2.5">
          <Link href="/painel" className="text-lg font-bold tracking-tight text-[var(--color-brand)]">
            STI
          </Link>
          {tenant && (
            <span className="hidden text-sm text-[var(--color-ink-2)] sm:inline">{tenant.name}</span>
          )}

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium leading-tight text-[var(--color-ink)]">
                {profile.full_name}
              </p>
              <p className="text-xs leading-tight text-[var(--color-ink-3)]">
                {roleLabel[profile.role]}
              </p>
            </div>
            <span
              aria-hidden="true"
              className="grid size-9 place-items-center rounded-full bg-[var(--color-brand-soft)] text-sm font-bold text-[var(--color-brand-ink)]"
            >
              {initials(profile.full_name)}
            </span>
            <form action={signOut}>
              <button
                type="submit"
                className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]"
              >
                Sair
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[110rem] gap-6 px-4 py-6">
        <nav aria-label="Navegação principal" className="hidden w-60 shrink-0 lg:block">
          <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-4">
            <SidebarNav groups={grupos} />
          </div>
        </nav>

        {/* Navegação compacta para tablet (RNF-07) */}
        <nav
          aria-label="Navegação principal"
          className="fixed inset-x-0 bottom-0 z-20 overflow-x-auto border-t border-[var(--color-border)] bg-[var(--color-surface)] lg:hidden"
        >
          <CompactNav items={planos} />
        </nav>

        <main id="conteudo" tabIndex={-1} className="min-w-0 flex-1 pb-20 lg:pb-0 focus:outline-none">
          {children}
        </main>
      </div>
    </div>
  )
}
