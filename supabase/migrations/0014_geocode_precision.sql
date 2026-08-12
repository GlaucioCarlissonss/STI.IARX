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
