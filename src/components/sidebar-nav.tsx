import type { NavGroup, NavItem } from '@/lib/navigation'
import { NavLink } from './nav-link'
import { NavGroup as GrupoExpansivel } from './nav-group'

/**
 * Barra lateral agrupada, com grupos que abrem e fecham.
 *
 * ## A decisão mudou, e vale registrar o que ela substituiu
 *
 * Esta barra foi escrita "sempre expandida, sem acordeão", e o argumento era
 * bom: o menu já chega filtrado por permissão, então um acordeão custaria um
 * clique para resolver um problema de altura que a filtragem já resolvia.
 *
 * O que o argumento não pesava: **para quem enxerga tudo, a lista passou de
 * vinte e cinco para trinta e três itens** em oito grupos. Nesse tamanho o
 * cabeçalho deixa de servir para a vista pular — vira mais uma linha de ruído —
 * e a barra passa a rolar, que é quando um menu começa a esconder coisa sem
 * avisar — e sem oferecer nada em troca.
 *
 * O acordeão devolve o cabeçalho ao seu trabalho: ele vira o alvo. E as duas
 * objeções originais continuam válidas, então foram respondidas em vez de
 * ignoradas — o grupo da tela atual abre sozinho, e **tudo chega aberto na
 * primeira visita**; a barra encolhe por escolha de quem usa, e a escolha
 * persiste (ver `nav-group.tsx`).
 *
 * Continua Server Component: a decisão de O QUE mostrar é do servidor. Só o
 * abre/fecha e o realce do item ativo são cliente, porque dependem da rota.
 */
export function SidebarNav({ groups }: { groups: NavGroup[] }) {
  return (
    <ul className="flex flex-col gap-4">
      {groups.map((grupo, i) => {
        /*
         * O rótulo do grupo nunca foi `<h2>`, e continua não sendo: o menu vem
         * ANTES do `<main>`, e quem navega por títulos ouviria "Atendimento,
         * Financeiro…" antes do `<h1>` da página. Agora ele é o `<summary>` do
         * grupo — que é alvo de clique e de teclado, e anuncia o estado sem
         * entrar no índice de títulos.
         */
        const lista = (
          <ul
            /* Era `aria-labelledby` apontando para o `<p>` do rótulo. O `<p>`
               virou `<summary>`, e uma referência para um id que não existe
               mais não falha em lugar nenhum — só deixa a lista sem nome para
               quem usa leitor de tela. `aria-label` diz a mesma coisa sem
               depender de outro elemento. */
            aria-label={grupo.label ?? undefined}
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
        )

        /* Grupo sem rótulo não tem o que abrir: são os destinos soltos do topo,
           que precisam estar sempre à vista. */
        if (!grupo.label) {
          return <li key={`solto-${i}`}>{lista}</li>
        }

        return (
          <li key={grupo.label}>
            <GrupoExpansivel
              id={identificador(grupo.label)}
              label={grupo.label}
              hrefs={grupo.items.flatMap((item) => (item.href ? [item.href] : []))}
            >
              {lista}
            </GrupoExpansivel>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * O identificador que guarda o abre/fecha.
 *
 * Vem do RÓTULO, e não do índice do grupo: índice muda quando um grupo é
 * acrescentado no meio, e a preferência de "Financeiro" passaria a valer para
 * "Integrações" sem que ninguém mexesse em nada.
 */
function identificador(rotulo: string): string {
  return rotulo
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
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
