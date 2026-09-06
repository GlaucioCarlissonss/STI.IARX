-- =============================================================================
-- STI.IARX — instalação completa do banco, em um arquivo
-- =============================================================================
-- COMO USAR
--   1. No Supabase, menu lateral -> SQL Editor -> New query
--   2. Cole este arquivo INTEIRO
--   3. Clique em Run
--
-- ARQUIVO GERADO por scripts/gerar-instalador.py. Não edite aqui: edite
-- supabase/migrations/*.sql e gere de novo, senão o banco passa a divergir do
-- repositório e ninguém sabe qual dos dois é a verdade.
--
-- TUDO OU NADA: roda numa única transação. Se qualquer linha falhar, NADA é
-- aplicado e o banco fica como estava. É de propósito — schema aplicado pela
-- metade é pior que schema nenhum, porque a segunda tentativa esbarra no que a
-- primeira deixou pronto.
--
-- O QUE ELE CRIA
--   58 tabelas e 18 views em `public`, além das policies de RLS, das
--   funções em `app`, dos 9 perfis de acesso do sistema, do bucket privado
--   `anexos` e dos dados de exemplo.
--
-- O QUE ASSUME QUE JÁ EXISTE (o Supabase provê de fábrica)
--   auth.users, auth.jwt(), storage.buckets, storage.objects,
--   storage.foldername() e os papéis anon / authenticated / service_role.
--   `scripts/supabase-shim.sql` NÃO entra aqui: ele existe só para rodar as
--   migrações num PostgreSQL puro, sem Supabase.
--
-- SE DER ERRO
--   Copie a mensagem INTEIRA. Ela diz qual linha reclamou, e é com ela que se
--   conserta — adivinhar não funciona.
-- =============================================================================

begin;


-- =============================================================================
-- ARQUIVO 1 de 23: 0001_foundation.sql
-- =============================================================================

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


-- =============================================================================
-- ARQUIVO 2 de 23: 0002_core.sql
-- =============================================================================

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


-- =============================================================================
-- ARQUIVO 3 de 23: 0003_business_hours.sql
-- =============================================================================

-- =============================================================================
-- 0003 — Calendários de atendimento e aritmética de horário útil (ADR-004)
-- =============================================================================
-- "4 horas de resolução em horário comercial" não é soma de timestamps: precisa
-- pular fora-de-expediente, feriados regionais e respeitar o timezone da filial.
-- Toda essa aritmética vive aqui, no banco, para ter UMA implementação usada por
-- triggers, views, dashboard, relatórios e integrações.
-- =============================================================================

create table public.business_hours (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  timezone   text not null default 'America/Sao_Paulo',
  is_24x7    boolean not null default false,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_business_hours_id_tenant unique (id, tenant_id)
);

create unique index uq_business_hours_default on public.business_hours (tenant_id) where is_default;
create index idx_business_hours_tenant on public.business_hours (tenant_id);

create trigger trg_business_hours_validate_tz
  before insert or update of timezone on public.business_hours
  for each row execute function app.validate_timezone();

-- Janelas de expediente. Um mesmo dia pode ter várias (ex.: 08–12 e 13–18).
create table public.business_hours_intervals (
  id                uuid primary key default gen_random_uuid(),
  business_hours_id uuid not null references public.business_hours(id) on delete cascade,
  weekday           smallint not null check (weekday between 0 and 6), -- 0 = domingo (extract(dow))
  starts_at         time not null,
  ends_at           time not null,
  constraint bhi_valid_range check (ends_at > starts_at),
  constraint uq_bhi_slot unique (business_hours_id, weekday, starts_at)
);

create index idx_bhi_lookup on public.business_hours_intervals (business_hours_id, weekday, starts_at);

create table public.business_hours_holidays (
  id                uuid primary key default gen_random_uuid(),
  business_hours_id uuid not null references public.business_hours(id) on delete cascade,
  holiday_date      date not null,
  name              text not null,
  constraint uq_holiday unique (business_hours_id, holiday_date)
);

-- Filial referencia seu calendário (RF-CLI-02).
alter table public.branches
  add column business_hours_id uuid,
  add constraint fk_branches_business_hours
    foreign key (business_hours_id, tenant_id)
    references public.business_hours (id, tenant_id) on delete set null;

-- -----------------------------------------------------------------------------
-- fn_business_minutes_between — minutos úteis decorridos entre dois instantes
-- -----------------------------------------------------------------------------
create or replace function app.fn_business_minutes_between(
  p_from timestamptz,
  p_to   timestamptz,
  p_business_hours_id uuid
)
returns numeric
language plpgsql
stable
as $$
declare
  v_tz      text;
  v_24x7    boolean;
  v_total   numeric := 0;
  v_day     date;
  v_last    date;
  v_guard   integer := 0;
  r         record;
  v_win_start timestamptz;
  v_win_end   timestamptz;
  v_ov_start  timestamptz;
  v_ov_end    timestamptz;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    return 0;
  end if;

  -- Sem calendário configurado, o comportamento é 24x7 (corrido).
  if p_business_hours_id is null then
    return extract(epoch from (p_to - p_from)) / 60.0;
  end if;

  select timezone, is_24x7 into v_tz, v_24x7
  from public.business_hours where id = p_business_hours_id;

  if v_tz is null or v_24x7 then
    return extract(epoch from (p_to - p_from)) / 60.0;
  end if;

  v_day  := (p_from at time zone v_tz)::date;
  v_last := (p_to   at time zone v_tz)::date;

  while v_day <= v_last loop
    v_guard := v_guard + 1;
    if v_guard > 3660 then           -- ~10 anos: intervalo absurdo, aborta em vez de travar
      raise exception 'fn_business_minutes_between: intervalo excede o limite suportado';
    end if;

    if not exists (
      select 1 from public.business_hours_holidays h
      where h.business_hours_id = p_business_hours_id and h.holiday_date = v_day
    ) then
      for r in
        select starts_at, ends_at
        from public.business_hours_intervals
        where business_hours_id = p_business_hours_id
          and weekday = extract(dow from v_day)::smallint
        order by starts_at
      loop
        -- Converte a janela local do dia para instantes absolutos no tz do calendário.
        v_win_start := (v_day + r.starts_at) at time zone v_tz;
        v_win_end   := (v_day + r.ends_at)   at time zone v_tz;

        v_ov_start := greatest(v_win_start, p_from);
        v_ov_end   := least(v_win_end, p_to);

        if v_ov_end > v_ov_start then
          v_total := v_total + extract(epoch from (v_ov_end - v_ov_start)) / 60.0;
        end if;
      end loop;
    end if;

    v_day := v_day + 1;
  end loop;

  return v_total;
end;
$$;

comment on function app.fn_business_minutes_between(timestamptz, timestamptz, uuid) is
  'Minutos de expediente entre dois instantes, descontando feriados e fora-de-horário.';

-- -----------------------------------------------------------------------------
-- fn_add_business_minutes — prazo final a partir de um início + minutos úteis
-- -----------------------------------------------------------------------------
create or replace function app.fn_add_business_minutes(
  p_start   timestamptz,
  p_minutes numeric,
  p_business_hours_id uuid
)
returns timestamptz
language plpgsql
stable
as $$
declare
  v_tz        text;
  v_24x7      boolean;
  v_remaining numeric;
  v_day       date;
  v_guard     integer := 0;
  r           record;
  v_win_start timestamptz;
  v_win_end   timestamptz;
  v_cursor    timestamptz;
  v_available numeric;
begin
  if p_start is null or p_minutes is null then
    return null;
  end if;

  if p_business_hours_id is null then
    return p_start + make_interval(mins => p_minutes::int);
  end if;

  select timezone, is_24x7 into v_tz, v_24x7
  from public.business_hours where id = p_business_hours_id;

  if v_tz is null or v_24x7 then
    return p_start + make_interval(mins => p_minutes::int);
  end if;

  v_remaining := greatest(p_minutes, 0);
  v_day := (p_start at time zone v_tz)::date;

  loop
    v_guard := v_guard + 1;
    if v_guard > 3660 then
      raise exception 'fn_add_business_minutes: prazo não alcançado — calendário sem expediente?';
    end if;

    if not exists (
      select 1 from public.business_hours_holidays h
      where h.business_hours_id = p_business_hours_id and h.holiday_date = v_day
    ) then
      for r in
        select starts_at, ends_at
        from public.business_hours_intervals
        where business_hours_id = p_business_hours_id
          and weekday = extract(dow from v_day)::smallint
        order by starts_at
      loop
        v_win_start := (v_day + r.starts_at) at time zone v_tz;
        v_win_end   := (v_day + r.ends_at)   at time zone v_tz;

        -- Antes do expediente, o relógio só começa a contar na abertura.
        v_cursor := greatest(v_win_start, p_start);

        if v_cursor < v_win_end then
          -- Prazo zero: vence na primeira abertura de expediente.
          if v_remaining <= 0 then
            return v_cursor;
          end if;

          v_available := extract(epoch from (v_win_end - v_cursor)) / 60.0;

          if v_remaining <= v_available then
            return v_cursor + make_interval(secs => (v_remaining * 60)::double precision);
          end if;

          v_remaining := v_remaining - v_available;
        end if;
      end loop;
    end if;

    v_day := v_day + 1;
  end loop;
end;
$$;

comment on function app.fn_add_business_minutes(timestamptz, numeric, uuid) is
  'Instante em que se completam N minutos de expediente a partir de p_start.';

select app.harden_table('public.business_hours');
select app.harden_table('public.business_hours_intervals');
select app.harden_table('public.business_hours_holidays');


-- =============================================================================
-- ARQUIVO 4 de 23: 0004_taxonomy_queues.sql
-- =============================================================================

-- =============================================================================
-- 0004 — Taxonomia (categorias, prioridades) e filas
-- =============================================================================

-- -----------------------------------------------------------------------------
-- ticket_priorities — tabela, não enum (antipattern A-10)
-- -----------------------------------------------------------------------------
-- O cliente customiza rótulo, cor e sobretudo o PESO usado no score de fila.
-- Como enum, cada "queremos uma prioridade Emergencial" viraria migração.
create table public.ticket_priorities (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  key        text not null check (key ~ '^[a-z_]+$'),
  label      text not null,
  weight     smallint not null check (weight between 0 and 100),
  color      text not null default '#64748b',
  sort_order smallint not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_priority_key unique (tenant_id, key),
  constraint uq_priority_id_tenant unique (id, tenant_id)
);

create index idx_priorities_tenant on public.ticket_priorities (tenant_id, sort_order);

-- -----------------------------------------------------------------------------
-- ticket_categories — auto-relacionamento: categoria e subcategoria
-- -----------------------------------------------------------------------------
create table public.ticket_categories (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  parent_id  uuid,
  name       text not null,
  description text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_category_parent foreign key (parent_id, tenant_id)
    references public.ticket_categories (id, tenant_id) on delete cascade,
  constraint uq_category_id_tenant unique (id, tenant_id)
);

create unique index uq_category_name on public.ticket_categories (tenant_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create index idx_categories_parent on public.ticket_categories (parent_id);

-- Profundidade máxima 2 (categoria → subcategoria). Sem isso, a UI de seleção e os
-- relatórios teriam de lidar com árvore arbitrária, o que o escopo não pede.
create or replace function app.enforce_category_depth()
returns trigger
language plpgsql
as $$
declare
  v_grandparent uuid;
begin
  if new.parent_id is not null then
    select parent_id into v_grandparent from public.ticket_categories where id = new.parent_id;
    if v_grandparent is not null then
      raise exception 'Categorias suportam no máximo 2 níveis (categoria → subcategoria)'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_category_depth
  before insert or update of parent_id on public.ticket_categories
  for each row execute function app.enforce_category_depth();

-- -----------------------------------------------------------------------------
-- queues — filas (RF-FIL-01..05)
-- -----------------------------------------------------------------------------
create table public.queues (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  slug        text not null,
  description text,
  -- Fila padrão do sistema: destino de tickets sem roteamento definido.
  is_system_default boolean not null default false,
  is_active   boolean not null default true,
  -- Pesos do score de priorização (RF-FIL-03). Configuráveis por fila.
  weight_criticality smallint not null default 60 check (weight_criticality between 0 and 100),
  weight_deadline    smallint not null default 30 check (weight_deadline between 0 and 100),
  weight_age         smallint not null default 10 check (weight_age between 0 and 100),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  constraint uq_queue_slug unique (tenant_id, slug),
  constraint uq_queue_id_tenant unique (id, tenant_id)
);

create unique index uq_queue_single_default on public.queues (tenant_id) where is_system_default;
create index idx_queues_tenant on public.queues (tenant_id) where deleted_at is null;

-- RF-FIL-01: a fila padrão não pode ser removida, renomeada nem desativada.
-- Aplicado no banco para que nenhuma rota administrativa consiga burlar.
create or replace function app.protect_default_queue()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_system_default then
      raise exception 'A fila padrão do sistema não pode ser removida'
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if old.is_system_default then
    if new.name is distinct from old.name then
      raise exception 'A fila padrão do sistema não pode ser renomeada'
        using errcode = 'restrict_violation';
    end if;
    if new.slug is distinct from old.slug then
      raise exception 'O identificador da fila padrão não pode ser alterado'
        using errcode = 'restrict_violation';
    end if;
    if not new.is_active or new.deleted_at is not null then
      raise exception 'A fila padrão do sistema não pode ser desativada'
        using errcode = 'restrict_violation';
    end if;
    if not new.is_system_default then
      raise exception 'A fila padrão não pode deixar de ser padrão'
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_protect_default_queue
  before update or delete on public.queues
  for each row execute function app.protect_default_queue();

create table public.queue_members (
  queue_id   uuid not null,
  user_id    uuid not null,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  is_lead    boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (queue_id, user_id),
  constraint fk_qm_queue foreign key (queue_id, tenant_id)
    references public.queues (id, tenant_id) on delete cascade,
  constraint fk_qm_user foreign key (user_id, tenant_id)
    references public.profiles (id, tenant_id) on delete cascade
);

create index idx_queue_members_user on public.queue_members (user_id);

-- -----------------------------------------------------------------------------
-- queue_rules — roteamento automático (RF-FIL-02)
-- -----------------------------------------------------------------------------
-- Condições em JSONB: o conjunto de campos roteáveis evolui (categoria, prioridade,
-- filial, cliente, origem, tags). Colunas fixas exigiriam migração a cada campo novo.
-- A avaliação é feita por fn_route_ticket, com semântica AND entre as chaves.
create table public.queue_rules (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  queue_id    uuid not null,
  name        text not null,
  -- Ex.: {"category_id":"…","priority_key":"critical","branch_id":"…","source_system":"bitrix24"}
  conditions  jsonb not null default '{}'::jsonb,
  sort_order  smallint not null default 100,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint fk_qr_queue foreign key (queue_id, tenant_id)
    references public.queues (id, tenant_id) on delete cascade,
  constraint queue_rules_conditions_object check (jsonb_typeof(conditions) = 'object')
);

create index idx_queue_rules_eval on public.queue_rules (tenant_id, sort_order) where is_active;

select app.harden_table('public.ticket_priorities');
select app.harden_table('public.ticket_categories');
select app.harden_table('public.queues');
select app.harden_table('public.queue_members');
select app.harden_table('public.queue_rules');


-- =============================================================================
-- ARQUIVO 5 de 23: 0005_tickets.sql
-- =============================================================================

-- =============================================================================
-- 0005 — Tickets: máquina de estados, numeração, comentários, anexos, histórico
-- =============================================================================

-- Contador de numeração legível por tenant (RF-TCK-10). Fica em `tenants` para
-- que o incremento seja um UPDATE de uma linha só — serialização natural por
-- tenant, sem lacunas, e sem tabela extra de contadores.
alter table public.tenants add column ticket_seq bigint not null default 0;

-- -----------------------------------------------------------------------------
-- ticket_status_transitions — a máquina de estados é DADO, não código (ADR-007)
-- -----------------------------------------------------------------------------
-- Tabela global (regra do produto, não do tenant). Alterar o fluxo é inserir
-- linha, não fazer deploy.
create table public.ticket_status_transitions (
  from_status text not null,
  to_status   text not null,
  description text,
  primary key (from_status, to_status)
);

insert into public.ticket_status_transitions (from_status, to_status, description) values
  ('open',                'triage',              'Início da triagem'),
  ('open',                'assigned',            'Atribuição direta'),
  ('open',                'closed',              'Cancelamento antes da triagem'),
  ('triage',              'assigned',            'Atribuição após triagem'),
  ('triage',              'open',                'Devolvido para a fila'),
  ('triage',              'closed',              'Descartado na triagem'),
  ('assigned',            'in_progress',         'Atendimento iniciado'),
  ('assigned',            'open',                'Devolvido para a fila'),
  ('assigned',            'waiting_requester',   'Aguardando o solicitante'),
  ('assigned',            'waiting_third_party', 'Aguardando terceiro'),
  ('in_progress',         'waiting_requester',   'Aguardando o solicitante'),
  ('in_progress',         'waiting_third_party', 'Aguardando terceiro'),
  ('in_progress',         'resolved',            'Resolvido'),
  ('in_progress',         'assigned',            'Reatribuído'),
  ('in_progress',         'open',                'Devolvido para a fila'),
  ('waiting_requester',   'in_progress',         'Retorno do solicitante'),
  ('waiting_requester',   'resolved',            'Resolvido durante a espera'),
  ('waiting_requester',   'closed',              'Fechado por falta de retorno'),
  ('waiting_third_party', 'in_progress',         'Retorno do terceiro'),
  ('waiting_third_party', 'resolved',            'Resolvido durante a espera'),
  ('resolved',            'closed',              'Confirmado / fechamento automático'),
  ('resolved',            'in_progress',         'Reaberto'),
  ('closed',              'in_progress',         'Reaberto após fechamento');

-- Estados que param o relógio de SLA (RF-SLA-05).
create or replace function app.status_pauses_sla(p_status text)
returns boolean
language sql
immutable
as $$
  select p_status in ('waiting_requester', 'waiting_third_party');
$$;

-- Estados considerados "em aberto" para dashboard e filas.
create or replace function app.status_is_open(p_status text)
returns boolean
language sql
immutable
as $$
  select p_status not in ('resolved', 'closed');
$$;

-- -----------------------------------------------------------------------------
-- tickets
-- -----------------------------------------------------------------------------
create table public.tickets (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  ticket_number  bigint not null,

  title          text not null check (length(btrim(title)) > 0),
  description    text,

  status         text not null default 'open'
                   check (status in ('open','triage','assigned','in_progress',
                                     'waiting_requester','waiting_third_party',
                                     'resolved','closed')),
  priority_id    uuid not null,
  category_id    uuid,
  queue_id       uuid not null,

  client_id      uuid,
  branch_id      uuid,
  requester_id   uuid,
  assignee_id    uuid,
  supplier_id    uuid,     -- FK adicionada em 0008 (suppliers ainda não existe)

  tags           text[] not null default '{}',

  -- Rastreabilidade de origem (RF-INT-10)
  source         text not null default 'ui' check (source in ('ui','api','integration','email')),
  source_system  text,
  external_id    text,
  external_url   text,
  -- Origem da última mudança: base da supressão de eco na sync reversa (ADR-008)
  change_source  text not null default 'ui' check (change_source in ('ui','api','integration','system')),

  first_response_at timestamptz,
  resolved_at       timestamptz,
  closed_at         timestamptz,
  reopened_count    integer not null default 0,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,

  constraint fk_tickets_priority foreign key (priority_id, tenant_id)
    references public.ticket_priorities (id, tenant_id),
  constraint fk_tickets_category foreign key (category_id, tenant_id)
    references public.ticket_categories (id, tenant_id) on delete set null,
  constraint fk_tickets_queue foreign key (queue_id, tenant_id)
    references public.queues (id, tenant_id),
  constraint fk_tickets_client foreign key (client_id, tenant_id)
    references public.clients (id, tenant_id) on delete set null,
  constraint fk_tickets_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete set null,
  constraint fk_tickets_requester foreign key (requester_id, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,
  constraint fk_tickets_assignee foreign key (assignee_id, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,
  constraint uq_ticket_number unique (tenant_id, ticket_number),
  constraint uq_ticket_id_tenant unique (id, tenant_id),
  -- Origem externa exige o par completo, senão a rastreabilidade fica pela metade.
  constraint tickets_external_pair check (
    (external_id is null and source_system is null)
    or (external_id is not null and source_system is not null)
  )
);

-- Idempotência de integração (RF-INT-06): o mesmo objeto externo nunca vira 2 tickets.
create unique index uq_ticket_external
  on public.tickets (tenant_id, source_system, external_id)
  where external_id is not null and deleted_at is null;

-- Índices desenhados para as três consultas quentes do produto.
-- 1) Visão de fila: filtra fila + aberto, ordena por prioridade/idade.
create index idx_tickets_queue_open on public.tickets (tenant_id, queue_id, created_at)
  where deleted_at is null and status not in ('resolved','closed');
-- 2) Escopo por filial (RLS de atendente).
create index idx_tickets_branch_open on public.tickets (tenant_id, branch_id, status)
  where deleted_at is null and status not in ('resolved','closed');
-- 3) "Meus tickets".
create index idx_tickets_assignee on public.tickets (tenant_id, assignee_id, status)
  where deleted_at is null and status not in ('resolved','closed');
create index idx_tickets_requester on public.tickets (tenant_id, requester_id, created_at desc)
  where deleted_at is null;
-- Índice parcial que sustenta os contadores do dashboard sem varrer a tabela (ADR-005).
create index idx_tickets_dashboard on public.tickets (tenant_id, status, priority_id)
  where deleted_at is null and status not in ('resolved','closed');
create index idx_tickets_tags on public.tickets using gin (tags);

-- -----------------------------------------------------------------------------
-- Numeração e roteamento na criação
-- -----------------------------------------------------------------------------
create or replace function app.tickets_before_insert()
returns trigger
language plpgsql
as $$
declare
  v_next bigint;
begin
  if new.ticket_number is null or new.ticket_number = 0 then
    update public.tenants
       set ticket_seq = ticket_seq + 1
     where id = new.tenant_id
    returning ticket_seq into v_next;

    if v_next is null then
      raise exception 'Tenant % inexistente', new.tenant_id using errcode = 'foreign_key_violation';
    end if;
    new.ticket_number := v_next;
  end if;

  -- Sem fila informada, cai na fila padrão do sistema (RF-FIL-01).
  if new.queue_id is null then
    select id into new.queue_id
    from public.queues
    where tenant_id = new.tenant_id and is_system_default
    limit 1;

    if new.queue_id is null then
      raise exception 'Tenant % não possui fila padrão configurada', new.tenant_id
        using errcode = 'not_null_violation';
    end if;
  end if;

  -- Filial não informada: deriva do solicitante quando ele tem filial primária.
  if new.branch_id is null and new.requester_id is not null then
    select ub.branch_id into new.branch_id
    from public.user_branches ub
    where ub.user_id = new.requester_id and ub.is_primary
    limit 1;
  end if;

  -- Cliente é derivado da filial — evita divergência entre os dois campos.
  if new.branch_id is not null then
    select b.client_id into new.client_id from public.branches b where b.id = new.branch_id;
  end if;

  return new;
end;
$$;

create trigger trg_tickets_before_insert
  before insert on public.tickets
  for each row execute function app.tickets_before_insert();

-- -----------------------------------------------------------------------------
-- Máquina de estados + carimbos de ciclo de vida (ADR-007)
-- -----------------------------------------------------------------------------
create or replace function app.tickets_before_update()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if not exists (
      select 1 from public.ticket_status_transitions t
      where t.from_status = old.status and t.to_status = new.status
    ) then
      raise exception 'Transição de status inválida: % → %', old.status, new.status
        using errcode = 'check_violation',
              hint = 'Consulte public.ticket_status_transitions para os fluxos permitidos.';
    end if;

    if new.status = 'resolved' then
      new.resolved_at := coalesce(new.resolved_at, now());
    end if;

    if new.status = 'closed' then
      new.closed_at := coalesce(new.closed_at, now());
    end if;

    -- Reabertura: limpa os carimbos para que a próxima resolução seja medida de novo.
    if app.status_is_open(new.status) and not app.status_is_open(old.status) then
      new.reopened_count := old.reopened_count + 1;
      new.resolved_at := null;
      new.closed_at := null;
    end if;
  end if;

  -- Cliente acompanha a filial automaticamente.
  if new.branch_id is distinct from old.branch_id and new.branch_id is not null then
    select b.client_id into new.client_id from public.branches b where b.id = new.branch_id;
  end if;

  return new;
end;
$$;

create trigger trg_tickets_before_update
  before update on public.tickets
  for each row execute function app.tickets_before_update();

-- -----------------------------------------------------------------------------
-- ticket_history — audit trail (RF-TCK-05)
-- -----------------------------------------------------------------------------
create table public.ticket_history (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  ticket_id     uuid not null references public.tickets(id) on delete cascade,
  actor_id      uuid references public.profiles(id) on delete set null,
  field         text not null,
  old_value     text,
  new_value     text,
  change_source text not null default 'ui',
  reason        text,
  created_at    timestamptz not null default now()
);

create index idx_ticket_history_ticket on public.ticket_history (ticket_id, created_at desc);
create index idx_ticket_history_tenant on public.ticket_history (tenant_id, created_at desc);

-- Gravado por TRIGGER, não pela aplicação (antipattern A-06): assim, mudanças
-- feitas por integração, job ou SQL direto também ficam auditadas.
create or replace function app.tickets_after_update_history()
returns trigger
language plpgsql
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  v_key text;
  v_ignored text[] := array['updated_at','change_source','ticket_number','tenant_id','id'];
begin
  for v_key in select jsonb_object_keys(v_new) loop
    if v_key = any (v_ignored) then
      continue;
    end if;
    if v_new -> v_key is distinct from v_old -> v_key then
      insert into public.ticket_history
        (tenant_id, ticket_id, actor_id, field, old_value, new_value, change_source)
      values
        (new.tenant_id, new.id, app.current_user_id(), v_key,
         nullif(v_old ->> v_key, ''), nullif(v_new ->> v_key, ''), new.change_source);
    end if;
  end loop;
  return null;
end;
$$;

create trigger trg_tickets_history
  after update on public.tickets
  for each row execute function app.tickets_after_update_history();

-- -----------------------------------------------------------------------------
-- Comentários e anexos
-- -----------------------------------------------------------------------------
create table public.ticket_comments (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  ticket_id  uuid not null,
  author_id  uuid,
  body       text not null check (length(btrim(body)) > 0),
  -- 'internal' nunca é exposto ao solicitante (aplicado via RLS em 0011).
  visibility text not null default 'public' check (visibility in ('public','internal')),
  source     text not null default 'ui' check (source in ('ui','api','integration','email')),
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint fk_comment_ticket foreign key (ticket_id, tenant_id)
    references public.tickets (id, tenant_id) on delete cascade,
  constraint fk_comment_author foreign key (author_id, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,
  constraint uq_comment_id_tenant unique (id, tenant_id)
);

create index idx_comments_ticket on public.ticket_comments (ticket_id, created_at)
  where deleted_at is null;
create unique index uq_comment_external on public.ticket_comments (tenant_id, ticket_id, external_id)
  where external_id is not null;

create table public.ticket_attachments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  ticket_id    uuid not null,
  comment_id   uuid,
  storage_path text not null,
  file_name    text not null,
  mime_type    text,
  size_bytes   bigint check (size_bytes >= 0),
  uploaded_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint fk_attach_ticket foreign key (ticket_id, tenant_id)
    references public.tickets (id, tenant_id) on delete cascade,
  constraint fk_attach_comment foreign key (comment_id, tenant_id)
    references public.ticket_comments (id, tenant_id) on delete cascade
);

create index idx_attachments_ticket on public.ticket_attachments (ticket_id);

-- Primeira resposta pública de um agente marca o TFR (RF-SLA-01).
-- Fica junto do comentário porque é esse o evento que define "houve resposta";
-- inferir por mudança de status daria falso positivo em triagem automática.
create or replace function app.comments_after_insert_first_response()
returns trigger
language plpgsql
as $$
declare
  v_author_role text;
begin
  if new.visibility <> 'public' then
    return null;
  end if;

  select role into v_author_role from public.profiles where id = new.author_id;

  if v_author_role is null or v_author_role in ('solicitante') then
    return null;   -- resposta do próprio solicitante não conta como atendimento
  end if;

  update public.tickets
     set first_response_at = now(),
         change_source = 'system'
   where id = new.ticket_id
     and first_response_at is null;

  return null;
end;
$$;

create trigger trg_comment_first_response
  after insert on public.ticket_comments
  for each row execute function app.comments_after_insert_first_response();

select app.harden_table('public.tickets');
select app.harden_table('public.ticket_comments');
select app.harden_table('public.ticket_attachments');
select app.harden_table('public.ticket_history');
select app.harden_table('public.ticket_status_transitions');


-- =============================================================================
-- ARQUIVO 6 de 23: 0006_sla.sql
-- =============================================================================

-- =============================================================================
-- 0006 — SLA: contratos, definições, medição, pausas e alertas
-- =============================================================================

-- -----------------------------------------------------------------------------
-- sla_contracts — contrato por cliente, opcionalmente sobrescrito por filial
-- -----------------------------------------------------------------------------
-- RF-SLA-07: `branch_id NULL` = vale para todas as filiais do cliente;
-- `branch_id` preenchido = sobrescrita específica daquela filial.
create table public.sla_contracts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  client_id         uuid not null,
  branch_id         uuid,
  name              text not null,
  business_hours_id uuid,
  valid_from        date,
  valid_to          date,
  is_active         boolean not null default true,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint fk_slac_client foreign key (client_id, tenant_id)
    references public.clients (id, tenant_id) on delete cascade,
  constraint fk_slac_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete cascade,
  constraint fk_slac_bh foreign key (business_hours_id, tenant_id)
    references public.business_hours (id, tenant_id) on delete set null,
  constraint uq_slac_id_tenant unique (id, tenant_id),
  constraint slac_valid_period check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create index idx_slac_lookup on public.sla_contracts (tenant_id, client_id, branch_id) where is_active;

-- -----------------------------------------------------------------------------
-- sla_definitions — alvos por (contrato?, categoria?, prioridade)
-- -----------------------------------------------------------------------------
-- `contract_id NULL` = SLA padrão do tenant (fallback final).
-- `category_id NULL` = curinga, vale para qualquer categoria.
create table public.sla_definitions (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  contract_id            uuid,
  category_id            uuid,
  priority_id            uuid not null,
  first_response_minutes integer not null check (first_response_minutes > 0),
  resolution_minutes     integer not null check (resolution_minutes > 0),
  business_hours_id      uuid,
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint fk_slad_contract foreign key (contract_id, tenant_id)
    references public.sla_contracts (id, tenant_id) on delete cascade,
  constraint fk_slad_category foreign key (category_id, tenant_id)
    references public.ticket_categories (id, tenant_id) on delete cascade,
  constraint fk_slad_priority foreign key (priority_id, tenant_id)
    references public.ticket_priorities (id, tenant_id) on delete cascade,
  constraint fk_slad_bh foreign key (business_hours_id, tenant_id)
    references public.business_hours (id, tenant_id) on delete set null,
  constraint slad_resolution_after_response check (resolution_minutes >= first_response_minutes),
  constraint uq_slad_id_tenant unique (id, tenant_id)
);

-- Impede duas definições idênticas competindo pela mesma combinação.
create unique index uq_slad_combo on public.sla_definitions (
  tenant_id,
  coalesce(contract_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid),
  priority_id
);

-- -----------------------------------------------------------------------------
-- fn_resolve_sla — precedência determinística (RF-SLA, seção 2.2)
-- -----------------------------------------------------------------------------
-- Sem ordenação explícita, múltiplas definições aplicáveis dariam resultado
-- imprevisível (dependente do plano de execução). O `order by` abaixo É a regra
-- de negócio: do mais específico ao mais genérico.
create or replace function app.fn_resolve_sla(
  p_tenant_id   uuid,
  p_client_id   uuid,
  p_branch_id   uuid,
  p_category_id uuid,
  p_priority_id uuid
)
returns public.sla_definitions
language sql
stable
as $$
  select d.*
  from public.sla_definitions d
  left join public.sla_contracts c on c.id = d.contract_id
  where d.tenant_id = p_tenant_id
    and d.priority_id = p_priority_id
    and d.is_active
    and (d.category_id is null or d.category_id = p_category_id)
    and (
      d.contract_id is null
      or (
        c.is_active
        and (c.valid_from is null or c.valid_from <= current_date)
        and (c.valid_to   is null or c.valid_to   >= current_date)
        and (
             (c.branch_id is not null and c.branch_id = p_branch_id)
          or (c.branch_id is null and c.client_id = p_client_id)
        )
      )
    )
  order by
    case
      when c.branch_id is not null and d.category_id is not null then 1  -- filial + categoria
      when c.branch_id is not null                              then 2  -- filial
      when c.id is not null and d.category_id is not null       then 3  -- cliente + categoria
      when c.id is not null                                     then 4  -- cliente
      else                                                            5  -- padrão do tenant
    end,
    d.created_at
  limit 1;
$$;

comment on function app.fn_resolve_sla(uuid,uuid,uuid,uuid,uuid) is
  'Resolve qual SLA se aplica, do mais específico ao mais genérico. NULL = sem cobertura.';

-- -----------------------------------------------------------------------------
-- sla_tracking — medição por ticket (1:1)
-- -----------------------------------------------------------------------------
create table public.sla_tracking (
  ticket_id              uuid primary key references public.tickets(id) on delete cascade,
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  -- Gravado para rastreabilidade: mostra QUAL política se aplicou, mesmo que ela
  -- mude depois (boa prática extraída do benchmarking, seção 2.1).
  sla_definition_id      uuid references public.sla_definitions(id) on delete set null,
  business_hours_id      uuid references public.business_hours(id) on delete set null,

  first_response_minutes integer,
  resolution_minutes     integer,

  started_at             timestamptz not null default now(),
  response_due_at        timestamptz,
  resolution_due_at      timestamptz,

  responded_at           timestamptz,
  resolved_at            timestamptz,

  response_breached      boolean not null default false,
  resolution_breached    boolean not null default false,

  paused_minutes         numeric not null default 0 check (paused_minutes >= 0),
  is_paused              boolean not null default false,

  -- 'covered' = há SLA aplicável; 'uncovered' = nenhuma definição casou (ver
  -- decisão em docs/01-requisitos.md §2.2 — o ticket é criado mesmo assim).
  coverage               text not null default 'covered' check (coverage in ('covered','uncovered')),
  updated_at             timestamptz not null default now()
);

create index idx_sla_tracking_due on public.sla_tracking (tenant_id, resolution_due_at)
  where not resolution_breached;
create index idx_sla_tracking_breached on public.sla_tracking (tenant_id)
  where resolution_breached or response_breached;

-- -----------------------------------------------------------------------------
-- sla_pauses — pausas como INTERVALOS, não contador (benchmarking §2.3)
-- -----------------------------------------------------------------------------
-- Guardar intervalos (e não decrementar um contador) preserva *quando* pausou,
-- permite recalcular o histórico e torna a medição auditável.
create table public.sla_pauses (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  ticket_id  uuid not null references public.tickets(id) on delete cascade,
  reason     text not null,
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  constraint sla_pause_valid check (ended_at is null or ended_at >= started_at)
);

create index idx_sla_pauses_ticket on public.sla_pauses (ticket_id, started_at desc);
create unique index uq_sla_pause_open on public.sla_pauses (ticket_id) where ended_at is null;

-- -----------------------------------------------------------------------------
-- Criação do tracking junto com o ticket
-- -----------------------------------------------------------------------------
create or replace function app.tickets_after_insert_sla()
returns trigger
language plpgsql
as $$
declare
  v_def public.sla_definitions;
  v_bh  uuid;
begin
  v_def := app.fn_resolve_sla(new.tenant_id, new.client_id, new.branch_id,
                              new.category_id, new.priority_id);

  if v_def.id is null then
    -- Sem cobertura: cria o ticket assim mesmo e sinaliza para o relatório de
    -- cobertura. Bloquear a criação inviabilizaria tickets vindos de integração.
    insert into public.sla_tracking (ticket_id, tenant_id, started_at, coverage)
    values (new.id, new.tenant_id, new.created_at, 'uncovered');
    return null;
  end if;

  -- Precedência do calendário: definição > contrato > filial.
  v_bh := coalesce(
    v_def.business_hours_id,
    (select c.business_hours_id from public.sla_contracts c where c.id = v_def.contract_id),
    (select b.business_hours_id from public.branches b where b.id = new.branch_id)
  );

  insert into public.sla_tracking (
    ticket_id, tenant_id, sla_definition_id, business_hours_id,
    first_response_minutes, resolution_minutes,
    started_at, response_due_at, resolution_due_at, coverage
  )
  values (
    new.id, new.tenant_id, v_def.id, v_bh,
    v_def.first_response_minutes, v_def.resolution_minutes,
    new.created_at,
    app.fn_add_business_minutes(new.created_at, v_def.first_response_minutes, v_bh),
    app.fn_add_business_minutes(new.created_at, v_def.resolution_minutes, v_bh),
    'covered'
  );

  return null;
end;
$$;

create trigger trg_tickets_sla_init
  after insert on public.tickets
  for each row execute function app.tickets_after_insert_sla();

-- -----------------------------------------------------------------------------
-- Pausa/retomada do relógio e fechamento da medição (RF-SLA-05)
-- -----------------------------------------------------------------------------
create or replace function app.tickets_after_update_sla()
returns trigger
language plpgsql
as $$
declare
  v_track   public.sla_tracking;
  v_pause   public.sla_pauses;
  v_paused  numeric;
begin
  select * into v_track from public.sla_tracking where ticket_id = new.id;
  if v_track.ticket_id is null then
    return null;
  end if;

  -- Entrou em estado de espera → abre pausa.
  if app.status_pauses_sla(new.status) and not app.status_pauses_sla(old.status) then
    insert into public.sla_pauses (tenant_id, ticket_id, reason)
    values (new.tenant_id, new.id, new.status)
    on conflict do nothing;

    update public.sla_tracking
       set is_paused = true, updated_at = now()
     where ticket_id = new.id;
  end if;

  -- Saiu do estado de espera → fecha pausa e empurra os prazos.
  if not app.status_pauses_sla(new.status) and app.status_pauses_sla(old.status) then
    update public.sla_pauses
       set ended_at = now()
     where ticket_id = new.id and ended_at is null
    returning * into v_pause;

    if v_pause.id is not null then
      -- Só conta o tempo de pausa que caiu DENTRO do expediente: pausar numa
      -- sexta 18h e retomar segunda 8h não deve gerar crédito nenhum.
      v_paused := app.fn_business_minutes_between(
        v_pause.started_at, v_pause.ended_at, v_track.business_hours_id);

      update public.sla_tracking t
         set paused_minutes = t.paused_minutes + v_paused,
             is_paused = false,
             response_due_at = case
               when t.responded_at is null and t.first_response_minutes is not null
                 then app.fn_add_business_minutes(
                        t.started_at, t.first_response_minutes + t.paused_minutes + v_paused,
                        t.business_hours_id)
               else t.response_due_at end,
             resolution_due_at = case
               when t.resolution_minutes is not null
                 then app.fn_add_business_minutes(
                        t.started_at, t.resolution_minutes + t.paused_minutes + v_paused,
                        t.business_hours_id)
               else t.resolution_due_at end,
             updated_at = now()
       where t.ticket_id = new.id;
    else
      update public.sla_tracking set is_paused = false, updated_at = now() where ticket_id = new.id;
    end if;
  end if;

  -- Primeira resposta registrada no ticket → fecha a medição de TFR.
  if new.first_response_at is not null and old.first_response_at is null then
    update public.sla_tracking
       set responded_at = new.first_response_at,
           response_breached = (response_due_at is not null and new.first_response_at > response_due_at),
           updated_at = now()
     where ticket_id = new.id;
  end if;

  -- Resolução → fecha a medição de TR.
  if new.resolved_at is not null and old.resolved_at is distinct from new.resolved_at then
    update public.sla_tracking
       set resolved_at = new.resolved_at,
           resolution_breached = (resolution_due_at is not null and new.resolved_at > resolution_due_at),
           updated_at = now()
     where ticket_id = new.id;
  end if;

  -- Reabertura limpa a medição de resolução para nova contagem.
  if new.resolved_at is null and old.resolved_at is not null then
    update public.sla_tracking
       set resolved_at = null, resolution_breached = false, updated_at = now()
     where ticket_id = new.id;
  end if;

  return null;
end;
$$;

create trigger trg_tickets_sla_update
  after update on public.tickets
  for each row execute function app.tickets_after_update_sla();

-- -----------------------------------------------------------------------------
-- Estado de SLA derivado (nunca armazenado — muda a cada segundo)
-- -----------------------------------------------------------------------------
create or replace function app.sla_state(
  p_due timestamptz, p_done timestamptz, p_breached boolean,
  p_warning_pct smallint, p_critical_pct smallint, p_started timestamptz
)
returns text
language sql
stable
as $$
  select case
    when p_due is null                       then 'no_sla'
    when p_breached                          then 'breached'
    when p_done is not null                  then 'met'
    when now() > p_due                       then 'breached'
    when p_started is null                   then 'ok'
    when extract(epoch from (now() - p_started))
         >= extract(epoch from (p_due - p_started)) * (p_critical_pct / 100.0) then 'critical'
    when extract(epoch from (now() - p_started))
         >= extract(epoch from (p_due - p_started)) * (p_warning_pct / 100.0)  then 'warning'
    else 'ok'
  end;
$$;

comment on function app.sla_state(timestamptz,timestamptz,boolean,smallint,smallint,timestamptz) is
  'Semáforo de SLA: no_sla | ok | warning | critical | breached | met (RF-SLA-04).';

select app.harden_table('public.sla_contracts');
select app.harden_table('public.sla_definitions');
select app.harden_table('public.sla_tracking');
select app.harden_table('public.sla_pauses');


-- =============================================================================
-- ARQUIVO 7 de 23: 0007_inventory.sql
-- =============================================================================

-- =============================================================================
-- 0007 — Inventário de TI e de linhas telefônicas
-- =============================================================================

-- -----------------------------------------------------------------------------
-- it_assets (RF-INV-01)
-- -----------------------------------------------------------------------------
create table public.it_assets (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,

  asset_tag        text,              -- patrimônio
  serial_number    text,              -- periféricos e licenças costumam não ter
  asset_type       text not null check (asset_type in (
                     'notebook','desktop','server','smartphone','tablet','monitor',
                     'printer','peripheral','network','software_license','other')),
  brand            text,
  model            text,
  specs            jsonb not null default '{}'::jsonb,

  status           text not null default 'in_stock' check (status in (
                     'in_stock','active','maintenance','retired','lost')),

  branch_id        uuid,
  assigned_user_id uuid,
  supplier_id      uuid,              -- FK adicionada em 0008

  acquisition_date date,
  warranty_until   date,
  acquisition_cost numeric(14,2) check (acquisition_cost is null or acquisition_cost >= 0),
  notes            text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,

  constraint fk_asset_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete set null,
  constraint fk_asset_user foreign key (assigned_user_id, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,
  constraint uq_asset_id_tenant unique (id, tenant_id),
  constraint asset_warranty_after_acquisition
    check (warranty_until is null or acquisition_date is null or warranty_until >= acquisition_date)
);

-- Unicidade POR TENANT, não global: dois tenants podem legitimamente usar a mesma
-- tag de patrimônio (decisão registrada em docs/01-requisitos.md §2.5).
create unique index uq_asset_tag on public.it_assets (tenant_id, upper(asset_tag))
  where asset_tag is not null and deleted_at is null;
create unique index uq_asset_serial on public.it_assets (tenant_id, upper(serial_number))
  where serial_number is not null and deleted_at is null;

create index idx_assets_branch on public.it_assets (tenant_id, branch_id, status) where deleted_at is null;
create index idx_assets_user on public.it_assets (tenant_id, assigned_user_id) where deleted_at is null;
create index idx_assets_warranty on public.it_assets (tenant_id, warranty_until)
  where deleted_at is null and warranty_until is not null;

-- -----------------------------------------------------------------------------
-- asset_assignments — histórico de ciclo de vida (RF-INV-02)
-- -----------------------------------------------------------------------------
-- Cobre a cadeia aquisição → atribuição → manutenção → realocação → baixa em uma
-- linha do tempo única. Uma tabela só de "atribuição" não registraria manutenção
-- nem baixa, deixando o lifecycle exigido pelo escopo sem trilha.
create table public.asset_assignments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  asset_id    uuid not null,
  event_type  text not null check (event_type in (
                'acquisition','assignment','maintenance','relocation','return','retirement','loss')),
  user_id     uuid,
  branch_id   uuid,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  performed_by uuid references public.profiles(id) on delete set null,
  notes       text,
  created_at  timestamptz not null default now(),
  constraint fk_aa_asset foreign key (asset_id, tenant_id)
    references public.it_assets (id, tenant_id) on delete cascade,
  constraint fk_aa_user foreign key (user_id, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,
  constraint fk_aa_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete set null,
  constraint aa_valid_period check (ended_at is null or ended_at >= started_at)
);

create index idx_aa_asset on public.asset_assignments (asset_id, started_at desc);
create index idx_aa_user on public.asset_assignments (tenant_id, user_id) where user_id is not null;

-- Mudanças de titularidade/local do ativo geram evento automaticamente: assim o
-- histórico não depende de a aplicação lembrar de gravá-lo.
create or replace function app.assets_after_update_history()
returns trigger
language plpgsql
as $$
begin
  if new.assigned_user_id is distinct from old.assigned_user_id
     or new.branch_id is distinct from old.branch_id then
    -- Fecha o vínculo anterior ainda aberto.
    update public.asset_assignments
       set ended_at = now()
     where asset_id = new.id and ended_at is null and event_type in ('assignment','relocation');

    insert into public.asset_assignments
      (tenant_id, asset_id, event_type, user_id, branch_id, performed_by)
    values
      (new.tenant_id, new.id,
       case when new.assigned_user_id is distinct from old.assigned_user_id
            then 'assignment' else 'relocation' end,
       new.assigned_user_id, new.branch_id, app.current_user_id());
  end if;

  if new.status is distinct from old.status and new.status in ('maintenance','retired','lost') then
    insert into public.asset_assignments
      (tenant_id, asset_id, event_type, user_id, branch_id, performed_by)
    values
      (new.tenant_id, new.id,
       case new.status when 'maintenance' then 'maintenance'
                       when 'retired'     then 'retirement'
                       else 'loss' end,
       new.assigned_user_id, new.branch_id, app.current_user_id());
  end if;

  return null;
end;
$$;

create trigger trg_assets_history
  after update on public.it_assets
  for each row execute function app.assets_after_update_history();

-- -----------------------------------------------------------------------------
-- telecom_lines (RF-TEL-01)
-- -----------------------------------------------------------------------------
create table public.telecom_lines (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,

  phone_number     text not null,
  carrier          text not null,
  plan_name        text,
  line_type        text not null check (line_type in ('postpaid','prepaid','control')),
  status           text not null default 'active' check (status in ('active','suspended','cancelled')),

  branch_id        uuid,
  assigned_user_id uuid,
  device_asset_id  uuid,             -- aparelho vinculado, quando houver

  monthly_cost     numeric(12,2) check (monthly_cost is null or monthly_cost >= 0),
  activated_on     date,
  cancelled_on     date,
  loyalty_until    date,
  notes            text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,

  constraint fk_line_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete set null,
  constraint fk_line_user foreign key (assigned_user_id, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,
  constraint fk_line_device foreign key (device_asset_id, tenant_id)
    references public.it_assets (id, tenant_id) on delete set null,
  constraint uq_line_id_tenant unique (id, tenant_id),
  constraint line_cancel_after_activation
    check (cancelled_on is null or activated_on is null or cancelled_on >= activated_on),
  constraint line_cancelled_needs_date
    check (status <> 'cancelled' or cancelled_on is not null)
);

create unique index uq_line_number on public.telecom_lines (tenant_id, phone_number)
  where deleted_at is null;
create index idx_lines_branch on public.telecom_lines (tenant_id, branch_id, status) where deleted_at is null;
-- Sustenta o relatório de custos por filial/operadora/período (RF-TEL-02).
create index idx_lines_cost on public.telecom_lines (tenant_id, carrier, status)
  where deleted_at is null;

-- -----------------------------------------------------------------------------
-- Vínculo de ativos e linhas a tickets (RF-INV-03)
-- -----------------------------------------------------------------------------
create table public.ticket_assets (
  ticket_id  uuid not null,
  asset_id   uuid not null,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (ticket_id, asset_id),
  constraint fk_ta_ticket foreign key (ticket_id, tenant_id)
    references public.tickets (id, tenant_id) on delete cascade,
  constraint fk_ta_asset foreign key (asset_id, tenant_id)
    references public.it_assets (id, tenant_id) on delete cascade
);

create index idx_ticket_assets_asset on public.ticket_assets (asset_id);

create table public.ticket_telecom_lines (
  ticket_id  uuid not null,
  line_id    uuid not null,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (ticket_id, line_id),
  constraint fk_tl_ticket foreign key (ticket_id, tenant_id)
    references public.tickets (id, tenant_id) on delete cascade,
  constraint fk_tl_line foreign key (line_id, tenant_id)
    references public.telecom_lines (id, tenant_id) on delete cascade
);

create index idx_ticket_lines_line on public.ticket_telecom_lines (line_id);

select app.harden_table('public.it_assets');
select app.harden_table('public.asset_assignments');
select app.harden_table('public.telecom_lines');
select app.harden_table('public.ticket_assets');
select app.harden_table('public.ticket_telecom_lines');


-- =============================================================================
-- ARQUIVO 8 de 23: 0008_suppliers.sql
-- =============================================================================

-- =============================================================================
-- 0008 — Fornecedores de serviços e contratos (RF-FOR)
-- =============================================================================

create table public.suppliers (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  name           text not null,
  legal_name     text,
  cnpj           text,
  email          text,
  phone          text,
  website        text,
  address_line   text,
  city           text,
  state          char(2),
  -- Serviços prestados como array: a lista é curta, aberta e sempre consultada
  -- junto com o fornecedor. Tabela satélite só acrescentaria JOIN sem ganho.
  services       text[] not null default '{}',
  -- Avaliação de desempenho (RF-FOR-01), 0 a 5.
  rating         numeric(2,1) check (rating is null or (rating >= 0 and rating <= 5)),
  is_active      boolean not null default true,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  constraint uq_supplier_id_tenant unique (id, tenant_id)
);

create unique index uq_supplier_cnpj on public.suppliers (tenant_id, cnpj)
  where cnpj is not null and deleted_at is null;
create index idx_suppliers_tenant on public.suppliers (tenant_id) where deleted_at is null;
create index idx_suppliers_services on public.suppliers using gin (services);

create table public.supplier_contracts (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  supplier_id            uuid not null,
  contract_number        text,
  description            text,
  starts_on              date,
  ends_on                date,
  monthly_cost           numeric(14,2) check (monthly_cost is null or monthly_cost >= 0),
  -- SLA CONTRATADO do fornecedor. Diferente de sla_definitions, que é o SLA que
  -- nós oferecemos ao cliente: aqui é o prazo que o terceiro nos deve.
  response_sla_minutes   integer check (response_sla_minutes is null or response_sla_minutes > 0),
  resolution_sla_minutes integer check (resolution_sla_minutes is null or resolution_sla_minutes > 0),
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint fk_sc_supplier foreign key (supplier_id, tenant_id)
    references public.suppliers (id, tenant_id) on delete cascade,
  constraint sc_valid_period check (ends_on is null or starts_on is null or ends_on >= starts_on)
);

create index idx_supplier_contracts on public.supplier_contracts (tenant_id, supplier_id) where is_active;

-- FKs pendentes de 0005 e 0007, agora que `suppliers` existe (RF-FOR-02, RF-INV-01).
alter table public.tickets
  add constraint fk_tickets_supplier foreign key (supplier_id, tenant_id)
    references public.suppliers (id, tenant_id) on delete set null;

alter table public.it_assets
  add constraint fk_asset_supplier foreign key (supplier_id, tenant_id)
    references public.suppliers (id, tenant_id) on delete set null;

create index idx_tickets_supplier on public.tickets (tenant_id, supplier_id)
  where supplier_id is not null and deleted_at is null;

select app.harden_table('public.suppliers');
select app.harden_table('public.supplier_contracts');


-- =============================================================================
-- ARQUIVO 9 de 23: 0009_integrations.sql
-- =============================================================================

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


-- =============================================================================
-- ARQUIVO 10 de 23: 0010_audit.sql
-- =============================================================================

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


-- =============================================================================
-- ARQUIVO 11 de 23: 0011_dashboard.sql
-- =============================================================================

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


-- =============================================================================
-- ARQUIVO 12 de 23: 0012_rls_policies.sql
-- =============================================================================

-- =============================================================================
-- 0012 — Policies de RLS (ADR-002, ADR-003)
-- =============================================================================
-- Todas as policies concentradas em um arquivo: o modelo de segurança inteiro
-- pode ser lido de uma vez, e a cobertura é verificável (ver supabase/tests).
--
-- Camadas, sempre nesta ordem:
--   1. tenant_id = app.current_tenant_id()        → isolamento entre assinantes
--   2. escopo de filial ou de autoria             → visibilidade dentro do tenant
--   3. papel                                      → o que pode escrever
--
-- `service_role` (Edge Functions, rota de TV) tem BYPASSRLS e não passa por aqui;
-- nesses dois pontos o isolamento é responsabilidade explícita do código.
-- =============================================================================

-- Privilégios de tabela. RLS filtra LINHAS, mas o GRANT ainda é necessário para
-- que o papel `authenticated` possa sequer tocar na tabela.
grant usage on schema public to anon, authenticated;
grant usage on schema app to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Helper: quem pode administrar cadastros do tenant
-- -----------------------------------------------------------------------------
create or replace function app.can_manage_config()
returns boolean
language sql
stable
as $$
  select coalesce(app.current_role() in ('super_admin','admin'), false);
$$;

create or replace function app.can_manage_records()
returns boolean
language sql
stable
as $$
  select coalesce(app.current_role() in ('super_admin','admin','gestor'), false);
$$;

-- Papéis que operam tickets (todos menos o solicitante puro).
create or replace function app.can_work_tickets()
returns boolean
language sql
stable
as $$
  select coalesce(app.current_role() in ('super_admin','admin','gestor','atendente'), false);
$$;

-- =============================================================================
-- tenants — cada um enxerga apenas o próprio
-- =============================================================================
create policy tenants_select on public.tenants
  for select to authenticated
  using (id = app.current_tenant_id() or app.is_super_admin());

create policy tenants_update on public.tenants
  for update to authenticated
  using (id = app.current_tenant_id() and app.can_manage_config())
  with check (id = app.current_tenant_id());

grant select, update on public.tenants to authenticated;

-- =============================================================================
-- profiles
-- =============================================================================
-- Todo membro do tenant enxerga os colegas (necessário para atribuir tickets,
-- mencionar pessoas e exibir nomes); apenas admin gerencia.
create policy profiles_select on public.profiles
  for select to authenticated
  using (tenant_id = app.current_tenant_id() or id = app.current_user_id() or app.is_super_admin());

create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.can_manage_config());

-- O próprio usuário edita seu perfil; admin edita qualquer um. A policy NÃO
-- impede troca de `role` por conta própria — isso é barrado pela trigger abaixo,
-- porque WITH CHECK não consegue comparar com o valor anterior.
create policy profiles_update on public.profiles
  for update to authenticated
  using (
    (tenant_id = app.current_tenant_id() and app.can_manage_config())
    or id = app.current_user_id()
  )
  with check (
    (tenant_id = app.current_tenant_id() and app.can_manage_config())
    or id = app.current_user_id()
  );

create policy profiles_delete on public.profiles
  for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_config());

-- Escalonamento de privilégio: sem isto, um `solicitante` poderia se promover a
-- `admin` com um simples update no próprio perfil, que a policy acima permite.
create or replace function app.prevent_self_privilege_escalation()
returns trigger
language plpgsql
as $$
begin
  if app.is_service_role() or app.current_user_id() is null then
    return new;                                  -- provisionamento pelo backend
  end if;

  if (new.role is distinct from old.role or new.tenant_id is distinct from old.tenant_id)
     and not app.can_manage_config() then
    raise exception 'Apenas administradores podem alterar papel ou tenant de um usuário'
      using errcode = 'insufficient_privilege';
  end if;

  -- Nem mesmo um admin se auto-promove a super_admin (papel da operação do SaaS).
  if new.role = 'super_admin' and old.role <> 'super_admin' and not app.is_super_admin() then
    raise exception 'Papel super_admin só pode ser concedido pela operação da plataforma'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger trg_profiles_no_escalation
  before update on public.profiles
  for each row execute function app.prevent_self_privilege_escalation();

grant select, insert, update, delete on public.profiles to authenticated;

-- =============================================================================
-- Cadastros administrados por admin/gestor, legíveis por todo o tenant
-- =============================================================================
-- Gerado em laço: são ~15 tabelas com exatamente a mesma forma de policy, e
-- escrevê-las à mão seria 15 chances de divergir uma delas.
do $$
declare
  t text;
  -- Só entram aqui tabelas que possuem coluna `tenant_id` própria.
  -- business_hours_intervals/holidays ficam de fora: pendem do calendário pai
  -- e recebem policy própria logo abaixo.
  read_write_tables text[] := array[
    'clients','branches','user_branches','business_hours',
    'ticket_priorities','ticket_categories','queues',
    'queue_members','queue_rules','sla_contracts','sla_definitions','suppliers',
    'supplier_contracts','dashboard_layouts','dashboard_tokens','integrations',
    'integration_mappings'
  ];
begin
  foreach t in array read_write_tables loop
    execute format($f$
      create policy %1$s_select on public.%1$s
        for select to authenticated
        using (tenant_id = app.current_tenant_id());
    $f$, t);

    execute format($f$
      create policy %1$s_insert on public.%1$s
        for insert to authenticated
        with check (tenant_id = app.current_tenant_id() and app.can_manage_records());
    $f$, t);

    execute format($f$
      create policy %1$s_update on public.%1$s
        for update to authenticated
        using (tenant_id = app.current_tenant_id() and app.can_manage_records())
        with check (tenant_id = app.current_tenant_id());
    $f$, t);

    execute format($f$
      create policy %1$s_delete on public.%1$s
        for delete to authenticated
        using (tenant_id = app.current_tenant_id() and app.can_manage_records());
    $f$, t);

    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end
$$;

-- Janelas e feriados não carregam tenant_id: o vínculo é pelo calendário pai.
grant select, insert, update, delete
  on public.business_hours_intervals, public.business_hours_holidays to authenticated;

create policy bhi_all on public.business_hours_intervals
  for all to authenticated
  using (exists (select 1 from public.business_hours bh
                 where bh.id = business_hours_id and bh.tenant_id = app.current_tenant_id()))
  with check (exists (select 1 from public.business_hours bh
                 where bh.id = business_hours_id and bh.tenant_id = app.current_tenant_id())
              and app.can_manage_records());

create policy bhh_all on public.business_hours_holidays
  for all to authenticated
  using (exists (select 1 from public.business_hours bh
                 where bh.id = business_hours_id and bh.tenant_id = app.current_tenant_id()))
  with check (exists (select 1 from public.business_hours bh
                 where bh.id = business_hours_id and bh.tenant_id = app.current_tenant_id())
              and app.can_manage_records());

-- =============================================================================
-- tickets — tenant + filial + autoria (ADR-003)
-- =============================================================================
create policy tickets_select on public.tickets
  for select to authenticated
  using (
    tenant_id = app.current_tenant_id()
    and (
         app.has_tenant_wide_access()                       -- admin, gestor
      or requester_id = app.current_user_id()               -- o que eu abri
      or (app.current_role() in ('atendente','visualizador') -- minhas filiais
          and branch_id = any (app.current_user_branch_ids()))
    )
  );

-- Qualquer membro do tenant abre ticket. Um solicitante não pode abrir "em nome
-- de" outra pessoa nem fora das suas filiais.
create policy tickets_insert on public.tickets
  for insert to authenticated
  with check (
    tenant_id = app.current_tenant_id()
    and (
         app.can_work_tickets()
      or (requester_id = app.current_user_id()
          and (branch_id is null or branch_id = any (app.current_user_branch_ids())))
    )
  );

create policy tickets_update on public.tickets
  for update to authenticated
  using (
    tenant_id = app.current_tenant_id()
    and app.can_work_tickets()
    and (app.has_tenant_wide_access() or branch_id = any (app.current_user_branch_ids()))
  )
  with check (tenant_id = app.current_tenant_id());

-- Sem DELETE: tickets usam soft delete (antipattern A-09). Só admin, e ainda
-- assim a rota da aplicação grava deleted_at em vez de remover.
create policy tickets_delete on public.tickets
  for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_config());

grant select, insert, update, delete on public.tickets to authenticated;

-- -----------------------------------------------------------------------------
-- Tabelas satélite do ticket: herdam a visibilidade do ticket pai
-- -----------------------------------------------------------------------------
create policy ticket_history_select on public.ticket_history
  for select to authenticated
  using (exists (select 1 from public.tickets t where t.id = ticket_id));

grant select on public.ticket_history to authenticated;

-- Comentário interno é invisível ao solicitante — é o ponto em que o produto
-- mais facilmente vaza informação para o cliente final.
create policy ticket_comments_select on public.ticket_comments
  for select to authenticated
  using (
    exists (select 1 from public.tickets t where t.id = ticket_id)
    and (visibility = 'public' or app.can_work_tickets())
  );

create policy ticket_comments_insert on public.ticket_comments
  for insert to authenticated
  with check (
    tenant_id = app.current_tenant_id()
    and exists (select 1 from public.tickets t where t.id = ticket_id)
    and (visibility = 'public' or app.can_work_tickets())
  );

create policy ticket_comments_update on public.ticket_comments
  for update to authenticated
  using (tenant_id = app.current_tenant_id() and author_id = app.current_user_id())
  with check (tenant_id = app.current_tenant_id());

grant select, insert, update on public.ticket_comments to authenticated;

create policy ticket_attachments_all on public.ticket_attachments
  for all to authenticated
  using (exists (select 1 from public.tickets t where t.id = ticket_id))
  with check (tenant_id = app.current_tenant_id()
              and exists (select 1 from public.tickets t where t.id = ticket_id));

grant select, insert, delete on public.ticket_attachments to authenticated;

create policy ticket_assets_all on public.ticket_assets
  for all to authenticated
  using (exists (select 1 from public.tickets t where t.id = ticket_id))
  with check (tenant_id = app.current_tenant_id() and app.can_work_tickets());

create policy ticket_lines_all on public.ticket_telecom_lines
  for all to authenticated
  using (exists (select 1 from public.tickets t where t.id = ticket_id))
  with check (tenant_id = app.current_tenant_id() and app.can_work_tickets());

grant select, insert, delete on public.ticket_assets, public.ticket_telecom_lines to authenticated;

-- Transições de status: catálogo global, leitura livre para autenticados.
create policy ticket_status_transitions_select on public.ticket_status_transitions
  for select to authenticated using (true);
grant select on public.ticket_status_transitions to authenticated;

-- =============================================================================
-- SLA — leitura acompanha o ticket; escrita é da trigger (service/definer)
-- =============================================================================
create policy sla_tracking_select on public.sla_tracking
  for select to authenticated
  using (exists (select 1 from public.tickets t where t.id = ticket_id));

create policy sla_pauses_select on public.sla_pauses
  for select to authenticated
  using (exists (select 1 from public.tickets t where t.id = ticket_id));

grant select on public.sla_tracking, public.sla_pauses to authenticated;

-- =============================================================================
-- Inventário — mesmo escopo de filial dos tickets (RF-USR-02)
-- =============================================================================
create policy it_assets_select on public.it_assets
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_see_branch(branch_id));

create policy it_assets_write on public.it_assets
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_records())
  with check (tenant_id = app.current_tenant_id() and app.can_manage_records());

create policy telecom_lines_select on public.telecom_lines
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_see_branch(branch_id));

create policy telecom_lines_write on public.telecom_lines
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_records())
  with check (tenant_id = app.current_tenant_id() and app.can_manage_records());

create policy asset_assignments_select on public.asset_assignments
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_see_branch(branch_id));

create policy asset_assignments_write on public.asset_assignments
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_records())
  with check (tenant_id = app.current_tenant_id() and app.can_manage_records());

grant select, insert, update, delete
  on public.it_assets, public.telecom_lines, public.asset_assignments to authenticated;

-- =============================================================================
-- Integrações — operação sensível: apenas admin
-- =============================================================================
-- integrations/integration_mappings já receberam policies no laço acima
-- (admin/gestor). Eventos e logs são somente leitura pela UI: quem escreve é a
-- Edge Function via service_role.
create policy integration_events_select on public.integration_events
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_records());

create policy integration_logs_select on public.integration_logs
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_records());

create policy integration_sync_state_select on public.integration_sync_state
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_records());

grant select on public.integration_events, public.integration_logs,
                public.integration_sync_state to authenticated;

-- =============================================================================
-- Auditoria — leitura restrita; ninguém escreve pela API (só a trigger)
-- =============================================================================
create policy audit_log_select on public.audit_log
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_records());

grant select on public.audit_log to authenticated;

-- Views herdam RLS das tabelas base via security_invoker (ver 0011).
grant select on public.vw_tickets_enriched, public.vw_dashboard_metrics,
                public.vw_agents_online, public.vw_sla_compliance,
                public.vw_telecom_costs to authenticated;

-- Sequências usadas por colunas identity/serial.
grant usage on all sequences in schema public to authenticated;


-- =============================================================================
-- ARQUIVO 13 de 23: 0013_areas_anexos_links.sql
-- =============================================================================

-- =============================================================================
-- 0013 — Lacunas funcionais: áreas, anexos, custódia, links de internet
-- =============================================================================
-- Camada de dados dos módulos especificados em docs/06-lacunas-e-roadmap.md.
-- Cobre o que é inequívoco; o que depende de decisão do operador está listado
-- como lacuna global naquele documento e NÃO foi antecipado aqui.
-- =============================================================================

-- =============================================================================
-- MÓDULO 2 — Áreas por filial
-- =============================================================================
-- Tabela, e não campo texto: texto livre fragmenta o dado ("Enfermagem",
-- "enfermagem", "Enferm.") e destrói justamente o agrupamento por área que é o
-- objetivo do módulo — mesmo raciocínio de ticket_priorities (antipattern A-10).
create table public.branch_areas (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  branch_id  uuid not null,
  name       text not null check (length(btrim(name)) > 0),
  code       text,
  -- A natureza da área carrega peso operacional: em Home Care, parada na
  -- Enfermagem tem impacto assistencial que a Administração não tem.
  kind       text not null default 'administrativa'
               check (kind in ('assistencial','administrativa','apoio','tecnica')),
  is_active  boolean not null default true,
  sort_order smallint not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_area_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete cascade,
  constraint uq_area_id_tenant unique (id, tenant_id)
);

create unique index uq_area_name on public.branch_areas (branch_id, lower(name));
create index idx_areas_branch on public.branch_areas (tenant_id, branch_id, sort_order)
  where is_active;

comment on table public.branch_areas is
  'Subdivisões da filial. Base do detalhamento por área em inventário, telefonia, links e mapas.';

-- Áreas iniciais de uma filial nova. Sem isso, cadastrar 40 filiais significa
-- digitar as mesmas áreas 40 vezes — e a divergência de nomes que esta tabela
-- existe para evitar volta pela porta da frente.
create or replace function app.fn_seed_branch_areas(p_branch_id uuid)
returns integer
language plpgsql
as $$
declare
  v_tenant uuid;
  v_count  integer;
begin
  select tenant_id into v_tenant from public.branches where id = p_branch_id;
  if v_tenant is null then
    raise exception 'Filial % não encontrada', p_branch_id using errcode = 'foreign_key_violation';
  end if;

  insert into public.branch_areas (tenant_id, branch_id, name, kind, sort_order)
  select v_tenant, p_branch_id, v.name, v.kind, v.ord
  from (values
    ('Recepção',      'assistencial',  10),
    ('Enfermagem',    'assistencial',  20),
    ('Administração', 'administrativa',30),
    ('Financeiro',    'administrativa',40),
    ('TI',            'tecnica',       50),
    ('Logística',     'apoio',         60),
    ('Diretoria',     'administrativa',70),
    ('Estoque de TI', 'apoio',         80)
  ) as v(name, kind, ord)
  -- Idempotente: rodar de novo não duplica nem falha.
  on conflict do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Coerência área × filial. A FK composta garante o TENANT, não a FILIAL —
-- sem esta validação, um ativo de São Paulo poderia apontar para a
-- "Enfermagem" de Manaus. O nome da coluna de área vem em TG_ARGV porque
-- telecom_lines a chama de company_area_id.
create or replace function app.validate_area_branch()
returns trigger
language plpgsql
as $$
declare
  v_area_col   text := tg_argv[0];
  v_row        jsonb := to_jsonb(new);
  v_area       uuid  := nullif(v_row ->> v_area_col, '')::uuid;
  v_branch     uuid  := nullif(v_row ->> 'branch_id', '')::uuid;
  v_area_branch uuid;
begin
  if v_area is null then
    return new;
  end if;

  if v_branch is null then
    raise exception 'Não é possível informar área sem filial'
      using errcode = 'check_violation';
  end if;

  select branch_id into v_area_branch from public.branch_areas where id = v_area;

  if v_area_branch is distinct from v_branch then
    raise exception 'A área informada pertence a outra filial'
      using errcode = 'check_violation',
            hint = 'Selecione uma área da filial do próprio registro.';
  end if;

  return new;
end;
$$;

-- Área em ativos. Nullable no banco de propósito: a obrigatoriedade vive na UI
-- até que os ativos já cadastrados recebam área (LG-02). SET NOT NULL agora
-- quebraria a base existente.
alter table public.it_assets
  add column branch_area_id uuid,
  add constraint fk_asset_area foreign key (branch_area_id, tenant_id)
    references public.branch_areas (id, tenant_id) on delete restrict;

create index idx_assets_area on public.it_assets (tenant_id, branch_area_id)
  where deleted_at is null and branch_area_id is not null;

create trigger trg_assets_area_branch
  before insert or update of branch_area_id, branch_id on public.it_assets
  for each row execute function app.validate_area_branch('branch_area_id');

-- =============================================================================
-- MÓDULO 9 — Área da empresa nas linhas telefônicas
-- =============================================================================
-- Nome do campo segue o escopo (`company_area_id`), apontando para a MESMA
-- tabela de áreas do módulo 2 — dois cadastros de área divergiriam.
alter table public.telecom_lines
  add column company_area_id uuid,
  add constraint fk_line_area foreign key (company_area_id, tenant_id)
    references public.branch_areas (id, tenant_id) on delete restrict;

create index idx_lines_area on public.telecom_lines (tenant_id, company_area_id)
  where deleted_at is null and company_area_id is not null;

create trigger trg_lines_area_branch
  before insert or update of company_area_id, branch_id on public.telecom_lines
  for each row execute function app.validate_area_branch('company_area_id');

-- =============================================================================
-- MÓDULO 7 — Vigência de contrato da linha
-- =============================================================================
-- `loyalty_until` (já existente) e `contract_end` são coisas distintas:
-- fidelidade limita cancelamento sem multa; vigência é o prazo contratual.
alter table public.telecom_lines
  add column contract_number text,
  add column contract_start  date,
  add column contract_end    date,
  add constraint line_contract_period
    check (contract_end is null or contract_start is null or contract_end >= contract_start);

create index idx_lines_contract_end on public.telecom_lines (tenant_id, contract_end)
  where contract_end is not null and deleted_at is null and status <> 'cancelled';

-- Sustenta os indicadores de governança do módulo 6.
create index idx_lines_no_user on public.telecom_lines (tenant_id, branch_id)
  where assigned_user_id is null and status = 'active' and deleted_at is null;
create index idx_lines_filters on public.telecom_lines (tenant_id, branch_id, carrier, status)
  where deleted_at is null;

-- =============================================================================
-- MÓDULOS 3, 7, 8 — Anexos
-- =============================================================================
-- Uma tabela POR ENTIDADE, e não uma tabela `attachments` polimórfica:
-- (entity_type, entity_id) não admite FK, então nada impediria apontar para um
-- ativo excluído, e a limpeza em cascata passaria a depender de código. O custo
-- é repetir a estrutura três vezes; o ganho é integridade referencial que não
-- depende da disciplina de quem escreve a query.

create table public.asset_attachments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  asset_id       uuid not null,
  category       text not null check (category in ('document','photo')),
  kind           text not null check (kind in (
                   'nfe','cte','receipt','contract','warranty',
                   'photo_front','photo_back','photo_tag','photo_serial','photo_other')),
  storage_path   text not null unique,
  file_name      text not null,
  mime_type      text not null,
  size_bytes     bigint check (size_bytes > 0),
  is_primary     boolean not null default false,
  thumbnail_path text,
  -- Número/chave da NF-e. Sem FK porque não existe módulo fiscal na plataforma;
  -- quando existir, vira referência de verdade.
  invoice_ref    text,
  uploaded_by    uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint fk_asset_attach foreign key (asset_id, tenant_id)
    references public.it_assets (id, tenant_id) on delete cascade,
  constraint photo_is_image check (category <> 'photo' or mime_type like 'image/%')
);

-- UMA foto principal por ativo, garantida por índice em vez de a aplicação
-- "lembrar" de desmarcar a anterior.
create unique index uq_asset_primary_photo on public.asset_attachments (asset_id)
  where is_primary and category = 'photo';
create index idx_asset_attachments on public.asset_attachments (asset_id, category, created_at desc);

create table public.telecom_line_attachments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  line_id        uuid not null,
  kind           text not null check (kind in (
                   'contract','amendment','loyalty_term','cancellation','invoice','other')),
  storage_path   text not null unique,
  file_name      text not null,
  mime_type      text not null,
  size_bytes     bigint check (size_bytes > 0),
  valid_until    date,
  uploaded_by    uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint fk_line_attach foreign key (line_id, tenant_id)
    references public.telecom_lines (id, tenant_id) on delete cascade
);

create index idx_line_attachments on public.telecom_line_attachments (line_id, kind, created_at desc);

-- =============================================================================
-- MÓDULO 4 — Custódia do equipamento
-- =============================================================================
-- NÃO criamos `asset_custody_history`: `asset_assignments` já registra o
-- lifecycle por trigger, e duas tabelas alimentadas pelo mesmo evento divergem —
-- qualquer relatório passaria a depender de saber qual das duas é a verdade.
-- Estendemos a existente e expomos uma VIEW com o nome pedido pelo escopo.
alter table public.asset_assignments
  add column previous_user_id   uuid,
  add column previous_branch_id uuid,
  add column previous_area_id   uuid,
  add column branch_area_id     uuid,
  add column reason text not null default 'outro'
    check (reason in ('realocacao','devolucao','substituicao','baixa',
                      'manutencao','aquisicao','perda','outro')),
  add column reason_note text,
  add constraint fk_aa_prev_user foreign key (previous_user_id, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,
  add constraint fk_aa_prev_branch foreign key (previous_branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete set null,
  add constraint fk_aa_area foreign key (branch_area_id, tenant_id)
    references public.branch_areas (id, tenant_id) on delete set null,
  add constraint fk_aa_prev_area foreign key (previous_area_id, tenant_id)
    references public.branch_areas (id, tenant_id) on delete set null;

-- Trigger reescrita: agora grava o estado ANTERIOR explicitamente e deriva o
-- motivo. O motivo informado pela UI chega por variável de sessão
-- (`app.custody_reason`), o que mantém a gravação no banco — escrita por
-- importação, integração ou SQL direto continua auditada (antipattern A-06).
create or replace function app.assets_after_update_history()
returns trigger
language plpgsql
as $$
declare
  v_reason text := coalesce(nullif(current_setting('app.custody_reason', true), ''), 'outro');
begin
  if v_reason not in ('realocacao','devolucao','substituicao','baixa',
                      'manutencao','aquisicao','perda','outro') then
    v_reason := 'outro';
  end if;

  -- Atribuir área a um ativo que ainda não tinha (NULL → valor) é CLASSIFICAÇÃO
  -- inicial, não movimentação: durante a migração dos ativos legados (LG-02)
  -- isso geraria um evento falso de realocação para cada ativo da base.
  if new.assigned_user_id is distinct from old.assigned_user_id
     or new.branch_id is distinct from old.branch_id
     or (old.branch_area_id is not null
         and new.branch_area_id is distinct from old.branch_area_id) then

    -- Fecha o vínculo anterior ainda aberto. `clock_timestamp()` e não `now()`:
    -- `started_at` também usa o relógio real, e `now()` (horário da transação)
    -- seria ANTERIOR ao início de um vínculo criado no mesmo commit, violando
    -- a constraint `aa_valid_period`.
    update public.asset_assignments
       set ended_at = clock_timestamp()
     where asset_id = new.id and ended_at is null
       and event_type in ('assignment','relocation');

    insert into public.asset_assignments (
      tenant_id, asset_id, event_type,
      user_id, branch_id, branch_area_id,
      previous_user_id, previous_branch_id, previous_area_id,
      reason, performed_by
    ) values (
      new.tenant_id, new.id,
      case when new.assigned_user_id is distinct from old.assigned_user_id
           then 'assignment' else 'relocation' end,
      new.assigned_user_id, new.branch_id, new.branch_area_id,
      old.assigned_user_id, old.branch_id, old.branch_area_id,
      case
        when v_reason <> 'outro' then v_reason
        when new.assigned_user_id is null and old.assigned_user_id is not null then 'devolucao'
        when new.branch_id is distinct from old.branch_id then 'realocacao'
        else 'outro'
      end,
      app.current_user_id()
    );
  end if;

  if new.status is distinct from old.status and new.status in ('maintenance','retired','lost') then
    insert into public.asset_assignments (
      tenant_id, asset_id, event_type, user_id, branch_id, branch_area_id,
      previous_user_id, previous_branch_id, previous_area_id, reason, performed_by
    ) values (
      new.tenant_id, new.id,
      case new.status when 'maintenance' then 'maintenance'
                      when 'retired'     then 'retirement'
                      else 'loss' end,
      new.assigned_user_id, new.branch_id, new.branch_area_id,
      old.assigned_user_id, old.branch_id, old.branch_area_id,
      case new.status when 'maintenance' then 'manutencao'
                      when 'retired'     then 'baixa'
                      else 'perda' end,
      app.current_user_id()
    );
  end if;

  return null;
end;
$$;

-- `now()` devolve o horário da TRANSAÇÃO: duas mudanças de custódia no mesmo
-- commit receberiam timestamp idêntico e a timeline ficaria sem ordem definida.
-- `clock_timestamp()` avança dentro da transação e mantém a cronologia real.
alter table public.asset_assignments
  alter column started_at set default clock_timestamp();

-- Ativo em uso sem responsável: índice parcial sustenta o contador de
-- governança sem varrer a tabela.
create index idx_assets_no_owner on public.it_assets (tenant_id, branch_id)
  where assigned_user_id is null and deleted_at is null and status = 'active';

-- =============================================================================
-- MÓDULO 5 — Anexos de ticket: classificação e cota
-- =============================================================================
alter table public.ticket_attachments
  add column kind text not null default 'document'
    check (kind in ('image','audio','video','document')),
  add column thumbnail_path   text,
  add column duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  add column width  integer check (width  is null or width  > 0),
  add column height integer check (height is null or height > 0),
  -- 'skipped' enquanto não houver decisão sobre antivírus (LG-03). A coluna
  -- existe desde já para não exigir migração depois.
  add column scan_status text not null default 'skipped'
    check (scan_status in ('pending','clean','infected','skipped'));

create index idx_ticket_attachments_kind on public.ticket_attachments (ticket_id, kind);

alter table public.tenants
  add column attachment_quota_mb integer not null default 500
    check (attachment_quota_mb between 1 and 100000);

-- `kind` derivado do MIME real: extensão informada pelo cliente não é fonte
-- de verdade.
create or replace function app.derive_attachment_kind()
returns trigger
language plpgsql
as $$
begin
  new.kind := case
    when new.mime_type like 'image/%' then 'image'
    when new.mime_type like 'audio/%' then 'audio'
    when new.mime_type like 'video/%' then 'video'
    else 'document'
  end;
  return new;
end;
$$;

create trigger trg_attachment_kind
  before insert or update of mime_type on public.ticket_attachments
  for each row execute function app.derive_attachment_kind();

create or replace function app.fn_ticket_attachment_usage(p_ticket_id uuid)
returns bigint
language sql
stable
as $$
  select coalesce(sum(size_bytes), 0)::bigint
  from public.ticket_attachments
  where ticket_id = p_ticket_id;
$$;

-- Cota validada NO BANCO: dois uploads simultâneos furariam um limite
-- verificado apenas na aplicação.
create or replace function app.enforce_ticket_attachment_quota()
returns trigger
language plpgsql
as $$
declare
  v_quota_mb integer;
  v_used     bigint;
begin
  select attachment_quota_mb into v_quota_mb from public.tenants where id = new.tenant_id;
  v_used := app.fn_ticket_attachment_usage(new.ticket_id);

  if v_used + coalesce(new.size_bytes, 0) > v_quota_mb::bigint * 1024 * 1024 then
    raise exception
      'Cota de anexos do ticket excedida (limite % MB, em uso % MB)',
      v_quota_mb, round(v_used / 1048576.0, 1)
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger trg_attachment_quota
  before insert on public.ticket_attachments
  for each row execute function app.enforce_ticket_attachment_quota();

-- =============================================================================
-- MÓDULO 8 — Links de internet
-- =============================================================================
create table public.internet_links (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  branch_id       uuid not null,
  branch_area_id  uuid,

  contract_number text,
  -- Operadora vem de `suppliers` quando cadastrada; `carrier_name` é o escape
  -- para não travar o registro de um link urgente por falta de cadastro.
  supplier_id     uuid,
  carrier_name    text,

  technology      text not null check (technology in (
                    'fiber','radio','satellite','mobile_4g','mobile_5g','xdsl','other')),
  download_mbps   integer check (download_mbps is null or download_mbps > 0),
  upload_mbps     integer check (upload_mbps is null or upload_mbps > 0),
  guaranteed_mbps integer check (guaranteed_mbps is null or guaranteed_mbps > 0),

  has_static_ip   boolean not null default false,
  static_ip       inet,                       -- tipo nativo valida o endereço

  cpe_brand       text,
  cpe_model       text,
  cpe_serial      text,
  cpe_asset_id    uuid,                       -- quando o CPE é patrimônio próprio

  status          text not null default 'active'
                    check (status in ('active','suspended','cancelled')),
  monthly_cost    numeric(12,2) check (monthly_cost is null or monthly_cost >= 0),

  activated_on    date,
  cancelled_on    date,
  contract_start  date,
  contract_end    date,
  loyalty_until   date,

  monitoring_host        text,
  monitoring_external_id text,
  -- 'unknown' é o estado honesto de um link não monitorado. Nunca 'down':
  -- "não sei" e "está fora" são informações diferentes para quem opera.
  last_state      text not null default 'unknown' check (last_state in ('up','down','unknown')),
  last_state_at   timestamptz,

  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint fk_link_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete cascade,
  constraint fk_link_area foreign key (branch_area_id, tenant_id)
    references public.branch_areas (id, tenant_id) on delete restrict,
  constraint fk_link_supplier foreign key (supplier_id, tenant_id)
    references public.suppliers (id, tenant_id) on delete set null,
  constraint fk_link_cpe foreign key (cpe_asset_id, tenant_id)
    references public.it_assets (id, tenant_id) on delete set null,
  constraint uq_link_id_tenant unique (id, tenant_id),
  constraint link_static_ip_pair check (not has_static_ip or static_ip is not null),
  constraint link_cancel_needs_date check (status <> 'cancelled' or cancelled_on is not null),
  constraint link_contract_period
    check (contract_end is null or contract_start is null or contract_end >= contract_start),
  constraint link_has_carrier check (supplier_id is not null or carrier_name is not null)
);

create unique index uq_link_contract on public.internet_links (tenant_id, upper(contract_number))
  where contract_number is not null and deleted_at is null;
create index idx_links_branch on public.internet_links (tenant_id, branch_id, status)
  where deleted_at is null;
create index idx_links_down on public.internet_links (tenant_id, branch_id)
  where last_state = 'down' and status = 'active' and deleted_at is null;
create index idx_links_contract_end on public.internet_links (tenant_id, contract_end)
  where contract_end is not null and deleted_at is null and status <> 'cancelled';

create trigger trg_links_area_branch
  before insert or update of branch_area_id, branch_id on public.internet_links
  for each row execute function app.validate_area_branch('branch_area_id');

create table public.internet_link_attachments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  link_id      uuid not null,
  kind         text not null check (kind in (
                 'contract','amendment','loyalty_term','cancellation',
                 'installation_report','other')),
  storage_path text not null unique,
  file_name    text not null,
  mime_type    text not null,
  size_bytes   bigint check (size_bytes > 0),
  valid_until  date,
  uploaded_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint fk_link_attach foreign key (link_id, tenant_id)
    references public.internet_links (id, tenant_id) on delete cascade
);

create index idx_link_attachments on public.internet_link_attachments (link_id, kind, created_at desc);

-- Histórico de indisponibilidade. `duration_seconds` é coluna gerada para não
-- recalcular a duração em todo relatório de uptime.
create table public.link_availability_events (
  id                bigint generated always as identity primary key,
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  link_id           uuid not null,
  state             text not null check (state in ('up','down')),
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  duration_seconds  integer generated always as (
                      case when ended_at is null then null
                           else greatest(extract(epoch from (ended_at - started_at))::integer, 0)
                      end) stored,
  source            text not null default 'manual' check (source in ('zabbix','manual','api')),
  external_event_id text,
  note              text,
  constraint fk_link_event foreign key (link_id, tenant_id)
    references public.internet_links (id, tenant_id) on delete cascade,
  constraint link_event_period check (ended_at is null or ended_at >= started_at)
);

-- Idempotência do webhook de monitoração, mesmo padrão do Integration Hub.
create unique index uq_link_event_external on public.link_availability_events (link_id, external_event_id)
  where external_event_id is not null;
create index idx_link_events on public.link_availability_events (link_id, started_at desc);
create unique index uq_link_event_open on public.link_availability_events (link_id)
  where ended_at is null;

-- =============================================================================
-- MÓDULO 1 — SLA e filas editáveis
-- =============================================================================
alter table public.sla_definitions
  add column name text,
  add column deleted_at timestamptz;

-- A unicidade passa a ignorar definições removidas: sem isso, uma combinação
-- só poderia ser recriada se o registro antigo fosse apagado de verdade.
drop index if exists uq_slad_combo;
create unique index uq_slad_combo on public.sla_definitions (
  tenant_id,
  coalesce(contract_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid),
  priority_id
) where deleted_at is null;

-- Sustenta o preview de impacto.
create index idx_sla_tracking_definition on public.sla_tracking (sla_definition_id)
  where resolved_at is null;

alter table public.queues
  add column tiebreaker text not null default 'fifo'
    check (tiebreaker in ('fifo','lifo','custom')),
  -- Catálogo fechado, não expressão livre: expressão arbitrária num ORDER BY
  -- é injeção de SQL e risco de query impagável (LG-05).
  add column tiebreaker_criterion text
    check (tiebreaker_criterion is null or tiebreaker_criterion in (
      'menor_prazo_restante','maior_tempo_espera','cliente_prioritario')),
  add constraint queue_custom_needs_criterion
    check (tiebreaker <> 'custom' or tiebreaker_criterion is not null);

-- Preview de impacto: conta pelo vínculo REAL gravado em sla_tracking, não
-- re-resolvendo a precedência — é o que de fato mede aqueles tickets.
create or replace function app.fn_sla_impact_preview(p_definition_id uuid)
returns table (affected_open bigint, affected_at_risk bigint, affected_breached bigint)
language sql
stable
as $$
  select
    count(*) filter (where t.status not in ('resolved','closed')),
    count(*) filter (where t.status not in ('resolved','closed')
                       and app.sla_state(st.resolution_due_at, st.resolved_at,
                                         st.resolution_breached, tn.sla_warning_pct,
                                         tn.sla_critical_pct, st.started_at)
                           in ('warning','critical')),
    count(*) filter (where t.status not in ('resolved','closed')
                       and (st.resolution_breached
                            or (st.resolution_due_at is not null and now() > st.resolution_due_at)))
  from public.sla_tracking st
  join public.tickets t  on t.id = st.ticket_id and t.deleted_at is null
  join public.tenants tn on tn.id = st.tenant_id
  where st.sla_definition_id = p_definition_id;
$$;

-- Transferência em massa numa transação: um laço na aplicação pode falhar no
-- meio e deixar parte dos tickets movida.
create or replace function app.fn_bulk_transfer_queue(
  p_ticket_ids uuid[],
  p_queue_id   uuid,
  p_reason     text
)
returns integer
language plpgsql
as $$
declare
  v_moved integer;
begin
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Informe o motivo da transferência (mínimo 3 caracteres)'
      using errcode = 'check_violation';
  end if;

  update public.tickets
     set queue_id = p_queue_id, change_source = 'ui'
   where id = any (p_ticket_ids)
     and deleted_at is null
     and queue_id <> p_queue_id;

  get diagnostics v_moved = row_count;

  -- O motivo é intenção do usuário: a trigger de histórico registra a troca de
  -- fila, mas não conhece o porquê.
  insert into public.ticket_history
    (tenant_id, ticket_id, actor_id, field, new_value, change_source, reason)
  select t.tenant_id, t.id, app.current_user_id(),
         'queue_transfer_reason', btrim(p_reason), 'ui', btrim(p_reason)
  from public.tickets t
  where t.id = any (p_ticket_ids) and t.queue_id = p_queue_id;

  return v_moved;
end;
$$;

-- =============================================================================
-- MÓDULO 10 — Versionamento de mapeamento de integração
-- =============================================================================
alter table public.integrations
  add column polling_endpoint  text,
  add column auth_header_name  text,
  -- Rotação de credencial: guarda a REFERÊNCIA nova até o teste passar.
  -- O valor do segredo continua fora do banco (ADR-009).
  add column secret_ref_pending text,
  add column secret_rotated_at  timestamptz,
  add column last_test_at       timestamptz,
  add column last_test_ok       boolean;

create table public.integration_mapping_versions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  integration_id uuid not null,
  version        integer not null,
  -- Snapshot do CONJUNTO: um mapeamento isolado de uma versão antiga não faz
  -- sentido sem os outros, e o rollback vira uma escrita atômica.
  snapshot       jsonb not null,
  note           text,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint fk_imv_integration foreign key (integration_id, tenant_id)
    references public.integrations (id, tenant_id) on delete cascade,
  constraint uq_mapping_version unique (integration_id, version),
  constraint snapshot_is_array check (jsonb_typeof(snapshot) = 'array')
);

create index idx_mapping_versions on public.integration_mapping_versions (integration_id, version desc);

-- Versiona ANTES de aplicar a mudança, e por trigger: assim o rollback existe
-- mesmo quando alguém edita o mapeamento por SQL direto.
create or replace function app.snapshot_mapping_version()
returns trigger
language plpgsql
as $$
declare
  v_integration uuid := coalesce(new.integration_id, old.integration_id);
  v_tenant      uuid := coalesce(new.tenant_id, old.tenant_id);
  v_next        integer;
  v_snapshot    jsonb;
begin
  select coalesce(max(version), 0) + 1 into v_next
  from public.integration_mapping_versions where integration_id = v_integration;

  select coalesce(jsonb_agg(to_jsonb(m) - 'id' - 'created_at' - 'updated_at'), '[]'::jsonb)
    into v_snapshot
  from public.integration_mappings m
  where m.integration_id = v_integration;

  insert into public.integration_mapping_versions
    (tenant_id, integration_id, version, snapshot, created_by)
  values (v_tenant, v_integration, v_next, v_snapshot, app.current_user_id());

  return null;
end;
$$;

create trigger trg_mapping_version
  after insert or update or delete on public.integration_mappings
  for each row execute function app.snapshot_mapping_version();

-- =============================================================================
-- MÓDULO 11 — Geolocalização das filiais
-- =============================================================================
alter table public.branches
  add column latitude  numeric(9,6) check (latitude  is null or latitude  between -90  and 90),
  add column longitude numeric(9,6) check (longitude is null or longitude between -180 and 180),
  add column geocoded_at timestamptz,
  -- Saber a procedência da coordenada importa para poder corrigi-la.
  add column geocode_source text
    check (geocode_source is null or geocode_source in ('manual','nominatim','google','mapbox')),
  add constraint branch_geo_pair
    check ((latitude is null) = (longitude is null));

create index idx_branches_geo on public.branches (tenant_id)
  where latitude is not null and longitude is not null and deleted_at is null;

-- =============================================================================
-- Views de mapa e de análise
-- =============================================================================
-- `security_invoker = true` em todas: o mapa e os dashboards mostram
-- exclusivamente o que o usuário logado pode ver, e os totais ficam coerentes
-- com o escopo dele — não com o do tenant.

create view public.vw_map_tickets with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name,
  b.city, b.state, b.latitude, b.longitude,
  count(t.id) filter (where t.status not in ('resolved','closed'))                    as open_total,
  count(t.id) filter (where t.status in ('assigned','in_progress'))                   as in_progress_total,
  count(t.id) filter (where t.status not in ('resolved','closed') and p.weight >= 80)  as critical_total,
  count(t.id) filter (where t.status not in ('resolved','closed')
                        and (st.resolution_breached
                             or (st.resolution_due_at is not null and now() > st.resolution_due_at)))
                                                                                      as breached_total,
  case
    when count(t.id) filter (where t.status not in ('resolved','closed')
                               and (p.weight >= 80 or st.resolution_breached
                                    or (st.resolution_due_at is not null and now() > st.resolution_due_at))) > 0
      then 'red'
    when count(t.id) filter (where t.status not in ('resolved','closed')
                               and st.resolution_due_at is not null
                               and now() >= st.started_at
                                 + (st.resolution_due_at - st.started_at) * 0.75) > 0
      then 'amber'
    else 'green'
  end as marker_state
from public.branches b
left join public.tickets t on t.branch_id = b.id and t.deleted_at is null
left join public.ticket_priorities p on p.id = t.priority_id
left join public.sla_tracking st on st.ticket_id = t.id
where b.deleted_at is null
group by b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude;

create view public.vw_map_assets with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name,
  b.city, b.state, b.latitude, b.longitude,
  count(a.id)                                                       as assets_total,
  count(a.id) filter (where a.status = 'active')                     as assets_active,
  count(a.id) filter (where a.status = 'maintenance')                as assets_maintenance,
  count(a.id) filter (where a.status = 'active' and a.assigned_user_id is null)
                                                                     as assets_without_owner,
  case
    when count(a.id) filter (where a.status = 'active' and a.assigned_user_id is null) > 0 then 'red'
    when count(a.id) filter (where a.status = 'maintenance') > 0 then 'amber'
    else 'green'
  end as marker_state
from public.branches b
left join public.it_assets a on a.branch_id = b.id and a.deleted_at is null
where b.deleted_at is null
group by b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude;

create view public.vw_map_telecom with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name,
  b.city, b.state, b.latitude, b.longitude,
  count(l.id) filter (where l.status = 'active')                    as lines_active,
  count(l.id) filter (where l.status = 'suspended')                 as lines_suspended,
  count(l.id) filter (where l.status = 'cancelled')                 as lines_cancelled,
  coalesce(sum(l.monthly_cost) filter (where l.status = 'active'), 0) as monthly_cost_active,
  case
    when count(l.id) filter (where l.status = 'suspended') > 0 then 'red'
    when count(l.id) filter (where l.status = 'active' and l.assigned_user_id is null) > 0 then 'amber'
    else 'green'
  end as marker_state
from public.branches b
left join public.telecom_lines l on l.branch_id = b.id and l.deleted_at is null
where b.deleted_at is null
group by b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude;

create view public.vw_map_internet with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name,
  b.city, b.state, b.latitude, b.longitude,
  count(k.id) filter (where k.status = 'active')                              as links_active,
  count(k.id) filter (where k.status = 'active' and k.last_state = 'down')    as links_down,
  count(k.id) filter (where k.status = 'active' and k.last_state = 'unknown') as links_unmonitored,
  coalesce(sum(k.monthly_cost) filter (where k.status = 'active'), 0)          as monthly_cost_active,
  case
    when count(k.id) filter (where k.status = 'active' and k.last_state = 'down') > 0 then 'red'
    when count(k.id) filter (where k.status = 'active' and k.last_state = 'unknown') > 0 then 'amber'
    else 'green'
  end as marker_state
from public.branches b
left join public.internet_links k on k.branch_id = b.id and k.deleted_at is null
where b.deleted_at is null
group by b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude;

-- Detalhamento do popup do marcador. Tickets NÃO entram: não possuem dimensão
-- de área no modelo atual (ver LG-13 em docs/06-lacunas-e-roadmap.md).
create view public.vw_map_area_breakdown with (security_invoker = true) as
select
  ar.tenant_id, ar.branch_id, ar.id as area_id, ar.name as area_name, ar.kind, ar.sort_order,
  (select count(*) from public.it_assets a
    where a.branch_area_id = ar.id and a.deleted_at is null)          as assets_total,
  (select count(*) from public.telecom_lines l
    where l.company_area_id = ar.id and l.deleted_at is null
      and l.status = 'active')                                        as lines_active,
  (select count(*) from public.internet_links k
    where k.branch_area_id = ar.id and k.deleted_at is null
      and k.status = 'active')                                        as links_active
from public.branch_areas ar
where ar.is_active;

-- Dashboard de telefonia (módulo 6), agregado por todas as dimensões filtráveis.
create view public.vw_telecom_dashboard with (security_invoker = true) as
select
  l.tenant_id, l.branch_id, b.name as branch_name,
  l.company_area_id, ar.name as area_name,
  l.carrier, l.line_type, l.status,
  count(*)                                              as lines_count,
  coalesce(sum(l.monthly_cost), 0)                      as monthly_total,
  round(avg(l.monthly_cost), 2)                         as monthly_avg,
  count(*) filter (where l.assigned_user_id is null)    as without_user,
  count(*) filter (where l.loyalty_until is null or l.loyalty_until < current_date)
                                                        as free_to_cancel
from public.telecom_lines l
left join public.branches b     on b.id = l.branch_id
left join public.branch_areas ar on ar.id = l.company_area_id
where l.deleted_at is null
group by l.tenant_id, l.branch_id, b.name, l.company_area_id, ar.name,
         l.carrier, l.line_type, l.status;

-- Dashboard de links (módulo 8).
create view public.vw_internet_dashboard with (security_invoker = true) as
select
  k.tenant_id, k.branch_id, b.name as branch_name,
  coalesce(s.name, k.carrier_name) as carrier,
  k.technology, k.status,
  count(*)                                          as links_count,
  coalesce(sum(k.monthly_cost), 0)                  as monthly_total,
  count(*) filter (where k.last_state = 'down')     as links_down,
  count(*) filter (where k.contract_end is not null
                     and k.contract_end <= current_date + 90) as expiring_90d,
  count(*) filter (where not exists (
    select 1 from public.internet_link_attachments la
    where la.link_id = k.id and la.kind = 'contract'))        as without_contract
from public.internet_links k
left join public.branches b  on b.id = k.branch_id
left join public.suppliers s on s.id = k.supplier_id
where k.deleted_at is null
group by k.tenant_id, k.branch_id, b.name, coalesce(s.name, k.carrier_name),
         k.technology, k.status;

-- Custo de conectividade consolidado por filial: telefonia + links na mesma
-- leitura, que é o relatório pedido no escopo do módulo 8.
create view public.vw_connectivity_cost with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name, b.city, b.state,
  coalesce(tel.lines_active, 0)  as lines_active,
  coalesce(tel.lines_cost, 0)    as telecom_monthly_cost,
  coalesce(net.links_active, 0)  as links_active,
  coalesce(net.links_cost, 0)    as internet_monthly_cost,
  coalesce(tel.lines_cost, 0) + coalesce(net.links_cost, 0) as total_monthly_cost
from public.branches b
left join (
  select branch_id, count(*) as lines_active, sum(coalesce(monthly_cost,0)) as lines_cost
  from public.telecom_lines where status = 'active' and deleted_at is null group by branch_id
) tel on tel.branch_id = b.id
left join (
  select branch_id, count(*) as links_active, sum(coalesce(monthly_cost,0)) as links_cost
  from public.internet_links where status = 'active' and deleted_at is null group by branch_id
) net on net.branch_id = b.id
where b.deleted_at is null;

-- View com o nome pedido pelo escopo do módulo 4, sobre a tabela que já existe.
create view public.asset_custody_history with (security_invoker = true) as
select
  aa.id, aa.tenant_id, aa.asset_id,
  a.asset_tag, a.model, a.asset_type,
  aa.previous_user_id, pu.full_name as previous_user_name,
  aa.user_id          as current_user_id, cu.full_name as current_user_name,
  aa.previous_branch_id, aa.branch_id, aa.previous_area_id, aa.branch_area_id,
  aa.event_type, aa.reason, aa.reason_note,
  aa.performed_by, pb.full_name as performed_by_name,
  aa.started_at as changed_at
from public.asset_assignments aa
join public.it_assets a on a.id = aa.asset_id
left join public.profiles pu on pu.id = aa.previous_user_id
left join public.profiles cu on cu.id = aa.user_id
left join public.profiles pb on pb.id = aa.performed_by
where aa.event_type in ('assignment','relocation','return','retirement','loss');

-- =============================================================================
-- RLS e auditoria das tabelas novas
-- =============================================================================
select app.harden_table('public.branch_areas');
select app.harden_table('public.asset_attachments');
select app.harden_table('public.telecom_line_attachments');
select app.harden_table('public.internet_links');
select app.harden_table('public.internet_link_attachments');
select app.harden_table('public.link_availability_events');
select app.harden_table('public.integration_mapping_versions');

-- Cadastros com a mesma forma de policy dos demais: leitura para o tenant,
-- escrita para admin/gestor. Gerado em laço para não divergir uma delas.
do $$
declare
  t text;
  tables text[] := array[
    'branch_areas','asset_attachments','telecom_line_attachments',
    'internet_link_attachments','link_availability_events','integration_mapping_versions'
  ];
begin
  foreach t in array tables loop
    execute format($f$
      create policy %1$s_select on public.%1$s
        for select to authenticated using (tenant_id = app.current_tenant_id());
    $f$, t);
    execute format($f$
      create policy %1$s_write on public.%1$s
        for all to authenticated
        using (tenant_id = app.current_tenant_id() and app.can_manage_records())
        with check (tenant_id = app.current_tenant_id() and app.can_manage_records());
    $f$, t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end
$$;

-- Links seguem o escopo de filial do inventário: um atendente vê a
-- conectividade das filiais que atende, não a do tenant inteiro.
create policy internet_links_select on public.internet_links
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_see_branch(branch_id));

create policy internet_links_write on public.internet_links
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_records())
  with check (tenant_id = app.current_tenant_id() and app.can_manage_records());

grant select, insert, update, delete on public.internet_links to authenticated;

grant select on
  public.vw_map_tickets, public.vw_map_assets, public.vw_map_telecom,
  public.vw_map_internet, public.vw_map_area_breakdown,
  public.vw_telecom_dashboard, public.vw_internet_dashboard,
  public.vw_connectivity_cost, public.asset_custody_history
  to authenticated;

select app.attach_audit('public.branch_areas');
select app.attach_audit('public.internet_links');
select app.attach_audit('public.asset_attachments');
select app.attach_audit('public.telecom_line_attachments');
select app.attach_audit('public.internet_link_attachments');


-- =============================================================================
-- ARQUIVO 14 de 23: 0014_geocode_precision.sql
-- =============================================================================

-- =============================================================================
-- 0014 — Precisão de geocodificação (Módulo 11 / Google Maps)
-- =============================================================================
-- `latitude`/`longitude` e `geocode_source` vieram em 0013. O que faltava era
-- registrar QUÃO exata é a coordenada: o Google devolve isso em
-- `geometry.location_type`, e a diferença é operacionalmente relevante —
-- ROOFTOP aponta o prédio, APPROXIMATE aponta o centro da cidade. Sem guardar
-- essa distinção, uma coordenada ruim fica indistinguível de uma boa no mapa.
-- =============================================================================

alter table public.branches
  add column geocode_precision text
    check (geocode_precision is null or geocode_precision in (
      'rooftop',              -- endereço exato (ideal)
      'range_interpolated',   -- interpolado entre dois números
      'geometric_center',     -- centro do logradouro/quadra
      'approximate',          -- aproximado (bairro/cidade)
      'manual'                -- coordenada informada por pessoa
    )),
  -- Endereço normalizado devolvido pelo serviço, para o operador conferir se o
  -- geocode acertou o lugar antes de confiar no marcador.
  add column geocoded_address text,
  add column place_id text;

comment on column public.branches.geocode_precision is
  'Qualidade da coordenada. approximate = centro da cidade, não a filial.';

-- Filiais cuja coordenada não é confiável o suficiente para operação de campo.
-- Índice parcial sustenta o alerta de qualidade sem varrer a tabela.
create index idx_branches_geo_imprecise on public.branches (tenant_id)
  where deleted_at is null
    and latitude is not null
    and (geocode_precision is null or geocode_precision in ('approximate','geometric_center'));

-- Recria as views de mapa para expor a precisão e o endereço normalizado, que o
-- popup do marcador precisa mostrar.
drop view if exists public.vw_map_tickets;
create view public.vw_map_tickets with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name,
  b.city, b.state, b.latitude, b.longitude,
  b.geocode_precision, b.geocoded_address, b.place_id,
  count(t.id) filter (where t.status not in ('resolved','closed'))                   as open_total,
  count(t.id) filter (where t.status in ('assigned','in_progress'))                  as in_progress_total,
  count(t.id) filter (where t.status not in ('resolved','closed') and p.weight >= 80) as critical_total,
  count(t.id) filter (where t.status not in ('resolved','closed')
                        and (st.resolution_breached
                             or (st.resolution_due_at is not null and now() > st.resolution_due_at)))
                                                                                     as breached_total,
  case
    when count(t.id) filter (where t.status not in ('resolved','closed')
                               and (p.weight >= 80 or st.resolution_breached
                                    or (st.resolution_due_at is not null and now() > st.resolution_due_at))) > 0
      then 'red'
    when count(t.id) filter (where t.status not in ('resolved','closed')
                               and st.resolution_due_at is not null
                               and now() >= st.started_at
                                 + (st.resolution_due_at - st.started_at) * 0.75) > 0
      then 'amber'
    else 'green'
  end as marker_state
from public.branches b
left join public.tickets t on t.branch_id = b.id and t.deleted_at is null
left join public.ticket_priorities p on p.id = t.priority_id
left join public.sla_tracking st on st.ticket_id = t.id
where b.deleted_at is null
group by b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude,
         b.geocode_precision, b.geocoded_address, b.place_id;

drop view if exists public.vw_map_assets;
create view public.vw_map_assets with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name,
  b.city, b.state, b.latitude, b.longitude,
  b.geocode_precision, b.geocoded_address, b.place_id,
  count(a.id)                                        as assets_total,
  count(a.id) filter (where a.status = 'active')      as assets_active,
  count(a.id) filter (where a.status = 'maintenance') as assets_maintenance,
  count(a.id) filter (where a.status = 'active' and a.assigned_user_id is null)
                                                     as assets_without_owner,
  case
    when count(a.id) filter (where a.status = 'active' and a.assigned_user_id is null) > 0 then 'red'
    when count(a.id) filter (where a.status = 'maintenance') > 0 then 'amber'
    else 'green'
  end as marker_state
from public.branches b
left join public.it_assets a on a.branch_id = b.id and a.deleted_at is null
where b.deleted_at is null
group by b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude,
         b.geocode_precision, b.geocoded_address, b.place_id;

drop view if exists public.vw_map_telecom;
create view public.vw_map_telecom with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name,
  b.city, b.state, b.latitude, b.longitude,
  b.geocode_precision, b.geocoded_address, b.place_id,
  count(l.id) filter (where l.status = 'active')                     as lines_active,
  count(l.id) filter (where l.status = 'suspended')                  as lines_suspended,
  count(l.id) filter (where l.status = 'cancelled')                  as lines_cancelled,
  coalesce(sum(l.monthly_cost) filter (where l.status = 'active'), 0) as monthly_cost_active,
  case
    when count(l.id) filter (where l.status = 'suspended') > 0 then 'red'
    when count(l.id) filter (where l.status = 'active' and l.assigned_user_id is null) > 0 then 'amber'
    else 'green'
  end as marker_state
from public.branches b
left join public.telecom_lines l on l.branch_id = b.id and l.deleted_at is null
where b.deleted_at is null
group by b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude,
         b.geocode_precision, b.geocoded_address, b.place_id;

drop view if exists public.vw_map_internet;
create view public.vw_map_internet with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name,
  b.city, b.state, b.latitude, b.longitude,
  b.geocode_precision, b.geocoded_address, b.place_id,
  count(k.id) filter (where k.status = 'active')                              as links_active,
  count(k.id) filter (where k.status = 'active' and k.last_state = 'down')    as links_down,
  count(k.id) filter (where k.status = 'active' and k.last_state = 'unknown') as links_unmonitored,
  coalesce(sum(k.monthly_cost) filter (where k.status = 'active'), 0)          as monthly_cost_active,
  case
    when count(k.id) filter (where k.status = 'active' and k.last_state = 'down') > 0 then 'red'
    when count(k.id) filter (where k.status = 'active' and k.last_state = 'unknown') > 0 then 'amber'
    else 'green'
  end as marker_state
from public.branches b
left join public.internet_links k on k.branch_id = b.id and k.deleted_at is null
where b.deleted_at is null
group by b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude,
         b.geocode_precision, b.geocoded_address, b.place_id;

grant select on public.vw_map_tickets, public.vw_map_assets,
                public.vw_map_telecom, public.vw_map_internet to authenticated;


-- =============================================================================
-- ARQUIVO 15 de 23: 0015_endereco_estruturado.sql
-- =============================================================================

-- =============================================================================
-- 0015 — Endereço estruturado e rastro da geolocalização
--
-- A geolocalização passa a partir do endereço CADASTRADO, não de coordenada
-- digitada: logradouro, número, bairro e CEP são obrigatórios para geocodificar.
-- O banco guarda três coisas que a aplicação sozinha não garantiria:
--
--   1. o formato do CEP (CHECK) — lixo de digitação não entra;
--   2. se o endereço está completo (coluna gerada) — a mesma regra vale para UI,
--      API e integração, que é o motivo de ela não morar só no formulário;
--   3. se a coordenada continua valendo para o endereço atual (trigger) — mudar
--      o logradouro e manter o pino antigo é o defeito silencioso clássico
--      deste módulo.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Endereço estruturado
-- -----------------------------------------------------------------------------
alter table public.branches
  add column if not exists street             text,
  add column if not exists street_number      text,
  add column if not exists address_complement text,
  -- Status do último fluxo de geocodificação. Os valores são os mesmos códigos
  -- de exceção da aplicação (src/lib/address.ts): um vocabulário só evita que a
  -- tela diga uma coisa e o log outra.
  add column if not exists geocode_status     text not null default 'pending',
  -- Coordenada existe, mas o endereço mudou depois dela.
  add column if not exists geocode_stale      boolean not null default false,
  add column if not exists geocode_verified_at timestamptz,
  add column if not exists geocode_provider   text;

alter table public.branches
  drop constraint if exists branches_geocode_status_check;
alter table public.branches
  add constraint branches_geocode_status_check check (geocode_status in (
    'pending',              -- nunca geocodificado, ou endereço alterado desde então
    'ok',                   -- rooftop
    'low_precision',        -- renderiza, com aviso
    'missing_fields',       -- [CAMPO AUSENTE]
    'inconsistent',         -- [INCONSISTÊNCIA DE ENDEREÇO]
    'multiple',             -- [MÚLTIPLAS CORRESPONDÊNCIAS] — aguarda o operador
    'not_found',            -- [ENDEREÇO NÃO ENCONTRADO]
    'service_unavailable'   -- [SERVIÇO INDISPONÍVEL]
  ));

-- CEP normalizado. Aceitar "01310200" e "01310-200" na mesma coluna espalharia
-- a normalização por todo lugar que compara CEP.
alter table public.branches
  drop constraint if exists branches_postal_code_format;
alter table public.branches
  add constraint branches_postal_code_format
  check (postal_code is null or postal_code ~ '^[0-9]{5}-[0-9]{3}$');

-- Endereço completo = os quatro campos exigidos para geocodificar.
-- Coluna gerada, não view: assim a regra vale também para quem escreve por SQL.
alter table public.branches
  add column if not exists address_complete boolean
  generated always as (
    street is not null and btrim(street) <> ''
    and street_number is not null and btrim(street_number) <> ''
    and district is not null and btrim(district) <> ''
    and postal_code is not null and btrim(postal_code) <> ''
  ) stored;

comment on column public.branches.address_complete is
  'Os quatro campos obrigatórios para geocodificar estão preenchidos.';
comment on column public.branches.geocode_stale is
  'A coordenada é anterior à última alteração de endereço — precisa refazer o fluxo.';

-- -----------------------------------------------------------------------------
-- Endereço formatado em uma linha
--
-- Função em vez de coluna gerada porque `concat_ws` não é IMMUTABLE e o Postgres
-- recusa a expressão em GENERATED. Uma função também deixa as views e a
-- aplicação com a mesma formatação.
-- -----------------------------------------------------------------------------
create or replace function public.fn_format_address(
  p_street text, p_number text, p_complement text,
  p_district text, p_city text, p_state text, p_postal text
) returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(
    concat_ws(', ',
      nullif(concat_ws(' - ',
        nullif(concat_ws(', ', nullif(btrim(p_street), ''), nullif(btrim(p_number), '')), ''),
        nullif(btrim(p_complement), '')
      ), ''),
      nullif(btrim(p_district), ''),
      nullif(concat_ws('/', nullif(btrim(p_city), ''), nullif(upper(btrim(p_state)), '')), ''),
      nullif(btrim(p_postal), '')
    ), '');
$$;

grant execute on function public.fn_format_address(text, text, text, text, text, text, text)
  to authenticated, anon, service_role;

-- -----------------------------------------------------------------------------
-- Coordenada desatualizada em relação ao endereço
--
-- Regra: se um campo de endereço mudou e a coordenada NÃO mudou no mesmo UPDATE,
-- a coordenada ficou velha. Quando o geocodificador grava endereço e coordenada
-- juntos, a condição não dispara — é o mesmo statement.
-- -----------------------------------------------------------------------------
create or replace function app.branches_geocode_staleness()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_address_changed boolean;
  v_coords_changed  boolean;
begin
  v_address_changed :=
       coalesce(new.street, '')             is distinct from coalesce(old.street, '')
    or coalesce(new.street_number, '')      is distinct from coalesce(old.street_number, '')
    or coalesce(new.district, '')           is distinct from coalesce(old.district, '')
    or coalesce(new.postal_code, '')        is distinct from coalesce(old.postal_code, '')
    or coalesce(new.city, '')               is distinct from coalesce(old.city, '')
    or coalesce(new.state, '')              is distinct from coalesce(old.state, '');

  v_coords_changed :=
       new.latitude  is distinct from old.latitude
    or new.longitude is distinct from old.longitude;

  if v_address_changed and not v_coords_changed then
    new.geocode_stale  := (new.latitude is not null);
    new.geocode_status := 'pending';
  elsif v_coords_changed then
    new.geocode_stale := false;
    if new.latitude is not null then
      new.geocode_verified_at := clock_timestamp();
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_branches_geocode_staleness on public.branches;
create trigger trg_branches_geocode_staleness
  before update on public.branches
  for each row execute function app.branches_geocode_staleness();

-- -----------------------------------------------------------------------------
-- Log de geocodificação
--
-- Append-only: é o rastro de quem geolocalizou o quê, com qual serviço, e qual
-- precisão saiu. Sem UPDATE nem DELETE para authenticated — um log editável não
-- serve para auditar decisão de despacho de equipe.
-- -----------------------------------------------------------------------------
create table if not exists public.geocode_logs (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  branch_id         uuid not null,
  requested_by      uuid references public.profiles(id) on delete set null,
  -- Endereço submetido, como estava no cadastro naquele instante.
  input_address     jsonb not null,
  status            text not null,
  provider          text,
  latitude          numeric(10, 7),
  longitude         numeric(10, 7),
  formatted_address text,
  precision         text,
  -- Candidatos devolvidos, quando houve mais de um.
  candidates        jsonb not null default '[]'::jsonb,
  message           text,
  -- Bloco de saída técnica exatamente como foi exibido ao operador. Guardar o
  -- texto renderizado, e não só os campos, é o que permite auditar depois o que
  -- a pessoa leu na hora de decidir — reconstruir o bloco anos depois, com
  -- outra versão do formatador, produziria um texto diferente.
  report_text       text,
  created_at        timestamptz not null default clock_timestamp(),
  constraint fk_geocode_logs_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete cascade,
  constraint geocode_logs_status_check check (status in (
    'ok','low_precision','missing_fields','inconsistent','multiple',
    'not_found','service_unavailable'
  )),
  constraint geocode_logs_precision_check check (precision is null or precision in (
    'rooftop','range_interpolated','geometric_center','approximate','manual'
  ))
);

create index if not exists idx_geocode_logs_branch
  on public.geocode_logs (tenant_id, branch_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Candidatos aguardando confirmação do operador
--
-- [MÚLTIPLAS CORRESPONDÊNCIAS] não pode virar escolha automática: condomínio e
-- galeria compartilham CEP, e chutar o primeiro resultado manda o técnico para
-- o bloco errado. Os candidatos ficam aqui até alguém confirmar.
-- -----------------------------------------------------------------------------
create table if not exists public.geocode_candidates (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  branch_id         uuid not null,
  ordinal           smallint not null,
  latitude          numeric(10, 7) not null,
  longitude         numeric(10, 7) not null,
  formatted_address text not null,
  precision         text not null,
  place_id          text,
  created_at        timestamptz not null default now(),
  constraint fk_geocode_candidates_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete cascade,
  constraint uq_geocode_candidates unique (branch_id, ordinal),
  constraint geocode_candidates_precision_check check (precision in (
    'rooftop','range_interpolated','geometric_center','approximate','manual'
  )),
  constraint geocode_candidates_lat_check check (latitude between -90 and 90),
  constraint geocode_candidates_lng_check check (longitude between -180 and 180)
);

create index if not exists idx_geocode_candidates_branch
  on public.geocode_candidates (tenant_id, branch_id, ordinal);

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
select app.harden_table('public.geocode_logs');
select app.harden_table('public.geocode_candidates');

drop policy if exists geocode_logs_select on public.geocode_logs;
create policy geocode_logs_select on public.geocode_logs
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_see_branch(branch_id));

drop policy if exists geocode_logs_insert on public.geocode_logs;
create policy geocode_logs_insert on public.geocode_logs
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.can_manage_records());

drop policy if exists geocode_candidates_select on public.geocode_candidates;
create policy geocode_candidates_select on public.geocode_candidates
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_see_branch(branch_id));

drop policy if exists geocode_candidates_write on public.geocode_candidates;
create policy geocode_candidates_write on public.geocode_candidates
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_records())
  with check (tenant_id = app.current_tenant_id() and app.can_manage_records());

grant select, insert on public.geocode_logs to authenticated;
grant select, insert, update, delete on public.geocode_candidates to authenticated;

-- -----------------------------------------------------------------------------
-- Views do mapa: endereço formatado e estado da geolocalização
--
-- O popup do mapa precisa dizer QUAL endereço aquele pino representa e o quanto
-- ele é confiável. Sem isso, um ponto aproximado parece igual a um exato.
-- -----------------------------------------------------------------------------
drop view if exists public.vw_map_tickets;
create view public.vw_map_tickets with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name,
  b.city, b.state, b.latitude, b.longitude,
  b.geocode_precision, b.geocoded_address, b.place_id,
  b.geocode_status, b.geocode_stale, b.address_complete,
  public.fn_format_address(b.street, b.street_number, b.address_complement,
                           b.district, b.city, b.state, b.postal_code) as address_formatted,
  count(t.id) filter (where t.status not in ('resolved','closed'))                   as open_total,
  count(t.id) filter (where t.status in ('assigned','in_progress'))                  as in_progress_total,
  count(t.id) filter (where t.status not in ('resolved','closed') and p.weight >= 80) as critical_total,
  count(t.id) filter (where t.status not in ('resolved','closed')
                        and (st.resolution_breached
                             or (st.resolution_due_at is not null and now() > st.resolution_due_at)))
                                                                                     as breached_total,
  case
    when count(t.id) filter (where t.status not in ('resolved','closed')
                               and (p.weight >= 80 or st.resolution_breached
                                    or (st.resolution_due_at is not null and now() > st.resolution_due_at))) > 0
      then 'red'
    when count(t.id) filter (where t.status not in ('resolved','closed')
                               and st.resolution_due_at is not null
                               and now() >= st.started_at
                                 + (st.resolution_due_at - st.started_at) * 0.75) > 0
      then 'amber'
    else 'green'
  end as marker_state
from public.branches b
left join public.tickets t on t.branch_id = b.id and t.deleted_at is null
left join public.ticket_priorities p on p.id = t.priority_id
left join public.sla_tracking st on st.ticket_id = t.id
where b.deleted_at is null
group by b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude,
         b.geocode_precision, b.geocoded_address, b.place_id,
         b.geocode_status, b.geocode_stale, b.address_complete,
         b.street, b.street_number, b.address_complement, b.district, b.postal_code;

drop view if exists public.vw_map_assets;
create view public.vw_map_assets with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name,
  b.city, b.state, b.latitude, b.longitude,
  b.geocode_precision, b.geocoded_address, b.place_id,
  b.geocode_status, b.geocode_stale, b.address_complete,
  public.fn_format_address(b.street, b.street_number, b.address_complement,
                           b.district, b.city, b.state, b.postal_code) as address_formatted,
  count(a.id)                                        as assets_total,
  count(a.id) filter (where a.status = 'active')      as assets_active,
  count(a.id) filter (where a.status = 'maintenance') as assets_maintenance,
  count(a.id) filter (where a.status = 'active' and a.assigned_user_id is null)
                                                     as assets_without_owner,
  case
    when count(a.id) filter (where a.status = 'active' and a.assigned_user_id is null) > 0 then 'red'
    when count(a.id) filter (where a.status = 'maintenance') > 0 then 'amber'
    else 'green'
  end as marker_state
from public.branches b
left join public.it_assets a on a.branch_id = b.id and a.deleted_at is null
where b.deleted_at is null
group by b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude,
         b.geocode_precision, b.geocoded_address, b.place_id,
         b.geocode_status, b.geocode_stale, b.address_complete,
         b.street, b.street_number, b.address_complement, b.district, b.postal_code;

drop view if exists public.vw_map_telecom;
create view public.vw_map_telecom with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name,
  b.city, b.state, b.latitude, b.longitude,
  b.geocode_precision, b.geocoded_address, b.place_id,
  b.geocode_status, b.geocode_stale, b.address_complete,
  public.fn_format_address(b.street, b.street_number, b.address_complement,
                           b.district, b.city, b.state, b.postal_code) as address_formatted,
  count(l.id) filter (where l.status = 'active')                     as lines_active,
  count(l.id) filter (where l.status = 'suspended')                  as lines_suspended,
  count(l.id) filter (where l.status = 'cancelled')                  as lines_cancelled,
  coalesce(sum(l.monthly_cost) filter (where l.status = 'active'), 0) as monthly_cost_active,
  case
    when count(l.id) filter (where l.status = 'suspended') > 0 then 'red'
    when count(l.id) filter (where l.status = 'active' and l.assigned_user_id is null) > 0 then 'amber'
    else 'green'
  end as marker_state
from public.branches b
left join public.telecom_lines l on l.branch_id = b.id and l.deleted_at is null
where b.deleted_at is null
group by b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude,
         b.geocode_precision, b.geocoded_address, b.place_id,
         b.geocode_status, b.geocode_stale, b.address_complete,
         b.street, b.street_number, b.address_complement, b.district, b.postal_code;

drop view if exists public.vw_map_internet;
create view public.vw_map_internet with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name,
  b.city, b.state, b.latitude, b.longitude,
  b.geocode_precision, b.geocoded_address, b.place_id,
  b.geocode_status, b.geocode_stale, b.address_complete,
  public.fn_format_address(b.street, b.street_number, b.address_complement,
                           b.district, b.city, b.state, b.postal_code) as address_formatted,
  count(k.id) filter (where k.status = 'active')                              as links_active,
  count(k.id) filter (where k.status = 'active' and k.last_state = 'down')    as links_down,
  count(k.id) filter (where k.status = 'active' and k.last_state = 'unknown') as links_unmonitored,
  coalesce(sum(k.monthly_cost) filter (where k.status = 'active'), 0)          as monthly_cost_active,
  case
    when count(k.id) filter (where k.status = 'active' and k.last_state = 'down') > 0 then 'red'
    when count(k.id) filter (where k.status = 'active' and k.last_state = 'unknown') > 0 then 'amber'
    else 'green'
  end as marker_state
from public.branches b
left join public.internet_links k on k.branch_id = b.id and k.deleted_at is null
where b.deleted_at is null
group by b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude,
         b.geocode_precision, b.geocoded_address, b.place_id,
         b.geocode_status, b.geocode_stale, b.address_complete,
         b.street, b.street_number, b.address_complement, b.district, b.postal_code;

-- Endereço e pendências de geolocalização, para a tela de cadastro.
drop view if exists public.vw_branch_addresses;
create view public.vw_branch_addresses with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name, b.client_id,
  coalesce(c.trade_name, c.legal_name) as client_name,
  b.street, b.street_number, b.address_complement, b.district,
  b.city, b.state, b.postal_code,
  public.fn_format_address(b.street, b.street_number, b.address_complement,
                           b.district, b.city, b.state, b.postal_code) as address_formatted,
  b.address_complete, b.latitude, b.longitude, b.geocode_precision,
  b.geocoded_address, b.place_id, b.geocode_status, b.geocode_stale,
  b.geocode_verified_at, b.geocode_provider,
  (select count(*) from public.geocode_candidates gc where gc.branch_id = b.id) as pending_candidates,
  (select l.message from public.geocode_logs l
    where l.branch_id = b.id order by l.created_at desc limit 1)                as last_message,
  (select l.created_at from public.geocode_logs l
    where l.branch_id = b.id order by l.created_at desc limit 1)                as last_attempt_at
from public.branches b
join public.clients c on c.id = b.client_id
where b.deleted_at is null;

grant select on public.vw_map_tickets, public.vw_map_assets,
                public.vw_map_telecom, public.vw_map_internet,
                public.vw_branch_addresses to authenticated;


-- =============================================================================
-- ARQUIVO 16 de 23: 0016_ultimo_log_geocode.sql
-- =============================================================================

-- =============================================================================
-- 0016 — Último log de geocodificação por filial
--
-- A tela de mapas buscava os 200 logs mais recentes do TENANT inteiro e
-- deduplicava por filial em memória. Com um parque grande (muitas filiais,
-- várias tentativas cada), o log mais recente de uma filial pouco
-- geocodificada cai fora dos 200 e a tela conclui "nunca tentamos" quando na
-- verdade há histórico — só que mais antigo que o corte. Uma view com
-- `distinct on` resolve por construção, sem depender de nenhum limite.
-- =============================================================================

drop view if exists public.vw_branch_last_geocode_log;
create view public.vw_branch_last_geocode_log with (security_invoker = true) as
select distinct on (branch_id)
  tenant_id, branch_id, status, report_text, message, created_at
from public.geocode_logs
order by branch_id, created_at desc;

grant select on public.vw_branch_last_geocode_log to authenticated;


-- =============================================================================
-- ARQUIVO 17 de 23: 0017_perfis_e_permissoes.sql
-- =============================================================================

-- =============================================================================
-- 0017 — Perfis de acesso e permissões granulares (módulo → tela → ação)
-- =============================================================================
-- Até aqui a autorização tinha um único eixo: `profiles.role`, com seis valores
-- fixos. Isso resolve "quem administra" e não resolve "quem aprova pagamento mas
-- não cadastra fornecedor" — que é exatamente a pergunta que o módulo financeiro
-- faz.
--
-- Esta migração acrescenta um segundo eixo SEM remover o primeiro:
--
--   * `profiles.role` continua governando as policies de RLS. Nenhuma das 118
--     policies existentes é reescrita.
--   * `access_profiles.base_role` é o TETO de RLS do perfil, e
--     `app.effective_base_role()` devolve o MENOR entre o papel do usuário e o
--     teto do perfil. Um perfil, portanto, só sabe restringir — nunca elevar.
--   * `permission_grants` refina dentro desse teto, na granularidade de ação.
--
-- Depois do backfill no fim do arquivo, todo usuário existente fica com um
-- perfil cujo `base_role` é igual ao seu papel atual. O comportamento observável
-- é idêntico ao de antes desta migração; a granularidade só passa a valer quando
-- alguém atribui um perfil mais restrito.

-- -----------------------------------------------------------------------------
-- Ordem de privilégio dos papéis
-- -----------------------------------------------------------------------------
-- Comparar papel por texto exigiria repetir a lista em cada CASE. Um rank
-- numérico deixa "menor privilégio" ser uma comparação, que é o que
-- `effective_base_role` precisa.
create or replace function app.role_rank(p_role text)
returns integer
language sql
immutable
as $$
  select case p_role
    when 'visualizador' then 0
    when 'solicitante'  then 1
    when 'atendente'    then 2
    when 'gestor'       then 3
    when 'admin'        then 4
    when 'super_admin'  then 5
    else -1                          -- papel desconhecido nunca alcança nada
  end;
$$;

comment on function app.role_rank(text) is
  'Ordem de privilégio dos papéis. Só para comparar teto — não autoriza nada.';

-- -----------------------------------------------------------------------------
-- permission_catalog — a superfície da APLICAÇÃO, não do cliente
-- -----------------------------------------------------------------------------
-- Sem `tenant_id` de propósito: as telas e ações que existem são as mesmas para
-- todo assinante. O que varia por tenant é quem recebe cada uma, e isso mora em
-- `permission_grants`.
--
-- Espelha `src/lib/permissions.ts`. A duplicação é intencional e verificada por
-- teste: o banco precisa da lista para validar grant, e a aplicação precisa dela
-- para montar a matriz sem uma ida ao banco por checkbox.
create table public.permission_catalog (
  key           text primary key,
  module        text not null,
  screen        text,
  action        text,
  label         text not null,
  min_base_role text not null
                  check (min_base_role in ('super_admin','admin','gestor','atendente','solicitante','visualizador')),
  sort_order    integer not null default 0,
  -- A chave é derivada da trinca. Gravar as duas coisas e deixá-las divergir
  -- quebraria a montagem da árvore na tela de perfis.
  constraint permission_catalog_key_matches_parts check (
    key = concat_ws('.', module, screen, action)
  ),
  -- Ação sem tela seria uma chave de dois níveis com semântica de três.
  constraint permission_catalog_action_needs_screen check (
    action is null or screen is not null
  )
);

create index idx_permission_catalog_module on public.permission_catalog (module, sort_order);

comment on table public.permission_catalog is
  'Catálogo global de permissões (modulo/tela/acao). Semeado por migração, somente leitura pela API.';

-- -----------------------------------------------------------------------------
-- access_profiles — perfis de acesso, por tenant
-- -----------------------------------------------------------------------------
create table public.access_profiles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  description text,
  -- Teto de RLS. Um perfil de base `atendente` não consegue exercer permissão
  -- de `gestor` nem se o grant existir — o RLS barra antes.
  base_role   text not null
                check (base_role in ('admin','gestor','atendente','solicitante','visualizador')),
  -- Perfis de sistema são atribuíveis mas não editáveis. `system_key` identifica
  -- cada um de forma estável: o nome é exibição e poderia ser traduzido.
  is_system   boolean not null default false,
  system_key  text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint uq_access_profiles_id_tenant unique (id, tenant_id),
  constraint access_profiles_system_key_required check (
    (is_system and system_key is not null) or (not is_system and system_key is null)
  )
);

create unique index uq_access_profiles_name on public.access_profiles (tenant_id, lower(name));
create unique index uq_access_profiles_system_key on public.access_profiles (tenant_id, system_key)
  where system_key is not null;
create index idx_access_profiles_tenant on public.access_profiles (tenant_id) where is_active;

comment on table public.access_profiles is
  'Perfis de acesso por tenant. base_role é o teto de RLS; permission_grants refina dentro dele.';

-- -----------------------------------------------------------------------------
-- permission_grants — presença da linha É a concessão
-- -----------------------------------------------------------------------------
-- Não existe coluna `allowed boolean`. Com "liberação explícita", uma linha
-- `allowed = false` significaria a mesma coisa que a ausência da linha, e as
-- duas representações do mesmo fato acabariam divergindo — sobrando linha falsa
-- que ninguém limpa e que confunde a leitura da matriz.
create table public.permission_grants (
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  profile_id     uuid not null,
  permission_key text not null references public.permission_catalog(key) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (profile_id, permission_key),
  constraint fk_grant_profile foreign key (profile_id, tenant_id)
    references public.access_profiles (id, tenant_id) on delete cascade
);

create index idx_permission_grants_tenant on public.permission_grants (tenant_id, permission_key);

comment on table public.permission_grants is
  'Concessões por perfil. A presença da linha concede; a ausência nega.';

-- -----------------------------------------------------------------------------
-- profiles.access_profile_id
-- -----------------------------------------------------------------------------
-- Nullable porque a coluna nasce vazia e é preenchida no backfill no fim deste
-- arquivo. FK composta (id, tenant_id) para o perfil nunca atravessar tenant —
-- o padrão do ADR-001.
alter table public.profiles
  add column access_profile_id uuid,
  add constraint fk_profiles_access_profile foreign key (access_profile_id, tenant_id)
    references public.access_profiles (id, tenant_id) on delete set null;

create index idx_profiles_access_profile on public.profiles (access_profile_id)
  where access_profile_id is not null;

-- -----------------------------------------------------------------------------
-- Funções de autorização
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER pelo mesmo motivo de `app.current_role()` (0002_core.sql:162):
-- ler `profiles` de dentro de uma policy de `profiles` recursaria.
create or replace function app.current_access_profile_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.access_profile_id from public.profiles p where p.id = app.current_user_id();
$$;

/**
 * Papel efetivo: o MENOR entre o papel do usuário e o teto do perfil.
 *
 * É o que garante que atribuir um perfil só restrinja. Sem o `least`, um perfil
 * de base `admin` dado a um `atendente` promoveria a pessoa sem passar pela
 * trigger de escalonamento.
 */
create or replace function app.effective_base_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when ap.base_role is null then p.role
    when app.role_rank(ap.base_role) < app.role_rank(p.role) then ap.base_role
    else p.role
  end
  from public.profiles p
  left join public.access_profiles ap
    on ap.id = p.access_profile_id and ap.is_active
  where p.id = app.current_user_id();
$$;

comment on function app.effective_base_role() is
  'Menor entre profiles.role e access_profiles.base_role. Perfil só restringe, nunca eleva.';

/**
 * A sessão tem esta permissão?
 *
 * Exige o grant da chave E de cada ancestral dela — é a herança de negação.
 * Um grant de ação que sobreviveu a uma despromoção, sem o grant do módulo, não
 * vale nada; é o caso que a versão "só olha a própria chave" deixaria passar.
 *
 * Usuário sem perfil atribuído devolve false. Depois do backfill isso só
 * acontece com linha nova ainda não configurada, e negar é a falha segura.
 */
create or replace function app.has_permission(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with wanted as (
    select array_to_string((string_to_array(p_key, '.'))[1:i], '.') as key
    from generate_subscripts(string_to_array(p_key, '.'), 1) as i
  )
  select app.current_access_profile_id() is not null
     and not exists (
       select 1 from wanted w
       where not exists (
         select 1 from public.permission_grants g
         where g.profile_id = app.current_access_profile_id()
           and g.permission_key = w.key
       )
     );
$$;

comment on function app.has_permission(text) is
  'Herança de negação: exige grant da chave e de todos os ancestrais dela.';

-- -----------------------------------------------------------------------------
-- Os três predicados de escrita passam a respeitar o teto do perfil
-- -----------------------------------------------------------------------------
-- `create or replace` do corpo: as policies referenciam a função pelo nome, e
-- portanto todas as 118 passam a considerar o perfil de uma só vez. Como o
-- backfill deixa base_role = role para todo mundo, o resultado imediato é
-- idêntico ao de hoje.
create or replace function app.can_manage_config()
returns boolean
language sql
stable
as $$
  select app.effective_base_role() in ('super_admin','admin');
$$;

create or replace function app.can_manage_records()
returns boolean
language sql
stable
as $$
  select app.effective_base_role() in ('super_admin','admin','gestor');
$$;

create or replace function app.can_work_tickets()
returns boolean
language sql
stable
as $$
  select app.effective_base_role() in ('super_admin','admin','gestor','atendente');
$$;

-- -----------------------------------------------------------------------------
-- Guardas de integridade do próprio sistema de permissões
-- -----------------------------------------------------------------------------
/**
 * Impede três formas de furar a autorização por dentro:
 *
 *   1. trocar o PRÓPRIO perfil de acesso (auto-promoção pela porta de trás,
 *      já que a trigger de 0012 só olha `role` e `tenant_id`);
 *   2. editar um perfil de sistema, que é contrato da plataforma;
 *   3. rebaixar `base_role` de perfil de sistema.
 */
create or replace function app.guard_access_profile_assignment()
returns trigger
language plpgsql
as $$
begin
  if app.is_service_role() or app.current_user_id() is null then
    return new;                                    -- provisionamento pelo backend
  end if;

  if new.access_profile_id is distinct from old.access_profile_id
     and new.id = app.current_user_id() then
    raise exception 'Você não pode alterar o seu próprio perfil de acesso'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger trg_profiles_no_self_profile_change
  before update of access_profile_id on public.profiles
  for each row execute function app.guard_access_profile_assignment();

create or replace function app.guard_system_profile()
returns trigger
language plpgsql
as $$
begin
  if app.is_service_role() or app.current_user_id() is null then
    return coalesce(new, old);
  end if;

  if coalesce(old.is_system, false) then
    if tg_op = 'DELETE' then
      raise exception 'Perfil de sistema não pode ser excluído'
        using errcode = 'insufficient_privilege';
    end if;
    -- Ativar/inativar é permitido; o resto do perfil é contrato da plataforma.
    if new.name is distinct from old.name
       or new.base_role is distinct from old.base_role
       or new.system_key is distinct from old.system_key
       or new.is_system is distinct from old.is_system then
      raise exception 'Perfil de sistema só aceita mudança de situação (ativo/inativo)'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

create trigger trg_access_profiles_guard_system
  before update or delete on public.access_profiles
  for each row execute function app.guard_system_profile();

/**
 * Recusa grant que o `base_role` do perfil não alcança.
 *
 * Sem isto a matriz aceitaria conceder `usuarios.perfis.editar` a um perfil de
 * base `gestor`: o checkbox ficaria marcado, o RLS negaria a operação, e o
 * administrador não teria nenhuma pista de por que o botão não funciona.
 */
create or replace function app.guard_grant_within_base_role()
returns trigger
language plpgsql
as $$
declare
  v_base text;
  v_min  text;
begin
  select base_role into v_base from public.access_profiles where id = new.profile_id;
  select min_base_role into v_min from public.permission_catalog where key = new.permission_key;

  if v_base is null or v_min is null then
    return new;                                    -- FK cuida da inexistência
  end if;

  if app.role_rank(v_min) > app.role_rank(v_base) then
    raise exception 'A permissão % exige papel base % — o perfil tem %',
      new.permission_key, v_min, v_base
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger trg_permission_grants_within_base_role
  before insert or update on public.permission_grants
  for each row execute function app.guard_grant_within_base_role();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
select app.harden_table('public.permission_catalog');
select app.harden_table('public.access_profiles');
select app.harden_table('public.permission_grants');

select app.attach_audit('public.access_profiles');
select app.attach_audit('public.permission_grants');

-- Catálogo é público para quem está autenticado: a aplicação precisa dele para
-- montar a matriz, e ele não contém dado de nenhum tenant. Sem policy de
-- escrita — só a migração semeia.
create policy permission_catalog_select on public.permission_catalog
  for select to authenticated
  using (true);

grant select on public.permission_catalog to authenticated;

-- Perfis: legíveis por todo o tenant (o formulário de usuário precisa listar),
-- graváveis só por quem administra configuração.
create policy access_profiles_select on public.access_profiles
  for select to authenticated
  using (tenant_id = app.current_tenant_id());

create policy access_profiles_insert on public.access_profiles
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.can_manage_config());

create policy access_profiles_update on public.access_profiles
  for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_config())
  with check (tenant_id = app.current_tenant_id());

create policy access_profiles_delete on public.access_profiles
  for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_config());

grant select, insert, update, delete on public.access_profiles to authenticated;

create policy permission_grants_select on public.permission_grants
  for select to authenticated
  using (tenant_id = app.current_tenant_id());

create policy permission_grants_insert on public.permission_grants
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.can_manage_config());

create policy permission_grants_delete on public.permission_grants
  for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_config());

grant select, insert, delete on public.permission_grants to authenticated;

-- -----------------------------------------------------------------------------
-- Semente do catálogo
-- -----------------------------------------------------------------------------
-- GERADO a partir de `PERMISSION_CATALOG` em `src/lib/permissions.ts`. Editar
-- aqui à mão faz o banco divergir da aplicação; edite o TypeScript e regenere.
-- `supabase/tests/schema_test.sql` compara a contagem, então a divergência
-- derruba o CI em vez de virar permissão fantasma.
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('helpdesk', 'helpdesk', null, null, 'Helpdesk', 'visualizador', 10),
  ('helpdesk.painel', 'helpdesk', 'painel', null, 'Painel operacional', 'visualizador', 20),
  ('helpdesk.painel.ver', 'helpdesk', 'painel', 'ver', 'Abrir o painel', 'visualizador', 30),
  ('helpdesk.tickets', 'helpdesk', 'tickets', null, 'Tickets', 'visualizador', 40),
  ('helpdesk.tickets.ver', 'helpdesk', 'tickets', 'ver', 'Consultar tickets', 'visualizador', 50),
  ('helpdesk.tickets.criar', 'helpdesk', 'tickets', 'criar', 'Abrir ticket', 'solicitante', 60),
  ('helpdesk.tickets.comentar', 'helpdesk', 'tickets', 'comentar', 'Comentar (público)', 'solicitante', 70),
  ('helpdesk.tickets.comentar_interno', 'helpdesk', 'tickets', 'comentar_interno', 'Comentar (interno)', 'atendente', 80),
  ('helpdesk.tickets.mudar_status', 'helpdesk', 'tickets', 'mudar_status', 'Mover status', 'atendente', 90),
  ('helpdesk.tickets.atribuir', 'helpdesk', 'tickets', 'atribuir', 'Atribuir atendente', 'atendente', 100),
  ('helpdesk.tickets.transferir', 'helpdesk', 'tickets', 'transferir', 'Transferir de fila', 'atendente', 110),
  ('helpdesk.filas', 'helpdesk', 'filas', null, 'Filas', 'visualizador', 120),
  ('helpdesk.filas.ver', 'helpdesk', 'filas', 'ver', 'Consultar filas', 'visualizador', 130),
  ('sla', 'sla', null, null, 'SLA e filas', 'gestor', 140),
  ('sla.compliance', 'sla', 'compliance', null, 'Compliance de SLA', 'gestor', 150),
  ('sla.compliance.ver', 'sla', 'compliance', 'ver', 'Ver compliance', 'gestor', 160),
  ('sla.definicoes', 'sla', 'definicoes', null, 'Definições de SLA', 'gestor', 170),
  ('sla.definicoes.ver', 'sla', 'definicoes', 'ver', 'Consultar definições', 'gestor', 180),
  ('sla.definicoes.criar', 'sla', 'definicoes', 'criar', 'Criar definição', 'gestor', 190),
  ('sla.definicoes.editar', 'sla', 'definicoes', 'editar', 'Editar definição', 'gestor', 200),
  ('sla.definicoes.inativar', 'sla', 'definicoes', 'inativar', 'Ativar/inativar definição', 'gestor', 210),
  ('sla.contratos', 'sla', 'contratos', null, 'Contratos de SLA', 'gestor', 220),
  ('sla.contratos.ver', 'sla', 'contratos', 'ver', 'Consultar contratos de SLA', 'gestor', 230),
  ('sla.contratos.criar', 'sla', 'contratos', 'criar', 'Criar contrato de SLA', 'gestor', 240),
  ('sla.contratos.editar', 'sla', 'contratos', 'editar', 'Editar contrato de SLA', 'gestor', 250),
  ('sla.contratos.inativar', 'sla', 'contratos', 'inativar', 'Ativar/inativar contrato de SLA', 'gestor', 260),
  ('sla.categorias', 'sla', 'categorias', null, 'Categorias de ticket', 'gestor', 270),
  ('sla.categorias.ver', 'sla', 'categorias', 'ver', 'Consultar categorias', 'gestor', 280),
  ('sla.categorias.criar', 'sla', 'categorias', 'criar', 'Criar categoria', 'gestor', 290),
  ('sla.categorias.editar', 'sla', 'categorias', 'editar', 'Editar categoria', 'gestor', 300),
  ('sla.categorias.inativar', 'sla', 'categorias', 'inativar', 'Ativar/inativar categoria', 'gestor', 310),
  ('sla.prioridades', 'sla', 'prioridades', null, 'Prioridades', 'gestor', 320),
  ('sla.prioridades.ver', 'sla', 'prioridades', 'ver', 'Consultar prioridades', 'gestor', 330),
  ('sla.prioridades.criar', 'sla', 'prioridades', 'criar', 'Criar prioridade', 'gestor', 340),
  ('sla.prioridades.editar', 'sla', 'prioridades', 'editar', 'Editar prioridade', 'gestor', 350),
  ('sla.prioridades.inativar', 'sla', 'prioridades', 'inativar', 'Ativar/inativar prioridade', 'gestor', 360),
  ('inventario', 'inventario', null, null, 'Inventário', 'visualizador', 370),
  ('inventario.ativos', 'inventario', 'ativos', null, 'Ativos de TI', 'visualizador', 380),
  ('inventario.ativos.ver', 'inventario', 'ativos', 'ver', 'Consultar ativos', 'visualizador', 390),
  ('inventario.ativos.criar', 'inventario', 'ativos', 'criar', 'Cadastrar ativo', 'gestor', 400),
  ('inventario.ativos.editar', 'inventario', 'ativos', 'editar', 'Editar ativo', 'gestor', 410),
  ('inventario.ativos.mudar_status', 'inventario', 'ativos', 'mudar_status', 'Mover ciclo de vida', 'gestor', 420),
  ('telefonia', 'telefonia', null, null, 'Telefonia', 'visualizador', 430),
  ('telefonia.linhas', 'telefonia', 'linhas', null, 'Linhas telefônicas', 'visualizador', 440),
  ('telefonia.linhas.ver', 'telefonia', 'linhas', 'ver', 'Consultar linhas', 'visualizador', 450),
  ('telefonia.linhas.criar', 'telefonia', 'linhas', 'criar', 'Cadastrar linha', 'gestor', 460),
  ('telefonia.linhas.editar', 'telefonia', 'linhas', 'editar', 'Editar linha', 'gestor', 470),
  ('telefonia.linhas.mudar_status', 'telefonia', 'linhas', 'mudar_status', 'Suspender/reativar linha', 'gestor', 480),
  ('clientes', 'clientes', null, null, 'Clientes e filiais', 'gestor', 490),
  ('clientes.grupos', 'clientes', 'grupos', null, 'Grupos econômicos', 'gestor', 500),
  ('clientes.grupos.ver', 'clientes', 'grupos', 'ver', 'Consultar clientes', 'gestor', 510),
  ('clientes.grupos.criar', 'clientes', 'grupos', 'criar', 'Cadastrar cliente', 'gestor', 520),
  ('clientes.grupos.editar', 'clientes', 'grupos', 'editar', 'Editar cliente', 'gestor', 530),
  ('clientes.grupos.inativar', 'clientes', 'grupos', 'inativar', 'Mudar situação do cliente', 'gestor', 540),
  ('clientes.filiais', 'clientes', 'filiais', null, 'Filiais', 'gestor', 550),
  ('clientes.filiais.ver', 'clientes', 'filiais', 'ver', 'Consultar filiais', 'gestor', 560),
  ('clientes.filiais.criar', 'clientes', 'filiais', 'criar', 'Cadastrar filial', 'gestor', 570),
  ('clientes.filiais.editar', 'clientes', 'filiais', 'editar', 'Editar filial', 'gestor', 580),
  ('clientes.filiais.inativar', 'clientes', 'filiais', 'inativar', 'Ativar/inativar filial', 'gestor', 590),
  ('fornecedores', 'fornecedores', null, null, 'Fornecedores', 'gestor', 600),
  ('fornecedores.cadastro', 'fornecedores', 'cadastro', null, 'Fornecedores', 'gestor', 610),
  ('fornecedores.cadastro.ver', 'fornecedores', 'cadastro', 'ver', 'Consultar fornecedores', 'gestor', 620),
  ('fornecedores.cadastro.criar', 'fornecedores', 'cadastro', 'criar', 'Cadastrar fornecedor', 'gestor', 630),
  ('fornecedores.cadastro.editar', 'fornecedores', 'cadastro', 'editar', 'Editar fornecedor', 'gestor', 640),
  ('fornecedores.cadastro.inativar', 'fornecedores', 'cadastro', 'inativar', 'Ativar/inativar fornecedor', 'gestor', 650),
  ('fornecedores.contratos', 'fornecedores', 'contratos', null, 'Contratos de fornecedor', 'gestor', 660),
  ('fornecedores.contratos.ver', 'fornecedores', 'contratos', 'ver', 'Consultar contratos', 'gestor', 670),
  ('fornecedores.contratos.criar', 'fornecedores', 'contratos', 'criar', 'Cadastrar contrato', 'gestor', 680),
  ('fornecedores.contratos.editar', 'fornecedores', 'contratos', 'editar', 'Editar contrato', 'gestor', 690),
  ('fornecedores.contratos.inativar', 'fornecedores', 'contratos', 'inativar', 'Ativar/inativar contrato', 'gestor', 700),
  ('mapas', 'mapas', null, null, 'Mapas', 'visualizador', 710),
  ('mapas.geolocalizacao', 'mapas', 'geolocalizacao', null, 'Geolocalização de filiais', 'visualizador', 720),
  ('mapas.geolocalizacao.ver', 'mapas', 'geolocalizacao', 'ver', 'Ver mapa', 'visualizador', 730),
  ('mapas.geolocalizacao.editar_endereco', 'mapas', 'geolocalizacao', 'editar_endereco', 'Gravar endereço e coordenada', 'gestor', 740),
  ('mapas.geolocalizacao.geocodificar', 'mapas', 'geolocalizacao', 'geocodificar', 'Rodar geocodificação', 'gestor', 750),
  ('financeiro', 'financeiro', null, null, 'Financeiro', 'gestor', 760),
  ('financeiro.centros_custo', 'financeiro', 'centros_custo', null, 'Centros de custo', 'gestor', 770),
  ('financeiro.centros_custo.ver', 'financeiro', 'centros_custo', 'ver', 'Consultar centros de custo', 'gestor', 780),
  ('financeiro.centros_custo.criar', 'financeiro', 'centros_custo', 'criar', 'Cadastrar centro de custo', 'gestor', 790),
  ('financeiro.centros_custo.editar', 'financeiro', 'centros_custo', 'editar', 'Editar centro de custo', 'gestor', 800),
  ('financeiro.centros_custo.inativar', 'financeiro', 'centros_custo', 'inativar', 'Ativar/inativar centro de custo', 'gestor', 810),
  ('financeiro.contas_bancarias', 'financeiro', 'contas_bancarias', null, 'Contas bancárias', 'gestor', 820),
  ('financeiro.contas_bancarias.ver', 'financeiro', 'contas_bancarias', 'ver', 'Consultar contas e saldos', 'gestor', 830),
  ('financeiro.contas_bancarias.criar', 'financeiro', 'contas_bancarias', 'criar', 'Cadastrar conta bancária', 'gestor', 840),
  ('financeiro.contas_bancarias.editar', 'financeiro', 'contas_bancarias', 'editar', 'Editar conta bancária', 'gestor', 850),
  ('financeiro.contas_bancarias.inativar', 'financeiro', 'contas_bancarias', 'inativar', 'Bloquear/reativar conta', 'gestor', 860),
  ('financeiro.contas_bancarias.movimentar', 'financeiro', 'contas_bancarias', 'movimentar', 'Lançar entrada/saída', 'gestor', 870),
  ('financeiro.contas_bancarias.transferir', 'financeiro', 'contas_bancarias', 'transferir', 'Transferir entre contas', 'gestor', 880),
  ('usuarios', 'usuarios', null, null, 'Usuários e acesso', 'gestor', 890),
  ('usuarios.usuarios', 'usuarios', 'usuarios', null, 'Usuários', 'gestor', 900),
  ('usuarios.usuarios.ver', 'usuarios', 'usuarios', 'ver', 'Consultar usuários', 'gestor', 910),
  ('usuarios.usuarios.criar', 'usuarios', 'usuarios', 'criar', 'Criar usuário', 'admin', 920),
  ('usuarios.usuarios.editar_acesso', 'usuarios', 'usuarios', 'editar_acesso', 'Alterar papel e filiais', 'admin', 930),
  ('usuarios.perfis', 'usuarios', 'perfis', null, 'Perfis de acesso', 'admin', 940),
  ('usuarios.perfis.ver', 'usuarios', 'perfis', 'ver', 'Consultar perfis', 'admin', 950),
  ('usuarios.perfis.criar', 'usuarios', 'perfis', 'criar', 'Criar perfil', 'admin', 960),
  ('usuarios.perfis.editar', 'usuarios', 'perfis', 'editar', 'Editar perfil e permissões', 'admin', 970),
  ('usuarios.perfis.inativar', 'usuarios', 'perfis', 'inativar', 'Ativar/inativar perfil', 'admin', 980),
  ('integracoes', 'integracoes', null, null, 'Integrações', 'admin', 990),
  ('integracoes.hub', 'integracoes', 'hub', null, 'Hub de integrações', 'admin', 1000),
  ('integracoes.hub.ver', 'integracoes', 'hub', 'ver', 'Consultar integrações', 'admin', 1010),
  ('integracoes.hub.editar', 'integracoes', 'hub', 'editar', 'Ligar/desligar e configurar', 'admin', 1020),
  ('integracoes.hub.rotacionar_token', 'integracoes', 'hub', 'rotacionar_token', 'Rotacionar token de entrada', 'admin', 1030),
  ('tv', 'tv', null, null, 'Painéis de TV', 'gestor', 1040),
  ('tv.tokens', 'tv', 'tokens', null, 'Tokens de exibição', 'gestor', 1050),
  ('tv.tokens.ver', 'tv', 'tokens', 'ver', 'Consultar tokens', 'gestor', 1060),
  ('tv.tokens.criar', 'tv', 'tokens', 'criar', 'Gerar token', 'gestor', 1070),
  ('tv.tokens.revogar', 'tv', 'tokens', 'revogar', 'Revogar token', 'gestor', 1080);

-- -----------------------------------------------------------------------------
-- Perfis de sistema, por tenant
-- -----------------------------------------------------------------------------
-- Criados para cada tenant existente e para os futuros (a função abaixo é
-- reaproveitada no provisionamento). São atribuíveis e não editáveis.
--
-- NOTA sobre "Aprovador N1/N2/N3": o nível de alçada NÃO é atributo do perfil.
-- A mesma pessoa pode ser N1 de um centro de custo e N2 de outro, e amarrar o
-- nível ao perfil forçaria um nível único por pessoa em toda a operação. Aqui
-- existe um perfil "Aprovador Financeiro" (a permissão de aprovar); o nível
-- passa a viver na cadeia de aprovação, junto com a faixa de valor — ver
-- docs/07.
create or replace function app.seed_system_access_profiles(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile record;
begin
  -- Perfis. `on conflict` deixa a função idempotente: rodar de novo num tenant
  -- já provisionado não duplica nem falha.
  insert into public.access_profiles (tenant_id, name, description, base_role, is_system, system_key)
  values
    (p_tenant_id, 'Admin do Cliente',
     'Acesso total ao ambiente do cliente.', 'admin', true, 'admin_cliente'),
    (p_tenant_id, 'Diretoria',
     'Leitura de tudo que o papel gestor alcança, sem escrita.', 'gestor', true, 'diretoria'),
    (p_tenant_id, 'Gestor de TI',
     'Operação de TI completa: helpdesk, inventário, telefonia, mapas, SLA e cadastros.',
     'gestor', true, 'gestor_ti'),
    (p_tenant_id, 'Operador de TI',
     'Atende ticket e consulta inventário e telefonia; não cadastra.', 'atendente', true, 'operador_ti'),
    (p_tenant_id, 'Gestor Financeiro',
     'Financeiro completo, mais fornecedores e leitura de clientes.', 'gestor', true, 'gestor_financeiro'),
    (p_tenant_id, 'Operador Financeiro',
     'Lança movimentação bancária e consulta; não cadastra conta nem transfere.',
     'gestor', true, 'operador_financeiro'),
    (p_tenant_id, 'Aprovador Financeiro',
     'Consulta o financeiro e aprova o que a alçada permitir.', 'gestor', true, 'aprovador_financeiro'),
    (p_tenant_id, 'Visualizador',
     'Somente leitura do que o papel visualizador alcança.', 'visualizador', true, 'visualizador'),
    -- Solicitante precisa de perfil próprio: sem nenhum perfil atribuído,
    -- `has_permission()` é falso em tudo e a pessoa perderia até abrir ticket,
    -- que é a razão dela existir no sistema.
    (p_tenant_id, 'Solicitante',
     'Abre e acompanha os próprios tickets; consulta o que o papel alcança.',
     'solicitante', true, 'solicitante')
  on conflict do nothing;

  -- Concessões. Expressas como REGRA sobre o catálogo, não como lista de
  -- chaves: listar ~108 chaves oito vezes garantiria que a próxima permissão
  -- nova entrasse em alguns perfis e fosse esquecida em outros.
  for v_profile in
    select id, base_role, system_key from public.access_profiles
    where tenant_id = p_tenant_id and is_system
  loop
    insert into public.permission_grants (tenant_id, profile_id, permission_key)
    select p_tenant_id, v_profile.id, c.key
    from public.permission_catalog c
    where app.role_rank(c.min_base_role) <= app.role_rank(v_profile.base_role)
      and case v_profile.system_key
        -- Tudo que o teto alcança.
        when 'admin_cliente' then true

        -- Só leitura: entradas de módulo e de tela (action is null) mais as de
        -- consulta. Sem as de módulo/tela a herança negaria as de consulta.
        when 'diretoria'    then c.action is null or c.action = 'ver'
        when 'visualizador' then c.action is null or c.action = 'ver'

        when 'gestor_ti' then c.module in
          ('helpdesk','inventario','telefonia','mapas','sla','clientes','fornecedores','tv')

        when 'operador_ti' then
          c.module = 'helpdesk'
          or (c.module in ('inventario','telefonia','mapas') and (c.action is null or c.action = 'ver'))

        when 'gestor_financeiro' then
          c.module in ('financeiro','fornecedores')
          or (c.module = 'clientes' and (c.action is null or c.action = 'ver'))
          or c.key in ('sla','sla.compliance','sla.compliance.ver')

        when 'operador_financeiro' then
          c.module = 'financeiro'
          and (c.action is null or c.action in ('ver','movimentar'))

        -- As ações de aprovação chegam com o módulo de contas a pagar; hoje o
        -- perfil concede a consulta, que é o que existe para conceder.
        when 'aprovador_financeiro' then
          c.module = 'financeiro' and (c.action is null or c.action = 'ver')

        -- Tudo que o teto `solicitante` alcança — que é helpdesk mais consulta
        -- de inventário, telefonia e mapas. É o que essa pessoa já faz hoje.
        when 'solicitante' then true

        else false
      end
    on conflict do nothing;
  end loop;
end;
$$;

comment on function app.seed_system_access_profiles(uuid) is
  'Cria (idempotente) os perfis de sistema e suas concessões para um tenant.';

-- Tenant que JÁ existe quando a migração roda (o caso de produção).
do $$
declare
  v_tenant uuid;
begin
  for v_tenant in select id from public.tenants loop
    perform app.seed_system_access_profiles(v_tenant);
  end loop;
end;
$$;

-- E todo tenant FUTURO.
--
-- O loop acima sozinho não bastava: em banco novo as migrações rodam antes de
-- `supabase/seed.sql`, então não havia tenant para iterar e nenhum ambiente
-- nascia com perfil. Pior, um usuário sem perfil tem `has_permission()` falso em
-- tudo — o ambiente subiria com todas as telas negadas e sem pista do motivo.
create or replace function app.tenants_seed_access_profiles()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform app.seed_system_access_profiles(new.id);
  return new;
end;
$$;

create trigger trg_tenants_seed_access_profiles
  after insert on public.tenants
  for each row execute function app.tenants_seed_access_profiles();

/**
 * Usuário novo herda o perfil de sistema do seu papel.
 *
 * Sem isto, quem for criado por `createUserAccount` nasce com
 * `access_profile_id` nulo e portanto sem permissão nenhuma — logaria e não
 * veria tela alguma. Atribuir explicitamente um perfil continua possível: a
 * trigger só age quando o campo vem vazio.
 */
create or replace function app.profiles_default_access_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text;
begin
  if new.access_profile_id is not null or new.tenant_id is null
     or new.role = 'super_admin' then
    return new;
  end if;

  v_key := case new.role
    when 'admin'        then 'admin_cliente'
    when 'gestor'       then 'gestor_ti'
    when 'atendente'    then 'operador_ti'
    when 'visualizador' then 'visualizador'
    when 'solicitante'  then 'solicitante'
    else null
  end;

  if v_key is null then
    return new;
  end if;

  select id into new.access_profile_id
  from public.access_profiles
  where tenant_id = new.tenant_id and system_key = v_key and is_active;

  return new;
end;
$$;

create trigger trg_profiles_default_access_profile
  before insert on public.profiles
  for each row execute function app.profiles_default_access_profile();

-- -----------------------------------------------------------------------------
-- Backfill: ninguém muda de comportamento nesta migração
-- -----------------------------------------------------------------------------
-- Cada usuário recebe o perfil de sistema cujo teto é igual ao papel que ele já
-- tem. `super_admin` fica sem perfil de propósito: é papel da operação da
-- plataforma, não do ambiente do cliente, e `effective_base_role()` devolve o
-- papel puro quando não há perfil.
update public.profiles p
set access_profile_id = ap.id
from public.access_profiles ap
where ap.tenant_id = p.tenant_id
  and ap.is_system
  and p.access_profile_id is null
  and p.role <> 'super_admin'
  and ap.system_key = case p.role
    when 'admin'        then 'admin_cliente'
    when 'gestor'       then 'gestor_ti'
    when 'atendente'    then 'operador_ti'
    when 'visualizador' then 'visualizador'
    when 'solicitante'  then 'solicitante'
    else null
  end;


-- =============================================================================
-- ARQUIVO 18 de 23: 0018_financeiro_base.sql
-- =============================================================================

-- =============================================================================
-- 0018 — Base do financeiro: centros de custo e contas bancárias
-- =============================================================================
-- Terceiro item da ordem de prioridade: são as duas dimensões que TODO
-- lançamento financeiro precisa referenciar. Criar contas a pagar antes delas
-- produziria títulos sem centro de custo e sem conta de origem — ou seja, sem
-- como responder "quanto a operação gastou" nem "de qual conta saiu", que são as
-- duas perguntas que justificam o módulo.
--
-- Não há tabela de título aqui. Contas a pagar e a receber vêm depois, quando
-- estas duas estiverem em uso e a camada de permissão validada na prática.

-- -----------------------------------------------------------------------------
-- Correção estrutural: supplier_contracts precisa ser referenciável
-- -----------------------------------------------------------------------------
-- `supplier_contracts` nasceu sem `unique (id, tenant_id)` (0008_suppliers.sql),
-- e é essa chave composta que o padrão do ADR-001 exige para uma FK não
-- atravessar tenant. Sem ela, o vínculo "título a pagar → contrato do
-- fornecedor" seria impossível de expressar com segurança, e a alternativa (FK
-- só por `id`) deixaria um título de um tenant apontar para o contrato de outro.
alter table public.supplier_contracts
  add constraint uq_supplier_contracts_id_tenant unique (id, tenant_id);

-- -----------------------------------------------------------------------------
-- cost_centers — hierarquia de até 3 níveis
-- -----------------------------------------------------------------------------
create table public.cost_centers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  parent_id   uuid,
  code        text not null,
  name        text not null,
  description text,
  -- Nulo = centro global do tenant. Preenchido = centro daquela filial, e o
  -- rateio de despesa passa a poder ser cobrado por unidade.
  branch_id   uuid,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint uq_cost_centers_id_tenant unique (id, tenant_id),
  constraint fk_cost_center_parent foreign key (parent_id, tenant_id)
    references public.cost_centers (id, tenant_id) on delete restrict,
  constraint fk_cost_center_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete restrict,
  -- Um centro não pode ser pai de si mesmo. O ciclo mais longo é barrado pela
  -- trigger de profundidade abaixo.
  constraint cost_centers_no_self_parent check (parent_id is null or parent_id <> id)
);

create unique index uq_cost_centers_code on public.cost_centers (tenant_id, lower(code));
create index idx_cost_centers_parent on public.cost_centers (parent_id);
create index idx_cost_centers_tenant on public.cost_centers (tenant_id) where is_active;
create index idx_cost_centers_branch on public.cost_centers (branch_id) where branch_id is not null;

comment on table public.cost_centers is
  'Centros de custo hierárquicos (máx. 3 níveis). Dimensão de rateio dos lançamentos financeiros.';

/**
 * Profundidade máxima 3 (centro → subcentro → sub-subcentro).
 *
 * Mesma decisão de `app.enforce_category_depth()` (0004_taxonomy_queues.sql) e
 * pelo mesmo motivo: relatório de DRE e a UI de seleção precisam de uma
 * profundidade conhecida. Árvore arbitrária transformaria todo relatório em
 * recursão de profundidade desconhecida, sem que ninguém tenha pedido isso.
 */
create or replace function app.enforce_cost_center_depth()
returns trigger
language plpgsql
as $$
declare
  v_nivel int := 1;
  v_atual uuid := new.parent_id;
begin
  while v_atual is not null loop
    v_nivel := v_nivel + 1;
    if v_nivel > 3 then
      raise exception 'Centros de custo suportam no máximo 3 níveis'
        using errcode = 'check_violation';
    end if;
    select parent_id into v_atual from public.cost_centers where id = v_atual;
    -- Ciclo: sem esta saída, um pai apontando para um descendente giraria para
    -- sempre e travaria a transação em vez de recusá-la.
    if v_atual = new.id then
      raise exception 'Hierarquia de centro de custo não pode formar ciclo'
        using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end;
$$;

create trigger trg_cost_center_depth
  before insert or update of parent_id on public.cost_centers
  for each row execute function app.enforce_cost_center_depth();

-- -----------------------------------------------------------------------------
-- bank_accounts
-- -----------------------------------------------------------------------------
create table public.bank_accounts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,
  bank_code       text,
  bank_name       text not null,
  agency          text,
  account_number  text,
  account_type    text not null default 'checking'
                    check (account_type in ('checking','savings','payment','investment')),
  holder_name     text,
  holder_document text,
  -- Saldo inicial é o ponto de partida da conciliação: o saldo corrente é
  -- DERIVADO (ver vw_bank_account_balances) e nunca gravado, porque saldo
  -- materializado e movimentação divergem no primeiro erro de arredondamento.
  opening_balance numeric(14,2) not null default 0,
  -- Limite de cheque especial / crédito. Positivo, aplicado abaixo de zero.
  credit_limit    numeric(14,2) not null default 0 check (credit_limit >= 0),
  status          text not null default 'active'
                    check (status in ('active','inactive','blocked')),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint uq_bank_accounts_id_tenant unique (id, tenant_id)
);

create unique index uq_bank_accounts_identity
  on public.bank_accounts (tenant_id, bank_code, agency, account_number)
  where deleted_at is null and account_number is not null;
create index idx_bank_accounts_tenant on public.bank_accounts (tenant_id)
  where deleted_at is null;

comment on table public.bank_accounts is
  'Contas bancárias do tenant. O saldo corrente é derivado das movimentações, nunca gravado aqui.';

-- -----------------------------------------------------------------------------
-- bank_account_movements
-- -----------------------------------------------------------------------------
create table public.bank_account_movements (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  bank_account_id uuid not null,
  direction       text not null check (direction in ('in','out')),
  -- Sempre positivo; o sinal é responsabilidade de `direction`. Guardar valor
  -- negativo para saída duplicaria a informação e permitiria a combinação
  -- absurda "saída de valor negativo".
  amount          numeric(14,2) not null check (amount > 0),
  moved_on        date not null,
  description     text not null,
  cost_center_id  uuid,
  -- Transferência interna é DUPLA ENTRADA: duas linhas com o mesmo grupo, uma
  -- `out` na origem e uma `in` no destino. Sem o grupo não haveria como saber
  -- que as duas metades são o mesmo fato, e o extrato mostraria uma saída
  -- inexplicada em uma conta e uma entrada inexplicada em outra.
  transfer_group  uuid,
  reconciled_at   timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint fk_movement_account foreign key (bank_account_id, tenant_id)
    references public.bank_accounts (id, tenant_id) on delete restrict,
  constraint fk_movement_cost_center foreign key (cost_center_id, tenant_id)
    references public.cost_centers (id, tenant_id) on delete restrict
);

create index idx_movements_account on public.bank_account_movements (bank_account_id, moved_on desc);
create index idx_movements_tenant on public.bank_account_movements (tenant_id, moved_on desc);
create index idx_movements_transfer on public.bank_account_movements (transfer_group)
  where transfer_group is not null;
create index idx_movements_unreconciled on public.bank_account_movements (tenant_id, moved_on)
  where reconciled_at is null;

comment on table public.bank_account_movements is
  'Entradas e saídas por conta. Transferência interna = duas linhas com o mesmo transfer_group.';

/**
 * Uma transferência tem exatamente duas metades, em contas diferentes, de
 * valores iguais e sentidos opostos.
 *
 * A checagem é AFTER e por STATEMENT: dentro de uma inserção de duas linhas, a
 * primeira metade sozinha é sempre "inválida", e uma trigger FOR EACH ROW
 * recusaria a transferência inteira antes de a segunda linha existir.
 */
create or replace function app.validate_transfer_pairs()
returns trigger
language plpgsql
as $$
declare
  v_grupo record;
begin
  for v_grupo in
    select transfer_group
    from public.bank_account_movements
    where transfer_group is not null
    group by transfer_group
    having count(*) <> 2
        or count(distinct bank_account_id) <> 2
        or count(distinct amount) <> 1
        or count(distinct direction) <> 2
  loop
    raise exception 'Transferência % precisa de duas metades, em contas distintas, de mesmo valor e sentidos opostos',
      v_grupo.transfer_group
      using errcode = 'check_violation';
  end loop;
  return null;
end;
$$;

create constraint trigger trg_movements_transfer_pairs
  after insert or update or delete on public.bank_account_movements
  deferrable initially deferred
  for each row execute function app.validate_transfer_pairs();

-- -----------------------------------------------------------------------------
-- vw_bank_account_balances — saldo derivado
-- -----------------------------------------------------------------------------
create view public.vw_bank_account_balances
with (security_invoker = true) as
select
  a.id                as bank_account_id,
  a.tenant_id,
  a.name,
  a.bank_name,
  a.account_type,
  a.status,
  a.opening_balance,
  a.credit_limit,
  coalesce(sum(case when m.direction = 'in'  then m.amount end), 0) as total_in,
  coalesce(sum(case when m.direction = 'out' then m.amount end), 0) as total_out,
  a.opening_balance
    + coalesce(sum(case when m.direction = 'in'  then m.amount end), 0)
    - coalesce(sum(case when m.direction = 'out' then m.amount end), 0) as current_balance,
  count(m.id) filter (where m.reconciled_at is null) as unreconciled_count,
  max(m.moved_on) as last_movement_on
from public.bank_accounts a
left join public.bank_account_movements m on m.bank_account_id = a.id
where a.deleted_at is null
group by a.id, a.tenant_id, a.name, a.bank_name, a.account_type, a.status,
         a.opening_balance, a.credit_limit;

comment on view public.vw_bank_account_balances is
  'Saldo corrente por conta = saldo inicial + entradas - saídas, com contagem de não conciliados.';

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
select app.harden_table('public.cost_centers');
select app.harden_table('public.bank_accounts');
select app.harden_table('public.bank_account_movements');

select app.attach_audit('public.cost_centers');
select app.attach_audit('public.bank_accounts');
select app.attach_audit('public.bank_account_movements');

-- Mesma forma das demais tabelas de cadastro do tenant (0012_rls_policies.sql):
-- leitura para todo o tenant, escrita para quem administra registros. O teto
-- efetivo já passa pelo perfil de acesso via `app.effective_base_role()`.
do $$
declare
  t text;
begin
  foreach t in array array['cost_centers','bank_accounts','bank_account_movements'] loop
    execute format($f$
      create policy %1$s_select on public.%1$s
        for select to authenticated
        using (tenant_id = app.current_tenant_id());
    $f$, t);
    execute format($f$
      create policy %1$s_insert on public.%1$s
        for insert to authenticated
        with check (tenant_id = app.current_tenant_id() and app.can_manage_records());
    $f$, t);
    execute format($f$
      create policy %1$s_update on public.%1$s
        for update to authenticated
        using (tenant_id = app.current_tenant_id() and app.can_manage_records())
        with check (tenant_id = app.current_tenant_id());
    $f$, t);
    execute format($f$
      create policy %1$s_delete on public.%1$s
        for delete to authenticated
        using (tenant_id = app.current_tenant_id() and app.can_manage_records());
    $f$, t);
    execute format('grant select, insert, update, delete on public.%s to authenticated', t);
  end loop;
end;
$$;

grant select on public.vw_bank_account_balances to authenticated;


-- =============================================================================
-- ARQUIVO 19 de 23: 0019_storage_anexos.sql
-- =============================================================================

-- =============================================================================
-- 0019 — Storage de anexos: bucket privado e autorização por caminho
-- =============================================================================
-- Fecha uma lacuna de infraestrutura, não de modelagem. Existem QUATRO tabelas
-- de anexo desde a 0005 e a 0013 — `ticket_attachments`, `asset_attachments`,
-- `telecom_line_attachments`, `internet_link_attachments` — todas com
-- `storage_path text not null`, e nenhuma linha de código que suba arquivo. Ou
-- seja: hoje é impossível anexar um documento a um ticket. A coluna existe, a FK
-- composta existe e a cota já é validada no banco (`trg_attachment_quota`,
-- 0013); faltava o bucket e a autorização.
--
-- Isto também é pré-requisito de dois módulos financeiros especificados em
-- docs/07: título a pagar sem NF/boleto não serve operacionalmente, e controle
-- de despesa depende de comprovante.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Bucket
-- -----------------------------------------------------------------------------
-- PRIVADO. Bucket público transformaria `storage_path` em URL adivinhável, e
-- anexo de ticket de Home Care pode conter dado de saúde do paciente — o tipo de
-- dado em que "ninguém vai adivinhar o caminho" não é controle de acesso.
--
-- O limite de 25 MB por arquivo é teto de UM arquivo e não substitui a cota por
-- ticket, que é do tenant (`tenants.attachment_quota_mb`) e continua na trigger
-- da 0013. São controles diferentes: um impede o upload gigante, o outro impede
-- a soma dos pequenos.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'anexos', 'anexos', false, 26214400,
  array[
    'application/pdf',
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'application/xml', 'text/xml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/plain', 'text/csv'
  ]
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

comment on table storage.buckets is
  'Buckets do Storage. `anexos` é privado: o acesso passa por URL assinada.';

-- -----------------------------------------------------------------------------
-- A convenção de caminho
-- -----------------------------------------------------------------------------
-- {tenant_id}/{entidade}/{entity_id}/{arquivo}
--
-- Isto NÃO é invenção desta migração: `supabase/seed.sql` já grava
-- `format('%s/%s/contrato-nl-link-001.pdf', k.tenant_id, k.id)`. O primeiro
-- segmento sendo o tenant é o que permite ao Storage ter a mesma fronteira de
-- isolamento das 138 policies de `public` (ADR-002), em vez de uma paralela.

/**
 * Tenant do caminho, ou NULL se o caminho não seguir a convenção.
 *
 * O cast direto `(...)[1]::uuid` levantaria exceção em caminho malformado, e
 * exceção dentro de policy vira erro 500 opaco em vez de negação limpa. Aqui
 * caminho estranho devolve NULL, e NULL reprova a comparação — nega.
 */
create or replace function app.storage_tenant(p_name text)
returns uuid
language plpgsql
immutable
as $$
declare
  v_first text := (storage.foldername(p_name))[1];
begin
  if v_first is null then
    return null;
  end if;
  return v_first::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

comment on function app.storage_tenant(text) is
  'Primeiro segmento do caminho como uuid; NULL se o caminho fugir da convenção.';

/**
 * Entidade do caminho — segundo segmento.
 */
create or replace function app.storage_entity(p_name text)
returns text
language sql
immutable
as $$
  select (storage.foldername(p_name))[2];
$$;

/**
 * Chave de permissão exigida para um verbo sobre a entidade.
 *
 * Mapa EXPLÍCITO, e o `else null` é a decisão de segurança: entidade que não
 * está aqui não tem chave, e sem chave `app.can_touch_attachment()` nega. Prefixo
 * novo no bucket não nasce liberado por esquecimento.
 *
 * `links` está deliberadamente FORA. A tabela `internet_link_attachments` existe
 * (0013:496), mas a tela de Links de Internet não existe na aplicação — só no
 * protótipo. Cadastrar `conectividade.links.anexar` agora criaria permissão que
 * não governa tela nenhuma, que é exatamente o defeito corrigido nesta mesma
 * rodada em seis outras chaves. Entra junto com a tela.
 */
create or replace function app.storage_permission_key(p_entity text, p_verb text)
returns text
language sql
immutable
as $$
  select case p_entity
    when 'tickets' then case p_verb
      when 'ver'     then 'helpdesk.tickets.ver'
      when 'anexar'  then 'helpdesk.tickets.anexar'
      when 'remover' then 'helpdesk.tickets.remover_anexo'
      else null end
    when 'ativos' then case p_verb
      when 'ver'     then 'inventario.ativos.ver'
      when 'anexar'  then 'inventario.ativos.anexar'
      when 'remover' then 'inventario.ativos.remover_anexo'
      else null end
    when 'linhas' then case p_verb
      when 'ver'     then 'telefonia.linhas.ver'
      when 'anexar'  then 'telefonia.linhas.anexar'
      when 'remover' then 'telefonia.linhas.remover_anexo'
      else null end
    else null
  end;
$$;

/**
 * O predicado único das policies do bucket.
 *
 * Segue o padrão de `app.can_see_branch()` (0002): a condição mora numa função
 * reutilizada, não copiada em cada policy — três cópias divergiriam na primeira
 * manutenção.
 *
 * Nega por omissão em toda saída: caminho fora da convenção, tenant diferente,
 * entidade desconhecida, verbo desconhecido, chave inexistente. A checagem
 * explícita de `key is not null` não é redundância defensiva: `has_permission`
 * recebendo NULL percorreria uma lista vazia de ancestrais e devolveria TRUE,
 * liberando justamente o caso que ninguém previu.
 */
create or replace function app.can_touch_attachment(p_name text, p_verb text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_tenant uuid := app.storage_tenant(p_name);
  v_key    text;
begin
  if v_tenant is null or v_tenant <> app.current_tenant_id() then
    return false;
  end if;

  v_key := app.storage_permission_key(app.storage_entity(p_name), p_verb);
  if v_key is null then
    return false;
  end if;

  -- Um caminho completo tem exatamente 3 pastas antes do arquivo. Aceitar menos
  -- deixaria um objeto solto em `{tenant}/tickets/arquivo.pdf`, sem ticket a que
  -- pertencer — anexo órfão que nenhuma tela mostra e nenhuma cota conta.
  if array_length(storage.foldername(p_name), 1) <> 3 then
    return false;
  end if;

  return app.has_permission(v_key);
end;
$$;

comment on function app.can_touch_attachment(text, text) is
  'Predicado das policies do bucket `anexos`: tenant do caminho + permissão da entidade. Nega por omissão.';

-- -----------------------------------------------------------------------------
-- Policies do bucket
-- -----------------------------------------------------------------------------
-- Só `create policy`: RLS em `storage.objects` já vem habilitado do Supabase, e
-- a tabela pertence a `supabase_storage_admin`. Mexer no enforcement dela
-- quebraria o serviço de Storage.
--
-- Verbos separados porque são decisões distintas: quem consulta anexo não é
-- necessariamente quem anexa, e apagar documento fiscal é ação própria.
drop policy if exists anexos_select on storage.objects;
create policy anexos_select on storage.objects
  for select to authenticated
  using (bucket_id = 'anexos' and app.can_touch_attachment(name, 'ver'));

drop policy if exists anexos_insert on storage.objects;
create policy anexos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'anexos' and app.can_touch_attachment(name, 'anexar'));

drop policy if exists anexos_delete on storage.objects;
create policy anexos_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'anexos' and app.can_touch_attachment(name, 'remover'));

-- Sem policy de UPDATE de propósito: trocar o conteúdo de um anexo por outro,
-- mantendo o mesmo caminho e o mesmo registro de metadados, é substituição
-- silenciosa de prova documental. Corrigir é remover e anexar de novo, que deixa
-- rastro nas duas tabelas.

-- -----------------------------------------------------------------------------
-- Chaves novas no catálogo
-- -----------------------------------------------------------------------------
-- Mantidas em sincronia com `PERMISSION_CATALOG` em `src/lib/permissions.ts`.
-- `sort_order` usa os intervalos livres entre as chaves existentes, para a matriz
-- da tela de perfis mostrar cada ação junto da sua tela.
--
-- `anexar` em ticket é `solicitante`: quem abre o chamado precisa poder mandar o
-- print do erro, e é o caso mais comum de anexo no helpdesk. Remover é
-- `atendente` — deixar o solicitante apagar anexo do próprio ticket depois de
-- escalado apagaria evidência.
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('helpdesk.tickets.anexar', 'helpdesk', 'tickets', 'anexar',
   'Anexar arquivo', 'solicitante', 112),
  ('helpdesk.tickets.remover_anexo', 'helpdesk', 'tickets', 'remover_anexo',
   'Remover anexo', 'atendente', 114),
  ('inventario.ativos.anexar', 'inventario', 'ativos', 'anexar',
   'Anexar nota ou foto', 'gestor', 422),
  ('inventario.ativos.remover_anexo', 'inventario', 'ativos', 'remover_anexo',
   'Remover anexo do ativo', 'gestor', 424),
  ('telefonia.linhas.anexar', 'telefonia', 'linhas', 'anexar',
   'Anexar contrato ou termo', 'gestor', 472),
  ('telefonia.linhas.remover_anexo', 'telefonia', 'linhas', 'remover_anexo',
   'Remover anexo da linha', 'gestor', 474)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

-- Perfis de sistema já existentes não conhecem as chaves novas. A função é
-- idempotente e expressa as concessões como REGRA sobre o catálogo, então
-- rodá-la de novo distribui as chaves novas pelos perfis certos sem duplicar as
-- antigas. Sem isto, um Admin do Cliente já provisionado ficaria sem poder
-- anexar até alguém marcar à mão — e ninguém saberia que precisava.
do $$
declare
  v_tenant uuid;
begin
  for v_tenant in select id from public.tenants loop
    perform app.seed_system_access_profiles(v_tenant);
  end loop;
end;
$$;



-- =============================================================================
-- ARQUIVO 20 de 23: 0020_titulos_e_alcadas.sql
-- =============================================================================

-- =============================================================================
-- 0020 — Títulos a pagar e a receber, com alçada CONFIGURÁVEL
-- =============================================================================
-- Fecha os módulos 5 e 6 de docs/07 e é onde "lançar uma despesa" passa a existir.
--
-- A NOTA MAIS IMPORTANTE DESTA MIGRAÇÃO
--
-- O módulo de Contas a Pagar foi pedido completo, com aprovação multinível. Mas a
-- regra de alçada — quem é N1, N2, N3 e por qual critério — nunca foi definida, e
-- o próprio escopo do projeto proíbe inventar regra de negócio.
--
-- A saída não é entregar meio módulo: é entregar o MECANISMO e deixar a REGRA
-- como dado. `approval_rules` nasce VAZIA. Cada linha dela diz "no nível N, para
-- valor entre X e Y, opcionalmente restrito a este centro de custo ou filial,
-- quem aprova precisa ter este perfil de acesso". Isso cobre os quatro critérios
-- que estavam em aberto (cargo, centro de custo, filial, faixa de valor pura) sem
-- que nenhum valor em reais seja escolhido por mim.
--
-- E como tabela vazia poderia significar duas coisas opostas — "não precisa
-- aprovar" ou "ninguém pode aprovar" —, quem decide é uma chave explícita no
-- tenant: `payable_approval_required`, que começa FALSE. Enquanto estiver false, o
-- título nasce aprovado e a operação pequena não é obrigada a um fluxo que não
-- pediu. Ligada sem nenhuma regra cadastrada, a função levanta erro dizendo o que
-- configurar — em vez de deixar todo título parado sem explicação.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- A chave que liga o fluxo de aprovação
-- -----------------------------------------------------------------------------
alter table public.tenants
  add column if not exists payable_approval_required boolean not null default false;

comment on column public.tenants.payable_approval_required is
  'Liga o fluxo de aprovação de títulos a pagar. FALSE = título nasce aprovado.';

-- -----------------------------------------------------------------------------
-- expense_categories — a dimensão "natureza do gasto"
-- -----------------------------------------------------------------------------
-- Separada de `cost_centers` porque respondem perguntas diferentes: o centro de
-- custo diz QUEM consome, a categoria diz O QUE foi consumido. Software comprado
-- para a filial de Manaus é categoria "Software" e centro "TI — Manaus"; misturar
-- as duas dimensões numa coluna impediria os dois relatórios.
create table public.expense_categories (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  code       text not null,
  name       text not null,
  -- Nulo = categoria de despesa geral. Preenchido = a categoria só se aplica a
  -- título ligado a fornecedor, o que evita classificar folha como compra.
  requires_supplier boolean not null default false,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_expense_categories_id_tenant unique (id, tenant_id)
);

create unique index uq_expense_categories_code
  on public.expense_categories (tenant_id, lower(code));
create index idx_expense_categories_tenant
  on public.expense_categories (tenant_id) where is_active;

comment on table public.expense_categories is
  'Natureza do gasto. Dimensão independente do centro de custo, que diz quem consome.';

-- -----------------------------------------------------------------------------
-- approval_rules — a alçada, como DADO
-- -----------------------------------------------------------------------------
create table public.approval_rules (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  -- 1, 2, 3… O nome do nível é do cliente: "N1", "Coordenação", "Diretoria".
  level      integer not null check (level between 1 and 9),
  level_name text not null,
  -- A faixa. `max_amount` nulo = sem teto, o topo da alçada.
  min_amount numeric(14,2) not null default 0 check (min_amount >= 0),
  max_amount numeric(14,2) check (max_amount is null or max_amount > min_amount),
  -- Escopos opcionais. Nulo = a regra vale para qualquer centro/filial.
  cost_center_id uuid,
  branch_id      uuid,
  -- Quem aprova: precisa ter ESTE perfil de acesso. É assim que "aprovação por
  -- cargo" se expressa sem uma tabela de cargos separada — o perfil já é o cargo
  -- funcional dentro do sistema.
  required_profile_id uuid,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_approval_rule_cost_center foreign key (cost_center_id, tenant_id)
    references public.cost_centers (id, tenant_id) on delete restrict,
  constraint fk_approval_rule_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete restrict,
  constraint fk_approval_rule_profile foreign key (required_profile_id, tenant_id)
    references public.access_profiles (id, tenant_id) on delete restrict
);

create index idx_approval_rules_tenant on public.approval_rules (tenant_id, level)
  where is_active;

comment on table public.approval_rules is
  'Alçada de aprovação por tenant. Nasce VAZIA de propósito: a regra é decisão do cliente, não do código.';

-- -----------------------------------------------------------------------------
-- payables — títulos a pagar (é aqui que "lançar despesa" vive)
-- -----------------------------------------------------------------------------
create table public.payables (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  description text not null,
  -- Número da NF, do boleto ou do documento. Sem FK: não existe módulo fiscal.
  document_ref text,

  supplier_id          uuid,
  supplier_contract_id uuid,
  expense_category_id  uuid,
  cost_center_id       uuid,
  branch_id            uuid,

  amount   numeric(14,2) not null check (amount > 0),
  issued_on date not null default current_date,
  due_on    date not null,

  /*
   * Parcelamento sem tabela extra: cada parcela É um título, apontando para o
   * primeiro. Assim cada parcela é aprovada, paga e cancelada por conta própria —
   * que é como acontece na prática, porque a segunda parcela pode vencer depois
   * de o fornecedor ser trocado.
   */
  parent_payable_id  uuid,
  installment_number integer not null default 1 check (installment_number >= 1),
  installment_total  integer not null default 1 check (installment_total >= 1),

  status text not null default 'draft' check (status in (
    'draft', 'pending_approval', 'approved', 'rejected', 'scheduled', 'paid', 'cancelled'
  )),

  approved_at      timestamptz,
  approved_by      uuid references public.profiles(id) on delete set null,
  rejection_reason text,

  paid_on         date,
  bank_account_id uuid,
  -- A movimentação gerada na baixa. Sem FK composta porque a movimentação pode
  -- ser apagada por estorno e o título tem de sobreviver ao estorno.
  bank_movement_id uuid,

  notes      text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint uq_payables_id_tenant unique (id, tenant_id),
  constraint fk_payable_supplier foreign key (supplier_id, tenant_id)
    references public.suppliers (id, tenant_id) on delete restrict,
  -- Só possível porque a 0018 acrescentou unique (id, tenant_id) em
  -- supplier_contracts. Sem aquela correção este vínculo era impossível no
  -- padrão do ADR-001.
  constraint fk_payable_contract foreign key (supplier_contract_id, tenant_id)
    references public.supplier_contracts (id, tenant_id) on delete restrict,
  constraint fk_payable_category foreign key (expense_category_id, tenant_id)
    references public.expense_categories (id, tenant_id) on delete restrict,
  constraint fk_payable_cost_center foreign key (cost_center_id, tenant_id)
    references public.cost_centers (id, tenant_id) on delete restrict,
  constraint fk_payable_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete restrict,
  constraint fk_payable_parent foreign key (parent_payable_id, tenant_id)
    references public.payables (id, tenant_id) on delete cascade,
  constraint fk_payable_bank_account foreign key (bank_account_id, tenant_id)
    references public.bank_accounts (id, tenant_id) on delete restrict,

  constraint payables_installment_coherent
    check (installment_number <= installment_total),
  -- Título pago tem de dizer quando e de qual conta. Sem isto existiria "pago"
  -- sem rastro de pagamento, que é o pior tipo de dado financeiro: parece
  -- resolvido e não prova nada.
  constraint payables_paid_has_evidence
    check (status <> 'paid' or (paid_on is not null and bank_account_id is not null)),
  constraint payables_rejected_has_reason
    check (status <> 'rejected' or rejection_reason is not null)
);

create index idx_payables_tenant_due on public.payables (tenant_id, due_on)
  where deleted_at is null;
create index idx_payables_status on public.payables (tenant_id, status)
  where deleted_at is null;
create index idx_payables_supplier on public.payables (supplier_id)
  where deleted_at is null;
create index idx_payables_parent on public.payables (parent_payable_id)
  where parent_payable_id is not null;

comment on table public.payables is
  'Títulos a pagar. Cada parcela é um título próprio, ligado ao primeiro por parent_payable_id.';

-- -----------------------------------------------------------------------------
-- payable_approvals — o rastro de cada nível
-- -----------------------------------------------------------------------------
-- Uma linha por decisão. Guardar só `approved_by` no título perderia o histórico
-- de um fluxo de três níveis, e perderia a rejeição que veio antes da aprovação.
create table public.payable_approvals (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  payable_id uuid not null,
  level      integer not null check (level between 1 and 9),
  decision   text not null check (decision in ('approved', 'rejected')),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz not null default now(),
  note       text,
  constraint fk_approval_payable foreign key (payable_id, tenant_id)
    references public.payables (id, tenant_id) on delete cascade,
  -- Um nível decide UMA vez por título. Duas decisões no mesmo nível deixariam
  -- ambíguo qual valeu.
  constraint uq_payable_approval_level unique (payable_id, level)
);

create index idx_payable_approvals_payable on public.payable_approvals (payable_id, level);

-- -----------------------------------------------------------------------------
-- payable_attachments — NF, boleto e comprovante
-- -----------------------------------------------------------------------------
-- Mesma forma das outras quatro tabelas de anexo: metadados aqui, binário no
-- bucket privado `anexos` da 0019.
create table public.payable_attachments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  payable_id   uuid not null,
  kind         text not null check (kind in (
                 'nfe', 'boleto', 'receipt', 'contract', 'other')),
  storage_path text not null unique,
  file_name    text not null,
  mime_type    text not null,
  size_bytes   bigint check (size_bytes > 0),
  uploaded_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint fk_payable_attach foreign key (payable_id, tenant_id)
    references public.payables (id, tenant_id) on delete cascade
);

create index idx_payable_attachments on public.payable_attachments (payable_id, kind);

-- -----------------------------------------------------------------------------
-- receivables — títulos a receber
-- -----------------------------------------------------------------------------
-- Sem fluxo de aprovação, e de propósito: aprovar o que se vai RECEBER não
-- protege ninguém. O controle aqui é a baixa — dizer que entrou o que entrou.
create table public.receivables (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  description text not null,
  document_ref text,

  client_id       uuid,
  sla_contract_id uuid,
  cost_center_id  uuid,
  branch_id       uuid,

  amount    numeric(14,2) not null check (amount > 0),
  issued_on date not null default current_date,
  due_on    date not null,

  parent_receivable_id uuid,
  installment_number   integer not null default 1 check (installment_number >= 1),
  installment_total    integer not null default 1 check (installment_total >= 1),

  status text not null default 'draft' check (status in (
    'draft', 'open', 'received', 'cancelled'
  )),

  received_on      date,
  received_amount  numeric(14,2) check (received_amount is null or received_amount > 0),
  bank_account_id  uuid,
  bank_movement_id uuid,

  notes      text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint uq_receivables_id_tenant unique (id, tenant_id),
  constraint fk_receivable_client foreign key (client_id, tenant_id)
    references public.clients (id, tenant_id) on delete restrict,
  constraint fk_receivable_sla_contract foreign key (sla_contract_id, tenant_id)
    references public.sla_contracts (id, tenant_id) on delete restrict,
  constraint fk_receivable_cost_center foreign key (cost_center_id, tenant_id)
    references public.cost_centers (id, tenant_id) on delete restrict,
  constraint fk_receivable_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete restrict,
  constraint fk_receivable_parent foreign key (parent_receivable_id, tenant_id)
    references public.receivables (id, tenant_id) on delete cascade,
  constraint fk_receivable_bank_account foreign key (bank_account_id, tenant_id)
    references public.bank_accounts (id, tenant_id) on delete restrict,
  constraint receivables_installment_coherent
    check (installment_number <= installment_total),
  -- `received_amount` separado de `amount` porque recebimento parcial e desconto
  -- acontecem, e sobrescrever o valor original apagaria a diferença.
  constraint receivables_received_has_evidence
    check (status <> 'received' or (received_on is not null and bank_account_id is not null))
);

create index idx_receivables_tenant_due on public.receivables (tenant_id, due_on)
  where deleted_at is null;
create index idx_receivables_status on public.receivables (tenant_id, status)
  where deleted_at is null;
create index idx_receivables_client on public.receivables (client_id)
  where deleted_at is null;

comment on table public.receivables is
  'Títulos a receber. Sem aprovação: o controle é a baixa, não a autorização.';

-- -----------------------------------------------------------------------------
-- A alçada, em função
-- -----------------------------------------------------------------------------
/**
 * Níveis de aprovação exigidos para um título.
 *
 * Devolve array vazio quando não há nada a aprovar — e é aí que o título nasce
 * aprovado. Regra de escopo: a linha mais específica ganha, então uma regra com
 * `cost_center_id` preenchido só se aplica àquele centro, e uma com nulo se
 * aplica a todos.
 *
 * Levanta exceção no único caso ambíguo: aprovação LIGADA e nenhuma regra que
 * cubra o valor. Deixar passar silenciosamente aprovaria sem alçada; deixar
 * parado sem erro esconderia a causa de o título nunca andar.
 */
create or replace function app.required_approval_levels(
  p_tenant_id      uuid,
  p_amount         numeric,
  p_cost_center_id uuid default null,
  p_branch_id      uuid default null
)
returns integer[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_required boolean;
  v_levels   integer[];
begin
  select payable_approval_required into v_required
  from public.tenants where id = p_tenant_id;

  if not coalesce(v_required, false) then
    return array[]::integer[];
  end if;

  select array_agg(distinct r.level order by r.level) into v_levels
  from public.approval_rules r
  where r.tenant_id = p_tenant_id
    and r.is_active
    and p_amount >= r.min_amount
    and (r.max_amount is null or p_amount <= r.max_amount)
    and (r.cost_center_id is null or r.cost_center_id = p_cost_center_id)
    and (r.branch_id is null or r.branch_id = p_branch_id);

  if v_levels is null or array_length(v_levels, 1) = 0 then
    raise exception
      'Aprovação de títulos está ligada, mas nenhuma faixa de alçada cobre % . Cadastre a alçada em approval_rules ou desligue tenants.payable_approval_required.',
      to_char(p_amount, 'FM999G999G990D00')
      using errcode = 'check_violation';
  end if;

  return v_levels;
end;
$$;

comment on function app.required_approval_levels(uuid, numeric, uuid, uuid) is
  'Níveis de alçada exigidos. Array vazio = não precisa aprovar. Exceção = ligado sem regra que cubra o valor.';

/**
 * Máquina de estados do título a pagar.
 *
 * Escrita como função, e não como tabela de transições no estilo de
 * `ticket_status_transitions` (0005), por um motivo: o fluxo do ticket é
 * personalizado por cliente, e por isso vive como dado. O do título é imposto por
 * contabilidade — não existe cliente que queira "pago" antes de "aprovado" — e
 * como dado só abriria porta para configurar um fluxo inválido.
 */
create or replace function app.payables_guard()
returns trigger
language plpgsql
as $$
declare
  v_permitido text[];
begin
  if tg_op = 'INSERT' then
    -- Título nasce em draft ou já aprovado (quando não há alçada). Nascer pago
    -- pularia o rastro de aprovação inteiro.
    if new.status not in ('draft', 'pending_approval', 'approved') then
      raise exception 'Título não pode ser criado com situação %', new.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if old.status = new.status then
    -- Edição de conteúdo. Título pago é imutável: alterar valor depois da baixa
    -- descolaria o título da movimentação bancária que o pagou.
    if old.status = 'paid' and (
      new.amount <> old.amount or new.due_on <> old.due_on
      or coalesce(new.supplier_id::text, '') <> coalesce(old.supplier_id::text, '')
    ) then
      raise exception 'Título pago não pode ter valor, vencimento ou fornecedor alterados'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  v_permitido := case old.status
    when 'draft'            then array['pending_approval', 'approved', 'cancelled']
    when 'pending_approval' then array['approved', 'rejected', 'cancelled']
    when 'approved'         then array['scheduled', 'paid', 'cancelled']
    when 'scheduled'        then array['paid', 'approved', 'cancelled']
    when 'rejected'         then array['draft', 'cancelled']
    -- Estorno existe: pagamento errado acontece e a contabilidade precisa
    -- desfazer. Volta para `approved`, não para `draft`, porque a aprovação que
    -- autorizou o pagamento continua válida.
    when 'paid'             then array['approved']
    when 'cancelled'        then array[]::text[]
    else array[]::text[]
  end;

  if not (new.status = any (v_permitido)) then
    raise exception 'Transição de título inválida: % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if new.status = 'approved' and old.status = 'pending_approval' then
    new.approved_at := coalesce(new.approved_at, now());
    new.approved_by := coalesce(new.approved_by, app.current_user_id());
  end if;

  -- Estorno limpa o rastro de pagamento: manter `paid_on` num título que voltou
  -- a "aprovado" faria o relatório contá-lo como pago.
  if old.status = 'paid' and new.status = 'approved' then
    new.paid_on := null;
    new.bank_movement_id := null;
  end if;

  return new;
end;
$$;

create trigger trg_payables_guard
  before insert or update on public.payables
  for each row execute function app.payables_guard();

create or replace function app.receivables_guard()
returns trigger
language plpgsql
as $$
declare
  v_permitido text[];
begin
  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'open') then
      raise exception 'Título a receber não pode ser criado com situação %', new.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if old.status = new.status then
    return new;
  end if;

  v_permitido := case old.status
    when 'draft'     then array['open', 'cancelled']
    when 'open'      then array['received', 'cancelled']
    when 'received'  then array['open']   -- estorno de baixa
    when 'cancelled' then array[]::text[]
    else array[]::text[]
  end;

  if not (new.status = any (v_permitido)) then
    raise exception 'Transição de título a receber inválida: % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if old.status = 'received' and new.status = 'open' then
    new.received_on := null;
    new.received_amount := null;
    new.bank_movement_id := null;
  end if;

  return new;
end;
$$;

create trigger trg_receivables_guard
  before insert or update on public.receivables
  for each row execute function app.receivables_guard();

-- -----------------------------------------------------------------------------
-- Anexo de título entra no mapa do bucket
-- -----------------------------------------------------------------------------
-- Substitui a função da 0019 acrescentando a entidade `titulos`. O `else null`
-- continua sendo a decisão de segurança: entidade fora do mapa não tem chave, e
-- sem chave `app.can_touch_attachment()` nega.
create or replace function app.storage_permission_key(p_entity text, p_verb text)
returns text
language sql
immutable
as $$
  select case p_entity
    when 'tickets' then case p_verb
      when 'ver'     then 'helpdesk.tickets.ver'
      when 'anexar'  then 'helpdesk.tickets.anexar'
      when 'remover' then 'helpdesk.tickets.remover_anexo'
      else null end
    when 'ativos' then case p_verb
      when 'ver'     then 'inventario.ativos.ver'
      when 'anexar'  then 'inventario.ativos.anexar'
      when 'remover' then 'inventario.ativos.remover_anexo'
      else null end
    when 'linhas' then case p_verb
      when 'ver'     then 'telefonia.linhas.ver'
      when 'anexar'  then 'telefonia.linhas.anexar'
      when 'remover' then 'telefonia.linhas.remover_anexo'
      else null end
    when 'titulos' then case p_verb
      when 'ver'     then 'financeiro.titulos_pagar.ver'
      when 'anexar'  then 'financeiro.titulos_pagar.anexar'
      when 'remover' then 'financeiro.titulos_pagar.remover_anexo'
      else null end
    else null
  end;
$$;

/**
 * Fachada em `public` para a aplicação chamar por RPC.
 *
 * O tenant NÃO é parâmetro: vem de `app.current_tenant_id()`, ou seja, do JWT.
 * Aceitar o tenant como argumento deixaria a aplicação escolher de qual tenant
 * ler a alçada — exatamente o furo que o ADR-002 fecha ao manter o claim fora do
 * alcance do cliente.
 */
create or replace function public.required_approval_levels_for(
  p_amount         numeric,
  p_cost_center_id uuid default null,
  p_branch_id      uuid default null
)
returns integer[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.required_approval_levels(
    app.current_tenant_id(), p_amount, p_cost_center_id, p_branch_id);
$$;

revoke all on function public.required_approval_levels_for(numeric, uuid, uuid) from public;
grant execute on function public.required_approval_levels_for(numeric, uuid, uuid) to authenticated;

comment on function public.required_approval_levels_for(numeric, uuid, uuid) is
  'Fachada RPC da alçada. O tenant vem do JWT, nunca do cliente.';

-- -----------------------------------------------------------------------------
-- RLS e auditoria
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'expense_categories', 'approval_rules', 'payables',
    'payable_approvals', 'payable_attachments', 'receivables'
  ]
  loop
    perform app.harden_table(format('public.%s', t)::regclass);
    perform app.attach_audit(format('public.%s', t)::regclass);

    execute format($f$
      create policy %1$s_select on public.%1$s
        for select to authenticated
        using (tenant_id = app.current_tenant_id());
    $f$, t);
    execute format($f$
      create policy %1$s_insert on public.%1$s
        for insert to authenticated
        with check (tenant_id = app.current_tenant_id() and app.can_manage_records());
    $f$, t);
    execute format($f$
      create policy %1$s_update on public.%1$s
        for update to authenticated
        using (tenant_id = app.current_tenant_id() and app.can_manage_records())
        with check (tenant_id = app.current_tenant_id());
    $f$, t);
    execute format($f$
      create policy %1$s_delete on public.%1$s
        for delete to authenticated
        using (tenant_id = app.current_tenant_id() and app.can_manage_records());
    $f$, t);
    execute format('grant select, insert, update, delete on public.%s to authenticated', t);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Visão consolidada dos títulos
-- -----------------------------------------------------------------------------
-- `security_invoker` obrigatório: sem ele a view rodaria com privilégio do dono e
-- ignoraria o RLS das tabelas base, virando vazamento entre tenants.
create view public.vw_payables_summary
  with (security_invoker = true) as
select
  p.tenant_id,
  p.status,
  count(*)                                              as titulos,
  sum(p.amount)                                         as total,
  count(*) filter (where p.due_on < current_date
                     and p.status not in ('paid', 'cancelled')) as vencidos,
  sum(p.amount) filter (where p.due_on < current_date
                     and p.status not in ('paid', 'cancelled')) as total_vencido,
  count(*) filter (where p.due_on between current_date and current_date + 7
                     and p.status not in ('paid', 'cancelled')) as vence_em_7_dias
from public.payables p
where p.deleted_at is null
group by p.tenant_id, p.status;

comment on view public.vw_payables_summary is
  'Títulos a pagar agregados por situação, com vencidos e a vencer em 7 dias.';

-- -----------------------------------------------------------------------------
-- Chaves novas no catálogo
-- -----------------------------------------------------------------------------
-- Em sincronia com PERMISSION_CATALOG em src/lib/permissions.ts.
--
-- `configurar` cobre alçada E categorias de despesa numa chave só, porque as duas
-- são "configurar o módulo de títulos" e nenhuma tem tela própria — chave para
-- tela que não existe é configuração morta.
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('financeiro.titulos_pagar', 'financeiro', 'titulos_pagar', null,
   'Títulos a pagar', 'gestor', 600),
  ('financeiro.titulos_pagar.ver', 'financeiro', 'titulos_pagar', 'ver',
   'Consultar títulos a pagar', 'gestor', 601),
  ('financeiro.titulos_pagar.criar', 'financeiro', 'titulos_pagar', 'criar',
   'Lançar despesa', 'gestor', 602),
  ('financeiro.titulos_pagar.editar', 'financeiro', 'titulos_pagar', 'editar',
   'Editar título', 'gestor', 603),
  ('financeiro.titulos_pagar.aprovar', 'financeiro', 'titulos_pagar', 'aprovar',
   'Aprovar ou reprovar', 'gestor', 604),
  ('financeiro.titulos_pagar.pagar', 'financeiro', 'titulos_pagar', 'pagar',
   'Dar baixa no pagamento', 'gestor', 605),
  ('financeiro.titulos_pagar.cancelar', 'financeiro', 'titulos_pagar', 'cancelar',
   'Cancelar título', 'gestor', 606),
  ('financeiro.titulos_pagar.configurar', 'financeiro', 'titulos_pagar', 'configurar',
   'Configurar alçada e categorias', 'admin', 607),
  ('financeiro.titulos_pagar.anexar', 'financeiro', 'titulos_pagar', 'anexar',
   'Anexar NF, boleto ou comprovante', 'gestor', 608),
  ('financeiro.titulos_pagar.remover_anexo', 'financeiro', 'titulos_pagar', 'remover_anexo',
   'Remover anexo do título', 'gestor', 609),

  ('financeiro.titulos_receber', 'financeiro', 'titulos_receber', null,
   'Títulos a receber', 'gestor', 620),
  ('financeiro.titulos_receber.ver', 'financeiro', 'titulos_receber', 'ver',
   'Consultar títulos a receber', 'gestor', 621),
  ('financeiro.titulos_receber.criar', 'financeiro', 'titulos_receber', 'criar',
   'Lançar título a receber', 'gestor', 622),
  ('financeiro.titulos_receber.editar', 'financeiro', 'titulos_receber', 'editar',
   'Editar título a receber', 'gestor', 623),
  ('financeiro.titulos_receber.baixar', 'financeiro', 'titulos_receber', 'baixar',
   'Dar baixa no recebimento', 'gestor', 624),
  ('financeiro.titulos_receber.cancelar', 'financeiro', 'titulos_receber', 'cancelar',
   'Cancelar título a receber', 'gestor', 625)
on conflict (key) do update
  set label = excluded.label, min_base_role = excluded.min_base_role,
      sort_order = excluded.sort_order;

-- -----------------------------------------------------------------------------
-- Os perfis financeiros passam a alcançar as telas novas
-- -----------------------------------------------------------------------------
-- Substitui a função da 0017. As mudanças são cirúrgicas, e não por nome de ação:
-- dar `criar` a todo o módulo faria o Operador Financeiro cadastrar CONTA
-- BANCÁRIA, que é exatamente o que o perfil dele não deve poder.
create or replace function app.seed_system_access_profiles(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile record;
begin
  insert into public.access_profiles (tenant_id, name, description, base_role, is_system, system_key)
  values
    (p_tenant_id, 'Admin do Cliente',
     'Acesso total ao ambiente do cliente.', 'admin', true, 'admin_cliente'),
    (p_tenant_id, 'Diretoria',
     'Leitura de tudo que o papel gestor alcança, sem escrita.', 'gestor', true, 'diretoria'),
    (p_tenant_id, 'Gestor de TI',
     'Operação de TI completa: helpdesk, inventário, telefonia, mapas, SLA e cadastros.',
     'gestor', true, 'gestor_ti'),
    (p_tenant_id, 'Operador de TI',
     'Atende ticket e consulta inventário e telefonia; não cadastra.', 'atendente', true, 'operador_ti'),
    (p_tenant_id, 'Gestor Financeiro',
     'Financeiro completo, mais fornecedores e leitura de clientes.', 'gestor', true, 'gestor_financeiro'),
    (p_tenant_id, 'Operador Financeiro',
     'Lança despesa e movimentação; não cadastra conta, não transfere e não aprova.',
     'gestor', true, 'operador_financeiro'),
    (p_tenant_id, 'Aprovador Financeiro',
     'Consulta o financeiro e aprova o que a alçada permitir.', 'gestor', true, 'aprovador_financeiro'),
    (p_tenant_id, 'Visualizador',
     'Somente leitura do que o papel visualizador alcança.', 'visualizador', true, 'visualizador'),
    (p_tenant_id, 'Solicitante',
     'Abre e acompanha os próprios tickets; consulta o que o papel alcança.',
     'solicitante', true, 'solicitante')
  on conflict do nothing;

  for v_profile in
    select id, base_role, system_key from public.access_profiles
    where tenant_id = p_tenant_id and is_system
  loop
    insert into public.permission_grants (tenant_id, profile_id, permission_key)
    select p_tenant_id, v_profile.id, c.key
    from public.permission_catalog c
    where app.role_rank(c.min_base_role) <= app.role_rank(v_profile.base_role)
      and case v_profile.system_key
        when 'admin_cliente' then true

        when 'diretoria'    then c.action is null or c.action = 'ver'
        when 'visualizador' then c.action is null or c.action = 'ver'

        when 'gestor_ti' then c.module in
          ('helpdesk','inventario','telefonia','mapas','sla','clientes','fornecedores','tv')

        when 'operador_ti' then
          c.module = 'helpdesk'
          or (c.module in ('inventario','telefonia','mapas') and (c.action is null or c.action = 'ver'))

        when 'gestor_financeiro' then
          c.module in ('financeiro','fornecedores')
          or (c.module = 'clientes' and (c.action is null or c.action = 'ver'))
          or c.key in ('sla','sla.compliance','sla.compliance.ver')

        -- Lançar despesa e anexar comprovante É o trabalho do operador. Aprovar,
        -- pagar e configurar alçada não são — e continuam de fora.
        when 'operador_financeiro' then
          c.module = 'financeiro'
          and (c.action is null
               or c.action in ('ver','movimentar')
               or (c.screen in ('titulos_pagar','titulos_receber')
                   and c.action in ('criar','editar','anexar','remover_anexo')))

        -- Agora o Aprovador tem de fato o que aprovar.
        when 'aprovador_financeiro' then
          c.module = 'financeiro'
          and (c.action is null
               or c.action = 'ver'
               or (c.screen = 'titulos_pagar' and c.action = 'aprovar'))

        when 'solicitante' then true

        else false
      end
    on conflict do nothing;
  end loop;
end;
$$;

comment on function app.seed_system_access_profiles(uuid) is
  'Cria (idempotente) os perfis de sistema e suas concessões para um tenant.';

-- Redistribui as chaves novas pelos perfis dos tenants que já existem. Sem isto,
-- um Gestor Financeiro provisionado antes desta migração não veria as telas
-- novas, e ninguém saberia que faltava marcar algo à mão.
do $$
declare
  v_tenant uuid;
begin
  for v_tenant in select id from public.tenants loop
    perform app.seed_system_access_profiles(v_tenant);
  end loop;
end;
$$;



-- =============================================================================
-- ARQUIVO 21 de 23: 0021_fluxo_de_caixa.sql
-- =============================================================================

-- =============================================================================
-- 0021 — Fluxo de caixa: projeção sobre o que já está lançado
-- =============================================================================
-- Fecha o MÓDULO 7 de docs/07. Não cria tabela nenhuma: a projeção é derivada de
-- `bank_accounts` + `bank_account_movements` + `payables` + `receivables`, todos
-- entregues nas migrações 0018 e 0020.
--
-- O QUE ESTA TELA PROJETA, E O QUE ELA NÃO PROJETA
-- ------------------------------------------------
-- Projeta o COMPROMETIDO: um título aprovado com vencimento em 10/nov é uma
-- obrigação registrada, não estimativa. Isso é dado real.
--
-- NÃO projeta tendência. `payables.paid_on` está vazio nesta base — não há
-- histórico de pagamento —, então nada de média de atraso, sazonalidade ou
-- previsão de faturamento. Número inventado com casa decimal parece mais
-- confiável que número nenhum, e é pior.
--
-- POR QUE NO BANCO E NÃO EM TYPESCRIPT
-- ------------------------------------
-- "Qual situação conta como previsto" é regra financeira, e aqui ela pode ser
-- PROVADA: `supabase/tests/schema_test.sql` roda contra PostgreSQL real com papel
-- sem `bypassrls`. O vitest desta base não tem banco.
--
-- POR QUE NÃO É `security definer`
-- --------------------------------
-- Nada aqui precisa furar o RLS. Sendo invoker, a consulta enxerga exatamente o
-- que a sessão enxerga — inclusive o escopo por filial. E não há fachada em `app`
-- como a de `required_approval_levels_for()` porque não há parâmetro de tenant a
-- proteger: o tenant vem do RLS das tabelas base.
-- =============================================================================


/**
 * Projeção de caixa por mês.
 *
 * O QUE ENTRA (e cada exclusão tem motivo, não é esquecimento):
 *
 *   payables.draft             NÃO — alguém ainda digitando não é compromisso.
 *   payables.pending_approval  SIM — a despesa já foi incorrida; excluir deixaria
 *                                    a projeção otimista. Volta somada, e a tela
 *                                    mostra o valor à parte para quem quiser
 *                                    subtrair.
 *   payables.approved          SIM
 *   payables.scheduled         SIM
 *   payables.rejected          NÃO — não será pago.
 *   payables.paid              NÃO — já está no saldo bancário. Incluir seria
 *                                    contar o mesmo dinheiro duas vezes.
 *   payables.cancelled         NÃO
 *
 *   receivables.open           SIM — única entrada prevista.
 *   receivables.draft          NÃO — não emitido.
 *   receivables.received       NÃO — já está no saldo.
 *   receivables.cancelled      NÃO
 *
 * TÍTULO VENCIDO E NÃO PAGO é obrigação real: não pode sumir da conta. Entra no
 * mês corrente com dia efetivo = hoje (`greatest(due_on, current_date)`) e volta
 * destacado em `overdue_inflow`/`overdue_outflow`, para a tela poder dizer quanto
 * do mês atual é atraso e não previsão.
 *
 * SALDO DE D0 — a armadilha que este código evita:
 * `vw_bank_account_balances.current_balance` NÃO tem corte de data, e
 * `bank_account_movements.moved_on` é uma `date` livre. Um lançamento datado no
 * futuro já está dentro daquele saldo hoje. Usá-lo como ponto de partida e depois
 * projetar o mesmo mês contaria o valor duas vezes. Aqui o saldo de D0 é
 * `opening_balance` mais os movimentos ATÉ hoje, e os movimentos futuros entram
 * como terceiro braço da projeção.
 *
 * INADIMPLÊNCIA é parâmetro, não regra: nenhum percentual está escrito em
 * documento de negócio algum, e três percentuais escolhidos por mim seriam regra
 * inventada com cara de fato. Mesma decisão da alçada na 0020, que nasce vazia.
 * Padrão 0 = todos os recebíveis entram integralmente.
 *
 * FILTRO POR CONTA BANCÁRIA foi deliberadamente NÃO implementado, embora docs/07
 * o cite. Título em aberto quase nunca tem `bank_account_id` — a conta só é
 * gravada na baixa —, então filtrar por conta esvaziaria a projeção e pareceria
 * "não há nada a pagar". Filtro que mente é pior que filtro ausente.
 */
create or replace function public.cash_flow_projection(
  p_months           integer default 12,
  p_delinquency_rate numeric default 0,
  p_branch_id        uuid    default null,
  p_cost_center_id   uuid    default null
)
returns table (
  bucket_start      date,
  inflow            numeric,
  outflow           numeric,
  net               numeric,
  running_balance   numeric,
  payables_count    integer,
  receivables_count integer,
  overdue_inflow    numeric,
  overdue_outflow   numeric,
  peak_day          date,
  peak_day_outflow  numeric
)
language sql
stable
as $$
with p as (
  -- Teto de 36 meses e piso de 1: o parâmetro vem da barra de endereço, e
  -- `?meses=100000` geraria cem mil linhas sem que ninguém tivesse pedido isso.
  select
    greatest(1, least(coalesce(p_months, 12), 36))                    as months,
    least(greatest(coalesce(p_delinquency_rate, 0), 0), 100) / 100.0  as rate,
    date_trunc('month', current_date)::date                           as first_month
),
baldes as (
  select (p.first_month + make_interval(months => n::int))::date as bucket_start
  from p, generate_series(0, p.months - 1) as n
),
horizonte as (
  select (max(bucket_start) + interval '1 month' - interval '1 day')::date as ate
  from baldes
),
-- Movimentos de conta não excluída. `bank_account_movements` não tem
-- `deleted_at`; a junção é o que impede somar movimento de conta apagada.
movimentos as (
  select m.direction, m.amount, m.moved_on, m.cost_center_id
  from public.bank_account_movements m
  join public.bank_accounts a
    on a.id = m.bank_account_id and a.deleted_at is null
),
saldo_d0 as (
  select
    (select coalesce(sum(opening_balance), 0)
       from public.bank_accounts where deleted_at is null)
  + (select coalesce(sum(case when direction = 'in' then amount else -amount end), 0)
       from movimentos where moved_on <= current_date)
    as valor
),
fluxos as (
  select
    greatest(pa.due_on, current_date) as efetivo,
    0::numeric                        as entrada,
    pa.amount                         as saida,
    (pa.due_on < current_date)        as vencido,
    1                                 as e_pagar,
    0                                 as e_receber
  from public.payables pa
  where pa.deleted_at is null
    and pa.status in ('pending_approval', 'approved', 'scheduled')
    and (p_branch_id is null or pa.branch_id = p_branch_id)
    and (p_cost_center_id is null or pa.cost_center_id = p_cost_center_id)

  union all

  select
    greatest(re.due_on, current_date),
    round(re.amount * (1 - (select rate from p)), 2),
    0::numeric,
    (re.due_on < current_date),
    0, 1
  from public.receivables re
  where re.deleted_at is null
    and re.status = 'open'
    and (p_branch_id is null or re.branch_id = p_branch_id)
    and (p_cost_center_id is null or re.cost_center_id = p_cost_center_id)

  union all

  -- Movimento bancário datado no futuro: já existe, ainda não aconteceu.
  -- Sai da conta quando há filtro de filial porque movimento bancário não tem
  -- filial — atribuí-lo a uma seria inventar o dado.
  select
    mv.moved_on,
    case when mv.direction = 'in'  then mv.amount else 0 end,
    case when mv.direction = 'out' then mv.amount else 0 end,
    false, 0, 0
  from movimentos mv
  where mv.moved_on > current_date
    and p_branch_id is null
    and (p_cost_center_id is null or mv.cost_center_id = p_cost_center_id)
),
por_balde as (
  select
    date_trunc('month', f.efetivo)::date              as bucket_start,
    sum(f.entrada)                                    as inflow,
    sum(f.saida)                                      as outflow,
    coalesce(sum(f.entrada) filter (where f.vencido), 0) as overdue_inflow,
    coalesce(sum(f.saida)   filter (where f.vencido), 0) as overdue_outflow,
    sum(f.e_pagar)                                    as payables_count,
    sum(f.e_receber)                                  as receivables_count
  from fluxos f
  where f.efetivo <= (select ate from horizonte)
  group by 1
),
-- Maior dia de saída DENTRO de cada mês: dá a granularidade de dia sem devolver
-- uma linha por dia. É observação, não alarme — quem lê decide o que fazer com
-- "12/nov concentra 40% do mês".
picos as (
  select
    date_trunc('month', f.efetivo)::date as bucket_start,
    f.efetivo                            as dia,
    sum(f.saida)                         as saida_dia,
    row_number() over (
      partition by date_trunc('month', f.efetivo)
      order by sum(f.saida) desc, f.efetivo
    ) as rn
  from fluxos f
  where f.efetivo <= (select ate from horizonte)
    and f.saida > 0
  group by 1, 2
)
select
  b.bucket_start,
  coalesce(q.inflow, 0),
  coalesce(q.outflow, 0),
  coalesce(q.inflow, 0) - coalesce(q.outflow, 0),
  (select valor from saldo_d0)
    + sum(coalesce(q.inflow, 0) - coalesce(q.outflow, 0))
        over (order by b.bucket_start rows between unbounded preceding and current row),
  coalesce(q.payables_count, 0)::integer,
  coalesce(q.receivables_count, 0)::integer,
  q.overdue_inflow,
  q.overdue_outflow,
  pk.dia,
  coalesce(pk.saida_dia, 0)
from baldes b
left join por_balde q on q.bucket_start = b.bucket_start
left join picos    pk on pk.bucket_start = b.bucket_start and pk.rn = 1
order by b.bucket_start;
$$;

revoke all on function public.cash_flow_projection(integer, numeric, uuid, uuid) from public;
grant execute on function public.cash_flow_projection(integer, numeric, uuid, uuid) to authenticated;

comment on function public.cash_flow_projection(integer, numeric, uuid, uuid) is
  'Projeção mensal de caixa sobre títulos comprometidos. `security invoker`: enxerga o que a sessão enxerga.';

-- -----------------------------------------------------------------------------
-- Chaves novas no catálogo
-- -----------------------------------------------------------------------------
-- Em sincronia com PERMISSION_CATALOG em src/lib/permissions.ts.
--
-- DUAS chaves, e só duas: a tela não escreve nada. Uma chave `configurar` não
-- governaria coisa alguma — o percentual de inadimplência é parâmetro de consulta,
-- não configuração gravada —, e chave que não governa nada é o defeito já
-- corrigido em seis chaves nesta base.
--
-- Ficar DENTRO do módulo `financeiro`, em vez de virar módulo próprio, é o que faz
-- `app.seed_system_access_profiles()` conceder a tela ao Gestor Financeiro
-- automaticamente (regra `c.module = 'financeiro'`) e o `.ver` ao Operador e ao
-- Aprovador (regra `c.action = 'ver'`), sem tocar na função.
--
-- `sort_order` 890-891: continua depois da última chave do módulo
-- (`financeiro.contas_bancarias.transferir`, 880 na 0017), que é a mesma posição
-- que as entradas ocupam no array de `src/lib/permissions.ts`. Manter a ordem do
-- banco igual à ordem do TypeScript evita que a matriz de perfis e o catálogo
-- contem histórias diferentes.
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('financeiro.fluxo_caixa', 'financeiro', 'fluxo_caixa', null,
   'Fluxo de caixa', 'gestor', 890),
  ('financeiro.fluxo_caixa.ver', 'financeiro', 'fluxo_caixa', 'ver',
   'Consultar a projeção', 'gestor', 891)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

-- Perfis de sistema já provisionados não conhecem as chaves novas. A função
-- expressa as concessões como REGRA sobre o catálogo, então rodá-la de novo
-- distribui as chaves novas sem duplicar as antigas.
do $$
declare
  v_tenant uuid;
begin
  for v_tenant in select id from public.tenants loop
    perform app.seed_system_access_profiles(v_tenant);
  end loop;
end;
$$;



-- =============================================================================
-- ARQUIVO 22 de 23: 0022_conectividade_links.sql
-- =============================================================================

-- =============================================================================
-- 0022 — Conectividade: a tela de Links de Internet ganha permissões
-- =============================================================================
-- Sem DDL de tabela: `internet_links`, `internet_link_attachments`,
-- `link_availability_events` e as views `vw_internet_dashboard` e
-- `vw_connectivity_cost` existem desde a 0013. Faltava a TELA — e é a tela que
-- autoriza as chaves.
--
-- A 0019 deixou isto escrito, dentro do docblock de `app.storage_permission_key`:
--
--   "`links` está deliberadamente FORA. A tabela `internet_link_attachments`
--    existe (0013:496), mas a tela de Links de Internet não existe na aplicação —
--    só no protótipo. Cadastrar `conectividade.links.anexar` agora criaria
--    permissão que não governa tela nenhuma... Entra junto com a tela."
--
-- É esta migração.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Chaves novas no catálogo
-- -----------------------------------------------------------------------------
-- Em sincronia com PERMISSION_CATALOG em src/lib/permissions.ts.
--
-- `sort_order` 481-489 é exatamente o vão livre entre a última chave de telefonia
-- (480) e a primeira de clientes (490) — nove posições para nove chaves. Cabe
-- porque nada em `src/` lê `permission_catalog.sort_order` (a coluna só ordena a
-- listagem no banco) e porque `on conflict do update` permite renumerar depois.
-- Manter a ordem do banco igual à ordem do array em TypeScript evita que a matriz
-- de perfis e o catálogo contem histórias diferentes.
--
-- `registrar_evento` é `gestor`, não `atendente`. A policy de escrita de
-- `link_availability_events` (0013) exige `app.can_manage_records()`, que é gestor
-- para cima; uma chave em `atendente` liberaria o botão e o banco negaria
-- devolvendo zero linhas. Permissão que não governa nada é o defeito que esta base
-- já corrigiu duas vezes — afrouxar a policy é decisão do cliente, não desta
-- migração.
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('conectividade', 'conectividade', null, null,
   'Conectividade', 'visualizador', 481),
  ('conectividade.links', 'conectividade', 'links', null,
   'Links de internet', 'visualizador', 482),
  ('conectividade.links.ver', 'conectividade', 'links', 'ver',
   'Consultar links', 'visualizador', 483),
  ('conectividade.links.criar', 'conectividade', 'links', 'criar',
   'Cadastrar link', 'gestor', 484),
  ('conectividade.links.editar', 'conectividade', 'links', 'editar',
   'Editar link', 'gestor', 485),
  ('conectividade.links.mudar_status', 'conectividade', 'links', 'mudar_status',
   'Suspender/cancelar link', 'gestor', 486),
  ('conectividade.links.registrar_evento', 'conectividade', 'links', 'registrar_evento',
   'Registrar queda ou retorno', 'gestor', 487),
  ('conectividade.links.anexar', 'conectividade', 'links', 'anexar',
   'Anexar contrato ou laudo', 'gestor', 488),
  ('conectividade.links.remover_anexo', 'conectividade', 'links', 'remover_anexo',
   'Remover anexo do link', 'gestor', 489)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

-- -----------------------------------------------------------------------------
-- 2. O bucket passa a aceitar anexo de link
-- -----------------------------------------------------------------------------
-- Só o mapa muda; o predicado `app.can_touch_attachment()` da 0019 continua o
-- mesmo, inclusive negando por omissão para entidade desconhecida.
create or replace function app.storage_permission_key(p_entity text, p_verb text)
returns text
language sql
immutable
as $$
  select case p_entity
    when 'tickets' then case p_verb
      when 'ver'     then 'helpdesk.tickets.ver'
      when 'anexar'  then 'helpdesk.tickets.anexar'
      when 'remover' then 'helpdesk.tickets.remover_anexo'
      else null end
    when 'ativos' then case p_verb
      when 'ver'     then 'inventario.ativos.ver'
      when 'anexar'  then 'inventario.ativos.anexar'
      when 'remover' then 'inventario.ativos.remover_anexo'
      else null end
    when 'linhas' then case p_verb
      when 'ver'     then 'telefonia.linhas.ver'
      when 'anexar'  then 'telefonia.linhas.anexar'
      when 'remover' then 'telefonia.linhas.remover_anexo'
      else null end
    when 'titulos' then case p_verb
      when 'ver'     then 'financeiro.titulos_pagar.ver'
      when 'anexar'  then 'financeiro.titulos_pagar.anexar'
      when 'remover' then 'financeiro.titulos_pagar.remover_anexo'
      else null end
    when 'links' then case p_verb
      when 'ver'     then 'conectividade.links.ver'
      when 'anexar'  then 'conectividade.links.anexar'
      when 'remover' then 'conectividade.links.remover_anexo'
      else null end
    else null
  end;
$$;

-- -----------------------------------------------------------------------------
-- 3. O estado do link passa a ser derivado dos eventos
-- -----------------------------------------------------------------------------
-- `link_availability_events` grava a queda, mas `internet_links.last_state` e
-- `last_state_at` são colunas separadas e NADA as sincronizava — o protótipo fazia
-- isso no cliente. Dois caminhos de escrita (a tela e, no futuro, a Edge Function
-- do Zabbix) divergiriam no primeiro evento vindo de fora da tela.
--
-- A regra é recalculada, não incrementada: "há queda aberta?" responde certo
-- mesmo que os eventos cheguem fora de ordem, que é justamente o que um webhook
-- faz.
--
-- Sem `security definer` de propósito: quem consegue gravar o evento
-- (`can_manage_records`, pela policy da 0013) já consegue atualizar o link pela
-- mesma regra, então não há nada a contornar aqui.
create or replace function app.sync_link_state()
returns trigger
language plpgsql
as $$
declare
  v_link uuid := coalesce(new.link_id, old.link_id);
begin
  update public.internet_links k
     set last_state = case
           when exists (
             select 1 from public.link_availability_events e
             where e.link_id = k.id and e.state = 'down' and e.ended_at is null
           ) then 'down'
           -- Link sem host monitorado nunca é "no ar": é "não monitorado".
           -- Dizer "up" porque ninguém reportou queda seria afirmar o que não se
           -- sabe, e é a distinção que o protótipo já fazia.
           when k.monitoring_host is null or btrim(k.monitoring_host) = '' then 'unknown'
           else 'up'
         end,
         last_state_at = now()
   where k.id = v_link;
  return null;
end;
$$;

comment on function app.sync_link_state() is
  'Mantém internet_links.last_state coerente com os eventos de disponibilidade.';

drop trigger if exists trg_link_event_syncs_state on public.link_availability_events;
create trigger trg_link_event_syncs_state
  after insert or update or delete on public.link_availability_events
  for each row execute function app.sync_link_state();

-- -----------------------------------------------------------------------------
-- 4. Os perfis de sistema precisam conhecer o módulo novo
-- -----------------------------------------------------------------------------
-- ISTO NÃO É FORMALIDADE. As regras de `app.seed_system_access_profiles()` são
-- POR MÓDULO, e `conectividade` não está em nenhuma delas. Sem esta alteração as
-- nove chaves iriam só para Admin do Cliente, Diretoria e Visualizador — e o
-- Gestor de TI, que é exatamente quem cuida de link de internet, não veria a tela.
-- Sintoma: menu faltando, não erro.
create or replace function app.seed_system_access_profiles(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile record;
begin
  insert into public.access_profiles (tenant_id, name, description, base_role, is_system, system_key)
  values
    (p_tenant_id, 'Admin do Cliente',
     'Acesso total ao ambiente do cliente.', 'admin', true, 'admin_cliente'),
    (p_tenant_id, 'Diretoria',
     'Leitura de tudo que o papel gestor alcança, sem escrita.', 'gestor', true, 'diretoria'),
    (p_tenant_id, 'Gestor de TI',
     'Operação de TI completa: helpdesk, inventário, telefonia, conectividade, mapas, SLA e cadastros.',
     'gestor', true, 'gestor_ti'),
    (p_tenant_id, 'Operador de TI',
     'Atende ticket e consulta inventário, telefonia e links; não cadastra.',
     'atendente', true, 'operador_ti'),
    (p_tenant_id, 'Gestor Financeiro',
     'Financeiro completo, mais fornecedores e leitura de clientes.', 'gestor', true, 'gestor_financeiro'),
    (p_tenant_id, 'Operador Financeiro',
     'Lança despesa e movimentação; não cadastra conta, não transfere e não aprova.',
     'gestor', true, 'operador_financeiro'),
    (p_tenant_id, 'Aprovador Financeiro',
     'Consulta o financeiro e aprova o que a alçada permitir.', 'gestor', true, 'aprovador_financeiro'),
    (p_tenant_id, 'Visualizador',
     'Somente leitura do que o papel visualizador alcança.', 'visualizador', true, 'visualizador'),
    (p_tenant_id, 'Solicitante',
     'Abre e acompanha os próprios tickets; consulta o que o papel alcança.',
     'solicitante', true, 'solicitante')
  on conflict do nothing;

  -- A descrição de dois perfis mudou junto com o módulo novo; `on conflict do
  -- nothing` acima não atualiza quem já existe, e um texto velho na tela de
  -- perfis é exatamente o tipo de mentira silenciosa que esta base persegue.
  update public.access_profiles set description =
    'Operação de TI completa: helpdesk, inventário, telefonia, conectividade, mapas, SLA e cadastros.'
   where tenant_id = p_tenant_id and system_key = 'gestor_ti';
  update public.access_profiles set description =
    'Atende ticket e consulta inventário, telefonia e links; não cadastra.'
   where tenant_id = p_tenant_id and system_key = 'operador_ti';

  for v_profile in
    select id, base_role, system_key from public.access_profiles
    where tenant_id = p_tenant_id and is_system
  loop
    insert into public.permission_grants (tenant_id, profile_id, permission_key)
    select p_tenant_id, v_profile.id, c.key
    from public.permission_catalog c
    where app.role_rank(c.min_base_role) <= app.role_rank(v_profile.base_role)
      and case v_profile.system_key
        when 'admin_cliente' then true

        when 'diretoria'    then c.action is null or c.action = 'ver'
        when 'visualizador' then c.action is null or c.action = 'ver'

        -- `conectividade` entra aqui: link de internet é parque de TI.
        when 'gestor_ti' then c.module in
          ('helpdesk','inventario','telefonia','conectividade','mapas','sla',
           'clientes','fornecedores','tv')

        when 'operador_ti' then
          c.module = 'helpdesk'
          or (c.module in ('inventario','telefonia','conectividade','mapas')
              and (c.action is null or c.action = 'ver'))

        when 'gestor_financeiro' then
          c.module in ('financeiro','fornecedores')
          or (c.module = 'clientes' and (c.action is null or c.action = 'ver'))
          or c.key in ('sla','sla.compliance','sla.compliance.ver')

        -- Lançar despesa e anexar comprovante É o trabalho do operador. Aprovar,
        -- pagar e configurar alçada não são — e continuam de fora.
        when 'operador_financeiro' then
          c.module = 'financeiro'
          and (c.action is null
               or c.action in ('ver','movimentar')
               or (c.screen in ('titulos_pagar','titulos_receber')
                   and c.action in ('criar','editar','anexar','remover_anexo')))

        when 'aprovador_financeiro' then
          c.module = 'financeiro'
          and (c.action is null
               or c.action = 'ver'
               or (c.screen = 'titulos_pagar' and c.action = 'aprovar'))

        when 'solicitante' then true

        else false
      end
    on conflict do nothing;
  end loop;
end;
$$;

comment on function app.seed_system_access_profiles(uuid) is
  'Cria os 9 perfis de sistema do tenant e concede as chaves por REGRA sobre o catálogo. Idempotente.';

do $$
declare
  v_tenant uuid;
begin
  for v_tenant in select id from public.tenants loop
    perform app.seed_system_access_profiles(v_tenant);
  end loop;
end;
$$;



-- =============================================================================
-- ARQUIVO 23 de 23: seed.sql — dados de exemplo
-- =============================================================================
-- Só faz sentido em banco novo ou de teste: cria 7 usuários em auth.users. Num
-- banco com dado real, apague daqui para baixo antes de rodar.

-- =============================================================================
-- Seed de demonstração — tenant "IAR Office" com dados realistas
-- =============================================================================
-- Em produção os usuários nascem no Supabase Auth (signup/convite) e o trigger de
-- provisionamento cria o profile. Aqui inserimos em auth.users diretamente porque
-- é ambiente local de desenvolvimento e queremos um dataset navegável.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Tenant
-- -----------------------------------------------------------------------------
insert into public.tenants (id, name, slug, cnpj) values
  ('a0000000-0000-4000-8000-000000000001', 'IAR Office Soluções', 'iaroffice', '12.345.678/0001-90');

-- -----------------------------------------------------------------------------
-- Calendário de atendimento: comercial 08–12 / 13–18, seg a sex
-- -----------------------------------------------------------------------------
insert into public.business_hours (id, tenant_id, name, timezone, is_default) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'Comercial (seg–sex)', 'America/Sao_Paulo', true),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   '24x7', 'America/Sao_Paulo', false);

update public.business_hours set is_24x7 = true where id = 'b0000000-0000-4000-8000-000000000002';

insert into public.business_hours_intervals (business_hours_id, weekday, starts_at, ends_at)
select 'b0000000-0000-4000-8000-000000000001', d, s, e
from generate_series(1, 5) as d,
     (values ('08:00'::time, '12:00'::time), ('13:00'::time, '18:00'::time)) as v(s, e);

insert into public.business_hours_holidays (business_hours_id, holiday_date, name) values
  ('b0000000-0000-4000-8000-000000000001', '2026-09-07', 'Independência'),
  ('b0000000-0000-4000-8000-000000000001', '2026-10-12', 'Nossa Senhora Aparecida'),
  ('b0000000-0000-4000-8000-000000000001', '2026-11-02', 'Finados'),
  ('b0000000-0000-4000-8000-000000000001', '2026-11-15', 'Proclamação da República'),
  ('b0000000-0000-4000-8000-000000000001', '2026-12-25', 'Natal');

-- -----------------------------------------------------------------------------
-- Prioridades — o `weight` alimenta o score de fila (RF-FIL-03)
-- -----------------------------------------------------------------------------
insert into public.ticket_priorities (id, tenant_id, key, label, weight, color, sort_order) values
  ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'critical', 'Crítica', 100, '#dc2626', 1),
  ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'high',     'Alta',     75, '#ea580c', 2),
  ('c0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'medium',   'Média',    45, '#ca8a04', 3),
  ('c0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'low',      'Baixa',    20, '#0891b2', 4);

-- -----------------------------------------------------------------------------
-- Categorias e subcategorias
-- -----------------------------------------------------------------------------
insert into public.ticket_categories (id, tenant_id, parent_id, name) values
  ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null, 'Infraestrutura'),
  ('d0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', null, 'Sistemas'),
  ('d0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', null, 'Telefonia'),
  ('d0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', null, 'Acessos');

insert into public.ticket_categories (id, tenant_id, parent_id, name) values
  ('d0000000-0000-4000-8000-000000000011', 'a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'Rede / Internet'),
  ('d0000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'Servidores'),
  ('d0000000-0000-4000-8000-000000000013', 'a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', 'ERP'),
  ('d0000000-0000-4000-8000-000000000014', 'a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000003', 'Linha móvel'),
  ('d0000000-0000-4000-8000-000000000015', 'a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000004', 'Reset de senha');

-- -----------------------------------------------------------------------------
-- Filas — a primeira é a padrão do sistema, protegida por trigger (RF-FIL-01)
-- -----------------------------------------------------------------------------
insert into public.queues (id, tenant_id, name, slug, description, is_system_default) values
  ('e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'Atendimento Geral', 'geral', 'Fila padrão do sistema. Recebe todo ticket sem roteamento específico.', true);

insert into public.queues (id, tenant_id, name, slug, description, weight_criticality, weight_deadline, weight_age) values
  ('e0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'Infraestrutura', 'infra', 'Rede, servidores e datacenter.', 70, 25, 5),
  ('e0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001',
   'Telefonia', 'telefonia', 'Linhas móveis e fixas.', 50, 30, 20);

-- Roteamento: categoria Telefonia → fila Telefonia; Infraestrutura → fila Infra.
insert into public.queue_rules (tenant_id, queue_id, name, conditions, sort_order) values
  ('a0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000003',
   'Telefonia por categoria',
   '{"category_id":"d0000000-0000-4000-8000-000000000003"}'::jsonb, 10),
  ('a0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002',
   'Infra por categoria',
   '{"category_id":"d0000000-0000-4000-8000-000000000001"}'::jsonb, 20);

-- -----------------------------------------------------------------------------
-- Clientes e filiais
-- -----------------------------------------------------------------------------
insert into public.clients (id, tenant_id, legal_name, trade_name, cnpj) values
  ('f0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'Grupo Meridiano Alimentos S.A.', 'Meridiano', '11.222.333/0001-44'),
  ('f0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'Construtora Vertex Ltda.', 'Vertex', '55.666.777/0001-88');

insert into public.branches (id, tenant_id, client_id, name, code, city, state, timezone, business_hours_id) values
  ('11110000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
   'Meridiano — Matriz São Paulo', 'MER-SP', 'São Paulo', 'SP', 'America/Sao_Paulo', 'b0000000-0000-4000-8000-000000000001'),
  ('11110000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
   'Meridiano — CD Campinas', 'MER-CPQ', 'Campinas', 'SP', 'America/Sao_Paulo', 'b0000000-0000-4000-8000-000000000001'),
  ('11110000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
   'Meridiano — Filial Manaus', 'MER-MAO', 'Manaus', 'AM', 'America/Manaus', 'b0000000-0000-4000-8000-000000000002'),
  ('11110000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002',
   'Vertex — Sede', 'VTX-SED', 'Belo Horizonte', 'MG', 'America/Sao_Paulo', 'b0000000-0000-4000-8000-000000000001');

-- -----------------------------------------------------------------------------
-- Usuários
-- -----------------------------------------------------------------------------
-- O claim tenant_id vai em app_metadata (ADR-002) — nunca em user_metadata.
insert into auth.users (id, email, raw_app_meta_data) values
  ('22220000-0000-4000-8000-000000000001', 'admin@iaroffice.com.br',
   '{"tenant_id":"a0000000-0000-4000-8000-000000000001"}'::jsonb),
  ('22220000-0000-4000-8000-000000000002', 'gestor@iaroffice.com.br',
   '{"tenant_id":"a0000000-0000-4000-8000-000000000001"}'::jsonb),
  ('22220000-0000-4000-8000-000000000003', 'ana.atendente@iaroffice.com.br',
   '{"tenant_id":"a0000000-0000-4000-8000-000000000001"}'::jsonb),
  ('22220000-0000-4000-8000-000000000004', 'bruno.atendente@iaroffice.com.br',
   '{"tenant_id":"a0000000-0000-4000-8000-000000000001"}'::jsonb),
  ('22220000-0000-4000-8000-000000000005', 'carla.solicitante@meridiano.com.br',
   '{"tenant_id":"a0000000-0000-4000-8000-000000000001"}'::jsonb),
  -- Duas pessoas do financeiro. Existem para que a matriz de permissões seja
  -- exercitada com dado real, e não só pela tabela-verdade da função: os dois
  -- têm o MESMO papel `gestor` e perfis de acesso diferentes, que é exatamente
  -- o contraste que o módulo de permissões introduziu.
  ('22220000-0000-4000-8000-000000000006', 'diego.financeiro@iaroffice.com.br',
   '{"tenant_id":"a0000000-0000-4000-8000-000000000001"}'::jsonb),
  ('22220000-0000-4000-8000-000000000007', 'elis.aprovadora@iaroffice.com.br',
   '{"tenant_id":"a0000000-0000-4000-8000-000000000001"}'::jsonb);

insert into public.profiles (id, tenant_id, role, full_name, email, last_seen_at) values
  ('22220000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'admin',       'Administrador IAR', 'admin@iaroffice.com.br', now()),
  ('22220000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'gestor',      'Gestor de Serviços', 'gestor@iaroffice.com.br', now()),
  ('22220000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'atendente',   'Ana Souza',          'ana.atendente@iaroffice.com.br', now()),
  ('22220000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'atendente',   'Bruno Lima',         'bruno.atendente@iaroffice.com.br', now() - interval '2 hours'),
  ('22220000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'solicitante', 'Carla Dias',         'carla.solicitante@meridiano.com.br', null),
  ('22220000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001', 'gestor',      'Diego Moreira',      'diego.financeiro@iaroffice.com.br', now() - interval '10 minutes'),
  ('22220000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000001', 'gestor',      'Elis Prado',         'elis.aprovadora@iaroffice.com.br', now() - interval '1 day');

-- O trigger `trg_profiles_default_access_profile` acabou de dar "Gestor de TI"
-- aos dois, porque é o perfil-padrão do papel `gestor`. Aqui trocamos para os
-- perfis financeiros: sem isto nenhum usuário-semente exercitaria a diferença
-- entre operar e aprovar, e a matriz ficaria provada só em tabela-verdade.
update public.profiles p
set access_profile_id = ap.id
from public.access_profiles ap
where ap.tenant_id = p.tenant_id
  and ap.system_key = case p.id
    when '22220000-0000-4000-8000-000000000006'::uuid then 'operador_financeiro'
    when '22220000-0000-4000-8000-000000000007'::uuid then 'aprovador_financeiro'
  end;

-- Ana vê 2 filiais; Bruno vê apenas Manaus. É esse contraste que exercita o ADR-003.
insert into public.user_branches (user_id, branch_id, tenant_id, is_primary) values
  ('22220000-0000-4000-8000-000000000003', '11110000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', true),
  ('22220000-0000-4000-8000-000000000003', '11110000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', false),
  ('22220000-0000-4000-8000-000000000004', '11110000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', true),
  ('22220000-0000-4000-8000-000000000005', '11110000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', true);

insert into public.queue_members (queue_id, user_id, tenant_id, is_lead) values
  ('e0000000-0000-4000-8000-000000000001', '22220000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', true),
  ('e0000000-0000-4000-8000-000000000001', '22220000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', false),
  ('e0000000-0000-4000-8000-000000000002', '22220000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', true);

-- -----------------------------------------------------------------------------
-- SLA — contrato do cliente + sobrescrita de filial + padrão do tenant
-- -----------------------------------------------------------------------------
insert into public.sla_contracts (id, tenant_id, client_id, branch_id, name, business_hours_id) values
  ('33330000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-000000000001', null, 'Meridiano — Padrão', 'b0000000-0000-4000-8000-000000000001'),
  -- Manaus opera 24x7: sobrescreve o contrato do grupo (RF-SLA-07)
  ('33330000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-000000000001', '11110000-0000-4000-8000-000000000003', 'Meridiano — Manaus 24x7',
   'b0000000-0000-4000-8000-000000000002');

-- Padrão do tenant (contract_id NULL): rede de segurança para qualquer combinação.
insert into public.sla_definitions (tenant_id, contract_id, category_id, priority_id,
                                    first_response_minutes, resolution_minutes, business_hours_id)
values
  ('a0000000-0000-4000-8000-000000000001', null, null, 'c0000000-0000-4000-8000-000000000001',  15,  240, 'b0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000001', null, null, 'c0000000-0000-4000-8000-000000000002',  60,  480, 'b0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000001', null, null, 'c0000000-0000-4000-8000-000000000003', 240, 1440, 'b0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000001', null, null, 'c0000000-0000-4000-8000-000000000004', 480, 2880, 'b0000000-0000-4000-8000-000000000001');

-- Contrato Meridiano: mais agressivo em crítica/alta.
insert into public.sla_definitions (tenant_id, contract_id, category_id, priority_id,
                                    first_response_minutes, resolution_minutes)
values
  ('a0000000-0000-4000-8000-000000000001', '33330000-0000-4000-8000-000000000001', null, 'c0000000-0000-4000-8000-000000000001', 10, 120),
  ('a0000000-0000-4000-8000-000000000001', '33330000-0000-4000-8000-000000000001', null, 'c0000000-0000-4000-8000-000000000002', 30, 360),
  -- Infra crítica no Meridiano é ainda mais apertada (contrato + categoria)
  ('a0000000-0000-4000-8000-000000000001', '33330000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 5, 60),
  -- Manaus 24x7
  ('a0000000-0000-4000-8000-000000000001', '33330000-0000-4000-8000-000000000002', null, 'c0000000-0000-4000-8000-000000000001', 15, 180);

-- -----------------------------------------------------------------------------
-- Fornecedores
-- -----------------------------------------------------------------------------
insert into public.suppliers (id, tenant_id, name, legal_name, cnpj, email, services, rating) values
  ('44440000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'NetLink Telecom',
   'NetLink Telecomunicações Ltda.', '99.888.777/0001-66', 'suporte@netlink.com.br',
   array['link dedicado','MPLS','telefonia'], 4.2),
  ('44440000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'TechParts Assistência',
   'TechParts Comércio e Serviços Ltda.', '88.777.666/0001-55', 'os@techparts.com.br',
   array['manutenção de hardware','garantia estendida'], 3.8);

insert into public.supplier_contracts (tenant_id, supplier_id, contract_number, description,
                                       starts_on, monthly_cost, response_sla_minutes, resolution_sla_minutes)
values
  ('a0000000-0000-4000-8000-000000000001', '44440000-0000-4000-8000-000000000001', 'NL-2026-001',
   'Link dedicado 500Mb matriz + backup', '2026-01-01', 4800.00, 30, 240),
  ('a0000000-0000-4000-8000-000000000001', '44440000-0000-4000-8000-000000000002', 'TP-2026-014',
   'Manutenção corretiva de notebooks', '2026-03-01', 1200.00, 240, 2880);

-- -----------------------------------------------------------------------------
-- Inventário de TI
-- -----------------------------------------------------------------------------
insert into public.it_assets (tenant_id, asset_tag, serial_number, asset_type, brand, model,
                              status, branch_id, assigned_user_id, supplier_id,
                              acquisition_date, warranty_until, acquisition_cost)
values
  ('a0000000-0000-4000-8000-000000000001', 'PAT-001042', 'SN-DELL-77A1', 'notebook', 'Dell', 'Latitude 5450',
   'active', '11110000-0000-4000-8000-000000000001', '22220000-0000-4000-8000-000000000005',
   '44440000-0000-4000-8000-000000000002', '2025-04-10', '2028-04-10', 6890.00),
  ('a0000000-0000-4000-8000-000000000001', 'PAT-001043', 'SN-DELL-77A2', 'notebook', 'Dell', 'Latitude 5450',
   'active', '11110000-0000-4000-8000-000000000001', '22220000-0000-4000-8000-000000000003',
   '44440000-0000-4000-8000-000000000002', '2025-04-10', '2028-04-10', 6890.00),
  ('a0000000-0000-4000-8000-000000000001', 'PAT-002001', 'SN-HPE-DL380-01', 'server', 'HPE', 'ProLiant DL380 Gen11',
   'active', '11110000-0000-4000-8000-000000000002', null, null, '2024-08-01', '2029-08-01', 48200.00),
  ('a0000000-0000-4000-8000-000000000001', 'PAT-003011', 'SN-SAM-A55-11', 'smartphone', 'Samsung', 'Galaxy A55',
   'active', '11110000-0000-4000-8000-000000000003', '22220000-0000-4000-8000-000000000004',
   null, '2025-11-20', '2026-11-20', 2199.00),
  ('a0000000-0000-4000-8000-000000000001', 'PAT-004002', null, 'software_license', 'Microsoft', 'M365 Business Premium',
   'active', '11110000-0000-4000-8000-000000000001', null, null, '2026-01-01', '2027-01-01', 0.00),
  ('a0000000-0000-4000-8000-000000000001', 'PAT-001099', 'SN-LEN-T14-09', 'notebook', 'Lenovo', 'ThinkPad T14',
   'maintenance', '11110000-0000-4000-8000-000000000002', null,
   '44440000-0000-4000-8000-000000000002', '2023-02-15', '2026-02-15', 5400.00);

-- -----------------------------------------------------------------------------
-- Linhas telefônicas
-- -----------------------------------------------------------------------------
insert into public.telecom_lines (tenant_id, phone_number, carrier, plan_name, line_type, status,
                                  branch_id, assigned_user_id, device_asset_id,
                                  monthly_cost, activated_on, loyalty_until)
select
  'a0000000-0000-4000-8000-000000000001', v.num, v.carrier, v.plan, v.ltype, v.status,
  v.branch, v.usr,
  (select id from public.it_assets where asset_tag = 'PAT-003011'),
  v.cost, v.act, v.loyal
from (values
  ('+55 11 98800-1001', 'Vivo',  'Controle 20GB', 'control',  'active',    '11110000-0000-4000-8000-000000000001'::uuid, '22220000-0000-4000-8000-000000000003'::uuid,  79.90, '2025-06-01'::date, '2026-06-01'::date),
  ('+55 11 98800-1002', 'Vivo',  'Pós 50GB',      'postpaid', 'active',    '11110000-0000-4000-8000-000000000001'::uuid, null,                                          129.90, '2025-06-01'::date, '2026-06-01'::date),
  ('+55 19 98800-2001', 'Claro', 'Pós 30GB',      'postpaid', 'active',    '11110000-0000-4000-8000-000000000002'::uuid, null,                                           99.90, '2024-09-15'::date, null),
  ('+55 92 98800-3001', 'TIM',   'Pós 100GB',     'postpaid', 'active',    '11110000-0000-4000-8000-000000000003'::uuid, '22220000-0000-4000-8000-000000000004'::uuid, 189.90, '2025-11-20'::date, '2027-11-20'::date),
  ('+55 92 98800-3002', 'TIM',   'Pré',           'prepaid',  'suspended', '11110000-0000-4000-8000-000000000003'::uuid, null,                                            0.00, '2024-01-10'::date, null)
) as v(num, carrier, plan, ltype, status, branch, usr, cost, act, loyal);

-- Uma linha cancelada, para o relatório de custos ter histórico.
insert into public.telecom_lines (tenant_id, phone_number, carrier, plan_name, line_type, status,
                                  branch_id, monthly_cost, activated_on, cancelled_on)
values ('a0000000-0000-4000-8000-000000000001', '+55 31 98800-4001', 'Claro', 'Pós 20GB', 'postpaid',
        'cancelled', '11110000-0000-4000-8000-000000000004', 89.90, '2023-05-01', '2026-05-31');

-- -----------------------------------------------------------------------------
-- Dashboard de TV
-- -----------------------------------------------------------------------------
insert into public.dashboard_layouts (id, tenant_id, name, slug, is_default, refresh_seconds, config) values
  ('55550000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'War Room — Operação', 'war-room', true, 45,
   '{"tiles":["open_total","in_progress_total","critical_total","sla_at_risk","sla_breached","agents_online","avg_resolution_minutes_24h","resolved_today"],"featured_queue":"geral","theme":"dark"}'::jsonb);

-- Token de demonstração. Segredo em claro: "demo-tv-token-iaroffice" (ADR-006 — em
-- produção o valor é gerado aleatoriamente e exibido uma única vez).
insert into public.dashboard_tokens (tenant_id, layout_id, name, token_hash, created_by) values
  ('a0000000-0000-4000-8000-000000000001', '55550000-0000-4000-8000-000000000001',
   'TV Recepção Matriz',
   encode(digest('demo-tv-token-iaroffice', 'sha256'), 'hex'),
   '22220000-0000-4000-8000-000000000001');

-- -----------------------------------------------------------------------------
-- Integração Bitrix24 (RF-INT-08)
-- -----------------------------------------------------------------------------
-- Token inbound de demonstração em claro: "demo-bitrix-app-token".
insert into public.integrations (id, tenant_id, name, slug, source_system, direction, status,
                                 auth_type, secret_ref, inbound_token_hash, base_url, config)
values
  ('66660000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'Bitrix24 — Tarefas', 'bitrix24-tarefas', 'bitrix24', 'bidirectional', 'active',
   'webhook_token',
   'BITRIX24_INBOUND_WEBHOOK_URL',                                 -- nome do secret, não o valor (ADR-009)
   encode(digest('demo-bitrix-app-token', 'sha256'), 'hex'),
   'https://exemplo.bitrix24.com.br',
   '{"default_queue_slug":"geral","default_priority_key":"medium","default_branch_code":"MER-SP"}'::jsonb);

-- Mapeamento Bitrix24 → SaaS (seção 4.2.2 do escopo)
insert into public.integration_mappings (tenant_id, integration_id, source_path, target_field, transform, value_map, is_required)
values
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'TITLE',          'title',        'direct',        '{}'::jsonb, true),
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'DESCRIPTION',    'description',  'html_to_text',  '{}'::jsonb, false),
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'CREATED_DATE',   'created_at',   'datetime',      '{}'::jsonb, false),
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'DEADLINE',       'deadline',     'datetime',      '{}'::jsonb, false),
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'RESPONSIBLE_ID', 'assignee_id',  'user_by_external_id', '{}'::jsonb, false),
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'CREATED_BY',     'requester_id', 'user_by_external_id', '{}'::jsonb, false),
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'GROUP_ID',       'queue_id',     'queue_by_external_id', '{}'::jsonb, false),
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'TAGS',           'tags',         'direct',        '{}'::jsonb, false),
  -- Bitrix24: PRIORITY 2=alta, 1=média, 0=baixa
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'PRIORITY',       'priority_key', 'value_map',
   '{"2":"high","1":"medium","0":"low"}'::jsonb, false),
  -- Bitrix24: STATUS 2=pendente, 3=em execução, 4=aguardando controle, 5=concluída, 6=adiada, 7=recusada
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'STATUS',         'status',       'value_map',
   '{"2":"open","3":"in_progress","4":"waiting_third_party","5":"resolved","6":"waiting_requester","7":"closed"}'::jsonb, false);

-- -----------------------------------------------------------------------------
-- Tickets de demonstração
-- -----------------------------------------------------------------------------
insert into public.tickets (tenant_id, title, description, status, priority_id, category_id, queue_id,
                            branch_id, requester_id, assignee_id, created_at, tags)
values
  ('a0000000-0000-4000-8000-000000000001', 'Link de internet da matriz oscilando',
   'Desde as 08h a conexão cai a cada poucos minutos. Afeta todo o andar comercial.',
   'in_progress', 'c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000011',
   'e0000000-0000-4000-8000-000000000002', '11110000-0000-4000-8000-000000000001',
   '22220000-0000-4000-8000-000000000005', '22220000-0000-4000-8000-000000000003',
   now() - interval '3 hours', array['rede','urgente']),

  ('a0000000-0000-4000-8000-000000000001', 'ERP lento ao emitir nota fiscal',
   'Emissão leva mais de 2 minutos por nota.',
   'assigned', 'c0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000013',
   'e0000000-0000-4000-8000-000000000001', '11110000-0000-4000-8000-000000000001',
   '22220000-0000-4000-8000-000000000005', '22220000-0000-4000-8000-000000000003',
   now() - interval '1 day', array['erp']),

  ('a0000000-0000-4000-8000-000000000001', 'Solicitação de reset de senha',
   'Usuário bloqueado após tentativas.',
   'open', 'c0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000015',
   'e0000000-0000-4000-8000-000000000001', '11110000-0000-4000-8000-000000000001',
   '22220000-0000-4000-8000-000000000005', null,
   now() - interval '20 minutes', array['acesso']),

  ('a0000000-0000-4000-8000-000000000001', 'Linha +55 92 98800-3001 sem sinal de dados',
   'Aparelho sem 4G desde ontem à noite.',
   'waiting_third_party', 'c0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000014',
   'e0000000-0000-4000-8000-000000000003', '11110000-0000-4000-8000-000000000003',
   null, '22220000-0000-4000-8000-000000000004',
   now() - interval '2 days', array['telefonia']),

  ('a0000000-0000-4000-8000-000000000001', 'Servidor de arquivos com disco cheio',
   'Volume /dados em 96% de uso.',
   'open', 'c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000012',
   'e0000000-0000-4000-8000-000000000002', '11110000-0000-4000-8000-000000000002',
   null, null,
   now() - interval '5 days', array['servidor','capacidade']),

  ('a0000000-0000-4000-8000-000000000001', 'Troca de notebook — colaborador novo',
   'Preparar equipamento com imagem padrão.',
   'resolved', 'c0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000002',
   'e0000000-0000-4000-8000-000000000001', '11110000-0000-4000-8000-000000000001',
   '22220000-0000-4000-8000-000000000005', '22220000-0000-4000-8000-000000000003',
   now() - interval '4 days', array['hardware']);

-- Vincula o ticket de rede ao servidor e o de telefonia à linha (RF-INV-03).
insert into public.ticket_assets (ticket_id, asset_id, tenant_id)
select t.id, a.id, t.tenant_id
from public.tickets t, public.it_assets a
where t.title = 'Servidor de arquivos com disco cheio' and a.asset_tag = 'PAT-002001';

insert into public.ticket_telecom_lines (ticket_id, line_id, tenant_id)
select t.id, l.id, t.tenant_id
from public.tickets t, public.telecom_lines l
where t.title like 'Linha +55 92%' and l.phone_number = '+55 92 98800-3001';

-- Comentários
insert into public.ticket_comments (tenant_id, ticket_id, author_id, body, visibility)
select t.tenant_id, t.id, '22220000-0000-4000-8000-000000000003',
       'Abrimos chamado na operadora sob protocolo 884512. Aguardando retorno.', 'public'
from public.tickets t where t.title = 'Link de internet da matriz oscilando';

insert into public.ticket_comments (tenant_id, ticket_id, author_id, body, visibility)
select t.tenant_id, t.id, '22220000-0000-4000-8000-000000000003',
       'Verificar se o contrato NL-2026-001 cobre SLA de 4h — cliente vai cobrar.', 'internal'
from public.tickets t where t.title = 'Link de internet da matriz oscilando';

-- -----------------------------------------------------------------------------
-- Áreas por filial (migração 0013) — base do detalhamento por área nos mapas
-- -----------------------------------------------------------------------------
select app.fn_seed_branch_areas(b.id)
from public.branches b
where b.tenant_id = 'a0000000-0000-4000-8000-000000000001';

-- -----------------------------------------------------------------------------
-- Endereço estruturado (migração 0015)
--
-- Logradouros e CEPs reais e públicos, escolhidos para exercitar o fluxo de
-- geocodificação de ponta a ponta. Cada filial cobre um caso diferente:
--   1. endereço completo                → caminho feliz
--   2. endereço completo em outra praça  → segunda coordenada no mapa
--   3. sem número                        → [CAMPO AUSENTE]
--   4. sem endereço nenhum               → filial fora do mapa, com aviso
-- -----------------------------------------------------------------------------
update public.branches
   set street = 'Avenida Paulista', street_number = '1578', district = 'Bela Vista',
       postal_code = '01310-200'
 where id = '11110000-0000-4000-8000-000000000001';
update public.branches
   set street = 'Avenida Francisco Glicério', street_number = '935', district = 'Centro',
       postal_code = '13012-100'
 where id = '11110000-0000-4000-8000-000000000002';
-- Sem número: o fluxo tem de barrar antes de gastar cota da Geocoding API.
update public.branches
   set street = 'Avenida Djalma Batista', district = 'Chapada', postal_code = '69050-010'
 where id = '11110000-0000-4000-8000-000000000003';

-- Coordenadas das filiais, para o mapa ter o que plotar antes do primeiro
-- geocode. Precisão declarada como `manual` — é o que elas são.
update public.branches set latitude = -23.550520, longitude = -46.633308,
       geocoded_at = now(), geocode_source = 'manual',
       geocode_precision = 'manual', geocode_status = 'ok',
       geocode_verified_at = now(), geocode_provider = 'seed'
 where id = '11110000-0000-4000-8000-000000000001';
update public.branches set latitude = -22.909938, longitude = -47.062633,
       geocoded_at = now(), geocode_source = 'manual',
       geocode_precision = 'manual', geocode_status = 'ok',
       geocode_verified_at = now(), geocode_provider = 'seed'
 where id = '11110000-0000-4000-8000-000000000002';
update public.branches set latitude = -3.119028, longitude = -60.021731,
       geocoded_at = now(), geocode_source = 'manual',
       geocode_precision = 'approximate', geocode_status = 'low_precision',
       geocode_verified_at = now(), geocode_provider = 'seed'
 where id = '11110000-0000-4000-8000-000000000003';
-- A sede da Vertex fica sem coordenada e sem endereço de propósito: exercita o
-- aviso "filiais sem localização" em vez de a filial desaparecer do mapa em
-- silêncio, e o [CAMPO AUSENTE] do fluxo de geocodificação.

-- Aloca os ativos em áreas da própria filial.
update public.it_assets a
   set branch_area_id = (
     select ar.id from public.branch_areas ar
     where ar.branch_id = a.branch_id
       and ar.name = case a.asset_type
                       when 'server'           then 'TI'
                       when 'software_license' then 'TI'
                       when 'smartphone'       then 'Enfermagem'
                       else 'Administração'
                     end
     limit 1)
 where a.tenant_id = 'a0000000-0000-4000-8000-000000000001'
   and a.branch_id is not null;

-- Aloca as linhas em áreas da própria filial.
update public.telecom_lines l
   set company_area_id = (
     select ar.id from public.branch_areas ar
     where ar.branch_id = l.branch_id and ar.name = 'Enfermagem' limit 1)
 where l.tenant_id = 'a0000000-0000-4000-8000-000000000001'
   and l.branch_id is not null;

-- -----------------------------------------------------------------------------
-- Links de internet
-- -----------------------------------------------------------------------------
insert into public.internet_links (
  tenant_id, branch_id, branch_area_id, contract_number, supplier_id,
  technology, download_mbps, upload_mbps, guaranteed_mbps,
  has_static_ip, static_ip, cpe_brand, cpe_model, status, monthly_cost,
  activated_on, contract_start, contract_end, monitoring_host, last_state, last_state_at
)
select
  'a0000000-0000-4000-8000-000000000001', b.id,
  (select ar.id from public.branch_areas ar where ar.branch_id = b.id and ar.name = 'TI' limit 1),
  v.contract, '44440000-0000-4000-8000-000000000001',
  v.tech, v.down, v.up, v.guaranteed,
  v.static_ip is not null, v.static_ip, v.brand, v.model, v.status, v.cost,
  v.activated, v.activated, v.contract_end, v.host, v.state, now()
from public.branches b
join (values
  ('11110000-0000-4000-8000-000000000001'::uuid, 'NL-LINK-001', 'fiber',     500, 500, 250, '200.150.10.2'::inet, 'Huawei',  'EG8145V5', 'active', 4800.00, '2026-01-01'::date, '2027-01-01'::date, '200.150.10.2', 'up'),
  ('11110000-0000-4000-8000-000000000002'::uuid, 'NL-LINK-002', 'fiber',     300, 300, 150, null,                 'Intelbras','WiFiber',  'active', 2200.00, '2026-02-15'::date, '2027-02-15'::date, '10.20.0.1',     'up'),
  ('11110000-0000-4000-8000-000000000003'::uuid, 'NL-LINK-003', 'satellite', 100,  20,  50, null,                 'Starlink', 'Gen3',     'active', 1900.00, '2026-03-01'::date, '2027-03-01'::date, '10.30.0.1',     'down')
) as v(branch, contract, tech, down, up, guaranteed, static_ip, brand, model, status, cost, activated, contract_end, host, state)
  on v.branch = b.id;

-- Evento de indisponibilidade em aberto para o link de Manaus.
insert into public.link_availability_events (tenant_id, link_id, state, started_at, source, note)
select k.tenant_id, k.id, 'down', now() - interval '35 minutes', 'manual',
       'Queda registrada manualmente — aguardando retorno da operadora.'
from public.internet_links k where k.contract_number = 'NL-LINK-003';

-- Contrato anexado a um dos links, para o indicador "sem contrato" ter contraste.
insert into public.internet_link_attachments
  (tenant_id, link_id, kind, storage_path, file_name, mime_type, size_bytes, uploaded_by)
select k.tenant_id, k.id, 'contract',
       -- Quatro segmentos: {tenant}/{entidade}/{entity_id}/{arquivo}. O caminho
       -- de dois segmentos que estava aqui NUNCA poderia ser baixado:
       -- `app.can_touch_attachment()` (0019) nega quando o caminho não tem
       -- exatamente 3 pastas, e a entidade sairia sendo o uuid do link.
       format('%s/links/%s/contrato-nl-link-001.pdf', k.tenant_id, k.id),
       'contrato-nl-link-001.pdf', 'application/pdf', 184320,
       '22220000-0000-4000-8000-000000000001'
from public.internet_links k where k.contract_number = 'NL-LINK-001';

-- -----------------------------------------------------------------------------
-- Financeiro: centros de custo e contas bancárias (0018)
-- -----------------------------------------------------------------------------
-- Três níveis de propósito: a trigger de profundidade recusa o quarto, e um seed
-- que só usa um nível nunca provaria que a hierarquia funciona.
insert into public.cost_centers (id, tenant_id, parent_id, code, name, description, branch_id) values
  ('c1110000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null,
   'TI', 'Tecnologia da Informação', 'Centro raiz de todo custo de TI.', null),
  ('c1110000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'c1110000-0000-4000-8000-000000000001',
   'TI-INFRA', 'Infraestrutura', 'Conectividade, servidores e nuvem.', null),
  ('c1110000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001',
   'c1110000-0000-4000-8000-000000000002',
   'TI-INFRA-LINK', 'Links de internet', 'Terceiro nível — o limite que a trigger permite.', null),
  -- Centro de filial: é o que torna possível cobrar custo por unidade.
  ('c1110000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001',
   'c1110000-0000-4000-8000-000000000001',
   'TI-MAO', 'TI — Filial Manaus', 'Custo de TI alocado na filial de Manaus.',
   '11110000-0000-4000-8000-000000000003');

insert into public.bank_accounts
  (id, tenant_id, name, bank_code, bank_name, agency, account_number, account_type,
   holder_name, holder_document, opening_balance, credit_limit, status) values
  ('c2220000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'Operação', '001', 'Banco do Brasil', '1234-5', '98765-4', 'checking',
   'IAR Office Serviços de TI Ltda.', '12.345.678/0001-99', 42000.00, 20000.00, 'active'),
  ('c2220000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'Reserva', '077', 'Banco Inter', '0001', '55443-2', 'savings',
   'IAR Office Serviços de TI Ltda.', '12.345.678/0001-99', 15000.00, 0, 'active'),
  -- Conta bloqueada: o painel precisa de contraste para o indicador de situação.
  ('c2220000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001',
   'Antiga folha', '341', 'Itaú', '4444', '11111-1', 'checking',
   'IAR Office Serviços de TI Ltda.', '12.345.678/0001-99', 0, 0, 'blocked');

-- Movimentações avulsas. Uma fica sem conciliar de propósito, para o indicador
-- "não conciliadas" da tela não nascer zerado.
insert into public.bank_account_movements
  (tenant_id, bank_account_id, direction, amount, moved_on, description, cost_center_id,
   reconciled_at, created_by) values
  ('a0000000-0000-4000-8000-000000000001', 'c2220000-0000-4000-8000-000000000001',
   'in',  38000.00, current_date - 20, 'Recebimento contrato Meridiano — competência anterior',
   null, now() - interval '19 days', '22220000-0000-4000-8000-000000000006'),
  ('a0000000-0000-4000-8000-000000000001', 'c2220000-0000-4000-8000-000000000001',
   'out',  4800.00, current_date - 12, 'Link de internet NL-LINK-001',
   'c1110000-0000-4000-8000-000000000003', now() - interval '11 days',
   '22220000-0000-4000-8000-000000000006'),
  ('a0000000-0000-4000-8000-000000000001', 'c2220000-0000-4000-8000-000000000001',
   'out',  1900.00, current_date - 5, 'Link satelital da filial de Manaus',
   'c1110000-0000-4000-8000-000000000004', null, '22220000-0000-4000-8000-000000000006');

-- Transferência interna: DUAS linhas com o mesmo `transfer_group`, inseridas na
-- mesma instrução. A constraint trigger é `deferrable initially deferred` e
-- valida o par por statement — inserir uma metade sozinha é recusado, e é
-- justamente esse caminho que o teste de schema exercita.
insert into public.bank_account_movements
  (tenant_id, bank_account_id, direction, amount, moved_on, description,
   transfer_group, created_by) values
  ('a0000000-0000-4000-8000-000000000001', 'c2220000-0000-4000-8000-000000000001',
   'out', 10000.00, current_date - 3, 'Aporte na reserva',
   'c3330000-0000-4000-8000-000000000001', '22220000-0000-4000-8000-000000000006'),
  ('a0000000-0000-4000-8000-000000000001', 'c2220000-0000-4000-8000-000000000002',
   'in',  10000.00, current_date - 3, 'Aporte recebido da conta Operação',
   'c3330000-0000-4000-8000-000000000001', '22220000-0000-4000-8000-000000000006');



commit;

-- =============================================================================
-- Conferência — rode DEPOIS, numa consulta separada
-- =============================================================================
--   select
--     (select count(*) from pg_tables   where schemaname = 'public') as tabelas,
--     (select count(*) from pg_views    where schemaname = 'public') as views,
--     (select count(*) from pg_policies where schemaname = 'public') as policies,
--     (select count(*) from pg_policies where schemaname = 'storage') as pol_storage,
--     (select count(*) from public.access_profiles)   as perfis,
--     (select count(*) from public.permission_catalog) as permissoes,
--     (select count(*) from public.profiles)          as usuarios;
--
-- Confira contra o que `npm run db:validate` reporta no seu ambiente. Números
-- fixos aqui envelheceriam calados a cada migração nova — foi o que aconteceu
-- com a primeira versão deste arquivo, que prometia 18 perfis quando são 9.
--
-- São 9 perfis porque o seed cria UM tenant, e cada tenant nasce com os 9
-- perfis do sistema por trigger. Dois tenants dariam 18.
-- =============================================================================
