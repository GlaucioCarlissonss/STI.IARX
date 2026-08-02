-- =============================================================================
-- 0011 — Dashboard: layouts, tokens de exibição e views de leitura
-- =============================================================================

-- -----------------------------------------------------------------------------
-- dashboard_layouts (RF-DSH-05)
-- -----------------------------------------------------------------------------
create table public.dashboard_layouts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,
  slug            text not null,
  -- Config do layout: quais tiles, ordem, fila em destaque, tema.
  config          jsonb not null default '{}'::jsonb,
  refresh_seconds smallint not null default 45 check (refresh_seconds between 10 and 600),
  is_default      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint uq_layout_slug unique (tenant_id, slug),
  constraint uq_layout_id_tenant unique (id, tenant_id),
  constraint layout_config_object check (jsonb_typeof(config) = 'object')
);

create unique index uq_layout_default on public.dashboard_layouts (tenant_id) where is_default;

-- -----------------------------------------------------------------------------
-- dashboard_tokens (ADR-006) — como uma TV faz login sem ter quem digite a senha
-- -----------------------------------------------------------------------------
create table public.dashboard_tokens (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  layout_id    uuid,
  name         text not null,                    -- "TV Recepção Matriz"
  -- SHA-256 do segredo. O valor em claro é mostrado uma única vez, na criação.
  token_hash   text not null unique,
  -- Escopo de filiais. Vazio = todas as filiais do tenant.
  branch_ids   uuid[] not null default '{}',
  expires_at   timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint fk_dt_layout foreign key (layout_id, tenant_id)
    references public.dashboard_layouts (id, tenant_id) on delete set null
);

create index idx_dashboard_tokens_tenant on public.dashboard_tokens (tenant_id)
  where revoked_at is null;

-- Resolve um token de exibição. SECURITY DEFINER porque roda sem sessão de
-- usuário (a TV não está autenticada) e precisa ler a tabela protegida por RLS.
-- VOLATILE: registra last_used_at, útil para detectar painel abandonado.
create or replace function app.resolve_dashboard_token(p_token text)
returns table (tenant_id uuid, layout_id uuid, branch_ids uuid[], refresh_seconds smallint)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text := encode(digest(p_token, 'sha256'), 'hex');
  v_row  public.dashboard_tokens;
begin
  select * into v_row
  from public.dashboard_tokens t
  where t.token_hash = v_hash
    and t.revoked_at is null
    and (t.expires_at is null or t.expires_at > now());

  if v_row.id is null then
    return;                       -- token inválido: retorna vazio, sem detalhar o motivo
  end if;

  update public.dashboard_tokens set last_used_at = now() where id = v_row.id;

  return query
    select v_row.tenant_id, v_row.layout_id, v_row.branch_ids,
           coalesce((select l.refresh_seconds from public.dashboard_layouts l
                      where l.id = v_row.layout_id), 45::smallint);
end;
$$;

-- Wrapper em `public` porque o PostgREST só expõe funções dos schemas
-- publicados — o schema `app` fica deliberadamente fora da API. O EXECUTE é
-- concedido apenas a service_role: nenhum usuário final resolve tokens de TV.
create or replace function public.resolve_dashboard_token(p_token text)
returns table (tenant_id uuid, layout_id uuid, branch_ids uuid[], refresh_seconds smallint)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select * from app.resolve_dashboard_token(p_token);
$$;

revoke all on function public.resolve_dashboard_token(text) from public, anon, authenticated;
grant execute on function public.resolve_dashboard_token(text) to service_role;

-- =============================================================================
-- Score de priorização de fila (RF-FIL-03)
-- =============================================================================
-- Os três termos são normalizados para 0..1 antes de receber peso. Sem isso, a
-- idade em segundos dominaria o score e a prioridade viraria decoração.
create or replace function app.queue_score(
  p_priority_weight smallint,
  p_started         timestamptz,
  p_due             timestamptz,
  p_breached        boolean,
  p_created         timestamptz,
  p_w_criticality   smallint,
  p_w_deadline      smallint,
  p_w_age           smallint
)
returns numeric
language sql
stable
as $$
  select
      (p_w_criticality * (coalesce(p_priority_weight, 0) / 100.0))
    + (p_w_deadline * case
         when p_breached then 1.0
         when p_due is null or p_started is null then 0.0
         else least(greatest(
              extract(epoch from (now() - p_started))
              / nullif(extract(epoch from (p_due - p_started)), 0), 0), 1)
       end)
    -- Idade normalizada em janela de 72h: garante que um ticket antigo de baixa
    -- prioridade suba na fila em vez de morrer de inanição (starvation).
    + (p_w_age * least(extract(epoch from (now() - p_created)) / (72 * 3600.0), 1));
$$;

-- =============================================================================
-- Views de leitura
-- =============================================================================
-- `security_invoker = true` é OBRIGATÓRIO: sem essa opção a view executaria com
-- os privilégios do dono e o RLS das tabelas base seria ignorado — o que
-- transformaria cada view em um vazamento entre tenants.

create view public.vw_tickets_enriched
with (security_invoker = true) as
select
  t.id,
  t.tenant_id,
  t.ticket_number,
  t.title,
  t.description,
  t.status,
  t.tags,
  t.source,
  t.source_system,
  t.external_id,
  t.external_url,
  t.created_at,
  t.updated_at,
  t.first_response_at,
  t.resolved_at,
  t.closed_at,
  t.reopened_count,

  t.priority_id,
  p.key   as priority_key,
  p.label as priority_label,
  p.color as priority_color,
  p.weight as priority_weight,

  t.queue_id,
  q.name as queue_name,
  q.slug as queue_slug,

  t.category_id,
  c.name as category_name,
  parent.name as category_parent_name,

  t.branch_id,
  b.name as branch_name,
  b.timezone as branch_timezone,
  t.client_id,
  cl.legal_name as client_name,

  t.assignee_id,
  ua.full_name as assignee_name,
  t.requester_id,
  ur.full_name as requester_name,
  t.supplier_id,
  s.name as supplier_name,

  st.response_due_at,
  st.resolution_due_at,
  st.responded_at,
  st.response_breached,
  st.resolution_breached,
  st.is_paused,
  st.paused_minutes,
  st.coverage as sla_coverage,

  app.sla_state(st.response_due_at, st.responded_at, st.response_breached,
                tn.sla_warning_pct, tn.sla_critical_pct, st.started_at) as response_state,
  app.sla_state(st.resolution_due_at, st.resolved_at, st.resolution_breached,
                tn.sla_warning_pct, tn.sla_critical_pct, st.started_at) as resolution_state,

  -- Minutos restantes de expediente até o vencimento (negativo = já estourou).
  case
    when st.resolution_due_at is null then null
    when st.resolution_due_at >= now() then
      app.fn_business_minutes_between(now(), st.resolution_due_at, st.business_hours_id)
    else
      -app.fn_business_minutes_between(st.resolution_due_at, now(), st.business_hours_id)
  end as minutes_to_resolution_due,

  app.queue_score(p.weight, st.started_at, st.resolution_due_at,
                  st.resolution_breached, t.created_at,
                  q.weight_criticality, q.weight_deadline, q.weight_age) as queue_score

from public.tickets t
join public.tenants tn            on tn.id = t.tenant_id
join public.ticket_priorities p   on p.id = t.priority_id
join public.queues q              on q.id = t.queue_id
left join public.ticket_categories c      on c.id = t.category_id
left join public.ticket_categories parent on parent.id = c.parent_id
left join public.branches b       on b.id = t.branch_id
left join public.clients cl       on cl.id = t.client_id
left join public.profiles ua      on ua.id = t.assignee_id
left join public.profiles ur      on ur.id = t.requester_id
left join public.suppliers s      on s.id = t.supplier_id
left join public.sla_tracking st  on st.ticket_id = t.id
where t.deleted_at is null;

comment on view public.vw_tickets_enriched is
  'Ticket + SLA + rótulos, já com semáforo e score de fila. security_invoker preserva RLS.';

-- -----------------------------------------------------------------------------
-- vw_dashboard_metrics — os contadores do painel em UMA passada (ADR-005)
-- -----------------------------------------------------------------------------
create view public.vw_dashboard_metrics
with (security_invoker = true) as
select
  t.tenant_id,
  count(*) filter (where t.status not in ('resolved','closed'))                     as open_total,
  count(*) filter (where t.status = 'open')                                          as open_new,
  count(*) filter (where t.status in ('assigned','in_progress'))                     as in_progress_total,
  count(*) filter (where t.status in ('waiting_requester','waiting_third_party'))    as waiting_total,
  count(*) filter (where t.status not in ('resolved','closed') and p.weight >= 80)   as critical_total,
  count(*) filter (where t.status not in ('resolved','closed')
                     and st.resolution_due_at is not null
                     and not st.resolution_breached
                     and now() >= st.started_at
                       + (st.resolution_due_at - st.started_at) * (tn.sla_warning_pct / 100.0))
                                                                                     as sla_at_risk,
  count(*) filter (where t.status not in ('resolved','closed')
                     and (st.resolution_breached
                          or (st.resolution_due_at is not null and now() > st.resolution_due_at)))
                                                                                     as sla_breached,
  count(*) filter (where t.resolved_at >= date_trunc('day', now()))                  as resolved_today,
  count(*) filter (where t.created_at >= date_trunc('day', now()))                   as created_today,
  -- TMR das últimas 24h, em minutos corridos.
  round(avg(extract(epoch from (t.resolved_at - t.created_at)) / 60.0)
        filter (where t.resolved_at >= now() - interval '24 hours'))::integer        as avg_resolution_minutes_24h
from public.tickets t
join public.tenants tn          on tn.id = t.tenant_id
join public.ticket_priorities p on p.id = t.priority_id
left join public.sla_tracking st on st.ticket_id = t.id
where t.deleted_at is null
group by t.tenant_id;

comment on view public.vw_dashboard_metrics is
  'Contadores do painel de TV. Um único scan sobre os índices parciais de tickets.';

-- Atendentes online (RF-DSH-02): "online" = visto nos últimos 5 minutos.
create view public.vw_agents_online
with (security_invoker = true) as
select
  p.tenant_id,
  count(*) filter (where p.last_seen_at >= now() - interval '5 minutes') as agents_online,
  count(*)                                                               as agents_total
from public.profiles p
where p.is_active and p.role in ('atendente','gestor','admin')
group by p.tenant_id;

-- Relatório de compliance de SLA (RF-SLA-06).
create view public.vw_sla_compliance
with (security_invoker = true) as
select
  t.tenant_id,
  date_trunc('month', t.created_at)                as period,
  t.queue_id,
  q.name                                           as queue_name,
  t.assignee_id,
  t.client_id,
  count(*)                                         as tickets_total,
  count(*) filter (where st.coverage = 'covered')  as tickets_with_sla,
  count(*) filter (where st.response_breached)     as response_breaches,
  count(*) filter (where st.resolution_breached)   as resolution_breaches,
  round(100.0 * count(*) filter (
          where st.coverage = 'covered' and not st.resolution_breached)
        / nullif(count(*) filter (where st.coverage = 'covered'), 0), 2) as resolution_compliance_pct,
  round(100.0 * count(*) filter (
          where st.coverage = 'covered' and not st.response_breached)
        / nullif(count(*) filter (where st.coverage = 'covered'), 0), 2) as response_compliance_pct
from public.tickets t
join public.queues q             on q.id = t.queue_id
left join public.sla_tracking st on st.ticket_id = t.id
where t.deleted_at is null
group by t.tenant_id, date_trunc('month', t.created_at), t.queue_id, q.name, t.assignee_id, t.client_id;

-- Custos de telecom por filial/operadora (RF-TEL-02).
create view public.vw_telecom_costs
with (security_invoker = true) as
select
  l.tenant_id,
  l.branch_id,
  b.name as branch_name,
  l.carrier,
  l.status,
  count(*)                       as lines_count,
  sum(coalesce(l.monthly_cost,0)) as monthly_total
from public.telecom_lines l
left join public.branches b on b.id = l.branch_id
where l.deleted_at is null
group by l.tenant_id, l.branch_id, b.name, l.carrier, l.status;

select app.harden_table('public.dashboard_layouts');
select app.harden_table('public.dashboard_tokens');

-- Realtime do dashboard (RNF-08). REPLICA IDENTITY FULL entrega o registro
-- completo no evento, permitindo ao cliente decidir se o ticket é do seu escopo.
alter table public.tickets replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.tickets;
  end if;
end
$$;
