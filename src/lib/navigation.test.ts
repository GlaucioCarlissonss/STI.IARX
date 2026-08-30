import { describe, expect, it } from 'vitest'
import {
  NAV_GROUPS,
  NAV_ITEMS,
  NAV_LINKS,
  SAFE_LANDING,
  landingHref,
  visibleNav,
  visibleNavGroups,
} from './navigation'
import { PERMISSION_KEYS, withAncestors } from './permissions'

/** Concede as chaves pedidas mais os ancestrais — como o banco faz. */
const conceder = (...keys: string[]) => new Set(withAncestors(keys))

describe('landingHref', () => {
  it('nunca devolve tela que a sessão não alcança', () => {
    // O laço que existia: perfil financeiro sem helpdesk pedia /painel, era
    // negado, e era mandado para /painel de novo. Hoje /painel não exige
    // permissão e cada bloco dela é que exige — então ele é destino seguro.
    const financeiro = conceder('financeiro.titulos_pagar.ver')
    const destino = landingHref(financeiro)
    expect(visibleNav(financeiro).map((i) => i.href)).toContain(destino)
  })

  it('a Visão geral é o destino de todo mundo, inclusive de quem não tem módulo', () => {
    expect(landingHref(new Set())).toBe('/painel')
    expect(landingHref(conceder(...PERMISSION_KEYS))).toBe('/painel')
  })

  it('nunca escolhe /conta como primeira opção', () => {
    // Mandar quem tem acesso a módulos para a tela de trocar senha seria pior
    // que não redirecionar.
    for (const granted of [new Set<string>(), conceder('helpdesk.tickets.ver')]) {
      expect(landingHref(granted)).not.toBe(SAFE_LANDING)
    }
  })

  it('o destino é sempre um item visível e navegável', () => {
    const casos = [
      new Set<string>(),
      conceder('helpdesk.tickets.ver'),
      conceder('financeiro.contas_bancarias.ver'),
      conceder(...PERMISSION_KEYS),
    ]
    for (const granted of casos) {
      const destino = landingHref(granted)
      const item = NAV_LINKS.find((i) => i.href === destino)
      expect(item, `${destino} tem de ser um item navegável`).toBeDefined()
      expect(item!.soon).toBeUndefined()
    }
  })
})

describe('visibleNavGroups', () => {
  it('grupo sem item alcançável desaparece inteiro, cabeçalho incluído', () => {
    const soFinanceiro = conceder(
      'financeiro.titulos_pagar.ver',
      'financeiro.contas_bancarias.ver',
    )
    const rotulos = visibleNavGroups(soFinanceiro).map((g) => g.label)
    expect(rotulos).toContain('Financeiro')
    // Cabeçalho sozinho anuncia um módulo sem dar acesso a ele.
    expect(rotulos).not.toContain('Atendimento')
    expect(rotulos).not.toContain('Administração')
  })

  it('item previsto NÃO faz o grupo aparecer sozinho', () => {
    // Integrações tem 6 itens "em breve" e 1 real. Sem o real, o grupo todo sai.
    const semIntegracoes = conceder('helpdesk.tickets.ver')
    const grupos = visibleNavGroups(semIntegracoes)
    expect(grupos.map((g) => g.label)).not.toContain('Integrações')
  })

  it('item previsto aparece no grupo que já apareceu por mérito próprio', () => {
    const comHub = conceder('integracoes.hub.ver')
    const integracoes = visibleNavGroups(comHub).find((g) => g.label === 'Integrações')
    expect(integracoes).toBeDefined()
    expect(integracoes!.items.filter((i) => i.soon).length).toBe(6)
  })

  it('quem não alcança nada ainda vê a Visão geral e a própria conta', () => {
    const hrefs = visibleNavGroups(new Set()).flatMap((g) => g.items.map((i) => i.href))
    expect(hrefs).toEqual(['/painel', SAFE_LANDING])
  })

  it('preserva a ordem declarada dos itens dentro do grupo', () => {
    const tudo = conceder(...PERMISSION_KEYS)
    const financeiro = visibleNavGroups(tudo).find((g) => g.label === 'Financeiro')!
    expect(financeiro.items.map((i) => i.label)).toEqual([
      'Títulos a pagar',
      'Títulos a receber',
      'Contas bancárias',
      'Centros de custo',
      'Fluxo de caixa',
    ])
  })
})

describe('NAV_GROUPS', () => {
  it('no máximo 7 grupos com rótulo — é o teto de uma barra que se lê de relance', () => {
    expect(NAV_GROUPS.filter((g) => g.label !== null).length).toBeLessThanOrEqual(7)
  })

  it('toda permissão de menu existe no catálogo', () => {
    for (const item of NAV_ITEMS) {
      if (item.permission === null) continue
      expect(PERMISSION_KEYS, `${item.label} aponta para chave inexistente`).toContain(
        item.permission,
      )
    }
  })

  it('item previsto não tem href nem permissão, e tem explicação', () => {
    for (const item of NAV_ITEMS.filter((i) => i.soon)) {
      expect(item.href).toBeNull()
      // Chave para tela que não existe é configuração morta.
      expect(item.permission).toBeNull()
      expect(item.hint, `${item.label} precisa explicar o que vai fazer`).toBeTruthy()
    }
  })

  it('não repete href entre os itens navegáveis', () => {
    const hrefs = NAV_LINKS.map((i) => i.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it('não repete rótulo — dois itens com o mesmo nome é impossível de distinguir', () => {
    const rotulos = NAV_ITEMS.map((i) => i.label)
    expect(new Set(rotulos).size).toBe(rotulos.length)
  })

  it('/conta é o destino seguro e não exige permissão', () => {
    const conta = NAV_ITEMS.find((i) => i.href === SAFE_LANDING)
    expect(conta).toBeDefined()
    expect(conta!.permission).toBeNull()
  })

  it('os 7 subgrupos de integração pedidos estão no menu', () => {
    const integracoes = NAV_GROUPS.find((g) => g.label === 'Integrações')!
    expect(integracoes.items).toHaveLength(7)
    for (const esperado of ['N8N', 'WhatsApp', 'Telegram', 'Bancos de dados', 'Pagamento', 'Recebimento']) {
      expect(
        integracoes.items.some((i) => i.label.includes(esperado)),
        `falta o subgrupo ${esperado}`,
      ).toBe(true)
    }
  })
})
