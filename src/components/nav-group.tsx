'use client'

import { useSyncExternalStore, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'

/**
 * Um grupo do menu que abre e fecha.
 *
 * ## Por que `<details>`, e não um botão com estado próprio
 *
 * `<details>`/`<summary>` já vem com abrir/fechar por teclado, `aria-expanded`
 * implícito e busca-na-página do navegador funcionando dentro do conteúdo
 * fechado. É o mesmo motivo de `edit-panel.tsx`: um acordeão escrito à mão
 * custa armadilha de foco e `Esc` à mão, três lugares onde acessibilidade
 * quebra em silêncio.
 *
 * ## As duas coisas que um acordeão de menu precisa acertar
 *
 * **1. O grupo da tela atual abre sozinho.** Sem isso, cada navegação
 * esconderia justamente onde a pessoa está, e o menu passaria a mentir sobre a
 * própria posição.
 *
 * **2. O que a pessoa fecha continua fechado.** A preferência mora em
 * `localStorage`, por grupo.
 *
 * ## Por que `useSyncExternalStore`, e não `useState` com efeito
 *
 * Ler `localStorage` durante a renderização faria o HTML do servidor discordar
 * do cliente — o defeito de hidratação que a varredura de telas pegou em
 * `/resultado`. Lê-lo num efeito e chamar `setState` resolve isso e cria outro:
 * uma renderização em cascata, que o próprio compilador do React recusa.
 *
 * `useSyncExternalStore` é a resposta para exatamente este caso: ele tem um
 * instantâneo PARA O SERVIDOR (aqui, "não há preferência") e outro para o
 * cliente, e troca de um para o outro depois da hidratação, sem efeito e sem
 * divergência.
 *
 * ## O padrão é ABERTO
 *
 * Primeira visita mostra tudo. Um menu que chega fechado obriga a caçar antes
 * de conhecer, e esconder por padrão o que a pessoa ainda não sabe que existe é
 * o contrário do que um menu faz. Quem não usa um grupo o fecha uma vez, e ele
 * continua fechado — a barra encolhe por escolha de quem usa, não por decisão
 * de quem programou.
 */
export function NavGroup({
  id,
  label,
  children,
  hrefs,
}: {
  id: string
  label: string
  children: ReactNode
  /** Os destinos do grupo, para saber se a tela atual está aqui dentro. */
  hrefs: string[]
}) {
  /*
   * O caminho vem de `usePathname()` e não do servidor porque um layout do App
   * Router não recebe a rota — ele persiste entre navegações. O gancho vale na
   * renderização do servidor também, então o estado inicial é o mesmo nos dois
   * lados.
   */
  const caminho = usePathname()
  const temItemAtivo = hrefs.some((h) => caminho === h || caminho.startsWith(`${h}/`))

  const preferencia = useSyncExternalStore(
    assinar,
    () => lerPreferencia(id),
    () => null,
  )

  /* O grupo da tela atual abre mesmo que tenha sido fechado antes: estar numa
     tela e não ver onde ela fica é pior que desrespeitar a preferência. */
  const aberto = temItemAtivo || (preferencia ?? true)

  return (
    <details
      open={aberto}
      onToggle={(e) => gravarPreferencia(id, (e.currentTarget as HTMLDetailsElement).open)}
      className="group"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-3 py-1.5 text-[0.68rem] font-semibold uppercase tracking-wider text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand)] [&::-webkit-details-marker]:hidden">
        {/* A setinha. `aria-hidden` porque `<summary>` já anuncia o estado —
            lê-la em voz alta diria "sinal de maior", que não acrescenta nada a
            "recolhido". */}
        <span
          aria-hidden="true"
          className="inline-block text-[0.8rem] leading-none transition-transform duration-150 group-open:rotate-90"
        >
          ›
        </span>
        {label}
      </summary>
      {children}
    </details>
  )
}

/* -------------------------------------------------------------------------- */
/* A preferência, como sistema externo                                        */
/* -------------------------------------------------------------------------- */

const ouvintes = new Set<() => void>()

function assinar(aoMudar: () => void): () => void {
  ouvintes.add(aoMudar)
  return () => ouvintes.delete(aoMudar)
}

function chave(id: string): string {
  return `sti.menu.${id}`
}

/** `null` = a pessoa nunca mexeu neste grupo. */
function lerPreferencia(id: string): boolean | null {
  try {
    const guardado = window.localStorage.getItem(chave(id))
    return guardado === null ? null : guardado === '1'
  } catch {
    /* Navegação privada, armazenamento bloqueado: o menu funciona igual, só
       não lembra. Não é motivo para a barra inteira falhar. */
    return null
  }
}

function gravarPreferencia(id: string, aberto: boolean): void {
  try {
    window.localStorage.setItem(chave(id), aberto ? '1' : '0')
  } catch {
    /* idem */
  }
  /* Avisa os outros grupos: eles compartilham a assinatura, e sem o aviso um
     grupo recém-fechado só refletiria a mudança na próxima renderização por
     outro motivo. */
  for (const ouvinte of ouvintes) ouvinte()
}
