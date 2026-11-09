'use client'

import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
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

  /*
   * Fechar insiste, e isso não é zelo: é um defeito medido.
   *
   * Vinte aberturas seguidas da gaveta de links, com `Esc` em cada uma: dezenove
   * fecharam em ~106ms e uma não fechou em vinte segundos — e o que o teste
   * registrou nessa é que **o endereço não mudou**. Não foi lentidão de
   * servidor; o `router.push` se perdeu. Num `push` do App Router a URL só muda
   * quando a resposta do servidor chega e a transição é confirmada, então uma
   * transição descartada no caminho não deixa rastro nenhum: a tecla não faz
   * nada, sem erro, sem sintoma, e a pessoa conclui que a gaveta travou.
   *
   * A reação é tentar de novo — então a tela tenta de novo, três vezes, a cada
   * 700ms. O laço não precisa de condição de parada própria: quando o `push`
   * finalmente pega, a página re-renderiza sem a gaveta, este componente
   * desmonta e a limpeza do efeito cancela o que sobrou. Um `push` repetido
   * para o mesmo endereço enquanto o primeiro ainda está em voo é ignorado pelo
   * roteador, então insistir não custa requisição a mais.
   */
  const fecharInsistindo = useCallback(() => {
    router.push(fechar as Route)

    let tentativas = 0
    const timers: ReturnType<typeof setTimeout>[] = []
    const conferir = () => {
      if (window.location.pathname + window.location.search === fechar) return
      if (tentativas >= 3) return
      tentativas += 1
      router.push(fechar as Route)
      timers.push(setTimeout(conferir, 700))
    }
    timers.push(setTimeout(conferir, 700))
    return () => timers.forEach(clearTimeout)
  }, [fechar, router])

  useEffect(() => {
    let limpar: (() => void) | undefined
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === 'Escape') limpar = fecharInsistindo()
    }
    window.addEventListener('keydown', aoTeclar)
    return () => {
      window.removeEventListener('keydown', aoTeclar)
      limpar?.()
    }
  }, [fecharInsistindo])

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
        onMouseDown={() => fecharInsistindo()}
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

/**
 * O cabeçalho de uma gaveta.
 *
 * Existe para que as gavetas de chamado, ativo e título não cheguem cada uma
 * com o seu próprio cabeçalho — foi exatamente assim que a aplicação ganhou
 * quatro larguras diferentes para a mesma coluna de formulário. A linha de
 * cima é o contexto (número, categoria, quando), o título é o registro, e o
 * selo é o estado dele.
 */
export function CabecalhoDaGaveta({
  titulo,
  linha,
  fechar,
  selo,
}: {
  titulo: string
  linha: string
  fechar: string
  selo?: ReactNode
}) {
  return (
    <header className="border-b border-[var(--color-border)] px-4 py-3">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-xs text-[var(--color-ink-3)]">{linha}</p>
        <Link
          href={fechar as Route}
          aria-label="Fechar a gaveta"
          data-testid="fechar-gaveta"
          className="rounded-lg border border-[var(--color-border)] px-2 py-0.5 text-sm text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]"
        >
          ✕
        </Link>
      </div>
      <h2 className="mt-1 flex flex-wrap items-center gap-2 text-lg font-bold leading-snug text-[var(--color-ink)]">
        {titulo}
        {selo}
      </h2>
    </header>
  )
}

/** O corpo rolável da gaveta — o mesmo respiro em todas elas. */
export function CorpoDaGaveta({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-6 pt-3">{children}</div>
}
