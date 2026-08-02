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
