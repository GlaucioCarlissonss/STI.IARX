import type { UserRole } from './types'

/**
 * Catálogo de permissões e a regra de herança.
 *
 * Três níveis, na forma `modulo`, `modulo.tela`, `modulo.tela.acao`. A chave é
 * texto porque ela atravessa a fronteira do banco (`permission_catalog.key`) e
 * do formulário (`name` do checkbox) — um enum numérico exigiria tradução nas
 * duas pontas e tornaria ilegível o que está gravado.
 *
 * ## A regra
 *
 * **Negação herda para baixo; liberação é sempre explícita.** Sem o grant do
 * módulo não há tela nem ação dentro dele; com o módulo, cada tela e cada ação
 * ainda precisa do seu próprio grant. Isso é deliberado: a alternativa
 * ("liberar o módulo libera tudo") faria cada tela nova nascer acessível a quem
 * já tem o módulo — inclusive telas sensíveis como Fluxo de Caixa, que
 * apareceriam sozinhas para um operador no dia em que fossem criadas.
 *
 * ## O que NÃO mora aqui
 *
 * Visibilidade por filial. Essa continua sendo do RLS
 * (`app.can_see_branch()`), e as duas coisas se somam: a permissão diz *o que*
 * a pessoa pode fazer, a filial diz *sobre quais linhas*. Misturar as duas numa
 * matriz só produziria uma tabela com centenas de células.
 */

export interface PermissionEntry {
  key: string
  module: string
  /** `null` na entrada do próprio módulo. */
  screen: string | null
  /** `null` nas entradas de módulo e de tela. */
  action: string | null
  label: string
  /**
   * Papel mínimo que consegue exercer a permissão de fato.
   *
   * Não é uma segunda checagem: é o que impede a tela de perfis de oferecer um
   * grant que o RLS vai negar de qualquer jeito. Conceder
   * `financeiro.contas_bancarias.criar` a um perfil de base `atendente`
   * produziria um botão que existe e sempre falha — pior que não ter o botão.
   */
  minBaseRole: UserRole
}

/** Ordem de privilégio dos papéis. Usada para comparar teto, nunca para autorizar. */
export const ROLE_RANK: Record<UserRole, number> = {
  visualizador: 0,
  solicitante: 1,
  atendente: 2,
  gestor: 3,
  admin: 4,
  super_admin: 5,
}

/** Rótulos dos módulos, para o cabeçalho da matriz e para o menu. */
export const MODULE_LABEL: Record<string, string> = {
  helpdesk: 'Helpdesk',
  sla: 'SLA e filas',
  inventario: 'Inventário',
  telefonia: 'Telefonia',
  conectividade: 'Conectividade',
  clientes: 'Clientes e filiais',
  fornecedores: 'Fornecedores',
  mapas: 'Mapas',
  financeiro: 'Financeiro',
  usuarios: 'Usuários e acesso',
  integracoes: 'Integrações',
  tv: 'Painéis de TV',
}

/*
 * Atalhos de construção. Escrever as ~110 entradas à mão convidaria a
 * divergência entre `key` e a trinca `module`/`screen`/`action` — e é justamente
 * dessa trinca que o SQL e a UI dependem para montar a árvore.
 */
const mod = (module: string, minBaseRole: UserRole): PermissionEntry => ({
  key: module, module, screen: null, action: null,
  label: MODULE_LABEL[module] ?? module, minBaseRole,
})
const scr = (
  module: string, screen: string, label: string, minBaseRole: UserRole,
): PermissionEntry => ({ key: `${module}.${screen}`, module, screen, action: null, label, minBaseRole })
const act = (
  module: string, screen: string, action: string, label: string, minBaseRole: UserRole,
): PermissionEntry => ({
  key: `${module}.${screen}.${action}`, module, screen, action, label, minBaseRole,
})

/**
 * O catálogo cobre APENAS telas que existem hoje mais as que esta rodada cria.
 *
 * Módulos com banco pronto e interface pendente (links de internet, contas a
 * pagar, controle de despesas) entram junto com a própria tela. Cadastrá-los
 * antes daria ao administrador um checkbox que não governa nada — configuração
 * morta é pior que ausência de configuração, porque parece ter surtido efeito.
 */
export const PERMISSION_CATALOG: readonly PermissionEntry[] = [
  /* --- Helpdesk ---------------------------------------------------------- */
  mod('helpdesk', 'visualizador'),
  scr('helpdesk', 'painel', 'Painel operacional', 'visualizador'),
  act('helpdesk', 'painel', 'ver', 'Abrir o painel', 'visualizador'),
  scr('helpdesk', 'tickets', 'Tickets', 'visualizador'),
  act('helpdesk', 'tickets', 'ver', 'Consultar tickets', 'visualizador'),
  act('helpdesk', 'tickets', 'criar', 'Abrir ticket', 'solicitante'),
  act('helpdesk', 'tickets', 'comentar', 'Comentar (público)', 'solicitante'),
  // Comentário interno é separado de propósito: hoje qualquer papel consegue
  // marcar `visibility:'internal'`, ou seja, um solicitante escreve na parte do
  // ticket que ele não deveria nem ler.
  act('helpdesk', 'tickets', 'comentar_interno', 'Comentar (interno)', 'atendente'),
  act('helpdesk', 'tickets', 'mudar_status', 'Mover status', 'atendente'),
  act('helpdesk', 'tickets', 'atribuir', 'Atribuir atendente', 'atendente'),
  act('helpdesk', 'tickets', 'transferir', 'Transferir de fila', 'atendente'),
  // Anexar é `solicitante`: quem abre o chamado precisa poder mandar o print do
  // erro, e é o anexo mais comum do helpdesk. Remover é `atendente` — deixar o
  // solicitante apagar anexo do próprio ticket já escalado apagaria evidência.
  act('helpdesk', 'tickets', 'anexar', 'Anexar arquivo', 'solicitante'),
  act('helpdesk', 'tickets', 'remover_anexo', 'Remover anexo', 'atendente'),
  scr('helpdesk', 'filas', 'Filas', 'visualizador'),
  act('helpdesk', 'filas', 'ver', 'Consultar filas', 'visualizador'),

  /* --- SLA e filas (configuração) ---------------------------------------- */
  mod('sla', 'gestor'),
  scr('sla', 'compliance', 'Compliance de SLA', 'gestor'),
  act('sla', 'compliance', 'ver', 'Ver compliance', 'gestor'),
  scr('sla', 'definicoes', 'Definições de SLA', 'gestor'),
  act('sla', 'definicoes', 'ver', 'Consultar definições', 'gestor'),
  act('sla', 'definicoes', 'criar', 'Criar definição', 'gestor'),
  act('sla', 'definicoes', 'editar', 'Editar definição', 'gestor'),
  act('sla', 'definicoes', 'inativar', 'Ativar/inativar definição', 'gestor'),
  scr('sla', 'contratos', 'Contratos de SLA', 'gestor'),
  act('sla', 'contratos', 'ver', 'Consultar contratos de SLA', 'gestor'),
  act('sla', 'contratos', 'criar', 'Criar contrato de SLA', 'gestor'),
  act('sla', 'contratos', 'editar', 'Editar contrato de SLA', 'gestor'),
  act('sla', 'contratos', 'inativar', 'Ativar/inativar contrato de SLA', 'gestor'),
  scr('sla', 'categorias', 'Categorias de ticket', 'gestor'),
  act('sla', 'categorias', 'ver', 'Consultar categorias', 'gestor'),
  act('sla', 'categorias', 'criar', 'Criar categoria', 'gestor'),
  act('sla', 'categorias', 'editar', 'Editar categoria', 'gestor'),
  act('sla', 'categorias', 'inativar', 'Ativar/inativar categoria', 'gestor'),
  scr('sla', 'prioridades', 'Prioridades', 'gestor'),
  act('sla', 'prioridades', 'ver', 'Consultar prioridades', 'gestor'),
  act('sla', 'prioridades', 'criar', 'Criar prioridade', 'gestor'),
  act('sla', 'prioridades', 'editar', 'Editar prioridade', 'gestor'),
  act('sla', 'prioridades', 'inativar', 'Ativar/inativar prioridade', 'gestor'),

  /* --- Inventário -------------------------------------------------------- */
  mod('inventario', 'visualizador'),
  scr('inventario', 'ativos', 'Ativos de TI', 'visualizador'),
  act('inventario', 'ativos', 'ver', 'Consultar ativos', 'visualizador'),
  act('inventario', 'ativos', 'criar', 'Cadastrar ativo', 'gestor'),
  act('inventario', 'ativos', 'editar', 'Editar ativo', 'gestor'),
  act('inventario', 'ativos', 'mudar_status', 'Mover ciclo de vida', 'gestor'),
  act('inventario', 'ativos', 'anexar', 'Anexar nota ou foto', 'gestor'),
  act('inventario', 'ativos', 'remover_anexo', 'Remover anexo do ativo', 'gestor'),

  /* --- Telefonia --------------------------------------------------------- */
  mod('telefonia', 'visualizador'),
  scr('telefonia', 'linhas', 'Linhas telefônicas', 'visualizador'),
  act('telefonia', 'linhas', 'ver', 'Consultar linhas', 'visualizador'),
  act('telefonia', 'linhas', 'criar', 'Cadastrar linha', 'gestor'),
  act('telefonia', 'linhas', 'editar', 'Editar linha', 'gestor'),
  act('telefonia', 'linhas', 'mudar_status', 'Suspender/reativar linha', 'gestor'),
  act('telefonia', 'linhas', 'anexar', 'Anexar contrato ou termo', 'gestor'),
  act('telefonia', 'linhas', 'remover_anexo', 'Remover anexo da linha', 'gestor'),

  /* --- Conectividade ------------------------------------------------------
     Entra agora porque a TELA entra agora. A camada de dados existe desde a
     migração 0013 (`internet_links`, `internet_link_attachments`,
     `link_availability_events`), e a 0019 deixou anotado que `conectividade.links`
     não seria cadastrada antes da tela: permissão que não governa tela é
     configuração morta.

     `registrar_evento` fica em `gestor`, e não em `atendente` como seria natural.
     O motivo é o banco: a policy de escrita de `link_availability_events` (0013)
     exige `app.can_manage_records()`, que é gestor para cima. Uma chave em
     `atendente` concederia na tela o que o banco negaria devolvendo zero linhas —
     permissão que não governa nada, o defeito que esta base já corrigiu duas
     vezes. Afrouxar aquela policy é decisão de segurança do cliente, não minha. */
  mod('conectividade', 'visualizador'),
  scr('conectividade', 'links', 'Links de internet', 'visualizador'),
  act('conectividade', 'links', 'ver', 'Consultar links', 'visualizador'),
  act('conectividade', 'links', 'criar', 'Cadastrar link', 'gestor'),
  act('conectividade', 'links', 'editar', 'Editar link', 'gestor'),
  act('conectividade', 'links', 'mudar_status', 'Suspender/cancelar link', 'gestor'),
  act('conectividade', 'links', 'registrar_evento', 'Registrar queda ou retorno', 'gestor'),
  act('conectividade', 'links', 'anexar', 'Anexar contrato ou laudo', 'gestor'),
  act('conectividade', 'links', 'remover_anexo', 'Remover anexo do link', 'gestor'),

  /* --- Clientes e filiais ------------------------------------------------ */
  mod('clientes', 'gestor'),
  scr('clientes', 'grupos', 'Grupos econômicos', 'gestor'),
  act('clientes', 'grupos', 'ver', 'Consultar clientes', 'gestor'),
  act('clientes', 'grupos', 'criar', 'Cadastrar cliente', 'gestor'),
  act('clientes', 'grupos', 'editar', 'Editar cliente', 'gestor'),
  act('clientes', 'grupos', 'inativar', 'Mudar situação do cliente', 'gestor'),
  scr('clientes', 'filiais', 'Filiais', 'gestor'),
  act('clientes', 'filiais', 'ver', 'Consultar filiais', 'gestor'),
  act('clientes', 'filiais', 'criar', 'Cadastrar filial', 'gestor'),
  act('clientes', 'filiais', 'editar', 'Editar filial', 'gestor'),
  act('clientes', 'filiais', 'inativar', 'Ativar/inativar filial', 'gestor'),

  /* --- Fornecedores ------------------------------------------------------ */
  mod('fornecedores', 'gestor'),
  scr('fornecedores', 'cadastro', 'Fornecedores', 'gestor'),
  act('fornecedores', 'cadastro', 'ver', 'Consultar fornecedores', 'gestor'),
  act('fornecedores', 'cadastro', 'criar', 'Cadastrar fornecedor', 'gestor'),
  act('fornecedores', 'cadastro', 'editar', 'Editar fornecedor', 'gestor'),
  act('fornecedores', 'cadastro', 'inativar', 'Ativar/inativar fornecedor', 'gestor'),
  scr('fornecedores', 'contratos', 'Contratos de fornecedor', 'gestor'),
  act('fornecedores', 'contratos', 'ver', 'Consultar contratos', 'gestor'),
  act('fornecedores', 'contratos', 'criar', 'Cadastrar contrato', 'gestor'),
  act('fornecedores', 'contratos', 'editar', 'Editar contrato', 'gestor'),
  act('fornecedores', 'contratos', 'inativar', 'Ativar/inativar contrato', 'gestor'),

  /* --- Mapas ------------------------------------------------------------- */
  mod('mapas', 'visualizador'),
  scr('mapas', 'geolocalizacao', 'Geolocalização de filiais', 'visualizador'),
  act('mapas', 'geolocalizacao', 'ver', 'Ver mapa', 'visualizador'),
  act('mapas', 'geolocalizacao', 'editar_endereco', 'Gravar endereço e coordenada', 'gestor'),
  act('mapas', 'geolocalizacao', 'geocodificar', 'Rodar geocodificação', 'gestor'),

  /* --- Financeiro (esta rodada entrega a base) --------------------------- */
  mod('financeiro', 'gestor'),
  /* Ordem do menu: título se lança todo dia, centro de custo se cadastra uma
     vez. Ver a decisão de agrupamento em src/lib/navigation.ts. */
  scr('financeiro', 'titulos_pagar', 'Títulos a pagar', 'gestor'),
  act('financeiro', 'titulos_pagar', 'ver', 'Consultar títulos a pagar', 'gestor'),
  act('financeiro', 'titulos_pagar', 'criar', 'Lançar despesa', 'gestor'),
  act('financeiro', 'titulos_pagar', 'editar', 'Editar título', 'gestor'),
  act('financeiro', 'titulos_pagar', 'aprovar', 'Aprovar ou reprovar', 'gestor'),
  act('financeiro', 'titulos_pagar', 'pagar', 'Dar baixa no pagamento', 'gestor'),
  act('financeiro', 'titulos_pagar', 'cancelar', 'Cancelar título', 'gestor'),
  /* `configurar` é uma chave só para alçada E categorias de despesa: as duas são
     configuração do módulo e nenhuma tem tela própria. Chave para tela que não
     existe é configuração morta. Teto `admin` porque mexer na alçada muda quem
     autoriza pagamento. */
  act('financeiro', 'titulos_pagar', 'configurar', 'Configurar alçada e categorias', 'admin'),
  act('financeiro', 'titulos_pagar', 'anexar', 'Anexar NF, boleto ou comprovante', 'gestor'),
  act('financeiro', 'titulos_pagar', 'remover_anexo', 'Remover anexo do título', 'gestor'),
  scr('financeiro', 'titulos_receber', 'Títulos a receber', 'gestor'),
  act('financeiro', 'titulos_receber', 'ver', 'Consultar títulos a receber', 'gestor'),
  act('financeiro', 'titulos_receber', 'criar', 'Lançar título a receber', 'gestor'),
  act('financeiro', 'titulos_receber', 'editar', 'Editar título a receber', 'gestor'),
  act('financeiro', 'titulos_receber', 'baixar', 'Dar baixa no recebimento', 'gestor'),
  act('financeiro', 'titulos_receber', 'cancelar', 'Cancelar título a receber', 'gestor'),
  scr('financeiro', 'centros_custo', 'Centros de custo', 'gestor'),
  act('financeiro', 'centros_custo', 'ver', 'Consultar centros de custo', 'gestor'),
  act('financeiro', 'centros_custo', 'criar', 'Cadastrar centro de custo', 'gestor'),
  act('financeiro', 'centros_custo', 'editar', 'Editar centro de custo', 'gestor'),
  act('financeiro', 'centros_custo', 'inativar', 'Ativar/inativar centro de custo', 'gestor'),
  scr('financeiro', 'contas_bancarias', 'Contas bancárias', 'gestor'),
  act('financeiro', 'contas_bancarias', 'ver', 'Consultar contas e saldos', 'gestor'),
  act('financeiro', 'contas_bancarias', 'criar', 'Cadastrar conta bancária', 'gestor'),
  act('financeiro', 'contas_bancarias', 'editar', 'Editar conta bancária', 'gestor'),
  act('financeiro', 'contas_bancarias', 'inativar', 'Bloquear/reativar conta', 'gestor'),
  act('financeiro', 'contas_bancarias', 'movimentar', 'Lançar entrada/saída', 'gestor'),
  act('financeiro', 'contas_bancarias', 'transferir', 'Transferir entre contas', 'gestor'),
  /* Fluxo de caixa é só leitura: projeta o que já está lançado e não grava nada.
     Por isso DUAS chaves e não mais — uma `configurar` não governaria coisa
     alguma, porque o percentual de inadimplência é parâmetro de consulta e não
     configuração gravada. Fica dentro de `financeiro` de propósito: é o que faz o
     Gestor Financeiro receber a tela e o Operador/Aprovador receberem o `ver`
     pelas regras que `app.seed_system_access_profiles()` já tem. */
  scr('financeiro', 'fluxo_caixa', 'Fluxo de caixa', 'gestor'),
  act('financeiro', 'fluxo_caixa', 'ver', 'Consultar a projeção', 'gestor'),

  /* --- Usuários e acesso ------------------------------------------------- */
  mod('usuarios', 'gestor'),
  scr('usuarios', 'usuarios', 'Usuários', 'gestor'),
  act('usuarios', 'usuarios', 'ver', 'Consultar usuários', 'gestor'),
  act('usuarios', 'usuarios', 'criar', 'Criar usuário', 'admin'),
  act('usuarios', 'usuarios', 'editar_acesso', 'Alterar papel e filiais', 'admin'),
  scr('usuarios', 'perfis', 'Perfis de acesso', 'admin'),
  act('usuarios', 'perfis', 'ver', 'Consultar perfis', 'admin'),
  act('usuarios', 'perfis', 'criar', 'Criar perfil', 'admin'),
  act('usuarios', 'perfis', 'editar', 'Editar perfil e permissões', 'admin'),
  act('usuarios', 'perfis', 'inativar', 'Ativar/inativar perfil', 'admin'),

  /* --- Integrações ------------------------------------------------------- */
  mod('integracoes', 'admin'),
  scr('integracoes', 'hub', 'Hub de integrações', 'admin'),
  act('integracoes', 'hub', 'ver', 'Consultar integrações', 'admin'),
  act('integracoes', 'hub', 'editar', 'Ligar/desligar e configurar', 'admin'),
  act('integracoes', 'hub', 'rotacionar_token', 'Rotacionar token de entrada', 'admin'),

  /* --- Painéis de TV ----------------------------------------------------- */
  mod('tv', 'gestor'),
  scr('tv', 'tokens', 'Tokens de exibição', 'gestor'),
  act('tv', 'tokens', 'ver', 'Consultar tokens', 'gestor'),
  act('tv', 'tokens', 'criar', 'Gerar token', 'gestor'),
  act('tv', 'tokens', 'revogar', 'Revogar token', 'gestor'),
] as const

/** Todas as chaves válidas — o SQL semeia exatamente esta lista. */
export const PERMISSION_KEYS: readonly string[] = PERMISSION_CATALOG.map((p) => p.key)

const CATALOG_BY_KEY = new Map(PERMISSION_CATALOG.map((p) => [p.key, p]))

export function permissionEntry(key: string): PermissionEntry | undefined {
  return CATALOG_BY_KEY.get(key)
}

/**
 * A pessoa tem esta permissão?
 *
 * Exige o grant da chave E de cada ancestral dela. É a herança de negação em
 * uma linha: sem `financeiro`, nem `financeiro.contas_bancarias` nem
 * `financeiro.contas_bancarias.criar` valem, mesmo que o grant específico
 * exista no banco — o que protege contra um grant órfão deixado por uma
 * despromoção mal feita.
 */
export function can(granted: ReadonlySet<string>, key: string): boolean {
  const parts = key.split('.')
  for (let i = 1; i <= parts.length; i += 1) {
    if (!granted.has(parts.slice(0, i).join('.'))) return false
  }
  return true
}

/** Alguma coisa dentro deste módulo está liberada? Usado pelo menu. */
export function canAnyInModule(granted: ReadonlySet<string>, module: string): boolean {
  if (!granted.has(module)) return false
  return PERMISSION_CATALOG.some(
    (p) => p.module === module && p.action !== null && can(granted, p.key),
  )
}

export interface CatalogScreen {
  key: string
  label: string
  actions: PermissionEntry[]
}
export interface CatalogModule {
  key: string
  label: string
  screens: CatalogScreen[]
}

/**
 * Catálogo em árvore, para a matriz de permissões.
 *
 * Construído a partir da lista plana em vez de declarado duas vezes: uma árvore
 * escrita à mão sairia de sincronia com as chaves na primeira permissão nova.
 */
export function catalogTree(): CatalogModule[] {
  const modules: CatalogModule[] = []
  for (const entry of PERMISSION_CATALOG) {
    if (entry.screen === null) {
      modules.push({ key: entry.key, label: entry.label, screens: [] })
      continue
    }
    const mod = modules.find((m) => m.key === entry.module)
    if (!mod) continue
    if (entry.action === null) {
      mod.screens.push({ key: entry.key, label: entry.label, actions: [] })
      continue
    }
    mod.screens.find((s) => s.key === `${entry.module}.${entry.screen}`)?.actions.push(entry)
  }
  return modules
}

/**
 * Fecha o conjunto de grants: marcar uma ação implica marcar a tela e o módulo.
 *
 * Sem isto, a matriz aceitaria salvar `financeiro.contas_bancarias.criar` sem
 * `financeiro`, e a permissão simplesmente não funcionaria — o administrador
 * veria o checkbox marcado e o operador continuaria sem o botão, sem nenhuma
 * pista do motivo. Fechar no salvamento é mais honesto que avisar depois.
 */
export function withAncestors(keys: Iterable<string>): string[] {
  const out = new Set<string>()
  for (const key of keys) {
    if (!CATALOG_BY_KEY.has(key)) continue
    const parts = key.split('.')
    for (let i = 1; i <= parts.length; i += 1) out.add(parts.slice(0, i).join('.'))
  }
  return [...out].sort()
}

/**
 * Grants que o papel-base não consegue exercer.
 *
 * A tela de perfis usa isto para não oferecer (nem gravar) permissão que o RLS
 * negaria de qualquer forma.
 */
export function unreachableForRole(keys: Iterable<string>, baseRole: UserRole): string[] {
  const rank = ROLE_RANK[baseRole]
  return [...keys].filter((k) => {
    const entry = CATALOG_BY_KEY.get(k)
    return entry ? ROLE_RANK[entry.minBaseRole] > rank : false
  })
}
