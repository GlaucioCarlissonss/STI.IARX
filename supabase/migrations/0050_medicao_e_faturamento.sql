-- =============================================================================
-- 0050 — Medição e faturamento (Fase 4 da unificação com o LTI — docs/23)
-- =============================================================================
-- É aqui que a locação vira dinheiro. E a regra que governa tudo nesta migração
-- é uma só: **a fatura não é digitada**. Ela é calculada do contrato mais as
-- medições do período, e cada linha dela aponta para o que a produziu.
--
-- ## Fatura e título são coisas diferentes
--
-- A **fatura** é o documento: numeração própria, itens, cálculo conferível
-- linha a linha. É dela que sairá a NFS-e quando entrar.
-- O **título a receber** é o direito de receber, no financeiro que já existe,
-- com baixa, conciliação e fluxo de caixa.
--
-- A fatura emitida GERA o título e guarda o vínculo. A fatura não guarda saldo
-- nem recebimento; o título não guarda item nem cálculo. Cancelar a fatura
-- cancela o título. É a mesma regra que fez o orçamento do GSTI ler os títulos
-- em vez de recriá-los (docs/20).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A série de leituras
-- -----------------------------------------------------------------------------
-- A 0048 guarda a ÚLTIMA leitura no equipamento, que é o que a frota mostra.
-- Isto aqui é a série: o consumo de um período é a diferença entre duas
-- leituras, e sem o histórico essa diferença não existe — só existiria "quanto
-- marca agora", que não fatura nada.
create table public.meter_readings (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  equipment_id uuid not null references public.rental_equipment(id) on delete cascade,
  /* A alocação em que a leitura foi tirada. Nula quando a peça está na base —
     leitura de manutenção também é leitura, e perder o número porque não havia
     contrato criaria um buraco justamente onde o medidor andou sem faturar. */
  contract_item_id uuid references public.rental_contract_items(id) on delete set null,

  reading      numeric(14,2) not null check (reading >= 0),
  read_on      date not null default current_date,
  source       text not null default 'manual'
                 check (source in ('manual', 'import', 'delivery', 'return', 'agent')),
  notes        text,
  created_by   uuid,
  created_at   timestamptz not null default now()
);

create index meter_readings_equipment_idx
  on public.meter_readings (tenant_id, equipment_id, read_on desc);
create unique index meter_readings_dia_uk
  on public.meter_readings (equipment_id, read_on, source);

comment on table public.meter_readings is
  'Série de leituras do medidor. O consumo de um período é a diferença entre duas delas.';

-- -----------------------------------------------------------------------------
-- 2. A fatura
-- -----------------------------------------------------------------------------
create table public.rental_invoices (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  contract_id uuid not null references public.rental_contracts(id) on delete restrict,
  client_id   uuid not null references public.clients(id) on delete restrict,

  number      text not null,
  /* A COMPETÊNCIA é o mês a que a cobrança pertence, e não o mês em que ela é
     emitida — a mesma distinção do orçamento de TI (docs/20). Primeiro dia do
     mês, por convenção já usada nesta base. */
  competence  date not null check (app.eh_competencia(competence)),

  status      text not null default 'draft'
                check (status in ('draft', 'issued', 'cancelled')),

  issued_on   date,
  due_on      date,
  total       numeric(14,2) not null default 0 check (total >= 0),

  /* O título que esta fatura gerou. Nulo enquanto rascunho: rascunho é cálculo,
     não cobrança. */
  receivable_id uuid references public.receivables(id) on delete set null,

  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create unique index rental_invoices_number_uk
  on public.rental_invoices (tenant_id, lower(number)) where deleted_at is null;
/* Uma fatura viva por contrato e competência: duas cobranças do mesmo mês é o
   erro que o cliente encontra antes da gente. */
create unique index rental_invoices_competencia_uk
  on public.rental_invoices (contract_id, competence)
  where deleted_at is null and status <> 'cancelled';
create index rental_invoices_status_idx
  on public.rental_invoices (tenant_id, status, competence desc) where deleted_at is null;

-- -----------------------------------------------------------------------------
-- 3. As linhas da fatura
-- -----------------------------------------------------------------------------
-- Cada linha diz O QUE cobra e DE ONDE veio. `contract_item_id` e as leituras
-- são a memória de cálculo: sem elas, "excedente de 42 horas" é um número que
-- ninguém consegue conferir seis meses depois.
create table public.rental_invoice_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  invoice_id  uuid not null references public.rental_invoices(id) on delete cascade,
  contract_item_id uuid references public.rental_contract_items(id) on delete set null,
  equipment_id uuid references public.rental_equipment(id) on delete set null,

  kind        text not null
                check (kind in ('rent', 'excess', 'service', 'part', 'discount')),
  description text not null,

  /* Quantidade na unidade do que se cobra: dias de locação, horas de excedente,
     unidades de peça. */
  quantity    numeric(14,4) not null default 1 check (quantity >= 0),
  unit_price  numeric(14,4) not null default 0,
  amount      numeric(14,2) not null,

  /* A memória do cálculo do excedente. */
  meter_from  numeric(14,2),
  meter_to    numeric(14,2),
  days        integer check (days is null or days >= 0),

  created_at  timestamptz not null default now()
);

create index rental_invoice_items_invoice_idx
  on public.rental_invoice_items (tenant_id, invoice_id);

/*
 * O total da fatura é a SOMA das linhas — garantida por gatilho.
 *
 * É a regra que impede o pior tipo de defeito financeiro: um total que não bate
 * com o detalhe. Quem confere a fatura soma as linhas; se o total for um campo
 * digitado, a divergência só aparece quando o cliente reclama. Aqui o total é
 * recalculado a cada linha inserida, alterada ou removida, e ninguém o escreve
 * à mão.
 */
create or replace function app.recalcular_total_da_fatura()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_invoice uuid := coalesce(new.invoice_id, old.invoice_id);
begin
  update public.rental_invoices i
     set total = coalesce((
           select sum(x.amount) from public.rental_invoice_items x
            where x.invoice_id = v_invoice
         ), 0)
   where i.id = v_invoice;
  return null;
end;
$$;

create trigger trg_rental_invoice_items_total
  after insert or update or delete on public.rental_invoice_items
  for each row execute function app.recalcular_total_da_fatura();

-- -----------------------------------------------------------------------------
-- 4. O gatilho da emissão
-- -----------------------------------------------------------------------------
create or replace function app.validar_fatura()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if (old.status, new.status) not in (
      ('draft', 'issued'),
      ('draft', 'cancelled'),
      ('issued', 'cancelled')
    ) then
      raise exception 'transição de fatura inválida: % → %', old.status, new.status
        using errcode = '23514', constraint = 'rental_invoices_transicao';
    end if;

    /* Emitir fatura de zero é cobrança sem causa: ou faltou medição, ou o
       contrato não teve item no período. Nos dois casos, emitir esconderia o
       problema atrás de um documento. */
    if new.status = 'issued' and new.total <= 0 then
      raise exception 'fatura sem valor não é emitida: confira as medições e os itens do período'
        using errcode = '23514', constraint = 'rental_invoices_total_positivo';
    end if;

    if new.status = 'issued' and new.issued_on is null then
      new.issued_on := current_date;
    end if;
  end if;

  /* Fatura emitida não muda de valor: o documento foi para o cliente. Corrigir
     exige cancelar e refazer, que é o que deixa rastro. */
  if old.status = 'issued' and new.status = 'issued' and new.total is distinct from old.total then
    raise exception 'fatura emitida não muda de valor — cancele e refaça'
      using errcode = '23514', constraint = 'rental_invoices_emitida_imutavel';
  end if;

  return new;
end;
$$;

create trigger trg_rental_invoices_valida
  before update on public.rental_invoices
  for each row execute function app.validar_fatura();

-- -----------------------------------------------------------------------------
-- 5. Visão do consumo por alocação e competência
-- -----------------------------------------------------------------------------
-- O que a tela mostra antes de faturar, e o que o cálculo confere depois.
create or replace view public.vw_rental_consumption as
select
  i.id                as contract_item_id,
  i.tenant_id,
  i.contract_id,
  i.equipment_id,
  e.asset_tag,
  e.meter_kind,
  i.monthly_price,
  i.franchise,
  i.excess_price,
  i.delivered_on,
  i.returned_on,
  i.meter_at_delivery,
  i.meter_at_return,
  e.meter_reading     as meter_now,
  coalesce(i.meter_at_return, e.meter_reading) - coalesce(i.meter_at_delivery, 0) as meter_used
from public.rental_contract_items i
join public.rental_equipment e on e.id = i.equipment_id
where i.deleted_at is null
  and i.status in ('delivered', 'returned');

comment on view public.vw_rental_consumption is
  'Consumo acumulado por alocação: o que o cálculo da fatura lê para apurar o excedente.';

-- -----------------------------------------------------------------------------
-- 6. RLS e privilégios
-- -----------------------------------------------------------------------------
select app.harden_table('public.meter_readings');
select app.harden_table('public.rental_invoices');
select app.harden_table('public.rental_invoice_items');
select app.attach_audit('public.rental_invoices');

create policy meter_readings_select on public.meter_readings
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.frota.ver'));
create policy meter_readings_insert on public.meter_readings
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.frota.mover'));

create policy rental_invoices_select on public.rental_invoices
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.faturamento.ver'));
create policy rental_invoices_write on public.rental_invoices
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.faturamento.faturar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.faturamento.faturar'));

create policy rental_invoice_items_select on public.rental_invoice_items
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.faturamento.ver'));
create policy rental_invoice_items_write on public.rental_invoice_items
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.faturamento.faturar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.faturamento.faturar'));

grant select, insert on public.meter_readings to authenticated;
grant select, insert, update on public.rental_invoices to authenticated;
grant select, insert, update, delete on public.rental_invoice_items to authenticated;
grant select on public.vw_rental_consumption to authenticated;

-- -----------------------------------------------------------------------------
-- 7. Catálogo de permissões
-- -----------------------------------------------------------------------------
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('locacao.medicoes',            'locacao', 'medicoes',    null,       'Medições e consumo',          'visualizador', 530),
  ('locacao.medicoes.ver',        'locacao', 'medicoes',    'ver',      'Consultar medições e consumo','visualizador', 531),
  ('locacao.faturamento',         'locacao', 'faturamento', null,       'Faturamento da locação',      'gestor',       540),
  ('locacao.faturamento.ver',     'locacao', 'faturamento', 'ver',      'Consultar faturas de locação','gestor',       541),
  ('locacao.faturamento.faturar', 'locacao', 'faturamento', 'faturar',  'Gerar e emitir fatura',       'gestor',       542),
  ('locacao.faturamento.cancelar','locacao', 'faturamento', 'cancelar', 'Cancelar fatura emitida',     'gestor',       543)
on conflict (key) do nothing;

/* Faturar é `gestor` inteiro, inclusive o `ver`: a fatura mostra preço acordado
   por cliente, que é informação comercial — diferente da frota, que qualquer
   técnico precisa consultar. */
