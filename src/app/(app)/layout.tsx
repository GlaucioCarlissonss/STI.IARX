import Link from 'next/link'
import { requireSession, touchPresence } from '@/lib/session'
import { can } from '@/lib/permissions'
import { roleLabel } from '@/lib/i18n'
import { initials } from '@/lib/format'
import { signOut } from '@/app/login/actions'
import { NavLink } from '@/components/nav-link'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile, tenant, permissions } = await requireSession()

  // Presença para o contador do painel de TV (RF-DSH-02).
  await touchPresence(profile.id)

  /*
   * O menu passa a espelhar a permissão de CONSULTA de cada tela, em vez dos
   * helpers de papel. Duas razões: um item que aparece e cai em redirect é pior
   * que um item ausente; e manter a lista do menu em sincronia com os gates das
   * páginas à mão já tinha produzido uma divergência — `/usuarios` aparecia para
   * gestor e a edição lá dentro exigia admin.
   *
   * `/conta` fica sempre visível: trocar a própria senha não é permissão de
   * módulo, é direito de quem tem conta.
   */
  const show = (perm: string) => can(permissions, perm)
  const nav = [
    { href: '/painel', label: 'Painel', show: show('helpdesk.painel.ver') },
    { href: '/tickets', label: 'Tickets', show: show('helpdesk.tickets.ver') },
    { href: '/filas', label: 'Filas', show: show('helpdesk.filas.ver') },
    { href: '/sla', label: 'SLA', show: show('sla.compliance.ver') },
    { href: '/inventario', label: 'Inventário', show: show('inventario.ativos.ver') },
    { href: '/telefonia', label: 'Telefonia', show: show('telefonia.linhas.ver') },
    { href: '/fornecedores', label: 'Fornecedores', show: show('fornecedores.cadastro.ver') },
    { href: '/clientes', label: 'Clientes e filiais', show: show('clientes.grupos.ver') },
    { href: '/usuarios', label: 'Usuários', show: show('usuarios.usuarios.ver') },
    { href: '/perfis', label: 'Perfis de acesso', show: show('usuarios.perfis.ver') },
    { href: '/integracoes', label: 'Integrações', show: show('integracoes.hub.ver') },
    { href: '/mapas', label: 'Mapas', show: show('mapas.geolocalizacao.ver') },
    { href: '/tv', label: 'Painéis de TV', show: show('tv.tokens.ver') },
    { href: '/conta', label: 'Minha conta', show: true },
  ].filter((item) => item.show)

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
        <nav aria-label="Navegação principal" className="hidden w-56 shrink-0 lg:block">
          <ul className="sticky top-20 flex flex-col gap-0.5">
            {nav.map((item) => (
              <li key={item.href}>
                <NavLink href={item.href}>{item.label}</NavLink>
              </li>
            ))}
          </ul>
        </nav>

        {/* Navegação compacta para tablet (RNF-07) */}
        <nav
          aria-label="Navegação principal"
          className="fixed inset-x-0 bottom-0 z-20 overflow-x-auto border-t border-[var(--color-border)] bg-[var(--color-surface)] lg:hidden"
        >
          <ul className="flex gap-1 px-2 py-1.5">
            {nav.map((item) => (
              <li key={item.href} className="shrink-0">
                <NavLink href={item.href}>{item.label}</NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main id="conteudo" tabIndex={-1} className="min-w-0 flex-1 pb-20 lg:pb-0 focus:outline-none">
          {children}
        </main>
      </div>
    </div>
  )
}
