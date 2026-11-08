'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'

/**
 * O menu do celular, em gaveta.
 *
 * ## O que ele substitui
 *
 * Uma tira horizontal, fixa no rodapé, com os trinta e poucos destinos que a
 * pessoa alcança — rolando de lado. Três defeitos de uma vez: o destino que
 * interessa quase nunca está visível, rolar de lado é o gesto que ninguém
 * procura, e a tira não mostrava os GRUPOS, então a organização que existe no
 * desktop simplesmente não existia no celular.
 *
 * Agora é um botão e uma gaveta com a MESMA sanfona do desktop — o mesmo
 * componente, não uma cópia. Duas navegações que deveriam ser a mesma coisa
 * divergem no primeiro grupo renomeado.
 *
 * ## Por que a gaveta fecha ao trocar de tela
 *
 * Porque navegar É a tarefa. Sem isso, a pessoa escolhe um destino e continua
 * olhando para o menu, com a tela nova escondida atrás dele.
 */
export function MenuCelular({ children }: { children: ReactNode }) {
  const caminho = usePathname()
  const fecharRef = useRef<HTMLButtonElement>(null)

  /*
   * A gaveta guarda EM QUE TELA foi aberta, e "está aberta" é uma comparação
   * com a tela atual. Trocou de tela, a comparação falha e ela se fecha
   * sozinha — sem um efeito observando o caminho para zerar estado, que é o
   * padrão que causa renderização em cascata (e que o lint deste projeto
   * recusa, com razão).
   */
  const [abertaEm, setAbertaEm] = useState<string | null>(null)
  const aberto = abertaEm !== null && abertaEm === caminho
  const setAberto = (v: boolean) => setAbertaEm(v ? caminho : null)

  useEffect(() => {
    if (!aberto) return
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAbertaEm(null)
    }
    window.addEventListener('keydown', aoTeclar)
    /* Trava a rolagem do fundo: sem isso, arrastar a gaveta rola a página
       atrás dela, e ao fechar a pessoa está num lugar que não escolheu. */
    const antes = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    fecharRef.current?.focus()
    return () => {
      window.removeEventListener('keydown', aoTeclar)
      document.body.style.overflow = antes
    }
  }, [aberto])

  return (
    <>
      <button
        type="button"
        onClick={() => setAberto(true)}
        aria-expanded={aberto}
        aria-label="Abrir o menu"
        data-testid="abrir-menu-celular"
        className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-ink-2)] lg:hidden"
      >
        ☰ Menu
      </button>

      {aberto && (
        <div
          className="fixed inset-0 z-40 bg-[rgba(16,22,34,.45)] lg:hidden"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setAberto(false)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navegação principal"
            data-testid="gaveta-menu"
            className="flex h-full w-[82%] max-w-sm flex-col bg-[var(--color-surface)] shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
              <span className="font-display text-sm font-bold">Navegação</span>
              <button
                ref={fecharRef}
                type="button"
                onClick={() => setAberto(false)}
                className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-sm text-[var(--color-ink-2)]"
              >
                ✕ Fechar
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-2 py-3">{children}</div>
          </div>
        </div>
      )}
    </>
  )
}
