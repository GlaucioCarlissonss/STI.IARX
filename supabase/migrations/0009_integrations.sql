-- =============================================================================
-- 0009 — Integration Hub (RF-INT) — genérico, com Bitrix24 como primeira fonte
-- =============================================================================

-- -----------------------------------------------------------------------------
-- integrations (RF-INT-03)
-- -----------------------------------------------------------------------------
create table public.integrations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  name          text not null,
  slug          text not null,
  source_system text not null,               -- 'bitrix24', 'zabbix', 'generic', …
  direction     text not null default 'inbound'
                  check (direction in ('inbound','outbound','bidirectional')),
  status        text not null default 'paused'
                  check (status in ('active','paused','error')),

  auth_type     text not null default 'webhook_token'
                  check (auth_type in ('none','webhook_token','api_key','oauth2','hmac')),

  -- SEGREDOS NÃO FICAM AQUI (ADR-009). `secret_ref` é apenas o NOME da variável
  -- de ambiente/secret da Edge Function que contém a credencial de saída.
  secret_ref    text,
  -- Token de verificação inbound guardado como HASH. A verificação compara
  -- hashes; o valor em claro nunca é persistido.
  inbound_token_hash text,

  base_url      text,
  config        jsonb not null default '{}'::jsonb,

  -- Sincronização reversa desligada por padrão (lacuna L-06, ADR-008).
  reverse_sync_enabled boolean not null default false,
  -- Janela de supressão de eco, em segundos.
  echo_window_seconds  integer not null default 120 check (echo_window_seconds >= 0),

  -- Polling só quando a origem não suporta webhook (RF-INT-07).
  polling_enabled       boolean not null default false,
  polling_interval_secs integer check (polling_interval_secs is null or polling_interval_secs >= 60),

  last_sync_at   timestamptz,
  request_count  bigint not null default 0,
  error_count    bigint not null default 0,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint uq_integration_slug unique (tenant_id, slug),
  constraint uq_integration_id_tenant unique (id, tenant_id),
  constraint integration_config_object check (jsonb_typeof(config) = 'object'),
  constraint integration_polling_needs_interval
    check (not polling_enabled or polling_interval_secs is not null)
);

create index idx_integrations_tenant on public.integrations (tenant_id, status);
-- Resolução do webhook inbound: recebe o slug na URL e o token no corpo/header.
create index idx_integrations_lookup on public.integrations (source_system, slug) where status = 'active';

comment on column public.integrations.secret_ref is
  'Nome do secret na Edge Function — NUNCA o valor do segredo (ADR-009).';

-- -----------------------------------------------------------------------------
-- integration_mappings — mapeamento de campos por integração (RF-INT-03)
-- -----------------------------------------------------------------------------
create table public.integration_mappings (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  integration_id uuid not null,
  -- Caminho no payload de origem, notação por ponto: 'data.FIELDS_AFTER.TITLE'
  source_path    text not null,
  -- Coluna alvo do ticket: 'title', 'description', 'priority_id', …
  target_field   text not null,
  transform      text not null default 'direct' check (transform in (
                   'direct','value_map','datetime','user_by_email','user_by_external_id',
                   'queue_by_external_id','constant','html_to_text')),
  -- Para 'value_map': {"2":"critical","1":"medium","0":"low"}
  value_map      jsonb not null default '{}'::jsonb,
  default_value  text,
  is_required    boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint fk_im_integration foreign key (integration_id, tenant_id)
    references public.integrations (id, tenant_id) on delete cascade,
  constraint uq_im_target unique (integration_id, target_field),
  constraint im_value_map_object check (jsonb_typeof(value_map) = 'object')
);

create index idx_mappings_integration on public.integration_mappings (integration_id);

-- -----------------------------------------------------------------------------
-- integration_events — idempotência e estado do processamento (RF-INT-06, ADR-010)
-- -----------------------------------------------------------------------------
create table public.integration_events (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  integration_id uuid not null,
  -- Chave de deduplicação. Para o Bitrix24: 'ONTASKUPDATE:12345:1466439714'.
  event_key      text not null,
  event_type     text,
  external_id    text,
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'pending'
                   check (status in ('pending','processed','failed','skipped_echo','ignored')),
  attempts       smallint not null default 0,
  last_error     text,
  ticket_id      uuid,
  received_at    timestamptz not null default now(),
  processed_at   timestamptz,
  constraint fk_ie_integration foreign key (integration_id, tenant_id)
    references public.integrations (id, tenant_id) on delete cascade,
  constraint fk_ie_ticket foreign key (ticket_id, tenant_id)
    references public.tickets (id, tenant_id) on delete set null,
  -- A GARANTIA de idempotência: reentrega do mesmo evento viola esta constraint,
  -- o receptor detecta e responde 200 sem reprocessar.
  constraint uq_integration_event unique (integration_id, event_key)
);

create index idx_events_pending on public.integration_events (integration_id, received_at)
  where status = 'pending';
create index idx_events_tenant on public.integration_events (tenant_id, received_at desc);
create index idx_events_external on public.integration_events (integration_id, external_id)
  where external_id is not null;

-- -----------------------------------------------------------------------------
-- integration_logs — trilha de toda requisição (RF-INT-04)
-- -----------------------------------------------------------------------------
create table public.integration_logs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  integration_id  uuid not null,
  event_id        uuid references public.integration_events(id) on delete set null,
  direction       text not null check (direction in ('inbound','outbound')),
  method          text,
  endpoint        text,
  request_payload jsonb,
  response_status integer,
  response_body   text,
  duration_ms     integer check (duration_ms is null or duration_ms >= 0),
  outcome         text not null default 'ok'
                    check (outcome in ('ok','error','retry','skipped_echo','duplicate')),
  error_message   text,
  created_at      timestamptz not null default now(),
  constraint fk_il_integration foreign key (integration_id, tenant_id)
    references public.integrations (id, tenant_id) on delete cascade
);

-- Índice em ordem decrescente: a UI sempre lê "as últimas N requisições".
create index idx_logs_integration on public.integration_logs (integration_id, created_at desc);
create index idx_logs_errors on public.integration_logs (tenant_id, created_at desc)
  where outcome in ('error','retry');

comment on table public.integration_logs is
  'Retenção prevista de 90 dias (lacuna L-05) — ver app.purge_integration_logs().';

-- -----------------------------------------------------------------------------
-- integration_sync_state — supressão de eco na sync reversa (ADR-008)
-- -----------------------------------------------------------------------------
create table public.integration_sync_state (
  integration_id     uuid not null,
  ticket_id          uuid not null,
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  external_id        text,
  -- Hash do último payload que NÓS enviamos. Se um webhook chegar com o mesmo
  -- conteúdo dentro da janela, é eco da nossa própria escrita — descartar.
  last_outbound_hash text,
  last_outbound_at   timestamptz,
  last_inbound_hash  text,
  last_inbound_at    timestamptz,
  primary key (integration_id, ticket_id),
  constraint fk_iss_integration foreign key (integration_id, tenant_id)
    references public.integrations (id, tenant_id) on delete cascade,
  constraint fk_iss_ticket foreign key (ticket_id, tenant_id)
    references public.tickets (id, tenant_id) on delete cascade
);

-- -----------------------------------------------------------------------------
-- Contadores e utilitários
-- -----------------------------------------------------------------------------
create or replace function app.integration_logs_after_insert()
returns trigger
language plpgsql
as $$
begin
  update public.integrations
     set request_count = request_count + 1,
         error_count   = error_count + case when new.outcome = 'error' then 1 else 0 end,
         last_sync_at  = greatest(coalesce(last_sync_at, new.created_at), new.created_at),
         updated_at    = now()
   where id = new.integration_id;
  return null;
end;
$$;

create trigger trg_integration_logs_counters
  after insert on public.integration_logs
  for each row execute function app.integration_logs_after_insert();

-- Purga de logs (lacuna L-05). Executada por cron da Edge Function.
create or replace function app.purge_integration_logs(p_retention_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from public.integration_logs
   where created_at < now() - make_interval(days => p_retention_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

select app.harden_table('public.integrations');
select app.harden_table('public.integration_mappings');
select app.harden_table('public.integration_events');
select app.harden_table('public.integration_logs');
select app.harden_table('public.integration_sync_state');
