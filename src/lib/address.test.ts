import { describe, expect, it } from 'vitest'
import {
  type CepLookup,
  type GeocodeReport,
  buildReportText,
  checkAddressConsistency,
  formatAddress,
  geocodeQuery,
  isValidCep,
  missingRequiredFields,
  normalizeCep,
  normalizeForCompare,
  shouldRender,
  zoomForPrecision,
} from './address'
import { parseGoogleGeocode, runGeocodePipeline } from './geocode.server'

/* Endereço público e verificável, usado só para exercitar o fluxo. */
const paulista = {
  street: 'Avenida Paulista',
  streetNumber: '1578',
  district: 'Bela Vista',
  postalCode: '01310-200',
  city: 'São Paulo',
  state: 'SP',
  complement: null,
}

const cepPaulista: CepLookup = {
  postalCode: '01310-200',
  street: 'Avenida Paulista',
  district: 'Bela Vista',
  city: 'São Paulo',
  state: 'SP',
}

const googleOk = (locationType = 'ROOFTOP') => ({
  status: 'OK',
  results: [
    {
      formatted_address: 'Av. Paulista, 1578 - Bela Vista, São Paulo - SP, 01310-200, Brasil',
      place_id: 'ChIJ-abc',
      geometry: { location: { lat: -23.5613, lng: -46.6565 }, location_type: locationType },
    },
  ],
})

const deps = (over: Partial<Parameters<typeof runGeocodePipeline>[1]> = {}) => ({
  now: () => new Date('2026-08-14T12:00:00.000Z'),
  lookupCep: async () => cepPaulista,
  geocodeAddress: async () => ({
    status: 'ok' as const,
    candidates: parseGoogleGeocode(googleOk()),
    provider: 'google-geocoding',
    message: '',
  }),
  ...over,
})

describe('CEP', () => {
  it('normaliza com e sem máscara', () => {
    expect(normalizeCep('01310200')).toBe('01310-200')
    expect(normalizeCep('01310-200')).toBe('01310-200')
    expect(normalizeCep(' 01310.200 ')).toBe('01310-200')
  })

  it('rejeita CEP com número errado de dígitos', () => {
    expect(normalizeCep('0131020')).toBeNull()
    expect(normalizeCep('013102000')).toBeNull()
    expect(isValidCep('abc')).toBe(false)
    expect(isValidCep(null)).toBe(false)
  })
})

describe('campos obrigatórios', () => {
  it('aceita o endereço completo', () => {
    expect(missingRequiredFields(paulista)).toEqual([])
  })

  it('lista cada ausência pelo nome que o operador vê', () => {
    expect(missingRequiredFields({ ...paulista, streetNumber: '' })).toEqual(['número'])
    expect(
      missingRequiredFields({ street: null, streetNumber: null, district: null, postalCode: null }),
    ).toEqual(['logradouro', 'número', 'bairro', 'CEP'])
  })

  it('trata campo só com espaço como ausente', () => {
    expect(missingRequiredFields({ ...paulista, district: '   ' })).toEqual(['bairro'])
  })
})

describe('formatação', () => {
  it('monta o endereço no padrão dos Correios', () => {
    expect(formatAddress(paulista)).toBe(
      'Avenida Paulista, 1578, Bela Vista, São Paulo/SP, 01310-200',
    )
  })

  it('inclui o complemento quando informado', () => {
    expect(formatAddress({ ...paulista, complement: 'Sala 402' })).toContain('1578 - Sala 402')
  })

  it('deixa o complemento fora da consulta de geocodificação', () => {
    const q = geocodeQuery({ ...paulista, complement: 'Sala 402' })
    expect(q).not.toContain('Sala 402')
    expect(q).toContain('Avenida Paulista, 1578')
    expect(q.endsWith('Brasil')).toBe(true)
  })
})

describe('consistência CEP × endereço', () => {
  it('não acusa divergência por abreviação ou acento', () => {
    const r = checkAddressConsistency(
      { ...paulista, street: 'AV. PAULISTA', city: 'Sao Paulo' },
      cepPaulista,
    )
    expect(r.consistent).toBe(true)
  })

  it('acusa UF divergente', () => {
    const r = checkAddressConsistency({ ...paulista, state: 'RJ' }, cepPaulista)
    expect(r.consistent).toBe(false)
    expect(r.issues[0]).toContain('UF cadastrada "RJ"')
  })

  it('acusa cidade divergente — o caso do CEP de outra praça', () => {
    const r = checkAddressConsistency({ ...paulista, city: 'Campinas' }, cepPaulista)
    expect(r.consistent).toBe(false)
    expect(r.issues.some((i) => i.includes('Campinas'))).toBe(true)
  })

  it('acusa logradouro divergente', () => {
    const r = checkAddressConsistency({ ...paulista, street: 'Rua Augusta' }, cepPaulista)
    expect(r.consistent).toBe(false)
  })

  it('sem consulta de CEP não inventa veredito', () => {
    expect(checkAddressConsistency(paulista, null)).toEqual({ consistent: true, issues: [] })
  })

  it('normaliza tipos de logradouro abreviados', () => {
    expect(normalizeForCompare('R. das Flores')).toBe('rua das flores')
    expect(normalizeForCompare('Pç. da Sé')).toBe('praca da se')
    expect(normalizeForCompare('Rod. Anhanguera')).toBe('rodovia anhanguera')
  })
})

describe('precisão e zoom', () => {
  it('mantém o zoom na faixa exigida (16-18)', () => {
    for (const p of ['rooftop', 'range_interpolated', 'geometric_center', 'approximate', 'manual'] as const) {
      const z = zoomForPrecision(p)
      expect(z).toBeGreaterThanOrEqual(16)
      expect(z).toBeLessThanOrEqual(18)
    }
    expect(zoomForPrecision('rooftop')).toBe(18)
    expect(zoomForPrecision('approximate')).toBe(16)
  })

  it('só renderiza mapa em estado válido', () => {
    expect(shouldRender('ok')).toBe(true)
    expect(shouldRender('low_precision')).toBe(true)
    for (const s of ['missing_fields', 'inconsistent', 'multiple', 'not_found', 'service_unavailable'] as const)
      expect(shouldRender(s)).toBe(false)
  })
})

describe('parser da Geocoding API', () => {
  it('extrai coordenada, precisão e place_id', () => {
    const [c] = parseGoogleGeocode(googleOk())
    expect(c.lat).toBe(-23.5613)
    expect(c.precision).toBe('rooftop')
    expect(c.placeId).toBe('ChIJ-abc')
  })

  it('descarta resultado sem coordenada utilizável', () => {
    expect(
      parseGoogleGeocode({ status: 'OK', results: [{ geometry: { location: { lat: 0, lng: 0 } } }] }),
    ).toEqual([])
  })

  it('devolve vazio para payload inesperado', () => {
    expect(parseGoogleGeocode(null)).toEqual([])
    expect(parseGoogleGeocode({ status: 'ZERO_RESULTS' })).toEqual([])
  })
})

describe('fluxo de geolocalização', () => {
  it('caminho feliz: rooftop, coordenada e provedor registrados', async () => {
    const r = await runGeocodePipeline(paulista, deps())
    expect(r.status).toBe('ok')
    expect(r.chosen?.precision).toBe('rooftop')
    expect(r.chosen?.lat).toBe(-23.5613)
    expect(r.provider).toBe('google-geocoding')
  })

  it('[CAMPO AUSENTE] interrompe antes de gastar cota', async () => {
    let called = false
    const r = await runGeocodePipeline(
      { ...paulista, streetNumber: null },
      deps({
        geocodeAddress: async () => {
          called = true
          return { status: 'ok' as const, candidates: [], provider: 'x', message: '' }
        },
      }),
    )
    expect(r.status).toBe('missing_fields')
    expect(r.chosen).toBeNull()
    expect(called).toBe(false)
  })

  it('CEP com menos de 8 dígitos é campo ausente, não endereço inexistente', async () => {
    const r = await runGeocodePipeline({ ...paulista, postalCode: '0131' }, deps())
    expect(r.status).toBe('missing_fields')
    expect(r.missing).toEqual(['CEP válido (8 dígitos)'])
  })

  it('[INCONSISTÊNCIA DE ENDEREÇO] não geocodifica', async () => {
    let called = false
    const r = await runGeocodePipeline(
      { ...paulista, city: 'Recife', state: 'PE' },
      deps({
        geocodeAddress: async () => {
          called = true
          return { status: 'ok' as const, candidates: [], provider: 'x', message: '' }
        },
      }),
    )
    expect(r.status).toBe('inconsistent')
    expect(called).toBe(false)
    expect(r.consistency.issues.length).toBeGreaterThan(0)
  })

  it('[ENDEREÇO NÃO ENCONTRADO] não produz coordenada', async () => {
    const r = await runGeocodePipeline(
      paulista,
      deps({
        geocodeAddress: async () => ({
          status: 'not_found' as const,
          candidates: [],
          provider: 'google-geocoding',
          message: 'Nenhuma correspondência.',
        }),
      }),
    )
    expect(r.status).toBe('not_found')
    expect(r.chosen).toBeNull()
    expect(shouldRender(r.status)).toBe(false)
  })

  it('[MÚLTIPLAS CORRESPONDÊNCIAS] quando há empate na maior precisão', async () => {
    const r = await runGeocodePipeline(
      paulista,
      deps({
        geocodeAddress: async () => ({
          status: 'ok' as const,
          candidates: parseGoogleGeocode({
            status: 'OK',
            results: [
              { formatted_address: 'Bloco A', geometry: { location: { lat: -23.56, lng: -46.65 }, location_type: 'ROOFTOP' } },
              { formatted_address: 'Bloco B', geometry: { location: { lat: -23.561, lng: -46.651 }, location_type: 'ROOFTOP' } },
            ],
          }),
          provider: 'google-geocoding',
          message: '',
        }),
      }),
    )
    expect(r.status).toBe('multiple')
    expect(r.candidates).toHaveLength(2)
    expect(r.chosen).toBeNull()
  })

  it('desempata pela precisão quando ela difere, e registra a escolha', async () => {
    const r = await runGeocodePipeline(
      paulista,
      deps({
        geocodeAddress: async () => ({
          status: 'ok' as const,
          candidates: parseGoogleGeocode({
            status: 'OK',
            results: [
              { formatted_address: 'Centro da rua', geometry: { location: { lat: -23.5, lng: -46.6 }, location_type: 'GEOMETRIC_CENTER' } },
              { formatted_address: 'O imóvel', geometry: { location: { lat: -23.5613, lng: -46.6565 }, location_type: 'ROOFTOP' } },
            ],
          }),
          provider: 'google-geocoding',
          message: '',
        }),
      }),
    )
    expect(r.status).toBe('ok')
    expect(r.chosen?.formattedAddress).toBe('O imóvel')
    expect(r.message).toContain('maior precisão')
  })

  it('[BAIXA PRECISÃO] renderiza, mas avisa', async () => {
    const r = await runGeocodePipeline(
      paulista,
      deps({
        geocodeAddress: async () => ({
          status: 'ok' as const,
          candidates: parseGoogleGeocode(googleOk('APPROXIMATE')),
          provider: 'google-geocoding',
          message: '',
        }),
      }),
    )
    expect(r.status).toBe('low_precision')
    expect(shouldRender(r.status)).toBe(true)
    expect(zoomForPrecision(r.chosen!.precision)).toBe(16)
  })

  it('[SERVIÇO INDISPONÍVEL] lista os requisitos mínimos', async () => {
    const r = await runGeocodePipeline(
      paulista,
      deps({
        geocodeAddress: async () => ({
          status: 'service_unavailable' as const,
          candidates: [],
          provider: null,
          message: 'GOOGLE_MAPS_SERVER_KEY ausente.',
        }),
      }),
    )
    expect(r.status).toBe('service_unavailable')
    expect(r.chosen).toBeNull()
    expect(r.requirements.length).toBeGreaterThanOrEqual(4)
  })

  it('consulta de CEP fora do ar não vira "consistente" silencioso', async () => {
    const r = await runGeocodePipeline(paulista, deps({ lookupCep: async () => null }))
    expect(r.cepLookup).toBeNull()
    expect(buildReportText(r)).toContain('NÃO VERIFICADA')
  })

  it('não interpola coordenada em nenhum estado de falha', async () => {
    const failures = [
      { ...paulista, street: null },
      { ...paulista, postalCode: null },
      { ...paulista, city: 'Recife', state: 'PE' },
    ]
    for (const addr of failures) {
      const r = await runGeocodePipeline(addr, deps())
      expect(r.chosen).toBeNull()
      expect(r.candidates).toEqual([])
    }
  })
})

describe('relatório técnico', () => {
  const report = async (over = {}): Promise<GeocodeReport> =>
    runGeocodePipeline(paulista, deps(over))

  it('traz as cinco seções na ordem acordada', async () => {
    const text = buildReportText(await report())
    const order = ['ENDERECO DE ENTRADA:', 'VALIDACAO:', 'GEOCODIFICACAO:', 'RENDERIZACAO:', 'LOG:']
    const positions = order.map((s) => text.indexOf(s))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('no caminho feliz declara satélite, zoom e status', async () => {
    const text = buildReportText(await report())
    expect(text).toContain('- Campos obrigatórios: COMPLETO')
    expect(text).toContain('- Consistência CEP/Logradouro: CONSISTENTE')
    expect(text).toContain('- Mapa: renderizado em modo satélite (google-geocoding)')
    expect(text).toContain('- Zoom: 18')
    expect(text).toContain('- Alternância satélite/mapa: sim')
    expect(text).toContain('- Status: SUCESSO')
    expect(text).toContain('- Serviço utilizado: google-geocoding')
  })

  it('marca campo ausente e não declara mapa renderizado', async () => {
    const text = buildReportText(await runGeocodePipeline({ ...paulista, district: null }, deps()))
    expect(text).toContain('- Bairro: [AUSENTE]')
    expect(text).toContain('INCOMPLETO — ausentes: bairro')
    expect(text).toContain('- Mapa: NÃO renderizado')
    expect(text).toContain('[CAMPO AUSENTE]')
  })

  it('lista os candidatos quando há múltiplas correspondências', async () => {
    const text = buildReportText(
      await report({
        geocodeAddress: async () => ({
          status: 'ok' as const,
          candidates: parseGoogleGeocode({
            status: 'OK',
            results: [
              { formatted_address: 'Torre 1', geometry: { location: { lat: -23.56, lng: -46.65 }, location_type: 'ROOFTOP' } },
              { formatted_address: 'Torre 2', geometry: { location: { lat: -23.561, lng: -46.651 }, location_type: 'ROOFTOP' } },
            ],
          }),
          provider: 'google-geocoding',
          message: '',
        }),
      }),
    )
    expect(text).toContain('Correspondências múltiplas: sim (2)')
    expect(text).toContain('1. Torre 1')
    expect(text).toContain('2. Torre 2')
  })

  it('imprime os requisitos mínimos quando o serviço está indisponível', async () => {
    const text = buildReportText(
      await report({
        geocodeAddress: async () => ({
          status: 'service_unavailable' as const,
          candidates: [],
          provider: null,
          message: 'chave ausente',
        }),
      }),
    )
    expect(text).toContain('REQUISITOS MINIMOS:')
    expect(text).toContain('provedor de tiles')
    expect(text).toContain('- Serviço utilizado: não disponível')
  })
})
