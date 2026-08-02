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
