import type { SlaState, TicketStatus, UserRole } from './types'

/**
 * Dicionário pt-BR (RNF-09).
 *
 * O banco guarda os valores em inglês e a tradução vive aqui (ADR-012): assim,
 * mudar um rótulo é mexer em uma linha deste arquivo, não migrar dados nem
 * quebrar relatórios que filtram por status.
 *
 * Para adicionar um idioma: duplicar este módulo e resolver o dicionário pela
 * preferência do tenant (`tenants.default_locale`).
 */

export const ticketStatusLabel: Record<TicketStatus, string> = {
  open: 'Aberto',
  triage: 'Em triagem',
  assigned: 'Atribuído',
  in_progress: 'Em andamento',
  waiting_requester: 'Aguardando solicitante',
  waiting_third_party: 'Aguardando terceiro',
  resolved: 'Resolvido',
  closed: 'Fechado',
}

/** Cor semântica de cada status, usada em badges e no painel de TV. */
export const ticketStatusTone: Record<TicketStatus, 'neutral' | 'info' | 'warn' | 'good'> = {
  open: 'info',
  triage: 'info',
  assigned: 'info',
  in_progress: 'info',
  waiting_requester: 'warn',
  waiting_third_party: 'warn',
  resolved: 'good',
  closed: 'neutral',
}

export const roleLabel: Record<UserRole, string> = {
  super_admin: 'Super administrador',
  admin: 'Administrador',
  gestor: 'Gestor',
  atendente: 'Atendente',
  solicitante: 'Solicitante',
  visualizador: 'Visualizador (TV)',
}

export const slaStateLabel: Record<SlaState, string> = {
  no_sla: 'Sem SLA',
  ok: 'No prazo',
  warning: 'Em atenção',
  critical: 'Em risco',
  breached: 'SLA estourado',
  met: 'Cumprido',
}

export const assetTypeLabel: Record<string, string> = {
  notebook: 'Notebook',
  desktop: 'Desktop',
  server: 'Servidor',
  smartphone: 'Smartphone',
  tablet: 'Tablet',
  monitor: 'Monitor',
  printer: 'Impressora',
  peripheral: 'Periférico',
  network: 'Rede',
  software_license: 'Licença de software',
  other: 'Outro',
}

export const assetStatusLabel: Record<string, string> = {
  in_stock: 'Em estoque',
  active: 'Em uso',
  maintenance: 'Em manutenção',
  retired: 'Baixado',
  lost: 'Perdido',
}

export const lineTypeLabel: Record<string, string> = {
  postpaid: 'Pós-pago',
  prepaid: 'Pré-pago',
  control: 'Controle',
}

export const lineStatusLabel: Record<string, string> = {
  active: 'Ativa',
  suspended: 'Suspensa',
  cancelled: 'Cancelada',
}

/* --- Áreas da filial e custódia ------------------------------------------- */

/**
 * Natureza da área.
 *
 * Não é enfeite de cadastro: em Home Care, parada na Enfermagem tem impacto
 * assistencial que a Administração não tem, e é esse campo que permite ler o
 * inventário por peso operacional em vez de só por quantidade.
 */
export const areaKindLabel: Record<string, string> = {
  assistencial: 'Assistencial',
  administrativa: 'Administrativa',
  apoio: 'Apoio',
  tecnica: 'Técnica',
}

export const custodyReasonLabel: Record<string, string> = {
  realocacao: 'Realocação',
  devolucao: 'Devolução',
  substituicao: 'Substituição',
  baixa: 'Baixa',
  manutencao: 'Manutenção',
  aquisicao: 'Aquisição',
  perda: 'Perda',
  outro: 'Outro',
}

export const custodyEventLabel: Record<string, string> = {
  assignment: 'Troca de responsável',
  relocation: 'Realocação',
  return: 'Devolução',
  retirement: 'Baixa',
  loss: 'Perda',
}

/* --- Conectividade ------------------------------------------------------- */

export const linkTechnologyLabel: Record<string, string> = {
  fiber: 'Fibra',
  radio: 'Rádio',
  satellite: 'Satélite',
  mobile_4g: '4G',
  mobile_5g: '5G',
  xdsl: 'xDSL',
  other: 'Outra',
}

export const linkStatusLabel: Record<string, string> = {
  active: 'Ativo',
  suspended: 'Suspenso',
  cancelled: 'Cancelado',
}

/**
 * Estado de monitoração.
 *
 * `unknown` é "Não monitorado", NUNCA "Fora do ar". Link sem host cadastrado não
 * está caído: ninguém está olhando. Chamar as duas coisas pelo mesmo nome faria a
 * tela alarmar sobre um link que pode estar perfeito — e, pior, esconderia que
 * falta configurar a monitoração.
 */
export const linkStateLabel: Record<string, string> = {
  up: 'No ar',
  down: 'Fora do ar',
  unknown: 'Não monitorado',
}

export const linkStateTone: Record<string, 'ok' | 'breach' | 'neutral'> = {
  up: 'ok',
  down: 'breach',
  unknown: 'neutral',
}

export const integrationStatusLabel: Record<string, string> = {
  active: 'Ativa',
  paused: 'Pausada',
  error: 'Com erro',
}

export const integrationOutcomeLabel: Record<string, string> = {
  ok: 'Sucesso',
  error: 'Erro',
  retry: 'Retentativa',
  skipped_echo: 'Eco descartado',
  duplicate: 'Duplicado',
}

/** Nomes de campo do ticket, para exibir o histórico em linguagem de negócio. */
export const ticketFieldLabel: Record<string, string> = {
  status: 'Status',
  title: 'Título',
  description: 'Descrição',
  priority_id: 'Prioridade',
  category_id: 'Categoria',
  queue_id: 'Fila',
  assignee_id: 'Atendente',
  requester_id: 'Solicitante',
  branch_id: 'Filial',
  client_id: 'Cliente',
  supplier_id: 'Fornecedor',
  tags: 'Tags',
  first_response_at: 'Primeira resposta',
  resolved_at: 'Resolvido em',
  closed_at: 'Fechado em',
  reopened_count: 'Reaberturas',
  deleted_at: 'Excluído em',
  external_id: 'ID externo',
  source_system: 'Sistema de origem',
}

export const changeSourceLabel: Record<string, string> = {
  ui: 'Painel',
  api: 'API',
  integration: 'Integração',
  system: 'Sistema',
}
