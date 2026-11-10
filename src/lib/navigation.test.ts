import { describe, expect, it } from 'vitest'
import {
  NAV_GROUPS,
  NAV_ITEMS,
  NAV_LINKS,
  PORTAL,
  SAFE_LANDING,
  landingHref,
  visibleNav,
  visibleNavGroups,
} from './navigation'
import { PERMISSION_KEYS, withAncestors } from './permissions'
import type { Esfera } from './esferas'

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
    // Integrações tem 3 itens "em breve" e 1 real. Sem o real, o grupo todo sai.
    const semIntegracoes = conceder('helpdesk.tickets.ver')
    const grupos = visibleNavGroups(semIntegracoes)
    expect(grupos.map((g) => g.label)).not.toContain('Integrações')
  })

  it('item previsto aparece no grupo que já apareceu por mérito próprio', () => {
    const comHub = conceder('integracoes.hub.ver')
    const integracoes = visibleNavGroups(comHub).find((g) => g.label === 'Integrações')
    expect(integracoes).toBeDefined()
    expect(integracoes!.items.filter((i) => i.soon).length).toBe(3)
  })

  it('quem não alcança nada ainda vê a Visão geral, o portal e a própria conta', () => {
    /*
     * As três não exigem permissão de módulo, e as três são necessárias: sem a
     * Visão geral e sem o portal, uma sessão recém-criada veria um menu com um
     * item só — a tela de trocar a senha —, o que parece um sistema quebrado.
     *
     * O portal entrou na 0033 e é o destino de quem só pede. Ele não acrescenta
     * acesso nenhum: o que a página mostra já era alcançável.
     */
    const hrefs = visibleNavGroups(new Set()).flatMap((g) => g.items.map((i) => i.href))
    expect(hrefs).toEqual(['/painel', PORTAL, SAFE_LANDING])
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
      'Orçamento de TI',
    ])
  })
})

describe('NAV_GROUPS', () => {
  it('o teto de grupos é por esfera: 8 com uma, 9 com as duas', () => {
    /*
     * O teto não é sobre a declaração, é sobre o que uma pessoa vê de uma vez.
     * Sete era o limite enquanto a barra vivia expandida; com os grupos
     * recolhíveis subiu para oito.
     *
     * A empresa com AS DUAS esferas é o caso excepcional — ela faz dois
     * negócios — e chega a nove. É exatamente para ela que existe o seletor de
     * foco no cabeçalho, que devolve o menu para seis ou sete. Contar a
     * declaração, e não o menu de cada esfera, passaria a reprovar a cada módulo
     * novo mesmo que nenhum menu real tivesse crescido.
     */
    const tudo = conceder(...PERMISSION_KEYS)
    const quantos = (esferas: Esfera[]) =>
      visibleNavGroups(tudo, esferas).filter((g) => g.label !== null).length

    expect(quantos(['management'])).toBeLessThanOrEqual(8)
    expect(quantos(['rental'])).toBeLessThanOrEqual(8)
    expect(quantos(['management', 'rental'])).toBeLessThanOrEqual(9)
  })

  it('todo grupo com rótulo tem pelo menos dois itens', () => {
    /*
     * Um grupo de um item só é um cabeçalho que não agrupa nada — e, com
     * acordeão, é um clique para revelar uma linha. Quando sobra um item só,
     * ele pertence a outro grupo ou ao topo, fora de grupo.
     */
    for (const grupo of NAV_GROUPS) {
      if (grupo.label === null) continue
      expect(grupo.items.length, `"${grupo.label}" tem um item só`).toBeGreaterThanOrEqual(2)
    }
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

  it('os 7 assuntos de integração pedidos continuam cobertos pelo menu', () => {
    /*
     * O pedido original (docs/01) listava sete assuntos de integração, e por um
     * tempo os sete eram sete itens "em breve" no grupo Integrações.
     *
     * Três deles — N8N, WhatsApp e Telegram — FORAM ENTREGUES na migração 0034,
     * e não como integração: como CANAL DE CONVERSA, em `Atendimento →
     * Conversas`. Eles saíram do grupo Integrações porque anunciar como futuro o
     * que já existe é pior que não anunciar, e porque aquele grupo trata de
     * mapear um registro externo para um chamado — outro assunto.
     *
     * O Telegram não tem adaptador próprio e nem precisa: ele entra pelo canal
     * genérico do N8N, que é o motivo de aquele canal existir.
     *
     * Este teste guarda a cobertura do pedido, não o formato dela: cada assunto
     * tem de estar em algum lugar do menu — entregue ou anunciado.
     */
    const integracoes = NAV_GROUPS.find((g) => g.label === 'Integrações')!
    /*
     * Cinco, e não quatro: `Sugestões de IA` veio de Administração para cá
     * depois de a página do próprio Milvus sobre ChatGPT dizer que o token vai
     * "na área de integrações". Este teste guarda a COBERTURA dos assuntos
     * pedidos, não o tamanho do grupo — por isso o número vem com motivo
     * escrito, em vez de ser ajustado em silêncio.
     */
    expect(integracoes.items).toHaveLength(5)
    expect(
      integracoes.items.some((i) => i.href === '/ia'),
      'a configuração de IA é uma integração: ela fala com um provedor de fora',
    ).toBe(true)
    for (const esperado of ['Bancos de dados', 'Pagamento', 'Recebimento']) {
      expect(
        integracoes.items.some((i) => i.label.includes(esperado)),
        `falta o subgrupo ${esperado}`,
      ).toBe(true)
    }

    const conversas = NAV_ITEMS.find((i) => i.href === '/conversas')
    expect(conversas, 'N8N, WhatsApp e Telegram foram entregues como Conversas').toBeDefined()
    expect(conversas!.permission).toBe('canais.conversas.ver')
  })
})

describe('a esfera decide o que existe no menu', () => {
  const tudo = conceder(...PERMISSION_KEYS)
  const rotulos = (esferas: Esfera[]) =>
    visibleNavGroups(tudo, esferas)
      .map((g) => g.label)
      .filter((l): l is string => l !== null)

  it('gestão não vê o grupo de locação', () => {
    expect(rotulos(['management'])).not.toContain('Locação')
  })

  it('locação não vê inventário nem gestão — são telas de governança', () => {
    const vistos = rotulos(['rental'])
    expect(vistos).toContain('Locação')
    expect(vistos).not.toContain('Inventário e monitoramento')
    expect(vistos).not.toContain('Gestão')
  })

  it('quem tem as duas vê a união, sem repetir grupo', () => {
    const duas = rotulos(['management', 'rental'])
    expect(duas).toEqual([...new Set(duas)])
    for (const g of [...rotulos(['management']), ...rotulos(['rental'])]) {
      expect(duas).toContain(g)
    }
  })

  it('os grupos comuns aparecem nas duas — financeiro não é de um negócio só', () => {
    for (const esfera of ['management', 'rental'] as Esfera[]) {
      expect(rotulos([esfera])).toContain('Financeiro')
      expect(rotulos([esfera])).toContain('Atendimento')
    }
  })

  it('quem NÃO administra o ambiente não recebe seis promessas', () => {
    // O solicitante de uma empresa de locação ainda não tem nada para abrir no
    // módulo. Mostrar o roteiro dele seria o "menu de promessas" que a regra
    // geral evita.
    const solicitante = conceder('helpdesk.tickets.criar')
    const rotulosDele = visibleNavGroups(solicitante, ['rental']).map((g) => g.label)
    expect(rotulosDele).not.toContain('Locação')
  })

  it('o grupo de locação aparece só com telas previstas, porque a esfera foi LIGADA', () => {
    /*
     * A regra geral manda sumir o grupo sem item alcançável — ela existe para
     * não anunciar módulo a quem não tem acesso. Um grupo de esfera é outro
     * caso: ele só chega aqui porque alguém ligou aquela esfera de propósito, e
     * esconder tudo faria parecer que ligar não surtiu efeito.
     */
    const locacao = visibleNavGroups(tudo, ['rental']).find((g) => g.label === 'Locação')
    expect(locacao).toBeDefined()
    expect(locacao!.items.length).toBeGreaterThan(0)
    expect(locacao!.items.every((i) => i.soon)).toBe(true)
  })

  it('o destino pós-login respeita a esfera', () => {
    // Mandar para uma tela que o menu daquela empresa não mostra é o mesmo laço
    // de redirect que `landingHref` existe para quebrar.
    const soLocacao = conceder('inventario.ativos.ver', 'helpdesk.tickets.ver')
    const destino = landingHref(soLocacao, ['rental'])
    expect(visibleNav(soLocacao, ['rental']).map((i) => i.href)).toContain(destino)
    expect(destino).not.toBe('/inventario')
  })
})
