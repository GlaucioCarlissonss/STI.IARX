'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { Route } from 'next'
import {
  useEffect,
  useTransition,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { comParametros } from '@/lib/data/endereco'
import type { SlaState, TicketStatus } from '@/lib/types'
import { PriorityBadge, StatusBadge } from './ui'
import { EdicaoNaLinha, type OpcaoDeEdicao } from './edicao-na-linha'
import { avisar } from './avisos'
import { useProgresso } from './progresso'
import { acaoEmLote } from '@/app/(app)/tickets/actions'

/**
 * A lista de chamados — a tela em que o atendimento passa o dia.
 *
 * ## O que ela substitui, e por quê
 *
 * Uma tabela de nove colunas com uma barra de filtro em cima e um botão
 * "Filtrar". Três problemas medidos, não opinados:
 *
 * - **Cinco linhas por tela de 900px.** Trinta chamados abertos eram seis
 *   rolagens para se ter uma ideia do dia.
 * - **Nenhuma ação sem sair da lista.** Atribuir três chamados eram doze
 *   cliques e três telas, uma de cada vez.
 * - **Ordem fixa e invisível.** A lista vinha por score de priorização e não
 *   havia como ordenar por prazo, que é a pergunta mais feita de todas.
 *
 * ## Por que o estado de seleção é do cliente e o resto não é
 *
 * Filtro, ordem e página vivem no endereço, porque são a pergunta e a pergunta
 * se compartilha. A SELEÇÃO não: ela é uma intenção momentânea, morre quando a
 * pessoa troca de página e não faz sentido nenhum dentro de um link mandado
 * para outra pessoa. Por isso é o único estado que fica em memória aqui.
 *
 * ## Uma marcação para dois formatos
 *
 * Abaixo de `lg` as linhas viram fichas. Não é um componente paralelo: são os
 * mesmos dados, a mesma seleção e a mesma ordem, renderizados em outra forma no
 * mesmo arquivo. Duas implementações de "a lista" divergiriam no primeiro campo
 * novo — e a que ninguém abre no computador é sempre a que apodrece.
 */

export interface TicketDaLista {
  id: string
  numero: number
  titulo: string
  categoria: string
  abertura: string
  status: TicketStatus
  prioridadeLabel: string
  prioridadeCor: string
  fila: string
  filial: string
  atendente: string | null
  atendenteId: string | null
  /** As transições que o BANCO aceita a partir do estado atual (ADR-007). */
  statusPossiveis: OpcaoDeEdicao[]
  slaEstado: SlaState | null
  /** "No prazo", "SLA estourado"… — o texto que acompanha a cor do prazo. */
  slaRotulo: string
  prazo: string
  atrasado: boolean
}

/**
 * A cor do prazo é o semáforo de SLA.
 *
 * Vermelho é o que já estourou; âmbar é o que vai estourar nesta jornada. O
 * resto fica em cinza de propósito: se tudo tem cor, cor não quer dizer nada.
 */
function corDoPrazo(t: TicketDaLista): string {
  if (t.atrasado || t.slaEstado === 'breached') {
    return 'font-semibold text-[var(--color-breach-ink)]'
  }
  if (t.slaEstado === 'critical' || t.slaEstado === 'warning') {
    return 'font-medium text-[var(--color-warn-ink)]'
  }
  return 'text-[var(--color-ink-2)]'
}

export interface CabecalhoOrdenavel {
  chave: string
  rotulo: string
  /** `null` em coluna que não ordena — SLA é estado derivado, não campo. */
  href: string | null
  ativa: boolean
  asc: boolean
}

export interface OpcaoDeLote {
  valor: string
  rotulo: string
}

export interface PermissoesDaLista {
  atribuir: boolean
  status: boolean
  transferir: boolean
}

/* --- Densidade ------------------------------------------------------------
 *
 * Lida de `localStorage` por `useSyncExternalStore`, e não por `useState` +
 * `useEffect`: no servidor não existe `localStorage`, e qualquer leitura
 * durante a renderização produziria uma marcação diferente da do cliente — a
 * hidratação quebra, o React remonta a árvore e a tela pisca. O terceiro
 * argumento é o valor do servidor, e é por isso que ele existe.
 */
const CHAVE_DENSIDADE = 'sti.lista.densidade'
const EVENTO = 'sti:densidade'

function assinarDensidade(aoMudar: () => void) {
  window.addEventListener('storage', aoMudar)
  window.addEventListener(EVENTO, aoMudar)
  return () => {
    window.removeEventListener('storage', aoMudar)
    window.removeEventListener(EVENTO, aoMudar)
  }
}

function lerDensidade(): 'compacto' | 'confortavel' {
  try {
    return localStorage.getItem(CHAVE_DENSIDADE) === 'confortavel' ? 'confortavel' : 'compacto'
  } catch {
    // Navegação privada ou cookies bloqueados: o padrão vale, e a lista abre.
    return 'compacto'
  }
}

const densidadeDoServidor = () => 'compacto' as const

function gravarDensidade(valor: 'compacto' | 'confortavel') {
  try {
    localStorage.setItem(CHAVE_DENSIDADE, valor)
  } catch {
    /* sem memória entre visitas; a escolha ainda vale nesta. */
  }
  window.dispatchEvent(new Event(EVENTO))
}

/* --- A lista -------------------------------------------------------------- */

export function ListaDeTickets({
  tickets,
  cabecalhos,
  atendentes,
  filas,
  permissoes,
  base,
  params,
  aberto,
}: {
  tickets: TicketDaLista[]
  cabecalhos: CabecalhoOrdenavel[]
  atendentes: OpcaoDeLote[]
  filas: OpcaoDeLote[]
  permissoes: PermissoesDaLista
  /** Endereço desta lista, para montar o link que abre a gaveta. */
  base: string
  params: Record<string, string | undefined>
  /** O chamado que está na gaveta agora, se houver. */
  aberto: string | null
}) {
  const router = useRouter()
  /* Abrir a gaveta e andar com J/K são navegações: dentro de uma transição,
     elas acendem o fio de progresso do cabeçalho em vez de parecerem um
     clique que não pegou. */
  const [navegando, iniciarNavegacao] = useTransition()
  useProgresso(navegando)
  /* A mesma lista de atendentes do lote serve à edição na linha — duas listas
     divergiriam no dia em que alguém entrasse na equipe. */
  const atendentesEditaveis = atendentes

  /*
   * Com a gaveta aberta, a lista fica com menos da metade da largura. Em vez de
   * espremer sete colunas até o título virar reticência — que é o que o
   * `table-fixed` faria —, três colunas somem: fila, prioridade e atendente.
   *
   * Elas não se perdem: estão todas na gaveta, no chamado que está aberto. O
   * que a lista precisa manter nessa largura é o que permite ESCOLHER o
   * próximo: número, título, estado e prazo.
   */
  const estreita = aberto !== null
  const ocultas = estreita ? new Set(['fila', 'prioridade', 'atendente']) : new Set<string>()
  const visiveis = cabecalhos.filter((c) => !ocultas.has(c.chave))
  const densidade = useSyncExternalStore(assinarDensidade, lerDensidade, densidadeDoServidor)
  const [cursor, setCursor] = useState(0)
  const [marcados, setMarcados] = useState<ReadonlySet<string>>(new Set())
  const corpoRef = useRef<HTMLDivElement>(null)

  /* Sem `useCallback`: o compilador do React memoiza por conta própria, e a
     lista de dependências escrita à mão só cria a chance de ela discordar do
     que a função realmente usa — foi o que o lint apontou. */
  function alternar(id: string) {
    setMarcados((antes) => {
      const novo = new Set(antes)
      if (novo.has(id)) novo.delete(id)
      else novo.add(id)
      return novo
    })
  }

  /* O endereço que abre um chamado na gaveta. É a MESMA consulta mais um
     parâmetro — por isso a lista continua filtrada e ordenada como estava, e
     o link pode ser mandado para outra pessoa inteiro. */
  /* `pagina` vai explicitamente em `mudancas`: abrir a gaveta não muda o
     CONJUNTO, então a regra que devolve a lista para a primeira página não
     vale aqui — abrir um chamado da página 4 e voltar para a 1 seria perder o
     lugar, que é exatamente o que a gaveta existe para evitar. */
  function comGaveta(id: string) {
    return comParametros(base, params, { aberto: id, pagina: params.pagina ?? null })
  }

  /*
   * Teclado. O que ele NÃO pode fazer é disparar enquanto a pessoa digita: a
   * mesma tecla "j" que anda na lista é uma letra dentro do campo de filtro e
   * dentro da paleta de comandos. Sem esta guarda, buscar por "ajuste" moveria
   * o cursor três vezes e abriria um chamado no "e".
   */
  useEffect(() => {
    function aoTeclar(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const alvo = e.target as HTMLElement | null
      const digitando =
        alvo &&
        (alvo.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(alvo.tagName) ||
          alvo.closest('[data-testid="paleta"]') !== null)
      if (digitando) return
      if (tickets.length === 0) return

      const tecla = e.key.toLowerCase()

      /* Com a gaveta aberta, andar na lista TROCA o que está nela. É o modo de
         triagem: trinta chamados conferidos sem abrir trinta telas. Com a
         gaveta fechada, andar só move o cursor — ninguém quer que a seta
         dispare uma navegação a cada toque. */
      /* O endereço é montado AQUI dentro, e não por uma função de fora, de
         propósito: uma função definida no corpo do componente muda de
         identidade a cada renderização e faria este efeito se desinscrever e
         reinscrever sem parar — ou exigiria uma lista de dependências escrita
         à mão, que é o que o compilador do React desencoraja. */
      const enderecoDaGaveta = (id: string) =>
        comParametros(base, params, { aberto: id, pagina: params.pagina ?? null })

      const irPara = (indice: number) => {
        setCursor(indice)
        const alvo = tickets[indice]
        if (aberto && alvo) {
          iniciarNavegacao(() => router.push(enderecoDaGaveta(alvo.id) as Route, { scroll: false }))
        }
      }

      if (tecla === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        irPara(Math.min(cursor + 1, tickets.length - 1))
      } else if (tecla === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        irPara(Math.max(cursor - 1, 0))
      } else if (tecla === 'x') {
        e.preventDefault()
        const alvo = tickets[cursor]
        if (alvo) {
          setMarcados((antes) => {
            const novo = new Set(antes)
            if (novo.has(alvo.id)) novo.delete(alvo.id)
            else novo.add(alvo.id)
            return novo
          })
        }
      } else if (e.key === 'Enter') {
        const alvo = tickets[cursor]
        if (alvo) {
          e.preventDefault()
          /* Enter abre na GAVETA, não na página inteira: a tarefa quase sempre
             é olhar e decidir, e para isso sair da lista é custo sem retorno.
             Quem precisa da página inteira tem o link dentro da gaveta — e
             Ctrl+clique no título continua abrindo em outra aba. */
          iniciarNavegacao(() =>
            router.push(enderecoDaGaveta(alvo.id) as Route, { scroll: false }),
          )
        }
      } else if (e.key === 'Escape' && marcados.size > 0) {
        e.preventDefault()
        setMarcados(new Set())
      }
    }

    window.addEventListener('keydown', aoTeclar)
    return () => window.removeEventListener('keydown', aoTeclar)
  }, [tickets, cursor, marcados.size, router, aberto, base, params, iniciarNavegacao])

  /* O cursor tem que ficar visível: andar para fora da tela é o mesmo que não
     andar. `nearest` evita o salto brusco de centralizar a cada tecla. */
  useEffect(() => {
    const linha = corpoRef.current?.querySelector(`[data-indice="${cursor}"]`)
    linha?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  /* Mudou a página ou o filtro, o cursor volta ao topo e a seleção sai — manter
     marcado o que não está mais na tela é como se aplica uma ação em massa num
     chamado que a pessoa não vê. Quem faz isso NÃO é um efeito que zera estado:
     é a `key` que a página dá a este componente, derivada da consulta. Trocou a
     consulta, o React desmonta e monta de novo, e o estado nasce limpo sem uma
     linha de código para isso. */

  const todosMarcados = tickets.length > 0 && marcados.size === tickets.length
  const alternarTodos = () =>
    setMarcados(todosMarcados ? new Set() : new Set(tickets.map((t) => t.id)))

  const alturaLinha = densidade === 'compacto' ? 'py-1.5' : 'py-3'
  const mostraSubtitulo = densidade === 'confortavel'

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <SeletorDeDensidade atual={densidade} />
        <p className="hidden text-xs text-[var(--color-ink-3)] lg:block">
          <Tecla>J</Tecla> <Tecla>K</Tecla> anda · <Tecla>X</Tecla> marca ·{' '}
          <Tecla>Enter</Tecla> abre · <Tecla>Esc</Tecla> limpa
        </p>
      </div>

      <div
        ref={corpoRef}
        className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] lg:overflow-x-auto"
      >
        {/* --- Computador: tabela ---

            `table-fixed` com larguras declaradas: sem isso o navegador
            distribui a largura pelo CONTEÚDO, e um título longo empurrava a
            coluna de prazo para fora da tela — justamente a que responde "o que
            vence primeiro". Com largura fixa, o título é quem cede e corta com
            reticências; o prazo cabe sempre. */}
        <table className="hidden w-full table-fixed border-collapse text-sm lg:table">
          <colgroup>
            <col className="w-10" />
            <col className="w-14" />
            <col />
            <col className="w-36" />
            {!ocultas.has('prioridade') && <col className="w-32" />}
            {!ocultas.has('fila') && <col className="w-40" />}
            {!ocultas.has('atendente') && <col className="w-36" />}
            <col className="w-36" />
          </colgroup>
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-2)] text-left">
              <th scope="col" className="w-10 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={todosMarcados}
                  onChange={alternarTodos}
                  aria-label="Marcar todos os chamados desta página"
                  className="size-3.5 accent-[var(--color-brand)]"
                />
              </th>
              {visiveis.map((c) => (
                <Cabecalho key={c.chave} coluna={c} />
              ))}
            </tr>
          </thead>
          <tbody>
            {tickets.map((t, i) => {
              const marcado = marcados.has(t.id)
              return (
                <tr
                  key={t.id}
                  data-indice={i}
                  data-cursor={i === cursor ? '1' : undefined}
                  data-marcado={marcado ? '1' : undefined}
                  data-aberto={aberto === t.id ? '1' : undefined}
                  className={`border-b border-[var(--color-border)] last:border-b-0 ${
                    marcado
                      ? 'bg-[var(--color-brand-soft)]'
                      : aberto === t.id || i === cursor
                        ? 'bg-[var(--color-surface-2)] shadow-[inset_3px_0_0_var(--color-brand)]'
                        : 'hover:bg-[var(--color-surface-2)]'
                  }`}
                >
                  <td className={`px-3 ${alturaLinha}`}>
                    <input
                      type="checkbox"
                      checked={marcado}
                      onChange={() => alternar(t.id)}
                      aria-label={`Marcar o chamado ${t.numero}`}
                      className="size-3.5 accent-[var(--color-brand)]"
                    />
                  </td>
                  <td className={`px-3 font-mono text-xs text-[var(--color-ink-3)] ${alturaLinha}`}>
                    #{t.numero}
                  </td>
                  {/* No compacto a linha é UMA linha: o título corta com
                      reticências em vez de empurrar a altura. É isso que faz
                      caber o triplo de chamados por tela — e o título inteiro
                      continua a um passo, no `title` e na tela do chamado. */}
                  <td className={`px-3 ${alturaLinha}`}>
                    <div className={mostraSubtitulo ? '' : 'truncate'}>
                      <LinkDoChamado
                        id={t.id}
                        titulo={t.titulo}
                        href={comGaveta(t.id)}
                        aoAbrir={() => setCursor(i)}
                        router={router}
                      />
                      {mostraSubtitulo ? (
                        <p className="mt-0.5 text-xs text-[var(--color-ink-3)]">
                          {t.categoria} · aberto {t.abertura}
                        </p>
                      ) : (
                        <span className="ml-2 text-xs text-[var(--color-ink-3)]">{t.categoria}</span>
                      )}
                    </div>
                  </td>
                  {/* Status e atendente são editáveis NA LINHA: são as duas
                      mudanças de um campo só que acontecem o dia inteiro.
                      Qualquer coisa que peça contexto abre a gaveta. */}
                  {/* `overflow-hidden`: a pílula de "Aguardando terceiro" é mais
                      larga que a coluna, e sem isto ela invadia o prazo da
                      linha ao lado. */}
                  <td className={`overflow-hidden px-3 ${alturaLinha}`}>
                    <EdicaoNaLinha
                      ticketId={t.id}
                      campo="status"
                      valor={t.status}
                      opcoes={t.statusPossiveis}
                      rotulo={`Status do chamado ${t.numero}`}
                      podeEditar={permissoes.status && t.statusPossiveis.length > 1}
                    >
                      <StatusBadge status={t.status} />
                    </EdicaoNaLinha>
                  </td>
                  {!ocultas.has('prioridade') && (
                    <td className={`px-3 ${alturaLinha}`}>
                      <PriorityBadge label={t.prioridadeLabel} color={t.prioridadeCor} />
                    </td>
                  )}
                  {!ocultas.has('fila') && (
                    <td
                      className={`whitespace-nowrap px-3 text-[var(--color-ink-2)] ${alturaLinha}`}
                    >
                      {t.fila}
                    </td>
                  )}
                  {!ocultas.has('atendente') && (
                  <td
                    className={`truncate whitespace-nowrap px-3 text-[var(--color-ink-2)] ${alturaLinha}`}
                  >
                    <EdicaoNaLinha
                      ticketId={t.id}
                      campo="atendente"
                      valor={t.atendenteId ?? ''}
                      opcoes={[{ valor: '', rotulo: 'Não atribuído' }, ...atendentesEditaveis]}
                      rotulo={`Atendente do chamado ${t.numero}`}
                      podeEditar={permissoes.atribuir}
                    >
                      <span className="text-sm">{t.atendente ?? 'Não atribuído'}</span>
                    </EdicaoNaLinha>
                  </td>
                  )}
                  {/* O SLA deixou de ser uma coluna e virou a COR e a palavra
                      deste prazo. Uma coluna inteira para repetir "No prazo" em
                      quase toda linha custava 160px que o título não tinha — e
                      quem precisa do estado o lê aqui: "atrasado 1d 10h" diz a
                      mesma coisa, no lugar onde a pessoa já estava olhando.
                      O rótulo completo continua disponível para leitor de tela
                      e no `title`, porque cor sozinha não informa (WCAG 1.4.1). */}
                  <td
                    title={t.slaRotulo}
                    className={`whitespace-nowrap px-3 tabular-nums ${alturaLinha} ${corDoPrazo(t)}`}
                  >
                    {t.prazo}
                    <span className="sr-only"> — {t.slaRotulo}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {/* --- Celular: fichas --- */}
        <ul className="lg:hidden">
          {tickets.map((t, i) => {
            const marcado = marcados.has(t.id)
            return (
              <li
                key={t.id}
                data-indice={i}
                data-marcado={marcado ? '1' : undefined}
                className={`flex gap-3 border-b border-[var(--color-border)] px-3 py-3 last:border-b-0 ${
                  marcado ? 'bg-[var(--color-brand-soft)]' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={marcado}
                  onChange={() => alternar(t.id)}
                  aria-label={`Marcar o chamado ${t.numero}`}
                  className="mt-1 size-4 shrink-0 accent-[var(--color-brand)]"
                />
                <div className="min-w-0 flex-1">
                  {/* A primeira linha é a que decide: número, estado e prazo. */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-[var(--color-ink-3)]">#{t.numero}</span>
                    <StatusBadge status={t.status} />
                    <span className={`ml-auto text-xs tabular-nums ${corDoPrazo(t)}`}>
                      {t.atrasado || t.slaEstado === 'breached' ? `${t.slaRotulo} · ` : ''}
                      {t.prazo}
                    </span>
                  </div>
                  <span className="mt-1 block font-semibold leading-snug text-[var(--color-ink)]">
                    <LinkDoChamado
                      id={t.id}
                      titulo={t.titulo}
                      href={comGaveta(t.id)}
                      aoAbrir={() => setCursor(i)}
                      router={router}
                    />
                  </span>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-ink-2)]">
                    <PriorityBadge label={t.prioridadeLabel} color={t.prioridadeCor} />
                    <span>{t.fila}</span>
                    <span>{t.atendente ?? 'Não atribuído'}</span>
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      {marcados.size > 0 && (
        <BarraDeLote
          ids={[...marcados]}
          atendentes={atendentes}
          filas={filas}
          permissoes={permissoes}
          anteriores={Object.fromEntries(tickets.map((t) => [t.id, t.atendenteId ?? '']))}
          aoLimpar={() => setMarcados(new Set())}
        />
      )}
    </div>
  )
}

/**
 * O título do chamado.
 *
 * O `href` aponta para a PÁGINA INTEIRA de propósito, e o clique comum é
 * interceptado para abrir a gaveta. Com isso as duas coisas valem ao mesmo
 * tempo: clicar fica no contexto da lista, e Ctrl+clique, botão do meio ou
 * "abrir em nova aba" continuam levando à página — que é o que o navegador
 * promete ao mostrar o endereço na barra de status. Um `<button>` aqui
 * quebraria essa promessa, e um link para a própria lista faria "abrir em nova
 * aba" devolver a lista.
 */
function LinkDoChamado({
  id,
  titulo,
  href,
  aoAbrir,
  router,
}: {
  id: string
  titulo: string
  href: string
  aoAbrir: () => void
  router: ReturnType<typeof useRouter>
}) {
  const [pendente, iniciar] = useTransition()
  useProgresso(pendente)
  return (
    <Link
      href={`/tickets/${id}` as Route}
      title={titulo}
      data-testid="abrir-chamado"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
        e.preventDefault()
        aoAbrir()
        iniciar(() => router.push(href as Route, { scroll: false }))
      }}
      className="font-medium text-[var(--color-brand-ink)] hover:underline"
    >
      {titulo}
    </Link>
  )
}

function Tecla({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-[var(--color-border)] border-b-2 bg-[var(--color-surface)] px-1 font-sans text-[0.7rem] text-[var(--color-ink-2)]">
      {children}
    </kbd>
  )
}

/**
 * Cabeçalho que ordena.
 *
 * É `<Link>`, não botão: ordenar muda o endereço, então o "voltar" do navegador
 * desfaz, e a lista ordenada por prazo pode ser copiada e mandada. A seta diz a
 * direção ATUAL; `aria-sort` diz a mesma coisa para quem usa leitor de tela,
 * que de outro modo ouviria só o nome da coluna.
 */
function Cabecalho({ coluna }: { coluna: CabecalhoOrdenavel }) {
  return (
    <th
      scope="col"
      aria-sort={coluna.ativa ? (coluna.asc ? 'ascending' : 'descending') : 'none'}
      className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]"
    >
      {coluna.href === null ? (
        coluna.rotulo
      ) : (
        <Link
        href={coluna.href as Route}
        className={`inline-flex items-center gap-1 hover:text-[var(--color-ink)] ${
          coluna.ativa ? 'text-[var(--color-brand-ink)]' : ''
        }`}
      >
          {coluna.rotulo}
          <span aria-hidden="true" className={coluna.ativa ? '' : 'opacity-0'}>
            {coluna.asc ? '↑' : '↓'}
          </span>
        </Link>
      )}
    </th>
  )
}

function SeletorDeDensidade({ atual }: { atual: 'compacto' | 'confortavel' }) {
  const opcoes = [
    { valor: 'compacto' as const, rotulo: 'Compacto' },
    { valor: 'confortavel' as const, rotulo: 'Confortável' },
  ]
  return (
    <div
      role="group"
      aria-label="Densidade da lista"
      className="hidden overflow-hidden rounded-lg border border-[var(--color-border)] lg:flex"
    >
      {opcoes.map((o) => (
        <button
          key={o.valor}
          type="button"
          aria-pressed={atual === o.valor}
          data-testid={`densidade-${o.valor}`}
          onClick={() => gravarDensidade(o.valor)}
          className={`px-2.5 py-1 text-xs font-medium ${
            atual === o.valor
              ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand-ink)]'
              : 'text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]'
          }`}
        >
          {o.rotulo}
        </button>
      ))}
    </div>
  )
}

/* --- A barra de ações em massa -------------------------------------------- */

/**
 * Ela só existe quando há seleção.
 *
 * Uma barra permanente com os controles desabilitados ocupa espaço o ano
 * inteiro para ser útil em dois minutos por dia — e ainda rouba quatro paradas
 * de tabulação de quem navega por teclado. Aparecendo com a seleção, ela também
 * é a confirmação de que a seleção existe.
 */
function BarraDeLote({
  ids,
  atendentes,
  filas,
  permissoes,
  anteriores,
  aoLimpar,
}: {
  ids: string[]
  atendentes: OpcaoDeLote[]
  filas: OpcaoDeLote[]
  permissoes: PermissoesDaLista
  anteriores: Record<string, string>
  aoLimpar: () => void
}) {
  const nada = !permissoes.atribuir && !permissoes.status && !permissoes.transferir

  return (
    <div
      role="region"
      aria-label="Ações em massa"
      data-testid="barra-de-lote"
      className="sticky bottom-3 z-10 mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-[var(--color-ink)] px-3 py-2.5 text-sm text-[var(--color-surface)] shadow-lg"
    >
      <span className="font-semibold" data-testid="contagem-marcados">
        {ids.length} selecionado{ids.length > 1 ? 's' : ''}
      </span>

      {permissoes.atribuir && (
        <AcaoEmMassa
          acao="atribuir"
          rotulo="Atribuir a…"
          ids={ids}
          opcoes={[{ valor: '', rotulo: 'Sem atendente' }, ...atendentes]}
          anteriores={anteriores}
          aoConcluir={aoLimpar}
        />
      )}
      {permissoes.status && (
        <AcaoEmMassa
          acao="status"
          rotulo="Mudar status…"
          ids={ids}
          opcoes={STATUS_EM_LOTE}
          aoConcluir={aoLimpar}
        />
      )}
      {permissoes.transferir && (
        <AcaoEmMassa
          acao="fila"
          rotulo="Mover de fila…"
          ids={ids}
          opcoes={filas}
          pedeMotivo
          aoConcluir={aoLimpar}
        />
      )}

      {nada && (
        <span className="text-xs opacity-80">
          Seu perfil não tem ação em lote disponível para chamados.
        </span>
      )}

      <button
        type="button"
        onClick={aoLimpar}
        className="ml-auto text-xs opacity-75 underline-offset-2 hover:underline"
      >
        Limpar seleção (Esc)
      </button>
    </div>
  )
}

/* Os estados para os quais faz sentido empurrar um lote. "Resolvido" e
   "Fechado" ficam de fora de propósito: fechar em massa sem olhar o chamado é
   como se perde o histórico de um atendimento, e a máquina de estados do banco
   recusaria boa parte deles de qualquer forma. */
const STATUS_EM_LOTE: OpcaoDeLote[] = [
  { valor: 'triage', rotulo: 'Em triagem' },
  { valor: 'assigned', rotulo: 'Atribuído' },
  { valor: 'in_progress', rotulo: 'Em andamento' },
  { valor: 'waiting_requester', rotulo: 'Aguardando solicitante' },
  { valor: 'waiting_third_party', rotulo: 'Aguardando terceiro' },
]

function AcaoEmMassa({
  acao,
  rotulo,
  ids,
  opcoes,
  pedeMotivo = false,
  anteriores,
  aoConcluir,
}: {
  acao: 'atribuir' | 'status' | 'fila'
  rotulo: string
  ids: string[]
  opcoes: OpcaoDeLote[]
  pedeMotivo?: boolean
  /** Atendente de cada chamado ANTES do lote — é o que permite desfazer. */
  anteriores?: Record<string, string>
  aoConcluir?: () => void
}) {
  const [enviando, iniciar] = useTransition()
  const motivoRef = useRef<HTMLInputElement>(null)
  const [valor, setValor] = useState('__')

  /*
   * A ação é chamada DIRETAMENTE, não por `useActionState` com um efeito
   * lendo o resultado — e a diferença não é de estilo.
   *
   * O lote muda os chamados que estão marcados, e marcar quase sempre vem de
   * um filtro: "sem atendente", "em aberto". Atribuir os dois últimos sem
   * atendente esvazia a lista, a tela troca para o estado vazio e ESTE
   * componente deixa de existir — antes de qualquer efeito dele rodar. Era
   * exatamente aí que a confirmação sumia: no caso em que o lote funcionou
   * inteiro.
   *
   * Chamando a ação aqui e avisando logo depois, a mensagem é publicada numa
   * loja de módulo que não depende de componente nenhum continuar montado.
   */
  function aplicar(escolha: string) {
    const motivo = motivoRef.current?.value.trim() ?? ''
    /* Transferir sem motivo é recusado pelo servidor; pedir aqui evita a ida e
       volta e deixa o cursor onde falta escrever. */
    if (pedeMotivo && !motivo) {
      motivoRef.current?.focus()
      setValor('__')
      return
    }

    const dados = new FormData()
    for (const id of ids) dados.append('id', id)
    dados.set('acao', acao)
    dados.set('valor', escolha)
    if (motivo) dados.set('motivo', motivo)

    iniciar(async () => {
      const r = await acaoEmLote({}, dados)
      if (r.error) {
        avisar({ tipo: 'erro', texto: r.error })
        setValor('__')
        return
      }
      if (!r.success) return

      /*
       * Desfazer só para atribuição, e só quando sabemos de onde cada chamado
       * veio. Voltar um atendente é sempre possível; voltar um status depende
       * da máquina de estados do banco, e um desfazer que pode ser recusado é
       * pior que nenhum.
       */
      const podeDesfazer = acao === 'atribuir' && anteriores !== undefined
      avisar({
        tipo: 'ok',
        texto: r.success,
        desfazer: podeDesfazer
          ? {
              rotulo: 'desfazer',
              aoClicar: () => {
                /* Agrupa por valor anterior: um lote por destino, em vez de
                   uma escrita por chamado. */
                const porValor = new Map<string, string[]>()
                for (const id of ids) {
                  const antes = anteriores?.[id] ?? ''
                  porValor.set(antes, [...(porValor.get(antes) ?? []), id])
                }
                for (const [antes, grupo] of porValor) {
                  const volta = new FormData()
                  for (const id of grupo) volta.append('id', id)
                  volta.set('acao', 'atribuir')
                  volta.set('valor', antes)
                  void acaoEmLote({}, volta).then((v) => {
                    if (v.error) avisar({ tipo: 'erro', texto: v.error })
                  })
                }
              },
            }
          : undefined,
      })
      aoConcluir?.()
    })
  }

  return (
    <div className="flex items-center gap-1.5">
      {pedeMotivo && (
        <input
          ref={motivoRef}
          name="motivo"
          placeholder="motivo da transferência"
          aria-label="Motivo da transferência"
          className="w-40 rounded-md border border-white/20 bg-white/10 px-2 py-1 text-xs text-[var(--color-surface)] placeholder:text-white/50"
        />
      )}

      <select
        value={valor}
        disabled={enviando}
        aria-label={rotulo}
        data-testid={`lote-${acao}`}
        onChange={(e) => {
          setValor(e.target.value)
          if (e.target.value !== '__') aplicar(e.target.value)
        }}
        className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-xs text-[var(--color-surface)]"
      >
        <option value="__">{enviando ? 'aplicando…' : rotulo}</option>
        {opcoes.map((o) => (
          <option key={o.valor || 'vazio'} value={o.valor} className="text-[var(--color-ink)]">
            {o.rotulo}
          </option>
        ))}
      </select>
    </div>
  )
}
