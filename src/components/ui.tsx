import Link from 'next/link'
import {
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react'
import { enderecoDaPagina, totalDePaginas } from '@/lib/data/paginacao'
import type { SlaState, TicketStatus } from '@/lib/types'
import { slaStateLabel, ticketStatusLabel, ticketStatusTone } from '@/lib/i18n'

/* ==========================================================================
   Primitivos de UI compartilhados pelas telas administrativas.
   ========================================================================== */

type Tone = 'ok' | 'warn' | 'crit' | 'breach' | 'neutral' | 'info'

const toneClasses: Record<Tone, string> = {
  ok: 'bg-[var(--color-ok-soft)] text-[var(--color-ok-ink)]',
  warn: 'bg-[var(--color-warn-soft)] text-[var(--color-warn-ink)]',
  crit: 'bg-[var(--color-crit-soft)] text-[var(--color-crit-ink)]',
  breach: 'bg-[var(--color-breach-soft)] text-[var(--color-breach-ink)]',
  neutral: 'bg-[var(--color-neutral-soft)] text-[var(--color-neutral-ink)]',
  info: 'bg-[var(--color-brand-soft)] text-[var(--color-brand-ink)]',
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      /* `whitespace-nowrap`: "Aguardando terceiro" e "SLA estourado" quebravam
         em duas linhas dentro da coluna e empurravam a altura da linha inteira
         — numa lista compacta isso custa duas linhas de dado por chamado. */
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${toneClasses[tone]}`}
    >
      {children}
    </span>
  )
}

export function StatusBadge({ status }: { status: TicketStatus }) {
  const tone = ticketStatusTone[status]
  const map: Record<typeof tone, Tone> = { neutral: 'neutral', info: 'info', warn: 'warn', good: 'ok' }
  return <Badge tone={map[tone]}>{ticketStatusLabel[status]}</Badge>
}

const slaTone: Record<SlaState, Tone> = {
  no_sla: 'neutral',
  ok: 'ok',
  warning: 'warn',
  critical: 'crit',
  breached: 'breach',
  met: 'ok',
}

/**
 * Semáforo de SLA. O texto acompanha a cor de propósito: cor sozinha não
 * transmite informação para quem tem daltonismo (WCAG 1.4.1).
 */
export function SlaBadge({ state }: { state: SlaState | null }) {
  const value = state ?? 'no_sla'
  return (
    <Badge tone={slaTone[value]}>
      <span aria-hidden="true">●</span>
      {slaStateLabel[value]}
    </Badge>
  )
}

export function PriorityBadge({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-sm font-semibold"
      style={{ color }}
    >
      <span
        aria-hidden="true"
        className="inline-block size-2.5 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  )
}

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] ${className}`}
    >
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-5 py-3.5">
          {title && <h2 className="text-sm font-semibold text-[var(--color-ink)]">{title}</h2>}
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  )
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: ReactNode
  hint?: string
  tone?: Tone
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)]">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
        {label}
      </p>
      <p
        className={`fonte-display mt-1.5 text-3xl font-bold tabular-nums ${toneClasses[tone].split(' ')[1]}`}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-[var(--color-ink-3)]">{hint}</p>}
    </div>
  )
}

/**
 * A faixa de indicadores no alto da tela.
 *
 * ## Por que ela virou componente
 *
 * Porque havia **cinco grades diferentes** para a mesma coisa —
 * `sm:2 xl:4` em dezesseis telas, `xl:3` em três, mais `lg:2`, `sm:3` e
 * `xl:5` avulsos. Nenhuma dessas variações foi decidida: é o que acontece
 * quando cada tela escreve a própria classe. O resultado é que a mesma faixa
 * quebra em pontos diferentes conforme a tela, e quem usa percebe sem saber
 * dizer o quê.
 *
 * Agora a quantidade de colunas sai do NÚMERO de indicadores, e a regra de
 * quebra é uma só. No celular, todas viram uma coluna.
 *
 * ## As três faixas que continuam escrevendo a própria classe
 *
 * Não por esquecimento:
 *
 *  - A de `/painel` tem oito indicadores numa faixa só, metade deles atrás de
 *    permissão. Pela regra daqui, oito viram três por linha — e ali eles são
 *    quatro de propósito, porque a faixa é a primeira coisa que a tela mostra.
 *  - A de `/mapas` usa `mb-3` em vez de `mb-6`: a faixa encosta no mapa logo
 *    abaixo, e o respiro maior separaria os dois como se não falassem do mesmo
 *    recorte.
 *  - A de `/inventario/agentes/[id]` desenha uma faixa por DISCO, dentro de um
 *    cartão. A quantidade varia com a máquina, e a margem é a do cartão.
 *
 * Ou seja: a faixa padronizou dezesseis telas e as exceções têm motivo escrito.
 * É a diferença entre uma regra e uma uniformização.
 */
export function FaixaDeIndicadores({ children }: { children: ReactNode }) {
  const quantos = Children.count(children)
  /* Classes escritas por extenso, não montadas por interpolação: o Tailwind
     varre o código em busca de nomes literais, e `xl:grid-cols-${n}` não
     existiria no CSS final. */
  const colunas =
    quantos <= 2
      ? 'sm:grid-cols-2'
      : quantos === 3
        ? 'sm:grid-cols-2 xl:grid-cols-3'
        : quantos === 5
          ? 'sm:grid-cols-2 xl:grid-cols-5'
          : quantos >= 6
            ? /* Seis em uma linha só cabe em tela muito larga: a 1440px um
                 valor em reais encosta na borda do bloco. Até lá, três por
                 linha. */
              'sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6'
            : 'sm:grid-cols-2 xl:grid-cols-4'

  return <div className={`mb-6 grid gap-3 ${colunas}`}>{children}</div>
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-ink)]">{title}</h1>
        {description && <p className="mt-1 text-sm text-[var(--color-ink-2)]">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  /** O caminho de saída. Tela vazia sem saída é um beco. */
  action?: ReactNode
}) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center sm:p-10">
      <p className="font-semibold text-[var(--color-ink)]">{title}</p>
      {description && <p className="mt-1 text-sm text-[var(--color-ink-2)]">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}

/* --- Paginação ----------------------------------------------------------- */

/**
 * Rodapé de página: quantas linhas, de quantas, e como ir para as outras.
 *
 * ## "51–100 de 412" antes dos botões
 *
 * O número total é a parte que importa, e é justamente a que não existia: a
 * tela truncava em 200 sem dizer nada. Com o total à vista, quem olha sabe o
 * tamanho do acervo mesmo sem percorrer — e sabe que existe mais.
 *
 * ## `<Link>` e não botão
 *
 * Paginação é navegação: o endereço muda, o botão "voltar" do navegador
 * funciona, e a página 3 de uma busca filtrada pode ser copiada e mandada para
 * outra pessoa. Com `<button>` e estado em memória nada disso valeria, e seria
 * mais código.
 *
 * ## `aria-disabled` em vez de sumir
 *
 * Na primeira página, "Anterior" fica visível e inerte. Remover o botão faria a
 * barra inteira pular de posição a cada troca de página, e quem navega por
 * teclado perderia a referência de onde estava a tabulação.
 */
export function Pager({
  pagina,
  total,
  tamanho,
  base,
  params,
}: {
  pagina: number
  total: number
  tamanho: number
  base: string
  params: Record<string, string | undefined>
}) {
  const paginas = totalDePaginas(total, tamanho)
  if (total === 0) return null

  const primeiro = (pagina - 1) * tamanho + 1
  const ultimo = Math.min(pagina * tamanho, total)
  const temAnterior = pagina > 1
  const temProxima = pagina < paginas

  const estilo = (ativo: boolean) =>
    `rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium ${
      ativo
        ? 'text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]'
        : 'cursor-not-allowed text-[var(--color-ink-3)] opacity-60'
    }`

  return (
    <nav
      aria-label="Paginação"
      className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm"
    >
      <p className="text-[var(--color-ink-2)]">
        {total > 0 ? (
          <>
            <span className="font-medium text-[var(--color-ink)] tabular-nums">
              {primeiro}–{ultimo}
            </span>{' '}
            de <span className="tabular-nums">{total}</span>
          </>
        ) : (
          'Nenhum registro'
        )}
      </p>

      <div className="flex items-center gap-2">
        {temAnterior ? (
          <Link href={enderecoDaPagina(base, params, pagina - 1)} className={estilo(true)}>
            Anterior
          </Link>
        ) : (
          <span aria-disabled="true" className={estilo(false)}>
            Anterior
          </span>
        )}
        <span className="text-[var(--color-ink-3)] tabular-nums">
          {pagina} / {paginas}
        </span>
        {temProxima ? (
          <Link href={enderecoDaPagina(base, params, pagina + 1)} className={estilo(true)}>
            Próxima
          </Link>
        ) : (
          <span aria-disabled="true" className={estilo(false)}>
            Próxima
          </span>
        )}
      </div>
    </nav>
  )
}

/* --- Carregamento -------------------------------------------------------- */

/**
 * Bloco cinza que ocupa o lugar do conteúdo enquanto ele vem.
 *
 * `aria-hidden`: a forma do esqueleto não é informação, e um leitor de tela
 * anunciando oito retângulos vazios atrapalha mais do que o silêncio. Quem
 * anuncia é o `PageSkeleton`, uma vez só.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-lg bg-[var(--color-surface-3)] ${className}`}
    />
  )
}

/**
 * O esqueleto padrão de uma tela da aplicação.
 *
 * **Por que um só, e não um por tela.** Um esqueleto fiel a cada página seriam
 * 25 arquivos para manter em dia com 25 layouts — e esqueleto desatualizado é
 * pior que esqueleto genérico, porque promete uma forma que não chega. Este
 * reproduz o que praticamente toda tela tem: título, uma faixa de indicadores e
 * uma lista. A função dele é dizer "está vindo, e vem aqui", não enganar.
 *
 * `role="status"` com `aria-live="polite"` anuncia uma vez, sem interromper o
 * que a pessoa estiver ouvindo.
 */
export function PageSkeleton() {
  return (
    <div role="status" aria-live="polite">
      <p className="sr-only">Carregando a tela…</p>
      <div className="mb-6">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="mt-2 h-4 w-80 max-w-full" />
      </div>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-64" />
    </div>
  )
}

/** Aviso de erro. `role="alert"` faz o leitor de tela anunciar na hora. */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-lg bg-[var(--color-breach-soft)] px-3.5 py-2.5 text-sm font-medium text-[var(--color-breach-ink)]"
    >
      {children}
    </p>
  )
}

/**
 * Percorre as linhas e carimba em cada célula o nome da sua coluna.
 *
 * É isso que permite a tabela virar ficha no celular sem que nenhuma das 33
 * telas precise ser reescrita: o rótulo que estava no `<thead>` passa a viajar
 * junto com o dado, e o CSS o exibe quando a coluna deixa de existir.
 *
 * Três detalhes que não são opcionais:
 *
 * - **`Fragment` é atravessado.** Várias telas envolvem a linha do registro e a
 *   linha do painel de edição num `<Fragment>`; sem recursão, essas tabelas
 *   ficariam sem rótulo nenhum, que é justamente onde a ficha mais precisa.
 * - **`colSpan` não recebe rótulo** e avança o índice pelo número de colunas
 *   que ocupa. A linha do painel não é um dado de coluna, e numerá-la como se
 *   fosse desalinharia todas as células seguintes.
 * - **`false` e `null` passam intactos.** `{abre && <tr>…}` é o idioma usado em
 *   todas essas telas.
 */
function comRotulos(nos: ReactNode, head: string[]): ReactNode {
  return Children.map(nos, (no) => {
    if (!isValidElement(no)) return no
    const props = no.props as { children?: ReactNode }

    if (no.type === Fragment) {
      return cloneElement(
        no as ReactElement<{ children?: ReactNode }>,
        {},
        comRotulos(props.children, head),
      )
    }

    if (no.type !== 'tr') return no

    let coluna = 0
    const celulas = Children.map(props.children, (celula) => {
      if (!isValidElement(celula)) return celula
      const { colSpan } = celula.props as { colSpan?: number }
      const largura = colSpan && colSpan > 1 ? colSpan : 1
      const rotulo = largura > 1 ? undefined : head[coluna]
      coluna += largura
      if (!rotulo) return celula
      return cloneElement(celula as ReactElement<{ 'data-rotulo'?: string }>, {
        'data-rotulo': rotulo,
      })
    })

    return cloneElement(no as ReactElement<{ children?: ReactNode }>, {}, celulas)
  })
}

/**
 * Tabela no computador, ficha no celular.
 *
 * ## Por que não bastava rolar de lado
 *
 * Bastava, e era o que havia: `min-w-[52rem]` com `overflow-x-auto`. Num
 * aparelho de 390px isso significa que **toda** listagem do sistema chegava
 * cortada na terceira coluna, e as colunas que ficam de fora são sempre as do
 * fim — situação, prazo, ação —, que é onde está o trabalho. Em duas telas o
 * estouro vazava do invólucro e empurrava a PÁGINA inteira para os lados: 892px
 * de documento em 390px de tela, com o cabeçalho deslizando junto.
 *
 * Abaixo de `lg` a tabela vira uma pilha de fichas, cada célula com o seu
 * rótulo à esquerda (ver `.tabela` em `globals.css`). Nada de componente
 * paralelo: é a mesma marcação, a mesma ordem e o mesmo conteúdo — uma segunda
 * implementação para celular divergiria da primeira no mês seguinte.
 *
 * ## `tabIndex={0}` e `role="region"`
 *
 * Não são enfeite: um `div` com `overflow-x` só rola com ponteiro ou toque. Quem
 * navega por teclado chegava ao fim da tabela sem nunca ver as últimas colunas
 * (WCAG 2.1.1). Com `tabIndex`, as setas rolam a região; com `role` e
 * `aria-label`, o leitor de tela diz o que é aquilo antes de entrar.
 */
export function Table({
  head,
  children,
  label = 'Tabela de dados',
}: {
  head: string[]
  children: ReactNode
  label?: string
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="w-full min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] lg:overflow-x-auto"
    >
      <table className="tabela w-full border-collapse text-sm lg:min-w-[52rem]">
        <thead>
          <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-2)] text-left">
            {head.map((h) => (
              <th
                key={h}
                scope="col"
                className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{comRotulos(children, head)}</tbody>
      </table>
    </div>
  )
}

export function Td({
  children,
  className = '',
  colSpan,
  'data-rotulo': rotulo,
}: {
  children: ReactNode
  className?: string
  /** Usado pelas linhas que abrem um painel abaixo do registro. */
  colSpan?: number
  /** O nome da coluna, carimbado por `Table`. É o que vira rótulo na ficha. */
  'data-rotulo'?: string
}) {
  return (
    <td
      colSpan={colSpan}
      data-rotulo={rotulo}
      className={`border-b border-[var(--color-border)] px-4 py-3 ${className}`}
    >
      {/* O invólucro existe por causa da ficha de celular: lá a célula é um
          `flex` com o rótulo à esquerda, e sem ele cada filho do `<td>` viraria
          uma coluna solta — "Dell Latitude 5450" e "Notebook" apareciam lado a
          lado, brigando pela mesma faixa de 10 caracteres. Com o invólucro, o
          valor inteiro é UM item do flex, e volta a empilhar como na tabela. */}
      <div className="valor-da-celula">{children}</div>
    </td>
  )
}

/* --- Controles de formulário ------------------------------------------- */

export function Field({
  label,
  htmlFor,
  hint,
  required,
  children,
}: {
  label: string
  htmlFor: string
  hint?: string
  required?: boolean
  children: ReactNode
}) {
  const hintId = `${htmlFor}-hint`
  // A dica só ajuda leitor de tela se o campo apontar para ela: o `id` sozinho
  // nunca foi suficiente, e nenhum input do projeto informava
  // `aria-describedby` na mão — a regra de negócio na dica ("obrigatório se o
  // status for cancelada", "define o SLA aplicável"...) ficava muda. Clonar o
  // filho aqui resolve para every campo que usa `Field`, de uma vez.
  const field =
    hint && isValidElement(children)
      ? cloneElement(children as React.ReactElement<{ 'aria-describedby'?: string }>, {
          'aria-describedby': hintId,
        })
      : children
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-[var(--color-ink)]">
        {label}
        {required && (
          <span className="ml-1 text-[var(--color-breach-ink)]" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {field}
      {hint && (
        <p id={hintId} className="text-xs text-[var(--color-ink-3)]">
          {hint}
        </p>
      )}
    </div>
  )
}

/**
 * `border-strong`, e não `border`: o fio de 1px que delimita um campo é
 * "componente de interface" para a WCAG 1.4.11 e precisa de 3:1 contra o fundo
 * — o fio decorativo de cartão não precisa, e é por isso que são dois tokens.
 * Com o mesmo cinza-claro dos dois, o campo de texto sumia no cartão branco e
 * só reaparecia ao receber foco.
 */
export const inputClass =
  'w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] transition-colors placeholder:text-[var(--color-ink-3)] focus:border-[var(--color-brand)]'

export function Button({
  children,
  variant = 'primary',
  type = 'submit',
  disabled,
  name,
  value,
  onClick,
  'aria-describedby': ariaDescribedBy,
}: {
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'danger'
  type?: 'submit' | 'button'
  disabled?: boolean
  name?: string
  value?: string
  onClick?: () => void
  /** Liga o botão à explicação de por que está desabilitado (ex.: campo faltando). */
  'aria-describedby'?: string
}) {
  const variants = {
    primary: 'bg-[var(--color-brand)] text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]',
    secondary:
      'border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]',
    danger: 'bg-[var(--color-danger-solid)] text-[var(--color-on-solid)] hover:opacity-90',
  }
  return (
    <button
      type={type}
      name={name}
      value={value}
      disabled={disabled}
      onClick={onClick}
      aria-describedby={ariaDescribedBy}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]}`}
    >
      {children}
    </button>
  )
}
