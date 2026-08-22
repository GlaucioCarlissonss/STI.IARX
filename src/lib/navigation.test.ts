import { describe, expect, it } from 'vitest'
import { NAV_ITEMS, SAFE_LANDING, landingHref, visibleNav } from './navigation'
import { PERMISSION_KEYS, withAncestors } from './permissions'

/** Concede as chaves pedidas mais os ancestrais — como o banco faz. */
const conceder = (...keys: string[]) => new Set(withAncestors(keys))

describe('landingHref', () => {
  it('nunca devolve tela que a sessão não alcança', () => {
    // O laço de redirect que existia: perfil financeiro sem helpdesk pedia
    // /painel, era negado, e era mandado para /painel de novo.
    const financeiro = conceder('financeiro.centros_custo.ver', 'financeiro.contas_bancarias.ver')
    expect(landingHref(financeiro)).toBe('/financeiro/centros-de-custo')
    expect(landingHref(financeiro)).not.toBe('/painel')
  })

  it('cai em /conta quando a sessão não alcança tela nenhuma', () => {
    expect(landingHref(new Set())).toBe(SAFE_LANDING)
  })

  it('respeita a ordem do menu ao escolher o destino', () => {
    const tudo = conceder(...PERMISSION_KEYS)
    expect(landingHref(tudo)).toBe(NAV_ITEMS[0]!.href)
  })

  it('o destino escolhido é sempre um item visível no menu', () => {
    const casos = [
      new Set<string>(),
      conceder('helpdesk.painel.ver'),
      conceder('financeiro.contas_bancarias.ver'),
      conceder('mapas.geolocalizacao.ver'),
      conceder(...PERMISSION_KEYS),
    ]
    for (const granted of casos) {
      const destino = landingHref(granted)
      expect(visibleNav(granted).map((i) => i.href)).toContain(destino)
    }
  })
})

describe('NAV_ITEMS', () => {
  it('toda permissão de menu existe no catálogo — item apontando para chave morta nunca aparece', () => {
    for (const item of NAV_ITEMS) {
      if (item.permission === null) continue
      expect(PERMISSION_KEYS).toContain(item.permission)
    }
  })

  it('/conta é o único item sem permissão, e é o destino seguro', () => {
    const livres = NAV_ITEMS.filter((i) => i.permission === null)
    expect(livres.map((i) => i.href)).toEqual([SAFE_LANDING])
  })

  it('não repete href', () => {
    const hrefs = NAV_ITEMS.map((i) => i.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })
})
