'use client'

import { useEffect, useSyncExternalStore } from 'react'

/**
 * O fio de progresso da navegação.
 *
 * ## Por que ele existe
 *
 * As navegações desta aplicação levam entre 110 e 250ms (medido em `/painel`,
 * `/inventario` e `/financeiro/fluxo-de-caixa`). É rápido demais para pedir um
 * esqueleto — ele apareceria e sumiria antes de ser lido, e piscar é pior que
 * esperar parado — e lento o bastante para a pessoa duvidar se o clique pegou
 * e clicar de novo.
 *
 * Um fio de 2px sob o cabeçalho resolve a dúvida sem roubar a tela.
 *
 * ## Por que uma contagem, e não um booleano
 *
 * Porque duas coisas podem estar navegando ao mesmo tempo — o filtro que
 * acabou de mudar e a gaveta que está abrindo. Com booleano, a primeira a
 * terminar apagaria o fio enquanto a outra ainda está em curso.
 */

let emCurso = 0
const ouvintes = new Set<() => void>()

function publicar() {
  for (const o of ouvintes) o()
}

function assinar(aoMudar: () => void) {
  ouvintes.add(aoMudar)
  return () => {
    ouvintes.delete(aoMudar)
  }
}

const ler = () => emCurso > 0
const lerNoServidor = () => false

/**
 * Liga um `useTransition` local ao fio global.
 *
 * É efeito porque sincroniza com um sistema EXTERNO ao React (a loja de
 * módulo) — não é estado sendo copiado de um lugar para outro. A função de
 * limpeza é o que garante que o fio desapareça mesmo quando o componente sai
 * da tela no meio da navegação.
 */
export function useProgresso(pendente: boolean) {
  useEffect(() => {
    if (!pendente) return
    emCurso += 1
    publicar()
    return () => {
      emCurso -= 1
      publicar()
    }
  }, [pendente])
}

export function BarraDeNavegacao() {
  const navegando = useSyncExternalStore(assinar, ler, lerNoServidor)

  return (
    <div
      aria-hidden="true"
      data-testid="progresso"
      data-navegando={navegando ? '1' : undefined}
      className={`pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 transition-opacity ${
        navegando ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <div className="barra-navegando h-full bg-[var(--color-brand)]" />
    </div>
  )
}
