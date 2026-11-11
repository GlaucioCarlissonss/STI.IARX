-- =============================================================================
-- 0051 — Manutenção em campo (Fase 5 da unificação com o LTI — docs/23)
-- =============================================================================
-- A ordem de serviço da locação **é um chamado**, e não uma entidade paralela.
--
-- Foi decisão de produto, e o motivo é operacional: "o que está aberto" precisa
-- ter UM lugar. Com duas listas de trabalho pendente — chamados de um lado,
-- ordens de serviço do outro — o técnico passa a ter duas filas, o SLA vale
-- para uma só, a busca acha metade, e o aplicativo mostra uma delas. O LTI tem
-- `ordem_servico` com dezesseis colunas; aqui o chamado já traz catorze delas
-- (fila, prioridade, SLA, atendente, anexo, histórico, comentário), e o que
-- falta são as três que só a locação tem.
--
-- ## As três que faltavam
--
--  1. **a qual equipamento** o atendimento se refere (e a qual alocação);
--  2. **apontamento de horas** — quem trabalhou, quanto tempo, a que custo;
--  3. **alçada de custo** — acima de um valor, fechar exige aprovação.
--
-- A peça consumida entra aqui com descrição e custo; na Fase 6, quando o
-- catálogo de peças existir, ela ganha a referência ao item de estoque. Criar a
-- coluna agora, apontando para uma tabela que não existe, seria promessa em
-- forma de schema.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A extensão de campo do chamado
-- -----------------------------------------------------------------------------
-- 1:1 com `tickets`, e não colunas dentro dele: chamado de helpdesk não tem
-- equipamento de locação, e dezessete colunas nulas em todos os chamados do
-- tenant de gestão seria o preço de não separar.
create table public.ticket_field_service (
  ticket_id    uuid primary key references public.tickets(id) on delete cascade,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,

  equipment_id uuid not null references public.rental_equipment(id) on delete restrict,
  /* A alocação em que o atendimento aconteceu. Nula quando a peça está na base
     — manutenção preventiva no galpão também é atendimento de campo, e exigir
     contrato impediria registrá-la. */
  contract_item_id uuid references public.rental_contract_items(id) on delete set null,

  kind         text not null default 'corrective'
                 check (kind in ('corrective', 'preventive', 'installation', 'removal')),

  /*
   * A ALÇADA: acima dela, fechar exige aprovação de quem pode gastar.
   *
   * Nula = sem teto, e é o padrão deliberado: inventar um limite faria o
   * primeiro conserto caro travar sem que ninguém tivesse decidido isso.
   */
  cost_limit   numeric(14,2) check (cost_limit is null or cost_limit >= 0),
  approved_by  uuid references public.profiles(id) on delete set null,
  approved_at  timestamptz,
  approval_note text,

  /* Quem pagou: a locadora (garantia, desgaste) ou o cliente (mau uso). É o
     campo que decide se o custo vira linha de fatura na Fase 6. */
  billable_to  text not null default 'provider'
                 check (billable_to in ('provider', 'client')),

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index ticket_field_service_equipment_idx
  on public.ticket_field_service (tenant_id, equipment_id);

comment on table public.ticket_field_service is
  'O que um chamado de campo tem a mais que um chamado comum: equipamento, alçada e quem paga.';

-- -----------------------------------------------------------------------------
-- 2. Apontamento de horas
-- -----------------------------------------------------------------------------
create table public.ticket_labor_entries (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  ticket_id    uuid not null references public.tickets(id) on delete cascade,
  technician_id uuid references public.profiles(id) on delete set null,

  worked_on    date not null default current_date,
  hours        numeric(6,2) not null check (hours > 0 and hours <= 24),
  hourly_rate  numeric(14,2) not null default 0 check (hourly_rate >= 0),
  /* O custo da linha é derivado, e guardado: a hora muda de preço com o tempo,
     e recalcular o passado com a tabela de hoje mudaria o custo de um serviço
     que já foi faturado. */
  amount       numeric(14,2) not null check (amount >= 0),
  notes        text,
  created_at   timestamptz not null default now()
);

create index ticket_labor_entries_ticket_idx
  on public.ticket_labor_entries (tenant_id, ticket_id);

-- -----------------------------------------------------------------------------
-- 3. Peças consumidas
-- -----------------------------------------------------------------------------
create table public.ticket_parts_used (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  ticket_id    uuid not null references public.tickets(id) on delete cascade,

  /* Descrição livre por enquanto. A Fase 6 acrescenta `part_id` referenciando o
     catálogo e passa a dar baixa no estoque — e aí esta coluna vira o nome
     congelado da peça no dia do uso, que é o que um orçamento antigo precisa. */
  description  text not null,
  quantity     numeric(14,3) not null check (quantity > 0),
  unit_cost    numeric(14,2) not null default 0 check (unit_cost >= 0),
  amount       numeric(14,2) not null check (amount >= 0),
  created_at   timestamptz not null default now()
);

create index ticket_parts_used_ticket_idx
  on public.ticket_parts_used (tenant_id, ticket_id);

-- -----------------------------------------------------------------------------
-- 4. O custo do atendimento, e a alçada
-- -----------------------------------------------------------------------------
-- `security_invoker = true` é obrigatório em TODA view daqui: sem ele a view roda
-- com os privilégios do dono, que tem `bypassrls`, e o RLS das tabelas de base
-- deixa de valer — o custo do atendimento de um tenant apareceria para outro.
-- A asserção de schema cobra isso de todas as views de `public`.
create or replace view public.vw_field_service_cost
with (security_invoker = true) as
select
  f.ticket_id,
  f.tenant_id,
  f.equipment_id,
  f.contract_item_id,
  f.kind,
  f.billable_to,
  f.cost_limit,
  f.approved_at,
  coalesce((select sum(l.amount) from public.ticket_labor_entries l where l.ticket_id = f.ticket_id), 0)
    as labor_cost,
  coalesce((select sum(pu.amount) from public.ticket_parts_used pu where pu.ticket_id = f.ticket_id), 0)
    as parts_cost,
  coalesce((select sum(l.amount) from public.ticket_labor_entries l where l.ticket_id = f.ticket_id), 0)
  + coalesce((select sum(pu.amount) from public.ticket_parts_used pu where pu.ticket_id = f.ticket_id), 0)
    as total_cost,
  coalesce((select sum(l.hours) from public.ticket_labor_entries l where l.ticket_id = f.ticket_id), 0)
    as total_hours
from public.ticket_field_service f;

comment on view public.vw_field_service_cost is
  'Custo do atendimento de campo: mão de obra + peças, somadas do detalhe.';

/*
 * A alçada vale no FECHAMENTO, e não no apontamento.
 *
 * Travar o lançamento faria o técnico parar de apontar a peça que já usou — e o
 * custo real desapareceria do sistema em vez de aparecer e pedir aprovação. O
 * atendimento acontece; o que a alçada governa é dar o serviço por concluído
 * com um custo que ninguém autorizou.
 */
create or replace function app.validar_alcada_de_campo()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_campo record;
  v_custo numeric(14,2);
begin
  if new.status not in ('resolved', 'closed') or old.status in ('resolved', 'closed') then
    return new;
  end if;

  select * into v_campo from public.ticket_field_service where ticket_id = new.id;
  if not found or v_campo.cost_limit is null or v_campo.approved_at is not null then
    return new;
  end if;

  select total_cost into v_custo from public.vw_field_service_cost where ticket_id = new.id;

  if v_custo > v_campo.cost_limit then
    /* Os números saem formatados em pt-BR aqui, e não na tela: esta frase é
       repassada inteira a quem clicou (ver `mensagemDeErro`), e "610.00" no
       meio de uma aplicação em português é o tipo de detalhe que faz a pessoa
       desconfiar do valor em vez do limite. */
    raise exception
      'custo de R$ % ultrapassa a alçada de R$ % — precisa de aprovação antes de fechar',
      replace(to_char(v_custo, 'FM999999990.00'), '.', ','),
      replace(to_char(v_campo.cost_limit, 'FM999999990.00'), '.', ',')
      using errcode = '23514',
            constraint = 'ticket_field_service_alcada',
            hint = 'Aprove o custo na aba de manutenção, ou reduza o apontamento.';
  end if;

  return new;
end;
$$;

create trigger trg_tickets_alcada_de_campo
  before update on public.tickets
  for each row execute function app.validar_alcada_de_campo();

-- -----------------------------------------------------------------------------
-- 5. RLS e privilégios
-- -----------------------------------------------------------------------------
select app.harden_table('public.ticket_field_service');
select app.harden_table('public.ticket_labor_entries');
select app.harden_table('public.ticket_parts_used');
select app.attach_audit('public.ticket_field_service');

create policy field_service_select on public.ticket_field_service
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.manutencao.ver'));
create policy field_service_write on public.ticket_field_service
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.manutencao.atender'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.manutencao.atender'));

create policy labor_entries_select on public.ticket_labor_entries
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.manutencao.ver'));
create policy labor_entries_write on public.ticket_labor_entries
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.manutencao.atender'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.manutencao.atender'));

create policy parts_used_select on public.ticket_parts_used
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.manutencao.ver'));
create policy parts_used_write on public.ticket_parts_used
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.manutencao.atender'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.manutencao.atender'));

grant select, insert, update on public.ticket_field_service to authenticated;
grant select, insert, update, delete on public.ticket_labor_entries to authenticated;
grant select, insert, update, delete on public.ticket_parts_used to authenticated;
grant select on public.vw_field_service_cost to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Catálogo de permissões
-- -----------------------------------------------------------------------------
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('locacao.manutencao',         'locacao', 'manutencao', null,      'Manutenção em campo',          'visualizador', 550),
  ('locacao.manutencao.ver',     'locacao', 'manutencao', 'ver',     'Consultar atendimentos de campo', 'visualizador', 551),
  ('locacao.manutencao.abrir',   'locacao', 'manutencao', 'abrir',   'Abrir atendimento de campo',   'atendente',    552),
  ('locacao.manutencao.atender', 'locacao', 'manutencao', 'atender', 'Apontar horas e peças',        'atendente',    553),
  ('locacao.manutencao.aprovar', 'locacao', 'manutencao', 'aprovar', 'Aprovar custo acima da alçada','gestor',       554)
on conflict (key) do nothing;

/* Aprovar é `gestor`, e apontar é `atendente`: quem gasta não é quem autoriza o
   gasto. É a mesma separação da alçada de títulos a pagar. */
