import { afterEach, describe, expect, it, vi } from 'vitest'
import { nominatimPrecision, parseNominatimResults, resolveGeocodeProvider } from './geocode.server'

const nominatimHouse = {
  place_id: 12345,
  lat: '-23.5613000',
  lon: '-46.6565000',
  display_name: 'Avenida Paulista, 1578, Bela Vista, São Paulo, SP, 01310-200, Brasil',
  addresstype: 'house',
  class: 'building',
  type: 'yes',
}

describe('Nominatim — parser', () => {
  it('extrai coordenada e endereço formatado', () => {
    const [c] = parseNominatimResults([nominatimHouse])
    expect(c.lat).toBe(-23.5613)
    expect(c.lng).toBe(-46.6565)
    expect(c.formattedAddress).toContain('Avenida Paulista')
    expect(c.placeId).toBe('12345')
  })

  it('usa `lon`, não `lng` — o campo que o Nominatim de fato devolve', () => {
    const [c] = parseNominatimResults([{ ...nominatimHouse, lat: '-3.1', lon: '-60.0' }])
    expect(c.lat).toBe(-3.1)
    expect(c.lng).toBe(-60.0)
  })

  it('descarta resultado sem coordenada válida', () => {
    expect(parseNominatimResults([{ display_name: 'sem coordenada' }])).toEqual([])
    expect(parseNominatimResults([{ lat: '0', lon: '0' }])).toEqual([])
  })

  it('devolve vazio para payload que não é array', () => {
    expect(parseNominatimResults(null)).toEqual([])
    expect(parseNominatimResults({ error: 'Unable to geocode' })).toEqual([])
  })

  it('respeita o limite de candidatos', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...nominatimHouse,
      place_id: i,
      lat: String(-23.5 - i * 0.001),
    }))
    expect(parseNominatimResults(many)).toHaveLength(5)
  })
})

describe('Nominatim — heurística de precisão', () => {
  it('house/building vira rooftop', () => {
    expect(nominatimPrecision({ addresstype: 'house', class: 'building' })).toBe('rooftop')
  })
  it('logradouro (highway/road) vira range_interpolated', () => {
    expect(nominatimPrecision({ class: 'highway', addresstype: 'road' })).toBe('range_interpolated')
    expect(nominatimPrecision({ addresstype: 'road' })).toBe('range_interpolated')
  })
  it('bairro/cidade vira approximate', () => {
    expect(nominatimPrecision({ addresstype: 'suburb' })).toBe('approximate')
    expect(nominatimPrecision({ addresstype: 'city' })).toBe('approximate')
  })
  it('tipo desconhecido cai no meio-termo, não em rooftop', () => {
    expect(nominatimPrecision({ addresstype: 'unknown_type' })).toBe('geometric_center')
    expect(nominatimPrecision({})).toBe('geometric_center')
  })
})

describe('seleção de provedor sem exigir configuração', () => {
  const ORIGINAL_ENV = process.env
  afterEach(() => {
    process.env = ORIGINAL_ENV
    vi.unstubAllEnvs()
  })

  it('usa Nominatim quando não há chave do Google — o padrão zero-config', () => {
    vi.stubEnv('GOOGLE_MAPS_SERVER_KEY', '')
    process.env.GOOGLE_MAPS_SERVER_KEY = ''
    const provider = resolveGeocodeProvider()
    expect(provider.name).toBe('geocodeAddressNominatim')
  })

  it('prefere o Google quando a chave existe', () => {
    process.env.GOOGLE_MAPS_SERVER_KEY = 'uma-chave-de-teste'
    const provider = resolveGeocodeProvider()
    expect(provider.name).toBe('geocodeAddressGoogle')
    delete process.env.GOOGLE_MAPS_SERVER_KEY
  })
})
