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
