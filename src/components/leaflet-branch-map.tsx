'use client'

import 'leaflet/dist/leaflet.css'
import { useEffect, useRef, useState } from 'react'
import type { Map as LeafletMap, Marker as LeafletMarker, LayerGroup } from 'leaflet'
import { MAX_AUTO_ZOOM, markerSvg, pointsSignature, popupHtml, type MapPoint } from './map-marker'

export type { MapPoint }

/**
 * Mapa das filiais com OpenStreetMap (ruas) e Esri World Imagery (satélite).
 *
 * Motor sem chave e sem cadastro — funciona assim que o app é publicado, sem
 * o operador precisar criar conta no Google Cloud. É o motor padrão quando
 * `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` não está definida (ver `branch-map.tsx`).
 *
 * Mesma assinatura de props do motor Google (`google-map.tsx`), para os dois
 * serem intercambiáveis sem tocar em quem os consome.
 */
export function LeafletBranchMap({
  points,
  height = 560,
  focus = null,
  /** Camada inicial: 'satellite' equivale ao `hybrid` do Google (imagem + rótulos). */
  defaultLayer = 'satellite',
  /** Zoom aplicado ao focar uma filial (faixa 16–18). */
  focusZoom = 17,
}: {
  points: MapPoint[]
  height?: number
  /** Filial a centralizar. `nonce` permite repetir o foco na mesma filial. */
  focus?: { branchId: string; nonce: number } | null
  defaultLayer?: 'satellite' | 'street'
  focusZoom?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const markersRef = useRef(new Map<string, LeafletMarker>())
  const lastFitRef = useRef<string | null>(null)
  const [ready, setReady] = useState(false)
  // Distinto de `ready`: o mapa existe assim que `ready` vira true, mas os
  // marcadores só existem depois que o efeito seguinte (também assíncrono,
  // por causa do próprio `import('leaflet')`) terminar de povoar `markersRef`.
  // Sem essa distinção, um clique na lista lateral entre um momento e outro
  // encontrava `markersRef` vazio e retornava em silêncio, sem centralizar
  // nem reagir de novo — porque as deps do efeito de foco não mudam depois.
  const [markersReady, setMarkersReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /* O mapa é criado UMA vez. Recriá-lo a cada mudança de `points` — o que
     acontece a cada tecla da busca — recarregaria os tiles e piscaria a tela. */
  useEffect(() => {
    if (!ref.current || mapRef.current) return
    let cancelled = false

    // Import dinâmico: o pacote toca `window`/`navigator` na avaliação de
    // alguns submódulos, e um import estático quebraria a renderização deste
    // Client Component durante o passo de SSR do Next.
    import('leaflet')
      .then((L) => {
        if (cancelled || !ref.current) return

        // Ruas: OpenStreetMap. Satélite: Esri World Imagery — atenção, a URL
        // do Esri inverte a ordem para {z}/{y}/{x}, diferente do padrão XYZ.
        const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        })
        const satelliteImagery = L.tileLayer(
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          { maxZoom: 19, attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics' },
        )
        // Rótulos de rua sobre a imagem de satélite — o equivalente ao modo
        // `hybrid` do Google. Satélite sem nome de rua não serve para
        // conferir se o pino caiu no endereço certo.
        const satelliteLabels = L.tileLayer(
          'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
          { maxZoom: 19 },
        )
        const satellite: LayerGroup = L.layerGroup([satelliteImagery, satelliteLabels])

        const map = L.map(ref.current, {
          center: [-14.6, -52.5],
          zoom: 4,
          // Teto único: substitui o listener de 'idle' que o motor Google usa
          // para recortar o zoom depois do fitBounds — aqui a própria API do
          // Leaflet aplica o limite em toda interação (roda, duplo clique,
          // fitBounds), não só no primeiro ajuste automático.
          maxZoom: MAX_AUTO_ZOOM,
          layers: [defaultLayer === 'street' ? street : satellite],
        })

        L.control
          .layers({ Mapa: street, Satélite: satellite }, undefined, { position: 'topright' })
          .addTo(map)

        mapRef.current = map
        setReady(true)
      })
      .catch(() => {
        if (!cancelled) setError('Não foi possível carregar o mapa (OpenStreetMap/Esri).')
      })

    return () => {
      cancelled = true
      // Leaflet recusa reutilizar o mesmo elemento sem destruir a instância
      // anterior — sem isso, remontar a tela (voltar de outra rota) lançaria
      // "Map container is already initialized".
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [defaultLayer])

  /* Marcadores acompanham a filtragem; o mapa em si permanece. */
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    let cancelled = false

    import('leaflet').then((L) => {
      if (cancelled) return

      markersRef.current.forEach((m) => m.remove())
      markersRef.current = new Map()

      const latLngs: [number, number][] = []
      for (const p of points) {
        const { url, size, anchor } = markerSvg(p)
        const marker = L.marker([p.lat, p.lng], {
          icon: L.icon({
            iconUrl: url,
            iconSize: [size, size],
            iconAnchor: [anchor, anchor],
            popupAnchor: [0, -anchor],
          }),
          title: `${p.name} — ${p.count}`,
          // Sem isso o Leaflet gera `<img alt="">` — o marcador ficava sem
          // nome acessível, só com o `title` (tooltip do mouse, que leitor
          // de tela não lê da mesma forma). O motor Google já expunha isso.
          alt: `${p.name} — ${p.count}`,
        }).addTo(map)
        // autoClose (padrão do Leaflet) já garante um popup aberto por vez —
        // não precisa da InfoWindow única e compartilhada que o motor Google usa.
        marker.bindPopup(popupHtml(p), { maxWidth: 300 })
        markersRef.current.set(p.branchId, marker)
        latLngs.push([p.lat, p.lng])
      }
      // Só reenquadra quando o CONJUNTO de pontos muda de fato — não a cada
      // refresh em tempo real ou re-render do servidor com o mesmo conteúdo.
      const signature = pointsSignature(points)
      if (latLngs.length && signature !== lastFitRef.current) {
        map.fitBounds(latLngs, { padding: [64, 64] })
      }
      lastFitRef.current = signature
      setMarkersReady(true)
    })

    return () => {
      cancelled = true
    }
  }, [ready, points])

  /* Clique na lista lateral: centraliza e abre o popup daquela filial. */
  useEffect(() => {
    const map = mapRef.current
    if (!markersReady || !map || !focus) return
    const point = points.find((p) => p.branchId === focus.branchId)
    const marker = markersRef.current.get(focus.branchId)
    if (!point || !marker) return
    // flyTo anima a transição — o mais próximo do comportamento de um GPS
    // "chegando" no ponto, em vez de saltar direto para o zoom final.
    map.flyTo([point.lat, point.lng], focusZoom)
    marker.openPopup()
  }, [markersReady, focus, points, focusZoom])

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
