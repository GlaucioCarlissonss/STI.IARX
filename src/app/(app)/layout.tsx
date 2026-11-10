import Link from 'next/link'
import { cookies } from 'next/headers'
import { requireSession, touchPresence } from '@/lib/session'
import { visibleNavGroups } from '@/lib/navigation'
import { SidebarNav } from '@/components/sidebar-nav'
import { PaletaDeComandos } from '@/components/paleta'
import { MenuCelular } from '@/components/menu-celular'
import { roleLabel } from '@/lib/i18n'
import { initials } from '@/lib/format'
import { signOut } from '@/app/login/actions'
import { ClientFocus } from '@/components/client-focus'
import { ThemeToggle } from '@/components/theme-toggle'
import { RegiaoDeAvisos } from '@/components/avisos'
import { BarraDeNavegacao } from '@/components/progresso'
import { getClients } from '@/lib/data/lookups'
import { SeletorDeEsfera } from '@/components/seletor-de-esfera'
import { COOKIE_DO_FOCO, esferasEmUso, lerFoco } from '@/lib/esferas'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile, tenant, permissions, esferas } = await requireSession()

  // Presença para o contador do painel de TV (RF-DSH-02).
  await touchPresence(profile.id)

  /*
   * O menu e o destino pós-negação saem da MESMA lista (`src/lib/navigation.ts`).
   * Manter as duas coisas separadas já tinha custado um laço de redirect: o menu
   * escondia `/painel` de quem não podia vê-lo e o `requireScreen` mandava para
   * lá de todo jeito.
   */
  /*
   * A esfera entra ANTES da permissão: ela decide o que existe neste negócio, e
   * a permissão decide o que esta pessoa alcança do que existe. Trocar a ordem
   * daria um menu com cadeado em módulo que a empresa não contratou.
   */
  const focoDaEsfera = lerFoco((await cookies()).get(COOKIE_DO_FOCO)?.value, esferas)
  const grupos = visibleNavGroups(permissions, esferasEmUso(esferas, focoDaEsfera))
  /* A paleta usa as esferas da EMPRESA, não o foco. O foco encurta o menu de
     quem escolheu encurtá-lo; esconder a tela também da busca transformaria uma
     preferência de atalho em barreira — e aí quem focasse "Locação" teria que
     desfocar para achar um projeto pelo nome. */
  const gruposDaEmpresa = focoDaEsfera ? visibleNavGroups(permissions, esferas) : grupos
  /*
   * A paleta recebe as telas JÁ FILTRADAS por permissão, com o grupo de cada
   * uma. O grupo não é enfeite: é o que distingue "Contas bancárias" de
   * "Contas a pagar" numa lista sem a barra lateral ao lado para dar contexto.
   *
   * Vem de `visibleNavGroups`, a mesma fonte do menu — a paleta não pode
   * oferecer uma tela que o menu esconde.
   */
  const telasDaPaleta = gruposDaEmpresa.flatMap((g) =>
    g.items
      .filter((i) => i.href !== null)
      .map((i) => ({ label: i.label, href: i.href as string, grupo: g.label })),
  )

  /*
   * O seletor de foco só aparece para quem tem MAIS DE UMA empresa: com uma só,
   * "Todas as empresas" e o nome dela apontam para o mesmo conjunto, e o
   * controle vira decoração que ainda ocupa uma parada de tabulação.
   */
  const empresas = await getClients()
  const foco =
    empresas.length > 1
      ? empresas.map((c) => ({
          id: c.id,
          nome: c.trade_name ?? c.legal_name,
          cor: c.color ?? '#64748b',
        }))
      : []

  return (
    <div className="min-h-screen">
      <a href="#conteudo" className="skip-link">
        Pular para o conteúdo
      </a>

      <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto flex max-w-[110rem] items-center gap-4 px-4 py-2.5">
          <Link
            href="/painel"
            className="fonte-display text-lg font-bold text-[var(--color-brand)]"
          >
            STI
          </Link>
          {tenant && (
            <span className="hidden text-sm text-[var(--color-ink-2)] sm:inline">{tenant.name}</span>
          )}

          <div className="ml-auto flex items-center gap-3">
            <PaletaDeComandos telas={telasDaPaleta} />
            {esferas.length > 1 && <SeletorDeEsfera atual={focoDaEsfera} />}
            <MenuCelular>
              <SidebarNav groups={grupos} />
            </MenuCelular>
            {foco.length > 0 && (
              <ClientFocus opcoes={foco} selecionado={profile.focused_client_id} />
            )}
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
            <ThemeToggle />
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


        {/* `entrar`: quatro pixels e 180ms ao trocar de tela. É direção, não
            animação — e some inteiro sob `prefers-reduced-motion`. */}
        <main
          id="conteudo"
          tabIndex={-1}
          className="entrar min-w-0 flex-1 focus:outline-none"
        >
          {children}
        </main>
      </div>

      {/* A região de avisos fica AQUI, fora do `<main>`: é o que a revalidação
          de uma ação não recria, e é por isso que a confirmação sobrevive a
          ela. Uma vez só, para a aplicação inteira. */}
      <BarraDeNavegacao />
      <RegiaoDeAvisos />
    </div>
  )
}
