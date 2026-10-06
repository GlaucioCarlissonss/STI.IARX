import { cloneElement, isValidElement, type ReactNode } from 'react'
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
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${toneClasses[tone]}`}
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
 * Tabela com rolagem horizontal em tela estreita.
 *
 * `tabIndex={0}` e `role="region"` no invólucro não são enfeite: um `div` com
 * `overflow-x` só rola com ponteiro ou toque. Quem navega por teclado chegava ao
 * fim da tabela sem nunca ver as últimas colunas — e as últimas colunas são
 * sempre as de situação e ação, que é onde está o trabalho (WCAG 2.1.1). Com
 * `tabIndex`, as setas rolam a região; com `role` e `aria-label`, o leitor de
 * tela diz o que é aquilo antes de entrar.
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
      className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]"
    >
      <table className="w-full min-w-[52rem] border-collapse text-sm">
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
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export function Td({
  children,
  className = '',
  colSpan,
}: {
  children: ReactNode
  className?: string
  /** Usado pelas linhas que abrem um painel abaixo do registro. */
  colSpan?: number
}) {
  return (
    <td colSpan={colSpan} className={`border-b border-[var(--color-border)] px-4 py-3 ${className}`}>
      {children}
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
