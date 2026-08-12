/**
 * Coordenadas e integração com o Google Maps.
 *
 * Módulo sem dependências, para ser testável e reutilizável tanto pelo app
 * quanto pelo protótipo em `demo/`.
 */

export type GeocodePrecision =
  | 'rooftop'
  | 'range_interpolated'
  | 'geometric_center'
  | 'approximate'
  | 'manual'

export interface Coordinates {
  lat: number
  lng: number
}

/** Rótulos e implicação operacional de cada nível de precisão. */
export const PRECISION_LABEL: Record<GeocodePrecision, string> = {
  rooftop: 'Endereço exato',
  range_interpolated: 'Interpolado no logradouro',
  geometric_center: 'Centro do logradouro',
  approximate: 'Aproximado (cidade/bairro)',
  manual: 'Informado manualmente',
}

/**
 * Precisão suficiente para alguém em campo achar o local.
 * `approximate` cai no centro da cidade — inútil para despachar técnico.
 */
export function isPreciseEnough(p: GeocodePrecision | null | undefined): boolean {
  return p === 'rooftop' || p === 'range_interpolated' || p === 'manual'
}

/** Mapeia `geometry.location_type` da Geocoding API para o nosso enum. */
export function mapGoogleLocationType(locationType: string | undefined): GeocodePrecision {
  switch ((locationType ?? '').toUpperCase()) {
    case 'ROOFTOP':
      return 'rooftop'
    case 'RANGE_INTERPOLATED':
      return 'range_interpolated'
    case 'GEOMETRIC_CENTER':
      return 'geometric_center'
    default:
      return 'approximate'
  }
}

const LAT_RANGE = 90
const LNG_RANGE = 180

export function isValidCoordinates(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= LAT_RANGE &&
    Math.abs(lng) <= LNG_RANGE &&
    // 0,0 é o Golfo da Guiné: quase sempre sinal de campo vazio virando zero,
    // não de uma filial no meio do Atlântico.
    !(lat === 0 && lng === 0)
  )
}

/**
 * Extrai coordenadas de qualquer coisa que a pessoa cole da barra do navegador.
 *
 * Formatos aceitos, em ordem de tentativa:
 *   1. URL do Google Maps com `@lat,lng,zoom` (o mais comum ao copiar a URL)
 *   2. Parâmetro `?q=lat,lng` ou `?query=lat,lng` (link de compartilhamento)
 *   3. `!3dlat!4dlng` (aparece em URLs de lugar)
 *   4. Par solto `-23.550520, -46.633308`
 *
 * Colar a URL inteira é o caminho natural de quem está olhando o Maps; exigir
 * que a pessoa recorte os números convida ao erro de digitação.
 */
export function parseCoordinates(input: string): Coordinates | null {
  const text = (input ?? '').trim()
  if (!text) return null

  const patterns: RegExp[] = [
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/, // .../@-23.55,-46.63,17z
    /[?&](?:q|query|ll|center)=(-?\d+(?:\.\d+)?)%2C(-?\d+(?:\.\d+)?)/i,
    /[?&](?:q|query|ll|center)=(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i,
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/, // !3dlat!4dlng
    /^\s*(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)\s*$/, // par solto
  ]

  for (const re of patterns) {
    const m = text.match(re)
    if (!m) continue
    const lat = Number(m[1])
    const lng = Number(m[2])
    if (isValidCoordinates(lat, lng)) return { lat, lng }
  }

  return null
}

/** Arredonda para 6 casas — ~11 cm, muito além do necessário e do que a UI mostra. */
export function roundCoordinates({ lat, lng }: Coordinates): Coordinates {
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) }
}

export function formatCoordinates(lat: number, lng: number): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`
}

/**
 * Link para o ponto exato no Google Maps.
 * Usa a Maps URLs API, que é estável e não exige chave.
 */
export function googleMapsUrl(lat: number, lng: number, label?: string): string {
  const q = label ? `${lat},${lng}(${encodeURIComponent(label)})` : `${lat},${lng}`
  return `https://www.google.com/maps/search/?api=1&query=${q}`
}

/** Link de rota até a filial — o que o técnico de campo realmente usa. */
export function googleDirectionsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
}

/** Monta o endereço em uma linha, como a Geocoding API espera receber. */
export function buildGeocodeQuery(parts: {
  addressLine?: string | null
  district?: string | null
  city?: string | null
  state?: string | null
  postalCode?: string | null
}): string {
  return [parts.addressLine, parts.district, parts.city, parts.state, parts.postalCode, 'Brasil']
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(', ')
}
