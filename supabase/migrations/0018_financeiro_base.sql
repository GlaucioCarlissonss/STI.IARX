-- =============================================================================
-- 0018 — Base do financeiro: centros de custo e contas bancárias
-- =============================================================================
-- Terceiro item da ordem de prioridade: são as duas dimensões que TODO
-- lançamento financeiro precisa referenciar. Criar contas a pagar antes delas
-- produziria títulos sem centro de custo e sem conta de origem — ou seja, sem
-- como responder "quanto a operação gastou" nem "de qual conta saiu", que são as
-- duas perguntas que justificam o módulo.
--
-- Não há tabela de título aqui. Contas a pagar e a receber vêm depois, quando
-- estas duas estiverem em uso e a camada de permissão validada na prática.

-- -----------------------------------------------------------------------------
-- Correção estrutural: supplier_contracts precisa ser referenciável
-- -----------------------------------------------------------------------------
-- `supplier_contracts` nasceu sem `unique (id, tenant_id)` (0008_suppliers.sql),
-- e é essa chave composta que o padrão do ADR-001 exige para uma FK não
-- atravessar tenant. Sem ela, o vínculo "título a pagar → contrato do
-- fornecedor" seria impossível de expressar com segurança, e a alternativa (FK
-- só por `id`) deixaria um título de um tenant apontar para o contrato de outro.
alter table public.supplier_contracts
  add constraint uq_supplier_contracts_id_tenant unique (id, tenant_id);

-- -----------------------------------------------------------------------------
-- cost_centers — hierarquia de até 3 níveis
-- -----------------------------------------------------------------------------
create table public.cost_centers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  parent_id   uuid,
  code        text not null,
  name        text not null,
  description text,
  -- Nulo = centro global do tenant. Preenchido = centro daquela filial, e o
  -- rateio de despesa passa a poder ser cobrado por unidade.
  branch_id   uuid,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint uq_cost_centers_id_tenant unique (id, tenant_id),
  constraint fk_cost_center_parent foreign key (parent_id, tenant_id)
    references public.cost_centers (id, tenant_id) on delete restrict,
  constraint fk_cost_center_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete restrict,
  -- Um centro não pode ser pai de si mesmo. O ciclo mais longo é barrado pela
  -- trigger de profundidade abaixo.
  constraint cost_centers_no_self_parent check (parent_id is null or parent_id <> id)
);

create unique index uq_cost_centers_code on public.cost_centers (tenant_id, lower(code));
create index idx_cost_centers_parent on public.cost_centers (parent_id);
create index idx_cost_centers_tenant on public.cost_centers (tenant_id) where is_active;
create index idx_cost_centers_branch on public.cost_centers (branch_id) where branch_id is not null;

comment on table public.cost_centers is
  'Centros de custo hierárquicos (máx. 3 níveis). Dimensão de rateio dos lançamentos financeiros.';

/**
 * Profundidade máxima 3 (centro → subcentro → sub-subcentro).
 *
 * Mesma decisão de `app.enforce_category_depth()` (0004_taxonomy_queues.sql) e
 * pelo mesmo motivo: relatório de DRE e a UI de seleção precisam de uma
 * profundidade conhecida. Árvore arbitrária transformaria todo relatório em
 * recursão de profundidade desconhecida, sem que ninguém tenha pedido isso.
 */
create or replace function app.enforce_cost_center_depth()
returns trigger
language plpgsql
as $$
declare
  v_nivel int := 1;
  v_atual uuid := new.parent_id;
begin
  while v_atual is not null loop
    v_nivel := v_nivel + 1;
    if v_nivel > 3 then
      raise exception 'Centros de custo suportam no máximo 3 níveis'
        using errcode = 'check_violation';
    end if;
    select parent_id into v_atual from public.cost_centers where id = v_atual;
    -- Ciclo: sem esta saída, um pai apontando para um descendente giraria para
    -- sempre e travaria a transação em vez de recusá-la.
    if v_atual = new.id then
      raise exception 'Hierarquia de centro de custo não pode formar ciclo'
        using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end;
$$;

create trigger trg_cost_center_depth
  before insert or update of parent_id on public.cost_centers
  for each row execute function app.enforce_cost_center_depth();

-- -----------------------------------------------------------------------------
-- bank_accounts
-- -----------------------------------------------------------------------------
create table public.bank_accounts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,
  bank_code       text,
  bank_name       text not null,
  agency          text,
  account_number  text,
  account_type    text not null default 'checking'
                    check (account_type in ('checking','savings','payment','investment')),
  holder_name     text,
  holder_document text,
  -- Saldo inicial é o ponto de partida da conciliação: o saldo corrente é
  -- DERIVADO (ver vw_bank_account_balances) e nunca gravado, porque saldo
  -- materializado e movimentação divergem no primeiro erro de arredondamento.
  opening_balance numeric(14,2) not null default 0,
  -- Limite de cheque especial / crédito. Positivo, aplicado abaixo de zero.
  credit_limit    numeric(14,2) not null default 0 check (credit_limit >= 0),
  status          text not null default 'active'
                    check (status in ('active','inactive','blocked')),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint uq_bank_accounts_id_tenant unique (id, tenant_id)
);

create unique index uq_bank_accounts_identity
  on public.bank_accounts (tenant_id, bank_code, agency, account_number)
  where deleted_at is null and account_number is not null;
create index idx_bank_accounts_tenant on public.bank_accounts (tenant_id)
  where deleted_at is null;

comment on table public.bank_accounts is
  'Contas bancárias do tenant. O saldo corrente é derivado das movimentações, nunca gravado aqui.';

-- -----------------------------------------------------------------------------
-- bank_account_movements
-- -----------------------------------------------------------------------------
create table public.bank_account_movements (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  bank_account_id uuid not null,
  direction       text not null check (direction in ('in','out')),
  -- Sempre positivo; o sinal é responsabilidade de `direction`. Guardar valor
  -- negativo para saída duplicaria a informação e permitiria a combinação
  -- absurda "saída de valor negativo".
  amount          numeric(14,2) not null check (amount > 0),
  moved_on        date not null,
  description     text not null,
  cost_center_id  uuid,
  -- Transferência interna é DUPLA ENTRADA: duas linhas com o mesmo grupo, uma
  -- `out` na origem e uma `in` no destino. Sem o grupo não haveria como saber
  -- que as duas metades são o mesmo fato, e o extrato mostraria uma saída
  -- inexplicada em uma conta e uma entrada inexplicada em outra.
  transfer_group  uuid,
  reconciled_at   timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint fk_movement_account foreign key (bank_account_id, tenant_id)
    references public.bank_accounts (id, tenant_id) on delete restrict,
  constraint fk_movement_cost_center foreign key (cost_center_id, tenant_id)
    references public.cost_centers (id, tenant_id) on delete restrict
);

create index idx_movements_account on public.bank_account_movements (bank_account_id, moved_on desc);
create index idx_movements_tenant on public.bank_account_movements (tenant_id, moved_on desc);
create index idx_movements_transfer on public.bank_account_movements (transfer_group)
  where transfer_group is not null;
create index idx_movements_unreconciled on public.bank_account_movements (tenant_id, moved_on)
  where reconciled_at is null;

comment on table public.bank_account_movements is
  'Entradas e saídas por conta. Transferência interna = duas linhas com o mesmo transfer_group.';

/**
 * Uma transferência tem exatamente duas metades, em contas diferentes, de
 * valores iguais e sentidos opostos.
 *
 * A checagem é AFTER e por STATEMENT: dentro de uma inserção de duas linhas, a
 * primeira metade sozinha é sempre "inválida", e uma trigger FOR EACH ROW
 * recusaria a transferência inteira antes de a segunda linha existir.
 */
create or replace function app.validate_transfer_pairs()
returns trigger
language plpgsql
as $$
declare
  v_grupo record;
begin
  for v_grupo in
    select transfer_group
    from public.bank_account_movements
    where transfer_group is not null
    group by transfer_group
    having count(*) <> 2
        or count(distinct bank_account_id) <> 2
        or count(distinct amount) <> 1
        or count(distinct direction) <> 2
  loop
    raise exception 'Transferência % precisa de duas metades, em contas distintas, de mesmo valor e sentidos opostos',
      v_grupo.transfer_group
      using errcode = 'check_violation';
  end loop;
  return null;
end;
$$;

create constraint trigger trg_movements_transfer_pairs
  after insert or update or delete on public.bank_account_movements
  deferrable initially deferred
  for each row execute function app.validate_transfer_pairs();

-- -----------------------------------------------------------------------------
-- vw_bank_account_balances — saldo derivado
-- -----------------------------------------------------------------------------
create view public.vw_bank_account_balances
with (security_invoker = true) as
select
  a.id                as bank_account_id,
  a.tenant_id,
  a.name,
  a.bank_name,
  a.account_type,
  a.status,
  a.opening_balance,
  a.credit_limit,
  coalesce(sum(case when m.direction = 'in'  then m.amount end), 0) as total_in,
  coalesce(sum(case when m.direction = 'out' then m.amount end), 0) as total_out,
  a.opening_balance
    + coalesce(sum(case when m.direction = 'in'  then m.amount end), 0)
    - coalesce(sum(case when m.direction = 'out' then m.amount end), 0) as current_balance,
  count(m.id) filter (where m.reconciled_at is null) as unreconciled_count,
  max(m.moved_on) as last_movement_on
from public.bank_accounts a
left join public.bank_account_movements m on m.bank_account_id = a.id
where a.deleted_at is null
group by a.id, a.tenant_id, a.name, a.bank_name, a.account_type, a.status,
         a.opening_balance, a.credit_limit;

comment on view public.vw_bank_account_balances is
  'Saldo corrente por conta = saldo inicial + entradas - saídas, com contagem de não conciliados.';

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
select app.harden_table('public.cost_centers');
select app.harden_table('public.bank_accounts');
select app.harden_table('public.bank_account_movements');

select app.attach_audit('public.cost_centers');
select app.attach_audit('public.bank_accounts');
select app.attach_audit('public.bank_account_movements');

-- Mesma forma das demais tabelas de cadastro do tenant (0012_rls_policies.sql):
-- leitura para todo o tenant, escrita para quem administra registros. O teto
-- efetivo já passa pelo perfil de acesso via `app.effective_base_role()`.
do $$
declare
  t text;
begin
  foreach t in array array['cost_centers','bank_accounts','bank_account_movements'] loop
    execute format($f$
      create policy %1$s_select on public.%1$s
        for select to authenticated
        using (tenant_id = app.current_tenant_id());
    $f$, t);
    execute format($f$
      create policy %1$s_insert on public.%1$s
        for insert to authenticated
        with check (tenant_id = app.current_tenant_id() and app.can_manage_records());
    $f$, t);
    execute format($f$
      create policy %1$s_update on public.%1$s
        for update to authenticated
        using (tenant_id = app.current_tenant_id() and app.can_manage_records())
        with check (tenant_id = app.current_tenant_id());
    $f$, t);
    execute format($f$
      create policy %1$s_delete on public.%1$s
        for delete to authenticated
        using (tenant_id = app.current_tenant_id() and app.can_manage_records());
    $f$, t);
    execute format('grant select, insert, update, delete on public.%s to authenticated', t);
  end loop;
end;
$$;

grant select on public.vw_bank_account_balances to authenticated;
