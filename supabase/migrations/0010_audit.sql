-- =============================================================================
-- 0010 — Auditoria global (RF: Audit & Compliance)
-- =============================================================================
-- Complementa `ticket_history` (específico de tickets) cobrindo os cadastros:
-- clientes, filiais, usuários, filas, SLAs, inventário, fornecedores, integrações.
-- Gravado por TRIGGER (antipattern A-06): escrita via UI, API, job ou SQL direto
-- é auditada do mesmo jeito.
-- =============================================================================

create table public.audit_log (
  id          bigint generated always as identity primary key,
  tenant_id   uuid,
  actor_id    uuid,
  action      text not null check (action in ('insert','update','delete')),
  entity_type text not null,
  entity_id   text,
  -- Apenas os campos que mudaram: {"campo": {"old": …, "new": …}}
  changes     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index idx_audit_tenant on public.audit_log (tenant_id, created_at desc);
create index idx_audit_entity on public.audit_log (entity_type, entity_id, created_at desc);
create index idx_audit_actor on public.audit_log (actor_id, created_at desc) where actor_id is not null;

-- Campos sem valor informativo em auditoria — poluem o diff sem contar história.
create or replace function app.audit_ignored_columns()
returns text[]
language sql
immutable
as $$
  select array['updated_at','created_at','search_vector'];
$$;

create or replace function app.audit_row()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old     jsonb;
  v_new     jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_key     text;
  v_tenant  uuid;
  v_entity  text := tg_table_name;
  v_id      text;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_changes := jsonb_build_object('deleted', v_old);
    v_tenant := nullif(v_old ->> 'tenant_id', '')::uuid;
    v_id := v_old ->> 'id';

  elsif tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    v_changes := jsonb_build_object('created', v_new);
    v_tenant := nullif(v_new ->> 'tenant_id', '')::uuid;
    v_id := v_new ->> 'id';

  else
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_tenant := nullif(v_new ->> 'tenant_id', '')::uuid;
    v_id := v_new ->> 'id';

    for v_key in select jsonb_object_keys(v_new) loop
      if v_key = any (app.audit_ignored_columns()) then
        continue;
      end if;
      if v_new -> v_key is distinct from v_old -> v_key then
        v_changes := v_changes || jsonb_build_object(
          v_key, jsonb_build_object('old', v_old -> v_key, 'new', v_new -> v_key));
      end if;
    end loop;

    -- UPDATE que não alterou nada relevante não vira linha de auditoria.
    if v_changes = '{}'::jsonb then
      return null;
    end if;
  end if;

  insert into public.audit_log (tenant_id, actor_id, action, entity_type, entity_id, changes)
  values (v_tenant, app.current_user_id(), lower(tg_op), v_entity, v_id, v_changes);

  return null;
end;
$$;

-- Anexa a auditoria a uma tabela. Centralizado para não haver tabela de cadastro
-- que "esqueceu" de ser auditada.
create or replace function app.attach_audit(p_table regclass)
returns void
language plpgsql
as $$
declare
  v_short text := split_part(p_table::text, '.', 2);
begin
  if v_short = '' then
    v_short := p_table::text;
  end if;
  execute format(
    'create trigger trg_%s_audit after insert or update or delete on %s
       for each row execute function app.audit_row()',
    v_short, p_table::text);
end;
$$;

select app.attach_audit('public.clients');
select app.attach_audit('public.branches');
select app.attach_audit('public.profiles');
select app.attach_audit('public.user_branches');
select app.attach_audit('public.queues');
select app.attach_audit('public.queue_members');
select app.attach_audit('public.queue_rules');
select app.attach_audit('public.ticket_priorities');
select app.attach_audit('public.ticket_categories');
select app.attach_audit('public.sla_contracts');
select app.attach_audit('public.sla_definitions');
select app.attach_audit('public.business_hours');
select app.attach_audit('public.it_assets');
select app.attach_audit('public.telecom_lines');
select app.attach_audit('public.suppliers');
select app.attach_audit('public.supplier_contracts');
select app.attach_audit('public.integrations');
select app.attach_audit('public.integration_mappings');

select app.harden_table('public.audit_log');
