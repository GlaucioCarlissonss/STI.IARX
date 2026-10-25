import type { Route } from 'next'
import { can } from './permissions'

/**
 * A arquitetura de informação do menu, em um lugar só.
 *
 * Estava inline em `src/app/(app)/layout.tsx`, e por isso `requireScreen()` não
 * tinha como saber para onde mandar quem foi negado — mandava sempre para
 * `/painel`. Isso produzia um laço: quem não tem `helpdesk.painel.ver` pede
 * `/painel`, é negado, e é redirecionado para `/painel` outra vez. Não é
 * hipótese: os perfis financeiros do sistema não recebem o módulo de helpdesk,
 * então um Aprovador Financeiro nunca conseguiria entrar.
 *
 * ---------------------------------------------------------------------------
 * AS DECISÕES DE AGRUPAMENTO E NOMENCLATURA
 * ---------------------------------------------------------------------------
 * A lista era plana com 16 itens. Lista plana funciona até uns 7 itens; passando
 * disso a pessoa lê o menu inteiro toda vez para achar um item, porque não há
 * onde a vista descansar. Com 25 itens previstos, agrupar deixou de ser estética.
 *
 * **Agrupamento por trabalho, não por tabela.** Os grupos respondem "o que eu
 * vim fazer aqui": atender, cobrar e pagar, cuidar do parque, cadastrar,
 * conectar, administrar. Um menu espelhando o modelo de dados obrigaria quem usa
 * a conhecer o modelo de dados.
 *
 * **Sete grupos.** É o teto prático de uma barra lateral que se lê de relance.
 * Ordem: o que se usa todo dia no topo, configuração no fim. `Visão geral` fica
 * fora de grupo porque é destino, não categoria.
 *
 * **"Títulos a pagar", não "Contas a pagar".** No mesmo grupo existe
 * `Contas bancárias`. A palavra "contas" significando duas coisas diferentes a
 * dois itens de distância é fonte de erro de leitura, e "título" é o termo que o
 * financeiro brasileiro já usa. Onde havia escolha, ganhou a palavra que não
 * colide.
 *
 * **Nada de rótulo técnico.** `SLA e prazos` em vez de `SLA`, porque metade de
 * quem abre a tela não sabe o que é a sigla; `Mapa das filiais` em vez de
 * `Mapas`, que não dizia o mapa de quê.
 *
 * **A ordem dentro do grupo não é a ordem em que o módulo foi construído.** No
 * Financeiro os títulos vêm antes dos centros de custo: título se lança todo dia,
 * centro de custo se cadastra uma vez. Foi uma escolha deliberada sobre a ordem
 * pedida, e é a única divergência.
 */

/** Item de menu. `href: null` = previsto, sem tela ainda. */
export interface NavItem {
  /* `Route` para o redirect de `requireScreen()` não precisar de cast: rota
     inexistente aqui é erro de build, não 404 em produção. */
  href: Route | null
  label: string
  /** Permissão de CONSULTA da tela. `null` = visível para qualquer sessão. */
  permission: string | null
  /**
   * Item previsto e ainda sem tela.
   *
   * Aparece desabilitado, com selo. NÃO tem permissão e NÃO faz o grupo
   * aparecer sozinho — senão um menu inteiro de promessas surgiria para quem não
   * tem acesso a nada daquele grupo. Também não recebe chave no catálogo:
   * permissão que não governa tela é configuração morta, e foi o defeito
   * corrigido em seis chaves nesta mesma linha de trabalho.
   */
  soon?: true
  /** Explica o que o item vai fazer, no `title` do elemento desabilitado. */
  hint?: string
}

export interface NavGroup {
  /** `null` = itens soltos no topo, sem cabeçalho de grupo. */
  label: string | null
  items: readonly NavItem[]
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: null,
    items: [
      /*
       * Sem permissão de propósito. A Visão geral é a tela inicial de todo mundo
       * e cada BLOCO dela exige a permissão do seu módulo. Exigir
       * `helpdesk.painel.ver` aqui era o que derrubava um perfil financeiro no
       * laço de redirect — e `helpdesk.painel.ver` continua governando o bloco
       * de atendimento dentro da página.
       */
      { href: '/painel', label: 'Visão geral', permission: null },
      /*
       * O portal fica no topo, sem permissão, e é o primeiro item de quem só
       * pede. Ele não acrescenta acesso nenhum: tudo que a página mostra já era
       * alcançável — chamados próprios pela policy da 0012, catálogo e base
       * pelas permissões da 0033. O que ele acrescenta é a ORDEM: procurar a
       * resposta antes de pedir um serviço, e pedir um serviço antes de abrir um
       * chamado livre.
       */
      { href: '/portal', label: 'Portal', permission: null },
    ],
  },
  {
    label: 'Atendimento',
    items: [
      { href: '/tickets', label: 'Tickets', permission: 'helpdesk.tickets.ver' },
      { href: '/tickets/novo', label: 'Abrir ticket', permission: 'helpdesk.tickets.criar' },
      { href: '/filas', label: 'Filas', permission: 'helpdesk.filas.ver' },
      { href: '/sla', label: 'SLA e prazos', permission: 'sla.compliance.ver' },
      /* "Satisfação" e não "CSAT": a sigla é jargão de quem mede, e quem abre a
         tela quer saber se as pessoas gostaram do atendimento. */
      { href: '/satisfacao', label: 'Satisfação', permission: 'helpdesk.satisfacao.ver' },
      /* No grupo de Atendimento, e não num grupo próprio: as duas telas servem
         ao mesmo trabalho — o chamado que não precisa ser aberto. Um grupo
         "Autoatendimento" com dois itens só acrescentaria um cabeçalho. */
      { href: '/base', label: 'Base de conhecimento', permission: 'autoatendimento.base.ver' },
      { href: '/catalogo', label: 'Catálogo de serviços', permission: 'autoatendimento.catalogo.ver' },
      /* Em Atendimento, e não em Infraestrutura, apesar de a configuração do
         canal ser trabalho de infraestrutura: quem abre esta tela todo dia é
         quem atende, para ver de onde os chamados estão chegando. A
         configuração mora um clique adentro, atrás da permissão de admin. */
      { href: '/conversas', label: 'Conversas', permission: 'canais.conversas.ver' },
    ],
  },
  {
    label: 'Financeiro',
    items: [
      { href: '/financeiro/titulos-a-pagar', label: 'Títulos a pagar', permission: 'financeiro.titulos_pagar.ver' },
      { href: '/financeiro/titulos-a-receber', label: 'Títulos a receber', permission: 'financeiro.titulos_receber.ver' },
      { href: '/financeiro/contas-bancarias', label: 'Contas bancárias', permission: 'financeiro.contas_bancarias.ver' },
      { href: '/financeiro/centros-de-custo', label: 'Centros de custo', permission: 'financeiro.centros_custo.ver' },
      {
        href: '/financeiro/fluxo-de-caixa',
        label: 'Fluxo de caixa',
        permission: 'financeiro.fluxo_caixa.ver',
      },
    ],
  },
  {
    label: 'Infraestrutura',
    items: [
      { href: '/inventario', label: 'Inventário de TI', permission: 'inventario.ativos.ver' },
      /* Logo abaixo do inventário e não dentro dele: são duas perguntas. O
         inventário é o patrimônio (inclui monitor, impressora e licença, que nunca
         terão agente); a frota é o que está ligado e reportando agora. */
      { href: '/inventario/agentes', label: 'Agentes nas máquinas', permission: 'inventario.agentes.ver' },
      /* Depois de `agentes` porque é a mesma coleta vista de outro ângulo: ali
         uma máquina por vez, aqui um programa em toda a frota. */
      { href: '/inventario/software', label: 'Software instalado', permission: 'inventario.software.ver' },
      { href: '/telefonia', label: 'Telefonia', permission: 'telefonia.linhas.ver' },
      { href: '/conectividade/links', label: 'Links de internet', permission: 'conectividade.links.ver' },
      { href: '/mapas', label: 'Mapa das filiais', permission: 'mapas.geolocalizacao.ver' },
    ],
  },
  {
    label: 'Cadastros',
    items: [
      { href: '/clientes', label: 'Clientes e filiais', permission: 'clientes.grupos.ver' },
      { href: '/fornecedores', label: 'Fornecedores e contratos', permission: 'fornecedores.cadastro.ver' },
    ],
  },
  {
    /*
     * Os sete subgrupos que o escopo pede. Um existe: o hub, que hoje atende
     * Bitrix24. Os outros seis entram como previstos — a decisão de mostrá-los
     * foi tomada com o cliente, para o menu comunicar o roteiro.
     */
    label: 'Integrações',
    items: [
      { href: '/integracoes', label: 'Sistemas de tickets', permission: 'integracoes.hub.ver' },
      /* `Automação (N8N)`, `WhatsApp` e `Telegram` estavam aqui como "em breve" e
         SAÍRAM: os três existem, em `Atendimento → Conversas` (migração 0034).
         Deixá-los aqui prometeria como futuro o que já está pronto, e no grupo
         errado — este grupo trata de mapear um REGISTRO externo para um chamado,
         e aqueles três são CONVERSA. O Telegram, em particular, entra pelo canal
         genérico do N8N, sem adaptador próprio nesta base. */
      {
        href: null,
        label: 'Bancos de dados',
        permission: null,
        soon: true,
        hint: 'Leitura de base externa para importar inventário ou cadastro.',
      },
      {
        href: null,
        label: 'Pagamento bancário',
        permission: null,
        soon: true,
        hint: 'Remessa de pagamento ao banco. Depende dos títulos a pagar.',
      },
      {
        href: null,
        label: 'Recebimento bancário',
        permission: null,
        soon: true,
        hint: 'Retorno de cobrança e baixa automática. Depende dos títulos a receber.',
      },
    ],
  },
  {
    label: 'Administração',
    items: [
      { href: '/usuarios', label: 'Usuários', permission: 'usuarios.usuarios.ver' },
      { href: '/perfis', label: 'Perfis de acesso', permission: 'usuarios.perfis.ver' },
      { href: '/tv', label: 'Painéis de TV', permission: 'tv.tokens.ver' },
    ],
  },
  {
    label: null,
    items: [
      // Trocar a própria senha não é permissão de módulo, é direito de quem tem
      // conta — e por isso é o último destino seguro.
      { href: '/conta', label: 'Minha conta', permission: null },
    ],
  },
]

/** Destino que não exige permissão de módulo nenhuma. */
export const SAFE_LANDING: Route = '/conta'

/** A tela de quem só pede. Ver `landingHref`. */
export const PORTAL: Route = '/portal'

/** Todo item de todos os grupos, na ordem do menu. */
export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

/** Itens que levam a algum lugar — exclui os previstos. */
export const NAV_LINKS: readonly NavItem[] = NAV_ITEMS.filter((i) => i.href !== null)

function itemVisivel(item: NavItem, granted: ReadonlySet<string>): boolean {
  if (item.soon) return false // decidido pelo grupo, nunca sozinho
  return item.permission === null || can(granted, item.permission)
}

/**
 * Grupos com os itens que esta sessão alcança.
 *
 * Grupo sem nenhum item alcançável desaparece inteiro, cabeçalho incluído — um
 * cabeçalho sozinho anuncia a existência de um módulo sem dar acesso a ele, o
 * que só produz pergunta para o suporte.
 *
 * Os itens previstos entram apenas nos grupos que já apareceram por mérito
 * próprio: eles informam o roteiro a quem usa o módulo, e não viram menu para
 * quem não usa.
 */
export function visibleNavGroups(granted: ReadonlySet<string>): NavGroup[] {
  const out: NavGroup[] = []
  for (const grupo of NAV_GROUPS) {
    const reais = grupo.items.filter((i) => itemVisivel(i, granted))
    if (reais.length === 0) continue
    const previstos = grupo.items.filter((i) => i.soon)
    // Preserva a ordem declarada em vez de jogar os previstos para o fim: a
    // posição diz onde a tela vai nascer, e mover atrapalha quem já se orientou.
    const itens = grupo.items.filter((i) => reais.includes(i) || previstos.includes(i))
    out.push({ label: grupo.label, items: itens })
  }
  return out
}

/** Lista plana do que a sessão alcança. Usada pelo `landingHref`. */
export function visibleNav(granted: ReadonlySet<string>): NavItem[] {
  return NAV_ITEMS.filter((i) => itemVisivel(i, granted))
}

/**
 * Primeira tela que esta sessão realmente alcança.
 *
 * Só devolve href que a pessoa pode abrir, então nunca devolve a tela que acabou
 * de negar o acesso — é o que quebra o laço de redirect. Item previsto não conta:
 * não tem para onde ir.
 */
export function landingHref(granted: ReadonlySet<string>): Route {
  for (const item of NAV_ITEMS) {
    if (item.soon || item.href === null) continue
    // `/conta` é último recurso, não primeira escolha: mandar quem tem acesso a
    // módulos para a tela de trocar senha seria pior que não redirecionar.
    if (item.href === SAFE_LANDING) continue
    /*
     * `/portal` também não é primeira escolha para quem trabalha os chamados: é
     * uma tela de autoatendimento, e mandar um atendente para ela todo dia seria
     * um clique a mais antes da fila. Quem não alcança nenhum módulo de operação
     * cai nela pela regra do fim.
     */
    if (item.href === PORTAL) continue
    if (item.permission === null || can(granted, item.permission)) return item.href
  }

  /*
   * Chegou aqui: a sessão não alcança nenhuma tela de operação. É o caso do
   * `solicitante`, e o portal é exatamente a tela dele — melhor que `/conta`,
   * que é a de trocar senha.
   */
  return PORTAL
}
