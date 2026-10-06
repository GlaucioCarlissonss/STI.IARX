import type { NavGroup, NavItem } from '@/lib/navigation'
import { NavLink } from './nav-link'

/**
 * Barra lateral agrupada.
 *
 * **Sempre expandida, sem acordeão.** O menu já chega filtrado por permissão:
 * um solicitante vê seis itens, não vinte e cinco. Acordeão custaria um clique
 * para alcançar qualquer coisa e criaria estado — "qual grupo estava aberto?" —
 * para resolver um problema de altura que a filtragem já resolve. Onde a lista
 * fica longa (perfil de administrador), o cabeçalho de grupo é o que a vista usa
 * para pular; escondido dentro de um acordeão ele não serviria para isso.
 *
 * Continua Server Component: a decisão de o que mostrar é do servidor. Só o
 * realce do item ativo é cliente, dentro do `NavLink`, porque depende da rota.
 */
export function SidebarNav({ groups }: { groups: NavGroup[] }) {
  return (
    <ul className="flex flex-col gap-4">
      {groups.map((grupo, i) => {
        /*
         * O rótulo do grupo era um `<h2>`, e o menu vem ANTES do `<main>` no
         * documento. Quem navega por títulos — que é como se lê uma tela com
         * leitor de tela — ouvia "Atendimento, Financeiro, Infraestrutura…"
         * antes do `<h1>` da página, e a hierarquia do documento começava no
         * nível 2. Rótulo de grupo de menu não é título de seção da página.
         *
         * Vira texto comum com `id`, e a lista aponta para ele com
         * `aria-labelledby`: ao entrar no grupo o leitor anuncia "Atendimento,
         * lista com 4 itens" — mais informação do que o `<h2>` dava, e sem
         * nenhuma linha no índice de títulos.
         */
        const rotuloId = `nav-grupo-${i}`
        return (
        <li key={grupo.label ?? `solto-${i}`}>
          {grupo.label && (
            <p
              id={rotuloId}
              className="mb-1 px-3 text-[0.68rem] font-semibold uppercase tracking-wider text-[var(--color-ink-3)]"
            >
              {grupo.label}
            </p>
          )}
          <ul
            aria-labelledby={grupo.label ? rotuloId : undefined}
            className="flex flex-col gap-0.5"
          >
            {grupo.items.map((item) => (
              <li key={item.href ?? item.label}>
                {item.href === null ? <SoonItem item={item} /> : (
                  <NavLink href={item.href}>{item.label}</NavLink>
                )}
              </li>
            ))}
          </ul>
        </li>
        )
      })}
    </ul>
  )
}

/**
 * Item previsto, sem tela.
 *
 * É um `<span>`, não um `<button disabled>`: botão desabilitado sai da ordem de
 * tabulação sem explicar por quê, e leitor de tela anuncia "botão indisponível",
 * que não informa nada. Aqui o selo "em breve" está no texto lido, e o `title`
 * carrega o motivo.
 */
function SoonItem({ item }: { item: NavItem }) {
  return (
    <span
      title={item.hint}
      className="flex cursor-default items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-[var(--color-ink-3)]"
    >
      <span>{item.label}</span>
      <span className="rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[0.62rem] font-semibold uppercase tracking-wide">
        em breve
      </span>
    </span>
  )
}

/**
 * Navegação compacta de tablet e celular (RNF-07).
 *
 * Sem grupos, e de propósito: cabeçalho de grupo numa tira horizontal ocuparia
 * o espaço dos próprios itens. Aqui a lista é plana e os itens previstos ficam de
 * fora — numa barra que já rola de lado, item que não leva a lugar nenhum só
 * empurra para longe o que leva.
 */
export function CompactNav({ items }: { items: NavItem[] }) {
  return (
    <ul className="flex gap-1 px-2 py-1.5">
      {items
        .filter((i) => i.href !== null)
        .map((item) => (
          <li key={item.href} className="shrink-0">
            <NavLink href={item.href!}>{item.label}</NavLink>
          </li>
        ))}
    </ul>
  )
}
