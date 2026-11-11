-- =============================================================================
-- 0049 — Contratos de locação (Fase 3 da unificação com o LTI — docs/23)
-- =============================================================================
-- O contrato é o que torna alcançáveis os três estados que a 0048 criou e
-- ninguém conseguia atingir: `reserved`, `in_transit_out` e `rented`. Sem ele
-- a frota só sabia estar na base ou na oficina — que é meia frota.
--
-- ## O que o contrato governa
--
-- Vigência, quem paga, onde a máquina opera e **como o consumo vira dinheiro**:
-- preço do item, franquia inclusa e preço do excedente. A Fase 4 lê isso para
-- calcular a fatura; aqui ele é cadastrado e aplicado à alocação.
--
-- ## Por que não existe tabela de preço separada
--
-- O LTI tem `tabela_preco` + `tabela_preco_item` + `tabela_franquia` +
-- `tabela_franquia_item`. São quatro tabelas para responder "quanto custa este
-- item neste contrato" — e a resposta já está no item do contrato, que é onde
-- ela precisa ficar congelada: reajustar a tabela não pode mudar o que um
-- contrato assinado cobra. O modelo (0048) guarda o preço SUGERIDO, o item do
-- contrato guarda o preço ACORDADO, e a diferença entre os dois é o desconto
-- comercial — visível sem uma quinta tabela para registrá-lo.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Local de operação — onde a máquina fica, do lado do cliente
-- -----------------------------------------------------------------------------
-- Não é `branches`, e não é `rental_depots`. A filial do cliente é cadastro do
-- cliente; o depósito é da casa. O local de operação é o ENDEREÇO DE USO: a
-- unidade, o andar, o setor onde o concentrador fica ligado. Um cliente com
-- três unidades tem três locais, e é por eles que a entrega e o recolhimento se
-- orientam — não pelo CNPJ.
create table public.operation_locations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  client_id  uuid not null references public.clients(id) on delete restrict,
  /* A filial é opcional: há cliente que não tem filial cadastrada, e exigir uma
     impediria o cadastro do local — que é o dado de que a entrega precisa. */
  branch_id  uuid references public.branches(id) on delete set null,
  name       text not null,
  address_line text,
  contact_name text,
  contact_phone text,
  notes      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index operation_locations_name_uk
  on public.operation_locations (tenant_id, client_id, lower(name)) where deleted_at is null;
create index operation_locations_client_idx
  on public.operation_locations (tenant_id, client_id) where deleted_at is null;

comment on table public.operation_locations is
  'Endereço de uso do equipamento, do lado do cliente. Diferente de branches (cadastro do cliente) e de rental_depots (base da casa).';

-- -----------------------------------------------------------------------------
-- 2. O contrato
-- -----------------------------------------------------------------------------
create table public.rental_contracts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  client_id   uuid not null references public.clients(id) on delete restrict,

  code        text not null,
  status      text not null default 'draft'
                check (status in ('draft', 'active', 'suspended', 'ended', 'cancelled')),

  starts_on   date not null,
  ends_on     date,

  /* Dia do mês em que a competência fecha e a fatura sai. Não é "vencimento":
     é quando o período acaba. A Fase 4 usa isto para saber o que entra em qual
     mês — e sem ele o fechamento seria sempre no dia 1º, o que não é o que
     nenhum contrato de locação combina. */
  billing_day smallint not null default 1 check (billing_day between 1 and 28),

  /*
   * Os PADRÕES de cobrança do contrato. Cada item pode divergir, e diverge
   * mesmo — equipamento mais pesado costuma vir com franquia maior. Guardar o
   * padrão aqui evita digitar a mesma franquia em vinte itens, e guardá-lo
   * TAMBÉM no item é o que congela o acordo: reajustar o contrato não pode
   * mudar retroativamente o que já foi faturado.
   */
  default_franchise numeric(14,2) check (default_franchise is null or default_franchise >= 0),
  default_excess_price numeric(14,4) check (default_excess_price is null or default_excess_price >= 0),

  /* Índice de reajuste como TEXTO, e não como tabela de índices: o sistema não
     calcula o reajuste (não tem a série do IPCA), ele registra o que foi
     combinado. Prometer cálculo exigiria uma fonte de dados que não existe
     aqui, e um número inventado é pior que um campo descritivo. */
  adjustment_index text,
  adjustment_month smallint check (adjustment_month is null or adjustment_month between 1 and 12),

  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,

  constraint rental_contracts_vigencia check (ends_on is null or ends_on >= starts_on)
);

create unique index rental_contracts_code_uk
  on public.rental_contracts (tenant_id, lower(code)) where deleted_at is null;
create index rental_contracts_client_idx
  on public.rental_contracts (tenant_id, client_id) where deleted_at is null;
create index rental_contracts_status_idx
  on public.rental_contracts (tenant_id, status) where deleted_at is null;

-- As transições do contrato, pela mesma razão das do equipamento: a tela lê
-- daqui e desenha só o que o banco aceita.
create table public.rental_contract_status_transitions (
  from_status text not null,
  to_status   text not null,
  description text,
  primary key (from_status, to_status)
);

insert into public.rental_contract_status_transitions (from_status, to_status, description) values
  ('draft',     'active',    'Assinado: as alocações passam a valer'),
  ('draft',     'cancelled', 'Desistência antes de começar'),
  ('active',    'suspended', 'Suspenso: para de faturar, equipamento continua no cliente'),
  ('suspended', 'active',    'Retomado'),
  ('active',    'ended',     'Encerrado no fim da vigência'),
  ('suspended', 'ended',     'Encerrado durante a suspensão'),
  ('active',    'cancelled', 'Rescindido'),
  ('suspended', 'cancelled', 'Rescindido durante a suspensão');

-- -----------------------------------------------------------------------------
-- 3. O item do contrato — a alocação de uma peça
-- -----------------------------------------------------------------------------
create table public.rental_contract_items (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  contract_id   uuid not null references public.rental_contracts(id) on delete cascade,
  equipment_id  uuid not null references public.rental_equipment(id) on delete restrict,
  operation_location_id uuid references public.operation_locations(id) on delete set null,

  status        text not null default 'reserved'
                  check (status in ('reserved', 'delivered', 'returned', 'cancelled')),

  /* O preço ACORDADO, congelado no item. Ver o cabeçalho desta migração. */
  monthly_price numeric(14,2) not null check (monthly_price >= 0),
  franchise     numeric(14,2) check (franchise is null or franchise >= 0),
  excess_price  numeric(14,4) check (excess_price is null or excess_price >= 0),

  /* As datas EFETIVAS, que não são as do contrato: a peça que entrou no dia 20
     é cobrada por onze dias, não pelo mês. É o que a Fase 4 usa para o
     pró-rata. */
  delivered_on  date,
  returned_on   date,

  /* A leitura do medidor na entrega e na devolução: é a base do consumo do
     período, e precisa ser congelada no item — o medidor do equipamento segue
     andando no próximo contrato. */
  meter_at_delivery numeric(14,2) check (meter_at_delivery is null or meter_at_delivery >= 0),
  meter_at_return   numeric(14,2) check (meter_at_return is null or meter_at_return >= 0),

  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create index rental_contract_items_contract_idx
  on public.rental_contract_items (tenant_id, contract_id) where deleted_at is null;
create index rental_contract_items_equipment_idx
  on public.rental_contract_items (tenant_id, equipment_id) where deleted_at is null;

/*
 * UMA alocação viva por equipamento.
 *
 * É a regra que impede o pior erro desta casa: a mesma máquina alocada em dois
 * contratos. Sem ela, o segundo contrato fatura um equipamento que está no
 * cliente do primeiro, e a descoberta acontece na entrega — com o caminhão na
 * porta. Índice parcial, porque `returned` e `cancelled` são histórico e podem
 * se repetir à vontade.
 */
create unique index rental_contract_items_uma_viva
  on public.rental_contract_items (equipment_id)
  where deleted_at is null and status in ('reserved', 'delivered');

-- -----------------------------------------------------------------------------
-- 4. Gatilho: o contrato e a máquina de estados do equipamento
-- -----------------------------------------------------------------------------
create or replace function app.validar_item_de_contrato()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_status_contrato text;
  v_status_equip    text;
begin
  select status into v_status_contrato
  from public.rental_contracts where id = new.contract_id;

  /* Contrato encerrado ou cancelado não recebe alocação nova. Deixar passar
     criaria cobrança em contrato morto, que ninguém procura e ninguém confere. */
  if tg_op = 'INSERT' and v_status_contrato in ('ended', 'cancelled') then
    raise exception 'contrato % não aceita novos itens', v_status_contrato
      using errcode = '23514', constraint = 'rental_contract_items_contrato_vivo';
  end if;

  select status into v_status_equip
  from public.rental_equipment where id = new.equipment_id;

  if tg_op = 'INSERT' then
    /* Alocar exige a peça na base alocável. O índice único acima já impede a
       dupla alocação; isto aqui pega o resto: máquina em manutenção, extraviada
       ou baixada não entra em contrato. */
    if v_status_equip <> 'available' then
      raise exception 'equipamento não está disponível (está em %)', v_status_equip
        using errcode = '23514',
              constraint = 'rental_contract_items_equipamento_disponivel',
              hint = 'Mova o equipamento para disponível antes de alocá-lo.';
    end if;
  end if;

  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if (old.status, new.status) not in (
      ('reserved', 'delivered'),
      ('reserved', 'cancelled'),
      ('delivered', 'returned')
    ) then
      raise exception 'transição de item inválida: % → %', old.status, new.status
        using errcode = '23514', constraint = 'rental_contract_items_transicao';
    end if;

    /* Entregar exige data e leitura, porque é delas que sai o pró-rata e o
       consumo do período. Aceitar sem elas empurra o problema para o
       fechamento, quando ninguém mais lembra o dia. */
    if new.status = 'delivered' and new.delivered_on is null then
      raise exception 'entrega precisa da data: é dela que sai a cobrança proporcional'
        using errcode = '23514', constraint = 'rental_contract_items_entrega_tem_data';
    end if;
    if new.status = 'returned' and new.returned_on is null then
      raise exception 'devolução precisa da data'
        using errcode = '23514', constraint = 'rental_contract_items_devolucao_tem_data';
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_rental_contract_items_valida
  before insert or update on public.rental_contract_items
  for each row execute function app.validar_item_de_contrato();

/*
 * Encerrar ou cancelar o contrato devolve as peças.
 *
 * Sem isto, encerrar o contrato deixaria equipamento preso em `rented` para
 * sempre — e o índice de alocação única impediria alocá-lo de novo, sem dizer
 * por quê. O gatilho marca os itens como devolvidos; mover o EQUIPAMENTO de
 * volta é ato de quem recolhe, na tela, porque é o recolhimento físico que
 * decide se ele volta para a base ou para a oficina.
 */
create or replace function app.encerrar_itens_do_contrato()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  if new.status in ('ended', 'cancelled') and old.status not in ('ended', 'cancelled') then
    update public.rental_contract_items
       set status = case when status = 'delivered' then 'returned' else 'cancelled' end,
           returned_on = case when status = 'delivered' then current_date else returned_on end
     where contract_id = new.id
       and deleted_at is null
       and status in ('reserved', 'delivered');
  end if;
  return new;
end;
$$;

create trigger trg_rental_contracts_encerra_itens
  after update on public.rental_contracts
  for each row execute function app.encerrar_itens_do_contrato();

-- -----------------------------------------------------------------------------
-- 5. Visão: o item com tudo o que a tela mostra junto
-- -----------------------------------------------------------------------------
create or replace view public.vw_rental_allocations as
select
  i.id,
  i.tenant_id,
  i.contract_id,
  c.code          as contract_code,
  c.status        as contract_status,
  c.client_id,
  i.equipment_id,
  e.asset_tag,
  e.status        as equipment_status,
  e.meter_kind,
  e.meter_reading,
  m.name          as model_name,
  i.operation_location_id,
  l.name          as location_name,
  i.status,
  i.monthly_price,
  i.franchise,
  i.excess_price,
  i.delivered_on,
  i.returned_on,
  i.meter_at_delivery,
  i.meter_at_return
from public.rental_contract_items i
join public.rental_contracts c on c.id = i.contract_id
join public.rental_equipment e on e.id = i.equipment_id
join public.equipment_models m on m.id = e.model_id
left join public.operation_locations l on l.id = i.operation_location_id
where i.deleted_at is null;

comment on view public.vw_rental_allocations is
  'Alocação com contrato, equipamento, modelo e local já resolvidos — a linha que a tela desenha.';

-- -----------------------------------------------------------------------------
-- 6. RLS e privilégios
-- -----------------------------------------------------------------------------
select app.harden_table('public.operation_locations');
select app.harden_table('public.rental_contracts');
select app.harden_table('public.rental_contract_items');
select app.attach_audit('public.rental_contracts');
select app.attach_audit('public.rental_contract_items');

alter table public.rental_contract_status_transitions enable row level security;
create policy rental_contract_transitions_select on public.rental_contract_status_transitions
  for select to authenticated using (true);

create policy operation_locations_select on public.operation_locations
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.contratos.ver'));
create policy operation_locations_write on public.operation_locations
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.contratos.editar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.contratos.editar'));

create policy rental_contracts_select on public.rental_contracts
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.contratos.ver'));
create policy rental_contracts_insert on public.rental_contracts
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.contratos.criar'));
create policy rental_contracts_update on public.rental_contracts
  for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.contratos.editar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.contratos.editar'));

create policy rental_contract_items_select on public.rental_contract_items
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.contratos.ver'));
create policy rental_contract_items_write on public.rental_contract_items
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.contratos.alocar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.contratos.alocar'));

grant select, insert, update on public.operation_locations to authenticated;
grant select, insert, update on public.rental_contracts to authenticated;
grant select, insert, update, delete on public.rental_contract_items to authenticated;
grant select on public.rental_contract_status_transitions to authenticated;
grant select on public.vw_rental_allocations to authenticated;

-- -----------------------------------------------------------------------------
-- 7. Catálogo de permissões
-- -----------------------------------------------------------------------------
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('locacao.contratos',        'locacao', 'contratos', null,      'Contratos de locação',            'visualizador', 520),
  ('locacao.contratos.ver',    'locacao', 'contratos', 'ver',     'Consultar contratos de locação',  'visualizador', 521),
  ('locacao.contratos.criar',  'locacao', 'contratos', 'criar',   'Criar contrato de locação',       'gestor',       522),
  ('locacao.contratos.editar', 'locacao', 'contratos', 'editar',  'Editar contrato e locais de operação', 'gestor',  523),
  ('locacao.contratos.alocar', 'locacao', 'contratos', 'alocar',  'Alocar, expedir, entregar e recolher', 'atendente', 524),
  ('locacao.contratos.mover',  'locacao', 'contratos', 'mover',   'Ativar, suspender, encerrar e rescindir', 'gestor', 525)
on conflict (key) do nothing;

/* `alocar` é `atendente` pela mesma razão de `frota.mover`: quem expede e
   recolhe está no campo. Ativar e rescindir contrato é decisão comercial, e
   essa fica em `mover`, com papel de gestão. */
