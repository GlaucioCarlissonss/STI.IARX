import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { markerSvg, popupHtml, type MapPoint } from './map-marker'

/**
 * O pino do mapa é o único lugar da aplicação onde a paleta é repetida em
 * hexadecimal, e a repetição não tem conserto: o SVG vira uma `data:` URI, e
 * documento de data URI não enxerga as custom properties da página.
 *
 * O que tem conserto é a DIVERGÊNCIA. A entrega 4 vai trocar a paleta; sem este
 * teste, os três pinos ficariam com a cor antiga e ninguém veria — o sintoma
 * seria um verde levemente diferente num mapa, não um erro.
 */

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')

function token(nome: string): string {
  const achado = css.match(new RegExp(`--${nome}:\\s*(#[0-9a-fA-F]{6})`))
  if (!achado) throw new Error(`token --${nome} não existe em globals.css`)
  return achado[1]!.toLowerCase()
}

const ponto = (estado: MapPoint['state_color']): MapPoint => ({
  branchId: 'b1',
  name: 'Filial',
  city: 'São Paulo',
  state: 'SP',
  lat: -23.5,
  lng: -46.6,
  count: 4,
  state_color: estado,
  precision: null,
  address: null,
  breakdown: [],
})

describe('cor do pino do mapa', () => {
  it.each([
    ['green', 'color-marker-green'],
    ['amber', 'color-marker-amber'],
    ['red', 'color-marker-red'],
  ] as const)('o pino %s usa exatamente o token %s', (estado, nome) => {
    const svg = decodeURIComponent(markerSvg(ponto(estado)).url)
    expect(svg.toLowerCase()).toContain(`fill="${token(nome)}"`)
  })

  it('os três tokens de pino são cores distintas — semáforo que repete cor não sinaliza', () => {
    const cores = ['color-marker-green', 'color-marker-amber', 'color-marker-red'].map(token)
    expect(new Set(cores).size).toBe(3)
  })
})

describe('popup do mapa', () => {
  /*
   * O popup é HTML comum no documento da página, então ele PODE usar `var()` —
   * e esta é a diferença que o teste protege. Hexadecimal reaparecendo aqui
   * significa que alguém copiou a solução do pino para um lugar onde ela não
   * era necessária, e a paleta voltou a ter duas fontes.
   */
  it('não traz nenhuma cor literal: tudo sai dos tokens', () => {
    const html = popupHtml({
      ...ponto('green'),
      address: 'Rua Um, 100',
      breakdown: [{ label: 'Enfermagem', value: 8 }],
    })
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}/)
    expect(html).toContain('var(--color-ink)')
    expect(html).toContain('var(--font-sans)')
  })

  it('escapa o que veio do banco antes de concatenar no HTML', () => {
    const html = popupHtml({ ...ponto('red'), name: '<img src=x onerror=alert(1)>' })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})
