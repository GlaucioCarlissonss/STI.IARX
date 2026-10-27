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
 * vim fazer aqui": atender, resolver sozinho, acompanhar o resultado, cuidar do
 * parque, cobrar e pagar, cadastrar, conectar, administrar. Um menu espelhando
 * o modelo de dados obrigaria quem usa a conhecer o modelo de dados.
 *
 * **Oito grupos, e eles abrem e fecham.** Enquanto a barra era sempre expandida,
 * sete era o teto prático — além disso ela rolava, e um menu que rola esconde
 * sem avisar. Com os grupos recolhíveis (`nav-group.tsx`) o custo de um grupo a
 * mais deixou de ser N linhas e passou a ser uma. Ordem: o que se usa todo dia
 * no topo, configuração no fim. `Visão geral` e `Portal` ficam fora de grupo
 * porque são destino, não categoria — e porque o que está sempre à vista não
 * pode depender de alguém ter aberto a gaveta certa.
 *
 * **O agrupamento segue as ÁREAS do Milvus**, que é o concorrente que a
 * docs/12 inventariou com fonte: help desk, omnichannel, base de conhecimento,
 * catálogo de serviços, portal/ESM, gestão de contratos, inventário com agente
 * e monitoramento, dashboards e integrações.
 *
 * Registro o que NÃO consegui confirmar, para não virar requisito inventado: a
 * **barra lateral literal do Milvus** não aparece em nenhuma fonte pública que
 * eu tenha alcançado — nem em documentação, nem nas resenhas. O que está abaixo
 * segue as áreas que as fontes atribuem ao produto, não uma captura de tela do
 * menu deles. Meia hora de demonstração resolveria a diferença.
 *
 * Duas divergências deliberadas: **Financeiro** e **Gestão** (resultado e
 * projetos) não têm correspondente no Milvus. São o que a docs/12 §2.1 chama de
 * "o que seria burrice perder" — apagá-los para parecer com o concorrente seria
 * copiar o mapa e jogar fora o território.
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
      /* Logo abaixo do SLA porque é a mesma pergunta vista de outro ângulo: ali
         o prazo, aqui as horas em que o prazo corre. Estava no banco desde a
         0006 e não tinha tela — dava para ESCOLHER um expediente e não dava para
         criar nenhum, nem cadastrar feriado. */
      { href: '/sla/horarios', label: 'Expediente e feriados', permission: 'sla.horarios.ver' },
      /* "Satisfação" e não "CSAT": a sigla é jargão de quem mede, e quem abre a
         tela quer saber se as pessoas gostaram do atendimento. */
      { href: '/satisfacao', label: 'Satisfação', permission: 'helpdesk.satisfacao.ver' },
      /* Fica em Atendimento, e não em Infraestrutura, apesar de a configuração
         do canal ser trabalho de infraestrutura: quem abre esta tela todo dia é
         quem atende, para ver de onde os chamados estão chegando. É o
         "omnichannel" que o Milvus trata como área de destaque — aqui ele é
         uma porta de entrada do mesmo atendimento, não um lugar separado. */
      { href: '/conversas', label: 'Conversas', permission: 'canais.conversas.ver' },
    ],
  },
  {
    /* Base de conhecimento, catálogo e portal são TRÊS áreas distintas no
       Milvus, e a razão é a mesma que vale aqui: elas não servem a quem atende,
       servem a quem pergunta. Enquanto a barra era sempre expandida, um grupo
       de dois itens era um cabeçalho a mais; com grupos recolhíveis, é uma
       linha — e o nome do grupo passa a dizer para que as duas telas existem. */
    label: 'Autoatendimento',
    items: [
      { href: '/base', label: 'Base de conhecimento', permission: 'autoatendimento.base.ver' },
      { href: '/catalogo', label: 'Catálogo de serviços', permission: 'autoatendimento.catalogo.ver' },
    ],
  },
  {
    /* Não tem correspondente no Milvus, e é de propósito: a visão de resultado
       compila financeiro, SLA e projetos sob um recorte só, e o cronograma veio
       do GSTI.IARX. São o que a docs/12 §2.1 chama de "o que seria burrice
       perder" — ficam juntos porque respondem à mesma pergunta, que é como a
       TI está indo, e não o que está acontecendo agora. */
    label: 'Gestão',
    items: [
      { href: '/resultado', label: 'Visão de resultado', permission: 'gestao.resultado.ver' },
      { href: '/projetos', label: 'Projetos', permission: 'projetos.projetos.ver' },
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
      /* O orçamento de TI, vindo do GSTI.IARX. Fica no grupo Financeiro porque é
         dinheiro, mas responde outra pergunta que os títulos: eles dizem QUANDO
         eu pago, ele diz QUANTO a TI custa por mês. Os dois não somam. */
      {
        href: '/financeiro/orcamento',
        label: 'Orçamento de TI',
        permission: 'financeiro.orcamento.ver',
      },
    ],
  },
  {
    /* "Inventário e monitoramento", e não "Infraestrutura": é o nome da área no
       Milvus, e é mais exato. "Infraestrutura" descreve o que as coisas SÃO;
       este grupo responde o que se faz com elas — saber o que existe, e saber
       se está de pé. Telefonia, links e mapa entram porque são parque também:
       a pergunta "a filial está no ar?" não separa computador de link. */
    label: 'Inventário e monitoramento',
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
    /* "Clientes e contratos", e não "Cadastros": cadastro é o que a tela faz,
       não o que ela guarda — e "gestão de contratos" é uma área nomeada no
       Milvus, com prazo, condição e histórico. O rótulo antigo obrigava a abrir
       para descobrir o que tinha dentro. */
    label: 'Clientes e contratos',
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
      /*
       * A IA saiu de Administração e veio para cá, e a razão é uma fonte, não um
       * gosto: a página do próprio Milvus sobre ChatGPT instrui a colar o token
       * "na área de integrações". É exatamente o que esta tela é — credencial
       * por referência (ADR-009) e teto de gasto mensal; ela não pede sugestão
       * nenhuma, quem pede é o chamado.
       *
       * O argumento antigo ("é configuração de ambiente, como os canais")
       * continua verdadeiro e levava ao lugar errado: os canais também são
       * integração, e o que decide o grupo é COM QUEM a tela fala — um provedor
       * de fora —, não quem a abre.
       */
      { href: '/ia', label: 'Sugestões de IA', permission: 'ia.config.ver' },
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
      /* Onze parâmetros de operação que só existiam como coluna: para mudar o
         percentual de atenção do SLA ou as horas de silêncio do agente era
         preciso um `update` à mão no banco. Na prática, ninguém mudou. */
      {
        href: '/ambiente',
        label: 'Preferências do ambiente',
        permission: 'ambiente.preferencias.ver',
      },
      /* A trilha grava desde a 0010 em 45 tabelas e nunca teve onde ser lida. A
         pergunta que ela responde sempre vem em dia ruim: quem mudou isso. */
      { href: '/auditoria', label: 'Trilha de alterações', permission: 'auditoria.trilha.ver' },
      /* A docs/13 mandava rodar SQL à mão para saber se o agendador parou — e
         quem precisa da resposta não tem psql. */
      { href: '/auditoria/trabalhos', label: 'Trabalhos agendados', permission: 'auditoria.trabalhos.ver' },
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
