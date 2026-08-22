import type { Route } from 'next'
import { can } from './permissions'

/**
 * A navegação do app, em um lugar só.
 *
 * Estava inline em `src/app/(app)/layout.tsx`, e por isso `requireScreen()` não
 * tinha como saber para onde mandar quem foi negado — mandava sempre para
 * `/painel`. Isso produzia um laço: quem não tem `helpdesk.painel.ver` pede
 * `/painel`, é negado, e é redirecionado para `/painel` outra vez. Não é
 * hipótese: os perfis financeiros do sistema não recebem o módulo de helpdesk,
 * então um Aprovador Financeiro nunca conseguiria entrar.
 *
 * A ordem da lista importa duas vezes: é a ordem do menu e é a ordem de
 * preferência de destino pós-login.
 */
export interface NavItem {
  /* `Route` para o redirect de `requireScreen()` não precisar de cast: rota
     inexistente aqui é erro de build, não 404 em produção. */
  href: Route
  label: string
  /** Permissão de CONSULTA da tela. `null` = visível para qualquer sessão. */
  permission: string | null
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/painel', label: 'Painel', permission: 'helpdesk.painel.ver' },
  { href: '/tickets', label: 'Tickets', permission: 'helpdesk.tickets.ver' },
  { href: '/filas', label: 'Filas', permission: 'helpdesk.filas.ver' },
  { href: '/sla', label: 'SLA', permission: 'sla.compliance.ver' },
  { href: '/inventario', label: 'Inventário', permission: 'inventario.ativos.ver' },
  { href: '/telefonia', label: 'Telefonia', permission: 'telefonia.linhas.ver' },
  { href: '/fornecedores', label: 'Fornecedores', permission: 'fornecedores.cadastro.ver' },
  {
    href: '/financeiro/centros-de-custo',
    label: 'Centros de custo',
    permission: 'financeiro.centros_custo.ver',
  },
  {
    href: '/financeiro/contas-bancarias',
    label: 'Contas bancárias',
    permission: 'financeiro.contas_bancarias.ver',
  },
  { href: '/clientes', label: 'Clientes e filiais', permission: 'clientes.grupos.ver' },
  { href: '/usuarios', label: 'Usuários', permission: 'usuarios.usuarios.ver' },
  { href: '/perfis', label: 'Perfis de acesso', permission: 'usuarios.perfis.ver' },
  { href: '/integracoes', label: 'Integrações', permission: 'integracoes.hub.ver' },
  { href: '/mapas', label: 'Mapas', permission: 'mapas.geolocalizacao.ver' },
  { href: '/tv', label: 'Painéis de TV', permission: 'tv.tokens.ver' },
  // Trocar a própria senha não é permissão de módulo, é direito de quem tem
  // conta — e por isso serve de último destino seguro.
  { href: '/conta', label: 'Minha conta', permission: null },
]

/** Destino que não exige permissão de módulo nenhuma. */
export const SAFE_LANDING: Route = '/conta'

export function visibleNav(granted: ReadonlySet<string>): NavItem[] {
  return NAV_ITEMS.filter((item) => item.permission === null || can(granted, item.permission))
}

/**
 * Primeira tela que esta sessão realmente alcança.
 *
 * Só devolve href que a pessoa pode abrir, então nunca devolve a tela que acabou
 * de negar o acesso — é o que quebra o laço de redirect.
 */
export function landingHref(granted: ReadonlySet<string>): Route {
  for (const item of NAV_ITEMS) {
    if (item.permission !== null && can(granted, item.permission)) return item.href
  }
  return SAFE_LANDING
}
