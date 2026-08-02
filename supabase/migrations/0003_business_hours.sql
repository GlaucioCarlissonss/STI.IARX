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
