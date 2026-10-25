-- =============================================================================
-- 0039 — Visão de resultado: financeiro, SLA e projetos numa tela só
-- =============================================================================
-- É a tela que o GSTI.IARX chama de Painel Executivo, e a razão de os três
-- módulos existirem juntos lá: o gestor de TI não acompanha custo, prazo e
-- entrega em três lugares — ele responde por um resultado.
--
-- POR QUE ELA FECHA UMA DÍVIDA DESTE REPOSITÓRIO
-- ----------------------------------------------
-- Quando o módulo de SLA do GSTI foi recusado (0037), a justificativa dizia:
--
--   "O que falta aqui não é a tabela: é a LEITURA MENSAL CONSOLIDADA para o
--    gestor. Isso é relatório sobre o que já existe."
--
-- Esta é a leitura. E ela é relatório mesmo: nenhuma tabela nova, nenhum número
-- digitado. Os três indicadores vêm de onde os dados já estão —
-- `vw_it_budget_monthly` (0038), `vw_projects` (0037) e `vw_sla_compliance`
-- (0011), que calcula conformidade chamado a chamado desde sempre.
--
-- POR QUE UMA FUNÇÃO, E NÃO TRÊS CONSULTAS NA TELA
-- ------------------------------------------------
-- Porque o recorte precisa ser o MESMO nos três. Com três consultas montadas na
-- tela, um filtro que diverge entre elas produz uma tela em que os números não
-- conversam — e ninguém percebe, porque cada um parece certo sozinho.
--
-- Aqui o cliente e a competência entram uma vez e valem para os três. E o
-- resultado é testável por asserção de schema, que é a única forma de provar que
-- um indicador consolidado soma o que diz somar.
--
-- O DETALHE DE CADA INDICADOR SAI PELA DIMENSÃO QUE A FONTE TEM
-- -------------------------------------------------------------
-- Financeiro e projetos se abrem por FILIAL; o SLA, por FILA. Não é descuido:
-- `vw_sla_compliance` agrupa por fila, responsável e cliente — não por filial.
--
-- Forçar as três no mesmo eixo exigiria uma view nova de SLA por filial, e a
-- tela estaria afirmando uma comparação que o dado não sustenta. Cada indicador
-- se abre pelo que ele realmente sabe, e a tela diz qual é o eixo de cada um.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0. O cenário entra na view consolidada
-- -----------------------------------------------------------------------------
/*
 * `vw_it_budget_monthly` já agrupava por `scenario_id`, mas não dizia QUAL
 * cenário — e sem a chave não há como um relatório separar o oficial dos
 * demais. A própria 0038 define o contrato:
 *
 *   "O `oficial` alimenta os indicadores; os outros convivem sem contaminar os
 *    totais."
 *
 * Sem esta coluna, o contrato era só um comentário: no dia em que alguém
 * criasse um cenário de simulação, todo indicador de gasto passaria a somar a
 * simulação junto com o real — silenciosamente, e para mais.
 *
 * A coluna entra no FIM porque `create or replace view` exige que as colunas
 * existentes mantenham nome, tipo e posição.
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
  count(*) as lancamentos,
  sc.key as scenario_key
from public.it_cost_entries e
join public.expense_categories cat on cat.id = e.expense_category_id
join public.it_budget_scenarios sc on sc.id = e.scenario_id
left join public.branches b on b.id = e.branch_id
where e.deleted_at is null
group by e.tenant_id, e.client_id, e.scenario_id, e.competence,
         e.expense_category_id, cat.name, e.branch_id, b.name, sc.key;

comment on view public.vw_it_budget_monthly is
  'O consolidado mensal com a decomposição por ORIGEM e a chave do CENÁRIO — é ela que mantém a simulação fora do indicador.';

-- -----------------------------------------------------------------------------
-- 1. Os indicadores consolidados
-- -----------------------------------------------------------------------------
/*
 * `security invoker` — o padrão desta base. Cada `select` lá dentro passa pelas
 * policies de quem chamou: quem não tem `financeiro.orcamento.ver` recebe zero
 * no financeiro, e não um erro. É deliberado, e a tela diz o que está oculto por
 * permissão em vez de mostrar zero como se fosse ausência de dado.
 */
create or replace function public.gestao_resultado(
  p_client_id uuid,
  p_competence date
)
returns table (
  gasto_mes numeric,
  gasto_mes_anterior numeric,
  gasto_despesa numeric,
  gasto_investimento numeric,
  gasto_compartilhado numeric,
  compromisso_12m numeric,
  projetos_total integer,
  projetos_em_andamento integer,
  projetos_atrasados integer,
  projetos_entregues_no_prazo integer,
  projetos_entregues integer,
  sla_tickets integer,
  sla_com_acordo integer,
  sla_fora integer,
  sla_conformidade numeric,
  competencia_fechada boolean
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  /*
   * `scenario_key = 'oficial'` nos três recortes de dinheiro. É o contrato da
   * 0038 — o cenário de simulação convive sem contaminar o total —, e aqui ele
   * é especialmente caro: um indicador de resultado que soma simulação com real
   * erra sempre para mais, e ninguém desconfia de um número que subiu.
   */
  with financeiro as (
    select
      coalesce(sum(m.total), 0)               as total,
      coalesce(sum(m.total_despesa), 0)       as despesa,
      coalesce(sum(m.total_investimento), 0)  as investimento,
      coalesce(sum(m.total_compartilhado), 0) as compartilhado
    from public.vw_it_budget_monthly m
    where m.client_id = p_client_id and m.competence = p_competence
      and m.scenario_key = 'oficial'
  ),
  anterior as (
    select coalesce(sum(m.total), 0) as total
    from public.vw_it_budget_monthly m
    where m.client_id = p_client_id
      and m.competence = (p_competence - interval '1 month')::date
      and m.scenario_key = 'oficial'
  ),
  /*
   * Compromisso: o que já está lançado nos doze meses SEGUINTES.
   *
   * Não é projeção nem estimativa — é parcela e recorrência que alguém já
   * registrou. É o número que responde "quanto da verba do ano que vem já está
   * comprometido", e ele costuma surpreender.
   */
  compromisso as (
    select coalesce(sum(e.amount), 0) as total
    from public.it_cost_entries e
    join public.it_budget_scenarios sc on sc.id = e.scenario_id
    where e.client_id = p_client_id
      and e.deleted_at is null
      and sc.key = 'oficial'
      and e.competence > p_competence
      and e.competence <= (p_competence + interval '12 months')::date
  ),
  projetos as (
    select
      count(*)::integer                                           as total,
      count(*) filter (where p.status = 'em_andamento')::integer  as em_andamento,
      count(*) filter (where p.atrasado)::integer                 as atrasados,
      count(*) filter (where p.actual_end_month is not null)::integer as entregues,
      count(*) filter (where p.actual_end_month is not null
                         and p.desvio_meses <= 0)::integer        as no_prazo
    from public.vw_projects p
    where p.client_id = p_client_id
  ),
  /*
   * SLA: lido de `vw_sla_compliance`, que conta chamado a chamado desde a 0011.
   *
   * `resolution_breaches` é o número de estouros; a conformidade é derivada
   * daqui e não da coluna `resolution_compliance_pct` da view — ela é por fila,
   * e a média de percentuais por fila NÃO é o percentual do conjunto. Uma fila
   * com um chamado e 0% puxaria o resultado tanto quanto uma com duzentos.
   */
  sla as (
    select
      coalesce(sum(s.tickets_total), 0)::integer      as tickets,
      coalesce(sum(s.tickets_with_sla), 0)::integer   as com_acordo,
      coalesce(sum(s.resolution_breaches), 0)::integer as fora
    from public.vw_sla_compliance s
    where s.client_id = p_client_id
      and date_trunc('month', s.period)::date = p_competence
  )
  select
    f.total,
    a.total,
    f.despesa,
    f.investimento,
    f.compartilhado,
    c.total,
    pr.total,
    pr.em_andamento,
    pr.atrasados,
    pr.no_prazo,
    pr.entregues,
    sl.tickets,
    sl.com_acordo,
    sl.fora,
    /* Zero chamado com acordo devolve NULO, e não 100%: "nenhum estouro em
       nenhum chamado" não é conformidade perfeita, é ausência de medida. A tela
       escreve um travessão. */
    case when sl.com_acordo > 0
         then round(((sl.com_acordo - sl.fora)::numeric / sl.com_acordo) * 100, 1)
         else null end,
    app.competencia_fechada(p_client_id, p_competence)
  from financeiro f, anterior a, compromisso c, projetos pr, sla sl;
$$;

grant execute on function public.gestao_resultado(uuid, date) to authenticated;

comment on function public.gestao_resultado(uuid, date) is
  'Os indicadores de financeiro, projetos e SLA de um cliente numa competência — com o MESMO recorte nos três.';

-- -----------------------------------------------------------------------------
-- 2. O detalhe do financeiro, por filial
-- -----------------------------------------------------------------------------
/*
 * A soma deste detalhe tem de bater com `gasto_mes`. A tela confere e DIZ o
 * resultado da conferência — é o contrato de leitura do painel do GSTI:
 *
 *   "a soma do detalhe conferida contra o indicador na própria tela"
 *
 * Um indicador que não bate com o seu próprio detalhamento é o defeito mais
 * caro de um painel: os dois números parecem certos sozinhos, e quem compara
 * descobre que um filtro divergiu.
 */
create or replace function public.gestao_gasto_por_filial(
  p_client_id uuid,
  p_competence date
)
returns table (branch_id uuid, branch_name text, total numeric)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    m.branch_id,
    coalesce(m.branch_name, 'Do grupo') as branch_name,
    sum(m.total) as total
  from public.vw_it_budget_monthly m
  where m.client_id = p_client_id and m.competence = p_competence
    and m.scenario_key = 'oficial'   -- o MESMO recorte do indicador, ou a conferência acusa
  group by m.branch_id, m.branch_name
  order by sum(m.total) desc;
$$;

grant execute on function public.gestao_gasto_por_filial(uuid, date) to authenticated;

comment on function public.gestao_gasto_por_filial(uuid, date) is
  'O gasto da competência aberto por filial. A soma tem de bater com o indicador — e a tela confere.';

-- -----------------------------------------------------------------------------
-- 3. Catálogo de permissões
-- -----------------------------------------------------------------------------
/*
 * Módulo próprio com uma tela só, e isso é deliberado.
 *
 * A visão de resultado atravessa três módulos, e pendurá-la em qualquer um
 * deles (`financeiro.resultado`? `projetos.resultado`?) diria que ela pertence
 * àquele — e quem concedesse a chave estaria concedendo mais do que imagina.
 *
 * A chave aqui governa só o ACESSO À TELA. O que cada bloco mostra continua
 * governado pela permissão do módulo de origem: sem `financeiro.orcamento.ver`
 * o bloco financeiro não aparece, e a tela diz que ele está oculto por
 * permissão — em vez de mostrar zero, que seria lido como "não há gasto".
 */
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('gestao', 'gestao', null, null, 'Gestão', 'gestor', 480),
  ('gestao.resultado', 'gestao', 'resultado', null, 'Visão de resultado', 'gestor', 481),
  ('gestao.resultado.ver', 'gestao', 'resultado', 'ver',
   'Abrir a visão de resultado', 'gestor', 482)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

/* `gestao` entra em `gestor_ti` — é a tela dele — e, por leitura, em
   `diretoria`, que recebe toda chave `ver` que o papel alcança. */
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
        -- `gestao` é a tela dele por definição: custo, prazo e entrega juntos.
        -- Do `financeiro`, só o ORÇAMENTO: quem responde pelo custo da TI é ele,
        -- e título a pagar continua sendo de quem paga.
        when 'gestor_ti' then
          c.module in
            ('helpdesk','inventario','telefonia','conectividade','mapas','sla',
             'clientes','fornecedores','tv','autoatendimento','canais','ia',
             'auditoria','projetos','gestao')
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
