'use client'

import { useEffect, useRef, useState } from 'react'
import { PRECISION_LABEL, googleMapsUrl } from '@/lib/maps'
import { MAX_AUTO_ZOOM, markerSvg, pointsSignature, popupHtml, type MapPoint } from './map-marker'

export type { MapPoint }

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
  setMap(m: unknown): void
}
interface GMap {
  fitBounds(b: GBounds, padding?: number): void
  setCenter(p: LatLng): void
  panTo(p: LatLng): void
  setZoom(z: number): void
  getZoom(): number | undefined
  setMapTypeId(id: string): void
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
    event: { clearInstanceListeners(instance: unknown): void }
  }
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

/** Pino SVG inline (compartilhado em `map-marker.tsx`), no formato de ícone do Google. */
function markerIcon(google: GoogleApi, point: MapPoint) {
  const { url, size, anchor } = markerSvg(point)
  return {
    url,
    scaledSize: new google.maps.Size(size, size),
    anchor: new google.maps.Point(anchor, anchor),
  }
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
  height = 560,
  focus = null,
  /**
   * Camada inicial. `hybrid` é satélite COM rótulos de rua — satélite puro é
   * bonito e inútil para conferir endereço, porque não mostra o nome da via.
   */
  mapTypeId = 'hybrid',
  /** Zoom aplicado ao focar uma filial (faixa 16–18). */
  focusZoom = 17,
}: {
  points: MapPoint[]
  height?: number
  /** Filial a centralizar. `nonce` permite repetir o foco na mesma filial. */
  focus?: { branchId: string; nonce: number } | null
  mapTypeId?: 'hybrid' | 'satellite' | 'roadmap' | 'terrain'
  focusZoom?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const mapRef = useRef<GMap | null>(null)
  const infoRef = useRef<GInfoWindow | null>(null)
  const markersRef = useRef(new Map<string, GMarker>())
  const lastFitRef = useRef<string | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY

  /* O mapa é criado UMA vez. Recriá-lo a cada mudança de `points` — o que
     acontece a cada tecla da busca — recarregaria os tiles e piscaria a tela. */
  useEffect(() => {
    if (!apiKey || !ref.current || mapRef.current) return
    let cancelled = false

    loadGoogleMaps(apiKey)
      .then(() => {
        if (cancelled || !ref.current) return
        const google = (window as unknown as { google: GoogleApi }).google
        const map = new google.maps.Map(ref.current, {
          // Alternância satélite/mapa exposta ao operador: conferir se o pino
          // caiu no imóvel certo exige a imagem; ler o nome da rua exige o mapa.
          mapTypeControl: true,
          mapTypeId,
          streetViewControl: true,
          zoomControl: true,
          gestureHandling: 'greedy',
          center: { lat: -14.6, lng: -52.5 },
          zoom: 4,
        })
        // Com uma única filial, fitBounds aproxima ao máximo e a vista perde
        // referência geográfica; limitamos o zoom depois do ajuste.
        map.addListener('idle', () => {
          const z = map.getZoom()
          if (typeof z === 'number' && z > MAX_AUTO_ZOOM) map.setZoom(MAX_AUTO_ZOOM)
        })
        mapRef.current = map
        infoRef.current = new google.maps.InfoWindow({ maxWidth: 300 })
        setReady(true)
      })
      .catch(() => {
        if (!cancelled)
          setError('Não foi possível carregar o Google Maps. Verifique a chave e as restrições de domínio.')
      })

    return () => {
      cancelled = true
      // A JS API do Google não tem um `map.remove()` equivalente ao do
      // Leaflet — o melhor que dá para fazer é soltar os listeners e os
      // marcadores para o GC recolher. Sem isso, um mapa por painel de filial
      // (várias instâncias) vazava a cada navegação para longe da tela.
      const google = (window as unknown as { google?: GoogleApi }).google
      if (mapRef.current && google) {
        markersRef.current.forEach((m) => m.setMap(null))
        markersRef.current = new Map()
        infoRef.current?.close()
        google.maps.event.clearInstanceListeners(mapRef.current)
      }
      mapRef.current = null
    }
  }, [apiKey, mapTypeId])

  /* Marcadores acompanham a filtragem; o mapa em si permanece. */
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    const google = (window as unknown as { google: GoogleApi }).google
    const info = infoRef.current

    markersRef.current.forEach((m) => m.setMap(null))
    markersRef.current = new Map()
    info?.close()

    const bounds = new google.maps.LatLngBounds()
    for (const p of points) {
      const marker = new google.maps.Marker({
        position: { lat: p.lat, lng: p.lng },
        map,
        title: `${p.name} — ${p.count}`,
        icon: markerIcon(google, p),
      })
      marker.addListener('click', () => {
        info?.setContent(popupHtml(p))
        info?.open({ map, anchor: marker })
      })
      markersRef.current.set(p.branchId, marker)
      bounds.extend({ lat: p.lat, lng: p.lng })
    }
    // Só reenquadra quando o CONJUNTO de pontos muda de fato — não a cada
    // refresh em tempo real ou re-render do servidor com o mesmo conteúdo.
    const signature = pointsSignature(points)
    if (!bounds.isEmpty() && signature !== lastFitRef.current) {
      map.fitBounds(bounds, 64)
    }
    lastFitRef.current = signature
  }, [ready, points])

  /* Clique na lista lateral: centraliza e abre o popup daquela filial. */
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || !focus) return
    const point = points.find((p) => p.branchId === focus.branchId)
    const marker = markersRef.current.get(focus.branchId)
    if (!point || !marker) return
    map.panTo({ lat: point.lat, lng: point.lng })
    map.setZoom(focusZoom)
    infoRef.current?.setContent(popupHtml(point))
    infoRef.current?.open({ map, anchor: marker })
  }, [ready, focus, points, focusZoom])

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

  /* O contêiner do mapa nunca é desmontado: se a busca não encontrar filial, o
     aviso vem SOBRE o mapa. Desmontar recriaria o mapa na próxima busca. */
  return (
    <div className="relative">
      <div
        ref={ref}
        role="application"
        aria-label="Mapa das filiais"
        style={{ height }}
        className="w-full overflow-hidden rounded-xl border border-[var(--color-border)]"
      />
      {points.length === 0 && (
        <p className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink-2)] shadow">
          Nenhuma filial com coordenada nesta seleção.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm font-medium text-[var(--color-breach-ink)]">
          {error}
        </p>
      )}
    </div>
  )
}
