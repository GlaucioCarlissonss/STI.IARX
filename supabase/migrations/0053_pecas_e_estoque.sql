-- =============================================================================
-- 0053 — Peças, estoque e compras (Fase 6 da unificação com o LTI — docs/23)
-- =============================================================================
-- Quatro decisões governam este arquivo inteiro. Elas estão escritas aqui porque
-- daqui a seis meses o motivo some antes do código.
--
-- ## 1. O saldo é DERIVADO, nunca digitado
--
-- `part_movements` é o razão; `part_balances` é o acumulado, mantido por
-- gatilho. Um campo de saldo editável é a forma mais rápida de o estoque e a
-- realidade se separarem — e de ninguém descobrir quando, porque a divergência
-- não deixa rastro. Aqui, para o saldo mudar, alguém precisa dizer POR QUÊ:
-- entrou por compra, saiu por atendimento, foi ajustado por contagem.
--
-- ## 2. Saldo negativo é recusado
--
-- Saldo negativo não é um número menor que zero: é a confissão de que falta um
-- movimento. Aceitá-lo faria o sistema continuar operando sobre uma mentira
-- aritmética, e o inventário seguinte "corrigiria" uma diferença que nunca
-- existiu fisicamente.
--
-- ## 3. A política de reposição é por peça E DEPÓSITO
--
-- O mínimo da oficina não é o mínimo do galpão. Uma política por peça obrigaria
-- a escolher entre encher a oficina ou desabastecê-la.
--
-- ## 4. A NF de compra gera o título a pagar QUE JÁ EXISTE
--
-- Simétrico à Fase 4, onde a fatura de locação gera o `receivable`. O segundo
-- financeiro é a forma clássica de um ERP passar a ter duas verdades sobre o
-- mesmo dinheiro.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. O catálogo de peças
-- -----------------------------------------------------------------------------
create table public.parts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  sku           text not null,
  name          text not null,
  manufacturer_id uuid references public.equipment_manufacturers(id) on delete set null,
  /* A unidade é do CADASTRO, e não do movimento: a mesma peça contada em
     unidades numa entrada e em metros noutra daria um saldo sem significado. */
  unit          text not null default 'un'
                  check (unit in ('un', 'm', 'kg', 'l', 'cx', 'par')),
  category      text,

  /*
   * Custo médio móvel, mantido pelo gatilho da entrada.
   *
   * Guardado, e não calculado na leitura: o custo de hoje não pode reescrever o
   * valor de um consumo que já foi faturado. É a mesma razão de
   * `ticket_labor_entries.amount` existir.
   */
  average_cost  numeric(14,4) not null default 0 check (average_cost >= 0),

  notes         text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create unique index parts_sku_uk
  on public.parts (tenant_id, lower(sku)) where deleted_at is null;
create index parts_tenant_idx on public.parts (tenant_id) where deleted_at is null;

comment on table public.parts is
  'Catálogo de peças. O saldo NÃO mora aqui — ver part_balances, que é derivado dos movimentos.';

-- -----------------------------------------------------------------------------
-- 2. Política de reposição — por peça e depósito
-- -----------------------------------------------------------------------------
create table public.part_stock_policies (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  part_id      uuid not null references public.parts(id) on delete cascade,
  depot_id     uuid not null references public.rental_depots(id) on delete cascade,

  min_quantity numeric(14,3) not null default 0 check (min_quantity >= 0),
  max_quantity numeric(14,3) not null default 0 check (max_quantity >= 0),
  lead_time_days integer check (lead_time_days is null or lead_time_days >= 0),

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  /* Máximo abaixo do mínimo é política impossível: a sugestão de compra
     (máximo − saldo) nasceria negativa e a peça nunca sairia da lista. */
  constraint part_stock_policies_faixa check (max_quantity >= min_quantity)
);

create unique index part_stock_policies_uk
  on public.part_stock_policies (part_id, depot_id);

-- -----------------------------------------------------------------------------
-- 3. O saldo — acumulado, mantido por gatilho
-- -----------------------------------------------------------------------------
create table public.part_balances (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  part_id    uuid not null references public.parts(id) on delete cascade,
  depot_id   uuid not null references public.rental_depots(id) on delete cascade,

  quantity   numeric(14,3) not null default 0 check (quantity >= 0),
  last_movement_at timestamptz,

  updated_at timestamptz not null default now()
);

create unique index part_balances_uk on public.part_balances (part_id, depot_id);
create index part_balances_tenant_idx on public.part_balances (tenant_id);

comment on table public.part_balances is
  'Saldo por peça e depósito. Escrito SOMENTE pelo gatilho de part_movements — a aplicação nunca o atualiza direto.';

-- -----------------------------------------------------------------------------
-- 4. O razão
-- -----------------------------------------------------------------------------
create table public.part_movements (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  part_id    uuid not null references public.parts(id) on delete restrict,
  depot_id   uuid not null references public.rental_depots(id) on delete restrict,

  kind       text not null check (kind in (
               'purchase',     -- entrada por compra
               'consumption',  -- baixa por atendimento de campo
               'return',       -- devolução ao estoque
               'adjustment',   -- ajuste de contagem
               'transfer_in',  -- chegada de transferência
               'transfer_out'  -- saída de transferência
             )),

  /*
   * A QUANTIDADE É ASSINADA, e o sinal é o fato.
   *
   * A alternativa — quantidade positiva mais uma coluna de direção — obriga
   * toda soma a conhecer a tabela de direções, e o primeiro relatório que
   * esquecer vira um saldo errado que ninguém confere. Com o sinal no número,
   * o saldo é `sum(quantity)` e não há como somar errado.
   */
  quantity   numeric(14,3) not null check (quantity <> 0),
  unit_cost  numeric(14,4) check (unit_cost is null or unit_cost >= 0),

  -- De onde o movimento veio. Nenhum é obrigatório; todos são rastro.
  ticket_id          uuid references public.tickets(id) on delete set null,
  purchase_order_id  uuid,
  inventory_count_id uuid,
  transfer_depot_id  uuid references public.rental_depots(id) on delete set null,

  notes      text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index part_movements_part_idx
  on public.part_movements (tenant_id, part_id, depot_id, created_at desc);
create index part_movements_ticket_idx
  on public.part_movements (ticket_id) where ticket_id is not null;

comment on table public.part_movements is
  'O razão do estoque. O saldo é a soma desta coluna — por isso ela é assinada.';

/**
 * Número em pt-BR, sem zero nem ponto sobrando: 2 → "2", 2.5 → "2,5".
 *
 * Existe porque estas mensagens vão INTEIRAS para a tela (ver `mensagemDeErro`),
 * e são lidas por quem está conferindo estoque, não por quem escreveu o schema.
 */
create or replace function app.numero_pt(p_valor numeric)
returns text
language sql
immutable
as $$
  select replace(
    rtrim(rtrim(to_char(p_valor, 'FM999999990.999'), '0'), '.'),
    '.', ',');
$$;

/*
 * O gatilho que mantém o saldo, e recusa o negativo.
 *
 * Ele roda DEPOIS da inserção porque precisa do movimento gravado para somar; a
 * recusa é feita antes de gravar o saldo, então a transação inteira volta e não
 * sobra movimento órfão.
 */
create or replace function app.aplicar_movimento_de_peca()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_saldo numeric(14,3);
  v_antes numeric(14,3);
  v_peca  text;
begin
  select quantity into v_antes
    from public.part_balances
   where part_id = new.part_id and depot_id = new.depot_id;

  v_saldo := coalesce(v_antes, 0) + new.quantity;

  if v_saldo < 0 then
    select sku || ' — ' || name into v_peca from public.parts where id = new.part_id;
    /* `app.numero_pt` em vez de `to_char` cru: o formato `FM...999` devolve
       "2." para um valor inteiro, e um ponto solto no meio de uma frase em
       português faz a pessoa desconfiar do número em vez da regra. */
    raise exception
      'saldo de % ficaria negativo (% em estoque, movimento de %)',
      coalesce(v_peca, 'peça'),
      app.numero_pt(coalesce(v_antes, 0)),
      app.numero_pt(new.quantity)
      using errcode = '23514',
            constraint = 'part_balances_nao_negativo',
            hint = 'Dê entrada antes, ou corrija a quantidade. Saldo negativo é movimento faltando, não número.';
  end if;

  insert into public.part_balances
    (tenant_id, part_id, depot_id, quantity, last_movement_at, updated_at)
  values (new.tenant_id, new.part_id, new.depot_id, v_saldo, new.created_at, now())
  on conflict (part_id, depot_id) do update
    set quantity = excluded.quantity,
        last_movement_at = excluded.last_movement_at,
        updated_at = now();

  /*
   * Custo médio MÓVEL, e só na entrada paga.
   *
   * Saída não muda custo médio — se mudasse, consumir barato encareceria o que
   * sobrou. Ajuste de contagem também não: a diferença é de quantidade, e
   * atribuir-lhe um preço inventaria um custo que ninguém pagou.
   */
  if new.kind = 'purchase' and new.unit_cost is not null and new.quantity > 0 then
    update public.parts p
       set average_cost = case
             when coalesce(v_antes, 0) <= 0 then new.unit_cost
             else ((coalesce(v_antes, 0) * p.average_cost) + (new.quantity * new.unit_cost))
                  / (coalesce(v_antes, 0) + new.quantity)
           end
     where p.id = new.part_id;
  end if;

  return new;
end;
$$;

create trigger trg_part_movements_aplica
  after insert on public.part_movements
  for each row execute function app.aplicar_movimento_de_peca();

/*
 * Movimento não se edita nem se apaga.
 *
 * Um razão corrigível por baixo é um razão que não prova nada: o saldo deixaria
 * de ser explicável pela lista de movimentos, que é a única coisa que torna o
 * estoque auditável. Errou? Lança o movimento contrário, e os dois ficam à
 * vista — que é como a contabilidade faz há quinhentos anos.
 */
create or replace function app.movimento_de_peca_e_imutavel()
returns trigger
language plpgsql
as $$
begin
  raise exception 'movimento de estoque não se altera nem se exclui'
    using errcode = '23514',
          hint = 'Lance o movimento contrário: o razão guarda o erro E a correção.';
end;
$$;

create trigger trg_part_movements_imutavel
  before update or delete on public.part_movements
  for each row execute function app.movimento_de_peca_e_imutavel();

-- -----------------------------------------------------------------------------
-- 5. A peça do atendimento passa a conhecer o catálogo
-- -----------------------------------------------------------------------------
/*
 * `part_id` é OPCIONAL, de propósito.
 *
 * Exigir cadastro para lançar a peça faria o técnico não lançar — e a Fase 5 já
 * ensinou para onde isso leva: o custo real desaparece em vez de aparecer. A
 * peça avulsa continua aceita; a peça do catálogo dá baixa sozinha.
 */
alter table public.ticket_parts_used
  add column part_id  uuid references public.parts(id) on delete set null,
  add column depot_id uuid references public.rental_depots(id) on delete set null;

create index ticket_parts_used_part_idx
  on public.ticket_parts_used (part_id) where part_id is not null;

create or replace function app.baixar_peca_do_estoque()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_depot uuid;
begin
  if new.part_id is null then
    return new;
  end if;

  /* Sem depósito informado, sai do depósito que TEM a peça — e, entre eles, do
     que tem mais. Escolher o primeiro por ordem alfabética zeraria a oficina
     enquanto o galpão está cheio. */
  v_depot := new.depot_id;
  if v_depot is null then
    select depot_id into v_depot
      from public.part_balances
     where part_id = new.part_id and quantity >= new.quantity
     order by quantity desc
     limit 1;
  end if;

  if v_depot is null then
    raise exception 'nenhum depósito tem % desta peça em estoque', new.quantity
      using errcode = '23514',
            constraint = 'part_balances_nao_negativo',
            hint = 'Dê entrada por compra, ou lance a peça como avulsa (sem catálogo).';
  end if;

  insert into public.part_movements
    (tenant_id, part_id, depot_id, kind, quantity, unit_cost, ticket_id, notes)
  values (new.tenant_id, new.part_id, v_depot, 'consumption', -new.quantity,
          nullif(new.unit_cost, 0), new.ticket_id,
          'Baixa automática pelo apontamento de campo');

  return new;
end;
$$;

create trigger trg_ticket_parts_used_baixa
  after insert on public.ticket_parts_used
  for each row execute function app.baixar_peca_do_estoque();

/*
 * Remover o apontamento DEVOLVE a peça ao estoque.
 *
 * A Fase 5 permite remover um apontamento lançado por engano. Sem esta
 * devolução, o engano custaria uma peça no saldo para sempre — e o inventário
 * seguinte encontraria uma sobra que ninguém sabe explicar.
 */
create or replace function app.devolver_peca_ao_estoque()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_mov record;
begin
  if old.part_id is null then
    return old;
  end if;

  select * into v_mov
    from public.part_movements
   where ticket_id = old.ticket_id and part_id = old.part_id and kind = 'consumption'
   order by created_at desc
   limit 1;

  if found then
    insert into public.part_movements
      (tenant_id, part_id, depot_id, kind, quantity, ticket_id, notes)
    values (old.tenant_id, old.part_id, v_mov.depot_id, 'return', old.quantity, old.ticket_id,
            'Devolução: apontamento removido');
  end if;

  return old;
end;
$$;

create trigger trg_ticket_parts_used_devolve
  after delete on public.ticket_parts_used
  for each row execute function app.devolver_peca_ao_estoque();

-- -----------------------------------------------------------------------------
-- 6. Ordem de compra
-- -----------------------------------------------------------------------------
create table public.purchase_orders (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  supplier_id uuid references public.suppliers(id) on delete restrict,
  depot_id    uuid not null references public.rental_depots(id) on delete restrict,

  code        text not null,
  status      text not null default 'draft'
                check (status in ('draft', 'sent', 'partial', 'received', 'cancelled')),
  expected_on date,

  /* Total = soma das linhas, garantido por gatilho. Mesma regra da fatura da
     0050: um total digitado é um total que diverge. */
  total       numeric(14,2) not null default 0 check (total >= 0),

  -- A NF e o título que ela gerou. Ver a decisão 4 no cabeçalho.
  invoice_ref text,
  payable_id  uuid references public.payables(id) on delete set null,

  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create unique index purchase_orders_code_uk
  on public.purchase_orders (tenant_id, lower(code)) where deleted_at is null;
create index purchase_orders_tenant_idx
  on public.purchase_orders (tenant_id, status) where deleted_at is null;

create table public.purchase_order_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  order_id    uuid not null references public.purchase_orders(id) on delete cascade,
  part_id     uuid not null references public.parts(id) on delete restrict,

  quantity    numeric(14,3) not null check (quantity > 0),
  unit_price  numeric(14,4) not null default 0 check (unit_price >= 0),
  amount      numeric(14,2) not null check (amount >= 0),

  /*
   * Recebimento PARCIAL é o caso normal, não a exceção.
   *
   * Fechar a ordem na primeira entrega perderia o que falta — e é exatamente o
   * que faz alguém comprar de novo o que já está a caminho.
   */
  received_quantity numeric(14,3) not null default 0 check (received_quantity >= 0),

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint purchase_order_items_recebido_cabe check (received_quantity <= quantity)
);

create index purchase_order_items_order_idx on public.purchase_order_items (order_id);

create or replace function app.recalcular_total_da_ordem()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_order uuid := coalesce(new.order_id, old.order_id);
begin
  update public.purchase_orders o
     set total = coalesce(
           (select sum(i.amount) from public.purchase_order_items i where i.order_id = v_order), 0),
         updated_at = now()
   where o.id = v_order;
  return coalesce(new, old);
end;
$$;

create trigger trg_purchase_order_items_total
  after insert or update or delete on public.purchase_order_items
  for each row execute function app.recalcular_total_da_ordem();

-- -----------------------------------------------------------------------------
-- 7. Contagem de inventário
-- -----------------------------------------------------------------------------
create table public.inventory_counts (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  depot_id   uuid not null references public.rental_depots(id) on delete restrict,

  code       text not null,
  status     text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  counted_on date not null default current_date,
  closed_at  timestamptz,
  closed_by  uuid references public.profiles(id) on delete set null,
  notes      text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index inventory_counts_code_uk on public.inventory_counts (tenant_id, lower(code));

create table public.inventory_count_items (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  count_id  uuid not null references public.inventory_counts(id) on delete cascade,
  part_id   uuid not null references public.parts(id) on delete restrict,

  /*
   * O esperado é CONGELADO na abertura da contagem.
   *
   * Lê-lo do saldo no fechamento compararia a contagem de ontem com o estoque
   * de hoje: a peça consumida no meio viraria uma "falta" que nunca houve.
   */
  expected_quantity numeric(14,3) not null,
  counted_quantity  numeric(14,3),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index inventory_count_items_uk on public.inventory_count_items (count_id, part_id);

/*
 * Fechar a contagem gera os AJUSTES — um movimento por diferença.
 *
 * A diferença não é apagada nem sobrescrita no saldo: ela vira um movimento com
 * data, autor e vínculo à contagem. É o que permite, meses depois, responder
 * "por que sumiram duas?" com uma linha em vez de um silêncio.
 */
create or replace function app.fechar_contagem_de_inventario()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_item record;
  v_dif  numeric(14,3);
begin
  if new.status <> 'closed' or old.status = 'closed' then
    return new;
  end if;

  if exists (
    select 1 from public.inventory_count_items
     where count_id = new.id and counted_quantity is null
  ) then
    raise exception 'há item sem contagem informada — uma contagem incompleta não ajusta nada'
      using errcode = '23514',
            hint = 'Informe a quantidade contada de cada item, ou remova o item da contagem.';
  end if;

  for v_item in
    select * from public.inventory_count_items where count_id = new.id
  loop
    v_dif := v_item.counted_quantity - v_item.expected_quantity;
    if v_dif <> 0 then
      insert into public.part_movements
        (tenant_id, part_id, depot_id, kind, quantity, inventory_count_id, notes, created_by)
      values (new.tenant_id, v_item.part_id, new.depot_id, 'adjustment', v_dif, new.id,
              format('Contagem %s: esperado %s, contado %s',
                     new.code,
                     app.numero_pt(v_item.expected_quantity),
                     app.numero_pt(v_item.counted_quantity)),
              new.closed_by);
    end if;
  end loop;

  new.closed_at := now();
  return new;
end;
$$;

create trigger trg_inventory_counts_fecha
  before update on public.inventory_counts
  for each row execute function app.fechar_contagem_de_inventario();

-- -----------------------------------------------------------------------------
-- 8. A visão que a tela desenha
-- -----------------------------------------------------------------------------
create or replace view public.vw_part_stock
with (security_invoker = true) as
select
  p.id                      as part_id,
  p.tenant_id,
  p.sku,
  p.name,
  p.unit,
  p.category,
  p.average_cost,
  p.is_active,
  d.id                      as depot_id,
  d.name                    as depot_name,
  coalesce(b.quantity, 0)   as quantity,
  b.last_movement_at,
  pol.min_quantity,
  pol.max_quantity,
  pol.lead_time_days,
  /* A sugestão é MÁXIMO − saldo, e não mínimo − saldo: repor até o mínimo faz
     comprar de novo na semana seguinte. */
  case
    when pol.min_quantity is null then null
    when coalesce(b.quantity, 0) > pol.min_quantity then 0
    else greatest(pol.max_quantity - coalesce(b.quantity, 0), 0)
  end                       as suggested_purchase,
  case
    when pol.min_quantity is null then 'sem_politica'
    when coalesce(b.quantity, 0) <= 0 then 'zerado'
    when coalesce(b.quantity, 0) < pol.min_quantity then 'abaixo'
    when coalesce(b.quantity, 0) = pol.min_quantity then 'no_limite'
    else 'em_nivel'
  end                       as level,
  coalesce(b.quantity, 0) * p.average_cost as stock_value
from public.parts p
join public.rental_depots d
  on d.tenant_id = p.tenant_id and d.deleted_at is null
left join public.part_balances b on b.part_id = p.id and b.depot_id = d.id
left join public.part_stock_policies pol on pol.part_id = p.id and pol.depot_id = d.id
where p.deleted_at is null
  /* A peça aparece no depósito onde ela TEM saldo ou TEM política. O produto
     cartesiano cru mostraria 48 peças × 2 depósitos = 96 linhas, das quais a
     maioria diria apenas "zero, e ninguém pediu para haver". */
  and (b.id is not null or pol.id is not null);

comment on view public.vw_part_stock is
  'Peça × depósito com saldo, política e sugestão de compra — a linha que a tela de estoque desenha.';

-- -----------------------------------------------------------------------------
-- 9. RLS e privilégios
-- -----------------------------------------------------------------------------
select app.harden_table('public.parts');
select app.harden_table('public.part_stock_policies');
select app.harden_table('public.part_balances');
select app.harden_table('public.part_movements');
select app.harden_table('public.purchase_orders');
select app.harden_table('public.purchase_order_items');
select app.harden_table('public.inventory_counts');
select app.harden_table('public.inventory_count_items');

select app.attach_audit('public.parts');
select app.attach_audit('public.purchase_orders');
select app.attach_audit('public.inventory_counts');

-- Peças: ver é de quem atende (o técnico precisa saber se tem a peça).
create policy parts_select on public.parts
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.pecas.ver'));
create policy parts_write on public.parts
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.pecas.gerenciar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.pecas.gerenciar'));

create policy part_policies_select on public.part_stock_policies
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.pecas.ver'));
create policy part_policies_write on public.part_stock_policies
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.pecas.gerenciar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.pecas.gerenciar'));

/*
 * O SALDO É SÓ DE LEITURA PARA TODO MUNDO.
 *
 * Não há policy de escrita: nem o gestor edita o saldo pela aplicação. Quem o
 * escreve é o gatilho, que é `security definer` e por isso não passa por aqui.
 * É a trava que torna a decisão 1 verdadeira em vez de combinada.
 */
create policy part_balances_select on public.part_balances
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.pecas.ver'));

create policy part_movements_select on public.part_movements
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.pecas.ver'));
create policy part_movements_insert on public.part_movements
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.pecas.movimentar'));

create policy purchase_orders_select on public.purchase_orders
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.compras.ver'));
create policy purchase_orders_write on public.purchase_orders
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.compras.gerenciar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.compras.gerenciar'));

create policy purchase_items_select on public.purchase_order_items
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.compras.ver'));
create policy purchase_items_write on public.purchase_order_items
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.compras.gerenciar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.compras.gerenciar'));

create policy inventory_counts_select on public.inventory_counts
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.contagens.ver'));
create policy inventory_counts_write on public.inventory_counts
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.contagens.contar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.contagens.contar'));

create policy inventory_items_select on public.inventory_count_items
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.contagens.ver'));
create policy inventory_items_write on public.inventory_count_items
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.contagens.contar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.contagens.contar'));

grant select, insert, update on public.parts to authenticated;
grant select, insert, update, delete on public.part_stock_policies to authenticated;
grant select on public.part_balances to authenticated;
grant select, insert on public.part_movements to authenticated;
grant select, insert, update on public.purchase_orders to authenticated;
grant select, insert, update, delete on public.purchase_order_items to authenticated;
grant select, insert, update on public.inventory_counts to authenticated;
grant select, insert, update, delete on public.inventory_count_items to authenticated;
grant select on public.vw_part_stock to authenticated;

-- -----------------------------------------------------------------------------
-- 10. Catálogo de permissões
-- -----------------------------------------------------------------------------
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('locacao.pecas',              'locacao', 'pecas',      null,         'Peças e estoque',                'visualizador', 560),
  ('locacao.pecas.ver',          'locacao', 'pecas',      'ver',        'Consultar peças e saldo',        'visualizador', 561),
  ('locacao.pecas.gerenciar',    'locacao', 'pecas',      'gerenciar',  'Cadastrar peça e política',      'gestor',       562),
  ('locacao.pecas.movimentar',   'locacao', 'pecas',      'movimentar', 'Lançar entrada, saída e transferência', 'atendente', 563),
  ('locacao.compras',            'locacao', 'compras',    null,         'Ordens de compra',               'atendente',    570),
  ('locacao.compras.ver',        'locacao', 'compras',    'ver',        'Consultar ordens de compra',     'atendente',    571),
  ('locacao.compras.gerenciar',  'locacao', 'compras',    'gerenciar',  'Criar, enviar e cancelar ordem', 'gestor',       572),
  ('locacao.compras.receber',    'locacao', 'compras',    'receber',    'Receber mercadoria',             'atendente',    573),
  ('locacao.compras.faturar',    'locacao', 'compras',    'faturar',    'Registrar NF e gerar título a pagar', 'gestor',  574),
  ('locacao.contagens',          'locacao', 'contagens',  null,         'Contagens de inventário',        'visualizador', 580),
  ('locacao.contagens.ver',      'locacao', 'contagens',  'ver',        'Consultar contagens',            'visualizador', 581),
  ('locacao.contagens.contar',   'locacao', 'contagens',  'contar',     'Abrir e lançar contagem',        'atendente',    582),
  ('locacao.contagens.fechar',   'locacao', 'contagens',  'fechar',     'Fechar contagem e gerar ajustes','gestor',       583)
on conflict (key) do nothing;

/*
 * Receber é `atendente` — quem está na doca confere a entrega. Registrar a NF é
 * `gestor`, porque é o que vira dinheiro a pagar. Fechar contagem é `gestor`
 * pelo mesmo motivo: o ajuste é uma perda ou uma sobra reconhecida.
 *
 * ## Por que a TELA de compras é `atendente`, e não `gestor`
 *
 * A primeira versão deste arquivo pôs a tela em `gestor` — preço de fornecedor
 * é informação comercial — e deixou `receber` em `atendente`. A asserção de
 * integridade do catálogo recusou, e com razão: uma ação nunca pode exigir
 * papel MENOR que a tela que a contém, senão ela fica inalcançável. Quem
 * recebe não conseguiria abrir a tela onde se recebe.
 *
 * Entre baixar a tela e subir a ação, baixar é o certo: a pessoa da doca
 * precisa mesmo ver o que foi pedido para conferir o que chegou. Esconder
 * preço de quem tem acesso à tela é controle de CAMPO, e não de papel —
 * fingir resolvê-lo com rank só quebraria o alcance sem esconder nada.
 */
