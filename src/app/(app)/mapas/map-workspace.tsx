'use client'

import { useMemo, useState } from 'react'
import { PRECISION_LABEL, isPreciseEnough, type GeocodePrecision } from '@/lib/maps'
import { GoogleBranchMap, type MapPoint } from '@/components/google-map'
import { inputClass } from '@/components/ui'

export interface MissingBranch {
  branchId: string
  name: string
  city: string | null
  state: string | null
  precision: GeocodePrecision | null
  count: number
}

const NUM_TONE: Record<MapPoint['state_color'], string> = {
  green: 'text-[var(--color-ok-ink)]',
  amber: 'text-[var(--color-warn-ink)]',
  red: 'text-[var(--color-breach-ink)]',
}

/**
 * Mapa + lista de localizações.
 *
 * A busca filtra marcador e lista pela MESMA regra: duas regras separadas
 * divergiriam e a lista mostraria filial que o mapa esconde.
 */
export function MapWorkspace({
  points,
  missing,
  unitLabel,
}: {
  points: MapPoint[]
  /** Filiais sem coordenada: entram na lista, nunca no mapa. */
  missing: MissingBranch[]
  unitLabel: string
}) {
  const [query, setQuery] = useState('')
  const [focus, setFocus] = useState<{ branchId: string; nonce: number } | null>(null)

  const matches = (name: string, city: string | null, state: string | null) =>
    [name, city, state].filter(Boolean).join(' ').toLowerCase().includes(query.trim().toLowerCase())

  const shownPoints = useMemo(
    () => (query.trim() ? points.filter((p) => matches(p.name, p.city, p.state)) : points),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, query],
  )
  const shownMissing = query.trim()
    ? missing.filter((m) => matches(m.name, m.city, m.state))
    : missing

  const total = shownPoints.reduce((s, p) => s + p.count, 0)
  const listed = shownPoints.length + shownMissing.length

  return (
    <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="relative">
        <GoogleBranchMap points={shownPoints} focus={focus} />

        {/* Barra sobre o mapa. Fica à esquerda no topo: o canto inferior
            esquerdo é da atribuição do Google e não pode ser coberto. */}
        <div className="absolute left-3 top-3 z-10 flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setFocus(null)
            }}
            placeholder="Buscar filial, cidade ou UF"
            aria-label="Buscar no mapa"
            className={`${inputClass} w-56 shadow`}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-ink-2)] shadow hover:bg-[var(--color-surface-2)]"
            >
              Limpar filtro
            </button>
          )}
          <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink-2)] shadow">
            <strong>{shownPoints.length}</strong> filial(is) no mapa ·{' '}
            <strong className="tabular-nums">{total}</strong> {unitLabel}
            {shownMissing.length > 0 && (
              <span className="font-semibold text-[var(--color-warn-ink)]">
                {' '}
                · {shownMissing.length} sem localização
              </span>
            )}
          </span>
        </div>
      </div>

      <aside className="flex max-h-[44rem] flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <h2 className="border-b border-[var(--color-border)] px-3.5 py-2.5 text-sm font-semibold">
          Localizações <span className="font-normal text-[var(--color-ink-3)]">({listed})</span>
        </h2>
        <ul className="flex flex-col gap-1 overflow-y-auto p-1.5">
          {shownPoints.map((p) => (
            <li key={p.branchId}>
              <button
                type="button"
                onClick={() => setFocus({ branchId: p.branchId, nonce: Date.now() })}
                aria-current={focus?.branchId === p.branchId}
                className="grid w-full grid-cols-[2.6rem_minmax(0,1fr)] items-center gap-x-2 rounded-lg border border-transparent p-2 text-left hover:border-[var(--color-border)] hover:bg-[var(--color-surface-2)] aria-[current=true]:border-[var(--color-brand)] aria-[current=true]:bg-[var(--color-brand-soft)]"
              >
                <span
                  className={`row-span-2 justify-self-center text-lg font-bold tabular-nums ${NUM_TONE[p.state_color]}`}
                >
                  {p.count}
                </span>
                <span className="text-sm font-semibold">{p.name}</span>
                <span className="col-start-2 text-xs text-[var(--color-ink-3)]">
                  {[p.city, p.state].filter(Boolean).join(' / ')}
                  {' · '}
                  {isPreciseEnough(p.precision) ? 'exata' : 'aproximada'}
                </span>
              </button>
            </li>
          ))}

          {/* Sem coordenada continua listada — sumir sem aviso faria o mapa
              parecer completo. */}
          {shownMissing.map((m) => (
            <li
              key={m.branchId}
              className="grid grid-cols-[2.6rem_minmax(0,1fr)] items-center gap-x-2 p-2"
            >
              <span className="row-span-2 justify-self-center text-lg font-bold tabular-nums text-[var(--color-ink-3)]">
                {m.count}
              </span>
              <span className="text-sm font-semibold">{m.name}</span>
              <span className="col-start-2 text-xs text-[var(--color-warn-ink)]">
                {m.precision
                  ? PRECISION_LABEL[m.precision]
                  : 'sem coordenada — não aparece no mapa'}
              </span>
            </li>
          ))}

          {listed === 0 && (
            <li className="p-4 text-center text-sm text-[var(--color-ink-2)]">
              Nenhuma filial nesta busca.
            </li>
          )}
        </ul>
      </aside>
    </div>
  )
}
