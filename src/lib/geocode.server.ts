/**
 * Geocodificação: as chamadas de rede do fluxo de localização.
 *
 * Fica separado de `address.ts` (puro) porque este arquivo **só pode rodar no
 * servidor**: a chave da Geocoding API é de servidor e não tem restrição de
 * referrer — se ela vazar para o bundle, qualquer pessoa consome a cota e a
 * fatura. Nenhum componente cliente deve importar este módulo.
 */

import {
  type CepLookup,
  type GeocodeCandidate,
  type GeocodeReport,
  type GeocodeStatus,
  type StructuredAddress,
  SERVICE_REQUIREMENTS,
  checkAddressConsistency,
  geocodeQuery,
  missingRequiredFields,
  normalizeCep,
} from './address'
import { isValidCoordinates, mapGoogleLocationType, roundCoordinates } from './maps'

// Guarda em vez do pacote `server-only`: não adiciona dependência e falha alto
// se alguém importar isto de um componente cliente — o que levaria a chave de
// servidor para o bundle. Em teste (Node, sem `window`) a guarda não dispara.
if (typeof window !== 'undefined')
  throw new Error(
    'geocode.server.ts é módulo de servidor: importá-lo no cliente exporia GOOGLE_MAPS_SERVER_KEY.',
  )

const FETCH_TIMEOUT_MS = 8000

/** `fetch` com prazo: um provedor lento não pode pendurar a Server Action. */
async function fetchJson(url: string, init?: RequestInit): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      // Regra de tempo real: nada de cache. O cadastro é a verdade, e uma
      // resposta velha faria o mapa mostrar o endereço anterior.
      cache: 'no-store',
    })
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/* ==========================================================================
   Consulta de CEP — usada para validar consistência, nunca para geocodificar
   ========================================================================== */

/** Template configurável; `{cep}` recebe os 8 dígitos. Padrão: ViaCEP. */
const CEP_LOOKUP_URL = process.env.CEP_LOOKUP_URL ?? 'https://viacep.com.br/ws/{cep}/json/'

interface ViaCepShape {
  cep?: string
  logradouro?: string
  bairro?: string
  localidade?: string
  uf?: string
  erro?: boolean | string
}

/**
 * Resolve o CEP em logradouro/bairro/cidade/UF.
 *
 * Devolve `null` quando o serviço não responde ou o CEP não existe. `null` aqui
 * significa "não verificado", não "consistente" — quem chama precisa dizer isso
 * ao operador, e não fingir que a validação passou.
 */
export async function lookupCep(cep: string | null | undefined): Promise<CepLookup | null> {
  const normalized = normalizeCep(cep)
  if (!normalized) return null
  if (process.env.CEP_LOOKUP_DISABLED === '1') return null

  const digits = normalized.replace('-', '')
  const data = (await fetchJson(CEP_LOOKUP_URL.replace('{cep}', digits))) as ViaCepShape | null
  if (!data || data.erro === true || data.erro === 'true') return null

  return {
    postalCode: normalized,
    street: data.logradouro?.trim() || null,
    district: data.bairro?.trim() || null,
    city: data.localidade?.trim() || null,
    state: data.uf?.trim().toUpperCase() || null,
  }
}

/* ==========================================================================
   Geocodificação
   ========================================================================== */

interface GoogleGeocodeResult {
  formatted_address?: string
  place_id?: string
  partial_match?: boolean
  geometry?: { location?: { lat?: number; lng?: number }; location_type?: string }
}
interface GoogleGeocodeResponse {
  status?: string
  results?: GoogleGeocodeResult[]
  error_message?: string
}

export interface GeocodeProviderResult {
  status: 'ok' | 'not_found' | 'service_unavailable'
  candidates: GeocodeCandidate[]
  provider: string | null
  message: string
}

const MAX_CANDIDATES = 5

/** Converte a resposta da Geocoding API em candidatos nossos. */
export function parseGoogleGeocode(payload: unknown): GeocodeCandidate[] {
  const body = (payload ?? {}) as GoogleGeocodeResponse
  return (body.results ?? [])
    .map((r): GeocodeCandidate | null => {
      const lat = Number(r.geometry?.location?.lat)
      const lng = Number(r.geometry?.location?.lng)
      if (!isValidCoordinates(lat, lng)) return null
      const rounded = roundCoordinates({ lat, lng })
      return {
        lat: rounded.lat,
        lng: rounded.lng,
        formattedAddress: r.formatted_address ?? '',
        precision: mapGoogleLocationType(r.geometry?.location_type),
        placeId: r.place_id ?? null,
        partial: r.partial_match === true,
      }
    })
    .filter((c): c is GeocodeCandidate => c !== null)
    .slice(0, MAX_CANDIDATES)
}

/**
 * Geocodifica o endereço estruturado pela Google Geocoding API.
 *
 * `components=country:BR|postal_code:` restringe a busca ao CEP informado — sem
 * isso, "Rua 7 de Setembro, 100" devolve resultado em dezenas de cidades e o
 * fluxo cai em múltiplas correspondências sempre.
 */
export async function geocodeAddressGoogle(address: StructuredAddress): Promise<GeocodeProviderResult> {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY
  if (!key)
    return {
      status: 'service_unavailable',
      candidates: [],
      provider: null,
      message:
        'API de geocodificação não configurada no ambiente (GOOGLE_MAPS_SERVER_KEY ausente).',
    }

  const cep = normalizeCep(address.postalCode)
  const components = ['country:BR', cep ? `postal_code:${cep}` : null].filter(Boolean).join('|')
  const url =
    'https://maps.googleapis.com/maps/api/geocode/json' +
    `?address=${encodeURIComponent(geocodeQuery(address))}` +
    `&components=${encodeURIComponent(components)}` +
    `&language=pt-BR&region=br&key=${encodeURIComponent(key)}`

  const payload = await fetchJson(url)
  if (payload === null)
    return {
      status: 'service_unavailable',
      candidates: [],
      provider: 'google-geocoding',
      message: 'A Geocoding API não respondeu (rede, cota ou chave inválida).',
    }

  const body = payload as GoogleGeocodeResponse
  const status = (body.status ?? '').toUpperCase()

  if (status === 'ZERO_RESULTS')
    return { status: 'not_found', candidates: [], provider: 'google-geocoding', message: 'Nenhuma correspondência para o endereço informado.' }

  if (status !== 'OK')
    return {
      status: 'service_unavailable',
      candidates: [],
      provider: 'google-geocoding',
      // OVER_QUERY_LIMIT / REQUEST_DENIED / INVALID_REQUEST caem aqui. Tratar
      // isso como "endereço não encontrado" faria o operador corrigir um
      // cadastro que está certo.
      message: `A Geocoding API respondeu ${status}${body.error_message ? `: ${body.error_message}` : ''}.`,
    }

  const candidates = parseGoogleGeocode(payload)
  if (candidates.length === 0)
    return { status: 'not_found', candidates: [], provider: 'google-geocoding', message: 'A resposta não trouxe coordenada utilizável.' }

  return { status: 'ok', candidates, provider: 'google-geocoding', message: '' }
}

/* ==========================================================================
   Geocodificação sem chave — Nominatim (OpenStreetMap)
   ========================================================================== */

interface NominatimAddress {
  house_number?: string
  road?: string
  suburb?: string
  neighbourhood?: string
  city?: string
  town?: string
  state?: string
  postcode?: string
}
interface NominatimResult {
  lat?: string
  lon?: string
  display_name?: string
  place_id?: number
  /** jsonv2: tipo semântico do resultado — 'house', 'road', 'suburb', 'city'… */
  addresstype?: string
  class?: string
  type?: string
  address?: NominatimAddress
}

/** Identifica a aplicação ao Nominatim — a política de uso exige um User-Agent próprio, não o do navegador. */
const NOMINATIM_USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ?? 'STI-IARX-helpdesk/1.0 (contato via painel do operador)'

/**
 * Estima o nível de precisão a partir do tipo semântico que o Nominatim
 * devolve. Não é o mesmo vocabulário do Google (`ROOFTOP`/…) — é uma
 * heurística sobre `addresstype`/`class`/`type`, documentada como tal para não
 * parecer mais exata do que realmente é.
 */
export function nominatimPrecision(r: NominatimResult): GeocodeCandidate['precision'] {
  const kind = (r.addresstype || r.type || '').toLowerCase()
  const cls = (r.class || '').toLowerCase()
  if (kind === 'house' || cls === 'building') return 'rooftop'
  if (cls === 'highway' || kind === 'road') return 'range_interpolated'
  if (['suburb', 'neighbourhood', 'city_district', 'quarter', 'city', 'town', 'village'].includes(kind))
    return 'approximate'
  return 'geometric_center'
}

/** Converte a resposta do Nominatim em candidatos nossos. */
export function parseNominatimResults(payload: unknown): GeocodeCandidate[] {
  const results = Array.isArray(payload) ? (payload as NominatimResult[]) : []
  return results
    .map((r): GeocodeCandidate | null => {
      const lat = Number(r.lat)
      const lng = Number(r.lon) // atenção: o campo do Nominatim é `lon`, não `lng`
      if (!isValidCoordinates(lat, lng)) return null
      const rounded = roundCoordinates({ lat, lng })
      return {
        lat: rounded.lat,
        lng: rounded.lng,
        formattedAddress: r.display_name ?? '',
        precision: nominatimPrecision(r),
        placeId: r.place_id ? String(r.place_id) : null,
      }
    })
    .filter((c): c is GeocodeCandidate => c !== null)
    .slice(0, MAX_CANDIDATES)
}

/**
 * Geocodifica pelo Nominatim (OpenStreetMap) — sem chave, sem cadastro.
 *
 * É o provedor padrão quando `GOOGLE_MAPS_SERVER_KEY` não está configurada
 * (ver `resolveGeocodeProvider`): o fluxo funciona assim que o app é
 * publicado, sem o operador precisar criar conta em lugar nenhum.
 *
 * Parâmetros estruturados (`street`/`city`/`state`/`postalcode`), não a busca
 * livre (`q`) — a mesma razão do `components` na chamada ao Google: sem
 * restringir por CEP, um logradouro comum devolve resultado em dezenas de
 * cidades e o fluxo cai em múltiplas correspondências sempre.
 */
export async function geocodeAddressNominatim(address: StructuredAddress): Promise<GeocodeProviderResult> {
  const cep = normalizeCep(address.postalCode)
  const params = new URLSearchParams({
    format: 'jsonv2',
    addressdetails: '1',
    countrycodes: 'br',
    limit: String(MAX_CANDIDATES),
    country: 'Brazil',
  })
  const street = [address.street, address.streetNumber].map((p) => (p ?? '').trim()).filter(Boolean).join(' ')
  if (street) params.set('street', street)
  if (address.city) params.set('city', address.city.trim())
  if (address.state) params.set('state', address.state.trim())
  if (cep) params.set('postalcode', cep)

  const payload = await fetchJson(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { 'User-Agent': NOMINATIM_USER_AGENT, 'Accept-Language': 'pt-BR' },
  })
  if (payload === null)
    return {
      status: 'service_unavailable',
      candidates: [],
      provider: 'nominatim',
      message: 'O Nominatim (OpenStreetMap) não respondeu.',
    }

  const candidates = parseNominatimResults(payload)
  if (candidates.length === 0)
    return {
      status: 'not_found',
      candidates: [],
      provider: 'nominatim',
      message: 'Nenhuma correspondência para o endereço informado.',
    }

  return { status: 'ok', candidates, provider: 'nominatim', message: '' }
}

/**
 * Escolhe o provedor de geocodificação sem exigir configuração do operador.
 *
 * Google é preferido quando a chave existe (SLA e suporte oficiais); na
 * ausência dela, o Nominatim garante que o fluxo funcione de qualquer forma —
 * o mapa não fica bloqueado esperando alguém criar conta no Google Cloud.
 */
export function resolveGeocodeProvider(): (address: StructuredAddress) => Promise<GeocodeProviderResult> {
  return process.env.GOOGLE_MAPS_SERVER_KEY ? geocodeAddressGoogle : geocodeAddressNominatim
}

/** Provedor efetivo usado pelo pipeline por padrão — resolvido a cada chamada. */
export async function geocodeAddress(address: StructuredAddress): Promise<GeocodeProviderResult> {
  return resolveGeocodeProvider()(address)
}

/* ==========================================================================
   Fluxo completo
   ========================================================================== */

/** Injetável para teste: o pipeline não precisa de rede para ser verificado. */
export interface GeocodeDeps {
  lookupCep: (cep: string | null | undefined) => Promise<CepLookup | null>
  geocodeAddress: (address: StructuredAddress) => Promise<GeocodeProviderResult>
  now: () => Date
}

const defaultDeps: GeocodeDeps = { lookupCep, geocodeAddress, now: () => new Date() }

/**
 * Executa o fluxo na ordem exigida: campos obrigatórios → consistência →
 * geocodificação → escolha do candidato.
 *
 * A ordem não é decorativa. Geocodificar antes de validar gastaria cota com
 * endereço que o operador ainda vai corrigir, e — pior — devolveria uma
 * coordenada plausível para um endereço incompleto, que é justamente o erro que
 * o fluxo existe para impedir.
 */
export async function runGeocodePipeline(
  address: StructuredAddress,
  deps: Partial<GeocodeDeps> = {},
): Promise<GeocodeReport> {
  const d = { ...defaultDeps, ...deps }
  const timestamp = d.now().toISOString()

  const base: GeocodeReport = {
    status: 'ok',
    input: address,
    missing: missingRequiredFields(address),
    consistency: { consistent: true, issues: [] },
    cepLookup: null,
    candidates: [],
    chosen: null,
    provider: null,
    message: '',
    requirements: SERVICE_REQUIREMENTS,
    timestamp,
  }

  // 1. Campos obrigatórios. Nada de renderizar mapa com endereço pela metade.
  if (base.missing.length > 0)
    return {
      ...base,
      status: 'missing_fields',
      message: `Complete o cadastro antes de geolocalizar: ${base.missing.join(', ')}.`,
    }

  if (!normalizeCep(address.postalCode))
    return {
      ...base,
      status: 'missing_fields',
      missing: ['CEP válido (8 dígitos)'],
      message: 'O CEP cadastrado não tem 8 dígitos.',
    }

  // 2. Consistência. CEP de uma cidade com logradouro de outra é erro de
  //    cadastro, e geocodificar isso produz um ponto convincente e errado.
  const cepLookup = await d.lookupCep(address.postalCode)
  const consistency = checkAddressConsistency(address, cepLookup)
  if (!consistency.consistent)
    return {
      ...base,
      cepLookup,
      consistency,
      status: 'inconsistent',
      message: `Corrija o cadastro: ${consistency.issues.join('; ')}.`,
    }

  // 3. Geocodificação.
  const geo = await d.geocodeAddress(address)
  if (geo.status !== 'ok')
    return {
      ...base,
      cepLookup,
      consistency,
      provider: geo.provider,
      status: geo.status as GeocodeStatus,
      message: geo.message,
    }

  // 4. Escolha. Mais de um resultado com a MESMA precisão máxima é ambiguidade
  //    real (condomínio, galeria) e precisa de confirmação humana. Quando um
  //    resultado é mais preciso que os outros, ele é a escolha — e isso fica
  //    registrado.
  const ranked = [...geo.candidates].sort((a, b) => rank(b) - rank(a))
  const best = ranked[0]
  const tied = ranked.filter((c) => rank(c) === rank(best))

  if (tied.length > 1)
    return {
      ...base,
      cepLookup,
      consistency,
      provider: geo.provider,
      candidates: tied,
      status: 'multiple',
      message: `${tied.length} endereços com a mesma precisão para este CEP. Confirme qual é a localização correta.`,
    }

  const lowPrecision = best.precision !== 'rooftop'
  return {
    ...base,
    cepLookup,
    consistency,
    provider: geo.provider,
    candidates: geo.candidates,
    chosen: best,
    status: lowPrecision ? 'low_precision' : 'ok',
    message: lowPrecision
      ? `A geocodificação devolveu precisão "${best.precision}" — o ponto não é o imóvel. Confira no satélite antes de despachar equipe.`
      : geo.candidates.length > 1
        ? `Escolhido o resultado de maior precisão entre ${geo.candidates.length} correspondências.`
        : '',
  }
}

/** Ordem de preferência de precisão. Empate no topo = ambiguidade. */
function rank(c: GeocodeCandidate): number {
  const byPrecision =
    c.precision === 'rooftop' ? 4 : c.precision === 'range_interpolated' ? 3 : c.precision === 'geometric_center' ? 2 : 1
  // Resultado marcado como parcial pelo provedor perde do exato de mesma classe.
  return byPrecision * 2 - (c.partial ? 1 : 0)
}
