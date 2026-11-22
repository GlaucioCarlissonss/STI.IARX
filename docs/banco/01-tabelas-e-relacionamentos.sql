-- =============================================================================
-- 01 — TABELAS E RELACIONAMENTOS  (125 tabelas)
--
-- GERADO — não edite este arquivo.
--
-- Ele é lido do catálogo do PostgreSQL por
-- `scripts/gerar-artefatos-do-banco.py`, a partir de um banco feito só das
-- migrações. A fonte da verdade continua sendo `supabase/migrations/`; isto
-- aqui é o retrato consolidado do que elas produzem, para quem precisa LER o
-- schema inteiro de uma vez em vez de atravessar 64 arquivos.
--
-- Para mudar o schema: migração nova. Para atualizar este arquivo: rode o
-- gerador. `npm test` fica vermelho quando os dois divergem.
-- =============================================================================

-- A chave estrangeira aparece como `alter table ... add constraint`, e não
-- dentro do `create table`, porque a ordem de criação entre 125 tabelas tem
-- ciclo: `tickets` aponta para `profiles` e `profiles` aponta para `tenants`,
-- que por sua vez tem coluna apontando para `planos`. Separar as duas coisas
-- é o que torna este arquivo executável de cima para baixo.

-- 354 chaves estrangeiras, no fim do arquivo.

-- --------------------------------------------------------------------------
-- As sequências (7), antes de quem as usa
-- --------------------------------------------------------------------------
create sequence public.audit_log_id_seq as bigint;
create sequence public.auth_tokens_id_seq as bigint;
create sequence public.invites_id_seq as bigint;
create sequence public.job_alert_episodes_id_seq as bigint;
create sequence public.job_runs_id_seq as bigint;
create sequence public.link_availability_events_id_seq as bigint;
create sequence public.tenant_status_events_id_seq as bigint;

-- --------------------------------------------------------------------------
-- access_profiles
-- --------------------------------------------------------------------------
create table public.access_profiles (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  name text not null,
  description text,
  base_role text not null,
  is_system boolean default false not null,
  system_key text,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.access_profiles
  add constraint access_profiles_pkey PRIMARY KEY (id);
alter table public.access_profiles
  add constraint uq_access_profiles_id_tenant UNIQUE (id, tenant_id);
alter table public.access_profiles
  add constraint access_profiles_base_role_check CHECK ((base_role = ANY (ARRAY['admin'::text, 'gestor'::text, 'atendente'::text, 'solicitante'::text, 'visualizador'::text])));
alter table public.access_profiles
  add constraint access_profiles_system_key_required CHECK (((is_system AND (system_key IS NOT NULL)) OR ((NOT is_system) AND (system_key IS NULL))));

-- --------------------------------------------------------------------------
-- agent_alerts
-- --------------------------------------------------------------------------
create table public.agent_alerts (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  device_id uuid not null,
  branch_id uuid,
  kind text not null,
  chave text default ''::text not null,
  severidade text default 'alerta'::text not null,
  mensagem text not null,
  valor numeric(6,2),
  aberto_em timestamp with time zone default now() not null,
  fechado_em timestamp with time zone,
  notificado_em timestamp with time zone
);
alter table public.agent_alerts
  add constraint agent_alerts_pkey PRIMARY KEY (id);
alter table public.agent_alerts
  add constraint uq_aa_id_tenant UNIQUE (id, tenant_id);
alter table public.agent_alerts
  add constraint agent_alerts_kind_check CHECK ((kind = ANY (ARRAY['disco_cheio'::text, 'maquina_muda'::text, 'servico_fora'::text, 'smart_falha'::text])));
alter table public.agent_alerts
  add constraint agent_alerts_severidade_check CHECK ((severidade = ANY (ARRAY['aviso'::text, 'alerta'::text, 'critico'::text])));

-- --------------------------------------------------------------------------
-- agent_devices
-- --------------------------------------------------------------------------
create table public.agent_devices (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  device_uuid uuid not null,
  token_hash text not null,
  hostname text,
  os text,
  os_version text,
  chassis text,
  agent_version text,
  it_asset_id uuid,
  match_method text,
  divergences jsonb default '{}'::jsonb not null,
  branch_id uuid,
  last_snapshot_hash text,
  last_snapshot_at timestamp with time zone,
  last_seen_at timestamp with time zone,
  revoked_at timestamp with time zone,
  enrollment_id uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  remote_id text
);
alter table public.agent_devices
  add constraint agent_devices_pkey PRIMARY KEY (id);
alter table public.agent_devices
  add constraint agent_devices_token_hash_key UNIQUE (token_hash);
alter table public.agent_devices
  add constraint uq_ad_id_tenant UNIQUE (id, tenant_id);
alter table public.agent_devices
  add constraint uq_agent_device_uuid UNIQUE (tenant_id, device_uuid);
alter table public.agent_devices
  add constraint agent_devices_match_method_check CHECK ((match_method = ANY (ARRAY['serial'::text, 'device_uuid'::text, 'hostname'::text, 'created'::text])));

-- --------------------------------------------------------------------------
-- agent_enrollments
-- --------------------------------------------------------------------------
create table public.agent_enrollments (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  name text not null,
  token_hash text not null,
  branch_id uuid,
  max_uses integer,
  uses_count integer default 0 not null,
  expires_at timestamp with time zone,
  revoked_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.agent_enrollments
  add constraint agent_enrollments_pkey PRIMARY KEY (id);
alter table public.agent_enrollments
  add constraint agent_enrollments_token_hash_key UNIQUE (token_hash);
alter table public.agent_enrollments
  add constraint uq_ae_id_tenant UNIQUE (id, tenant_id);
alter table public.agent_enrollments
  add constraint agent_enrollments_max_uses_check CHECK (((max_uses IS NULL) OR (max_uses > 0)));
alter table public.agent_enrollments
  add constraint agent_enrollments_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 120)));
alter table public.agent_enrollments
  add constraint agent_enrollments_uses_count_check CHECK ((uses_count >= 0));

-- --------------------------------------------------------------------------
-- agent_inventory_snapshots
-- --------------------------------------------------------------------------
create table public.agent_inventory_snapshots (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  device_id uuid not null,
  payload jsonb not null,
  payload_hash text not null,
  collected_at timestamp with time zone not null,
  created_at timestamp with time zone default now() not null
);
alter table public.agent_inventory_snapshots
  add constraint agent_inventory_snapshots_pkey PRIMARY KEY (id);

-- --------------------------------------------------------------------------
-- agent_metrics_hourly
-- --------------------------------------------------------------------------
create table public.agent_metrics_hourly (
  tenant_id uuid not null,
  device_id uuid not null,
  branch_id uuid,
  hora timestamp with time zone not null,
  cpu_avg smallint,
  cpu_max smallint,
  mem_avg_pct smallint,
  mem_max_pct smallint,
  amostras integer default 0 not null
);
alter table public.agent_metrics_hourly
  add constraint agent_metrics_hourly_pkey PRIMARY KEY (device_id, hora);
alter table public.agent_metrics_hourly
  add constraint agent_metrics_hourly_amostras_check CHECK ((amostras >= 0));
alter table public.agent_metrics_hourly
  add constraint agent_metrics_hourly_cpu_avg_check CHECK (((cpu_avg >= 0) AND (cpu_avg <= 100)));
alter table public.agent_metrics_hourly
  add constraint agent_metrics_hourly_cpu_max_check CHECK (((cpu_max >= 0) AND (cpu_max <= 100)));
alter table public.agent_metrics_hourly
  add constraint agent_metrics_hourly_mem_avg_pct_check CHECK (((mem_avg_pct >= 0) AND (mem_avg_pct <= 100)));
alter table public.agent_metrics_hourly
  add constraint agent_metrics_hourly_mem_max_pct_check CHECK (((mem_max_pct >= 0) AND (mem_max_pct <= 100)));

-- --------------------------------------------------------------------------
-- agent_metrics_raw
-- --------------------------------------------------------------------------
create table public.agent_metrics_raw (
  tenant_id uuid not null,
  device_id uuid not null,
  branch_id uuid,
  collected_at timestamp with time zone not null,
  cpu_percent smallint,
  mem_used_bytes bigint,
  mem_total_bytes bigint,
  uptime_s bigint,
  servicos_fora text[] default '{}'::text[] not null
);
alter table public.agent_metrics_raw
  add constraint agent_metrics_raw_pkey PRIMARY KEY (device_id, collected_at);
alter table public.agent_metrics_raw
  add constraint agent_metrics_raw_cpu_percent_check CHECK (((cpu_percent >= 0) AND (cpu_percent <= 100)));
alter table public.agent_metrics_raw
  add constraint agent_metrics_raw_mem_total_bytes_check CHECK ((mem_total_bytes >= 0));
alter table public.agent_metrics_raw
  add constraint agent_metrics_raw_mem_used_bytes_check CHECK ((mem_used_bytes >= 0));
alter table public.agent_metrics_raw
  add constraint agent_metrics_raw_uptime_s_check CHECK ((uptime_s >= 0));

-- --------------------------------------------------------------------------
-- agent_software
-- --------------------------------------------------------------------------
create table public.agent_software (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  device_id uuid not null,
  name text not null,
  version text default ''::text not null,
  publisher text,
  installed_on date,
  first_seen_at timestamp with time zone default now() not null,
  last_seen_at timestamp with time zone default now() not null
);
alter table public.agent_software
  add constraint agent_software_pkey PRIMARY KEY (id);
alter table public.agent_software
  add constraint uq_software_device UNIQUE (device_id, name, version);
alter table public.agent_software
  add constraint agent_software_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 300)));

-- --------------------------------------------------------------------------
-- agent_volume_samples
-- --------------------------------------------------------------------------
create table public.agent_volume_samples (
  tenant_id uuid not null,
  device_id uuid not null,
  branch_id uuid,
  ponto text not null,
  hora timestamp with time zone not null,
  total_bytes bigint not null,
  livre_min_bytes bigint not null,
  amostras integer default 1 not null
);
alter table public.agent_volume_samples
  add constraint agent_volume_samples_pkey PRIMARY KEY (device_id, ponto, hora);
alter table public.agent_volume_samples
  add constraint agent_volume_samples_amostras_check CHECK ((amostras >= 0));
alter table public.agent_volume_samples
  add constraint agent_volume_samples_livre_min_bytes_check CHECK ((livre_min_bytes >= 0));
alter table public.agent_volume_samples
  add constraint agent_volume_samples_ponto_check CHECK (((length(ponto) >= 1) AND (length(ponto) <= 120)));
alter table public.agent_volume_samples
  add constraint agent_volume_samples_total_bytes_check CHECK ((total_bytes > 0));
alter table public.agent_volume_samples
  add constraint avs_livre_cabe_no_total CHECK ((livre_min_bytes <= total_bytes));

-- --------------------------------------------------------------------------
-- ai_settings
-- --------------------------------------------------------------------------
create table public.ai_settings (
  tenant_id uuid not null,
  enabled boolean default false not null,
  provider text default 'anthropic'::text not null,
  model text default 'claude-opus-5-5'::text not null,
  effort text default 'medium'::text not null,
  secret_ref text,
  sugerir_resposta boolean default true not null,
  sugerir_triagem boolean default true not null,
  redigir_artigo boolean default true not null,
  enviar_notas_internas boolean default false not null,
  limite_mensal_centavos integer default 5000 not null,
  gasto_do_mes_centavos integer default 0 not null,
  mes_de_referencia date default (date_trunc('month'::text, now()))::date not null,
  tokens_entrada bigint default 0 not null,
  tokens_saida bigint default 0 not null,
  updated_at timestamp with time zone default now() not null,
  updated_by uuid
);
alter table public.ai_settings
  add constraint ai_settings_pkey PRIMARY KEY (tenant_id);
alter table public.ai_settings
  add constraint ai_settings_effort_check CHECK ((effort = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])));
alter table public.ai_settings
  add constraint ai_settings_gasto_do_mes_centavos_check CHECK ((gasto_do_mes_centavos >= 0));
alter table public.ai_settings
  add constraint ai_settings_limite_mensal_centavos_check CHECK (((limite_mensal_centavos >= 0) AND (limite_mensal_centavos <= 100000000)));
alter table public.ai_settings
  add constraint ai_settings_model_check CHECK (((length(TRIM(BOTH FROM model)) >= 3) AND (length(TRIM(BOTH FROM model)) <= 80)));
alter table public.ai_settings
  add constraint ai_settings_provider_check CHECK ((provider = 'anthropic'::text));
alter table public.ai_settings
  add constraint ai_settings_secret_ref_check CHECK (((secret_ref IS NULL) OR (secret_ref ~ '^[A-Z][A-Z0-9_]{2,60}$'::text)));
alter table public.ai_settings
  add constraint ai_settings_tokens_entrada_check CHECK ((tokens_entrada >= 0));
alter table public.ai_settings
  add constraint ai_settings_tokens_saida_check CHECK ((tokens_saida >= 0));
alter table public.ai_settings
  add constraint ia_ligada_tem_credencial CHECK (((NOT enabled) OR (secret_ref IS NOT NULL)));

-- --------------------------------------------------------------------------
-- ai_suggestions
-- --------------------------------------------------------------------------
create table public.ai_suggestions (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  ticket_id uuid not null,
  kind text not null,
  payload jsonb not null,
  status text default 'pendente'::text not null,
  requested_by uuid,
  acted_by uuid,
  acted_at timestamp with time zone,
  model text,
  tokens_entrada integer default 0 not null,
  tokens_saida integer default 0 not null,
  custo_centavos integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.ai_suggestions
  add constraint ai_suggestions_pkey PRIMARY KEY (id);
alter table public.ai_suggestions
  add constraint uq_suggestion_id_tenant UNIQUE (id, tenant_id);
alter table public.ai_suggestions
  add constraint ai_suggestions_custo_centavos_check CHECK ((custo_centavos >= 0));
alter table public.ai_suggestions
  add constraint ai_suggestions_kind_check CHECK ((kind = ANY (ARRAY['resposta'::text, 'triagem'::text, 'artigo'::text])));
alter table public.ai_suggestions
  add constraint ai_suggestions_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text));
alter table public.ai_suggestions
  add constraint ai_suggestions_status_check CHECK ((status = ANY (ARRAY['pendente'::text, 'aceita'::text, 'recusada'::text])));
alter table public.ai_suggestions
  add constraint ai_suggestions_tokens_entrada_check CHECK ((tokens_entrada >= 0));
alter table public.ai_suggestions
  add constraint ai_suggestions_tokens_saida_check CHECK ((tokens_saida >= 0));
alter table public.ai_suggestions
  add constraint sug_decidida_tem_autor CHECK ((((status = 'pendente'::text) AND (acted_by IS NULL) AND (acted_at IS NULL)) OR ((status <> 'pendente'::text) AND (acted_by IS NOT NULL) AND (acted_at IS NOT NULL))));

-- --------------------------------------------------------------------------
-- approval_rules
-- --------------------------------------------------------------------------
create table public.approval_rules (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  level integer not null,
  level_name text not null,
  min_amount numeric(14,2) default 0 not null,
  max_amount numeric(14,2),
  cost_center_id uuid,
  branch_id uuid,
  required_profile_id uuid,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.approval_rules
  add constraint approval_rules_pkey PRIMARY KEY (id);
alter table public.approval_rules
  add constraint approval_rules_check CHECK (((max_amount IS NULL) OR (max_amount > min_amount)));
alter table public.approval_rules
  add constraint approval_rules_level_check CHECK (((level >= 1) AND (level <= 9)));
alter table public.approval_rules
  add constraint approval_rules_min_amount_check CHECK ((min_amount >= (0)::numeric));

-- --------------------------------------------------------------------------
-- asset_assignments
-- --------------------------------------------------------------------------
create table public.asset_assignments (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  asset_id uuid not null,
  event_type text not null,
  user_id uuid,
  branch_id uuid,
  started_at timestamp with time zone default clock_timestamp() not null,
  ended_at timestamp with time zone,
  performed_by uuid,
  notes text,
  created_at timestamp with time zone default now() not null,
  previous_user_id uuid,
  previous_branch_id uuid,
  previous_area_id uuid,
  branch_area_id uuid,
  reason text default 'outro'::text not null,
  reason_note text
);
alter table public.asset_assignments
  add constraint asset_assignments_pkey PRIMARY KEY (id);
alter table public.asset_assignments
  add constraint aa_valid_period CHECK (((ended_at IS NULL) OR (ended_at >= started_at)));
alter table public.asset_assignments
  add constraint asset_assignments_event_type_check CHECK ((event_type = ANY (ARRAY['acquisition'::text, 'assignment'::text, 'maintenance'::text, 'relocation'::text, 'return'::text, 'retirement'::text, 'loss'::text])));
alter table public.asset_assignments
  add constraint asset_assignments_reason_check CHECK ((reason = ANY (ARRAY['realocacao'::text, 'devolucao'::text, 'substituicao'::text, 'baixa'::text, 'manutencao'::text, 'aquisicao'::text, 'perda'::text, 'outro'::text])));

-- --------------------------------------------------------------------------
-- asset_attachments
-- --------------------------------------------------------------------------
create table public.asset_attachments (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  asset_id uuid not null,
  category text not null,
  kind text not null,
  storage_path text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint,
  is_primary boolean default false not null,
  thumbnail_path text,
  invoice_ref text,
  uploaded_by uuid,
  created_at timestamp with time zone default now() not null
);
alter table public.asset_attachments
  add constraint asset_attachments_pkey PRIMARY KEY (id);
alter table public.asset_attachments
  add constraint asset_attachments_storage_path_key UNIQUE (storage_path);
alter table public.asset_attachments
  add constraint asset_attachments_category_check CHECK ((category = ANY (ARRAY['document'::text, 'photo'::text])));
alter table public.asset_attachments
  add constraint asset_attachments_kind_check CHECK ((kind = ANY (ARRAY['nfe'::text, 'cte'::text, 'receipt'::text, 'contract'::text, 'warranty'::text, 'photo_front'::text, 'photo_back'::text, 'photo_tag'::text, 'photo_serial'::text, 'photo_other'::text])));
alter table public.asset_attachments
  add constraint asset_attachments_size_bytes_check CHECK ((size_bytes > 0));
alter table public.asset_attachments
  add constraint photo_is_image CHECK (((category <> 'photo'::text) OR (mime_type ~~ 'image/%'::text)));

-- --------------------------------------------------------------------------
-- audit_log
-- --------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity not null,
  tenant_id uuid,
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id text,
  changes jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null
);
alter table public.audit_log
  add constraint audit_log_pkey PRIMARY KEY (id);
alter table public.audit_log
  add constraint audit_log_action_check CHECK ((action = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text])));

-- --------------------------------------------------------------------------
-- auth_tokens
-- --------------------------------------------------------------------------
create table public.auth_tokens (
  id bigint default nextval('auth_tokens_id_seq'::regclass) not null,
  purpose text not null,
  token_hash text not null,
  user_id uuid not null,
  tenant_id uuid,
  email text not null,
  expires_at timestamp with time zone not null,
  used_at timestamp with time zone,
  created_at timestamp with time zone default now() not null
);
alter table public.auth_tokens
  add constraint auth_tokens_pkey PRIMARY KEY (id);
alter table public.auth_tokens
  add constraint auth_tokens_token_hash_key UNIQUE (token_hash);
alter table public.auth_tokens
  add constraint auth_tokens_email_check CHECK ((email ~~ '%@%'::text));
alter table public.auth_tokens
  add constraint auth_tokens_purpose_check CHECK ((purpose = ANY (ARRAY['password_reset'::text, 'email_confirm'::text])));

-- --------------------------------------------------------------------------
-- bank_account_movements
-- --------------------------------------------------------------------------
create table public.bank_account_movements (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  bank_account_id uuid not null,
  direction text not null,
  amount numeric(14,2) not null,
  moved_on date not null,
  description text not null,
  cost_center_id uuid,
  transfer_group uuid,
  reconciled_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.bank_account_movements
  add constraint bank_account_movements_pkey PRIMARY KEY (id);
alter table public.bank_account_movements
  add constraint bank_account_movements_amount_check CHECK ((amount > (0)::numeric));
alter table public.bank_account_movements
  add constraint bank_account_movements_direction_check CHECK ((direction = ANY (ARRAY['in'::text, 'out'::text])));

-- --------------------------------------------------------------------------
-- bank_accounts
-- --------------------------------------------------------------------------
create table public.bank_accounts (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  name text not null,
  bank_code text,
  bank_name text not null,
  agency text,
  account_number text,
  account_type text default 'checking'::text not null,
  holder_name text,
  holder_document text,
  opening_balance numeric(14,2) default 0 not null,
  credit_limit numeric(14,2) default 0 not null,
  status text default 'active'::text not null,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.bank_accounts
  add constraint bank_accounts_pkey PRIMARY KEY (id);
alter table public.bank_accounts
  add constraint uq_bank_accounts_id_tenant UNIQUE (id, tenant_id);
alter table public.bank_accounts
  add constraint bank_accounts_account_type_check CHECK ((account_type = ANY (ARRAY['checking'::text, 'savings'::text, 'payment'::text, 'investment'::text])));
alter table public.bank_accounts
  add constraint bank_accounts_credit_limit_check CHECK ((credit_limit >= (0)::numeric));
alter table public.bank_accounts
  add constraint bank_accounts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'blocked'::text])));

-- --------------------------------------------------------------------------
-- branch_areas
-- --------------------------------------------------------------------------
create table public.branch_areas (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  branch_id uuid not null,
  name text not null,
  code text,
  kind text default 'administrativa'::text not null,
  is_active boolean default true not null,
  sort_order smallint default 100 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.branch_areas
  add constraint branch_areas_pkey PRIMARY KEY (id);
alter table public.branch_areas
  add constraint uq_area_id_tenant UNIQUE (id, tenant_id);
alter table public.branch_areas
  add constraint branch_areas_kind_check CHECK ((kind = ANY (ARRAY['assistencial'::text, 'administrativa'::text, 'apoio'::text, 'tecnica'::text])));
alter table public.branch_areas
  add constraint branch_areas_name_check CHECK ((length(btrim(name)) > 0));

-- --------------------------------------------------------------------------
-- branches
-- --------------------------------------------------------------------------
create table public.branches (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  client_id uuid not null,
  name text not null,
  code text,
  cnpj text,
  address_line text,
  district text,
  city text,
  state character(2),
  postal_code text,
  timezone text default 'America/Sao_Paulo'::text not null,
  contact_name text,
  contact_email text,
  contact_phone text,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone,
  business_hours_id uuid,
  latitude numeric(9,6),
  longitude numeric(9,6),
  geocoded_at timestamp with time zone,
  geocode_source text,
  geocode_precision text,
  geocoded_address text,
  place_id text,
  street text,
  street_number text,
  address_complement text,
  geocode_status text default 'pending'::text not null,
  geocode_stale boolean default false not null,
  geocode_verified_at timestamp with time zone,
  geocode_provider text,
  address_complete boolean generated always as (((street IS NOT NULL) AND (btrim(street) <> ''::text) AND (street_number IS NOT NULL) AND (btrim(street_number) <> ''::text) AND (district IS NOT NULL) AND (btrim(district) <> ''::text) AND (postal_code IS NOT NULL) AND (btrim(postal_code) <> ''::text))) stored
);
alter table public.branches
  add constraint branches_pkey PRIMARY KEY (id);
alter table public.branches
  add constraint uq_branches_id_tenant UNIQUE (id, tenant_id);
alter table public.branches
  add constraint branch_geo_pair CHECK (((latitude IS NULL) = (longitude IS NULL)));
alter table public.branches
  add constraint branches_geocode_precision_check CHECK (((geocode_precision IS NULL) OR (geocode_precision = ANY (ARRAY['rooftop'::text, 'range_interpolated'::text, 'geometric_center'::text, 'approximate'::text, 'manual'::text]))));
alter table public.branches
  add constraint branches_geocode_source_check CHECK (((geocode_source IS NULL) OR (geocode_source = ANY (ARRAY['manual'::text, 'nominatim'::text, 'google'::text, 'mapbox'::text]))));
alter table public.branches
  add constraint branches_geocode_status_check CHECK ((geocode_status = ANY (ARRAY['pending'::text, 'ok'::text, 'low_precision'::text, 'missing_fields'::text, 'inconsistent'::text, 'multiple'::text, 'not_found'::text, 'service_unavailable'::text])));
alter table public.branches
  add constraint branches_latitude_check CHECK (((latitude IS NULL) OR ((latitude >= ('-90'::integer)::numeric) AND (latitude <= (90)::numeric))));
alter table public.branches
  add constraint branches_longitude_check CHECK (((longitude IS NULL) OR ((longitude >= ('-180'::integer)::numeric) AND (longitude <= (180)::numeric))));
alter table public.branches
  add constraint branches_postal_code_format CHECK (((postal_code IS NULL) OR (postal_code ~ '^[0-9]{5}-[0-9]{3}$'::text)));

-- --------------------------------------------------------------------------
-- business_hours
-- --------------------------------------------------------------------------
create table public.business_hours (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  name text not null,
  timezone text default 'America/Sao_Paulo'::text not null,
  is_24x7 boolean default false not null,
  is_default boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.business_hours
  add constraint business_hours_pkey PRIMARY KEY (id);
alter table public.business_hours
  add constraint uq_business_hours_id_tenant UNIQUE (id, tenant_id);

-- --------------------------------------------------------------------------
-- business_hours_holidays
-- --------------------------------------------------------------------------
create table public.business_hours_holidays (
  id uuid default gen_random_uuid() not null,
  business_hours_id uuid not null,
  holiday_date date not null,
  name text not null
);
alter table public.business_hours_holidays
  add constraint business_hours_holidays_pkey PRIMARY KEY (id);
alter table public.business_hours_holidays
  add constraint uq_holiday UNIQUE (business_hours_id, holiday_date);

-- --------------------------------------------------------------------------
-- business_hours_intervals
-- --------------------------------------------------------------------------
create table public.business_hours_intervals (
  id uuid default gen_random_uuid() not null,
  business_hours_id uuid not null,
  weekday smallint not null,
  starts_at time without time zone not null,
  ends_at time without time zone not null
);
alter table public.business_hours_intervals
  add constraint business_hours_intervals_pkey PRIMARY KEY (id);
alter table public.business_hours_intervals
  add constraint uq_bhi_slot UNIQUE (business_hours_id, weekday, starts_at);
alter table public.business_hours_intervals
  add constraint bhi_valid_range CHECK ((ends_at > starts_at));
alter table public.business_hours_intervals
  add constraint business_hours_intervals_weekday_check CHECK (((weekday >= 0) AND (weekday <= 6)));

-- --------------------------------------------------------------------------
-- channel_contacts
-- --------------------------------------------------------------------------
create table public.channel_contacts (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  channel_id uuid not null,
  external_id text not null,
  display_name text,
  profile_id uuid,
  client_id uuid,
  branch_id uuid,
  bloqueado boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.channel_contacts
  add constraint channel_contacts_pkey PRIMARY KEY (id);
alter table public.channel_contacts
  add constraint uq_contact_id_tenant UNIQUE (id, tenant_id);
alter table public.channel_contacts
  add constraint uq_contact_no_canal UNIQUE (channel_id, external_id);
alter table public.channel_contacts
  add constraint channel_contacts_external_id_check CHECK (((length(TRIM(BOTH FROM external_id)) >= 1) AND (length(TRIM(BOTH FROM external_id)) <= 200)));

-- --------------------------------------------------------------------------
-- channel_conversations
-- --------------------------------------------------------------------------
create table public.channel_conversations (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  channel_id uuid not null,
  contact_id uuid not null,
  ticket_id uuid,
  status text default 'aberta'::text not null,
  external_thread_id text,
  last_message_at timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.channel_conversations
  add constraint channel_conversations_pkey PRIMARY KEY (id);
alter table public.channel_conversations
  add constraint uq_conversation_id_tenant UNIQUE (id, tenant_id);
alter table public.channel_conversations
  add constraint channel_conversations_status_check CHECK ((status = ANY (ARRAY['aberta'::text, 'fechada'::text])));

-- --------------------------------------------------------------------------
-- channel_messages
-- --------------------------------------------------------------------------
create table public.channel_messages (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  channel_id uuid not null,
  conversation_id uuid,
  direction text not null,
  external_id text,
  body text,
  media jsonb default '[]'::jsonb not null,
  status text default 'recebida'::text not null,
  attempts integer default 0 not null,
  last_error text,
  scheduled_for timestamp with time zone default now() not null,
  sent_at timestamp with time zone,
  comment_id uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.channel_messages
  add constraint channel_messages_pkey PRIMARY KEY (id);
alter table public.channel_messages
  add constraint channel_messages_attempts_check CHECK ((attempts >= 0));
alter table public.channel_messages
  add constraint channel_messages_direction_check CHECK ((direction = ANY (ARRAY['entrada'::text, 'saida'::text])));
alter table public.channel_messages
  add constraint channel_messages_media_check CHECK ((jsonb_typeof(media) = 'array'::text));
alter table public.channel_messages
  add constraint channel_messages_status_check CHECK ((status = ANY (ARRAY['recebida'::text, 'na_fila'::text, 'enviada'::text, 'falhou'::text, 'ignorada'::text])));
alter table public.channel_messages
  add constraint msg_enviada_tem_data CHECK (((status <> 'enviada'::text) OR (sent_at IS NOT NULL)));

-- --------------------------------------------------------------------------
-- channels
-- --------------------------------------------------------------------------
create table public.channels (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  name text not null,
  kind text not null,
  status text default 'ativo'::text not null,
  inbound_token_hash text not null,
  outbound_url text,
  secret_ref text,
  config jsonb default '{}'::jsonb not null,
  default_queue_id uuid,
  default_priority_id uuid,
  default_client_id uuid,
  abre_chamado boolean default true not null,
  last_inbound_at timestamp with time zone,
  last_outbound_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.channels
  add constraint channels_pkey PRIMARY KEY (id);
alter table public.channels
  add constraint channels_inbound_token_hash_key UNIQUE (inbound_token_hash);
alter table public.channels
  add constraint uq_channel_id_tenant UNIQUE (id, tenant_id);
alter table public.channels
  add constraint channel_abre_precisa_de_destino CHECK (((NOT abre_chamado) OR ((default_queue_id IS NOT NULL) AND (default_priority_id IS NOT NULL))));
alter table public.channels
  add constraint channels_config_check CHECK ((jsonb_typeof(config) = 'object'::text));
alter table public.channels
  add constraint channels_kind_check CHECK ((kind = ANY (ARRAY['whatsapp'::text, 'email'::text, 'bitrix24'::text, 'n8n'::text])));
alter table public.channels
  add constraint channels_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 2) AND (length(TRIM(BOTH FROM name)) <= 120)));
alter table public.channels
  add constraint channels_outbound_url_check CHECK (((outbound_url IS NULL) OR (outbound_url ~~ 'https://%'::text)));
alter table public.channels
  add constraint channels_secret_ref_check CHECK (((secret_ref IS NULL) OR (secret_ref ~ '^[A-Z][A-Z0-9_]{2,60}$'::text)));
alter table public.channels
  add constraint channels_status_check CHECK ((status = ANY (ARRAY['ativo'::text, 'pausado'::text, 'erro'::text])));

-- --------------------------------------------------------------------------
-- clients
-- --------------------------------------------------------------------------
create table public.clients (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  legal_name text not null,
  trade_name text,
  cnpj text,
  contract_ref text,
  status text default 'active'::text not null,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone,
  color text default '#64748b'::text not null
);
alter table public.clients
  add constraint clients_pkey PRIMARY KEY (id);
alter table public.clients
  add constraint uq_clients_id_tenant UNIQUE (id, tenant_id);
alter table public.clients
  add constraint clients_color_hex CHECK ((color ~ '^#[0-9a-fA-F]{6}$'::text));
alter table public.clients
  add constraint clients_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'prospect'::text])));

-- --------------------------------------------------------------------------
-- cost_centers
-- --------------------------------------------------------------------------
create table public.cost_centers (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  parent_id uuid,
  code text not null,
  name text not null,
  description text,
  branch_id uuid,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.cost_centers
  add constraint cost_centers_pkey PRIMARY KEY (id);
alter table public.cost_centers
  add constraint uq_cost_centers_id_tenant UNIQUE (id, tenant_id);
alter table public.cost_centers
  add constraint cost_centers_no_self_parent CHECK (((parent_id IS NULL) OR (parent_id <> id)));

-- --------------------------------------------------------------------------
-- dashboard_layouts
-- --------------------------------------------------------------------------
create table public.dashboard_layouts (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  name text not null,
  slug text not null,
  config jsonb default '{}'::jsonb not null,
  refresh_seconds smallint default 45 not null,
  is_default boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.dashboard_layouts
  add constraint dashboard_layouts_pkey PRIMARY KEY (id);
alter table public.dashboard_layouts
  add constraint uq_layout_id_tenant UNIQUE (id, tenant_id);
alter table public.dashboard_layouts
  add constraint uq_layout_slug UNIQUE (tenant_id, slug);
alter table public.dashboard_layouts
  add constraint dashboard_layouts_refresh_seconds_check CHECK (((refresh_seconds >= 10) AND (refresh_seconds <= 600)));
alter table public.dashboard_layouts
  add constraint layout_config_object CHECK ((jsonb_typeof(config) = 'object'::text));

-- --------------------------------------------------------------------------
-- dashboard_tokens
-- --------------------------------------------------------------------------
create table public.dashboard_tokens (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  layout_id uuid,
  name text not null,
  token_hash text not null,
  branch_ids uuid[] default '{}'::uuid[] not null,
  expires_at timestamp with time zone,
  revoked_at timestamp with time zone,
  last_used_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.dashboard_tokens
  add constraint dashboard_tokens_pkey PRIMARY KEY (id);
alter table public.dashboard_tokens
  add constraint dashboard_tokens_token_hash_key UNIQUE (token_hash);

-- --------------------------------------------------------------------------
-- email_outbox
-- --------------------------------------------------------------------------
create table public.email_outbox (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  to_email text not null,
  to_name text,
  subject text not null,
  body_text text not null,
  kind text not null,
  ticket_id uuid,
  dedupe_key text,
  status text default 'pending'::text not null,
  attempts integer default 0 not null,
  last_error text,
  scheduled_for timestamp with time zone default now() not null,
  sent_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.email_outbox
  add constraint email_outbox_pkey PRIMARY KEY (id);
alter table public.email_outbox
  add constraint email_outbox_attempts_check CHECK ((attempts >= 0));
alter table public.email_outbox
  add constraint email_outbox_kind_check CHECK ((kind = ANY (ARRAY['sla_warning'::text, 'sla_critical'::text, 'sla_breach'::text, 'satisfaction_invite'::text, 'ticket_assigned'::text, 'test'::text, 'agent_alert'::text, 'contract_expiring'::text, 'link_down'::text, 'link_restored'::text, 'password_reset'::text, 'email_confirm'::text, 'signup_existing'::text, 'invite'::text, 'trial_ending'::text, 'trial_ended'::text])));
alter table public.email_outbox
  add constraint email_outbox_sent_has_date CHECK (((status <> 'sent'::text) OR (sent_at IS NOT NULL)));
alter table public.email_outbox
  add constraint email_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'skipped'::text])));
alter table public.email_outbox
  add constraint email_outbox_subject_check CHECK (((length(subject) >= 1) AND (length(subject) <= 200)));
alter table public.email_outbox
  add constraint email_outbox_to_email_check CHECK ((to_email ~~ '%@%'::text));

-- --------------------------------------------------------------------------
-- equipment_categories
-- --------------------------------------------------------------------------
create table public.equipment_categories (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  code text not null,
  name text not null,
  default_meter_kind text default 'none'::text not null,
  default_useful_life_months integer,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.equipment_categories
  add constraint equipment_categories_pkey PRIMARY KEY (id);
alter table public.equipment_categories
  add constraint equipment_categories_default_meter_kind_check CHECK ((default_meter_kind = ANY (ARRAY['none'::text, 'hours'::text, 'cycles'::text, 'distance'::text])));
alter table public.equipment_categories
  add constraint equipment_categories_default_useful_life_months_check CHECK (((default_useful_life_months IS NULL) OR ((default_useful_life_months >= 1) AND (default_useful_life_months <= 600))));

-- --------------------------------------------------------------------------
-- equipment_manufacturers
-- --------------------------------------------------------------------------
create table public.equipment_manufacturers (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  name text not null,
  support_contact text,
  notes text,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.equipment_manufacturers
  add constraint equipment_manufacturers_pkey PRIMARY KEY (id);

-- --------------------------------------------------------------------------
-- equipment_models
-- --------------------------------------------------------------------------
create table public.equipment_models (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  manufacturer_id uuid not null,
  category_id uuid not null,
  code text not null,
  name text not null,
  specs jsonb default '{}'::jsonb not null,
  monthly_price numeric(14,2),
  daily_price numeric(14,2),
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.equipment_models
  add constraint equipment_models_pkey PRIMARY KEY (id);
alter table public.equipment_models
  add constraint equipment_models_daily_price_check CHECK (((daily_price IS NULL) OR (daily_price >= (0)::numeric)));
alter table public.equipment_models
  add constraint equipment_models_monthly_price_check CHECK (((monthly_price IS NULL) OR (monthly_price >= (0)::numeric)));

-- --------------------------------------------------------------------------
-- expense_categories
-- --------------------------------------------------------------------------
create table public.expense_categories (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  code text not null,
  name text not null,
  requires_supplier boolean default false not null,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.expense_categories
  add constraint expense_categories_pkey PRIMARY KEY (id);
alter table public.expense_categories
  add constraint uq_expense_categories_id_tenant UNIQUE (id, tenant_id);

-- --------------------------------------------------------------------------
-- geocode_candidates
-- --------------------------------------------------------------------------
create table public.geocode_candidates (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  branch_id uuid not null,
  ordinal smallint not null,
  latitude numeric(10,7) not null,
  longitude numeric(10,7) not null,
  formatted_address text not null,
  precision text not null,
  place_id text,
  created_at timestamp with time zone default now() not null
);
alter table public.geocode_candidates
  add constraint geocode_candidates_pkey PRIMARY KEY (id);
alter table public.geocode_candidates
  add constraint uq_geocode_candidates UNIQUE (branch_id, ordinal);
alter table public.geocode_candidates
  add constraint geocode_candidates_lat_check CHECK (((latitude >= ('-90'::integer)::numeric) AND (latitude <= (90)::numeric)));
alter table public.geocode_candidates
  add constraint geocode_candidates_lng_check CHECK (((longitude >= ('-180'::integer)::numeric) AND (longitude <= (180)::numeric)));
alter table public.geocode_candidates
  add constraint geocode_candidates_precision_check CHECK (("precision" = ANY (ARRAY['rooftop'::text, 'range_interpolated'::text, 'geometric_center'::text, 'approximate'::text, 'manual'::text])));

-- --------------------------------------------------------------------------
-- geocode_logs
-- --------------------------------------------------------------------------
create table public.geocode_logs (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  branch_id uuid not null,
  requested_by uuid,
  input_address jsonb not null,
  status text not null,
  provider text,
  latitude numeric(10,7),
  longitude numeric(10,7),
  formatted_address text,
  precision text,
  candidates jsonb default '[]'::jsonb not null,
  message text,
  report_text text,
  created_at timestamp with time zone default clock_timestamp() not null
);
alter table public.geocode_logs
  add constraint geocode_logs_pkey PRIMARY KEY (id);
alter table public.geocode_logs
  add constraint geocode_logs_precision_check CHECK ((("precision" IS NULL) OR ("precision" = ANY (ARRAY['rooftop'::text, 'range_interpolated'::text, 'geometric_center'::text, 'approximate'::text, 'manual'::text]))));
alter table public.geocode_logs
  add constraint geocode_logs_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'low_precision'::text, 'missing_fields'::text, 'inconsistent'::text, 'multiple'::text, 'not_found'::text, 'service_unavailable'::text])));

-- --------------------------------------------------------------------------
-- import_batches
-- --------------------------------------------------------------------------
create table public.import_batches (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  resource text not null,
  file_name text not null,
  file_bytes integer not null,
  status text default 'preview'::text not null,
  on_conflict text default 'update'::text not null,
  column_map jsonb default '{}'::jsonb not null,
  total_rows integer default 0 not null,
  created_rows integer default 0 not null,
  updated_rows integer default 0 not null,
  skipped_rows integer default 0 not null,
  rejected_rows integer default 0 not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  applied_at timestamp with time zone,
  updated_at timestamp with time zone default now() not null
);
alter table public.import_batches
  add constraint import_batches_pkey PRIMARY KEY (id);
alter table public.import_batches
  add constraint import_batches_created_rows_check CHECK ((created_rows >= 0));
alter table public.import_batches
  add constraint import_batches_file_bytes_check CHECK ((file_bytes >= 0));
alter table public.import_batches
  add constraint import_batches_on_conflict_check CHECK ((on_conflict = ANY (ARRAY['update'::text, 'skip'::text])));
alter table public.import_batches
  add constraint import_batches_rejected_rows_check CHECK ((rejected_rows >= 0));
alter table public.import_batches
  add constraint import_batches_skipped_rows_check CHECK ((skipped_rows >= 0));
alter table public.import_batches
  add constraint import_batches_status_check CHECK ((status = ANY (ARRAY['preview'::text, 'applied'::text, 'discarded'::text])));
alter table public.import_batches
  add constraint import_batches_total_rows_check CHECK ((total_rows >= 0));
alter table public.import_batches
  add constraint import_batches_updated_rows_check CHECK ((updated_rows >= 0));

-- --------------------------------------------------------------------------
-- import_rows
-- --------------------------------------------------------------------------
create table public.import_rows (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  batch_id uuid not null,
  line_number integer not null,
  raw jsonb not null,
  outcome text not null,
  reason text,
  record_id uuid,
  created_at timestamp with time zone default now() not null
);
alter table public.import_rows
  add constraint import_rows_pkey PRIMARY KEY (id);
alter table public.import_rows
  add constraint import_rows_line_number_check CHECK ((line_number >= 1));
alter table public.import_rows
  add constraint import_rows_outcome_check CHECK ((outcome = ANY (ARRAY['create'::text, 'update'::text, 'skip'::text, 'reject'::text])));
alter table public.import_rows
  add constraint import_rows_recusa_tem_motivo CHECK ((((outcome = 'reject'::text) AND (reason IS NOT NULL)) OR ((outcome <> 'reject'::text) AND (reason IS NULL))));

-- --------------------------------------------------------------------------
-- integration_events
-- --------------------------------------------------------------------------
create table public.integration_events (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  integration_id uuid not null,
  event_key text not null,
  event_type text,
  external_id text,
  payload jsonb default '{}'::jsonb not null,
  status text default 'pending'::text not null,
  attempts smallint default 0 not null,
  last_error text,
  ticket_id uuid,
  received_at timestamp with time zone default now() not null,
  processed_at timestamp with time zone
);
alter table public.integration_events
  add constraint integration_events_pkey PRIMARY KEY (id);
alter table public.integration_events
  add constraint uq_integration_event UNIQUE (integration_id, event_key);
alter table public.integration_events
  add constraint integration_events_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processed'::text, 'failed'::text, 'skipped_echo'::text, 'ignored'::text])));

-- --------------------------------------------------------------------------
-- integration_logs
-- --------------------------------------------------------------------------
create table public.integration_logs (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  integration_id uuid not null,
  event_id uuid,
  direction text not null,
  method text,
  endpoint text,
  request_payload jsonb,
  response_status integer,
  response_body text,
  duration_ms integer,
  outcome text default 'ok'::text not null,
  error_message text,
  created_at timestamp with time zone default now() not null
);
alter table public.integration_logs
  add constraint integration_logs_pkey PRIMARY KEY (id);
alter table public.integration_logs
  add constraint integration_logs_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text])));
alter table public.integration_logs
  add constraint integration_logs_duration_ms_check CHECK (((duration_ms IS NULL) OR (duration_ms >= 0)));
alter table public.integration_logs
  add constraint integration_logs_outcome_check CHECK ((outcome = ANY (ARRAY['ok'::text, 'error'::text, 'retry'::text, 'skipped_echo'::text, 'duplicate'::text])));

-- --------------------------------------------------------------------------
-- integration_mapping_versions
-- --------------------------------------------------------------------------
create table public.integration_mapping_versions (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  integration_id uuid not null,
  version integer not null,
  snapshot jsonb not null,
  note text,
  created_by uuid,
  created_at timestamp with time zone default now() not null
);
alter table public.integration_mapping_versions
  add constraint integration_mapping_versions_pkey PRIMARY KEY (id);
alter table public.integration_mapping_versions
  add constraint uq_mapping_version UNIQUE (integration_id, version);
alter table public.integration_mapping_versions
  add constraint snapshot_is_array CHECK ((jsonb_typeof(snapshot) = 'array'::text));

-- --------------------------------------------------------------------------
-- integration_mappings
-- --------------------------------------------------------------------------
create table public.integration_mappings (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  integration_id uuid not null,
  source_path text not null,
  target_field text not null,
  transform text default 'direct'::text not null,
  value_map jsonb default '{}'::jsonb not null,
  default_value text,
  is_required boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.integration_mappings
  add constraint integration_mappings_pkey PRIMARY KEY (id);
alter table public.integration_mappings
  add constraint uq_im_target UNIQUE (integration_id, target_field);
alter table public.integration_mappings
  add constraint im_value_map_object CHECK ((jsonb_typeof(value_map) = 'object'::text));
alter table public.integration_mappings
  add constraint integration_mappings_transform_check CHECK ((transform = ANY (ARRAY['direct'::text, 'value_map'::text, 'datetime'::text, 'user_by_email'::text, 'user_by_external_id'::text, 'queue_by_external_id'::text, 'constant'::text, 'html_to_text'::text])));

-- --------------------------------------------------------------------------
-- integration_sync_state
-- --------------------------------------------------------------------------
create table public.integration_sync_state (
  integration_id uuid not null,
  ticket_id uuid not null,
  tenant_id uuid not null,
  external_id text,
  last_outbound_hash text,
  last_outbound_at timestamp with time zone,
  last_inbound_hash text,
  last_inbound_at timestamp with time zone
);
alter table public.integration_sync_state
  add constraint integration_sync_state_pkey PRIMARY KEY (integration_id, ticket_id);

-- --------------------------------------------------------------------------
-- integrations
-- --------------------------------------------------------------------------
create table public.integrations (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  name text not null,
  slug text not null,
  source_system text not null,
  direction text default 'inbound'::text not null,
  status text default 'paused'::text not null,
  auth_type text default 'webhook_token'::text not null,
  secret_ref text,
  inbound_token_hash text,
  base_url text,
  config jsonb default '{}'::jsonb not null,
  reverse_sync_enabled boolean default false not null,
  echo_window_seconds integer default 120 not null,
  polling_enabled boolean default false not null,
  polling_interval_secs integer,
  last_sync_at timestamp with time zone,
  request_count bigint default 0 not null,
  error_count bigint default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  polling_endpoint text,
  auth_header_name text,
  secret_ref_pending text,
  secret_rotated_at timestamp with time zone,
  last_test_at timestamp with time zone,
  last_test_ok boolean
);
alter table public.integrations
  add constraint integrations_pkey PRIMARY KEY (id);
alter table public.integrations
  add constraint uq_integration_id_tenant UNIQUE (id, tenant_id);
alter table public.integrations
  add constraint uq_integration_slug UNIQUE (tenant_id, slug);
alter table public.integrations
  add constraint integration_config_object CHECK ((jsonb_typeof(config) = 'object'::text));
alter table public.integrations
  add constraint integration_polling_needs_interval CHECK (((NOT polling_enabled) OR (polling_interval_secs IS NOT NULL)));
alter table public.integrations
  add constraint integrations_auth_type_check CHECK ((auth_type = ANY (ARRAY['none'::text, 'webhook_token'::text, 'api_key'::text, 'oauth2'::text, 'hmac'::text])));
alter table public.integrations
  add constraint integrations_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text, 'bidirectional'::text])));
alter table public.integrations
  add constraint integrations_echo_window_seconds_check CHECK ((echo_window_seconds >= 0));
alter table public.integrations
  add constraint integrations_polling_interval_secs_check CHECK (((polling_interval_secs IS NULL) OR (polling_interval_secs >= 60)));
alter table public.integrations
  add constraint integrations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'error'::text])));

-- --------------------------------------------------------------------------
-- internet_link_attachments
-- --------------------------------------------------------------------------
create table public.internet_link_attachments (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  link_id uuid not null,
  kind text not null,
  storage_path text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint,
  valid_until date,
  uploaded_by uuid,
  created_at timestamp with time zone default now() not null
);
alter table public.internet_link_attachments
  add constraint internet_link_attachments_pkey PRIMARY KEY (id);
alter table public.internet_link_attachments
  add constraint internet_link_attachments_storage_path_key UNIQUE (storage_path);
alter table public.internet_link_attachments
  add constraint internet_link_attachments_kind_check CHECK ((kind = ANY (ARRAY['contract'::text, 'amendment'::text, 'loyalty_term'::text, 'cancellation'::text, 'installation_report'::text, 'other'::text])));
alter table public.internet_link_attachments
  add constraint internet_link_attachments_size_bytes_check CHECK ((size_bytes > 0));

-- --------------------------------------------------------------------------
-- internet_links
-- --------------------------------------------------------------------------
create table public.internet_links (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  branch_id uuid not null,
  branch_area_id uuid,
  contract_number text,
  supplier_id uuid,
  carrier_name text,
  technology text not null,
  download_mbps integer,
  upload_mbps integer,
  guaranteed_mbps integer,
  has_static_ip boolean default false not null,
  static_ip inet,
  cpe_brand text,
  cpe_model text,
  cpe_serial text,
  cpe_asset_id uuid,
  status text default 'active'::text not null,
  monthly_cost numeric(12,2),
  activated_on date,
  cancelled_on date,
  contract_start date,
  contract_end date,
  loyalty_until date,
  monitoring_host text,
  monitoring_external_id text,
  last_state text default 'unknown'::text not null,
  last_state_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.internet_links
  add constraint internet_links_pkey PRIMARY KEY (id);
alter table public.internet_links
  add constraint uq_link_id_tenant UNIQUE (id, tenant_id);
alter table public.internet_links
  add constraint internet_links_download_mbps_check CHECK (((download_mbps IS NULL) OR (download_mbps > 0)));
alter table public.internet_links
  add constraint internet_links_guaranteed_mbps_check CHECK (((guaranteed_mbps IS NULL) OR (guaranteed_mbps > 0)));
alter table public.internet_links
  add constraint internet_links_last_state_check CHECK ((last_state = ANY (ARRAY['up'::text, 'down'::text, 'unknown'::text])));
alter table public.internet_links
  add constraint internet_links_monthly_cost_check CHECK (((monthly_cost IS NULL) OR (monthly_cost >= (0)::numeric)));
alter table public.internet_links
  add constraint internet_links_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'cancelled'::text])));
alter table public.internet_links
  add constraint internet_links_technology_check CHECK ((technology = ANY (ARRAY['fiber'::text, 'radio'::text, 'satellite'::text, 'mobile_4g'::text, 'mobile_5g'::text, 'xdsl'::text, 'other'::text])));
alter table public.internet_links
  add constraint internet_links_upload_mbps_check CHECK (((upload_mbps IS NULL) OR (upload_mbps > 0)));
alter table public.internet_links
  add constraint link_cancel_needs_date CHECK (((status <> 'cancelled'::text) OR (cancelled_on IS NOT NULL)));
alter table public.internet_links
  add constraint link_contract_period CHECK (((contract_end IS NULL) OR (contract_start IS NULL) OR (contract_end >= contract_start)));
alter table public.internet_links
  add constraint link_has_carrier CHECK (((supplier_id IS NOT NULL) OR (carrier_name IS NOT NULL)));
alter table public.internet_links
  add constraint link_static_ip_pair CHECK (((NOT has_static_ip) OR (static_ip IS NOT NULL)));

-- --------------------------------------------------------------------------
-- inventory_count_items
-- --------------------------------------------------------------------------
create table public.inventory_count_items (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  count_id uuid not null,
  part_id uuid not null,
  expected_quantity numeric(14,3) not null,
  counted_quantity numeric(14,3),
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.inventory_count_items
  add constraint inventory_count_items_pkey PRIMARY KEY (id);

-- --------------------------------------------------------------------------
-- inventory_counts
-- --------------------------------------------------------------------------
create table public.inventory_counts (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  depot_id uuid not null,
  code text not null,
  status text default 'open'::text not null,
  counted_on date default CURRENT_DATE not null,
  closed_at timestamp with time zone,
  closed_by uuid,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.inventory_counts
  add constraint inventory_counts_pkey PRIMARY KEY (id);
alter table public.inventory_counts
  add constraint inventory_counts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text, 'cancelled'::text])));

-- --------------------------------------------------------------------------
-- invites
-- --------------------------------------------------------------------------
create table public.invites (
  id bigint default nextval('invites_id_seq'::regclass) not null,
  tenant_id uuid not null,
  email text not null,
  role text not null,
  token_hash text not null,
  invited_by uuid,
  expires_at timestamp with time zone not null,
  accepted_at timestamp with time zone,
  revoked_at timestamp with time zone,
  created_at timestamp with time zone default now() not null
);
alter table public.invites
  add constraint invites_pkey PRIMARY KEY (id);
alter table public.invites
  add constraint invites_token_hash_key UNIQUE (token_hash);
alter table public.invites
  add constraint invites_email_check CHECK ((email ~~ '%@%'::text));
alter table public.invites
  add constraint invites_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'gestor'::text, 'atendente'::text, 'solicitante'::text])));

-- --------------------------------------------------------------------------
-- it_assets
-- --------------------------------------------------------------------------
create table public.it_assets (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  asset_tag text,
  serial_number text,
  asset_type text not null,
  brand text,
  model text,
  specs jsonb default '{}'::jsonb not null,
  status text default 'in_stock'::text not null,
  branch_id uuid,
  assigned_user_id uuid,
  supplier_id uuid,
  acquisition_date date,
  warranty_until date,
  acquisition_cost numeric(14,2),
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone,
  branch_area_id uuid
);
alter table public.it_assets
  add constraint it_assets_pkey PRIMARY KEY (id);
alter table public.it_assets
  add constraint uq_asset_id_tenant UNIQUE (id, tenant_id);
alter table public.it_assets
  add constraint asset_warranty_after_acquisition CHECK (((warranty_until IS NULL) OR (acquisition_date IS NULL) OR (warranty_until >= acquisition_date)));
alter table public.it_assets
  add constraint it_assets_acquisition_cost_check CHECK (((acquisition_cost IS NULL) OR (acquisition_cost >= (0)::numeric)));
alter table public.it_assets
  add constraint it_assets_asset_type_check CHECK ((asset_type = ANY (ARRAY['notebook'::text, 'desktop'::text, 'server'::text, 'smartphone'::text, 'tablet'::text, 'monitor'::text, 'printer'::text, 'peripheral'::text, 'network'::text, 'software_license'::text, 'other'::text])));
alter table public.it_assets
  add constraint it_assets_status_check CHECK ((status = ANY (ARRAY['in_stock'::text, 'active'::text, 'maintenance'::text, 'retired'::text, 'lost'::text])));

-- --------------------------------------------------------------------------
-- it_budget_closings
-- --------------------------------------------------------------------------
create table public.it_budget_closings (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  client_id uuid not null,
  competence date not null,
  closed_at timestamp with time zone default now() not null,
  closed_by uuid,
  note text,
  reopened_at timestamp with time zone,
  reopened_by uuid,
  reopen_reason text
);
alter table public.it_budget_closings
  add constraint it_budget_closings_pkey PRIMARY KEY (id);
alter table public.it_budget_closings
  add constraint uq_closing UNIQUE (client_id, competence);
alter table public.it_budget_closings
  add constraint closing_reabrir_tem_motivo CHECK (((reopened_at IS NULL) OR ((reopened_by IS NOT NULL) AND (reopen_reason IS NOT NULL))));
alter table public.it_budget_closings
  add constraint it_budget_closings_competence_check CHECK (app.eh_competencia(competence));

-- --------------------------------------------------------------------------
-- it_budget_scenarios
-- --------------------------------------------------------------------------
create table public.it_budget_scenarios (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  client_id uuid not null,
  key text not null,
  name text not null,
  description text,
  created_at timestamp with time zone default now() not null
);
alter table public.it_budget_scenarios
  add constraint it_budget_scenarios_pkey PRIMARY KEY (id);
alter table public.it_budget_scenarios
  add constraint uq_scenario_id_tenant UNIQUE (id, tenant_id);
alter table public.it_budget_scenarios
  add constraint uq_scenario_key UNIQUE (client_id, key);
alter table public.it_budget_scenarios
  add constraint it_budget_scenarios_key_check CHECK ((key ~ '^[a-z][a-z0-9_]{1,40}$'::text));
alter table public.it_budget_scenarios
  add constraint it_budget_scenarios_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 2) AND (length(TRIM(BOTH FROM name)) <= 80)));

-- --------------------------------------------------------------------------
-- it_budget_targets
-- --------------------------------------------------------------------------
create table public.it_budget_targets (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  client_id uuid not null,
  name text not null,
  expense_category_id uuid,
  branch_id uuid,
  monthly_cap numeric(14,2) not null,
  valid_from date,
  valid_until date,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.it_budget_targets
  add constraint it_budget_targets_pkey PRIMARY KEY (id);
alter table public.it_budget_targets
  add constraint uq_target_nome UNIQUE (client_id, name);
alter table public.it_budget_targets
  add constraint it_budget_targets_monthly_cap_check CHECK ((monthly_cap >= (0)::numeric));
alter table public.it_budget_targets
  add constraint it_budget_targets_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 2) AND (length(TRIM(BOTH FROM name)) <= 120)));
alter table public.it_budget_targets
  add constraint it_budget_targets_valid_from_check CHECK (((valid_from IS NULL) OR app.eh_competencia(valid_from)));
alter table public.it_budget_targets
  add constraint it_budget_targets_valid_until_check CHECK (((valid_until IS NULL) OR app.eh_competencia(valid_until)));
alter table public.it_budget_targets
  add constraint target_vigencia_coerente CHECK (((valid_until IS NULL) OR (valid_from IS NULL) OR (valid_until >= valid_from)));

-- --------------------------------------------------------------------------
-- it_cost_beneficiaries
-- --------------------------------------------------------------------------
create table public.it_cost_beneficiaries (
  entry_id uuid not null,
  branch_id uuid not null,
  tenant_id uuid not null
);
alter table public.it_cost_beneficiaries
  add constraint it_cost_beneficiaries_pkey PRIMARY KEY (entry_id, branch_id);

-- --------------------------------------------------------------------------
-- it_cost_entries
-- --------------------------------------------------------------------------
create table public.it_cost_entries (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  client_id uuid not null,
  branch_id uuid,
  expense_category_id uuid not null,
  cost_center_id uuid,
  supplier_id uuid,
  competence date not null,
  amount numeric(14,2) not null,
  description text,
  notes text,
  natureza text not null,
  classificacao text not null,
  installment_number integer,
  installment_total integer,
  parent_entry_id uuid,
  recurrence_until date,
  consumo text default 'integral'::text not null,
  scenario_id uuid not null,
  origem text default 'manual'::text not null,
  payable_id uuid,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.it_cost_entries
  add constraint it_cost_entries_pkey PRIMARY KEY (id);
alter table public.it_cost_entries
  add constraint uq_entry_id_tenant UNIQUE (id, tenant_id);
alter table public.it_cost_entries
  add constraint entry_parcela_cabe_no_total CHECK (((installment_number IS NULL) OR (installment_total IS NULL) OR (installment_number <= installment_total)));
alter table public.it_cost_entries
  add constraint entry_parcelada_tem_total CHECK (((natureza <> 'pontual_parcelada'::text) OR (installment_total IS NOT NULL)));
alter table public.it_cost_entries
  add constraint entry_titulo_tem_referencia CHECK (((origem <> 'titulo_a_pagar'::text) OR (payable_id IS NOT NULL)));
alter table public.it_cost_entries
  add constraint it_cost_entries_amount_check CHECK ((amount >= (0)::numeric));
alter table public.it_cost_entries
  add constraint it_cost_entries_classificacao_check CHECK ((classificacao = ANY (ARRAY['despesa'::text, 'investimento'::text])));
alter table public.it_cost_entries
  add constraint it_cost_entries_competence_check CHECK (app.eh_competencia(competence));
alter table public.it_cost_entries
  add constraint it_cost_entries_consumo_check CHECK ((consumo = ANY (ARRAY['integral'::text, 'compartilhado'::text])));
alter table public.it_cost_entries
  add constraint it_cost_entries_installment_number_check CHECK (((installment_number IS NULL) OR (installment_number >= 1)));
alter table public.it_cost_entries
  add constraint it_cost_entries_installment_total_check CHECK (((installment_total IS NULL) OR (installment_total >= 1)));
alter table public.it_cost_entries
  add constraint it_cost_entries_natureza_check CHECK ((natureza = ANY (ARRAY['fixa'::text, 'pontual_unica'::text, 'pontual_parcelada'::text])));
alter table public.it_cost_entries
  add constraint it_cost_entries_origem_check CHECK ((origem = ANY (ARRAY['manual'::text, 'planilha'::text, 'projecao'::text, 'titulo_a_pagar'::text])));
alter table public.it_cost_entries
  add constraint it_cost_entries_recurrence_until_check CHECK (((recurrence_until IS NULL) OR app.eh_competencia(recurrence_until)));

-- --------------------------------------------------------------------------
-- job_alert_episodes
-- --------------------------------------------------------------------------
create table public.job_alert_episodes (
  id bigint default nextval('job_alert_episodes_id_seq'::regclass) not null,
  job text not null,
  tipo text not null,
  aberto_em timestamp with time zone default now() not null,
  fechado_em timestamp with time zone,
  detalhe text,
  avisado_em timestamp with time zone,
  canais text[] default '{}'::text[] not null,
  erro_do_aviso text,
  volta_avisada_em timestamp with time zone
);
alter table public.job_alert_episodes
  add constraint job_alert_episodes_pkey PRIMARY KEY (id);
alter table public.job_alert_episodes
  add constraint job_alert_episodes_tipo_check CHECK ((tipo = ANY (ARRAY['falhou'::text, 'parou'::text])));
alter table public.job_alert_episodes
  add constraint job_alert_episodes_volta_depois_da_quebra CHECK (((volta_avisada_em IS NULL) OR ((avisado_em IS NOT NULL) AND (fechado_em IS NOT NULL))));

-- --------------------------------------------------------------------------
-- job_expectations
-- --------------------------------------------------------------------------
create table public.job_expectations (
  job text not null,
  rotulo text not null,
  tolerancia_min integer not null,
  ativo boolean default true not null,
  observacao text,
  updated_at timestamp with time zone default now() not null
);
alter table public.job_expectations
  add constraint job_expectations_pkey PRIMARY KEY (job);
alter table public.job_expectations
  add constraint job_expectations_tolerancia_min_check CHECK ((tolerancia_min > 0));

-- --------------------------------------------------------------------------
-- job_runs
-- --------------------------------------------------------------------------
create table public.job_runs (
  id bigint default nextval('job_runs_id_seq'::regclass) not null,
  job text not null,
  started_at timestamp with time zone default now() not null,
  finished_at timestamp with time zone,
  ok boolean,
  affected integer,
  detail text
);
alter table public.job_runs
  add constraint job_runs_pkey PRIMARY KEY (id);

-- --------------------------------------------------------------------------
-- kb_articles
-- --------------------------------------------------------------------------
create table public.kb_articles (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  title text not null,
  resumo text,
  body text not null,
  category_id uuid,
  status text default 'rascunho'::text not null,
  visibilidade text default 'interno'::text not null,
  source_ticket_id uuid,
  author_id uuid,
  published_at timestamp with time zone,
  views integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone,
  search_vector tsvector generated always as (((setweight(to_tsvector('portugues_sem_acento'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('portugues_sem_acento'::regconfig, COALESCE(resumo, ''::text)), 'B'::"char")) || setweight(to_tsvector('portugues_sem_acento'::regconfig, COALESCE(body, ''::text)), 'C'::"char"))) stored
);
alter table public.kb_articles
  add constraint kb_articles_pkey PRIMARY KEY (id);
alter table public.kb_articles
  add constraint uq_kb_id_tenant UNIQUE (id, tenant_id);
alter table public.kb_articles
  add constraint kb_articles_body_check CHECK ((length(TRIM(BOTH FROM body)) >= 10));
alter table public.kb_articles
  add constraint kb_articles_resumo_check CHECK (((resumo IS NULL) OR (length(resumo) <= 300)));
alter table public.kb_articles
  add constraint kb_articles_status_check CHECK ((status = ANY (ARRAY['rascunho'::text, 'publicado'::text, 'arquivado'::text])));
alter table public.kb_articles
  add constraint kb_articles_title_check CHECK (((length(TRIM(BOTH FROM title)) >= 3) AND (length(TRIM(BOTH FROM title)) <= 200)));
alter table public.kb_articles
  add constraint kb_articles_views_check CHECK ((views >= 0));
alter table public.kb_articles
  add constraint kb_articles_visibilidade_check CHECK ((visibilidade = ANY (ARRAY['interno'::text, 'solicitante'::text])));
alter table public.kb_articles
  add constraint kb_publicado_tem_data CHECK (((status <> 'publicado'::text) OR (published_at IS NOT NULL)));

-- --------------------------------------------------------------------------
-- kb_feedback
-- --------------------------------------------------------------------------
create table public.kb_feedback (
  article_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  util boolean not null,
  comentario text,
  created_at timestamp with time zone default now() not null
);
alter table public.kb_feedback
  add constraint kb_feedback_pkey PRIMARY KEY (article_id, user_id);
alter table public.kb_feedback
  add constraint kb_feedback_comentario_check CHECK (((comentario IS NULL) OR (length(comentario) <= 1000)));

-- --------------------------------------------------------------------------
-- link_availability_events
-- --------------------------------------------------------------------------
create table public.link_availability_events (
  id bigint generated always as identity not null,
  tenant_id uuid not null,
  link_id uuid not null,
  state text not null,
  started_at timestamp with time zone default now() not null,
  ended_at timestamp with time zone,
  duration_seconds integer generated always as (
CASE
    WHEN (ended_at IS NULL) THEN NULL::integer
    ELSE GREATEST((EXTRACT(epoch FROM (ended_at - started_at)))::integer, 0)
END) stored,
  source text default 'manual'::text not null,
  external_event_id text,
  note text
);
alter table public.link_availability_events
  add constraint link_availability_events_pkey PRIMARY KEY (id);
alter table public.link_availability_events
  add constraint link_availability_events_source_check CHECK ((source = ANY (ARRAY['zabbix'::text, 'manual'::text, 'api'::text])));
alter table public.link_availability_events
  add constraint link_availability_events_state_check CHECK ((state = ANY (ARRAY['up'::text, 'down'::text])));
alter table public.link_availability_events
  add constraint link_event_period CHECK (((ended_at IS NULL) OR (ended_at >= started_at)));

-- --------------------------------------------------------------------------
-- meter_readings
-- --------------------------------------------------------------------------
create table public.meter_readings (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  equipment_id uuid not null,
  contract_item_id uuid,
  reading numeric(14,2) not null,
  read_on date default CURRENT_DATE not null,
  source text default 'manual'::text not null,
  notes text,
  created_by uuid,
  created_at timestamp with time zone default now() not null
);
alter table public.meter_readings
  add constraint meter_readings_pkey PRIMARY KEY (id);
alter table public.meter_readings
  add constraint meter_readings_reading_check CHECK ((reading >= (0)::numeric));
alter table public.meter_readings
  add constraint meter_readings_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'import'::text, 'delivery'::text, 'return'::text, 'agent'::text])));

-- --------------------------------------------------------------------------
-- monitoring_webhooks
-- --------------------------------------------------------------------------
create table public.monitoring_webhooks (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  name text not null,
  inbound_token_hash text not null,
  active boolean default true not null,
  last_seen_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  created_by uuid,
  deleted_at timestamp with time zone
);
alter table public.monitoring_webhooks
  add constraint monitoring_webhooks_pkey PRIMARY KEY (id);
alter table public.monitoring_webhooks
  add constraint monitoring_webhooks_id_tenant_id_key UNIQUE (id, tenant_id);
alter table public.monitoring_webhooks
  add constraint monitoring_webhooks_inbound_token_hash_key UNIQUE (inbound_token_hash);
alter table public.monitoring_webhooks
  add constraint monitoring_webhooks_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 2) AND (length(TRIM(BOTH FROM name)) <= 120)));

-- --------------------------------------------------------------------------
-- notification_preferences
-- --------------------------------------------------------------------------
create table public.notification_preferences (
  tenant_id uuid not null,
  user_id uuid not null,
  kind text not null,
  enabled boolean not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.notification_preferences
  add constraint notification_preferences_pkey PRIMARY KEY (tenant_id, user_id, kind);

-- --------------------------------------------------------------------------
-- operation_locations
-- --------------------------------------------------------------------------
create table public.operation_locations (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  client_id uuid not null,
  branch_id uuid,
  name text not null,
  address_line text,
  contact_name text,
  contact_phone text,
  notes text,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.operation_locations
  add constraint operation_locations_pkey PRIMARY KEY (id);

-- --------------------------------------------------------------------------
-- part_balances
-- --------------------------------------------------------------------------
create table public.part_balances (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  part_id uuid not null,
  depot_id uuid not null,
  quantity numeric(14,3) default 0 not null,
  last_movement_at timestamp with time zone,
  updated_at timestamp with time zone default now() not null
);
alter table public.part_balances
  add constraint part_balances_pkey PRIMARY KEY (id);
alter table public.part_balances
  add constraint part_balances_quantity_check CHECK ((quantity >= (0)::numeric));

-- --------------------------------------------------------------------------
-- part_movements
-- --------------------------------------------------------------------------
create table public.part_movements (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  part_id uuid not null,
  depot_id uuid not null,
  kind text not null,
  quantity numeric(14,3) not null,
  unit_cost numeric(14,4),
  ticket_id uuid,
  purchase_order_id uuid,
  inventory_count_id uuid,
  transfer_depot_id uuid,
  notes text,
  created_by uuid,
  created_at timestamp with time zone default now() not null
);
alter table public.part_movements
  add constraint part_movements_pkey PRIMARY KEY (id);
alter table public.part_movements
  add constraint part_movements_kind_check CHECK ((kind = ANY (ARRAY['purchase'::text, 'consumption'::text, 'return'::text, 'adjustment'::text, 'transfer_in'::text, 'transfer_out'::text])));
alter table public.part_movements
  add constraint part_movements_quantity_check CHECK ((quantity <> (0)::numeric));
alter table public.part_movements
  add constraint part_movements_unit_cost_check CHECK (((unit_cost IS NULL) OR (unit_cost >= (0)::numeric)));

-- --------------------------------------------------------------------------
-- part_stock_policies
-- --------------------------------------------------------------------------
create table public.part_stock_policies (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  part_id uuid not null,
  depot_id uuid not null,
  min_quantity numeric(14,3) default 0 not null,
  max_quantity numeric(14,3) default 0 not null,
  lead_time_days integer,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.part_stock_policies
  add constraint part_stock_policies_pkey PRIMARY KEY (id);
alter table public.part_stock_policies
  add constraint part_stock_policies_faixa CHECK ((max_quantity >= min_quantity));
alter table public.part_stock_policies
  add constraint part_stock_policies_lead_time_days_check CHECK (((lead_time_days IS NULL) OR (lead_time_days >= 0)));
alter table public.part_stock_policies
  add constraint part_stock_policies_max_quantity_check CHECK ((max_quantity >= (0)::numeric));
alter table public.part_stock_policies
  add constraint part_stock_policies_min_quantity_check CHECK ((min_quantity >= (0)::numeric));

-- --------------------------------------------------------------------------
-- parts
-- --------------------------------------------------------------------------
create table public.parts (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  sku text not null,
  name text not null,
  manufacturer_id uuid,
  unit text default 'un'::text not null,
  category text,
  average_cost numeric(14,4) default 0 not null,
  notes text,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.parts
  add constraint parts_pkey PRIMARY KEY (id);
alter table public.parts
  add constraint parts_average_cost_check CHECK ((average_cost >= (0)::numeric));
alter table public.parts
  add constraint parts_unit_check CHECK ((unit = ANY (ARRAY['un'::text, 'm'::text, 'kg'::text, 'l'::text, 'cx'::text, 'par'::text])));

-- --------------------------------------------------------------------------
-- payable_approvals
-- --------------------------------------------------------------------------
create table public.payable_approvals (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  payable_id uuid not null,
  level integer not null,
  decision text not null,
  decided_by uuid,
  decided_at timestamp with time zone default now() not null,
  note text
);
alter table public.payable_approvals
  add constraint payable_approvals_pkey PRIMARY KEY (id);
alter table public.payable_approvals
  add constraint uq_payable_approval_level UNIQUE (payable_id, level);
alter table public.payable_approvals
  add constraint payable_approvals_decision_check CHECK ((decision = ANY (ARRAY['approved'::text, 'rejected'::text])));
alter table public.payable_approvals
  add constraint payable_approvals_level_check CHECK (((level >= 1) AND (level <= 9)));

-- --------------------------------------------------------------------------
-- payable_attachments
-- --------------------------------------------------------------------------
create table public.payable_attachments (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  payable_id uuid not null,
  kind text not null,
  storage_path text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint,
  uploaded_by uuid,
  created_at timestamp with time zone default now() not null
);
alter table public.payable_attachments
  add constraint payable_attachments_pkey PRIMARY KEY (id);
alter table public.payable_attachments
  add constraint payable_attachments_storage_path_key UNIQUE (storage_path);
alter table public.payable_attachments
  add constraint payable_attachments_kind_check CHECK ((kind = ANY (ARRAY['nfe'::text, 'boleto'::text, 'receipt'::text, 'contract'::text, 'other'::text])));
alter table public.payable_attachments
  add constraint payable_attachments_size_bytes_check CHECK ((size_bytes > 0));

-- --------------------------------------------------------------------------
-- payables
-- --------------------------------------------------------------------------
create table public.payables (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  description text not null,
  document_ref text,
  supplier_id uuid,
  supplier_contract_id uuid,
  expense_category_id uuid,
  cost_center_id uuid,
  branch_id uuid,
  amount numeric(14,2) not null,
  issued_on date default CURRENT_DATE not null,
  due_on date not null,
  parent_payable_id uuid,
  installment_number integer default 1 not null,
  installment_total integer default 1 not null,
  status text default 'draft'::text not null,
  approved_at timestamp with time zone,
  approved_by uuid,
  rejection_reason text,
  paid_on date,
  bank_account_id uuid,
  bank_movement_id uuid,
  notes text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.payables
  add constraint payables_pkey PRIMARY KEY (id);
alter table public.payables
  add constraint uq_payables_id_tenant UNIQUE (id, tenant_id);
alter table public.payables
  add constraint payables_amount_check CHECK ((amount > (0)::numeric));
alter table public.payables
  add constraint payables_installment_coherent CHECK ((installment_number <= installment_total));
alter table public.payables
  add constraint payables_installment_number_check CHECK ((installment_number >= 1));
alter table public.payables
  add constraint payables_installment_total_check CHECK ((installment_total >= 1));
alter table public.payables
  add constraint payables_paid_has_evidence CHECK (((status <> 'paid'::text) OR ((paid_on IS NOT NULL) AND (bank_account_id IS NOT NULL))));
alter table public.payables
  add constraint payables_rejected_has_reason CHECK (((status <> 'rejected'::text) OR (rejection_reason IS NOT NULL)));
alter table public.payables
  add constraint payables_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'pending_approval'::text, 'approved'::text, 'rejected'::text, 'scheduled'::text, 'paid'::text, 'cancelled'::text])));

-- --------------------------------------------------------------------------
-- permission_catalog
-- --------------------------------------------------------------------------
create table public.permission_catalog (
  key text not null,
  module text not null,
  screen text,
  action text,
  label text not null,
  min_base_role text not null,
  sort_order integer default 0 not null
);
alter table public.permission_catalog
  add constraint permission_catalog_pkey PRIMARY KEY (key);
alter table public.permission_catalog
  add constraint permission_catalog_action_needs_screen CHECK (((action IS NULL) OR (screen IS NOT NULL)));
alter table public.permission_catalog
  add constraint permission_catalog_key_matches_parts CHECK ((key = concat_ws('.'::text, module, screen, action)));
alter table public.permission_catalog
  add constraint permission_catalog_min_base_role_check CHECK ((min_base_role = ANY (ARRAY['super_admin'::text, 'admin'::text, 'gestor'::text, 'atendente'::text, 'solicitante'::text, 'visualizador'::text])));

-- --------------------------------------------------------------------------
-- permission_grants
-- --------------------------------------------------------------------------
create table public.permission_grants (
  tenant_id uuid not null,
  profile_id uuid not null,
  permission_key text not null,
  created_at timestamp with time zone default now() not null
);
alter table public.permission_grants
  add constraint permission_grants_pkey PRIMARY KEY (profile_id, permission_key);

-- --------------------------------------------------------------------------
-- planos
-- --------------------------------------------------------------------------
create table public.planos (
  id uuid default gen_random_uuid() not null,
  codigo text not null,
  nome text not null,
  resumo text not null,
  preco_mensal numeric(14,2),
  limite_usuarios integer,
  limite_chamados_mes integer,
  esferas text[] default ARRAY['management'::text] not null,
  destaques text[] default '{}'::text[] not null,
  publico boolean default true not null,
  ordem smallint default 0 not null,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.planos
  add constraint planos_pkey PRIMARY KEY (id);
alter table public.planos
  add constraint planos_codigo_key UNIQUE (codigo);
alter table public.planos
  add constraint planos_esferas_check CHECK (((esferas <@ ARRAY['management'::text, 'rental'::text]) AND (array_length(esferas, 1) > 0)));
alter table public.planos
  add constraint planos_limite_chamados_mes_check CHECK (((limite_chamados_mes IS NULL) OR (limite_chamados_mes > 0)));
alter table public.planos
  add constraint planos_limite_usuarios_check CHECK (((limite_usuarios IS NULL) OR (limite_usuarios > 0)));
alter table public.planos
  add constraint planos_preco_mensal_check CHECK (((preco_mensal IS NULL) OR (preco_mensal >= (0)::numeric)));

-- --------------------------------------------------------------------------
-- platform_settings
-- --------------------------------------------------------------------------
create table public.platform_settings (
  chave text not null,
  valor text not null,
  rotulo text not null,
  descricao text,
  updated_at timestamp with time zone default now() not null
);
alter table public.platform_settings
  add constraint platform_settings_pkey PRIMARY KEY (chave);

-- --------------------------------------------------------------------------
-- profiles
-- --------------------------------------------------------------------------
create table public.profiles (
  id uuid not null,
  tenant_id uuid,
  role text default 'solicitante'::text not null,
  full_name text not null,
  email text not null,
  phone text,
  avatar_url text,
  is_active boolean default true not null,
  last_seen_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  access_profile_id uuid,
  focused_client_id uuid
);
alter table public.profiles
  add constraint profiles_pkey PRIMARY KEY (id);
alter table public.profiles
  add constraint uq_profiles_id_tenant UNIQUE (id, tenant_id);
alter table public.profiles
  add constraint profiles_role_check CHECK ((role = ANY (ARRAY['super_admin'::text, 'admin'::text, 'gestor'::text, 'atendente'::text, 'solicitante'::text, 'visualizador'::text])));
alter table public.profiles
  add constraint profiles_tenant_required_for_non_super CHECK (((role = 'super_admin'::text) OR (tenant_id IS NOT NULL)));

-- --------------------------------------------------------------------------
-- project_members
-- --------------------------------------------------------------------------
create table public.project_members (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  project_id uuid not null,
  name text not null,
  role_in_project text,
  profile_id uuid,
  created_at timestamp with time zone default now() not null
);
alter table public.project_members
  add constraint project_members_pkey PRIMARY KEY (id);
alter table public.project_members
  add constraint uq_member_no_projeto UNIQUE (project_id, name);
alter table public.project_members
  add constraint project_members_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 2) AND (length(TRIM(BOTH FROM name)) <= 160)));

-- --------------------------------------------------------------------------
-- project_tasks
-- --------------------------------------------------------------------------
create table public.project_tasks (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  project_id uuid not null,
  name text not null,
  start_month date not null,
  planned_end_month date not null,
  actual_end_month date,
  assignee text,
  status text default 'pendente'::text not null,
  parent_task_id uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.project_tasks
  add constraint project_tasks_pkey PRIMARY KEY (id);
alter table public.project_tasks
  add constraint uq_task_id_tenant UNIQUE (id, tenant_id);
alter table public.project_tasks
  add constraint project_tasks_actual_end_month_check CHECK (app.eh_competencia(actual_end_month));
alter table public.project_tasks
  add constraint project_tasks_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 2) AND (length(TRIM(BOTH FROM name)) <= 160)));
alter table public.project_tasks
  add constraint project_tasks_planned_end_month_check CHECK (app.eh_competencia(planned_end_month));
alter table public.project_tasks
  add constraint project_tasks_start_month_check CHECK (app.eh_competencia(start_month));
alter table public.project_tasks
  add constraint project_tasks_status_check CHECK ((status = ANY (ARRAY['pendente'::text, 'em_andamento'::text, 'concluida'::text, 'cancelada'::text])));
alter table public.project_tasks
  add constraint task_fim_depois_do_inicio CHECK ((planned_end_month >= start_month));
alter table public.project_tasks
  add constraint task_nao_e_a_propria_principal CHECK (((parent_task_id IS NULL) OR (parent_task_id <> id)));
alter table public.project_tasks
  add constraint task_real_depois_do_inicio CHECK (((actual_end_month IS NULL) OR (actual_end_month >= start_month)));

-- --------------------------------------------------------------------------
-- projects
-- --------------------------------------------------------------------------
create table public.projects (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  client_id uuid not null,
  branch_id uuid,
  name text not null,
  description text,
  start_month date not null,
  planned_end_month date not null,
  actual_end_month date,
  status text default 'planejado'::text not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.projects
  add constraint projects_pkey PRIMARY KEY (id);
alter table public.projects
  add constraint uq_project_id_tenant UNIQUE (id, tenant_id);
alter table public.projects
  add constraint proj_concluido_tem_fim_real CHECK (((status <> 'concluido'::text) OR (actual_end_month IS NOT NULL)));
alter table public.projects
  add constraint proj_fim_depois_do_inicio CHECK ((planned_end_month >= start_month));
alter table public.projects
  add constraint proj_real_depois_do_inicio CHECK (((actual_end_month IS NULL) OR (actual_end_month >= start_month)));
alter table public.projects
  add constraint projects_actual_end_month_check CHECK (app.eh_competencia(actual_end_month));
alter table public.projects
  add constraint projects_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 2) AND (length(TRIM(BOTH FROM name)) <= 160)));
alter table public.projects
  add constraint projects_planned_end_month_check CHECK (app.eh_competencia(planned_end_month));
alter table public.projects
  add constraint projects_start_month_check CHECK (app.eh_competencia(start_month));
alter table public.projects
  add constraint projects_status_check CHECK ((status = ANY (ARRAY['planejado'::text, 'em_andamento'::text, 'concluido'::text, 'cancelado'::text])));

-- --------------------------------------------------------------------------
-- purchase_order_items
-- --------------------------------------------------------------------------
create table public.purchase_order_items (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  order_id uuid not null,
  part_id uuid not null,
  quantity numeric(14,3) not null,
  unit_price numeric(14,4) default 0 not null,
  amount numeric(14,2) not null,
  received_quantity numeric(14,3) default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.purchase_order_items
  add constraint purchase_order_items_pkey PRIMARY KEY (id);
alter table public.purchase_order_items
  add constraint purchase_order_items_amount_check CHECK ((amount >= (0)::numeric));
alter table public.purchase_order_items
  add constraint purchase_order_items_quantity_check CHECK ((quantity > (0)::numeric));
alter table public.purchase_order_items
  add constraint purchase_order_items_recebido_cabe CHECK ((received_quantity <= quantity));
alter table public.purchase_order_items
  add constraint purchase_order_items_received_quantity_check CHECK ((received_quantity >= (0)::numeric));
alter table public.purchase_order_items
  add constraint purchase_order_items_unit_price_check CHECK ((unit_price >= (0)::numeric));

-- --------------------------------------------------------------------------
-- purchase_orders
-- --------------------------------------------------------------------------
create table public.purchase_orders (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  supplier_id uuid,
  depot_id uuid not null,
  code text not null,
  status text default 'draft'::text not null,
  expected_on date,
  total numeric(14,2) default 0 not null,
  invoice_ref text,
  payable_id uuid,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.purchase_orders
  add constraint purchase_orders_pkey PRIMARY KEY (id);
alter table public.purchase_orders
  add constraint purchase_orders_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'sent'::text, 'partial'::text, 'received'::text, 'cancelled'::text])));
alter table public.purchase_orders
  add constraint purchase_orders_total_check CHECK ((total >= (0)::numeric));

-- --------------------------------------------------------------------------
-- queue_members
-- --------------------------------------------------------------------------
create table public.queue_members (
  queue_id uuid not null,
  user_id uuid not null,
  tenant_id uuid not null,
  is_lead boolean default false not null,
  created_at timestamp with time zone default now() not null
);
alter table public.queue_members
  add constraint queue_members_pkey PRIMARY KEY (queue_id, user_id);

-- --------------------------------------------------------------------------
-- queue_rules
-- --------------------------------------------------------------------------
create table public.queue_rules (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  queue_id uuid not null,
  name text not null,
  conditions jsonb default '{}'::jsonb not null,
  sort_order smallint default 100 not null,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.queue_rules
  add constraint queue_rules_pkey PRIMARY KEY (id);
alter table public.queue_rules
  add constraint queue_rules_conditions_object CHECK ((jsonb_typeof(conditions) = 'object'::text));

-- --------------------------------------------------------------------------
-- queues
-- --------------------------------------------------------------------------
create table public.queues (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  name text not null,
  slug text not null,
  description text,
  is_system_default boolean default false not null,
  is_active boolean default true not null,
  weight_criticality smallint default 60 not null,
  weight_deadline smallint default 30 not null,
  weight_age smallint default 10 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone,
  tiebreaker text default 'fifo'::text not null,
  tiebreaker_criterion text
);
alter table public.queues
  add constraint queues_pkey PRIMARY KEY (id);
alter table public.queues
  add constraint uq_queue_id_tenant UNIQUE (id, tenant_id);
alter table public.queues
  add constraint uq_queue_slug UNIQUE (tenant_id, slug);
alter table public.queues
  add constraint queue_custom_needs_criterion CHECK (((tiebreaker <> 'custom'::text) OR (tiebreaker_criterion IS NOT NULL)));
alter table public.queues
  add constraint queues_tiebreaker_check CHECK ((tiebreaker = ANY (ARRAY['fifo'::text, 'lifo'::text, 'custom'::text])));
alter table public.queues
  add constraint queues_tiebreaker_criterion_check CHECK (((tiebreaker_criterion IS NULL) OR (tiebreaker_criterion = ANY (ARRAY['menor_prazo_restante'::text, 'maior_tempo_espera'::text, 'cliente_prioritario'::text]))));
alter table public.queues
  add constraint queues_weight_age_check CHECK (((weight_age >= 0) AND (weight_age <= 100)));
alter table public.queues
  add constraint queues_weight_criticality_check CHECK (((weight_criticality >= 0) AND (weight_criticality <= 100)));
alter table public.queues
  add constraint queues_weight_deadline_check CHECK (((weight_deadline >= 0) AND (weight_deadline <= 100)));

-- --------------------------------------------------------------------------
-- receivables
-- --------------------------------------------------------------------------
create table public.receivables (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  description text not null,
  document_ref text,
  client_id uuid,
  sla_contract_id uuid,
  cost_center_id uuid,
  branch_id uuid,
  amount numeric(14,2) not null,
  issued_on date default CURRENT_DATE not null,
  due_on date not null,
  parent_receivable_id uuid,
  installment_number integer default 1 not null,
  installment_total integer default 1 not null,
  status text default 'draft'::text not null,
  received_on date,
  received_amount numeric(14,2),
  bank_account_id uuid,
  bank_movement_id uuid,
  notes text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.receivables
  add constraint receivables_pkey PRIMARY KEY (id);
alter table public.receivables
  add constraint uq_receivables_id_tenant UNIQUE (id, tenant_id);
alter table public.receivables
  add constraint receivables_amount_check CHECK ((amount > (0)::numeric));
alter table public.receivables
  add constraint receivables_installment_coherent CHECK ((installment_number <= installment_total));
alter table public.receivables
  add constraint receivables_installment_number_check CHECK ((installment_number >= 1));
alter table public.receivables
  add constraint receivables_installment_total_check CHECK ((installment_total >= 1));
alter table public.receivables
  add constraint receivables_received_amount_check CHECK (((received_amount IS NULL) OR (received_amount > (0)::numeric)));
alter table public.receivables
  add constraint receivables_received_has_evidence CHECK (((status <> 'received'::text) OR ((received_on IS NOT NULL) AND (bank_account_id IS NOT NULL))));
alter table public.receivables
  add constraint receivables_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'open'::text, 'received'::text, 'cancelled'::text])));

-- --------------------------------------------------------------------------
-- rental_contract_items
-- --------------------------------------------------------------------------
create table public.rental_contract_items (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  contract_id uuid not null,
  equipment_id uuid not null,
  operation_location_id uuid,
  status text default 'reserved'::text not null,
  monthly_price numeric(14,2) not null,
  franchise numeric(14,2),
  excess_price numeric(14,4),
  delivered_on date,
  returned_on date,
  meter_at_delivery numeric(14,2),
  meter_at_return numeric(14,2),
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.rental_contract_items
  add constraint rental_contract_items_pkey PRIMARY KEY (id);
alter table public.rental_contract_items
  add constraint rental_contract_items_excess_price_check CHECK (((excess_price IS NULL) OR (excess_price >= (0)::numeric)));
alter table public.rental_contract_items
  add constraint rental_contract_items_franchise_check CHECK (((franchise IS NULL) OR (franchise >= (0)::numeric)));
alter table public.rental_contract_items
  add constraint rental_contract_items_meter_at_delivery_check CHECK (((meter_at_delivery IS NULL) OR (meter_at_delivery >= (0)::numeric)));
alter table public.rental_contract_items
  add constraint rental_contract_items_meter_at_return_check CHECK (((meter_at_return IS NULL) OR (meter_at_return >= (0)::numeric)));
alter table public.rental_contract_items
  add constraint rental_contract_items_monthly_price_check CHECK ((monthly_price >= (0)::numeric));
alter table public.rental_contract_items
  add constraint rental_contract_items_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'delivered'::text, 'returned'::text, 'cancelled'::text])));

-- --------------------------------------------------------------------------
-- rental_contract_status_transitions
-- --------------------------------------------------------------------------
create table public.rental_contract_status_transitions (
  from_status text not null,
  to_status text not null,
  description text
);
alter table public.rental_contract_status_transitions
  add constraint rental_contract_status_transitions_pkey PRIMARY KEY (from_status, to_status);

-- --------------------------------------------------------------------------
-- rental_contracts
-- --------------------------------------------------------------------------
create table public.rental_contracts (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  client_id uuid not null,
  code text not null,
  status text default 'draft'::text not null,
  starts_on date not null,
  ends_on date,
  billing_day smallint default 1 not null,
  default_franchise numeric(14,2),
  default_excess_price numeric(14,4),
  adjustment_index text,
  adjustment_month smallint,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.rental_contracts
  add constraint rental_contracts_pkey PRIMARY KEY (id);
alter table public.rental_contracts
  add constraint rental_contracts_adjustment_month_check CHECK (((adjustment_month IS NULL) OR ((adjustment_month >= 1) AND (adjustment_month <= 12))));
alter table public.rental_contracts
  add constraint rental_contracts_billing_day_check CHECK (((billing_day >= 1) AND (billing_day <= 28)));
alter table public.rental_contracts
  add constraint rental_contracts_default_excess_price_check CHECK (((default_excess_price IS NULL) OR (default_excess_price >= (0)::numeric)));
alter table public.rental_contracts
  add constraint rental_contracts_default_franchise_check CHECK (((default_franchise IS NULL) OR (default_franchise >= (0)::numeric)));
alter table public.rental_contracts
  add constraint rental_contracts_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'suspended'::text, 'ended'::text, 'cancelled'::text])));
alter table public.rental_contracts
  add constraint rental_contracts_vigencia CHECK (((ends_on IS NULL) OR (ends_on >= starts_on)));

-- --------------------------------------------------------------------------
-- rental_depots
-- --------------------------------------------------------------------------
create table public.rental_depots (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  name text not null,
  code text,
  kind text default 'warehouse'::text not null,
  city text,
  state character(2),
  notes text,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.rental_depots
  add constraint rental_depots_pkey PRIMARY KEY (id);
alter table public.rental_depots
  add constraint rental_depots_kind_check CHECK ((kind = ANY (ARRAY['warehouse'::text, 'workshop'::text, 'transit'::text])));

-- --------------------------------------------------------------------------
-- rental_equipment
-- --------------------------------------------------------------------------
create table public.rental_equipment (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  asset_tag text not null,
  serial_number text,
  model_id uuid not null,
  depot_id uuid,
  status text default 'available'::text not null,
  blocked boolean default false not null,
  block_reason text,
  block_until date,
  meter_kind text default 'none'::text not null,
  meter_reading numeric(14,2) default 0 not null,
  meter_read_at timestamp with time zone,
  acquisition_date date,
  acquisition_value numeric(14,2),
  invoice_ref text,
  useful_life_months integer,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.rental_equipment
  add constraint rental_equipment_pkey PRIMARY KEY (id);
alter table public.rental_equipment
  add constraint rental_equipment_acquisition_value_check CHECK (((acquisition_value IS NULL) OR (acquisition_value >= (0)::numeric)));
alter table public.rental_equipment
  add constraint rental_equipment_bloqueio_tem_motivo CHECK (((NOT blocked) OR (block_reason IS NOT NULL)));
alter table public.rental_equipment
  add constraint rental_equipment_medidor_coerente CHECK (((meter_kind <> 'none'::text) OR ((meter_reading = (0)::numeric) AND (meter_read_at IS NULL))));
alter table public.rental_equipment
  add constraint rental_equipment_meter_kind_check CHECK ((meter_kind = ANY (ARRAY['none'::text, 'hours'::text, 'cycles'::text, 'distance'::text])));
alter table public.rental_equipment
  add constraint rental_equipment_meter_reading_check CHECK ((meter_reading >= (0)::numeric));
alter table public.rental_equipment
  add constraint rental_equipment_status_check CHECK ((status = ANY (ARRAY['available'::text, 'reserved'::text, 'in_transit_out'::text, 'rented'::text, 'in_transit_back'::text, 'inspection'::text, 'maintenance'::text, 'blocked'::text, 'lost'::text, 'written_off'::text])));
alter table public.rental_equipment
  add constraint rental_equipment_useful_life_months_check CHECK (((useful_life_months IS NULL) OR ((useful_life_months >= 1) AND (useful_life_months <= 600))));

-- --------------------------------------------------------------------------
-- rental_equipment_movements
-- --------------------------------------------------------------------------
create table public.rental_equipment_movements (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  equipment_id uuid not null,
  kind text not null,
  from_status text,
  to_status text,
  from_depot_id uuid,
  to_depot_id uuid,
  meter_reading numeric(14,2),
  notes text,
  created_by uuid,
  created_at timestamp with time zone default now() not null
);
alter table public.rental_equipment_movements
  add constraint rental_equipment_movements_pkey PRIMARY KEY (id);
alter table public.rental_equipment_movements
  add constraint rental_equipment_movements_kind_check CHECK ((kind = ANY (ARRAY['status'::text, 'depot'::text, 'meter'::text, 'block'::text, 'note'::text])));

-- --------------------------------------------------------------------------
-- rental_equipment_status_transitions
-- --------------------------------------------------------------------------
create table public.rental_equipment_status_transitions (
  from_status text not null,
  to_status text not null,
  description text
);
alter table public.rental_equipment_status_transitions
  add constraint rental_equipment_status_transitions_pkey PRIMARY KEY (from_status, to_status);

-- --------------------------------------------------------------------------
-- rental_invoice_items
-- --------------------------------------------------------------------------
create table public.rental_invoice_items (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  invoice_id uuid not null,
  contract_item_id uuid,
  equipment_id uuid,
  kind text not null,
  description text not null,
  quantity numeric(14,4) default 1 not null,
  unit_price numeric(14,4) default 0 not null,
  amount numeric(14,2) not null,
  meter_from numeric(14,2),
  meter_to numeric(14,2),
  days integer,
  created_at timestamp with time zone default now() not null
);
alter table public.rental_invoice_items
  add constraint rental_invoice_items_pkey PRIMARY KEY (id);
alter table public.rental_invoice_items
  add constraint rental_invoice_items_days_check CHECK (((days IS NULL) OR (days >= 0)));
alter table public.rental_invoice_items
  add constraint rental_invoice_items_kind_check CHECK ((kind = ANY (ARRAY['rent'::text, 'excess'::text, 'service'::text, 'part'::text, 'discount'::text])));
alter table public.rental_invoice_items
  add constraint rental_invoice_items_quantity_check CHECK ((quantity >= (0)::numeric));

-- --------------------------------------------------------------------------
-- rental_invoices
-- --------------------------------------------------------------------------
create table public.rental_invoices (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  contract_id uuid not null,
  client_id uuid not null,
  number text not null,
  competence date not null,
  status text default 'draft'::text not null,
  issued_on date,
  due_on date,
  total numeric(14,2) default 0 not null,
  receivable_id uuid,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.rental_invoices
  add constraint rental_invoices_pkey PRIMARY KEY (id);
alter table public.rental_invoices
  add constraint rental_invoices_competence_check CHECK (app.eh_competencia(competence));
alter table public.rental_invoices
  add constraint rental_invoices_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'issued'::text, 'cancelled'::text])));
alter table public.rental_invoices
  add constraint rental_invoices_total_check CHECK ((total >= (0)::numeric));

-- --------------------------------------------------------------------------
-- request_throttle
-- --------------------------------------------------------------------------
create table public.request_throttle (
  balde text not null,
  origem text not null,
  janela_inicio timestamp with time zone default now() not null,
  contagem integer default 0 not null
);
alter table public.request_throttle
  add constraint request_throttle_pkey PRIMARY KEY (balde, origem);

-- --------------------------------------------------------------------------
-- service_approvals
-- --------------------------------------------------------------------------
create table public.service_approvals (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  ticket_id uuid not null,
  service_id uuid not null,
  status text default 'pendente'::text not null,
  requested_by uuid,
  requested_at timestamp with time zone default now() not null,
  decided_by uuid,
  decided_at timestamp with time zone,
  motivo text
);
alter table public.service_approvals
  add constraint service_approvals_pkey PRIMARY KEY (id);
alter table public.service_approvals
  add constraint uq_service_approval_ticket UNIQUE (ticket_id);
alter table public.service_approvals
  add constraint sa_decidida_tem_autor CHECK ((((status = 'pendente'::text) AND (decided_by IS NULL) AND (decided_at IS NULL)) OR ((status <> 'pendente'::text) AND (decided_by IS NOT NULL) AND (decided_at IS NOT NULL))));
alter table public.service_approvals
  add constraint sa_recusa_tem_motivo CHECK (((status <> 'recusado'::text) OR ((motivo IS NOT NULL) AND (length(TRIM(BOTH FROM motivo)) >= 3))));
alter table public.service_approvals
  add constraint service_approvals_status_check CHECK ((status = ANY (ARRAY['pendente'::text, 'aprovado'::text, 'recusado'::text])));

-- --------------------------------------------------------------------------
-- service_catalog
-- --------------------------------------------------------------------------
create table public.service_catalog (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  name text not null,
  description text,
  category_id uuid,
  queue_id uuid,
  priority_id uuid,
  preco numeric(14,2),
  unidade text,
  prazo_horas integer,
  requer_aprovacao boolean default false not null,
  campos jsonb default '[]'::jsonb not null,
  is_active boolean default true not null,
  sort_order integer default 100 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone,
  aprovador_profile_id uuid
);
alter table public.service_catalog
  add constraint service_catalog_pkey PRIMARY KEY (id);
alter table public.service_catalog
  add constraint uq_sc_id_tenant UNIQUE (id, tenant_id);
alter table public.service_catalog
  add constraint service_catalog_campos_check CHECK ((jsonb_typeof(campos) = 'array'::text));
alter table public.service_catalog
  add constraint service_catalog_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 3) AND (length(TRIM(BOTH FROM name)) <= 120)));
alter table public.service_catalog
  add constraint service_catalog_prazo_horas_check CHECK (((prazo_horas IS NULL) OR ((prazo_horas >= 1) AND (prazo_horas <= 2000))));
alter table public.service_catalog
  add constraint service_catalog_preco_check CHECK (((preco IS NULL) OR (preco >= (0)::numeric)));
alter table public.service_catalog
  add constraint service_catalog_unidade_check CHECK (((unidade IS NULL) OR (unidade = ANY (ARRAY['unidade'::text, 'hora'::text, 'mes'::text, 'ponto'::text, 'usuario'::text]))));

-- --------------------------------------------------------------------------
-- service_catalog_clients
-- --------------------------------------------------------------------------
create table public.service_catalog_clients (
  service_id uuid not null,
  client_id uuid not null,
  tenant_id uuid not null,
  incluso_no_contrato boolean default false not null,
  preco numeric(14,2),
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.service_catalog_clients
  add constraint service_catalog_clients_pkey PRIMARY KEY (service_id, client_id);
alter table public.service_catalog_clients
  add constraint scc_incluso_nao_tem_preco CHECK (((NOT incluso_no_contrato) OR (preco IS NULL)));
alter table public.service_catalog_clients
  add constraint service_catalog_clients_preco_check CHECK (((preco IS NULL) OR (preco >= (0)::numeric)));

-- --------------------------------------------------------------------------
-- sla_contracts
-- --------------------------------------------------------------------------
create table public.sla_contracts (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  client_id uuid not null,
  branch_id uuid,
  name text not null,
  business_hours_id uuid,
  valid_from date,
  valid_to date,
  is_active boolean default true not null,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.sla_contracts
  add constraint sla_contracts_pkey PRIMARY KEY (id);
alter table public.sla_contracts
  add constraint uq_slac_id_tenant UNIQUE (id, tenant_id);
alter table public.sla_contracts
  add constraint slac_valid_period CHECK (((valid_to IS NULL) OR (valid_from IS NULL) OR (valid_to >= valid_from)));

-- --------------------------------------------------------------------------
-- sla_definitions
-- --------------------------------------------------------------------------
create table public.sla_definitions (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  contract_id uuid,
  category_id uuid,
  priority_id uuid not null,
  first_response_minutes integer not null,
  resolution_minutes integer not null,
  business_hours_id uuid,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  name text,
  deleted_at timestamp with time zone
);
alter table public.sla_definitions
  add constraint sla_definitions_pkey PRIMARY KEY (id);
alter table public.sla_definitions
  add constraint uq_slad_id_tenant UNIQUE (id, tenant_id);
alter table public.sla_definitions
  add constraint sla_definitions_first_response_minutes_check CHECK ((first_response_minutes > 0));
alter table public.sla_definitions
  add constraint sla_definitions_resolution_minutes_check CHECK ((resolution_minutes > 0));
alter table public.sla_definitions
  add constraint slad_resolution_after_response CHECK ((resolution_minutes >= first_response_minutes));

-- --------------------------------------------------------------------------
-- sla_pauses
-- --------------------------------------------------------------------------
create table public.sla_pauses (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  ticket_id uuid not null,
  reason text not null,
  started_at timestamp with time zone default now() not null,
  ended_at timestamp with time zone
);
alter table public.sla_pauses
  add constraint sla_pauses_pkey PRIMARY KEY (id);
alter table public.sla_pauses
  add constraint sla_pause_valid CHECK (((ended_at IS NULL) OR (ended_at >= started_at)));

-- --------------------------------------------------------------------------
-- sla_tracking
-- --------------------------------------------------------------------------
create table public.sla_tracking (
  ticket_id uuid not null,
  tenant_id uuid not null,
  sla_definition_id uuid,
  business_hours_id uuid,
  first_response_minutes integer,
  resolution_minutes integer,
  started_at timestamp with time zone default now() not null,
  response_due_at timestamp with time zone,
  resolution_due_at timestamp with time zone,
  responded_at timestamp with time zone,
  resolved_at timestamp with time zone,
  response_breached boolean default false not null,
  resolution_breached boolean default false not null,
  paused_minutes numeric default 0 not null,
  is_paused boolean default false not null,
  coverage text default 'covered'::text not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.sla_tracking
  add constraint sla_tracking_pkey PRIMARY KEY (ticket_id);
alter table public.sla_tracking
  add constraint sla_tracking_coverage_check CHECK ((coverage = ANY (ARRAY['covered'::text, 'uncovered'::text])));
alter table public.sla_tracking
  add constraint sla_tracking_paused_minutes_check CHECK ((paused_minutes >= (0)::numeric));

-- --------------------------------------------------------------------------
-- supplier_contracts
-- --------------------------------------------------------------------------
create table public.supplier_contracts (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  supplier_id uuid not null,
  contract_number text,
  description text,
  starts_on date,
  ends_on date,
  monthly_cost numeric(14,2),
  response_sla_minutes integer,
  resolution_sla_minutes integer,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.supplier_contracts
  add constraint supplier_contracts_pkey PRIMARY KEY (id);
alter table public.supplier_contracts
  add constraint uq_supplier_contracts_id_tenant UNIQUE (id, tenant_id);
alter table public.supplier_contracts
  add constraint sc_valid_period CHECK (((ends_on IS NULL) OR (starts_on IS NULL) OR (ends_on >= starts_on)));
alter table public.supplier_contracts
  add constraint supplier_contracts_monthly_cost_check CHECK (((monthly_cost IS NULL) OR (monthly_cost >= (0)::numeric)));
alter table public.supplier_contracts
  add constraint supplier_contracts_resolution_sla_minutes_check CHECK (((resolution_sla_minutes IS NULL) OR (resolution_sla_minutes > 0)));
alter table public.supplier_contracts
  add constraint supplier_contracts_response_sla_minutes_check CHECK (((response_sla_minutes IS NULL) OR (response_sla_minutes > 0)));

-- --------------------------------------------------------------------------
-- suppliers
-- --------------------------------------------------------------------------
create table public.suppliers (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  name text not null,
  legal_name text,
  cnpj text,
  email text,
  phone text,
  website text,
  address_line text,
  city text,
  state character(2),
  services text[] default '{}'::text[] not null,
  rating numeric(2,1),
  is_active boolean default true not null,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.suppliers
  add constraint suppliers_pkey PRIMARY KEY (id);
alter table public.suppliers
  add constraint uq_supplier_id_tenant UNIQUE (id, tenant_id);
alter table public.suppliers
  add constraint suppliers_rating_check CHECK (((rating IS NULL) OR ((rating >= (0)::numeric) AND (rating <= (5)::numeric))));

-- --------------------------------------------------------------------------
-- telecom_line_attachments
-- --------------------------------------------------------------------------
create table public.telecom_line_attachments (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  line_id uuid not null,
  kind text not null,
  storage_path text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint,
  valid_until date,
  uploaded_by uuid,
  created_at timestamp with time zone default now() not null
);
alter table public.telecom_line_attachments
  add constraint telecom_line_attachments_pkey PRIMARY KEY (id);
alter table public.telecom_line_attachments
  add constraint telecom_line_attachments_storage_path_key UNIQUE (storage_path);
alter table public.telecom_line_attachments
  add constraint telecom_line_attachments_kind_check CHECK ((kind = ANY (ARRAY['contract'::text, 'amendment'::text, 'loyalty_term'::text, 'cancellation'::text, 'invoice'::text, 'other'::text])));
alter table public.telecom_line_attachments
  add constraint telecom_line_attachments_size_bytes_check CHECK ((size_bytes > 0));

-- --------------------------------------------------------------------------
-- telecom_lines
-- --------------------------------------------------------------------------
create table public.telecom_lines (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  phone_number text not null,
  carrier text not null,
  plan_name text,
  line_type text not null,
  status text default 'active'::text not null,
  branch_id uuid,
  assigned_user_id uuid,
  device_asset_id uuid,
  monthly_cost numeric(12,2),
  activated_on date,
  cancelled_on date,
  loyalty_until date,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone,
  company_area_id uuid,
  contract_number text,
  contract_start date,
  contract_end date
);
alter table public.telecom_lines
  add constraint telecom_lines_pkey PRIMARY KEY (id);
alter table public.telecom_lines
  add constraint uq_line_id_tenant UNIQUE (id, tenant_id);
alter table public.telecom_lines
  add constraint line_cancel_after_activation CHECK (((cancelled_on IS NULL) OR (activated_on IS NULL) OR (cancelled_on >= activated_on)));
alter table public.telecom_lines
  add constraint line_cancelled_needs_date CHECK (((status <> 'cancelled'::text) OR (cancelled_on IS NOT NULL)));
alter table public.telecom_lines
  add constraint line_contract_period CHECK (((contract_end IS NULL) OR (contract_start IS NULL) OR (contract_end >= contract_start)));
alter table public.telecom_lines
  add constraint telecom_lines_line_type_check CHECK ((line_type = ANY (ARRAY['postpaid'::text, 'prepaid'::text, 'control'::text])));
alter table public.telecom_lines
  add constraint telecom_lines_monthly_cost_check CHECK (((monthly_cost IS NULL) OR (monthly_cost >= (0)::numeric)));
alter table public.telecom_lines
  add constraint telecom_lines_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'cancelled'::text])));

-- --------------------------------------------------------------------------
-- tenant_status_events
-- --------------------------------------------------------------------------
create table public.tenant_status_events (
  id bigint default nextval('tenant_status_events_id_seq'::regclass) not null,
  tenant_id uuid not null,
  de text,
  para text not null,
  motivo text,
  por uuid,
  created_at timestamp with time zone default now() not null
);
alter table public.tenant_status_events
  add constraint tenant_status_events_pkey PRIMARY KEY (id);

-- --------------------------------------------------------------------------
-- tenants
-- --------------------------------------------------------------------------
create table public.tenants (
  id uuid default gen_random_uuid() not null,
  name text not null,
  slug text not null,
  cnpj text,
  status text default 'active'::text not null,
  auto_close_after_days integer default 3 not null,
  sla_warning_pct smallint default 75 not null,
  sla_critical_pct smallint default 90 not null,
  default_locale text default 'pt-BR'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone,
  ticket_seq bigint default 0 not null,
  attachment_quota_mb integer default 500 not null,
  payable_approval_required boolean default false not null,
  agent_disk_alert_pct smallint default 90 not null,
  agent_mute_hours integer default 24 not null,
  agent_metrics_retention_days integer default 7 not null,
  agent_remote_url text,
  contract_alert_days integer default 30 not null,
  link_alert_minutes integer default 10 not null,
  spheres text[] default ARRAY['management'::text] not null,
  trial_ends_on date,
  plano_id uuid
);
alter table public.tenants
  add constraint tenants_pkey PRIMARY KEY (id);
alter table public.tenants
  add constraint tenants_slug_key UNIQUE (slug);
alter table public.tenants
  add constraint tenants_agent_disk_alert_pct_check CHECK (((agent_disk_alert_pct >= 50) AND (agent_disk_alert_pct <= 99)));
alter table public.tenants
  add constraint tenants_agent_metrics_retention_days_check CHECK (((agent_metrics_retention_days >= 1) AND (agent_metrics_retention_days <= 90)));
alter table public.tenants
  add constraint tenants_agent_mute_hours_check CHECK (((agent_mute_hours >= 1) AND (agent_mute_hours <= 720)));
alter table public.tenants
  add constraint tenants_agent_remote_url_check CHECK (((agent_remote_url IS NULL) OR (agent_remote_url ~~ '%{id}%'::text)));
alter table public.tenants
  add constraint tenants_attachment_quota_mb_check CHECK (((attachment_quota_mb >= 1) AND (attachment_quota_mb <= 100000)));
alter table public.tenants
  add constraint tenants_auto_close_after_days_check CHECK (((auto_close_after_days >= 0) AND (auto_close_after_days <= 365)));
alter table public.tenants
  add constraint tenants_contract_alert_days_check CHECK (((contract_alert_days >= 1) AND (contract_alert_days <= 365)));
alter table public.tenants
  add constraint tenants_link_alert_minutes_check CHECK (((link_alert_minutes >= 1) AND (link_alert_minutes <= 1440)));
alter table public.tenants
  add constraint tenants_sla_critical_pct_check CHECK (((sla_critical_pct >= 1) AND (sla_critical_pct <= 99)));
alter table public.tenants
  add constraint tenants_sla_warning_pct_check CHECK (((sla_warning_pct >= 1) AND (sla_warning_pct <= 99)));
alter table public.tenants
  add constraint tenants_spheres_known CHECK ((spheres <@ ARRAY['management'::text, 'rental'::text]));
alter table public.tenants
  add constraint tenants_spheres_not_empty CHECK ((array_length(spheres, 1) >= 1));
alter table public.tenants
  add constraint tenants_status_check CHECK ((status = ANY (ARRAY['trial'::text, 'active'::text, 'suspended'::text, 'cancelled'::text])));
alter table public.tenants
  add constraint tenants_trial_tem_prazo CHECK (((status = 'trial'::text) = (trial_ends_on IS NOT NULL)));
alter table public.tenants
  add constraint tenants_warning_before_critical CHECK ((sla_warning_pct < sla_critical_pct));

-- --------------------------------------------------------------------------
-- ticket_assets
-- --------------------------------------------------------------------------
create table public.ticket_assets (
  ticket_id uuid not null,
  asset_id uuid not null,
  tenant_id uuid not null,
  created_at timestamp with time zone default now() not null
);
alter table public.ticket_assets
  add constraint ticket_assets_pkey PRIMARY KEY (ticket_id, asset_id);

-- --------------------------------------------------------------------------
-- ticket_attachments
-- --------------------------------------------------------------------------
create table public.ticket_attachments (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  ticket_id uuid not null,
  comment_id uuid,
  storage_path text not null,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  uploaded_by uuid,
  created_at timestamp with time zone default now() not null,
  kind text default 'document'::text not null,
  thumbnail_path text,
  duration_seconds integer,
  width integer,
  height integer,
  scan_status text default 'skipped'::text not null
);
alter table public.ticket_attachments
  add constraint ticket_attachments_pkey PRIMARY KEY (id);
alter table public.ticket_attachments
  add constraint ticket_attachments_duration_seconds_check CHECK (((duration_seconds IS NULL) OR (duration_seconds >= 0)));
alter table public.ticket_attachments
  add constraint ticket_attachments_height_check CHECK (((height IS NULL) OR (height > 0)));
alter table public.ticket_attachments
  add constraint ticket_attachments_kind_check CHECK ((kind = ANY (ARRAY['image'::text, 'audio'::text, 'video'::text, 'document'::text])));
alter table public.ticket_attachments
  add constraint ticket_attachments_scan_status_check CHECK ((scan_status = ANY (ARRAY['pending'::text, 'clean'::text, 'infected'::text, 'skipped'::text])));
alter table public.ticket_attachments
  add constraint ticket_attachments_size_bytes_check CHECK ((size_bytes >= 0));
alter table public.ticket_attachments
  add constraint ticket_attachments_width_check CHECK (((width IS NULL) OR (width > 0)));

-- --------------------------------------------------------------------------
-- ticket_categories
-- --------------------------------------------------------------------------
create table public.ticket_categories (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  parent_id uuid,
  name text not null,
  description text,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.ticket_categories
  add constraint ticket_categories_pkey PRIMARY KEY (id);
alter table public.ticket_categories
  add constraint uq_category_id_tenant UNIQUE (id, tenant_id);

-- --------------------------------------------------------------------------
-- ticket_comments
-- --------------------------------------------------------------------------
create table public.ticket_comments (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  ticket_id uuid not null,
  author_id uuid,
  body text not null,
  visibility text default 'public'::text not null,
  source text default 'ui'::text not null,
  external_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone
);
alter table public.ticket_comments
  add constraint ticket_comments_pkey PRIMARY KEY (id);
alter table public.ticket_comments
  add constraint uq_comment_id_tenant UNIQUE (id, tenant_id);
alter table public.ticket_comments
  add constraint ticket_comments_body_check CHECK ((length(btrim(body)) > 0));
alter table public.ticket_comments
  add constraint ticket_comments_source_check CHECK ((source = ANY (ARRAY['ui'::text, 'api'::text, 'integration'::text, 'email'::text])));
alter table public.ticket_comments
  add constraint ticket_comments_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'internal'::text])));

-- --------------------------------------------------------------------------
-- ticket_field_service
-- --------------------------------------------------------------------------
create table public.ticket_field_service (
  ticket_id uuid not null,
  tenant_id uuid not null,
  equipment_id uuid not null,
  contract_item_id uuid,
  kind text default 'corrective'::text not null,
  cost_limit numeric(14,2),
  approved_by uuid,
  approved_at timestamp with time zone,
  approval_note text,
  billable_to text default 'provider'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.ticket_field_service
  add constraint ticket_field_service_pkey PRIMARY KEY (ticket_id);
alter table public.ticket_field_service
  add constraint ticket_field_service_billable_to_check CHECK ((billable_to = ANY (ARRAY['provider'::text, 'client'::text])));
alter table public.ticket_field_service
  add constraint ticket_field_service_cost_limit_check CHECK (((cost_limit IS NULL) OR (cost_limit >= (0)::numeric)));
alter table public.ticket_field_service
  add constraint ticket_field_service_kind_check CHECK ((kind = ANY (ARRAY['corrective'::text, 'preventive'::text, 'installation'::text, 'removal'::text])));

-- --------------------------------------------------------------------------
-- ticket_history
-- --------------------------------------------------------------------------
create table public.ticket_history (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  ticket_id uuid not null,
  actor_id uuid,
  field text not null,
  old_value text,
  new_value text,
  change_source text default 'ui'::text not null,
  reason text,
  created_at timestamp with time zone default now() not null
);
alter table public.ticket_history
  add constraint ticket_history_pkey PRIMARY KEY (id);

-- --------------------------------------------------------------------------
-- ticket_labor_entries
-- --------------------------------------------------------------------------
create table public.ticket_labor_entries (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  ticket_id uuid not null,
  technician_id uuid,
  worked_on date default CURRENT_DATE not null,
  hours numeric(6,2) not null,
  hourly_rate numeric(14,2) default 0 not null,
  amount numeric(14,2) not null,
  notes text,
  created_at timestamp with time zone default now() not null
);
alter table public.ticket_labor_entries
  add constraint ticket_labor_entries_pkey PRIMARY KEY (id);
alter table public.ticket_labor_entries
  add constraint ticket_labor_entries_amount_check CHECK ((amount >= (0)::numeric));
alter table public.ticket_labor_entries
  add constraint ticket_labor_entries_hourly_rate_check CHECK ((hourly_rate >= (0)::numeric));
alter table public.ticket_labor_entries
  add constraint ticket_labor_entries_hours_check CHECK (((hours > (0)::numeric) AND (hours <= (24)::numeric)));

-- --------------------------------------------------------------------------
-- ticket_parts_used
-- --------------------------------------------------------------------------
create table public.ticket_parts_used (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  ticket_id uuid not null,
  description text not null,
  quantity numeric(14,3) not null,
  unit_cost numeric(14,2) default 0 not null,
  amount numeric(14,2) not null,
  created_at timestamp with time zone default now() not null,
  part_id uuid,
  depot_id uuid
);
alter table public.ticket_parts_used
  add constraint ticket_parts_used_pkey PRIMARY KEY (id);
alter table public.ticket_parts_used
  add constraint ticket_parts_used_amount_check CHECK ((amount >= (0)::numeric));
alter table public.ticket_parts_used
  add constraint ticket_parts_used_quantity_check CHECK ((quantity > (0)::numeric));
alter table public.ticket_parts_used
  add constraint ticket_parts_used_unit_cost_check CHECK ((unit_cost >= (0)::numeric));

-- --------------------------------------------------------------------------
-- ticket_priorities
-- --------------------------------------------------------------------------
create table public.ticket_priorities (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  key text not null,
  label text not null,
  weight smallint not null,
  color text default '#64748b'::text not null,
  sort_order smallint default 0 not null,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.ticket_priorities
  add constraint ticket_priorities_pkey PRIMARY KEY (id);
alter table public.ticket_priorities
  add constraint uq_priority_id_tenant UNIQUE (id, tenant_id);
alter table public.ticket_priorities
  add constraint uq_priority_key UNIQUE (tenant_id, key);
alter table public.ticket_priorities
  add constraint ticket_priorities_key_check CHECK ((key ~ '^[a-z_]+$'::text));
alter table public.ticket_priorities
  add constraint ticket_priorities_weight_check CHECK (((weight >= 0) AND (weight <= 100)));

-- --------------------------------------------------------------------------
-- ticket_satisfaction
-- --------------------------------------------------------------------------
create table public.ticket_satisfaction (
  ticket_id uuid not null,
  tenant_id uuid not null,
  token_hash text not null,
  score smallint,
  comment text,
  sent_at timestamp with time zone default now() not null,
  answered_at timestamp with time zone,
  expires_at timestamp with time zone not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
alter table public.ticket_satisfaction
  add constraint ticket_satisfaction_pkey PRIMARY KEY (ticket_id);
alter table public.ticket_satisfaction
  add constraint ticket_satisfaction_token_hash_key UNIQUE (token_hash);
alter table public.ticket_satisfaction
  add constraint satisfaction_answered_has_score CHECK (((answered_at IS NULL) OR (score IS NOT NULL)));
alter table public.ticket_satisfaction
  add constraint ticket_satisfaction_comment_check CHECK (((comment IS NULL) OR (length(comment) <= 2000)));
alter table public.ticket_satisfaction
  add constraint ticket_satisfaction_score_check CHECK (((score >= 1) AND (score <= 5)));

-- --------------------------------------------------------------------------
-- ticket_status_transitions
-- --------------------------------------------------------------------------
create table public.ticket_status_transitions (
  from_status text not null,
  to_status text not null,
  description text
);
alter table public.ticket_status_transitions
  add constraint ticket_status_transitions_pkey PRIMARY KEY (from_status, to_status);

-- --------------------------------------------------------------------------
-- ticket_telecom_lines
-- --------------------------------------------------------------------------
create table public.ticket_telecom_lines (
  ticket_id uuid not null,
  line_id uuid not null,
  tenant_id uuid not null,
  created_at timestamp with time zone default now() not null
);
alter table public.ticket_telecom_lines
  add constraint ticket_telecom_lines_pkey PRIMARY KEY (ticket_id, line_id);

-- --------------------------------------------------------------------------
-- tickets
-- --------------------------------------------------------------------------
create table public.tickets (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  ticket_number bigint not null,
  title text not null,
  description text,
  status text default 'open'::text not null,
  priority_id uuid not null,
  category_id uuid,
  queue_id uuid not null,
  client_id uuid,
  branch_id uuid,
  requester_id uuid,
  assignee_id uuid,
  supplier_id uuid,
  tags text[] default '{}'::text[] not null,
  source text default 'ui'::text not null,
  source_system text,
  external_id text,
  external_url text,
  change_source text default 'ui'::text not null,
  first_response_at timestamp with time zone,
  resolved_at timestamp with time zone,
  closed_at timestamp with time zone,
  reopened_count integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone,
  service_id uuid,
  service_fields jsonb,
  service_price numeric(14,2)
);
alter table public.tickets
  add constraint tickets_pkey PRIMARY KEY (id);
alter table public.tickets
  add constraint uq_ticket_id_tenant UNIQUE (id, tenant_id);
alter table public.tickets
  add constraint uq_ticket_number UNIQUE (tenant_id, ticket_number);
alter table public.tickets
  add constraint tickets_change_source_check CHECK ((change_source = ANY (ARRAY['ui'::text, 'api'::text, 'integration'::text, 'system'::text])));
alter table public.tickets
  add constraint tickets_external_pair CHECK ((((external_id IS NULL) AND (source_system IS NULL)) OR ((external_id IS NOT NULL) AND (source_system IS NOT NULL))));
alter table public.tickets
  add constraint tickets_service_price_check CHECK (((service_price IS NULL) OR (service_price >= (0)::numeric)));
alter table public.tickets
  add constraint tickets_source_check CHECK ((source = ANY (ARRAY['ui'::text, 'api'::text, 'integration'::text, 'email'::text])));
alter table public.tickets
  add constraint tickets_status_check CHECK ((status = ANY (ARRAY['open'::text, 'triage'::text, 'assigned'::text, 'in_progress'::text, 'waiting_requester'::text, 'waiting_third_party'::text, 'waiting_approval'::text, 'resolved'::text, 'closed'::text])));
alter table public.tickets
  add constraint tickets_title_check CHECK ((length(btrim(title)) > 0));

-- --------------------------------------------------------------------------
-- user_branches
-- --------------------------------------------------------------------------
create table public.user_branches (
  user_id uuid not null,
  branch_id uuid not null,
  tenant_id uuid not null,
  is_primary boolean default false not null,
  created_at timestamp with time zone default now() not null
);
alter table public.user_branches
  add constraint user_branches_pkey PRIMARY KEY (user_id, branch_id);

-- ==========================================================================
-- OS RELACIONAMENTOS
-- ==========================================================================

alter table public.access_profiles
  add constraint access_profiles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.agent_alerts
  add constraint agent_alerts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.agent_alerts
  add constraint fk_aa_device FOREIGN KEY (device_id, tenant_id) REFERENCES agent_devices(id, tenant_id) ON DELETE CASCADE;
alter table public.agent_devices
  add constraint agent_devices_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.agent_devices
  add constraint fk_ad_asset FOREIGN KEY (it_asset_id, tenant_id) REFERENCES it_assets(id, tenant_id) ON DELETE SET NULL;
alter table public.agent_devices
  add constraint fk_ad_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE SET NULL;
alter table public.agent_devices
  add constraint fk_ad_enrollment FOREIGN KEY (enrollment_id, tenant_id) REFERENCES agent_enrollments(id, tenant_id) ON DELETE SET NULL;
alter table public.agent_enrollments
  add constraint agent_enrollments_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.agent_enrollments
  add constraint agent_enrollments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.agent_enrollments
  add constraint fk_ae_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE SET NULL;
alter table public.agent_inventory_snapshots
  add constraint agent_inventory_snapshots_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.agent_inventory_snapshots
  add constraint fk_ais_device FOREIGN KEY (device_id, tenant_id) REFERENCES agent_devices(id, tenant_id) ON DELETE CASCADE;
alter table public.agent_metrics_hourly
  add constraint agent_metrics_hourly_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.agent_metrics_hourly
  add constraint fk_amh_device FOREIGN KEY (device_id, tenant_id) REFERENCES agent_devices(id, tenant_id) ON DELETE CASCADE;
alter table public.agent_metrics_raw
  add constraint agent_metrics_raw_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.agent_metrics_raw
  add constraint fk_amr_device FOREIGN KEY (device_id, tenant_id) REFERENCES agent_devices(id, tenant_id) ON DELETE CASCADE;
alter table public.agent_software
  add constraint agent_software_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.agent_software
  add constraint fk_asw_device FOREIGN KEY (device_id, tenant_id) REFERENCES agent_devices(id, tenant_id) ON DELETE CASCADE;
alter table public.agent_volume_samples
  add constraint agent_volume_samples_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.agent_volume_samples
  add constraint fk_avs_device FOREIGN KEY (device_id, tenant_id) REFERENCES agent_devices(id, tenant_id) ON DELETE CASCADE;
alter table public.ai_settings
  add constraint ai_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.ai_settings
  add constraint ai_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.ai_suggestions
  add constraint ai_suggestions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.ai_suggestions
  add constraint fk_sug_acted_by FOREIGN KEY (acted_by, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.ai_suggestions
  add constraint fk_sug_requested_by FOREIGN KEY (requested_by, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.ai_suggestions
  add constraint fk_sug_ticket FOREIGN KEY (ticket_id, tenant_id) REFERENCES tickets(id, tenant_id) ON DELETE CASCADE;
alter table public.approval_rules
  add constraint approval_rules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.approval_rules
  add constraint fk_approval_rule_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE RESTRICT;
alter table public.approval_rules
  add constraint fk_approval_rule_cost_center FOREIGN KEY (cost_center_id, tenant_id) REFERENCES cost_centers(id, tenant_id) ON DELETE RESTRICT;
alter table public.approval_rules
  add constraint fk_approval_rule_profile FOREIGN KEY (required_profile_id, tenant_id) REFERENCES access_profiles(id, tenant_id) ON DELETE RESTRICT;
alter table public.asset_assignments
  add constraint asset_assignments_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.asset_assignments
  add constraint asset_assignments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.asset_assignments
  add constraint fk_aa_area FOREIGN KEY (branch_area_id, tenant_id) REFERENCES branch_areas(id, tenant_id) ON DELETE SET NULL;
alter table public.asset_assignments
  add constraint fk_aa_asset FOREIGN KEY (asset_id, tenant_id) REFERENCES it_assets(id, tenant_id) ON DELETE CASCADE;
alter table public.asset_assignments
  add constraint fk_aa_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE SET NULL;
alter table public.asset_assignments
  add constraint fk_aa_prev_area FOREIGN KEY (previous_area_id, tenant_id) REFERENCES branch_areas(id, tenant_id) ON DELETE SET NULL;
alter table public.asset_assignments
  add constraint fk_aa_prev_branch FOREIGN KEY (previous_branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE SET NULL;
alter table public.asset_assignments
  add constraint fk_aa_prev_user FOREIGN KEY (previous_user_id, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.asset_assignments
  add constraint fk_aa_user FOREIGN KEY (user_id, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.asset_attachments
  add constraint asset_attachments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.asset_attachments
  add constraint asset_attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.asset_attachments
  add constraint fk_asset_attach FOREIGN KEY (asset_id, tenant_id) REFERENCES it_assets(id, tenant_id) ON DELETE CASCADE;
alter table public.auth_tokens
  add constraint auth_tokens_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.auth_tokens
  add constraint auth_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.bank_account_movements
  add constraint bank_account_movements_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.bank_account_movements
  add constraint fk_movement_account FOREIGN KEY (bank_account_id, tenant_id) REFERENCES bank_accounts(id, tenant_id) ON DELETE RESTRICT;
alter table public.bank_account_movements
  add constraint fk_movement_cost_center FOREIGN KEY (cost_center_id, tenant_id) REFERENCES cost_centers(id, tenant_id) ON DELETE RESTRICT;
alter table public.bank_accounts
  add constraint bank_accounts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.branch_areas
  add constraint branch_areas_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.branch_areas
  add constraint fk_area_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE CASCADE;
alter table public.branches
  add constraint branches_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.branches
  add constraint fk_branches_business_hours FOREIGN KEY (business_hours_id, tenant_id) REFERENCES business_hours(id, tenant_id) ON DELETE SET NULL;
alter table public.branches
  add constraint fk_branches_client FOREIGN KEY (client_id, tenant_id) REFERENCES clients(id, tenant_id) ON DELETE CASCADE;
alter table public.business_hours
  add constraint business_hours_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.business_hours_holidays
  add constraint business_hours_holidays_business_hours_id_fkey FOREIGN KEY (business_hours_id) REFERENCES business_hours(id) ON DELETE CASCADE;
alter table public.business_hours_intervals
  add constraint business_hours_intervals_business_hours_id_fkey FOREIGN KEY (business_hours_id) REFERENCES business_hours(id) ON DELETE CASCADE;
alter table public.channel_contacts
  add constraint channel_contacts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.channel_contacts
  add constraint fk_contact_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE SET NULL;
alter table public.channel_contacts
  add constraint fk_contact_channel FOREIGN KEY (channel_id, tenant_id) REFERENCES channels(id, tenant_id) ON DELETE CASCADE;
alter table public.channel_contacts
  add constraint fk_contact_client FOREIGN KEY (client_id, tenant_id) REFERENCES clients(id, tenant_id) ON DELETE SET NULL;
alter table public.channel_contacts
  add constraint fk_contact_profile FOREIGN KEY (profile_id, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.channel_conversations
  add constraint channel_conversations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.channel_conversations
  add constraint fk_conv_channel FOREIGN KEY (channel_id, tenant_id) REFERENCES channels(id, tenant_id) ON DELETE CASCADE;
alter table public.channel_conversations
  add constraint fk_conv_contact FOREIGN KEY (contact_id, tenant_id) REFERENCES channel_contacts(id, tenant_id) ON DELETE CASCADE;
alter table public.channel_conversations
  add constraint fk_conv_ticket FOREIGN KEY (ticket_id, tenant_id) REFERENCES tickets(id, tenant_id) ON DELETE SET NULL;
alter table public.channel_messages
  add constraint channel_messages_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.channel_messages
  add constraint fk_msg_channel FOREIGN KEY (channel_id, tenant_id) REFERENCES channels(id, tenant_id) ON DELETE CASCADE;
alter table public.channel_messages
  add constraint fk_msg_comment FOREIGN KEY (comment_id, tenant_id) REFERENCES ticket_comments(id, tenant_id) ON DELETE SET NULL;
alter table public.channel_messages
  add constraint fk_msg_conversation FOREIGN KEY (conversation_id, tenant_id) REFERENCES channel_conversations(id, tenant_id) ON DELETE CASCADE;
alter table public.channels
  add constraint channels_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.channels
  add constraint channels_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.channels
  add constraint fk_channel_client FOREIGN KEY (default_client_id, tenant_id) REFERENCES clients(id, tenant_id) ON DELETE SET NULL;
alter table public.channels
  add constraint fk_channel_priority FOREIGN KEY (default_priority_id, tenant_id) REFERENCES ticket_priorities(id, tenant_id) ON DELETE SET NULL;
alter table public.channels
  add constraint fk_channel_queue FOREIGN KEY (default_queue_id, tenant_id) REFERENCES queues(id, tenant_id) ON DELETE SET NULL;
alter table public.clients
  add constraint clients_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.cost_centers
  add constraint cost_centers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.cost_centers
  add constraint fk_cost_center_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE RESTRICT;
alter table public.cost_centers
  add constraint fk_cost_center_parent FOREIGN KEY (parent_id, tenant_id) REFERENCES cost_centers(id, tenant_id) ON DELETE RESTRICT;
alter table public.dashboard_layouts
  add constraint dashboard_layouts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.dashboard_tokens
  add constraint dashboard_tokens_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.dashboard_tokens
  add constraint dashboard_tokens_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.dashboard_tokens
  add constraint fk_dt_layout FOREIGN KEY (layout_id, tenant_id) REFERENCES dashboard_layouts(id, tenant_id) ON DELETE SET NULL;
alter table public.email_outbox
  add constraint email_outbox_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.equipment_categories
  add constraint equipment_categories_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.equipment_manufacturers
  add constraint equipment_manufacturers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.equipment_models
  add constraint equipment_models_category_id_fkey FOREIGN KEY (category_id) REFERENCES equipment_categories(id) ON DELETE RESTRICT;
alter table public.equipment_models
  add constraint equipment_models_manufacturer_id_fkey FOREIGN KEY (manufacturer_id) REFERENCES equipment_manufacturers(id) ON DELETE RESTRICT;
alter table public.equipment_models
  add constraint equipment_models_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.expense_categories
  add constraint expense_categories_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.geocode_candidates
  add constraint fk_geocode_candidates_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE CASCADE;
alter table public.geocode_candidates
  add constraint geocode_candidates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.geocode_logs
  add constraint fk_geocode_logs_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE CASCADE;
alter table public.geocode_logs
  add constraint geocode_logs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.geocode_logs
  add constraint geocode_logs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.import_batches
  add constraint import_batches_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.import_batches
  add constraint import_batches_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.import_rows
  add constraint import_rows_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE;
alter table public.import_rows
  add constraint import_rows_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.integration_events
  add constraint fk_ie_integration FOREIGN KEY (integration_id, tenant_id) REFERENCES integrations(id, tenant_id) ON DELETE CASCADE;
alter table public.integration_events
  add constraint fk_ie_ticket FOREIGN KEY (ticket_id, tenant_id) REFERENCES tickets(id, tenant_id) ON DELETE SET NULL;
alter table public.integration_events
  add constraint integration_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.integration_logs
  add constraint fk_il_integration FOREIGN KEY (integration_id, tenant_id) REFERENCES integrations(id, tenant_id) ON DELETE CASCADE;
alter table public.integration_logs
  add constraint integration_logs_event_id_fkey FOREIGN KEY (event_id) REFERENCES integration_events(id) ON DELETE SET NULL;
alter table public.integration_logs
  add constraint integration_logs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.integration_mapping_versions
  add constraint fk_imv_integration FOREIGN KEY (integration_id, tenant_id) REFERENCES integrations(id, tenant_id) ON DELETE CASCADE;
alter table public.integration_mapping_versions
  add constraint integration_mapping_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.integration_mapping_versions
  add constraint integration_mapping_versions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.integration_mappings
  add constraint fk_im_integration FOREIGN KEY (integration_id, tenant_id) REFERENCES integrations(id, tenant_id) ON DELETE CASCADE;
alter table public.integration_mappings
  add constraint integration_mappings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.integration_sync_state
  add constraint fk_iss_integration FOREIGN KEY (integration_id, tenant_id) REFERENCES integrations(id, tenant_id) ON DELETE CASCADE;
alter table public.integration_sync_state
  add constraint fk_iss_ticket FOREIGN KEY (ticket_id, tenant_id) REFERENCES tickets(id, tenant_id) ON DELETE CASCADE;
alter table public.integration_sync_state
  add constraint integration_sync_state_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.integrations
  add constraint integrations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.internet_link_attachments
  add constraint fk_link_attach FOREIGN KEY (link_id, tenant_id) REFERENCES internet_links(id, tenant_id) ON DELETE CASCADE;
alter table public.internet_link_attachments
  add constraint internet_link_attachments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.internet_link_attachments
  add constraint internet_link_attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.internet_links
  add constraint fk_link_area FOREIGN KEY (branch_area_id, tenant_id) REFERENCES branch_areas(id, tenant_id) ON DELETE RESTRICT;
alter table public.internet_links
  add constraint fk_link_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE CASCADE;
alter table public.internet_links
  add constraint fk_link_cpe FOREIGN KEY (cpe_asset_id, tenant_id) REFERENCES it_assets(id, tenant_id) ON DELETE SET NULL;
alter table public.internet_links
  add constraint fk_link_supplier FOREIGN KEY (supplier_id, tenant_id) REFERENCES suppliers(id, tenant_id) ON DELETE SET NULL;
alter table public.internet_links
  add constraint internet_links_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.inventory_count_items
  add constraint inventory_count_items_count_id_fkey FOREIGN KEY (count_id) REFERENCES inventory_counts(id) ON DELETE CASCADE;
alter table public.inventory_count_items
  add constraint inventory_count_items_part_id_fkey FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE RESTRICT;
alter table public.inventory_count_items
  add constraint inventory_count_items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.inventory_counts
  add constraint inventory_counts_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.inventory_counts
  add constraint inventory_counts_depot_id_fkey FOREIGN KEY (depot_id) REFERENCES rental_depots(id) ON DELETE RESTRICT;
alter table public.inventory_counts
  add constraint inventory_counts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.invites
  add constraint invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.invites
  add constraint invites_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.it_assets
  add constraint fk_asset_area FOREIGN KEY (branch_area_id, tenant_id) REFERENCES branch_areas(id, tenant_id) ON DELETE RESTRICT;
alter table public.it_assets
  add constraint fk_asset_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE SET NULL;
alter table public.it_assets
  add constraint fk_asset_supplier FOREIGN KEY (supplier_id, tenant_id) REFERENCES suppliers(id, tenant_id) ON DELETE SET NULL;
alter table public.it_assets
  add constraint fk_asset_user FOREIGN KEY (assigned_user_id, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.it_assets
  add constraint it_assets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.it_budget_closings
  add constraint fk_closing_author FOREIGN KEY (closed_by, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.it_budget_closings
  add constraint fk_closing_client FOREIGN KEY (client_id, tenant_id) REFERENCES clients(id, tenant_id) ON DELETE CASCADE;
alter table public.it_budget_closings
  add constraint fk_closing_reopener FOREIGN KEY (reopened_by, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.it_budget_closings
  add constraint it_budget_closings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.it_budget_scenarios
  add constraint fk_scenario_client FOREIGN KEY (client_id, tenant_id) REFERENCES clients(id, tenant_id) ON DELETE CASCADE;
alter table public.it_budget_scenarios
  add constraint it_budget_scenarios_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.it_budget_targets
  add constraint fk_target_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE CASCADE;
alter table public.it_budget_targets
  add constraint fk_target_category FOREIGN KEY (expense_category_id, tenant_id) REFERENCES expense_categories(id, tenant_id) ON DELETE CASCADE;
alter table public.it_budget_targets
  add constraint fk_target_client FOREIGN KEY (client_id, tenant_id) REFERENCES clients(id, tenant_id) ON DELETE CASCADE;
alter table public.it_budget_targets
  add constraint it_budget_targets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.it_cost_beneficiaries
  add constraint fk_benef_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE CASCADE;
alter table public.it_cost_beneficiaries
  add constraint fk_benef_entry FOREIGN KEY (entry_id, tenant_id) REFERENCES it_cost_entries(id, tenant_id) ON DELETE CASCADE;
alter table public.it_cost_beneficiaries
  add constraint it_cost_beneficiaries_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.it_cost_entries
  add constraint fk_entry_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE SET NULL;
alter table public.it_cost_entries
  add constraint fk_entry_category FOREIGN KEY (expense_category_id, tenant_id) REFERENCES expense_categories(id, tenant_id) ON DELETE RESTRICT;
alter table public.it_cost_entries
  add constraint fk_entry_client FOREIGN KEY (client_id, tenant_id) REFERENCES clients(id, tenant_id) ON DELETE CASCADE;
alter table public.it_cost_entries
  add constraint fk_entry_cost_center FOREIGN KEY (cost_center_id, tenant_id) REFERENCES cost_centers(id, tenant_id) ON DELETE SET NULL;
alter table public.it_cost_entries
  add constraint fk_entry_creator FOREIGN KEY (created_by, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.it_cost_entries
  add constraint fk_entry_parent FOREIGN KEY (parent_entry_id, tenant_id) REFERENCES it_cost_entries(id, tenant_id) ON DELETE CASCADE;
alter table public.it_cost_entries
  add constraint fk_entry_payable FOREIGN KEY (payable_id, tenant_id) REFERENCES payables(id, tenant_id) ON DELETE SET NULL;
alter table public.it_cost_entries
  add constraint fk_entry_scenario FOREIGN KEY (scenario_id, tenant_id) REFERENCES it_budget_scenarios(id, tenant_id) ON DELETE CASCADE;
alter table public.it_cost_entries
  add constraint fk_entry_supplier FOREIGN KEY (supplier_id, tenant_id) REFERENCES suppliers(id, tenant_id) ON DELETE SET NULL;
alter table public.it_cost_entries
  add constraint it_cost_entries_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.job_alert_episodes
  add constraint job_alert_episodes_job_fkey FOREIGN KEY (job) REFERENCES job_expectations(job) ON DELETE CASCADE;
alter table public.kb_articles
  add constraint fk_kb_autor FOREIGN KEY (author_id, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.kb_articles
  add constraint fk_kb_categoria FOREIGN KEY (category_id, tenant_id) REFERENCES ticket_categories(id, tenant_id) ON DELETE SET NULL;
alter table public.kb_articles
  add constraint fk_kb_ticket FOREIGN KEY (source_ticket_id, tenant_id) REFERENCES tickets(id, tenant_id) ON DELETE SET NULL;
alter table public.kb_articles
  add constraint kb_articles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.kb_feedback
  add constraint fk_kbf_article FOREIGN KEY (article_id, tenant_id) REFERENCES kb_articles(id, tenant_id) ON DELETE CASCADE;
alter table public.kb_feedback
  add constraint fk_kbf_user FOREIGN KEY (user_id, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE CASCADE;
alter table public.kb_feedback
  add constraint kb_feedback_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.link_availability_events
  add constraint fk_link_event FOREIGN KEY (link_id, tenant_id) REFERENCES internet_links(id, tenant_id) ON DELETE CASCADE;
alter table public.link_availability_events
  add constraint link_availability_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.meter_readings
  add constraint meter_readings_contract_item_id_fkey FOREIGN KEY (contract_item_id) REFERENCES rental_contract_items(id) ON DELETE SET NULL;
alter table public.meter_readings
  add constraint meter_readings_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES rental_equipment(id) ON DELETE CASCADE;
alter table public.meter_readings
  add constraint meter_readings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.monitoring_webhooks
  add constraint monitoring_webhooks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.notification_preferences
  add constraint fk_notif_pref_profile FOREIGN KEY (user_id, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE CASCADE;
alter table public.notification_preferences
  add constraint notification_preferences_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.operation_locations
  add constraint operation_locations_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;
alter table public.operation_locations
  add constraint operation_locations_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT;
alter table public.operation_locations
  add constraint operation_locations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.part_balances
  add constraint part_balances_depot_id_fkey FOREIGN KEY (depot_id) REFERENCES rental_depots(id) ON DELETE CASCADE;
alter table public.part_balances
  add constraint part_balances_part_id_fkey FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE;
alter table public.part_balances
  add constraint part_balances_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.part_movements
  add constraint part_movements_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.part_movements
  add constraint part_movements_depot_id_fkey FOREIGN KEY (depot_id) REFERENCES rental_depots(id) ON DELETE RESTRICT;
alter table public.part_movements
  add constraint part_movements_part_id_fkey FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE RESTRICT;
alter table public.part_movements
  add constraint part_movements_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.part_movements
  add constraint part_movements_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL;
alter table public.part_movements
  add constraint part_movements_transfer_depot_id_fkey FOREIGN KEY (transfer_depot_id) REFERENCES rental_depots(id) ON DELETE SET NULL;
alter table public.part_stock_policies
  add constraint part_stock_policies_depot_id_fkey FOREIGN KEY (depot_id) REFERENCES rental_depots(id) ON DELETE CASCADE;
alter table public.part_stock_policies
  add constraint part_stock_policies_part_id_fkey FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE;
alter table public.part_stock_policies
  add constraint part_stock_policies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.parts
  add constraint parts_manufacturer_id_fkey FOREIGN KEY (manufacturer_id) REFERENCES equipment_manufacturers(id) ON DELETE SET NULL;
alter table public.parts
  add constraint parts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.payable_approvals
  add constraint fk_approval_payable FOREIGN KEY (payable_id, tenant_id) REFERENCES payables(id, tenant_id) ON DELETE CASCADE;
alter table public.payable_approvals
  add constraint payable_approvals_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.payable_approvals
  add constraint payable_approvals_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.payable_attachments
  add constraint fk_payable_attach FOREIGN KEY (payable_id, tenant_id) REFERENCES payables(id, tenant_id) ON DELETE CASCADE;
alter table public.payable_attachments
  add constraint payable_attachments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.payable_attachments
  add constraint payable_attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.payables
  add constraint fk_payable_bank_account FOREIGN KEY (bank_account_id, tenant_id) REFERENCES bank_accounts(id, tenant_id) ON DELETE RESTRICT;
alter table public.payables
  add constraint fk_payable_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE RESTRICT;
alter table public.payables
  add constraint fk_payable_category FOREIGN KEY (expense_category_id, tenant_id) REFERENCES expense_categories(id, tenant_id) ON DELETE RESTRICT;
alter table public.payables
  add constraint fk_payable_contract FOREIGN KEY (supplier_contract_id, tenant_id) REFERENCES supplier_contracts(id, tenant_id) ON DELETE RESTRICT;
alter table public.payables
  add constraint fk_payable_cost_center FOREIGN KEY (cost_center_id, tenant_id) REFERENCES cost_centers(id, tenant_id) ON DELETE RESTRICT;
alter table public.payables
  add constraint fk_payable_parent FOREIGN KEY (parent_payable_id, tenant_id) REFERENCES payables(id, tenant_id) ON DELETE CASCADE;
alter table public.payables
  add constraint fk_payable_supplier FOREIGN KEY (supplier_id, tenant_id) REFERENCES suppliers(id, tenant_id) ON DELETE RESTRICT;
alter table public.payables
  add constraint payables_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.payables
  add constraint payables_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.payables
  add constraint payables_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.permission_grants
  add constraint fk_grant_profile FOREIGN KEY (profile_id, tenant_id) REFERENCES access_profiles(id, tenant_id) ON DELETE CASCADE;
alter table public.permission_grants
  add constraint permission_grants_permission_key_fkey FOREIGN KEY (permission_key) REFERENCES permission_catalog(key) ON DELETE CASCADE;
alter table public.permission_grants
  add constraint permission_grants_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.profiles
  add constraint fk_profile_focused_client FOREIGN KEY (focused_client_id, tenant_id) REFERENCES clients(id, tenant_id) ON DELETE SET NULL;
alter table public.profiles
  add constraint fk_profiles_access_profile FOREIGN KEY (access_profile_id, tenant_id) REFERENCES access_profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.profiles
  add constraint profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.profiles
  add constraint profiles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.project_members
  add constraint fk_member_profile FOREIGN KEY (profile_id, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.project_members
  add constraint fk_member_project FOREIGN KEY (project_id, tenant_id) REFERENCES projects(id, tenant_id) ON DELETE CASCADE;
alter table public.project_members
  add constraint project_members_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.project_tasks
  add constraint fk_task_parent FOREIGN KEY (parent_task_id, tenant_id) REFERENCES project_tasks(id, tenant_id) ON DELETE RESTRICT;
alter table public.project_tasks
  add constraint fk_task_project FOREIGN KEY (project_id, tenant_id) REFERENCES projects(id, tenant_id) ON DELETE CASCADE;
alter table public.project_tasks
  add constraint project_tasks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.projects
  add constraint fk_project_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE SET NULL;
alter table public.projects
  add constraint fk_project_client FOREIGN KEY (client_id, tenant_id) REFERENCES clients(id, tenant_id) ON DELETE CASCADE;
alter table public.projects
  add constraint fk_project_creator FOREIGN KEY (created_by, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.projects
  add constraint projects_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.purchase_order_items
  add constraint purchase_order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE;
alter table public.purchase_order_items
  add constraint purchase_order_items_part_id_fkey FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE RESTRICT;
alter table public.purchase_order_items
  add constraint purchase_order_items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.purchase_orders
  add constraint purchase_orders_depot_id_fkey FOREIGN KEY (depot_id) REFERENCES rental_depots(id) ON DELETE RESTRICT;
alter table public.purchase_orders
  add constraint purchase_orders_payable_id_fkey FOREIGN KEY (payable_id) REFERENCES payables(id) ON DELETE SET NULL;
alter table public.purchase_orders
  add constraint purchase_orders_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT;
alter table public.purchase_orders
  add constraint purchase_orders_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.queue_members
  add constraint fk_qm_queue FOREIGN KEY (queue_id, tenant_id) REFERENCES queues(id, tenant_id) ON DELETE CASCADE;
alter table public.queue_members
  add constraint fk_qm_user FOREIGN KEY (user_id, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE CASCADE;
alter table public.queue_members
  add constraint queue_members_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.queue_rules
  add constraint fk_qr_queue FOREIGN KEY (queue_id, tenant_id) REFERENCES queues(id, tenant_id) ON DELETE CASCADE;
alter table public.queue_rules
  add constraint queue_rules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.queues
  add constraint queues_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.receivables
  add constraint fk_receivable_bank_account FOREIGN KEY (bank_account_id, tenant_id) REFERENCES bank_accounts(id, tenant_id) ON DELETE RESTRICT;
alter table public.receivables
  add constraint fk_receivable_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE RESTRICT;
alter table public.receivables
  add constraint fk_receivable_client FOREIGN KEY (client_id, tenant_id) REFERENCES clients(id, tenant_id) ON DELETE RESTRICT;
alter table public.receivables
  add constraint fk_receivable_cost_center FOREIGN KEY (cost_center_id, tenant_id) REFERENCES cost_centers(id, tenant_id) ON DELETE RESTRICT;
alter table public.receivables
  add constraint fk_receivable_parent FOREIGN KEY (parent_receivable_id, tenant_id) REFERENCES receivables(id, tenant_id) ON DELETE CASCADE;
alter table public.receivables
  add constraint fk_receivable_sla_contract FOREIGN KEY (sla_contract_id, tenant_id) REFERENCES sla_contracts(id, tenant_id) ON DELETE RESTRICT;
alter table public.receivables
  add constraint receivables_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.receivables
  add constraint receivables_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.rental_contract_items
  add constraint rental_contract_items_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES rental_contracts(id) ON DELETE CASCADE;
alter table public.rental_contract_items
  add constraint rental_contract_items_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES rental_equipment(id) ON DELETE RESTRICT;
alter table public.rental_contract_items
  add constraint rental_contract_items_operation_location_id_fkey FOREIGN KEY (operation_location_id) REFERENCES operation_locations(id) ON DELETE SET NULL;
alter table public.rental_contract_items
  add constraint rental_contract_items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.rental_contracts
  add constraint rental_contracts_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT;
alter table public.rental_contracts
  add constraint rental_contracts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.rental_depots
  add constraint rental_depots_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.rental_equipment
  add constraint rental_equipment_depot_id_fkey FOREIGN KEY (depot_id) REFERENCES rental_depots(id) ON DELETE RESTRICT;
alter table public.rental_equipment
  add constraint rental_equipment_model_id_fkey FOREIGN KEY (model_id) REFERENCES equipment_models(id) ON DELETE RESTRICT;
alter table public.rental_equipment
  add constraint rental_equipment_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.rental_equipment_movements
  add constraint rental_equipment_movements_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES rental_equipment(id) ON DELETE CASCADE;
alter table public.rental_equipment_movements
  add constraint rental_equipment_movements_from_depot_id_fkey FOREIGN KEY (from_depot_id) REFERENCES rental_depots(id) ON DELETE SET NULL;
alter table public.rental_equipment_movements
  add constraint rental_equipment_movements_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.rental_equipment_movements
  add constraint rental_equipment_movements_to_depot_id_fkey FOREIGN KEY (to_depot_id) REFERENCES rental_depots(id) ON DELETE SET NULL;
alter table public.rental_invoice_items
  add constraint rental_invoice_items_contract_item_id_fkey FOREIGN KEY (contract_item_id) REFERENCES rental_contract_items(id) ON DELETE SET NULL;
alter table public.rental_invoice_items
  add constraint rental_invoice_items_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES rental_equipment(id) ON DELETE SET NULL;
alter table public.rental_invoice_items
  add constraint rental_invoice_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES rental_invoices(id) ON DELETE CASCADE;
alter table public.rental_invoice_items
  add constraint rental_invoice_items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.rental_invoices
  add constraint rental_invoices_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT;
alter table public.rental_invoices
  add constraint rental_invoices_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES rental_contracts(id) ON DELETE RESTRICT;
alter table public.rental_invoices
  add constraint rental_invoices_receivable_id_fkey FOREIGN KEY (receivable_id) REFERENCES receivables(id) ON DELETE SET NULL;
alter table public.rental_invoices
  add constraint rental_invoices_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.service_approvals
  add constraint fk_sa_service FOREIGN KEY (service_id, tenant_id) REFERENCES service_catalog(id, tenant_id) ON DELETE RESTRICT;
alter table public.service_approvals
  add constraint fk_sa_ticket FOREIGN KEY (ticket_id, tenant_id) REFERENCES tickets(id, tenant_id) ON DELETE CASCADE;
alter table public.service_approvals
  add constraint service_approvals_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.service_approvals
  add constraint service_approvals_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.service_approvals
  add constraint service_approvals_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.service_catalog
  add constraint fk_sc_aprovador FOREIGN KEY (aprovador_profile_id, tenant_id) REFERENCES access_profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.service_catalog
  add constraint fk_sc_categoria FOREIGN KEY (category_id, tenant_id) REFERENCES ticket_categories(id, tenant_id) ON DELETE SET NULL;
alter table public.service_catalog
  add constraint fk_sc_fila FOREIGN KEY (queue_id, tenant_id) REFERENCES queues(id, tenant_id) ON DELETE SET NULL;
alter table public.service_catalog
  add constraint fk_sc_prioridade FOREIGN KEY (priority_id, tenant_id) REFERENCES ticket_priorities(id, tenant_id) ON DELETE SET NULL;
alter table public.service_catalog
  add constraint service_catalog_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.service_catalog_clients
  add constraint fk_scc_client FOREIGN KEY (client_id, tenant_id) REFERENCES clients(id, tenant_id) ON DELETE CASCADE;
alter table public.service_catalog_clients
  add constraint fk_scc_service FOREIGN KEY (service_id, tenant_id) REFERENCES service_catalog(id, tenant_id) ON DELETE CASCADE;
alter table public.service_catalog_clients
  add constraint service_catalog_clients_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.sla_contracts
  add constraint fk_slac_bh FOREIGN KEY (business_hours_id, tenant_id) REFERENCES business_hours(id, tenant_id) ON DELETE SET NULL;
alter table public.sla_contracts
  add constraint fk_slac_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE CASCADE;
alter table public.sla_contracts
  add constraint fk_slac_client FOREIGN KEY (client_id, tenant_id) REFERENCES clients(id, tenant_id) ON DELETE CASCADE;
alter table public.sla_contracts
  add constraint sla_contracts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.sla_definitions
  add constraint fk_slad_bh FOREIGN KEY (business_hours_id, tenant_id) REFERENCES business_hours(id, tenant_id) ON DELETE SET NULL;
alter table public.sla_definitions
  add constraint fk_slad_category FOREIGN KEY (category_id, tenant_id) REFERENCES ticket_categories(id, tenant_id) ON DELETE CASCADE;
alter table public.sla_definitions
  add constraint fk_slad_contract FOREIGN KEY (contract_id, tenant_id) REFERENCES sla_contracts(id, tenant_id) ON DELETE CASCADE;
alter table public.sla_definitions
  add constraint fk_slad_priority FOREIGN KEY (priority_id, tenant_id) REFERENCES ticket_priorities(id, tenant_id) ON DELETE CASCADE;
alter table public.sla_definitions
  add constraint sla_definitions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.sla_pauses
  add constraint sla_pauses_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.sla_pauses
  add constraint sla_pauses_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;
alter table public.sla_tracking
  add constraint sla_tracking_business_hours_id_fkey FOREIGN KEY (business_hours_id) REFERENCES business_hours(id) ON DELETE SET NULL;
alter table public.sla_tracking
  add constraint sla_tracking_sla_definition_id_fkey FOREIGN KEY (sla_definition_id) REFERENCES sla_definitions(id) ON DELETE SET NULL;
alter table public.sla_tracking
  add constraint sla_tracking_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.sla_tracking
  add constraint sla_tracking_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;
alter table public.supplier_contracts
  add constraint fk_sc_supplier FOREIGN KEY (supplier_id, tenant_id) REFERENCES suppliers(id, tenant_id) ON DELETE CASCADE;
alter table public.supplier_contracts
  add constraint supplier_contracts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.suppliers
  add constraint suppliers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.telecom_line_attachments
  add constraint fk_line_attach FOREIGN KEY (line_id, tenant_id) REFERENCES telecom_lines(id, tenant_id) ON DELETE CASCADE;
alter table public.telecom_line_attachments
  add constraint telecom_line_attachments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.telecom_line_attachments
  add constraint telecom_line_attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.telecom_lines
  add constraint fk_line_area FOREIGN KEY (company_area_id, tenant_id) REFERENCES branch_areas(id, tenant_id) ON DELETE RESTRICT;
alter table public.telecom_lines
  add constraint fk_line_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE SET NULL;
alter table public.telecom_lines
  add constraint fk_line_device FOREIGN KEY (device_asset_id, tenant_id) REFERENCES it_assets(id, tenant_id) ON DELETE SET NULL;
alter table public.telecom_lines
  add constraint fk_line_user FOREIGN KEY (assigned_user_id, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.telecom_lines
  add constraint telecom_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.tenant_status_events
  add constraint tenant_status_events_por_fkey FOREIGN KEY (por) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.tenant_status_events
  add constraint tenant_status_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.tenants
  add constraint tenants_plano_id_fkey FOREIGN KEY (plano_id) REFERENCES planos(id) ON DELETE SET NULL;
alter table public.ticket_assets
  add constraint fk_ta_asset FOREIGN KEY (asset_id, tenant_id) REFERENCES it_assets(id, tenant_id) ON DELETE CASCADE;
alter table public.ticket_assets
  add constraint fk_ta_ticket FOREIGN KEY (ticket_id, tenant_id) REFERENCES tickets(id, tenant_id) ON DELETE CASCADE;
alter table public.ticket_assets
  add constraint ticket_assets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.ticket_attachments
  add constraint fk_attach_comment FOREIGN KEY (comment_id, tenant_id) REFERENCES ticket_comments(id, tenant_id) ON DELETE CASCADE;
alter table public.ticket_attachments
  add constraint fk_attach_ticket FOREIGN KEY (ticket_id, tenant_id) REFERENCES tickets(id, tenant_id) ON DELETE CASCADE;
alter table public.ticket_attachments
  add constraint ticket_attachments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.ticket_attachments
  add constraint ticket_attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.ticket_categories
  add constraint fk_category_parent FOREIGN KEY (parent_id, tenant_id) REFERENCES ticket_categories(id, tenant_id) ON DELETE CASCADE;
alter table public.ticket_categories
  add constraint ticket_categories_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.ticket_comments
  add constraint fk_comment_author FOREIGN KEY (author_id, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.ticket_comments
  add constraint fk_comment_ticket FOREIGN KEY (ticket_id, tenant_id) REFERENCES tickets(id, tenant_id) ON DELETE CASCADE;
alter table public.ticket_comments
  add constraint ticket_comments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.ticket_field_service
  add constraint ticket_field_service_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.ticket_field_service
  add constraint ticket_field_service_contract_item_id_fkey FOREIGN KEY (contract_item_id) REFERENCES rental_contract_items(id) ON DELETE SET NULL;
alter table public.ticket_field_service
  add constraint ticket_field_service_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES rental_equipment(id) ON DELETE RESTRICT;
alter table public.ticket_field_service
  add constraint ticket_field_service_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.ticket_field_service
  add constraint ticket_field_service_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;
alter table public.ticket_history
  add constraint ticket_history_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.ticket_history
  add constraint ticket_history_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.ticket_history
  add constraint ticket_history_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;
alter table public.ticket_labor_entries
  add constraint ticket_labor_entries_technician_id_fkey FOREIGN KEY (technician_id) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.ticket_labor_entries
  add constraint ticket_labor_entries_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.ticket_labor_entries
  add constraint ticket_labor_entries_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;
alter table public.ticket_parts_used
  add constraint ticket_parts_used_depot_id_fkey FOREIGN KEY (depot_id) REFERENCES rental_depots(id) ON DELETE SET NULL;
alter table public.ticket_parts_used
  add constraint ticket_parts_used_part_id_fkey FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE SET NULL;
alter table public.ticket_parts_used
  add constraint ticket_parts_used_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.ticket_parts_used
  add constraint ticket_parts_used_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;
alter table public.ticket_priorities
  add constraint ticket_priorities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.ticket_satisfaction
  add constraint fk_satisfaction_ticket FOREIGN KEY (ticket_id, tenant_id) REFERENCES tickets(id, tenant_id) ON DELETE CASCADE;
alter table public.ticket_satisfaction
  add constraint ticket_satisfaction_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.ticket_telecom_lines
  add constraint fk_tl_line FOREIGN KEY (line_id, tenant_id) REFERENCES telecom_lines(id, tenant_id) ON DELETE CASCADE;
alter table public.ticket_telecom_lines
  add constraint fk_tl_ticket FOREIGN KEY (ticket_id, tenant_id) REFERENCES tickets(id, tenant_id) ON DELETE CASCADE;
alter table public.ticket_telecom_lines
  add constraint ticket_telecom_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.tickets
  add constraint fk_ticket_service FOREIGN KEY (service_id, tenant_id) REFERENCES service_catalog(id, tenant_id) ON DELETE SET NULL;
alter table public.tickets
  add constraint fk_tickets_assignee FOREIGN KEY (assignee_id, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.tickets
  add constraint fk_tickets_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE SET NULL;
alter table public.tickets
  add constraint fk_tickets_category FOREIGN KEY (category_id, tenant_id) REFERENCES ticket_categories(id, tenant_id) ON DELETE SET NULL;
alter table public.tickets
  add constraint fk_tickets_client FOREIGN KEY (client_id, tenant_id) REFERENCES clients(id, tenant_id) ON DELETE SET NULL;
alter table public.tickets
  add constraint fk_tickets_priority FOREIGN KEY (priority_id, tenant_id) REFERENCES ticket_priorities(id, tenant_id);
alter table public.tickets
  add constraint fk_tickets_queue FOREIGN KEY (queue_id, tenant_id) REFERENCES queues(id, tenant_id);
alter table public.tickets
  add constraint fk_tickets_requester FOREIGN KEY (requester_id, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE SET NULL;
alter table public.tickets
  add constraint fk_tickets_supplier FOREIGN KEY (supplier_id, tenant_id) REFERENCES suppliers(id, tenant_id) ON DELETE SET NULL;
alter table public.tickets
  add constraint tickets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.user_branches
  add constraint fk_user_branches_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE CASCADE;
alter table public.user_branches
  add constraint fk_user_branches_user FOREIGN KEY (user_id, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE CASCADE;
alter table public.user_branches
  add constraint user_branches_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- ==========================================================================
-- A QUEM CADA SEQUÊNCIA PERTENCE
-- ==========================================================================
-- Sem o `owned by`, apagar a tabela deixa a sequência órfã no banco,
-- e recriar a tabela esbarra num nome que já existe.
alter sequence public.auth_tokens_id_seq owned by public.auth_tokens.id;
alter sequence public.invites_id_seq owned by public.invites.id;
alter sequence public.job_alert_episodes_id_seq owned by public.job_alert_episodes.id;
alter sequence public.job_runs_id_seq owned by public.job_runs.id;
alter sequence public.tenant_status_events_id_seq owned by public.tenant_status_events.id;
