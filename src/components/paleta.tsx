'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Route } from 'next'
import type { ResultadoDeBusca } from '@/app/api/busca/route'

export interface TelaDaPaleta {
  label: string
  href: string
  grupo: string | null
}

/**
 * A paleta de comandos — ⌘K de qualquer tela.
 *
 * ## O problema que ela resolve
 *
 * São 45 telas em oito gavetas. Para chegar a "Fluxo de caixa" é preciso saber
 * que ela mora em Financeiro, abrir a gaveta e procurar na lista. Quem usa todo
 * dia decora; quem usa uma vez por mês não. E não havia busca nenhuma fora de
 * cada tela: achar o chamado #1042 exigia ir a Tickets e filtrar.
 *
 * ## Uma caixa só, com três coisas dentro
 *
 * **Telas** (as mesmas do menu, já filtradas por permissão), **ações** (abrir
 * chamado, lançar despesa) e **registros** (ticket, ativo, cliente). Ter os três
 * no mesmo lugar é o que faz a paleta valer o atalho: se fosse só navegação, a
 * barra lateral já bastava.
 *
 * ## Por que a caixa do cabeçalho existe
 *
 * Atalho que ninguém descobre não é atalho, é segredo. A caixa é o cartaz que
 * ensina `⌘K` — e funciona no clique para quem nunca vai usar o teclado.
 *
 * ## Decisões de teclado
 *
 * `⌘K` no Mac e `Ctrl+K` no resto, porque é o que o dedo já sabe de outras
 * ferramentas. `Esc` fecha. `↑ ↓` andam, `Enter` abre. A navegação é cíclica:
 * descer no último volta ao primeiro, que é o esperado numa lista curta e evita
 * a sensação de ter travado.
 */
export function PaletaDeComandos({ telas }: { telas: TelaDaPaleta[] }) {
  const router = useRouter()
  const [aberta, setAberta] = useState(false)
  const [termo, setTermo] = useState('')
  const [indice, setIndice] = useState(0)
  const [registros, setRegistros] = useState<ResultadoDeBusca[]>([])
  const [buscando, setBuscando] = useState(false)
  const campoRef = useRef<HTMLInputElement>(null)
  const listaRef = useRef<HTMLDivElement>(null)

  /* --- abrir e fechar ---------------------------------------------------- */
  useEffect(() => {
    function aoTeclar(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setAberta((v) => !v)
      }
    }
    window.addEventListener('keydown', aoTeclar)
    return () => window.removeEventListener('keydown', aoTeclar)
  }, [])

  useEffect(() => {
    if (!aberta) return
    setTermo('')
    setIndice(0)
    setRegistros([])
    /* O foco precisa do próximo quadro: o campo ainda não existe no DOM quando
       o estado muda. */
    const t = setTimeout(() => campoRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [aberta])

  /* --- busca de registros, com atraso e cancelamento --------------------- */
  useEffect(() => {
    const q = termo.trim()
    /* Mesmo critério da rota: um dígito é o número de um chamado, uma letra é
       ruído. Repetir a regra aqui evita uma ida ao servidor que já sabemos que
       volta vazia. */
    const minimo = /^\d+$/.test(q) ? 1 : 2
    if (!aberta || q.length < minimo) {
      setRegistros([])
      setBuscando(false)
      return
    }
    const controle = new AbortController()
    setBuscando(true)
    /*
     * 180ms: curto o bastante para parecer instantâneo, longo o bastante para
     * não disparar uma busca por letra digitada. O `AbortController` é o que
     * impede a resposta da terceira letra de chegar depois da quinta e
     * sobrescrever o resultado certo pelo errado — defeito que só aparece em
     * rede ruim, que é justamente onde dói.
     */
    const t = setTimeout(() => {
      fetch(`/api/busca?q=${encodeURIComponent(q)}`, { signal: controle.signal })
        .then((r) => (r.ok ? r.json() : { resultados: [] }))
        .then((d: { resultados: ResultadoDeBusca[] }) => setRegistros(d.resultados ?? []))
        .catch(() => {
          /* Abortada ou offline: a paleta continua servindo telas e ações. */
        })
        .finally(() => setBuscando(false))
    }, 180)

    return () => {
      controle.abort()
      clearTimeout(t)
    }
  }, [termo, aberta])

  /* --- o que aparece ----------------------------------------------------- */
  const normal = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()

  const itens = useMemo(() => {
    const q = normal(termo.trim())
    const casa = (s: string) => !q || normal(s).includes(q)

    const telasFiltradas = telas
      .filter((t) => casa(t.label) || casa(t.grupo ?? ''))
      .slice(0, 8)
      .map((t) => ({
        chave: `tela:${t.href}`,
        secao: 'Telas',
        titulo: t.label,
        detalhe: t.grupo ?? '',
        href: t.href,
        icone: '▸',
      }))

    const acoes = ACOES.filter((a) => telas.some((t) => t.href === a.telaQueAutoriza))
      .filter((a) => casa(a.titulo))
      .map((a) => ({
        chave: `acao:${a.href}`,
        secao: 'Ações',
        titulo: a.titulo,
        detalhe: a.detalhe,
        href: a.href,
        icone: '＋',
      }))

    const regs = registros.map((r) => ({
      chave: `reg:${r.href}`,
      secao: 'Registros',
      titulo: r.titulo,
      detalhe: r.detalhe,
      href: r.href,
      icone: r.tipo === 'ticket' ? '◆' : r.tipo === 'ativo' ? '▣' : '○',
    }))

    return [...telasFiltradas, ...acoes, ...regs]
  }, [telas, termo, registros])

  useEffect(() => {
    setIndice(0)
  }, [termo])

  const ir = useCallback(
    (href: string) => {
      setAberta(false)
      router.push(href as Route)
    },
    [router],
  )

  function aoTeclarNaPaleta(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      setAberta(false)
      return
    }
    if (!itens.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndice((i) => (i + 1) % itens.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndice((i) => (i - 1 + itens.length) % itens.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const alvo = itens[indice]
      if (alvo) ir(alvo.href)
    }
  }

  /* Mantém o item escolhido à vista quando a seta passa do fim da janela. */
  useEffect(() => {
    listaRef.current
      ?.querySelector<HTMLElement>('[data-escolhido="1"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [indice])

  return (
    <>
      <button
        type="button"
        onClick={() => setAberta(true)}
        data-testid="abrir-paleta"
        className="hidden items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-surface-3)] md:flex"
      >
        <span aria-hidden="true">🔍</span>
        <span>Buscar tela, chamado, ativo…</span>
        <kbd className="ml-6 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 font-mono text-[0.68rem]">
          ⌘K
        </kbd>
      </button>

      {aberta && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(16,22,34,.45)] p-4 pt-[12vh]"
          onMouseDown={(e) => {
            /* Fecha só no clique no VÉU. Sem a conferência, arrastar para
               selecionar texto dentro da paleta e soltar fora a fechava. */
            if (e.target === e.currentTarget) setAberta(false)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Buscar e navegar"
            data-testid="paleta"
            onKeyDown={aoTeclarNaPaleta}
            className="w-full max-w-xl overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
          >
            <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
              <span aria-hidden="true">🔍</span>
              <input
                ref={campoRef}
                value={termo}
                onChange={(e) => setTermo(e.target.value)}
                placeholder="Buscar tela, chamado, ativo, cliente…"
                aria-label="Buscar"
                className="flex-1 bg-transparent text-base outline-none placeholder:text-[var(--color-ink-3)]"
              />
              {buscando && <span className="text-xs text-[var(--color-ink-3)]">buscando…</span>}
              <kbd className="rounded border border-[var(--color-border)] px-1 font-mono text-[0.68rem] text-[var(--color-ink-3)]">
                Esc
              </kbd>
            </div>

            <div ref={listaRef} className="max-h-[52vh] overflow-y-auto py-1">
              {itens.length === 0 && (
                <p className="px-4 py-6 text-center text-sm text-[var(--color-ink-3)]">
                  {termo.trim().length < (/^\d+$/.test(termo.trim()) ? 1 : 2)
                    ? 'Digite para buscar telas, chamados, ativos e clientes.'
                    : 'Nada encontrado.'}
                </p>
              )}

              {itens.map((item, i) => {
                const primeiroDaSecao = i === 0 || itens[i - 1]!.secao !== item.secao
                return (
                  <div key={item.chave}>
                    {primeiroDaSecao && (
                      <p className="px-4 pb-1 pt-2 text-[0.62rem] font-bold uppercase tracking-wider text-[var(--color-ink-3)]">
                        {item.secao}
                      </p>
                    )}
                    <button
                      type="button"
                      data-escolhido={i === indice ? '1' : '0'}
                      onMouseEnter={() => setIndice(i)}
                      onClick={() => ir(item.href)}
                      className={`flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm ${
                        i === indice
                          ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)]'
                          : 'text-[var(--color-ink-2)]'
                      }`}
                    >
                      <span aria-hidden="true" className="text-xs opacity-70">
                        {item.icone}
                      </span>
                      <span className="truncate">{item.titulo}</span>
                      {item.detalhe && (
                        <span className="ml-auto shrink-0 text-xs text-[var(--color-ink-3)]">
                          {item.detalhe}
                        </span>
                      )}
                    </button>
                  </div>
                )
              })}
            </div>

            <div className="flex gap-3 border-t border-[var(--color-border)] px-4 py-2 text-[0.68rem] text-[var(--color-ink-3)]">
              <span>↑ ↓ anda</span>
              <span>Enter abre</span>
              <span>Esc fecha</span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/**
 * As ações.
 *
 * Cada uma declara a TELA que a autoriza, e só aparece se essa tela estiver na
 * lista que o servidor mandou — que já vem filtrada por permissão. É o jeito de
 * a paleta não oferecer "lançar despesa" para quem não alcança o financeiro, sem
 * repetir aqui a regra de permissão que já existe em `navigation.ts`.
 */
const ACOES: { titulo: string; detalhe: string; href: string; telaQueAutoriza: string }[] = [
  {
    titulo: 'Abrir chamado',
    detalhe: 'Atendimento',
    href: '/tickets/novo',
    telaQueAutoriza: '/tickets/novo',
  },
  {
    titulo: 'Lançar despesa',
    detalhe: 'Financeiro',
    href: '/financeiro/titulos-a-pagar',
    telaQueAutoriza: '/financeiro/titulos-a-pagar',
  },
  {
    titulo: 'Cadastrar ativo',
    detalhe: 'Inventário',
    href: '/inventario',
    telaQueAutoriza: '/inventario',
  },
  {
    titulo: 'Registrar queda de link',
    detalhe: 'Conectividade',
    href: '/conectividade/links',
    telaQueAutoriza: '/conectividade/links',
  },
]
