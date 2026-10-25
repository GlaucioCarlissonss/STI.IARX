-- =============================================================================
-- 0037 — Projetos, tarefas e cronograma
-- =============================================================================
-- Primeiro módulo trazido do GSTI.IARX, o SaaS de gestão para gestores de TI.
--
-- POR QUE ESTE MÓDULO VEM INTEIRO, E OS OUTROS DOIS NÃO
-- -----------------------------------------------------
-- O GSTI tem três módulos — Financeiro, Projetos e Suporte — e os três têm
-- relações MUITO diferentes com o que já existe aqui:
--
--   Projetos  → esta base não tem NADA. Lacuna limpa, e é o que esta migração
--               resolve.
--   Financeiro→ há sobreposição real: `payables` já guarda título a pagar com
--               parcelamento, centro de custo e filial. O que falta é a camada
--               de PLANEJAMENTO (competência, natureza, classificação, cenário,
--               fechamento), e ela entra lendo o que já existe em vez de criar
--               uma segunda verdade sobre o mesmo dinheiro. Outra migração.
--   Suporte   → **não entra.** O módulo de SLA do GSTI existe porque aquele
--               sistema não tem helpdesk: ele guarda, por mês e por fila, o
--               total atendido e quanto ficou dentro do SLA, digitado ou
--               importado. Esta base É o helpdesk, e calcula isso de chamado em
--               chamado, com expediente, feriado e pausa de relógio. Trazer o
--               agregado criaria um número digitado competindo com um número
--               derivado — e, quando os dois divergirem, ninguém saberá qual
--               está certo. O que falta aqui é a LEITURA mensal consolidada,
--               que é relatório sobre o que já existe, não tabela nova.
--
-- O QUE MUDA EM RELAÇÃO AO ORIGINAL
-- ---------------------------------
-- **A competência vira `date`.** No GSTI ela é texto `AAAA-MM` com `GLOB`,
-- porque o SQLite não tem tipo de mês. Aqui é um `date` preso ao dia 1 por
-- CHECK: comparação, intervalo e diferença em meses passam a ser aritmética de
-- data em vez de comparação de string.
--
-- **A hierarquia de tarefas passa a ser garantida pelo BANCO.** O original diz,
-- no schema: *"profundidade e ciclo o SQLite não expressa em CHECK"* — e valida
-- no domínio. O PostgreSQL expressa, e aqui expressa: uma trigger recusa ciclo e
-- recusa o quarto nível. A diferença importa porque a validação de aplicação é
-- pulada por importação, por correção manual e por qualquer caminho de escrita
-- que não passe pela função certa. O Gantt entra em laço infinito com um ciclo,
-- e descobrir isso em produção é descobrir pela tela que não carrega.
--
-- **`empresa`/`filial` viram `client_id`/`branch_id`**, que é como esta base
-- chama a mesma coisa desde a 0003.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Competência: o mês como data
-- -----------------------------------------------------------------------------
/*
 * Toda data deste módulo é um MÊS, não um dia: o cronograma é mensal porque
 * projeto de TI se planeja em meses, e fingir precisão de dia num campo que
 * ninguém preenche com precisão de dia produz um Gantt que mente.
 *
 * Guardar como `date` no dia 1 dá o melhor dos dois: aritmética de data de
 * verdade (`+ interval '1 month'`, `age()`) e um valor que não aceita 15/03.
 */
create or replace function app.eh_competencia(p_dia date)
returns boolean
language sql
immutable
as $$
  select p_dia is null or extract(day from p_dia) = 1;
$$;

comment on function app.eh_competencia(date) is
  'Verdadeiro quando a data é o primeiro dia do mês. Competência é mês, não dia.';

/** Diferença em meses entre duas competências. Negativo = a segunda é anterior. */
create or replace function app.meses_entre(p_de date, p_ate date)
returns integer
language sql
immutable
as $$
  select ((extract(year from p_ate) - extract(year from p_de)) * 12
        + (extract(month from p_ate) - extract(month from p_de)))::integer;
$$;

comment on function app.meses_entre(date, date) is
  'Diferença em meses entre duas competências, com sinal.';

-- -----------------------------------------------------------------------------
-- 2. Projetos
-- -----------------------------------------------------------------------------
create table public.projects (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  /* De quem é o projeto. Cliente é obrigatório — projeto de TI sem dono não tem
     a quem reportar —, filial é opcional: projeto de grupo atravessa unidades. */
  client_id     uuid not null,
  branch_id     uuid,

  name          text not null check (length(trim(name)) between 2 and 160),
  description   text,

  start_month        date not null check (app.eh_competencia(start_month)),
  planned_end_month  date not null check (app.eh_competencia(planned_end_month)),
  /* Só preenchido na conclusão. É ele que transforma "atrasado" em "desvio". */
  actual_end_month   date check (app.eh_competencia(actual_end_month)),

  status        text not null default 'planejado'
                  check (status in ('planejado', 'em_andamento', 'concluido', 'cancelado')),

  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  constraint uq_project_id_tenant unique (id, tenant_id),
  constraint fk_project_client foreign key (client_id, tenant_id)
    references public.clients (id, tenant_id) on delete cascade,
  constraint fk_project_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete set null,
  constraint fk_project_creator foreign key (created_by, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,

  constraint proj_fim_depois_do_inicio check (planned_end_month >= start_month),
  constraint proj_real_depois_do_inicio
    check (actual_end_month is null or actual_end_month >= start_month),
  /*
   * Concluído exige fim real.
   *
   * Sem isto, "concluído" vira um rótulo que alguém marca e o cronograma
   * continua mostrando a barra planejada sem a realizada — o projeto parece
   * entregue e o desvio não existe. É a mesma regra do original, aqui no banco.
   */
  constraint proj_concluido_tem_fim_real
    check (status <> 'concluido' or actual_end_month is not null)
);

create index idx_projects_cliente on public.projects (tenant_id, client_id) where deleted_at is null;
create index idx_projects_prazo on public.projects (tenant_id, planned_end_month) where deleted_at is null;

comment on table public.projects is
  'Projetos de TI com cronograma mensal. Atraso e desvio são derivados, nunca digitados.';

-- -----------------------------------------------------------------------------
-- 3. Tarefas, com hierarquia de três níveis
-- -----------------------------------------------------------------------------
create table public.project_tasks (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  project_id    uuid not null,

  name          text not null check (length(trim(name)) between 2 and 160),

  start_month        date not null check (app.eh_competencia(start_month)),
  planned_end_month  date not null check (app.eh_competencia(planned_end_month)),
  actual_end_month   date check (app.eh_competencia(actual_end_month)),

  /* Quem faz. Texto livre e não FK para `profiles`: metade das tarefas de um
     projeto de TI é de fornecedor, de outro setor ou de alguém que não tem
     conta aqui. Exigir cadastro faria a tarefa nascer sem responsável. */
  assignee      text,

  status        text not null default 'pendente'
                  check (status in ('pendente', 'em_andamento', 'concluida', 'cancelada')),

  /* A tarefa principal. Mesmo projeto, até três níveis, sem ciclo — e as três
     coisas são garantidas pela trigger logo abaixo. */
  parent_task_id uuid,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  constraint uq_task_id_tenant unique (id, tenant_id),
  constraint fk_task_project foreign key (project_id, tenant_id)
    references public.projects (id, tenant_id) on delete cascade,
  /* `on delete restrict`: excluir uma tarefa principal é bloqueado, não
     cascateado. Em cascata, uma confirmação de "excluir 1 tarefa" apagaria a
     subárvore inteira em silêncio. */
  constraint fk_task_parent foreign key (parent_task_id, tenant_id)
    references public.project_tasks (id, tenant_id) on delete restrict,

  constraint task_fim_depois_do_inicio check (planned_end_month >= start_month),
  constraint task_real_depois_do_inicio
    check (actual_end_month is null or actual_end_month >= start_month),
  constraint task_nao_e_a_propria_principal
    check (parent_task_id is null or parent_task_id <> id)
);

create index idx_tasks_projeto on public.project_tasks (project_id) where deleted_at is null;
create index idx_tasks_pai on public.project_tasks (parent_task_id) where parent_task_id is not null;
create index idx_tasks_prazo on public.project_tasks (tenant_id, planned_end_month) where deleted_at is null;

comment on table public.project_tasks is
  'Tarefas do projeto, com hierarquia de até 3 níveis garantida por trigger — não por convenção da aplicação.';

/** Três níveis: principal → subtarefa → subtarefa. */
create or replace function app.profundidade_maxima_de_tarefa()
returns integer
language sql
immutable
as $$ select 3; $$;

/*
 * A trigger que o SQLite não podia escrever.
 *
 * O schema original diz, em comentário: "profundidade e ciclo o SQLite não
 * expressa em CHECK" — e valida no domínio TypeScript. Funciona para quem passa
 * pela função certa, e não funciona para importação, correção manual ou
 * qualquer outro caminho de escrita.
 *
 * Aqui as três regras moram no banco:
 *
 *   1. mesmo projeto — um cronograma não agrupa por fora de si;
 *   2. sem ciclo — o Gantt entra em laço infinito, e o sintoma em produção é a
 *      tela que não carrega;
 *   3. até três níveis, contando a subárvore QUE VEM JUNTO: mover uma tarefa
 *      que já tem duas gerações abaixo para debaixo de outra raiz é recusado
 *      mesmo que a tarefa em si coubesse.
 */
create or replace function app.tarefa_valida_hierarquia()
returns trigger
language plpgsql
as $$
declare
  v_pai_projeto uuid;
  v_nivel_do_pai integer;
  v_altura_abaixo integer;
  v_teto integer := app.profundidade_maxima_de_tarefa();
begin
  if new.parent_task_id is null then
    return new;
  end if;

  select project_id into v_pai_projeto
    from public.project_tasks
   where id = new.parent_task_id and deleted_at is null;

  if v_pai_projeto is null then
    raise exception 'A tarefa principal escolhida não existe ou foi excluída.'
      using errcode = 'check_violation';
  end if;

  if v_pai_projeto <> new.project_id then
    raise exception 'A tarefa principal precisa ser do mesmo projeto.'
      using errcode = 'check_violation';
  end if;

  /* Ciclo: a tarefa que está sendo salva aparece na cadeia de ascendentes do
     pai escolhido. O `cycle` do CTE protege contra um ciclo já gravado — que
     não deveria existir, e é exatamente por isso que o laço precisa ter teto. */
  if exists (
    with recursive cadeia as (
      select t.id, t.parent_task_id, 1 as nivel
        from public.project_tasks t
       where t.id = new.parent_task_id
      union all
      select t.id, t.parent_task_id, c.nivel + 1
        from public.project_tasks t
        join cadeia c on t.id = c.parent_task_id
       where c.nivel < 64
    )
    select 1 from cadeia where id = new.id
  ) then
    raise exception 'Essa tarefa já está abaixo desta: escolhê-la como principal criaria um ciclo.'
      using errcode = 'check_violation';
  end if;

  /* Nível do pai (1 = raiz). */
  with recursive acima as (
    select t.id, t.parent_task_id, 1 as nivel
      from public.project_tasks t
     where t.id = new.parent_task_id
    union all
    select t.id, t.parent_task_id, a.nivel + 1
      from public.project_tasks t
      join acima a on t.id = a.parent_task_id
     where a.nivel < 64
  )
  select max(nivel) into v_nivel_do_pai from acima;

  /* Altura da subárvore que vem junto com a tarefa sendo movida. Na criação é
     zero, porque ela ainda não tem filhas. */
  with recursive abaixo as (
    select t.id, 0 as nivel
      from public.project_tasks t
     where t.id = new.id and t.deleted_at is null
    union all
    select t.id, a.nivel + 1
      from public.project_tasks t
      join abaixo a on t.parent_task_id = a.id
     where t.deleted_at is null and a.nivel < 64
  )
  select coalesce(max(nivel), 0) into v_altura_abaixo from abaixo;

  if v_nivel_do_pai + 1 + v_altura_abaixo > v_teto then
    raise exception
      'A hierarquia vai até % níveis (principal → subtarefa → subtarefa), e esta escolha passaria disso.',
      v_teto
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger trg_task_hierarquia
  before insert or update of parent_task_id, project_id on public.project_tasks
  for each row execute function app.tarefa_valida_hierarquia();

-- -----------------------------------------------------------------------------
-- 4. Envolvidos
-- -----------------------------------------------------------------------------
create table public.project_members (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  project_id    uuid not null,

  /* Mesmo raciocínio de `assignee`: fornecedor e gente de outro setor entram no
     projeto sem ter conta aqui. `profile_id` é o vínculo quando existe. */
  name          text not null check (length(trim(name)) between 2 and 160),
  role_in_project text,
  profile_id    uuid,

  created_at    timestamptz not null default now(),

  constraint uq_member_no_projeto unique (project_id, name),
  constraint fk_member_project foreign key (project_id, tenant_id)
    references public.projects (id, tenant_id) on delete cascade,
  constraint fk_member_profile foreign key (profile_id, tenant_id)
    references public.profiles (id, tenant_id) on delete set null
);

comment on table public.project_members is
  'Quem está no projeto. Nome livre, porque fornecedor e gente de outro setor entram sem ter conta aqui.';

-- -----------------------------------------------------------------------------
-- 5. Atraso e desvio: derivados, nunca digitados
-- -----------------------------------------------------------------------------
/*
 * A regra, igual à do original (`calcularAtraso`):
 *
 *   - cancelado nunca acusa atraso;
 *   - com fim real, não há atraso: há DESVIO em meses, que pode ser negativo
 *     (entrega adiantada);
 *   - sem fim real, o atraso é quanto o mês corrente passou do fim planejado.
 *
 * Calculado em view e não gravado em coluna porque atraso muda sozinho com a
 * passagem do mês: uma coluna precisaria de um trabalho agendado só para
 * envelhecer o número, e estaria errada entre uma execução e outra.
 */
create or replace function app.atraso_em_meses(
  p_planejado date,
  p_real date,
  p_status text
)
returns integer
language sql
stable
as $$
  select case
    when p_status in ('cancelado', 'cancelada') then 0
    when p_real is not null then 0
    else greatest(app.meses_entre(p_planejado, date_trunc('month', now())::date), 0)
  end;
$$;

create or replace function app.desvio_em_meses(
  p_planejado date,
  p_real date,
  p_status text
)
returns integer
language sql
stable
as $$
  select case
    when p_status in ('cancelado', 'cancelada') then 0
    when p_real is not null then app.meses_entre(p_planejado, p_real)
    else greatest(app.meses_entre(p_planejado, date_trunc('month', now())::date), 0)
  end;
$$;

comment on function app.atraso_em_meses(date, date, text) is
  'Meses de atraso de um item ainda não entregue. Cancelado e entregue devolvem zero.';
comment on function app.desvio_em_meses(date, date, text) is
  'Desvio entre planejado e real, em meses. Negativo = entregue adiantado.';

create or replace view public.vw_projects
with (security_invoker = true) as
select
  p.id,
  p.tenant_id,
  p.client_id,
  p.branch_id,
  p.name,
  p.description,
  p.start_month,
  p.planned_end_month,
  p.actual_end_month,
  p.status,
  p.created_at,
  c.trade_name  as client_name,
  b.name        as branch_name,
  app.meses_entre(p.start_month, p.planned_end_month) + 1 as duracao_planejada_meses,
  app.atraso_em_meses(p.planned_end_month, p.actual_end_month, p.status) as meses_atraso,
  app.desvio_em_meses(p.planned_end_month, p.actual_end_month, p.status) as desvio_meses,
  app.atraso_em_meses(p.planned_end_month, p.actual_end_month, p.status) > 0 as atrasado,
  (select count(*) from public.project_tasks t
    where t.project_id = p.id and t.deleted_at is null) as total_tarefas,
  (select count(*) from public.project_tasks t
    where t.project_id = p.id and t.deleted_at is null
      and t.actual_end_month is not null) as tarefas_entregues,
  (select count(*) from public.project_tasks t
    where t.project_id = p.id and t.deleted_at is null
      and app.atraso_em_meses(t.planned_end_month, t.actual_end_month, t.status) > 0) as tarefas_atrasadas
from public.projects p
join public.clients c on c.id = p.client_id
left join public.branches b on b.id = p.branch_id
where p.deleted_at is null;

grant select on public.vw_projects to authenticated;

comment on view public.vw_projects is
  'Projetos com atraso, desvio e contagem de tarefas — todos derivados na consulta, porque atraso muda sozinho com a passagem do mês.';

create or replace view public.vw_project_tasks
with (security_invoker = true) as
select
  t.id,
  t.tenant_id,
  t.project_id,
  t.parent_task_id,
  t.name,
  t.start_month,
  t.planned_end_month,
  t.actual_end_month,
  t.assignee,
  t.status,
  p.name        as project_name,
  p.client_id,
  p.branch_id,
  b.name        as branch_name,
  app.atraso_em_meses(t.planned_end_month, t.actual_end_month, t.status) as meses_atraso,
  app.desvio_em_meses(t.planned_end_month, t.actual_end_month, t.status) as desvio_meses,
  app.atraso_em_meses(t.planned_end_month, t.actual_end_month, t.status) > 0 as atrasado,
  (select count(*) from public.project_tasks f
    where f.parent_task_id = t.id and f.deleted_at is null) as total_subtarefas
from public.project_tasks t
join public.projects p on p.id = t.project_id and p.deleted_at is null
left join public.branches b on b.id = p.branch_id
where t.deleted_at is null;

grant select on public.vw_project_tasks to authenticated;

comment on view public.vw_project_tasks is
  'Tarefas com atraso e desvio derivados, mais o projeto e a filial — o recorte que o cronograma e os indicadores usam.';

-- -----------------------------------------------------------------------------
-- 6. RLS
-- -----------------------------------------------------------------------------
select app.harden_table('public.projects');
select app.harden_table('public.project_tasks');
select app.harden_table('public.project_members');

select app.attach_audit('public.projects');
select app.attach_audit('public.project_tasks');

create policy projects_select on public.projects
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('projetos.projetos.ver'));

create policy projects_insert on public.projects
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_permission('projetos.projetos.criar'));

create policy projects_update on public.projects
  for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('projetos.projetos.editar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('projetos.projetos.editar'));

create policy projects_delete on public.projects
  for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('projetos.projetos.excluir'));

create policy tasks_select on public.project_tasks
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('projetos.projetos.ver'));

/*
 * Tarefa tem DUAS permissões de escrita, e a distinção é o ponto.
 *
 * `editar` é de quem planeja: criar tarefa, mudar prazo, reagrupar hierarquia.
 * `executar` é de quem FAZ: marcar andamento e registrar o mês de entrega. O
 * teto de `executar` é `atendente`, porque quem executa a tarefa é o técnico —
 * e exigir papel de gestor para dizer "terminei" faria o cronograma envelhecer
 * no gargalo de quem o administra.
 */
create policy tasks_insert on public.project_tasks
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_permission('projetos.projetos.editar'));

create policy tasks_update on public.project_tasks
  for update to authenticated
  using (tenant_id = app.current_tenant_id()
         and (app.has_permission('projetos.projetos.editar')
              or app.has_permission('projetos.projetos.executar')))
  with check (tenant_id = app.current_tenant_id()
              and (app.has_permission('projetos.projetos.editar')
                   or app.has_permission('projetos.projetos.executar')));

create policy tasks_delete on public.project_tasks
  for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('projetos.projetos.editar'));

create policy members_select on public.project_members
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('projetos.projetos.ver'));

create policy members_write on public.project_members
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('projetos.projetos.editar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('projetos.projetos.editar'));

grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.project_tasks to authenticated;
grant select, insert, update, delete on public.project_members to authenticated;

-- -----------------------------------------------------------------------------
-- 7. Catálogo de permissões
-- -----------------------------------------------------------------------------
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('projetos', 'projetos', null, null, 'Projetos', 'visualizador', 470),
  ('projetos.projetos', 'projetos', 'projetos', null, 'Projetos e cronograma', 'visualizador', 471),
  ('projetos.projetos.ver', 'projetos', 'projetos', 'ver',
   'Consultar projetos e cronograma', 'visualizador', 472),
  ('projetos.projetos.executar', 'projetos', 'projetos', 'executar',
   'Atualizar andamento de tarefa', 'atendente', 473),
  ('projetos.projetos.criar', 'projetos', 'projetos', 'criar',
   'Criar projeto', 'gestor', 474),
  ('projetos.projetos.editar', 'projetos', 'projetos', 'editar',
   'Editar projeto, tarefas e envolvidos', 'gestor', 475),
  ('projetos.projetos.excluir', 'projetos', 'projetos', 'excluir',
   'Excluir projeto', 'gestor', 476)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

/*
 * `projetos` entra em `gestor_ti` (planeja e executa) e, por leitura, em
 * `diretoria` e `visualizador` — os dois recebem toda chave `ver` que o papel
 * alcança, e `projetos.projetos.ver` tem teto `visualizador`.
 *
 * `operador_ti` recebe o módulo inteiro limitado a `ver` e `executar`: ele
 * atualiza o andamento da tarefa que executou e não mexe no cronograma.
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
     'Operação de TI completa: helpdesk, inventário, telefonia, conectividade, mapas, SLA, projetos e cadastros.',
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
    'Operação de TI completa: helpdesk, inventário, telefonia, conectividade, mapas, SLA, projetos e cadastros.'
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
        when 'gestor_ti' then c.module in
          ('helpdesk','inventario','telefonia','conectividade','mapas','sla',
           'clientes','fornecedores','tv','autoatendimento','canais','ia',
           'auditoria','projetos')

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
