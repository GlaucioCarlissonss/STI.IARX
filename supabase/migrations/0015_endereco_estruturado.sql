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
