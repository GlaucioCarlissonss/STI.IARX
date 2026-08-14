/**
 * Marcador e popup do mapa de filiais — compartilhados entre motores.
 *
 * O pino (SVG inline em data URI) e o HTML do popup não dependem de nenhuma
 * API de mapa específica, então vivem aqui e são consumidos tanto pelo motor
 * Google (`google-map.tsx`) quanto pelo motor Leaflet/OSM (`leaflet-branch-map.tsx`).
 * Duplicar essa lógica entre os dois faria o popup do Google e o do Leaflet
 * divergirem na primeira mudança de um dos dois.
 */

import { PRECISION_LABEL, googleDirectionsUrl, googleMapsUrl, isPreciseEnough, type GeocodePrecision } from '@/lib/maps'

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

const MARKER_FILL: Record<MapPoint['state_color'], string> = {
  green: '#15803d',
  amber: '#a16207',
  red: '#b91c1c',
}

/**
 * Teto do enquadramento automático.
 *
 * Uma filial só no ajuste de bounds levaria o zoom ao máximo, e a vista perde
 * referência. 18 é o limite superior da faixa exigida para identificar o imóvel
 * (16–18) e é o suficiente para ver o telhado na camada de satélite.
 */
export const MAX_AUTO_ZOOM = 18

/**
 * Pino em SVG inline, colorido pelo semáforo, com a contagem embutida.
 *
 * Devolve a URL de dados e as dimensões — cada motor de mapa embrulha isso no
 * formato de ícone que espera (`google.maps.Size`/`Point` vs `L.icon`).
 */
export function markerSvg(point: MapPoint) {
  const r = 13 + Math.min(9, Math.round(Math.log2(point.count + 1) * 3))
  const size = r * 2 + 6
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <circle cx="${r + 3}" cy="${r + 3}" r="${r}" fill="${MARKER_FILL[point.state_color]}"
        stroke="#ffffff" stroke-width="2.5"/>
      <text x="${r + 3}" y="${r + 3}" text-anchor="middle" dominant-baseline="central"
        font-family="system-ui, sans-serif" font-size="${r > 15 ? 13 : 11}"
        font-weight="700" fill="#ffffff">${point.count}</text>
    </svg>`
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    size,
    anchor: r + 3,
  }
}

export function popupHtml(p: MapPoint): string {
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
