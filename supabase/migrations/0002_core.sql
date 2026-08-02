-- =============================================================================
-- 0002 — Núcleo: tenants, perfis, clientes, filiais e visibilidade
-- =============================================================================

-- -----------------------------------------------------------------------------
-- tenants — assinantes da plataforma. Fronteira de isolamento (ADR-001).
-- -----------------------------------------------------------------------------
create table public.tenants (
  id                    uuid primary key default gen_random_uuid(),
  name                  text        not null,
  slug                  text        not null unique,
  cnpj                  text,
  status                text        not null default 'active'
                          check (status in ('active', 'suspended', 'cancelled')),
  -- Preferências operacionais do tenant (lacunas L-01, L-04 em docs/01-requisitos.md)
  auto_close_after_days integer     not null default 3 check (auto_close_after_days between 0 and 365),
  sla_warning_pct       smallint    not null default 75 check (sla_warning_pct between 1 and 99),
  sla_critical_pct      smallint    not null default 90 check (sla_critical_pct between 1 and 99),
  default_locale        text        not null default 'pt-BR',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  constraint tenants_warning_before_critical check (sla_warning_pct < sla_critical_pct)
);

comment on table public.tenants is 'Assinantes do SaaS. Cada linha é uma fronteira de isolamento de dados.';

-- -----------------------------------------------------------------------------
-- profiles — extensão de auth.users com papel e tenant
-- -----------------------------------------------------------------------------
-- `super_admin` opera a plataforma e não pertence a nenhum tenant (tenant_id NULL).
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  tenant_id     uuid references public.tenants(id) on delete cascade,
  role          text        not null default 'solicitante'
                  check (role in ('super_admin','admin','gestor','atendente','solicitante','visualizador')),
  full_name     text        not null,
  email         text        not null,
  phone         text,
  avatar_url    text,
  is_active     boolean     not null default true,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint profiles_tenant_required_for_non_super
    check (role = 'super_admin' or tenant_id is not null)
);

create index idx_profiles_tenant on public.profiles (tenant_id) where tenant_id is not null;
create unique index uq_profiles_tenant_email on public.profiles (tenant_id, lower(email)) where tenant_id is not null;
-- Suporta o contador "atendentes online" do dashboard (RF-DSH-02).
create index idx_profiles_presence on public.profiles (tenant_id, last_seen_at desc)
  where is_active and role in ('atendente','gestor','admin');

-- Chave composta: permite que outras tabelas referenciem (id, tenant_id) e o banco
-- garanta que o vínculo não atravessa tenants (ADR-001).
alter table public.profiles add constraint uq_profiles_id_tenant unique (id, tenant_id);

-- -----------------------------------------------------------------------------
-- clients — grupos econômicos atendidos por um tenant
-- -----------------------------------------------------------------------------
create table public.clients (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  legal_name   text not null,
  trade_name   text,
  cnpj         text,
  contract_ref text,
  status       text not null default 'active' check (status in ('active','inactive','prospect')),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  constraint uq_clients_id_tenant unique (id, tenant_id)
);

create index idx_clients_tenant on public.clients (tenant_id) where deleted_at is null;
create unique index uq_clients_tenant_cnpj on public.clients (tenant_id, cnpj)
  where cnpj is not null and deleted_at is null;

-- -----------------------------------------------------------------------------
-- branches — filiais. Fronteira de visibilidade dos atendentes (ADR-003).
-- -----------------------------------------------------------------------------
create table public.branches (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  client_id     uuid not null,
  name          text not null,
  code          text,
  cnpj          text,
  address_line  text,
  district      text,
  city          text,
  state         char(2),
  postal_code   text,
  -- Timezone da filial: base de todo cálculo de horário útil de SLA (ADR-004).
  timezone      text not null default 'America/Sao_Paulo',
  contact_name  text,
  contact_email text,
  contact_phone text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  -- FK composta impede vincular uma filial a um cliente de outro tenant.
  constraint fk_branches_client foreign key (client_id, tenant_id)
    references public.clients (id, tenant_id) on delete cascade,
  constraint uq_branches_id_tenant unique (id, tenant_id)
);

-- Timezone é validado por trigger, não por CHECK: o Postgres exige funções
-- IMMUTABLE em CHECK, e a lista de timezones (pg_timezone_names) é um catálogo.
create or replace function app.validate_timezone()
returns trigger
language plpgsql
as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Timezone inválido: %', new.timezone
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger trg_branches_validate_tz
  before insert or update of timezone on public.branches
  for each row execute function app.validate_timezone();

create index idx_branches_tenant on public.branches (tenant_id) where deleted_at is null;
create index idx_branches_client on public.branches (client_id) where deleted_at is null;
create unique index uq_branches_client_code on public.branches (client_id, upper(code))
  where code is not null and deleted_at is null;

-- -----------------------------------------------------------------------------
-- user_branches — visibilidade N:N (RF-USR-02)
-- -----------------------------------------------------------------------------
create table public.user_branches (
  user_id    uuid not null,
  branch_id  uuid not null,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, branch_id),
  constraint fk_user_branches_user foreign key (user_id, tenant_id)
    references public.profiles (id, tenant_id) on delete cascade,
  constraint fk_user_branches_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete cascade
);

create index idx_user_branches_branch on public.user_branches (branch_id);
create unique index uq_user_branches_primary on public.user_branches (user_id) where is_primary;

-- =============================================================================
-- Helpers de autorização
-- =============================================================================
-- SECURITY DEFINER é OBRIGATÓRIO aqui: estas funções são chamadas de dentro das
-- policies de `tickets`, `it_assets` etc. e precisam ler `profiles`/`user_branches`
-- sem disparar as policies dessas tabelas — o que causaria recursão infinita.
-- `search_path` fixo evita sequestro de resolução de nomes por schema do usuário.

create or replace function app.current_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.role from public.profiles p where p.id = app.current_user_id();
$$;

create or replace function app.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(app.current_role() = 'super_admin', false);
$$;

-- admin e gestor enxergam todas as filiais do tenant (RF-USR-03).
create or replace function app.has_tenant_wide_access()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(app.current_role() in ('super_admin','admin','gestor'), false);
$$;

-- Retorna uuid[] em vez de SETOF: permite `branch_id = ANY(...)` na policy, que o
-- planner resolve com índice. `EXISTS (SELECT ...)` por linha degradava a fila.
create or replace function app.current_user_branch_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(ub.branch_id), '{}'::uuid[])
  from public.user_branches ub
  where ub.user_id = app.current_user_id();
$$;

comment on function app.current_user_branch_ids() is
  'Filiais visíveis ao usuário corrente. SECURITY DEFINER para evitar recursão de RLS.';

-- Predicado padrão de visibilidade por filial, reutilizado por tickets e ativos.
create or replace function app.can_see_branch(p_branch_id uuid)
returns boolean
language sql
stable
as $$
  select app.has_tenant_wide_access()
      or (p_branch_id is not null and p_branch_id = any (app.current_user_branch_ids()));
$$;

select app.harden_table('public.tenants');
select app.harden_table('public.profiles');
select app.harden_table('public.clients');
select app.harden_table('public.branches');
select app.harden_table('public.user_branches');
