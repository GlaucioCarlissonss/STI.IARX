/**
 * Tipos do domínio, espelhando o schema em supabase/migrations.
 *
 * Escritos à mão em vez de gerados: o app consome um subconjunto pequeno e
 * estável do schema, e o tipo gerado pelo Supabase CLI traz centenas de linhas
 * de ruído (relacionamentos, Insert/Update de cada tabela) que ninguém lê.
 * Se o schema crescer muito, migrar para `supabase gen types` é direto.
 */

export type TicketStatus =
  | 'open'
  | 'triage'
  | 'assigned'
  | 'in_progress'
  | 'waiting_requester'
  | 'waiting_third_party'
  | 'resolved'
  | 'closed'

export type UserRole =
  | 'super_admin'
  | 'admin'
  | 'gestor'
  | 'atendente'
  | 'solicitante'
  | 'visualizador'

/** Semáforo de SLA calculado por `app.sla_state()`. */
export type SlaState = 'no_sla' | 'ok' | 'warning' | 'critical' | 'breached' | 'met'

export type ChangeSource = 'ui' | 'api' | 'integration' | 'system'

export interface Profile {
  id: string
  tenant_id: string | null
  role: UserRole
  full_name: string
  email: string
  phone: string | null
  is_active: boolean
  last_seen_at: string | null
  /** Perfil de acesso; nulo cai no papel puro (ver `permissionsFromRole`). */
  access_profile_id: string | null
}

/** Perfil de acesso — teto de RLS mais a matriz de permissões. */
export interface AccessProfile {
  id: string
  name: string
  description: string | null
  base_role: Exclude<UserRole, 'super_admin'>
  is_system: boolean
  system_key: string | null
  is_active: boolean
}

export interface Tenant {
  id: string
  name: string
  slug: string
  sla_warning_pct: number
  sla_critical_pct: number
  auto_close_after_days: number
}

/** Linha de `vw_tickets_enriched` — ticket já com SLA, rótulos e score. */
export interface EnrichedTicket {
  id: string
  tenant_id: string
  ticket_number: number
  title: string
  description: string | null
  status: TicketStatus
  tags: string[]
  source: string
  source_system: string | null
  external_id: string | null
  external_url: string | null
  created_at: string
  updated_at: string
  first_response_at: string | null
  resolved_at: string | null
  closed_at: string | null
  reopened_count: number

  priority_id: string
  priority_key: string
  priority_label: string
  priority_color: string
  priority_weight: number

  queue_id: string
  queue_name: string
  queue_slug: string

  category_id: string | null
  category_name: string | null
  category_parent_name: string | null

  branch_id: string | null
  branch_name: string | null
  branch_timezone: string | null
  client_id: string | null
  client_name: string | null

  assignee_id: string | null
  assignee_name: string | null
  requester_id: string | null
  requester_name: string | null
  supplier_id: string | null
  supplier_name: string | null

  response_due_at: string | null
  resolution_due_at: string | null
  responded_at: string | null
  response_breached: boolean | null
  resolution_breached: boolean | null
  is_paused: boolean | null
  paused_minutes: number | null
  sla_coverage: 'covered' | 'uncovered' | null

  response_state: SlaState | null
  resolution_state: SlaState | null
  minutes_to_resolution_due: number | null
  queue_score: number | null
}

export interface DashboardMetrics {
  tenant_id: string
  open_total: number
  open_new: number
  in_progress_total: number
  waiting_total: number
  critical_total: number
  sla_at_risk: number
  sla_breached: number
  resolved_today: number
  created_today: number
  avg_resolution_minutes_24h: number | null
}

export interface Queue {
  id: string
  name: string
  slug: string
  description: string | null
  is_system_default: boolean
  is_active: boolean
}

export interface Priority {
  id: string
  key: string
  label: string
  weight: number
  color: string
  sort_order: number
  is_active: boolean
}

export interface Category {
  id: string
  parent_id: string | null
  name: string
  description: string | null
  is_active: boolean
}

export interface Branch {
  id: string
  client_id: string
  name: string
  code: string | null
  cnpj: string | null
  city: string | null
  state: string | null
  timezone: string
  business_hours_id: string | null
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
  is_active: boolean
}

export interface Client {
  id: string
  legal_name: string
  trade_name: string | null
  cnpj: string | null
  contract_ref: string | null
  status: string
}

export interface ItAsset {
  id: string
  asset_tag: string | null
  serial_number: string | null
  asset_type: string
  brand: string | null
  model: string | null
  status: string
  branch_id: string | null
  assigned_user_id: string | null
  supplier_id: string | null
  acquisition_date: string | null
  warranty_until: string | null
  acquisition_cost: number | null
  notes: string | null
}

export interface TelecomLine {
  id: string
  phone_number: string
  carrier: string
  plan_name: string | null
  line_type: 'postpaid' | 'prepaid' | 'control'
  status: 'active' | 'suspended' | 'cancelled'
  branch_id: string | null
  assigned_user_id: string | null
  device_asset_id: string | null
  monthly_cost: number | null
  activated_on: string | null
  cancelled_on: string | null
  loyalty_until: string | null
}

export interface Supplier {
  id: string
  name: string
  legal_name: string | null
  cnpj: string | null
  email: string | null
  phone: string | null
  services: string[]
  rating: number | null
  is_active: boolean
}

export interface SupplierContract {
  id: string
  supplier_id: string
  contract_number: string | null
  description: string | null
  starts_on: string | null
  ends_on: string | null
  monthly_cost: number | null
  response_sla_minutes: number | null
  resolution_sla_minutes: number | null
  is_active: boolean
}

export interface SlaContract {
  id: string
  client_id: string
  branch_id: string | null
  name: string
  business_hours_id: string | null
  valid_from: string | null
  valid_to: string | null
  is_active: boolean
  notes: string | null
}

/* --- Financeiro ---------------------------------------------------------- */

export interface CostCenter {
  id: string
  parent_id: string | null
  code: string
  name: string
  description: string | null
  branch_id: string | null
  is_active: boolean
}

export type BankAccountType = 'checking' | 'savings' | 'payment' | 'investment'
export type BankAccountStatus = 'active' | 'inactive' | 'blocked'

export interface BankAccount {
  id: string
  name: string
  bank_code: string | null
  bank_name: string
  agency: string | null
  account_number: string | null
  account_type: BankAccountType
  holder_name: string | null
  holder_document: string | null
  opening_balance: number
  credit_limit: number
  status: BankAccountStatus
  notes: string | null
}

/** Linha de `vw_bank_account_balances` — saldo derivado, nunca gravado. */
export interface BankAccountBalance {
  bank_account_id: string
  name: string
  bank_name: string
  account_type: BankAccountType
  status: BankAccountStatus
  opening_balance: number
  credit_limit: number
  total_in: number
  total_out: number
  current_balance: number
  unreconciled_count: number
  last_movement_on: string | null
}

export interface BankMovement {
  id: string
  bank_account_id: string
  direction: 'in' | 'out'
  amount: number
  moved_on: string
  description: string
  cost_center_id: string | null
  transfer_group: string | null
  reconciled_at: string | null
}

export interface Integration {
  id: string
  name: string
  slug: string
  source_system: string
  direction: 'inbound' | 'outbound' | 'bidirectional'
  status: 'active' | 'paused' | 'error'
  auth_type: string
  base_url: string | null
  reverse_sync_enabled: boolean
  last_sync_at: string | null
  request_count: number
  error_count: number
}

export interface IntegrationLog {
  id: string
  direction: 'inbound' | 'outbound'
  method: string | null
  endpoint: string | null
  response_status: number | null
  duration_ms: number | null
  outcome: 'ok' | 'error' | 'retry' | 'skipped_echo' | 'duplicate'
  error_message: string | null
  created_at: string
}

export interface TicketComment {
  id: string
  ticket_id: string
  author_id: string | null
  body: string
  visibility: 'public' | 'internal'
  created_at: string
  author?: { full_name: string; role: UserRole } | null
}

export interface TicketHistoryEntry {
  id: string
  field: string
  old_value: string | null
  new_value: string | null
  change_source: string
  created_at: string
  actor_id: string | null
}

/* --- Financeiro: títulos e alçada (migração 0020) ------------------------- */

export type PayableStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'scheduled'
  | 'paid'
  | 'cancelled'

export interface Payable {
  id: string
  description: string
  document_ref: string | null
  supplier_id: string | null
  supplier_contract_id: string | null
  expense_category_id: string | null
  cost_center_id: string | null
  branch_id: string | null
  amount: number
  issued_on: string
  due_on: string
  parent_payable_id: string | null
  installment_number: number
  installment_total: number
  status: PayableStatus
  approved_at: string | null
  approved_by: string | null
  rejection_reason: string | null
  paid_on: string | null
  bank_account_id: string | null
  notes: string | null
}

export type ReceivableStatus = 'draft' | 'open' | 'received' | 'cancelled'

export interface Receivable {
  id: string
  description: string
  document_ref: string | null
  client_id: string | null
  sla_contract_id: string | null
  cost_center_id: string | null
  branch_id: string | null
  amount: number
  issued_on: string
  due_on: string
  installment_number: number
  installment_total: number
  status: ReceivableStatus
  received_on: string | null
  received_amount: number | null
  bank_account_id: string | null
  notes: string | null
}

export interface ExpenseCategory {
  id: string
  code: string
  name: string
  requires_supplier: boolean
  is_active: boolean
}

export interface ApprovalRule {
  id: string
  level: number
  level_name: string
  min_amount: number
  max_amount: number | null
  cost_center_id: string | null
  branch_id: string | null
  required_profile_id: string | null
  is_active: boolean
}

export interface PayableApproval {
  id: string
  payable_id: string
  level: number
  decision: 'approved' | 'rejected'
  decided_by: string | null
  decided_at: string
  note: string | null
}

/** Uma linha por situação, de `vw_payables_summary`. */
export interface PayableSummaryRow {
  status: PayableStatus
  titulos: number
  total: number
  vencidos: number
  total_vencido: number | null
  vence_em_7_dias: number
}

/**
 * Uma linha por mês de `public.cash_flow_projection()`.
 *
 * `overdue_*` não é um mês à parte: é a fatia do mês corrente que já venceu e
 * continua devendo. Separar deixa a tela dizer "isto não é previsão, é atraso"
 * sem inventar um balde falso no eixo do tempo.
 */
export interface CashFlowBucket {
  bucket_start: string
  inflow: number
  outflow: number
  net: number
  running_balance: number
  payables_count: number
  receivables_count: number
  overdue_inflow: number | null
  overdue_outflow: number | null
  peak_day: string | null
  peak_day_outflow: number
}

/* --- Conectividade -------------------------------------------------------- */

export type LinkTechnology =
  | 'fiber'
  | 'radio'
  | 'satellite'
  | 'mobile_4g'
  | 'mobile_5g'
  | 'xdsl'
  | 'other'

export type LinkStatus = 'active' | 'suspended' | 'cancelled'

/** Estado de monitoração. `unknown` é "ninguém está olhando", não "caiu". */
export type LinkState = 'up' | 'down' | 'unknown'

export interface InternetLink {
  id: string
  branch_id: string
  branch_area_id: string | null
  contract_number: string | null
  supplier_id: string | null
  carrier_name: string | null
  technology: LinkTechnology
  download_mbps: number | null
  upload_mbps: number | null
  guaranteed_mbps: number | null
  has_static_ip: boolean
  static_ip: string | null
  cpe_brand: string | null
  cpe_model: string | null
  cpe_serial: string | null
  status: LinkStatus
  monthly_cost: number | null
  activated_on: string | null
  cancelled_on: string | null
  contract_start: string | null
  contract_end: string | null
  monitoring_host: string | null
  last_state: LinkState
  last_state_at: string | null
  notes: string | null
}

export interface LinkAvailabilityEvent {
  id: number
  link_id: string
  state: 'up' | 'down'
  started_at: string
  ended_at: string | null
  duration_seconds: number | null
  source: 'zabbix' | 'manual' | 'api'
  note: string | null
}

/** Linha de `vw_connectivity_cost`: telefonia e internet lado a lado por filial. */
export interface ConnectivityCostRow {
  branch_id: string
  branch_name: string
  lines_active: number
  telecom_monthly_cost: number
  links_active: number
  internet_monthly_cost: number
  total_monthly_cost: number
}
