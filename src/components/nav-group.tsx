'use client'

import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { usePathname } from 'next/navigation'

/**
 * A sanfona do menu: **um grupo aberto de cada vez**.
 *
 * ## O que mudou, e por que o estado subiu de lugar
 *
 * Antes cada grupo decidia sozinho se estava aberto, e vários podiam estar ao
 * mesmo tempo. Sanfona no sentido estrito é outra coisa: abrir um fecha os
 * outros, e a barra passa a ter uma altura previsível — o que estava em oito
 * estados independentes vira um.
 *
 * Isso é exatamente o tipo de estado que não cabe no componente: "qual grupo
 * está aberto" é uma frase sobre o conjunto, não sobre cada grupo. Daí o
 * contexto: `SanfonaDoMenu` sabe a resposta, e cada `NavGroup` só pergunta se a
 * resposta é ele.
 *
 * A barra inteira continua Server Component — o provedor recebe `children` já
 * renderizados pelo servidor e não os re-renderiza. O que atravessa para o
 * cliente é a lista de `id` e `href` dos grupos, que é o mínimo para saber qual
 * grupo contém a tela atual.
 *
 * ## As três regras, em ordem de precedência
 *
 * **1. A escolha de quem está na tela manda.** Clicou em "Financeiro", abre
 * Financeiro e fecha o resto; clicou de novo, fecha tudo. A escolha vale
 * enquanto a pessoa continuar na mesma tela.
 *
 * **2. Ao trocar de tela, o grupo da tela nova abre sozinho.** Sem isto, navegar
 * esconderia justamente onde a pessoa está — e numa sanfona o efeito é pior que
 * no acordeão livre, porque não sobra nenhum outro grupo aberto para dar
 * contexto. É por isso que a escolha guarda o caminho em que foi feita: ela não
 * é esquecida, é **suspensa** quando a tela muda para dentro de outro grupo.
 *
 * **3. Numa tela que não pertence a grupo nenhum, a escolha anterior continua
 * valendo.** "Visão geral", "Portal" e "Minha conta" estão soltos no topo e no
 * rodapé. Se a regra 2 fosse cega, ir à Visão geral fecharia a barra inteira e
 * obrigaria a reabrir uma gaveta para ir a qualquer lugar. Aqui não há grupo
 * ativo para disputar, então o último aberto continua aberto.
 *
 * Na primeiríssima visita não há escolha nem grupo ativo: abre o primeiro grupo
 * (Atendimento). Uma sanfona não tem como "chegar toda aberta", e chegar toda
 * fechada obrigaria a caçar antes de conhecer — abrir o grupo que é o coração do
 * produto é o meio-termo honesto.
 *
 * ## Por que `useSyncExternalStore`, e não `useState` com efeito
 *
 * Ler `localStorage` durante a renderização faria o HTML do servidor discordar
 * do cliente — o defeito de hidratação que a varredura de telas pegou em
 * `/resultado`. Lê-lo num efeito e chamar `setState` resolve isso e cria outro:
 * uma renderização em cascata, que o próprio compilador do React recusa.
 *
 * `useSyncExternalStore` é a resposta para exatamente este caso: tem um
 * instantâneo PARA O SERVIDOR (aqui, "não há escolha") e outro para o cliente, e
 * troca de um para o outro depois da hidratação, sem efeito e sem divergência.
 */
type Sanfona = {
  /** O grupo aberto agora, ou `null` quando a sanfona está toda fechada. */
  abertoId: string | null
  escolher: (id: string, aberto: boolean) => void
}

const Contexto = createContext<Sanfona | null>(null)

export function SanfonaDoMenu({
  grupos,
  children,
}: {
  /** Os grupos que abrem, na ordem da barra, com os destinos de cada um. */
  grupos: { id: string; hrefs: string[] }[]
  children: ReactNode
}) {
  /*
   * O caminho vem de `usePathname()` e não do servidor porque um layout do App
   * Router não recebe a rota — ele persiste entre navegações. O gancho vale na
   * renderização do servidor também, então o estado inicial é o mesmo nos dois
   * lados.
   */
  const caminho = usePathname()
  const escolha = useSyncExternalStore(assinar, lerEscolha, () => null)

  const grupoAtivo = useMemo(
    () =>
      grupos.find((g) => g.hrefs.some((h) => caminho === h || caminho.startsWith(`${h}/`)))
        ?.id ?? null,
    [grupos, caminho],
  )

  /* As três regras do cabeçalho, nesta ordem. A escolha só é soberana enquanto a
     tela for a mesma em que foi feita; depois disso o grupo da tela nova tem
     precedência, e, na falta dele, a escolha suspensa volta a valer. */
  const abertoId =
    escolha && escolha.caminho === caminho
      ? escolha.grupo
      : (grupoAtivo ?? (escolha ? escolha.grupo : (grupos[0]?.id ?? null)))

  const valor = useMemo<Sanfona>(
    () => ({
      abertoId,
      escolher: (id, aberto) => gravarEscolha(aberto ? id : null, caminho),
    }),
    [abertoId, caminho],
  )

  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>
}

/**
 * Um grupo da sanfona.
 *
 * ## Por que `<details>`, e não um botão com estado próprio
 *
 * `<details>`/`<summary>` já vem com abrir/fechar por teclado, `aria-expanded`
 * implícito e busca-na-página do navegador funcionando dentro do conteúdo
 * fechado. É o mesmo motivo de `edit-panel.tsx`: um acordeão escrito à mão custa
 * armadilha de foco e `Esc` à mão, três lugares onde acessibilidade quebra em
 * silêncio.
 */
export function NavGroup({
  id,
  label,
  children,
}: {
  id: string
  label: string
  children: ReactNode
}) {
  const sanfona = useContext(Contexto)
  const aberto = sanfona?.abertoId === id

  return (
    <details
      open={aberto}
      onToggle={(e) => {
        const estaAberto = (e.currentTarget as HTMLDetailsElement).open
        /*
         * O guarda que faz a exclusividade não entrar em laço. Fechar um grupo é
         * consequência de abrir outro, e o navegador dispara `toggle` tanto no
         * clique de quem usa quanto na mudança que o React faz por conta — sem
         * distinguir os dois, o fechamento do grupo anterior seria lido como
         * "a pessoa fechou tudo" e desfaria a abertura que acabou de acontecer.
         *
         * A diferença está aqui: no clique, o DOM discorda do estado que o React
         * tem; no eco, já concorda. Dá para comparar porque o evento `toggle` é
         * enfileirado pelo navegador, não despachado na hora — quando ele chega,
         * a re-renderização já foi comitada.
         */
        if (estaAberto === aberto) return
        sanfona?.escolher(id, estaAberto)
      }}
      className="group"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-3 py-1.5 text-[0.68rem] font-semibold uppercase tracking-wider text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand)] [&::-webkit-details-marker]:hidden">
        {/* A setinha, desenhada e não escrita: o `›` de texto, no corpo de 0,68rem
            do rótulo, virava um cisco de um pixel e meio — a única pista visual do
            estado era a que menos se via. O traço de 2 unidades num viewBox de 8
            sobrevive à redução.

            `currentColor` para acompanhar o `hover` do `<summary>` sem repetir
            cor. `aria-hidden` porque `<summary>` já anuncia o estado: lê-la em voz
            alta diria "sinal de maior", que não acrescenta nada a "recolhido".

            Sem `<title>` aqui — o React 19 o promove a título do documento mesmo
            dentro de `<svg>`, e foi assim que a hidratação de `/resultado`
            quebrou. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 8 12"
          className="h-3 w-2 shrink-0 transition-transform duration-150 group-open:rotate-90"
        >
          <path
            d="M1.5 1.5 6 6l-4.5 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {label}
      </summary>
      {children}
    </details>
  )
}

/* -------------------------------------------------------------------------- */
/* A escolha, como sistema externo                                            */
/* -------------------------------------------------------------------------- */

/**
 * Uma chave só, e não uma por grupo.
 *
 * A versão anterior guardava `sti.menu.<grupo>` com um booleano em cada. Com um
 * grupo aberto de cada vez, oito chaves descreveriam um estado que não existe
 * mais — e duas delas dizendo "aberto" seria um estado impossível, guardado.
 * As chaves antigas ficam órfãs no navegador de quem já usou a barra; são
 * inofensivas, ninguém as lê, e limpá-las custaria uma varredura por um ganho
 * de alguns bytes.
 */
const CHAVE = 'sti.menu.sanfona'

type Escolha = {
  /** `null` = a pessoa fechou o que estava aberto e não abriu outro. */
  grupo: string | null
  /** A tela em que a escolha foi feita — ver a regra 2 no cabeçalho. */
  caminho: string
}

const ouvintes = new Set<() => void>()

function assinar(aoMudar: () => void): () => void {
  ouvintes.add(aoMudar)
  return () => ouvintes.delete(aoMudar)
}

/*
 * O instantâneo precisa ser o MESMO objeto entre leituras enquanto nada muda:
 * `useSyncExternalStore` compara por identidade e entraria em laço de
 * renderização se `JSON.parse` devolvesse um objeto novo a cada chamada.
 */
let cacheBruto: string | null = null
let cacheObjeto: Escolha | null = null

/*
 * A mesma escolha, guardada também na memória da aba.
 *
 * Com armazenamento bloqueado — navegação privada, política de empresa —, voltar
 * `null` de toda leitura não deixaria a sanfona só sem memória: deixaria sem
 * funcionamento, porque o grupo clicado seria reaberto pelo cálculo da linha
 * seguinte. Aqui ela funciona igual dentro da aba; o que se perde é lembrar
 * depois de recarregar, que é exatamente o que o armazenamento bloqueado quer
 * dizer.
 */
let memoria: Escolha | null = null
let armazenamentoOk = true

/** `null` = a pessoa nunca mexeu na sanfona. */
function lerEscolha(): Escolha | null {
  if (!armazenamentoOk) return memoria

  let bruto: string | null = null
  try {
    bruto = window.localStorage.getItem(CHAVE)
  } catch {
    armazenamentoOk = false
    return memoria
  }

  if (bruto === cacheBruto) return cacheObjeto
  cacheBruto = bruto
  cacheObjeto = analisar(bruto)
  return cacheObjeto
}

function analisar(bruto: string | null): Escolha | null {
  if (bruto === null) return null
  try {
    const v = JSON.parse(bruto) as unknown
    if (typeof v !== 'object' || v === null) return null
    const { grupo, caminho } = v as Record<string, unknown>
    if (typeof caminho !== 'string') return null
    if (grupo !== null && typeof grupo !== 'string') return null
    return { grupo, caminho }
  } catch {
    /* Valor corrompido à mão ou sobra de uma versão anterior: vale como "nunca
       mexeu", que é o estado que a barra sabe exibir. */
    return null
  }
}

function gravarEscolha(grupo: string | null, caminho: string): void {
  memoria = { grupo, caminho }
  try {
    window.localStorage.setItem(CHAVE, JSON.stringify(memoria))
  } catch {
    armazenamentoOk = false
  }
  /* Avisa todos os grupos: eles compartilham a assinatura, e sem o aviso o
     grupo que estava aberto não saberia que precisa fechar. */
  for (const ouvinte of ouvintes) ouvinte()
}
