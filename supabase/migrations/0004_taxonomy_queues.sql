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
