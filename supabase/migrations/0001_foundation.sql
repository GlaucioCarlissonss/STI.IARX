-- =============================================================================
-- 0001 — Fundação: extensões, schema `app`, helpers de contexto e utilitários
-- =============================================================================
-- Este arquivo define os primitivos de segurança usados por TODAS as policies de
-- RLS do sistema. Ver ADR-002 e ADR-003 em docs/03-arquitetura.md.
-- =============================================================================

create extension if not exists pgcrypto;

-- Schema para helpers internos. Mantido fora de `public` para que nenhuma função
-- de contexto seja exposta acidentalmente pela API REST gerada pelo PostgREST.
create schema if not exists app;

-- -----------------------------------------------------------------------------
-- Contexto da requisição
-- -----------------------------------------------------------------------------
-- Lemos os claims direto de `request.jwt.claims` em vez de `auth.jwt()`: o
-- comportamento é idêntico no Supabase e o schema fica testável em um Postgres
-- puro (basta `set local request.jwt.claims = '...'`).

create or replace function app.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

comment on function app.jwt() is
  'Claims do JWT da requisição corrente, ou {} quando não houver sessão.';

create or replace function app.current_user_id()
returns uuid
language sql
stable
as $$
  select nullif(app.jwt() ->> 'sub', '')::uuid;
$$;

-- ATENÇÃO DE SEGURANÇA (ADR-002): o tenant é lido de `app_metadata`, jamais de
-- `user_metadata`. `user_metadata` é gravável pelo próprio usuário autenticado
-- via supabase.auth.updateUser(), o que permitiria a ele trocar de tenant.
create or replace function app.current_tenant_id()
returns uuid
language sql
stable
as $$
  select nullif(app.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid;
$$;

comment on function app.current_tenant_id() is
  'Tenant da sessão, lido de app_metadata (nunca de user_metadata — ver ADR-002).';

-- `service_role` é usado pelas Edge Functions e pela rota de TV. Nesses casos não
-- há usuário; o isolamento é responsabilidade explícita do código chamador.
create or replace function app.is_service_role()
returns boolean
language sql
stable
as $$
  select coalesce(app.jwt() ->> 'role', '') = 'service_role';
$$;

-- -----------------------------------------------------------------------------
-- Utilitários genéricos
-- -----------------------------------------------------------------------------

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function app.touch_updated_at() is
  'Trigger BEFORE UPDATE: mantém updated_at sem depender da aplicação.';

-- Aplica RLS + trigger de updated_at + índice de tenant de forma uniforme.
-- Centralizar evita o erro mais caro do modelo: esquecer RLS em uma tabela nova.
create or replace function app.harden_table(p_table regclass)
returns void
language plpgsql
as $$
declare
  v_name text := p_table::text;
  v_short text := split_part(v_name, '.', greatest(array_length(string_to_array(v_name, '.'), 1), 1));
begin
  execute format('alter table %s enable row level security', v_name);
  -- FORCE garante que nem o dono da tabela escape das policies.
  execute format('alter table %s force row level security', v_name);

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = v_short and column_name = 'updated_at'
  ) then
    execute format(
      'create trigger trg_%s_touch before update on %s
         for each row execute function app.touch_updated_at()',
      v_short, v_name);
  end if;
end;
$$;
