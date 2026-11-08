'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { comParametros } from '@/lib/data/endereco'

/**
 * Os filtros da lista, sem botão "Filtrar".
 *
 * ## Por que o botão saiu
 *
 * Porque ele era uma pergunta a mais entre a pessoa e a resposta. O padrão
 * antigo — quatro campos num cartão e um botão no fim — tinha três custos que
 * não aparecem em nenhum relatório: escolher o status e não ver nada acontecer
 * parece defeito; voltar atrás exige desfazer campo a campo e submeter de novo;
 * e o estado do formulário não é endereço, então "os críticos sem atendente"
 * não vira link.
 *
 * Aqui cada controle navega na hora, e o que muda é a URL. O "voltar" do
 * navegador desfaz o último filtro — que é o que todo mundo tenta antes de
 * procurar um botão de limpar.
 *
 * ## O campo de texto é a exceção, e tem atraso
 *
 * Digitar são várias mudanças por segundo, e navegar a cada tecla seria uma
 * consulta por letra. Por isso só ele tem atraso (350ms) e usa `replace` em vez
 * de `push`: sem isso, escrever "servidor" empilharia oito entradas no
 * histórico e o "voltar" teria de ser apertado oito vezes para sair da busca.
 */

export interface OpcaoDeFiltro {
  valor: string
  rotulo: string
}

export interface FiltroDeLista {
  /** O nome do parâmetro na URL. */
  nome: string
  rotulo: string
  valor: string
  /** A primeira opção é o estado "sem filtro" e não acende o chip. */
  opcoes: OpcaoDeFiltro[]
}

export function FiltrosDeLista({
  base,
  params,
  filtros,
  nomeDaBusca = 'busca',
  placeholder = 'Filtrar…',
}: {
  base: string
  params: Record<string, string | undefined>
  filtros: FiltroDeLista[]
  nomeDaBusca?: string
  placeholder?: string
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [texto, setTexto] = useState(params[nomeDaBusca] ?? '')
  const digitado = useRef(false)

  /* Enquanto a pessoa não digitou nada nesta visita, o campo segue o endereço:
     é o que faz o texto aparecer ao abrir um link filtrado e sumir ao limpar o
     filtro por outro caminho. Depois do primeiro toque, quem manda é o campo —
     sem essa trava, a resposta da navegação sobrescreveria o que está sendo
     escrito naquele instante. */
  useEffect(() => {
    if (!digitado.current) setTexto(params[nomeDaBusca] ?? '')
  }, [params, nomeDaBusca])

  useEffect(() => {
    if (!digitado.current) return
    const atual = params[nomeDaBusca] ?? ''
    if (texto === atual) return
    const id = setTimeout(() => {
      iniciar(() => router.replace(comParametros(base, params, { [nomeDaBusca]: texto || null })))
    }, 350)
    return () => clearTimeout(id)
  }, [texto, params, base, nomeDaBusca, router])

  const ir = (nome: string, valor: string) =>
    iniciar(() => router.push(comParametros(base, params, { [nome]: valor || null })))

  return (
    <div
      data-testid="filtros"
      data-pendente={pendente ? '1' : undefined}
      className="mb-3 flex flex-wrap items-center gap-2"
    >
      <input
        type="search"
        value={texto}
        onChange={(e) => {
          digitado.current = true
          setTexto(e.target.value)
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        data-testid="filtro-busca"
        className="min-w-0 flex-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-3)] sm:max-w-80"
      />

      {filtros.map((f) => {
        const limpo = f.opcoes[0]?.valor ?? ''
        const ativo = f.valor !== limpo
        const atual = f.opcoes.find((o) => o.valor === f.valor)
        return (
          <span
            key={f.nome}
            data-testid={`chip-${f.nome}`}
            data-ativo={ativo ? '1' : undefined}
            className={`relative inline-flex items-center rounded-full border px-3 py-1.5 text-sm ${
              ativo
                ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)] font-semibold text-[var(--color-brand-ink)]'
                : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-ink-2)]'
            }`}
          >
            {f.rotulo}: {atual?.rotulo ?? f.opcoes[0]?.rotulo}
            <span aria-hidden="true" className="ml-1.5 text-xs opacity-60">
              ⌄
            </span>
            {/* O `<select>` nativo por cima do chip: no celular isso abre o
                seletor do próprio aparelho, que é maior, rola com o polegar e
                já é familiar. Um menu desenhado por nós seria pior em todos
                esses pontos e ainda precisaria de teclado próprio. */}
            <select
              value={f.valor}
              aria-label={f.rotulo}
              onChange={(e) => ir(f.nome, e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              {f.opcoes.map((o) => (
                <option key={o.valor || 'vazio'} value={o.valor}>
                  {o.rotulo}
                </option>
              ))}
            </select>
          </span>
        )
      })}
    </div>
  )
}
