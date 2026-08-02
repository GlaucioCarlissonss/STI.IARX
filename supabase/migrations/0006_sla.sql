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
