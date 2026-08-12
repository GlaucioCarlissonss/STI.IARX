import { describe, expect, it } from 'vitest'
import {
  buildGeocodeQuery,
  formatCoordinates,
  googleDirectionsUrl,
  googleMapsUrl,
  isPreciseEnough,
  isValidCoordinates,
  mapGoogleLocationType,
  parseCoordinates,
  roundCoordinates,
} from './maps'

describe('parseCoordinates', () => {
  it('lê a URL que se copia da barra do Google Maps', () => {
    expect(
      parseCoordinates('https://www.google.com/maps/@-23.550520,-46.633308,17z'),
    ).toEqual({ lat: -23.55052, lng: -46.633308 })
  })

  it('lê URL de lugar com nome antes das coordenadas', () => {
    const url =
      'https://www.google.com/maps/place/Hospital/@-8.047562,-34.877,18z/data=!3m1!4b1'
    expect(parseCoordinates(url)).toEqual({ lat: -8.047562, lng: -34.877 })
  })

  it('lê link de compartilhamento com ?q=', () => {
    expect(parseCoordinates('https://maps.google.com/?q=-3.119028,-60.021731')).toEqual({
      lat: -3.119028,
      lng: -60.021731,
    })
  })

  it('lê ?q= com vírgula escapada (%2C)', () => {
    expect(
      parseCoordinates('https://www.google.com/maps?q=-22.909938%2C-47.062633'),
    ).toEqual({ lat: -22.909938, lng: -47.062633 })
  })

  it('lê o par !3d!4d das URLs de lugar', () => {
    expect(parseCoordinates('.../data=!4m5!3m4!1s0x0!8m2!3d-19.916681!4d-43.934493')).toEqual({
      lat: -19.916681,
      lng: -43.934493,
    })
  })

  it('aceita o par solto digitado à mão', () => {
    expect(parseCoordinates('-23.550520, -46.633308')).toEqual({ lat: -23.55052, lng: -46.633308 })
    expect(parseCoordinates('-23.55; -46.63')).toEqual({ lat: -23.55, lng: -46.63 })
  })

  it('rejeita entrada sem coordenada', () => {
    expect(parseCoordinates('')).toBeNull()
    expect(parseCoordinates('Rua das Flores, 100')).toBeNull()
    expect(parseCoordinates('https://www.google.com/maps')).toBeNull()
  })

  it('rejeita coordenada fora de faixa', () => {
    expect(parseCoordinates('-91.0, -46.6')).toBeNull()
    expect(parseCoordinates('-23.5, 181.0')).toBeNull()
  })

  it('rejeita 0,0 — quase sempre é campo vazio virando zero', () => {
    expect(parseCoordinates('0, 0')).toBeNull()
    expect(isValidCoordinates(0, 0)).toBe(false)
  })
})

describe('precisão', () => {
  it('traduz location_type do Google', () => {
    expect(mapGoogleLocationType('ROOFTOP')).toBe('rooftop')
    expect(mapGoogleLocationType('RANGE_INTERPOLATED')).toBe('range_interpolated')
    expect(mapGoogleLocationType('GEOMETRIC_CENTER')).toBe('geometric_center')
    expect(mapGoogleLocationType('APPROXIMATE')).toBe('approximate')
  })

  it('trata tipo desconhecido ou ausente como aproximado, nunca como exato', () => {
    expect(mapGoogleLocationType(undefined)).toBe('approximate')
    expect(mapGoogleLocationType('ALGO_NOVO')).toBe('approximate')
  })

  it('só considera confiável o que serve para achar o local em campo', () => {
    expect(isPreciseEnough('rooftop')).toBe(true)
    expect(isPreciseEnough('range_interpolated')).toBe(true)
    expect(isPreciseEnough('manual')).toBe(true)
    // Centro da cidade não serve para despachar técnico.
    expect(isPreciseEnough('approximate')).toBe(false)
    expect(isPreciseEnough('geometric_center')).toBe(false)
    expect(isPreciseEnough(null)).toBe(false)
  })
})

describe('formatação e links', () => {
  it('arredonda para 6 casas', () => {
    expect(roundCoordinates({ lat: -23.5505200123, lng: -46.6333089876 })).toEqual({
      lat: -23.55052,
      lng: -46.633309,
    })
  })

  it('formata com 6 casas fixas', () => {
    expect(formatCoordinates(-23.55052, -46.633308)).toBe('-23.550520, -46.633308')
  })

  it('monta link do Google Maps para o ponto exato', () => {
    const url = googleMapsUrl(-23.55052, -46.633308)
    expect(url).toContain('google.com/maps/search/?api=1')
    expect(url).toContain('-23.55052,-46.633308')
  })

  it('inclui rótulo escapado quando informado', () => {
    expect(googleMapsUrl(-8.047562, -34.877, 'Filial Recife')).toContain('Filial%20Recife')
  })

  it('monta link de rota até a filial', () => {
    expect(googleDirectionsUrl(-3.119028, -60.021731)).toContain('destination=-3.119028,-60.021731')
  })

  it('monta a consulta de geocodificação e ignora campos vazios', () => {
    expect(
      buildGeocodeQuery({
        addressLine: 'Av. Paulista, 1000',
        district: '',
        city: 'São Paulo',
        state: 'SP',
        postalCode: null,
      }),
    ).toBe('Av. Paulista, 1000, São Paulo, SP, Brasil')
  })
})
