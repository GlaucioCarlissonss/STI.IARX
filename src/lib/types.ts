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
}

export interface Category {
  id: string
  parent_id: string | null
  name: string
}

export interface Branch {
  id: string
  client_id: string
  name: string
  code: string | null
  city: string | null
  state: string | null
  timezone: string
  is_active: boolean
}

export interface Client {
  id: string
  legal_name: string
  trade_name: string | null
  cnpj: string | null
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
