'use client'

import { useEffect, useRef, useState } from 'react'
import {
  PRECISION_LABEL,
  googleDirectionsUrl,
  googleMapsUrl,
  isPreciseEnough,
  type GeocodePrecision,
} from '@/lib/maps'

export interface MapPoint {
  branchId: string
  name: string
  city: string | null
  state: string | null
  lat: number
  lng: number
  count: number
  state_color: 'green' | 'amber' | 'red'
  precision: GeocodePrecision | null
  address: string | null
  /** Linhas do popup: "Enfermagem: 8". Vem da quebra por área. */
  breakdown: { label: string; value: number }[]
}

/* --------------------------------------------------------------------------
   Tipos mínimos da Google Maps JS API.
   Declaramos apenas o que usamos, em vez de somar @types/google.maps ao
   projeto por um único componente.
   -------------------------------------------------------------------------- */
interface LatLng {
  lat: number
  lng: number
}
interface GBounds {
  extend(p: LatLng): void
  isEmpty(): boolean
}
interface GInfoWindow {
  setContent(c: string): void
  open(opts: { map: unknown; anchor: unknown }): void
  close(): void
}
interface GMarker {
  addListener(ev: string, cb: () => void): void
}
interface GMap {
  fitBounds(b: GBounds, padding?: number): void
  setCenter(p: LatLng): void
  setZoom(z: number): void
  getZoom(): number | undefined
  addListener(ev: string, cb: () => void): void
}
interface GoogleApi {
  maps: {
    Map: new (el: HTMLElement, opts: Record<string, unknown>) => GMap
    Marker: new (opts: Record<string, unknown>) => GMarker
    InfoWindow: new (opts?: Record<string, unknown>) => GInfoWindow
    LatLngBounds: new () => GBounds
    Point: new (x: number, y: number) => unknown
    Size: new (w: number, h: number) => unknown
  }
}

const MARKER_FILL: Record<MapPoint['state_color'], string> = {
  green: '#15803d',
  amber: '#a16207',
  red: '#b91c1c',
}

let loaderPromise: Promise<void> | null = null

/**
 * Carrega o script da Google Maps JS API uma única vez por página.
 *
 * Sem esta deduplicação, alternar entre as abas de mapa injetaria o script de
 * novo a cada montagem — o Google avisa no console e o mapa pisca.
 */
function loadGoogleMaps(apiKey: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if ((window as unknown as { google?: GoogleApi }).google?.maps) return Promise.resolve()
  if (loaderPromise) return loaderPromise

  loaderPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    // `loading=async` é o modo recomendado e evita o aviso de carregamento
    // sincrono; `language`/`region` garantem rótulos em pt-BR.
    script.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}` +
      `&loading=async&language=pt-BR&region=BR`
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      loaderPromise = null
      reject(new Error('Falha ao carregar a Google Maps JS API'))
    }
    document.head.appendChild(script)
  })

  return loaderPromise
}

/** Pino SVG inline, colorido pelo semáforo, com a contagem embutida. */
function markerIcon(google: GoogleApi, point: MapPoint) {
  const r = 13 + Math.min(9, Math.round(Math.log2(point.count + 1) * 3))
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${r * 2 + 6}" height="${r * 2 + 6}">
      <circle cx="${r + 3}" cy="${r + 3}" r="${r}" fill="${MARKER_FILL[point.state_color]}"
        stroke="#ffffff" stroke-width="2.5"/>
      <text x="${r + 3}" y="${r + 3}" text-anchor="middle" dominant-baseline="central"
        font-family="system-ui, sans-serif" font-size="${r > 15 ? 13 : 11}"
        font-weight="700" fill="#ffffff">${point.count}</text>
    </svg>`
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new google.maps.Size(r * 2 + 6, r * 2 + 6),
    anchor: new google.maps.Point(r + 3, r + 3),
  }
}

function popupHtml(p: MapPoint): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

  const precision = p.precision
    ? `<div style="font-size:11px;color:${isPreciseEnough(p.precision) ? '#15803d' : '#a16207'}">
         ${esc(PRECISION_LABEL[p.precision])}</div>`
    : ''

  const rows = p.breakdown.length
    ? p.breakdown
        .map(
          (b) =>
            `<div style="display:flex;justify-content:space-between;gap:12px;padding:1px 0">
               <span>${esc(b.label)}</span><strong>${b.value}</strong></div>`,
        )
        .join('')
    : '<div style="color:#6b7482">Nada nesta filial para este domínio.</div>'

  return `<div style="font:13px system-ui,sans-serif;min-width:210px;color:#14181f">
    <strong style="font-size:13.5px">${esc(p.name)}</strong>
    <div style="color:#6b7482;font-size:11.5px">${esc([p.city, p.state].filter(Boolean).join(' / '))}</div>
    ${p.address ? `<div style="color:#6b7482;font-size:11px;margin-top:2px">${esc(p.address)}</div>` : ''}
    ${precision}
    <div style="margin-top:8px;border-top:1px solid #e5e7eb;padding-top:6px">${rows}</div>
    <div style="margin-top:8px;display:flex;gap:10px;font-size:11.5px">
      <a href="${googleMapsUrl(p.lat, p.lng, p.name)}" target="_blank" rel="noopener">Ver no Maps</a>
      <a href="${googleDirectionsUrl(p.lat, p.lng)}" target="_blank" rel="noopener">Rota</a>
    </div>
  </div>`
}

/**
 * Mapa das filiais com Google Maps.
 *
 * A chave é pública por natureza (a JS API valida por referrer, não por
 * segredo), então vai em `NEXT_PUBLIC_`. Restrinja-a ao seu domínio no console
 * do Google — sem isso, qualquer site pode consumir sua cota.
 */
export function GoogleBranchMap({
  points,
  height = 520,
}: {
  points: MapPoint[]
  height?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY

  useEffect(() => {
    if (!apiKey || !ref.current || points.length === 0) return
    let cancelled = false

    loadGoogleMaps(apiKey)
      .then(() => {
        if (cancelled || !ref.current) return
        const google = (window as unknown as { google: GoogleApi }).google

        const map = new google.maps.Map(ref.current, {
          mapTypeControl: false,
          streetViewControl: false,
          zoomControl: true,
          gestureHandling: 'cooperative',
        })

        const info = new google.maps.InfoWindow({ maxWidth: 280 })
        const bounds = new google.maps.LatLngBounds()

        for (const p of points) {
          const marker = new google.maps.Marker({
            position: { lat: p.lat, lng: p.lng },
            map,
            title: `${p.name} — ${p.count}`,
            icon: markerIcon(google, p),
          })
          marker.addListener('click', () => {
            info.setContent(popupHtml(p))
            info.open({ map, anchor: marker })
          })
          bounds.extend({ lat: p.lat, lng: p.lng })
        }

        map.fitBounds(bounds, 64)
        // Com uma única filial, fitBounds aproxima ao máximo e a vista perde
        // referência geográfica; limitamos o zoom depois do ajuste.
        map.addListener('idle', () => {
          const z = map.getZoom()
          if (typeof z === 'number' && z > 15) map.setZoom(15)
        })
      })
      .catch(() => {
        if (!cancelled) setError('Não foi possível carregar o Google Maps. Verifique a chave e as restrições de domínio.')
      })

    return () => {
      cancelled = true
    }
  }, [apiKey, points])

  /* Degradação explícita: sem chave, o mapa não some — vira lista com link
     para o ponto exato no Google Maps, que é o essencial da tarefa. */
  if (!apiKey) {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <p className="text-sm font-semibold text-[var(--color-warn-ink)]">
          Google Maps não configurado
        </p>
        <p className="mt-1 text-sm text-[var(--color-ink-2)]">
          Defina <code className="font-mono text-xs">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> para
          exibir o mapa. Abaixo, as coordenadas já cadastradas com link para o ponto exato.
        </p>
        <ul className="mt-4 flex flex-col gap-2">
          {points.map((p) => (
            <li
              key={p.branchId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-border)] pb-2 text-sm last:border-0"
            >
              <span className="font-medium">{p.name}</span>
              <span className="font-mono text-xs text-[var(--color-ink-3)]">
                {p.lat.toFixed(6)}, {p.lng.toFixed(6)}
              </span>
              <span className="text-xs text-[var(--color-ink-3)]">
                {p.precision ? PRECISION_LABEL[p.precision] : 'precisão desconhecida'}
              </span>
              <a
                href={googleMapsUrl(p.lat, p.lng, p.name)}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto text-xs font-semibold text-[var(--color-brand)] hover:underline"
              >
                Abrir no Google Maps
              </a>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  if (points.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border)] p-10 text-center text-sm text-[var(--color-ink-2)]">
        Nenhuma filial com coordenada cadastrada.
      </div>
    )
  }

  return (
    <div>
      <div
        ref={ref}
        role="application"
        aria-label="Mapa das filiais"
        style={{ height }}
        className="w-full overflow-hidden rounded-xl border border-[var(--color-border)]"
      />
      {error && (
        <p role="alert" className="mt-2 text-sm font-medium text-[var(--color-breach-ink)]">
          {error}
        </p>
      )}
    </div>
  )
}
