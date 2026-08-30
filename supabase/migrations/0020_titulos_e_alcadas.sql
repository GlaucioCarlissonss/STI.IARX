-- =============================================================================
-- 0020 — Títulos a pagar e a receber, com alçada CONFIGURÁVEL
-- =============================================================================
-- Fecha os módulos 5 e 6 de docs/07 e é onde "lançar uma despesa" passa a existir.
--
-- A NOTA MAIS IMPORTANTE DESTA MIGRAÇÃO
--
-- O módulo de Contas a Pagar foi pedido completo, com aprovação multinível. Mas a
-- regra de alçada — quem é N1, N2, N3 e por qual critério — nunca foi definida, e
-- o próprio escopo do projeto proíbe inventar regra de negócio.
--
-- A saída não é entregar meio módulo: é entregar o MECANISMO e deixar a REGRA
-- como dado. `approval_rules` nasce VAZIA. Cada linha dela diz "no nível N, para
-- valor entre X e Y, opcionalmente restrito a este centro de custo ou filial,
-- quem aprova precisa ter este perfil de acesso". Isso cobre os quatro critérios
-- que estavam em aberto (cargo, centro de custo, filial, faixa de valor pura) sem
-- que nenhum valor em reais seja escolhido por mim.
--
-- E como tabela vazia poderia significar duas coisas opostas — "não precisa
-- aprovar" ou "ninguém pode aprovar" —, quem decide é uma chave explícita no
-- tenant: `payable_approval_required`, que começa FALSE. Enquanto estiver false, o
-- título nasce aprovado e a operação pequena não é obrigada a um fluxo que não
-- pediu. Ligada sem nenhuma regra cadastrada, a função levanta erro dizendo o que
-- configurar — em vez de deixar todo título parado sem explicação.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- A chave que liga o fluxo de aprovação
-- -----------------------------------------------------------------------------
alter table public.tenants
  add column if not exists payable_approval_required boolean not null default false;

comment on column public.tenants.payable_approval_required is
  'Liga o fluxo de aprovação de títulos a pagar. FALSE = título nasce aprovado.';

-- -----------------------------------------------------------------------------
-- expense_categories — a dimensão "natureza do gasto"
-- -----------------------------------------------------------------------------
-- Separada de `cost_centers` porque respondem perguntas diferentes: o centro de
-- custo diz QUEM consome, a categoria diz O QUE foi consumido. Software comprado
-- para a filial de Manaus é categoria "Software" e centro "TI — Manaus"; misturar
-- as duas dimensões numa coluna impediria os dois relatórios.
create table public.expense_categories (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  code       text not null,
  name       text not null,
  -- Nulo = categoria de despesa geral. Preenchido = a categoria só se aplica a
  -- título ligado a fornecedor, o que evita classificar folha como compra.
  requires_supplier boolean not null default false,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_expense_categories_id_tenant unique (id, tenant_id)
);

create unique index uq_expense_categories_code
  on public.expense_categories (tenant_id, lower(code));
create index idx_expense_categories_tenant
  on public.expense_categories (tenant_id) where is_active;

comment on table public.expense_categories is
  'Natureza do gasto. Dimensão independente do centro de custo, que diz quem consome.';

-- -----------------------------------------------------------------------------
-- approval_rules — a alçada, como DADO
-- -----------------------------------------------------------------------------
create table public.approval_rules (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  -- 1, 2, 3… O nome do nível é do cliente: "N1", "Coordenação", "Diretoria".
  level      integer not null check (level between 1 and 9),
  level_name text not null,
  -- A faixa. `max_amount` nulo = sem teto, o topo da alçada.
  min_amount numeric(14,2) not null default 0 check (min_amount >= 0),
  max_amount numeric(14,2) check (max_amount is null or max_amount > min_amount),
  -- Escopos opcionais. Nulo = a regra vale para qualquer centro/filial.
  cost_center_id uuid,
  branch_id      uuid,
  -- Quem aprova: precisa ter ESTE perfil de acesso. É assim que "aprovação por
  -- cargo" se expressa sem uma tabela de cargos separada — o perfil já é o cargo
  -- funcional dentro do sistema.
  required_profile_id uuid,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_approval_rule_cost_center foreign key (cost_center_id, tenant_id)
    references public.cost_centers (id, tenant_id) on delete restrict,
  constraint fk_approval_rule_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete restrict,
  constraint fk_approval_rule_profile foreign key (required_profile_id, tenant_id)
    references public.access_profiles (id, tenant_id) on delete restrict
);

create index idx_approval_rules_tenant on public.approval_rules (tenant_id, level)
  where is_active;

comment on table public.approval_rules is
  'Alçada de aprovação por tenant. Nasce VAZIA de propósito: a regra é decisão do cliente, não do código.';

-- -----------------------------------------------------------------------------
-- payables — títulos a pagar (é aqui que "lançar despesa" vive)
-- -----------------------------------------------------------------------------
create table public.payables (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  description text not null,
  -- Número da NF, do boleto ou do documento. Sem FK: não existe módulo fiscal.
  document_ref text,

  supplier_id          uuid,
  supplier_contract_id uuid,
  expense_category_id  uuid,
  cost_center_id       uuid,
  branch_id            uuid,

  amount   numeric(14,2) not null check (amount > 0),
  issued_on date not null default current_date,
  due_on    date not null,

  /*
   * Parcelamento sem tabela extra: cada parcela É um título, apontando para o
   * primeiro. Assim cada parcela é aprovada, paga e cancelada por conta própria —
   * que é como acontece na prática, porque a segunda parcela pode vencer depois
   * de o fornecedor ser trocado.
   */
  parent_payable_id  uuid,
  installment_number integer not null default 1 check (installment_number >= 1),
  installment_total  integer not null default 1 check (installment_total >= 1),

  status text not null default 'draft' check (status in (
    'draft', 'pending_approval', 'approved', 'rejected', 'scheduled', 'paid', 'cancelled'
  )),

  approved_at      timestamptz,
  approved_by      uuid references public.profiles(id) on delete set null,
  rejection_reason text,

  paid_on         date,
  bank_account_id uuid,
  -- A movimentação gerada na baixa. Sem FK composta porque a movimentação pode
  -- ser apagada por estorno e o título tem de sobreviver ao estorno.
  bank_movement_id uuid,

  notes      text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint uq_payables_id_tenant unique (id, tenant_id),
  constraint fk_payable_supplier foreign key (supplier_id, tenant_id)
    references public.suppliers (id, tenant_id) on delete restrict,
  -- Só possível porque a 0018 acrescentou unique (id, tenant_id) em
  -- supplier_contracts. Sem aquela correção este vínculo era impossível no
  -- padrão do ADR-001.
  constraint fk_payable_contract foreign key (supplier_contract_id, tenant_id)
    references public.supplier_contracts (id, tenant_id) on delete restrict,
  constraint fk_payable_category foreign key (expense_category_id, tenant_id)
    references public.expense_categories (id, tenant_id) on delete restrict,
  constraint fk_payable_cost_center foreign key (cost_center_id, tenant_id)
    references public.cost_centers (id, tenant_id) on delete restrict,
  constraint fk_payable_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete restrict,
  constraint fk_payable_parent foreign key (parent_payable_id, tenant_id)
    references public.payables (id, tenant_id) on delete cascade,
  constraint fk_payable_bank_account foreign key (bank_account_id, tenant_id)
    references public.bank_accounts (id, tenant_id) on delete restrict,

  constraint payables_installment_coherent
    check (installment_number <= installment_total),
  -- Título pago tem de dizer quando e de qual conta. Sem isto existiria "pago"
  -- sem rastro de pagamento, que é o pior tipo de dado financeiro: parece
  -- resolvido e não prova nada.
  constraint payables_paid_has_evidence
    check (status <> 'paid' or (paid_on is not null and bank_account_id is not null)),
  constraint payables_rejected_has_reason
    check (status <> 'rejected' or rejection_reason is not null)
);

create index idx_payables_tenant_due on public.payables (tenant_id, due_on)
  where deleted_at is null;
create index idx_payables_status on public.payables (tenant_id, status)
  where deleted_at is null;
create index idx_payables_supplier on public.payables (supplier_id)
  where deleted_at is null;
create index idx_payables_parent on public.payables (parent_payable_id)
  where parent_payable_id is not null;

comment on table public.payables is
  'Títulos a pagar. Cada parcela é um título próprio, ligado ao primeiro por parent_payable_id.';

-- -----------------------------------------------------------------------------
-- payable_approvals — o rastro de cada nível
-- -----------------------------------------------------------------------------
-- Uma linha por decisão. Guardar só `approved_by` no título perderia o histórico
-- de um fluxo de três níveis, e perderia a rejeição que veio antes da aprovação.
create table public.payable_approvals (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  payable_id uuid not null,
  level      integer not null check (level between 1 and 9),
  decision   text not null check (decision in ('approved', 'rejected')),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz not null default now(),
  note       text,
  constraint fk_approval_payable foreign key (payable_id, tenant_id)
    references public.payables (id, tenant_id) on delete cascade,
  -- Um nível decide UMA vez por título. Duas decisões no mesmo nível deixariam
  -- ambíguo qual valeu.
  constraint uq_payable_approval_level unique (payable_id, level)
);

create index idx_payable_approvals_payable on public.payable_approvals (payable_id, level);

-- -----------------------------------------------------------------------------
-- payable_attachments — NF, boleto e comprovante
-- -----------------------------------------------------------------------------
-- Mesma forma das outras quatro tabelas de anexo: metadados aqui, binário no
-- bucket privado `anexos` da 0019.
create table public.payable_attachments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  payable_id   uuid not null,
  kind         text not null check (kind in (
                 'nfe', 'boleto', 'receipt', 'contract', 'other')),
  storage_path text not null unique,
  file_name    text not null,
  mime_type    text not null,
  size_bytes   bigint check (size_bytes > 0),
  uploaded_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint fk_payable_attach foreign key (payable_id, tenant_id)
    references public.payables (id, tenant_id) on delete cascade
);

create index idx_payable_attachments on public.payable_attachments (payable_id, kind);

-- -----------------------------------------------------------------------------
-- receivables — títulos a receber
-- -----------------------------------------------------------------------------
-- Sem fluxo de aprovação, e de propósito: aprovar o que se vai RECEBER não
-- protege ninguém. O controle aqui é a baixa — dizer que entrou o que entrou.
create table public.receivables (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  description text not null,
  document_ref text,

  client_id       uuid,
  sla_contract_id uuid,
  cost_center_id  uuid,
  branch_id       uuid,

  amount    numeric(14,2) not null check (amount > 0),
  issued_on date not null default current_date,
  due_on    date not null,

  parent_receivable_id uuid,
  installment_number   integer not null default 1 check (installment_number >= 1),
  installment_total    integer not null default 1 check (installment_total >= 1),

  status text not null default 'draft' check (status in (
    'draft', 'open', 'received', 'cancelled'
  )),

  received_on      date,
  received_amount  numeric(14,2) check (received_amount is null or received_amount > 0),
  bank_account_id  uuid,
  bank_movement_id uuid,

  notes      text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint uq_receivables_id_tenant unique (id, tenant_id),
  constraint fk_receivable_client foreign key (client_id, tenant_id)
    references public.clients (id, tenant_id) on delete restrict,
  constraint fk_receivable_sla_contract foreign key (sla_contract_id, tenant_id)
    references public.sla_contracts (id, tenant_id) on delete restrict,
  constraint fk_receivable_cost_center foreign key (cost_center_id, tenant_id)
    references public.cost_centers (id, tenant_id) on delete restrict,
  constraint fk_receivable_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete restrict,
  constraint fk_receivable_parent foreign key (parent_receivable_id, tenant_id)
    references public.receivables (id, tenant_id) on delete cascade,
  constraint fk_receivable_bank_account foreign key (bank_account_id, tenant_id)
    references public.bank_accounts (id, tenant_id) on delete restrict,
  constraint receivables_installment_coherent
    check (installment_number <= installment_total),
  -- `received_amount` separado de `amount` porque recebimento parcial e desconto
  -- acontecem, e sobrescrever o valor original apagaria a diferença.
  constraint receivables_received_has_evidence
    check (status <> 'received' or (received_on is not null and bank_account_id is not null))
);

create index idx_receivables_tenant_due on public.receivables (tenant_id, due_on)
  where deleted_at is null;
create index idx_receivables_status on public.receivables (tenant_id, status)
  where deleted_at is null;
create index idx_receivables_client on public.receivables (client_id)
  where deleted_at is null;

comment on table public.receivables is
  'Títulos a receber. Sem aprovação: o controle é a baixa, não a autorização.';

-- -----------------------------------------------------------------------------
-- A alçada, em função
-- -----------------------------------------------------------------------------
/**
 * Níveis de aprovação exigidos para um título.
 *
 * Devolve array vazio quando não há nada a aprovar — e é aí que o título nasce
 * aprovado. Regra de escopo: a linha mais específica ganha, então uma regra com
 * `cost_center_id` preenchido só se aplica àquele centro, e uma com nulo se
 * aplica a todos.
 *
 * Levanta exceção no único caso ambíguo: aprovação LIGADA e nenhuma regra que
 * cubra o valor. Deixar passar silenciosamente aprovaria sem alçada; deixar
 * parado sem erro esconderia a causa de o título nunca andar.
 */
create or replace function app.required_approval_levels(
  p_tenant_id      uuid,
  p_amount         numeric,
  p_cost_center_id uuid default null,
  p_branch_id      uuid default null
)
returns integer[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_required boolean;
  v_levels   integer[];
begin
  select payable_approval_required into v_required
  from public.tenants where id = p_tenant_id;

  if not coalesce(v_required, false) then
    return array[]::integer[];
  end if;

  select array_agg(distinct r.level order by r.level) into v_levels
  from public.approval_rules r
  where r.tenant_id = p_tenant_id
    and r.is_active
    and p_amount >= r.min_amount
    and (r.max_amount is null or p_amount <= r.max_amount)
    and (r.cost_center_id is null or r.cost_center_id = p_cost_center_id)
    and (r.branch_id is null or r.branch_id = p_branch_id);

  if v_levels is null or array_length(v_levels, 1) = 0 then
    raise exception
      'Aprovação de títulos está ligada, mas nenhuma faixa de alçada cobre % . Cadastre a alçada em approval_rules ou desligue tenants.payable_approval_required.',
      to_char(p_amount, 'FM999G999G990D00')
      using errcode = 'check_violation';
  end if;

  return v_levels;
end;
$$;

comment on function app.required_approval_levels(uuid, numeric, uuid, uuid) is
  'Níveis de alçada exigidos. Array vazio = não precisa aprovar. Exceção = ligado sem regra que cubra o valor.';

/**
 * Máquina de estados do título a pagar.
 *
 * Escrita como função, e não como tabela de transições no estilo de
 * `ticket_status_transitions` (0005), por um motivo: o fluxo do ticket é
 * personalizado por cliente, e por isso vive como dado. O do título é imposto por
 * contabilidade — não existe cliente que queira "pago" antes de "aprovado" — e
 * como dado só abriria porta para configurar um fluxo inválido.
 */
create or replace function app.payables_guard()
returns trigger
language plpgsql
as $$
declare
  v_permitido text[];
begin
  if tg_op = 'INSERT' then
    -- Título nasce em draft ou já aprovado (quando não há alçada). Nascer pago
    -- pularia o rastro de aprovação inteiro.
    if new.status not in ('draft', 'pending_approval', 'approved') then
      raise exception 'Título não pode ser criado com situação %', new.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if old.status = new.status then
    -- Edição de conteúdo. Título pago é imutável: alterar valor depois da baixa
    -- descolaria o título da movimentação bancária que o pagou.
    if old.status = 'paid' and (
      new.amount <> old.amount or new.due_on <> old.due_on
      or coalesce(new.supplier_id::text, '') <> coalesce(old.supplier_id::text, '')
    ) then
      raise exception 'Título pago não pode ter valor, vencimento ou fornecedor alterados'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  v_permitido := case old.status
    when 'draft'            then array['pending_approval', 'approved', 'cancelled']
    when 'pending_approval' then array['approved', 'rejected', 'cancelled']
    when 'approved'         then array['scheduled', 'paid', 'cancelled']
    when 'scheduled'        then array['paid', 'approved', 'cancelled']
    when 'rejected'         then array['draft', 'cancelled']
    -- Estorno existe: pagamento errado acontece e a contabilidade precisa
    -- desfazer. Volta para `approved`, não para `draft`, porque a aprovação que
    -- autorizou o pagamento continua válida.
    when 'paid'             then array['approved']
    when 'cancelled'        then array[]::text[]
    else array[]::text[]
  end;

  if not (new.status = any (v_permitido)) then
    raise exception 'Transição de título inválida: % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if new.status = 'approved' and old.status = 'pending_approval' then
    new.approved_at := coalesce(new.approved_at, now());
    new.approved_by := coalesce(new.approved_by, app.current_user_id());
  end if;

  -- Estorno limpa o rastro de pagamento: manter `paid_on` num título que voltou
  -- a "aprovado" faria o relatório contá-lo como pago.
  if old.status = 'paid' and new.status = 'approved' then
    new.paid_on := null;
    new.bank_movement_id := null;
  end if;

  return new;
end;
$$;

create trigger trg_payables_guard
  before insert or update on public.payables
  for each row execute function app.payables_guard();

create or replace function app.receivables_guard()
returns trigger
language plpgsql
as $$
declare
  v_permitido text[];
begin
  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'open') then
      raise exception 'Título a receber não pode ser criado com situação %', new.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if old.status = new.status then
    return new;
  end if;

  v_permitido := case old.status
    when 'draft'     then array['open', 'cancelled']
    when 'open'      then array['received', 'cancelled']
    when 'received'  then array['open']   -- estorno de baixa
    when 'cancelled' then array[]::text[]
    else array[]::text[]
  end;

  if not (new.status = any (v_permitido)) then
    raise exception 'Transição de título a receber inválida: % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if old.status = 'received' and new.status = 'open' then
    new.received_on := null;
    new.received_amount := null;
    new.bank_movement_id := null;
  end if;

  return new;
end;
$$;

create trigger trg_receivables_guard
  before insert or update on public.receivables
  for each row execute function app.receivables_guard();

-- -----------------------------------------------------------------------------
-- Anexo de título entra no mapa do bucket
-- -----------------------------------------------------------------------------
-- Substitui a função da 0019 acrescentando a entidade `titulos`. O `else null`
-- continua sendo a decisão de segurança: entidade fora do mapa não tem chave, e
-- sem chave `app.can_touch_attachment()` nega.
create or replace function app.storage_permission_key(p_entity text, p_verb text)
returns text
language sql
immutable
as $$
  select case p_entity
    when 'tickets' then case p_verb
      when 'ver'     then 'helpdesk.tickets.ver'
      when 'anexar'  then 'helpdesk.tickets.anexar'
      when 'remover' then 'helpdesk.tickets.remover_anexo'
      else null end
    when 'ativos' then case p_verb
      when 'ver'     then 'inventario.ativos.ver'
      when 'anexar'  then 'inventario.ativos.anexar'
      when 'remover' then 'inventario.ativos.remover_anexo'
      else null end
    when 'linhas' then case p_verb
      when 'ver'     then 'telefonia.linhas.ver'
      when 'anexar'  then 'telefonia.linhas.anexar'
      when 'remover' then 'telefonia.linhas.remover_anexo'
      else null end
    when 'titulos' then case p_verb
      when 'ver'     then 'financeiro.titulos_pagar.ver'
      when 'anexar'  then 'financeiro.titulos_pagar.anexar'
      when 'remover' then 'financeiro.titulos_pagar.remover_anexo'
      else null end
    else null
  end;
$$;

/**
 * Fachada em `public` para a aplicação chamar por RPC.
 *
 * O tenant NÃO é parâmetro: vem de `app.current_tenant_id()`, ou seja, do JWT.
 * Aceitar o tenant como argumento deixaria a aplicação escolher de qual tenant
 * ler a alçada — exatamente o furo que o ADR-002 fecha ao manter o claim fora do
 * alcance do cliente.
 */
create or replace function public.required_approval_levels_for(
  p_amount         numeric,
  p_cost_center_id uuid default null,
  p_branch_id      uuid default null
)
returns integer[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.required_approval_levels(
    app.current_tenant_id(), p_amount, p_cost_center_id, p_branch_id);
$$;

revoke all on function public.required_approval_levels_for(numeric, uuid, uuid) from public;
grant execute on function public.required_approval_levels_for(numeric, uuid, uuid) to authenticated;

comment on function public.required_approval_levels_for(numeric, uuid, uuid) is
  'Fachada RPC da alçada. O tenant vem do JWT, nunca do cliente.';

-- -----------------------------------------------------------------------------
-- RLS e auditoria
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'expense_categories', 'approval_rules', 'payables',
    'payable_approvals', 'payable_attachments', 'receivables'
  ]
  loop
    perform app.harden_table(format('public.%s', t)::regclass);
    perform app.attach_audit(format('public.%s', t)::regclass);

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

-- -----------------------------------------------------------------------------
-- Visão consolidada dos títulos
-- -----------------------------------------------------------------------------
-- `security_invoker` obrigatório: sem ele a view rodaria com privilégio do dono e
-- ignoraria o RLS das tabelas base, virando vazamento entre tenants.
create view public.vw_payables_summary
  with (security_invoker = true) as
select
  p.tenant_id,
  p.status,
  count(*)                                              as titulos,
  sum(p.amount)                                         as total,
  count(*) filter (where p.due_on < current_date
                     and p.status not in ('paid', 'cancelled')) as vencidos,
  sum(p.amount) filter (where p.due_on < current_date
                     and p.status not in ('paid', 'cancelled')) as total_vencido,
  count(*) filter (where p.due_on between current_date and current_date + 7
                     and p.status not in ('paid', 'cancelled')) as vence_em_7_dias
from public.payables p
where p.deleted_at is null
group by p.tenant_id, p.status;

comment on view public.vw_payables_summary is
  'Títulos a pagar agregados por situação, com vencidos e a vencer em 7 dias.';

-- -----------------------------------------------------------------------------
-- Chaves novas no catálogo
-- -----------------------------------------------------------------------------
-- Em sincronia com PERMISSION_CATALOG em src/lib/permissions.ts.
--
-- `configurar` cobre alçada E categorias de despesa numa chave só, porque as duas
-- são "configurar o módulo de títulos" e nenhuma tem tela própria — chave para
-- tela que não existe é configuração morta.
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('financeiro.titulos_pagar', 'financeiro', 'titulos_pagar', null,
   'Títulos a pagar', 'gestor', 600),
  ('financeiro.titulos_pagar.ver', 'financeiro', 'titulos_pagar', 'ver',
   'Consultar títulos a pagar', 'gestor', 601),
  ('financeiro.titulos_pagar.criar', 'financeiro', 'titulos_pagar', 'criar',
   'Lançar despesa', 'gestor', 602),
  ('financeiro.titulos_pagar.editar', 'financeiro', 'titulos_pagar', 'editar',
   'Editar título', 'gestor', 603),
  ('financeiro.titulos_pagar.aprovar', 'financeiro', 'titulos_pagar', 'aprovar',
   'Aprovar ou reprovar', 'gestor', 604),
  ('financeiro.titulos_pagar.pagar', 'financeiro', 'titulos_pagar', 'pagar',
   'Dar baixa no pagamento', 'gestor', 605),
  ('financeiro.titulos_pagar.cancelar', 'financeiro', 'titulos_pagar', 'cancelar',
   'Cancelar título', 'gestor', 606),
  ('financeiro.titulos_pagar.configurar', 'financeiro', 'titulos_pagar', 'configurar',
   'Configurar alçada e categorias', 'admin', 607),
  ('financeiro.titulos_pagar.anexar', 'financeiro', 'titulos_pagar', 'anexar',
   'Anexar NF, boleto ou comprovante', 'gestor', 608),
  ('financeiro.titulos_pagar.remover_anexo', 'financeiro', 'titulos_pagar', 'remover_anexo',
   'Remover anexo do título', 'gestor', 609),

  ('financeiro.titulos_receber', 'financeiro', 'titulos_receber', null,
   'Títulos a receber', 'gestor', 620),
  ('financeiro.titulos_receber.ver', 'financeiro', 'titulos_receber', 'ver',
   'Consultar títulos a receber', 'gestor', 621),
  ('financeiro.titulos_receber.criar', 'financeiro', 'titulos_receber', 'criar',
   'Lançar título a receber', 'gestor', 622),
  ('financeiro.titulos_receber.editar', 'financeiro', 'titulos_receber', 'editar',
   'Editar título a receber', 'gestor', 623),
  ('financeiro.titulos_receber.baixar', 'financeiro', 'titulos_receber', 'baixar',
   'Dar baixa no recebimento', 'gestor', 624),
  ('financeiro.titulos_receber.cancelar', 'financeiro', 'titulos_receber', 'cancelar',
   'Cancelar título a receber', 'gestor', 625)
on conflict (key) do update
  set label = excluded.label, min_base_role = excluded.min_base_role,
      sort_order = excluded.sort_order;

-- -----------------------------------------------------------------------------
-- Os perfis financeiros passam a alcançar as telas novas
-- -----------------------------------------------------------------------------
-- Substitui a função da 0017. As mudanças são cirúrgicas, e não por nome de ação:
-- dar `criar` a todo o módulo faria o Operador Financeiro cadastrar CONTA
-- BANCÁRIA, que é exatamente o que o perfil dele não deve poder.
create or replace function app.seed_system_access_profiles(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile record;
begin
  insert into public.access_profiles (tenant_id, name, description, base_role, is_system, system_key)
  values
    (p_tenant_id, 'Admin do Cliente',
     'Acesso total ao ambiente do cliente.', 'admin', true, 'admin_cliente'),
    (p_tenant_id, 'Diretoria',
     'Leitura de tudo que o papel gestor alcança, sem escrita.', 'gestor', true, 'diretoria'),
    (p_tenant_id, 'Gestor de TI',
     'Operação de TI completa: helpdesk, inventário, telefonia, mapas, SLA e cadastros.',
     'gestor', true, 'gestor_ti'),
    (p_tenant_id, 'Operador de TI',
     'Atende ticket e consulta inventário e telefonia; não cadastra.', 'atendente', true, 'operador_ti'),
    (p_tenant_id, 'Gestor Financeiro',
     'Financeiro completo, mais fornecedores e leitura de clientes.', 'gestor', true, 'gestor_financeiro'),
    (p_tenant_id, 'Operador Financeiro',
     'Lança despesa e movimentação; não cadastra conta, não transfere e não aprova.',
     'gestor', true, 'operador_financeiro'),
    (p_tenant_id, 'Aprovador Financeiro',
     'Consulta o financeiro e aprova o que a alçada permitir.', 'gestor', true, 'aprovador_financeiro'),
    (p_tenant_id, 'Visualizador',
     'Somente leitura do que o papel visualizador alcança.', 'visualizador', true, 'visualizador'),
    (p_tenant_id, 'Solicitante',
     'Abre e acompanha os próprios tickets; consulta o que o papel alcança.',
     'solicitante', true, 'solicitante')
  on conflict do nothing;

  for v_profile in
    select id, base_role, system_key from public.access_profiles
    where tenant_id = p_tenant_id and is_system
  loop
    insert into public.permission_grants (tenant_id, profile_id, permission_key)
    select p_tenant_id, v_profile.id, c.key
    from public.permission_catalog c
    where app.role_rank(c.min_base_role) <= app.role_rank(v_profile.base_role)
      and case v_profile.system_key
        when 'admin_cliente' then true

        when 'diretoria'    then c.action is null or c.action = 'ver'
        when 'visualizador' then c.action is null or c.action = 'ver'

        when 'gestor_ti' then c.module in
          ('helpdesk','inventario','telefonia','mapas','sla','clientes','fornecedores','tv')

        when 'operador_ti' then
          c.module = 'helpdesk'
          or (c.module in ('inventario','telefonia','mapas') and (c.action is null or c.action = 'ver'))

        when 'gestor_financeiro' then
          c.module in ('financeiro','fornecedores')
          or (c.module = 'clientes' and (c.action is null or c.action = 'ver'))
          or c.key in ('sla','sla.compliance','sla.compliance.ver')

        -- Lançar despesa e anexar comprovante É o trabalho do operador. Aprovar,
        -- pagar e configurar alçada não são — e continuam de fora.
        when 'operador_financeiro' then
          c.module = 'financeiro'
          and (c.action is null
               or c.action in ('ver','movimentar')
               or (c.screen in ('titulos_pagar','titulos_receber')
                   and c.action in ('criar','editar','anexar','remover_anexo')))

        -- Agora o Aprovador tem de fato o que aprovar.
        when 'aprovador_financeiro' then
          c.module = 'financeiro'
          and (c.action is null
               or c.action = 'ver'
               or (c.screen = 'titulos_pagar' and c.action = 'aprovar'))

        when 'solicitante' then true

        else false
      end
    on conflict do nothing;
  end loop;
end;
$$;

comment on function app.seed_system_access_profiles(uuid) is
  'Cria (idempotente) os perfis de sistema e suas concessões para um tenant.';

-- Redistribui as chaves novas pelos perfis dos tenants que já existem. Sem isto,
-- um Gestor Financeiro provisionado antes desta migração não veria as telas
-- novas, e ninguém saberia que faltava marcar algo à mão.
do $$
declare
  v_tenant uuid;
begin
  for v_tenant in select id from public.tenants loop
    perform app.seed_system_access_profiles(v_tenant);
  end loop;
end;
$$;

commit;
