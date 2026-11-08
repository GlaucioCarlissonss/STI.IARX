'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { Route } from 'next'
import {
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { SlaState, TicketStatus } from '@/lib/types'
import { PriorityBadge, StatusBadge } from './ui'
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
}: {
  tickets: TicketDaLista[]
  cabecalhos: CabecalhoOrdenavel[]
  atendentes: OpcaoDeLote[]
  filas: OpcaoDeLote[]
  permissoes: PermissoesDaLista
}) {
  const router = useRouter()
  const densidade = useSyncExternalStore(assinarDensidade, lerDensidade, densidadeDoServidor)
  const [cursor, setCursor] = useState(0)
  const [marcados, setMarcados] = useState<ReadonlySet<string>>(new Set())
  const corpoRef = useRef<HTMLDivElement>(null)

  const alternar = useCallback((id: string) => {
    setMarcados((antes) => {
      const novo = new Set(antes)
      if (novo.has(id)) novo.delete(id)
      else novo.add(id)
      return novo
    })
  }, [])

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

      if (tecla === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor((c) => Math.min(c + 1, tickets.length - 1))
      } else if (tecla === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor((c) => Math.max(c - 1, 0))
      } else if (tecla === 'x') {
        e.preventDefault()
        const alvo = tickets[cursor]
        if (alvo) alternar(alvo.id)
      } else if (e.key === 'Enter') {
        const alvo = tickets[cursor]
        if (alvo) {
          e.preventDefault()
          router.push(`/tickets/${alvo.id}` as Route)
        }
      } else if (e.key === 'Escape' && marcados.size > 0) {
        e.preventDefault()
        setMarcados(new Set())
      }
    }

    window.addEventListener('keydown', aoTeclar)
    return () => window.removeEventListener('keydown', aoTeclar)
  }, [tickets, cursor, marcados.size, alternar, router])

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
            <col className="w-32" />
            <col className="w-40" />
            <col className="w-36" />
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
              {cabecalhos.map((c) => (
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
                  className={`border-b border-[var(--color-border)] last:border-b-0 ${
                    marcado
                      ? 'bg-[var(--color-brand-soft)]'
                      : i === cursor
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
                      <Link
                        href={`/tickets/${t.id}` as Route}
                        title={t.titulo}
                        className="font-medium text-[var(--color-brand-ink)] hover:underline"
                      >
                        {t.titulo}
                      </Link>
                      {mostraSubtitulo ? (
                        <p className="mt-0.5 text-xs text-[var(--color-ink-3)]">
                          {t.categoria} · aberto {t.abertura}
                        </p>
                      ) : (
                        <span className="ml-2 text-xs text-[var(--color-ink-3)]">{t.categoria}</span>
                      )}
                    </div>
                  </td>
                  <td className={`px-3 ${alturaLinha}`}>
                    <StatusBadge status={t.status} />
                  </td>
                  <td className={`px-3 ${alturaLinha}`}>
                    <PriorityBadge label={t.prioridadeLabel} color={t.prioridadeCor} />
                  </td>
                  <td
                    className={`whitespace-nowrap px-3 text-[var(--color-ink-2)] ${alturaLinha}`}
                  >
                    {t.fila}
                  </td>
                  <td
                    className={`truncate whitespace-nowrap px-3 text-[var(--color-ink-2)] ${alturaLinha}`}
                  >
                    {t.atendente ?? 'Não atribuído'}
                  </td>
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
                  <Link
                    href={`/tickets/${t.id}` as Route}
                    className="mt-1 block font-semibold leading-snug text-[var(--color-ink)]"
                  >
                    {t.titulo}
                  </Link>
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
          aoLimpar={() => setMarcados(new Set())}
        />
      )}
    </div>
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
  aoLimpar,
}: {
  ids: string[]
  atendentes: OpcaoDeLote[]
  filas: OpcaoDeLote[]
  permissoes: PermissoesDaLista
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
        />
      )}
      {permissoes.status && (
        <AcaoEmMassa acao="status" rotulo="Mudar status…" ids={ids} opcoes={STATUS_EM_LOTE} />
      )}
      {permissoes.transferir && (
        <AcaoEmMassa acao="fila" rotulo="Mover de fila…" ids={ids} opcoes={filas} pedeMotivo />
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
}: {
  acao: 'atribuir' | 'status' | 'fila'
  rotulo: string
  ids: string[]
  opcoes: OpcaoDeLote[]
  pedeMotivo?: boolean
}) {
  const [estado, enviar, enviando] = useActionState(acaoEmLote, {})
  const formRef = useRef<HTMLFormElement>(null)
  const motivoRef = useRef<HTMLInputElement>(null)
  const [valor, setValor] = useState('')

  return (
    <form ref={formRef} action={enviar} className="flex items-center gap-1.5">
      {ids.map((id) => (
        <input key={id} type="hidden" name="id" value={id} />
      ))}
      <input type="hidden" name="acao" value={acao} />

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
        name="valor"
        value={valor}
        disabled={enviando}
        aria-label={rotulo}
        data-testid={`lote-${acao}`}
        onChange={(e) => {
          setValor(e.target.value)
          if (e.target.value === '__') return
          /* Transferir sem motivo é recusado pelo servidor; pedir aqui evita a
             ida e volta e deixa o cursor onde falta escrever. */
          if (pedeMotivo && !motivoRef.current?.value.trim()) {
            motivoRef.current?.focus()
            return
          }
          formRef.current?.requestSubmit()
        }}
        className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-xs text-[var(--color-surface)]"
      >
        <option value="__">{rotulo}</option>
        {opcoes.map((o) => (
          <option key={o.valor || 'vazio'} value={o.valor} className="text-[var(--color-ink)]">
            {o.rotulo}
          </option>
        ))}
      </select>

      {(estado.error || estado.success) && (
        <span role="status" className="max-w-56 text-xs opacity-90">
          {estado.error ?? estado.success}
        </span>
      )}
    </form>
  )
}
