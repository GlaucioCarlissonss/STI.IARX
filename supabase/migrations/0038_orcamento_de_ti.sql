-- =============================================================================
-- 0038 — Orçamento de TI: quanto custa, e quanto vai custar
-- =============================================================================
-- Segundo módulo trazido do GSTI.IARX. O primeiro (projetos, 0037) veio inteiro
-- porque esta base não tinha nada. Este vem diferente, e a diferença é o ponto.
--
-- DUAS PERGUNTAS SOBRE O MESMO DINHEIRO
-- -------------------------------------
-- `payables` responde **quando eu pago**: vencimento, fornecedor, aprovação,
-- conta bancária, baixa. É contas a pagar, e funciona.
--
-- O financeiro do GSTI responde outra coisa: **quanto a TI deste cliente custa
-- por mês, por filial e por categoria — e quanto vai custar**. Competência (o mês
-- a que a despesa pertence, não o mês em que ela é paga), natureza (fixa,
-- pontual, parcelada), classificação (despesa ou investimento), cenários de
-- projeção, fechamento mensal.
--
-- Trazer o módulo inteiro criaria uma segunda verdade sobre o mesmo dinheiro: o
-- mesmo contrato de licença viraria um título a pagar e um lançamento, e os dois
-- somariam. Então o que entra aqui é a CAMADA DE PLANEJAMENTO, e ela lê o que já
-- existe:
--
--   `origem = 'titulo_a_pagar'` + `payable_id` com índice único.
--
-- Um título vira lançamento uma vez só, e a tela mostra de onde cada número veio.
-- O campo `origem` do GSTI já antecipava exatamente isto — ele distingue
-- planilha, manual e projeção, e "título a pagar" é a quarta origem natural.
--
-- O QUE SE REUSA EM VEZ DE RECRIAR
-- --------------------------------
--   `tipos_despesa`  → `expense_categories`, que existe desde a 0018
--   `empresas`       → `clients`
--   `filiais`        → `branches`
--   `fornecedor`     → `suppliers` (lá é texto livre; aqui é entidade)
--   `origem_custo`   → `cost_centers`
--
-- O QUE FICA DE FORA, E POR QUÊ
-- -----------------------------
--   `reconhecedores_origem` e o fluxo de "reconhecido" — ele existe para a carga
--     do ERP de um cliente específico, lendo a coluna `CREATIONUSER`. Sem essa
--     importação, não tem entrada.
--   `planos_reducao` — plano de redução de custo. É um segundo artefato de
--     planejamento ao lado das metas, e o teto por competência já responde
--     "quanto podemos gastar". Entra quando houver quem o use.
--   `planejamento` (JSON com proj_diarias, proj_pacientes) — é da operação de
--     saúde daquele cliente, não de gestão de TI.
--
-- DINHEIRO: `numeric(14,2)`, E NÃO CENTAVOS INTEIROS
-- --------------------------------------------------
-- O GSTI guarda centavos inteiros, e o motivo está escrito lá: "elimina erro de
-- ponto flutuante em somatórios". O motivo é do SQLite, que não tem decimal
-- exato — `REAL` é ponto flutuante.
--
-- O PostgreSQL tem: `numeric` é decimal exato, e é o que `payables.amount` já
-- usa. Manter o mesmo tipo é o que permite somar um lançamento contra um título
-- sem conversão — e conversão de unidade entre duas tabelas da mesma base é
-- exatamente onde um centavo se perde.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Cenários de projeção
-- -----------------------------------------------------------------------------
/*
 * Além do cenário `oficial`, que alimenta os indicadores por padrão, um cliente
 * pode manter projeções alternativas — "e se o contrato sair com o desconto
 * condicionado?". Os cenários convivem sem contaminar os totais oficiais.
 */
create table public.it_budget_scenarios (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  client_id     uuid not null,

  key           text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name          text not null check (length(trim(name)) between 2 and 80),
  description   text,

  created_at    timestamptz not null default now(),

  constraint uq_scenario_id_tenant unique (id, tenant_id),
  constraint uq_scenario_key unique (client_id, key),
  constraint fk_scenario_client foreign key (client_id, tenant_id)
    references public.clients (id, tenant_id) on delete cascade
);

comment on table public.it_budget_scenarios is
  'Cenários de projeção. O `oficial` alimenta os indicadores; os outros convivem sem contaminar os totais.';

-- -----------------------------------------------------------------------------
-- 2. Fechamento mensal
-- -----------------------------------------------------------------------------
/*
 * Uma competência fechada recusa QUALQUER escrita — inclusive por importação,
 * inclusive com justificativa. Reabrir é um ato, com autor e motivo.
 *
 * É a regra que dá sentido a um número divulgado: se o mês de março pode mudar
 * depois de o relatório de março ter saído, o relatório não vale nada.
 */
create table public.it_budget_closings (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  client_id     uuid not null,

  competence    date not null check (app.eh_competencia(competence)),

  closed_at     timestamptz not null default now(),
  closed_by     uuid,
  note          text,

  /* Reabertura: a linha NÃO é apagada. Apagar faria o fechamento sumir do
     histórico, e a pergunta "este mês já esteve fechado?" perderia resposta. */
  reopened_at   timestamptz,
  reopened_by   uuid,
  reopen_reason text,

  constraint uq_closing unique (client_id, competence),
  constraint fk_closing_client foreign key (client_id, tenant_id)
    references public.clients (id, tenant_id) on delete cascade,
  constraint fk_closing_author foreign key (closed_by, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,
  constraint fk_closing_reopener foreign key (reopened_by, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,

  /* Reabrir exige motivo. Sem ele, "fechei e reabri" é um evento sem causa — e
     a causa é a única coisa que alguém vai querer saber depois. */
  constraint closing_reabrir_tem_motivo
    check (reopened_at is null or (reopened_by is not null and reopen_reason is not null))
);

comment on table public.it_budget_closings is
  'Competências fechadas. A linha não some ao reabrir: "este mês já esteve fechado?" precisa ter resposta.';

create or replace function app.competencia_fechada(p_client_id uuid, p_competence date)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.it_budget_closings
     where client_id = p_client_id
       and competence = p_competence
       and reopened_at is null
  );
$$;

comment on function app.competencia_fechada(uuid, date) is
  'Verdadeiro quando a competência daquele cliente está fechada e não foi reaberta.';

-- -----------------------------------------------------------------------------
-- 3. Os lançamentos
-- -----------------------------------------------------------------------------
create table public.it_cost_entries (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  client_id     uuid not null,
  branch_id     uuid,

  /* `expense_categories`, que já existe desde a 0018. Criar `tipos_despesa` ao
     lado seria manter duas listas de categoria de despesa na mesma base. */
  expense_category_id uuid not null,
  cost_center_id      uuid,
  supplier_id         uuid,

  /*
   * A COMPETÊNCIA é o mês a que a despesa pertence — não o mês em que ela é
   * paga. É a diferença inteira entre este módulo e contas a pagar: a licença
   * anual paga em janeiro pertence aos doze meses, e quem olha "quanto a TI
   * custou em agosto" quer o duodécimo, não zero.
   */
  competence    date not null check (app.eh_competencia(competence)),

  amount        numeric(14,2) not null check (amount >= 0),
  description   text,
  notes         text,

  natureza      text not null
                  check (natureza in ('fixa', 'pontual_unica', 'pontual_parcelada')),
  classificacao text not null check (classificacao in ('despesa', 'investimento')),

  /* Parcelamento. A parcela 1 é o lançamento de origem; as demais apontam para
     ela, o que preserva a série — e permite responder "quanto falta deste
     contrato". */
  installment_number integer check (installment_number is null or installment_number >= 1),
  installment_total  integer check (installment_total is null or installment_total >= 1),
  parent_entry_id    uuid,

  /* Até quando a recorrência vale. NULO = em aberto, e projeta indefinidamente.
     Encerrar um contrato é cadastrar a vigência dele; supor uma data que
     ninguém informou inventaria o fim de contratos em vigor. */
  recurrence_until date check (recurrence_until is null or app.eh_competencia(recurrence_until)),

  /*
   * Quem CONSOME o que esta filial PAGA.
   *
   * Sem este campo, a matriz que centraliza as licenças de seis filiais aparece
   * como a unidade cara e as filiais que consomem aparecem baratas — o número
   * está certo e a leitura, errada. É a melhor ideia do financeiro do GSTI, e a
   * que esta base não tinha de forma nenhuma.
   */
  consumo       text not null default 'integral'
                  check (consumo in ('integral', 'compartilhado')),

  scenario_id   uuid not null,

  /*
   * A PROCEDÊNCIA DO DADO — de onde o registro entrou, não de onde o dinheiro
   * saiu. O total que o sistema mostra não é o total do que alguém digitou, e
   * isso precisa ser verificável em vez de explicado.
   */
  origem        text not null default 'manual'
                  check (origem in ('manual', 'planilha', 'projecao', 'titulo_a_pagar')),
  /* O título que originou este lançamento, quando houve um. É o que impede a
     dupla contagem: um título vira lançamento uma vez só. */
  payable_id    uuid,

  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  constraint uq_entry_id_tenant unique (id, tenant_id),
  constraint fk_entry_client foreign key (client_id, tenant_id)
    references public.clients (id, tenant_id) on delete cascade,
  constraint fk_entry_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete set null,
  constraint fk_entry_category foreign key (expense_category_id, tenant_id)
    references public.expense_categories (id, tenant_id) on delete restrict,
  constraint fk_entry_cost_center foreign key (cost_center_id, tenant_id)
    references public.cost_centers (id, tenant_id) on delete set null,
  constraint fk_entry_supplier foreign key (supplier_id, tenant_id)
    references public.suppliers (id, tenant_id) on delete set null,
  constraint fk_entry_scenario foreign key (scenario_id, tenant_id)
    references public.it_budget_scenarios (id, tenant_id) on delete cascade,
  constraint fk_entry_parent foreign key (parent_entry_id, tenant_id)
    references public.it_cost_entries (id, tenant_id) on delete cascade,
  constraint fk_entry_payable foreign key (payable_id, tenant_id)
    references public.payables (id, tenant_id) on delete set null,
  constraint fk_entry_creator foreign key (created_by, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,

  /* Parcelada exige o total de parcelas: sem ele, "parcelada" é um rótulo e a
     série não existe. */
  constraint entry_parcelada_tem_total
    check (natureza <> 'pontual_parcelada' or installment_total is not null),
  /* E o número da parcela não passa do total. */
  constraint entry_parcela_cabe_no_total
    check (installment_number is null or installment_total is null
           or installment_number <= installment_total),
  /* Origem `titulo_a_pagar` exige o título. Sem ele a procedência seria uma
     afirmação sem como conferir — e justamente a que impede a dupla contagem. */
  constraint entry_titulo_tem_referencia
    check (origem <> 'titulo_a_pagar' or payable_id is not null)
);

/*
 * Um título vira UM lançamento. O índice é o que impede a dupla contagem quando
 * a importação roda duas vezes — e ela vai rodar duas vezes, porque quem importa
 * não tem como saber se já importou.
 */
create unique index uq_entry_por_titulo
  on public.it_cost_entries (payable_id)
  where payable_id is not null and deleted_at is null;

create index idx_entries_competencia
  on public.it_cost_entries (tenant_id, client_id, competence) where deleted_at is null;
create index idx_entries_cenario
  on public.it_cost_entries (scenario_id, competence) where deleted_at is null;
create index idx_entries_serie
  on public.it_cost_entries (parent_entry_id) where parent_entry_id is not null;

comment on table public.it_cost_entries is
  'Custo de TI por competência. Complementa `payables` (quando eu pago) com a pergunta do gestor: quanto custa e quanto vai custar.';

-- -----------------------------------------------------------------------------
-- 4. Quem consome o que a outra filial paga
-- -----------------------------------------------------------------------------
/*
 * Tabela e não lista em JSON porque a pergunta do indicador — "o que desta
 * filial é pago por outra?" — se responde filtrando por filial, e filtro em JSON
 * não usa índice.
 *
 * A lista é CONGELADA na gravação. Escolher "todas as filiais" grava as que
 * existiam naquele momento: uma filial cadastrada em março não passa a se
 * beneficiar de um lançamento de janeiro, e o mês fechado não muda de número
 * sozinho.
 */
create table public.it_cost_beneficiaries (
  entry_id      uuid not null,
  branch_id     uuid not null,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  primary key (entry_id, branch_id),
  constraint fk_benef_entry foreign key (entry_id, tenant_id)
    references public.it_cost_entries (id, tenant_id) on delete cascade,
  constraint fk_benef_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete cascade
);

create index idx_benef_filial on public.it_cost_beneficiaries (branch_id);

comment on table public.it_cost_beneficiaries is
  'As filiais que CONSOMEM um custo pago por outra. A lista é congelada na gravação — mês fechado não muda de número sozinho.';

-- -----------------------------------------------------------------------------
-- 5. Metas: o teto de gasto
-- -----------------------------------------------------------------------------
create table public.it_budget_targets (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  client_id     uuid not null,

  name          text not null check (length(trim(name)) between 2 and 120),
  /* Categoria nula = o teto é do cliente inteiro. Filial nula = idem. É o que
     permite "a TI toda não passa de X" e "licenças não passam de Y" na mesma
     tabela. */
  expense_category_id uuid,
  branch_id     uuid,

  monthly_cap   numeric(14,2) not null check (monthly_cap >= 0),
  valid_from    date check (valid_from is null or app.eh_competencia(valid_from)),
  valid_until   date check (valid_until is null or app.eh_competencia(valid_until)),
  is_active     boolean not null default true,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint uq_target_nome unique (client_id, name),
  constraint fk_target_client foreign key (client_id, tenant_id)
    references public.clients (id, tenant_id) on delete cascade,
  constraint fk_target_category foreign key (expense_category_id, tenant_id)
    references public.expense_categories (id, tenant_id) on delete cascade,
  constraint fk_target_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete cascade,
  constraint target_vigencia_coerente
    check (valid_until is null or valid_from is null or valid_until >= valid_from)
);

comment on table public.it_budget_targets is
  'Teto de gasto mensal, por cliente, categoria ou filial. Categoria e filial nulas = o teto é do cliente inteiro.';

-- -----------------------------------------------------------------------------
-- 6. A trava do fechamento
-- -----------------------------------------------------------------------------
/*
 * Competência fechada recusa escrita — e recusa com exceção, não com silêncio.
 *
 * A diferença importa: todo o resto desta base trata negação de RLS como zero
 * linhas, e aqui zero linhas seria lido como "não encontrei a linha". O
 * fechamento não é uma questão de permissão, é uma afirmação sobre o mês: a
 * escrita está proibida para todo mundo, e quem tentar precisa saber disso.
 */
create or replace function app.orcamento_respeita_fechamento()
returns trigger
language plpgsql
as $$
declare
  v_client uuid;
  v_comp   date;
begin
  if tg_op = 'DELETE' then
    v_client := old.client_id;
    v_comp := old.competence;
  else
    v_client := new.client_id;
    v_comp := new.competence;
  end if;

  if app.competencia_fechada(v_client, v_comp) then
    raise exception
      'A competência % está fechada e não aceita alteração. Reabra-a, com motivo, antes de lançar.',
      to_char(v_comp, 'MM/YYYY')
      using errcode = 'check_violation';
  end if;

  /* Mover um lançamento PARA dentro de um mês fechado é a mesma coisa que
     escrever nele — e seria o jeito óbvio de contornar a trava. */
  if tg_op = 'UPDATE' and old.competence is distinct from new.competence
     and app.competencia_fechada(new.client_id, new.competence) then
    raise exception
      'A competência de destino % está fechada.', to_char(new.competence, 'MM/YYYY')
      using errcode = 'check_violation';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger trg_entry_fechamento
  before insert or update or delete on public.it_cost_entries
  for each row execute function app.orcamento_respeita_fechamento();

-- -----------------------------------------------------------------------------
-- 7. Parcelamento que fecha na conta
-- -----------------------------------------------------------------------------
/*
 * Divide um total em N parcelas de modo que a SOMA FECHE EXATAMENTE no total.
 *
 * 100,00 em 3 não é 33,33 três vezes: é 33,34 + 33,33 + 33,33. O resto vai nas
 * primeiras parcelas, que é a convenção comercial brasileira — e, mais
 * importante, é o que faz a soma do parcelamento bater com o valor do contrato.
 * Um centavo de diferença por contrato, em cem contratos, é o tipo de erro que
 * ninguém encontra depois.
 */
create or replace function app.ratear_valor(p_total numeric, p_parcelas integer)
returns numeric[]
language plpgsql
immutable
as $$
declare
  v_base  numeric(14,2);
  v_resto numeric(14,2);
  v_centavos integer;
  v_saida numeric[] := array[]::numeric[];
  i integer;
begin
  if p_parcelas < 1 then
    raise exception 'O número de parcelas precisa ser pelo menos 1.';
  end if;

  v_base := trunc(p_total / p_parcelas, 2);
  v_resto := p_total - (v_base * p_parcelas);
  /* Quantas parcelas levam um centavo a mais. `round` porque `v_resto` é
     múltiplo exato de 0,01 e a divisão por 0,01 pode cair em 1,9999…
     dependendo da escala. */
  v_centavos := round(v_resto / 0.01)::integer;

  for i in 1..p_parcelas loop
    v_saida := v_saida || (v_base + case when i <= v_centavos then 0.01 else 0 end);
  end loop;

  return v_saida;
end;
$$;

comment on function app.ratear_valor(numeric, integer) is
  'Divide um total em parcelas cuja soma fecha exatamente no total. O resto vai nas primeiras.';

-- -----------------------------------------------------------------------------
-- 8. Importar títulos a pagar como lançamentos
-- -----------------------------------------------------------------------------
/*
 * A ponte que impede a segunda verdade.
 *
 * Em vez de redigitar o que já está em `payables`, o orçamento IMPORTA: cada
 * título vira um lançamento com `origem = 'titulo_a_pagar'` e o `payable_id`
 * gravado. O índice único por título faz a segunda execução não duplicar nada —
 * e ela vai acontecer, porque quem importa não tem como saber se já importou.
 *
 * A competência é derivada de `due_on`: é a melhor aproximação disponível sem
 * pedir à pessoa que classifique título por título. Quem quiser outra
 * competência edita o lançamento — e a edição não muda a origem, porque um
 * título corrigido continua vindo de um título.
 *
 * `security definer` para poder ler `payables` e escrever `it_cost_entries` numa
 * transação só, mas o isolamento é explícito: o `where` filtra pelo tenant da
 * sessão, e a função é concedida a `authenticated` — não é um quarto uso de
 * `service_role` (ADR-011).
 */
create or replace function public.orcamento_importar_titulos(
  p_client_id uuid,
  p_competence date,
  p_scenario_id uuid
)
returns table (importados integer, ja_existiam integer, valor_total numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_import integer := 0;
  v_total  numeric(14,2) := 0;
  v_todos  integer := 0;
begin
  if not app.has_permission('financeiro.orcamento.lancar') then
    raise exception 'Sem permissão para lançar no orçamento.'
      using errcode = 'insufficient_privilege';
  end if;

  if app.competencia_fechada(p_client_id, p_competence) then
    raise exception 'A competência % está fechada.', to_char(p_competence, 'MM/YYYY')
      using errcode = 'check_violation';
  end if;

  /* Quantos títulos existem na janela — para a tela dizer "12 títulos, 5 já
     estavam lançados" em vez de só "importei 7". */
  select count(*) into v_todos
    from public.payables p
   where p.tenant_id = v_tenant
     and p.deleted_at is null
     and p.status <> 'rejected'
     and date_trunc('month', p.due_on)::date = p_competence
     and exists (
       select 1 from public.branches b
        where b.id = p.branch_id and b.client_id = p_client_id
     );

  with novos as (
    insert into public.it_cost_entries (
      tenant_id, client_id, branch_id, expense_category_id, cost_center_id,
      supplier_id, competence, amount, description, natureza, classificacao,
      installment_number, installment_total, scenario_id, origem, payable_id
    )
    select
      p.tenant_id,
      p_client_id,
      p.branch_id,
      p.expense_category_id,
      p.cost_center_id,
      p.supplier_id,
      date_trunc('month', p.due_on)::date,
      p.amount,
      p.description,
      /* Título com parcelamento vira lançamento parcelado; os demais, pontual
         única. "Fixa" é decisão de quem planeja, e o título não tem como dizer. */
      case when p.installment_total is not null and p.installment_total > 1
           then 'pontual_parcelada' else 'pontual_unica' end,
      /* Despesa por padrão: classificar como investimento é decisão contábil, e
         supô-la a partir do título erraria em favor do número mais vistoso. */
      'despesa',
      p.installment_number,
      p.installment_total,
      p_scenario_id,
      'titulo_a_pagar',
      p.id
    from public.payables p
    where p.tenant_id = v_tenant
      and p.deleted_at is null
      and p.status <> 'rejected'
      and p.expense_category_id is not null
      and date_trunc('month', p.due_on)::date = p_competence
      and exists (
        select 1 from public.branches b
         where b.id = p.branch_id and b.client_id = p_client_id
      )
      and not exists (
        select 1 from public.it_cost_entries e
         where e.payable_id = p.id and e.deleted_at is null
      )
    returning amount
  )
  select count(*), coalesce(sum(amount), 0) into v_import, v_total from novos;

  return query select v_import, greatest(v_todos - v_import, 0), v_total;
end;
$$;

revoke all on function public.orcamento_importar_titulos(uuid, date, uuid) from public;
grant execute on function public.orcamento_importar_titulos(uuid, date, uuid) to authenticated;

comment on function public.orcamento_importar_titulos(uuid, date, uuid) is
  'Traz os títulos a pagar de uma competência para o orçamento. Idempotente pelo índice único por título — rodar duas vezes não duplica.';

-- -----------------------------------------------------------------------------
-- 9. As views do painel
-- -----------------------------------------------------------------------------
create or replace view public.vw_it_cost_entries
with (security_invoker = true) as
select
  e.id,
  e.tenant_id,
  e.client_id,
  e.branch_id,
  e.competence,
  e.amount,
  e.description,
  e.natureza,
  e.classificacao,
  e.consumo,
  e.origem,
  e.payable_id,
  e.installment_number,
  e.installment_total,
  e.recurrence_until,
  e.scenario_id,
  e.created_at,
  c.trade_name  as client_name,
  b.name        as branch_name,
  cat.name      as category_name,
  cc.name       as cost_center_name,
  s.name        as supplier_name,
  sc.key        as scenario_key,
  sc.name       as scenario_name,
  app.competencia_fechada(e.client_id, e.competence) as competencia_fechada,
  (select count(*) from public.it_cost_beneficiaries bn where bn.entry_id = e.id) as beneficiadas
from public.it_cost_entries e
join public.clients c on c.id = e.client_id
join public.expense_categories cat on cat.id = e.expense_category_id
join public.it_budget_scenarios sc on sc.id = e.scenario_id
left join public.branches b on b.id = e.branch_id
left join public.cost_centers cc on cc.id = e.cost_center_id
left join public.suppliers s on s.id = e.supplier_id
where e.deleted_at is null;

grant select on public.vw_it_cost_entries to authenticated;

comment on view public.vw_it_cost_entries is
  'Os lançamentos do orçamento com os nomes resolvidos e a situação do fechamento.';

/*
 * O consolidado por competência, cenário e categoria.
 *
 * A conferência de ORIGEM mora aqui, e é o que torna o total verificável: o
 * número que o sistema mostra não é o total do que alguém digitou, e decompor
 * por procedência é o que permite responder "de onde vem essa diferença" em vez
 * de explicá-la.
 */
create or replace view public.vw_it_budget_monthly
with (security_invoker = true) as
select
  e.tenant_id,
  e.client_id,
  e.scenario_id,
  e.competence,
  e.expense_category_id,
  cat.name as category_name,
  e.branch_id,
  b.name as branch_name,
  sum(e.amount) as total,
  sum(e.amount) filter (where e.classificacao = 'despesa') as total_despesa,
  sum(e.amount) filter (where e.classificacao = 'investimento') as total_investimento,
  sum(e.amount) filter (where e.origem = 'manual') as total_manual,
  sum(e.amount) filter (where e.origem = 'planilha') as total_planilha,
  sum(e.amount) filter (where e.origem = 'projecao') as total_projecao,
  sum(e.amount) filter (where e.origem = 'titulo_a_pagar') as total_titulos,
  sum(e.amount) filter (where e.consumo = 'compartilhado') as total_compartilhado,
  count(*) as lancamentos
from public.it_cost_entries e
join public.expense_categories cat on cat.id = e.expense_category_id
left join public.branches b on b.id = e.branch_id
where e.deleted_at is null
group by e.tenant_id, e.client_id, e.scenario_id, e.competence,
         e.expense_category_id, cat.name, e.branch_id, b.name;

grant select on public.vw_it_budget_monthly to authenticated;

comment on view public.vw_it_budget_monthly is
  'O consolidado mensal com a decomposição por ORIGEM — é ela que torna o total verificável em vez de explicado.';

-- -----------------------------------------------------------------------------
-- 10. RLS
-- -----------------------------------------------------------------------------
select app.harden_table('public.it_budget_scenarios');
select app.harden_table('public.it_budget_closings');
select app.harden_table('public.it_cost_entries');
select app.harden_table('public.it_cost_beneficiaries');
select app.harden_table('public.it_budget_targets');

select app.attach_audit('public.it_cost_entries');
select app.attach_audit('public.it_budget_closings');
select app.attach_audit('public.it_budget_targets');

create policy orcamento_scenarios_select on public.it_budget_scenarios
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('financeiro.orcamento.ver'));

create policy orcamento_scenarios_write on public.it_budget_scenarios
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('financeiro.orcamento.lancar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('financeiro.orcamento.lancar'));

create policy orcamento_entries_select on public.it_cost_entries
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('financeiro.orcamento.ver'));

create policy orcamento_entries_write on public.it_cost_entries
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('financeiro.orcamento.lancar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('financeiro.orcamento.lancar'));

create policy orcamento_benef_select on public.it_cost_beneficiaries
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('financeiro.orcamento.ver'));

create policy orcamento_benef_write on public.it_cost_beneficiaries
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('financeiro.orcamento.lancar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('financeiro.orcamento.lancar'));

create policy orcamento_targets_select on public.it_budget_targets
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('financeiro.orcamento.ver'));

create policy orcamento_targets_write on public.it_budget_targets
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('financeiro.orcamento.lancar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('financeiro.orcamento.lancar'));

/* Fechar e reabrir é chave PRÓPRIA: quem lança não decide quando o mês para de
   aceitar lançamento. Fechar é o ato que dá sentido ao número divulgado. */
create policy orcamento_closings_select on public.it_budget_closings
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('financeiro.orcamento.ver'));

create policy orcamento_closings_write on public.it_budget_closings
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('financeiro.orcamento.fechar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('financeiro.orcamento.fechar'));

grant select, insert, update, delete on public.it_budget_scenarios to authenticated;
grant select, insert, update, delete on public.it_budget_closings to authenticated;
grant select, insert, update, delete on public.it_cost_entries to authenticated;
grant select, insert, update, delete on public.it_cost_beneficiaries to authenticated;
grant select, insert, update, delete on public.it_budget_targets to authenticated;

-- -----------------------------------------------------------------------------
-- 11. Catálogo de permissões
-- -----------------------------------------------------------------------------
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('financeiro.orcamento', 'financeiro', 'orcamento', null,
   'Orçamento de TI', 'gestor', 390),
  ('financeiro.orcamento.ver', 'financeiro', 'orcamento', 'ver',
   'Consultar o orçamento de TI', 'gestor', 391),
  ('financeiro.orcamento.lancar', 'financeiro', 'orcamento', 'lancar',
   'Lançar custo e importar títulos', 'gestor', 392),
  ('financeiro.orcamento.fechar', 'financeiro', 'orcamento', 'fechar',
   'Fechar e reabrir competência', 'gestor', 393)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

/*
 * O orçamento é do módulo `financeiro`, então ele já entra nos perfis que o
 * recebem — e, em `operador_financeiro`, a regra de ações (`ver`, `movimentar`)
 * já o limita a leitura, sem precisar de exceção.
 *
 * `gestor_ti` ganha o orçamento sem ganhar o resto do financeiro: quem responde
 * pelo custo da TI é ele, e títulos a pagar continuam sendo de quem paga.
 */
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
     'Operação de TI completa: helpdesk, inventário, telefonia, conectividade, mapas, SLA, projetos, orçamento de TI e cadastros.',
     'gestor', true, 'gestor_ti'),
    (p_tenant_id, 'Operador de TI',
     'Atende ticket, executa tarefa de projeto e consulta inventário, telefonia e links; não cadastra.',
     'atendente', true, 'operador_ti'),
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

  update public.access_profiles set description =
    'Operação de TI completa: helpdesk, inventário, telefonia, conectividade, mapas, SLA, projetos, orçamento de TI e cadastros.'
   where tenant_id = p_tenant_id and system_key = 'gestor_ti';
  update public.access_profiles set description =
    'Atende ticket, executa tarefa de projeto e consulta inventário, telefonia e links; não cadastra.'
   where tenant_id = p_tenant_id and system_key = 'operador_ti';

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

        -- `canais` entra aqui: conversa que vira chamado é operação de TI.
        -- `ia` também: sugestão de resposta e de triagem é ferramenta de quem
        -- atende, e o teto `admin` da configuração já a mantém fora do alcance
        -- do gestor.
        -- `auditoria` entra porque quem responde pela operação precisa poder
        -- responder "quem mudou isso" — e o teto `admin` de `trabalhos` já
        -- mantém o agendador fora.
        -- `projetos` entra porque o cronograma de TI é trabalho do gestor de TI.
        -- Do `financeiro`, só o ORÇAMENTO: quem responde pelo custo da TI é ele,
        -- e título a pagar continua sendo de quem paga.
        when 'gestor_ti' then
          c.module in
            ('helpdesk','inventario','telefonia','conectividade','mapas','sla',
             'clientes','fornecedores','tv','autoatendimento','canais','ia',
             'auditoria','projetos')
          or c.key in ('financeiro','financeiro.orcamento','financeiro.orcamento.ver',
                       'financeiro.orcamento.lancar','financeiro.orcamento.fechar')

        -- O operador lê e RESPONDE conversa — é o trabalho dele. Mas não liga nem
        -- desliga canal: isso guarda credencial. Em projetos, ele atualiza o
        -- andamento do que executou e não mexe no cronograma.
        when 'operador_ti' then
          c.module in ('helpdesk','autoatendimento','ia')
          or (c.module = 'canais' and c.screen is distinct from 'canais')
          or (c.module = 'projetos' and (c.action is null or c.action in ('ver','executar')))
          or (c.module in ('inventario','telefonia','conectividade','mapas')
              and (c.action is null or c.action = 'ver'))

        when 'gestor_financeiro' then
          c.module in ('financeiro','fornecedores')
          or (c.module = 'clientes' and (c.action is null or c.action = 'ver'))
          or (c.module = 'autoatendimento' and (c.action is null or c.action in ('ver','pedir')))
          or c.key in ('sla','sla.compliance','sla.compliance.ver')

        when 'operador_financeiro' then
          (c.module = 'financeiro'
            and (c.action is null
                 or c.action in ('ver','movimentar')
                 or (c.screen in ('titulos_pagar','titulos_receber')
                     and c.action in ('criar','editar','anexar','remover_anexo'))))
          or (c.module = 'autoatendimento' and (c.action is null or c.action in ('ver','pedir')))

        when 'aprovador_financeiro' then
          (c.module = 'financeiro'
            and (c.action is null
                 or c.action = 'ver'
                 or (c.screen = 'titulos_pagar' and c.action = 'aprovar')))
          or (c.module = 'autoatendimento' and (c.action is null or c.action in ('ver','pedir')))

        when 'solicitante' then true

        else false
      end
    on conflict do nothing;
  end loop;
end;
$$;

comment on function app.seed_system_access_profiles(uuid) is
  'Cria (idempotente) os perfis de sistema e suas concessões para um tenant.';

-- -----------------------------------------------------------------------------
-- 12. As categorias de despesa que nunca existiram
-- -----------------------------------------------------------------------------
/*
 * `expense_categories` está no banco desde a 0018, `payables` aponta para ela, a
 * tela de títulos a pagar lê a lista para um `select` — e **nenhuma linha nunca
 * foi criada**. Não há seed e não há tela de cadastro: o campo "Categoria" do
 * título a pagar sempre teve uma opção só, a vazia.
 *
 * É a mesma classe de defeito que a revisão da 0036 encontrou, e aqui ela é
 * bloqueante: `it_cost_entries.expense_category_id` é NOT NULL de propósito —
 * custo sem categoria não responde "quanto a TI gasta com o quê", que é a
 * pergunta do módulo.
 *
 * Os nove tipos vêm do GSTI.IARX, onde toda empresa nasce com eles. São os
 * grupos de gasto de uma operação de TI de verdade, e servem de ponto de
 * partida: a tabela aceita quantos mais o cliente quiser.
 */
create or replace function app.seed_expense_categories(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.expense_categories (tenant_id, code, name, requires_supplier)
  values
    (p_tenant_id, 'pessoas',        'Pessoas',                   false),
    (p_tenant_id, 'equipamentos',   'Equipamentos de TI',        true),
    (p_tenant_id, 'licencas',       'Licenças de software',      true),
    (p_tenant_id, 'impressao',      'Locação de impressora',     true),
    (p_tenant_id, 'materiais',      'Materiais de TI',           true),
    (p_tenant_id, 'servicos',       'Serviços técnicos',         true),
    (p_tenant_id, 'telecom',        'Telefonia e internet',      true),
    (p_tenant_id, 'desenvolvimento','Serviços de desenvolvimento', true),
    (p_tenant_id, 'sistemas',       'Sistemas gerenciais',       true)
  on conflict do nothing;
end;
$$;

comment on function app.seed_expense_categories(uuid) is
  'As nove categorias padrão de gasto de TI. A tabela existia desde a 0018 e nunca teve uma linha.';

create or replace function app.tenant_cria_categorias()
returns trigger
language plpgsql
as $$
begin
  perform app.seed_expense_categories(new.id);
  return new;
end;
$$;

create trigger trg_tenant_categorias
  after insert on public.tenants
  for each row execute function app.tenant_cria_categorias();

do $$
declare
  v_tenant record;
begin
  for v_tenant in select id from public.tenants loop
    perform app.seed_expense_categories(v_tenant.id);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- 13. Todo cliente nasce com o cenário oficial
-- -----------------------------------------------------------------------------
/*
 * Sem cenário, não há onde lançar — e `scenario_id` é NOT NULL de propósito: um
 * lançamento sem cenário entraria em todos os relatórios e em nenhum.
 */
create or replace function app.cliente_cria_cenario_oficial()
returns trigger
language plpgsql
as $$
begin
  insert into public.it_budget_scenarios (tenant_id, client_id, key, name, description)
  values (new.tenant_id, new.id, 'oficial', 'Oficial',
          'A projeção vigente. É ela que alimenta os indicadores por padrão.')
  on conflict do nothing;
  return new;
end;
$$;

create trigger trg_cliente_cenario_oficial
  after insert on public.clients
  for each row execute function app.cliente_cria_cenario_oficial();

insert into public.it_budget_scenarios (tenant_id, client_id, key, name, description)
select c.tenant_id, c.id, 'oficial', 'Oficial',
       'A projeção vigente. É ela que alimenta os indicadores por padrão.'
  from public.clients c
 where c.deleted_at is null
on conflict do nothing;

do $$
declare
  v_tenant record;
begin
  for v_tenant in select id from public.tenants loop
    perform app.seed_system_access_profiles(v_tenant.id);
  end loop;
end
$$;

commit;
