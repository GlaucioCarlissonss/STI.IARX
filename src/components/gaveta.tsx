'use client'

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import type { Route } from 'next'

/**
 * A gaveta — o registro aberto ao lado da lista, não no lugar dela.
 *
 * ## Por que ela existe
 *
 * Trabalhar um chamado era sair da lista, abrir a tela dele, mexer, voltar e
 * procurar de novo onde se estava. Numa triagem de trinta chamados isso é
 * trinta idas e voltas, e a cada volta a lista recomeça do topo.
 *
 * ## Por que o conteúdo vem do SERVIDOR
 *
 * A gaveta é um parâmetro do endereço (`?aberto=<id>`), e quem monta o conteúdo
 * é a página — componente de servidor, com as mesmas consultas, o mesmo RLS e
 * as mesmas permissões da tela inteira. Não existe uma rota de API nova
 * devolvendo chamado em JSON, e por isso não existe uma segunda porta para
 * manter em dia com a primeira. Isto aqui é só a moldura.
 *
 * ## Por que o endereço, e não estado em memória
 *
 * Porque "o chamado 5 aberto na lista dos críticos" vira link; porque o
 * "voltar" do navegador fecha a gaveta, que é o que todo mundo tenta; e porque
 * recarregar a página não perde o que estava aberto.
 *
 * ## No celular ela sobe de baixo
 *
 * Não por estilo: numa tela de 390px uma gaveta lateral é a tela inteira, e
 * aí a lista some de qualquer jeito. Subindo de baixo, ela cobre dois terços e
 * o contexto continua visível na faixa de cima — e o gesto de arrastar para
 * baixo é o que o aparelho já ensinou em todo aplicativo.
 */
export function Gaveta({
  fechar,
  rotulo,
  children,
}: {
  /** Endereço da MESMA lista sem o parâmetro da gaveta. */
  fechar: string
  rotulo: string
  children: ReactNode
}) {
  const router = useRouter()
  const painelRef = useRef<HTMLDivElement>(null)

  /*
   * Ela é desenhada no `<body>`, por portal — e isso NÃO é preferência de
   * organização, é geometria.
   *
   * O `<main>` da aplicação tem uma animação de entrada que mexe em
   * `transform`. Um elemento com animação de transform vira o bloco de
   * contenção dos descendentes `fixed`: a gaveta deixava de se posicionar pela
   * JANELA e passava a se posicionar pelo `<main>`. No computador isso quase
   * não aparecia; no celular aparecia inteiro — a folha ficava com 16px de
   * sobra de cada lado, exatamente o `px-4` do contêiner, parecendo um cartão
   * solto no ar em vez de uma folha subindo da borda do aparelho.
   *
   * `useSyncExternalStore` em vez de `useState` + `useEffect`: no servidor não
   * existe `document`, e é ele que devolve `false` lá e `true` aqui sem
   * sincronizar estado dentro de efeito.
   */
  const montado = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  )

  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === 'Escape') router.push(fechar as Route)
    }
    window.addEventListener('keydown', aoTeclar)
    return () => window.removeEventListener('keydown', aoTeclar)
  }, [fechar, router])

  /*
   * O foco vai para o PAINEL, não para o botão de fechar.
   *
   * Parece detalhe e é o que faz o teclado continuar funcionando: a lista
   * ignora J/K quando o foco está num botão ou campo — senão digitar no filtro
   * moveria o cursor. Com o foco no painel, que é um `div`, J e K continuam
   * passando para o próximo chamado com a gaveta aberta, que é o modo de
   * triagem que ela existe para permitir.
   */
  useEffect(() => {
    painelRef.current?.focus({ preventScroll: true })
  }, [])

  if (!montado) return null

  return createPortal(
    <>
      {/* O véu só existe no celular: no computador a lista ao lado continua
          clicável de propósito — clicar em outra linha troca o conteúdo da
          gaveta em vez de fechá-la e obrigar a abrir de novo. */}
      <div
        onMouseDown={() => router.push(fechar as Route)}
        className="fixed inset-0 z-30 bg-[rgba(16,22,34,.45)] lg:hidden"
      />

      <aside
        ref={painelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="false"
        aria-label={rotulo}
        data-testid="gaveta"
        className={[
          'fixed z-40 flex flex-col bg-[var(--color-surface)] shadow-2xl outline-none focus-visible:outline-none',
          /* Celular: folha subindo de baixo, dois terços da tela. */
          'inset-x-0 bottom-0 max-h-[82vh] rounded-t-2xl border-t border-[var(--color-border)] gaveta-sobe',
          /* Computador: coluna à direita, começando ABAIXO do cabeçalho —
             agora que ela se posiciona pela janela, sem `top` ela cobriria a
             busca e o seletor de empresa, que continuam sendo o caminho de
             saída de quem está com um chamado aberto. */
          'lg:bottom-0 lg:left-auto lg:right-0 lg:top-14 lg:max-h-none lg:w-[34rem] lg:rounded-none lg:border-l lg:border-t-0',
        ].join(' ')}
      >
        <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 rounded-full bg-[var(--color-border-strong)] lg:hidden" />
        {children}
      </aside>
    </>,
    document.body,
  )
}
