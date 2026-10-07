-- =============================================================================
-- 0028 — Agregados por filial e por cliente, para paginar sem mentir
-- =============================================================================
-- Entrega 6 da auditoria (docs/10): desempenho.
--
-- O PROBLEMA QUE ESTA MIGRAÇÃO EXISTE PARA RESOLVER
-- -------------------------------------------------
-- Cinco telas calculam os seus indicadores **em memória, a partir da lista
-- inteira**: `lista.filter(...).length`, `lista.reduce(...)`. Enquanto a consulta
-- traz tudo, o número está certo. No instante em que a lista passa a vir
-- paginada — que é o que a entrega 6 faz, porque hoje `/tickets` corta em 200,
-- `/inventario` em 400 e `/conectividade/links` em 300 **sem dizer a ninguém**,
-- e `/financeiro/titulos-*` não corta em lugar nenhum — esses mesmos indicadores
-- passariam a contar só a página visível.
--
-- "Ativos cadastrados: 50" numa empresa com 412 equipamentos é pior que a
-- truncagem que estamos corrigindo: a truncagem esconde linhas, e o número
-- errado afirma uma coisa falsa com cara de fato.
--
-- Por isso cada tela que paginar ganha aqui a sua fonte de total. Nenhuma regra
-- muda: **cada view reproduz exatamente o filtro que a tela já aplica hoje**,
-- inclusive onde esse filtro é discutível. Onde eu discordo da regra, o
-- comentário diz — e a regra fica.
--
-- E TODAS CARREGAM A COLUNA DO ESCOPO
-- -----------------------------------
-- `branch_id` nas de patrimônio e despesa, `client_id` na de receita. Sem isso o
-- foco por empresa (0027) estreitaria a lista e deixaria o indicador em cima
-- dela contando o tenant inteiro — dois números na mesma tela, discordando, sem
-- nada que explique. É o defeito que `vw_dashboard_metrics` ainda tem, e está
-- registrado como lacuna em docs/10 justamente por não ter sido resolvido lá.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Títulos a pagar — agora por filial
-- -----------------------------------------------------------------------------
-- A view existe desde a 0020 e **nunca teve leitor**: a tela calculava tudo na
-- aplicação. Ela volta aqui com `branch_id` no agrupamento, que é o que faltava
-- para ela conviver com o foco por empresa.
--
-- `coalesce` nos dois somatórios com `filter`: sem nenhuma linha vencida o
-- `sum(...) filter (...)` devolve NULL, e NULL somado na aplicação vira `NaN` na
-- tela. Com a view sem leitor isso nunca apareceu; com leitor, apareceria no
-- primeiro mês em que ninguém atrasasse nada.
drop view if exists public.vw_payables_summary;

create view public.vw_payables_summary
  with (security_invoker = true) as
select
  p.tenant_id,
  p.branch_id,
  p.status,
  count(*)                                              as titulos,
  coalesce(sum(p.amount), 0)                            as total,
  count(*) filter (where p.due_on < current_date
                     and p.status not in ('paid', 'cancelled')) as vencidos,
  coalesce(sum(p.amount) filter (where p.due_on < current_date
                     and p.status not in ('paid', 'cancelled')), 0) as total_vencido,
  count(*) filter (where p.due_on between current_date and current_date + 7
                     and p.status not in ('paid', 'cancelled')) as vence_em_7_dias
from public.payables p
where p.deleted_at is null
group by p.tenant_id, p.branch_id, p.status;

comment on view public.vw_payables_summary is
  'Títulos a pagar agregados por filial e situação. Fonte dos indicadores de /financeiro/titulos-a-pagar.';

-- -----------------------------------------------------------------------------
-- 2. Títulos a receber — por cliente
-- -----------------------------------------------------------------------------
-- `diferenca_recebida` é a conta que a tela chama de "diferença": o combinado
-- menos o efetivamente recebido, nos títulos já baixados. É onde desconto e
-- recebimento parcial aparecem — somar só o recebido esconderia a perda.
--
-- `coalesce(r.received_amount, r.amount)` repete a regra da tela: título baixado
-- sem valor informado foi recebido integralmente.
create view public.vw_receivables_summary
  with (security_invoker = true) as
select
  r.tenant_id,
  r.client_id,
  r.status,
  count(*)                                              as titulos,
  coalesce(sum(r.amount), 0)                            as total,
  count(*) filter (where r.due_on < current_date
                     and r.status = 'open')             as vencidos,
  coalesce(sum(r.amount) filter (where r.due_on < current_date
                     and r.status = 'open'), 0)         as total_vencido,
  coalesce(sum(r.amount - coalesce(r.received_amount, r.amount))
             filter (where r.status = 'received'), 0)   as diferenca_recebida
from public.receivables r
where r.deleted_at is null
group by r.tenant_id, r.client_id, r.status;

comment on view public.vw_receivables_summary is
  'Títulos a receber agregados por cliente e situação, com a diferença entre combinado e recebido.';

-- -----------------------------------------------------------------------------
-- 3. Inventário de TI
-- -----------------------------------------------------------------------------
-- `garantia_90d` reproduz a regra da tela **com o piso em `current_date`**, que
-- lá está e tem motivo escrito: sem o piso, garantia vencida há anos contava
-- como "vencendo em 90 dias" para sempre, e o indicador ficava vermelho
-- permanentemente, escondendo a garantia que de fato vence semana que vem.
--
-- `status <> 'retired'` também vem de lá: equipamento baixado não tem garantia
-- a renovar.
create view public.vw_assets_summary
  with (security_invoker = true) as
select
  a.tenant_id,
  a.branch_id,
  a.status,
  count(*)                                   as ativos,
  coalesce(sum(a.acquisition_cost), 0)       as valor_total,
  count(*) filter (where a.warranty_until is not null
                     and a.warranty_until >= current_date
                     and a.warranty_until <= current_date + 90
                     and a.status <> 'retired')        as garantia_90d
from public.it_assets a
where a.deleted_at is null
group by a.tenant_id, a.branch_id, a.status;

comment on view public.vw_assets_summary is
  'Inventário agregado por filial e situação. Fonte dos indicadores de /inventario.';

-- -----------------------------------------------------------------------------
-- 4. Links de internet — a coluna que faltava
-- -----------------------------------------------------------------------------
-- `vw_internet_dashboard` nasceu na 0013 e também nunca teve leitor. Ela quase
-- serve: traz contagem, custo, fora do ar, a vencer e sem contrato. Faltava
-- `links_unknown` — "não monitorado", que é um indicador da tela desde que o
-- módulo ganhou interface.
--
-- `expiring_90d` passa a reproduzir a tela ao pé da letra, incluindo
-- `status <> 'cancelled'`. **A tela não põe piso em `current_date` aqui**, ao
-- contrário do que faz com a garantia do inventário: contrato terminado há dois
-- anos continua contando como "vigência terminando nos próximos 90 dias". Eu
-- discordo dessa regra, mas ela é da tela e muda um número que alguém lê todo
-- dia — então ela fica, e esta linha existe para que paginar não a altere por
-- acidente. Trocá-la é decisão de produto, registrada em docs/10.
drop view if exists public.vw_internet_dashboard;

create view public.vw_internet_dashboard
  with (security_invoker = true) as
select
  k.tenant_id,
  k.branch_id,
  b.name as branch_name,
  coalesce(s.name, k.carrier_name) as carrier,
  k.technology,
  k.status,
  count(*)                                          as links_count,
  coalesce(sum(k.monthly_cost), 0)                  as monthly_total,
  count(*) filter (where k.last_state = 'down')     as links_down,
  count(*) filter (where k.last_state = 'unknown')  as links_unknown,
  count(*) filter (where k.status <> 'cancelled'
                     and k.contract_end is not null
                     and k.contract_end <= current_date + 90) as expiring_90d,
  -- O aviso da tela diz "N contratos vencendo — e há vigência já expirada".
  -- A segunda metade da frase também precisa de uma coluna: calculá-la na
  -- aplicação exigiria a lista inteira, que é justamente o que a paginação
  -- deixou de trazer. Sem isto, o aviso perderia a parte mais urgente.
  count(*) filter (where k.status <> 'cancelled'
                     and k.contract_end is not null
                     and k.contract_end < current_date)       as expirados,
  count(*) filter (where not exists (
    select 1 from public.internet_link_attachments la
    where la.link_id = k.id and la.kind = 'contract'))        as without_contract
from public.internet_links k
left join public.branches b  on b.id = k.branch_id
left join public.suppliers s on s.id = k.supplier_id
where k.deleted_at is null
group by k.tenant_id, k.branch_id, b.name, coalesce(s.name, k.carrier_name),
         k.technology, k.status;

comment on view public.vw_internet_dashboard is
  'Links agregados por filial, operadora, tecnologia e situação. Fonte dos indicadores de /conectividade/links.';

-- -----------------------------------------------------------------------------
-- 5. Permissão de leitura
-- -----------------------------------------------------------------------------
-- `drop view` leva junto os GRANTs. As duas views recriadas perderiam o
-- `select` que a 0013 e a 0020 tinham concedido, e o sintoma seria
-- "permission denied for view" numa tela que funcionava — num ambiente onde
-- ninguém mexeu em permissão nenhuma.
--
-- `security_invoker` continua sendo o que protege: o GRANT abre a view, e o RLS
-- da tabela de origem decide quais linhas ela entrega. Sem ele, um agregado
-- seria o caminho mais curto para descobrir quanto outro tenant tem a pagar sem
-- nunca ver uma linha dele.
grant select on
  public.vw_payables_summary,
  public.vw_receivables_summary,
  public.vw_assets_summary,
  public.vw_internet_dashboard
to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Índices para a paginação ordenada
-- -----------------------------------------------------------------------------
-- `.range()` com `order by` sem índice obriga o Postgres a ordenar a tabela
-- inteira para devolver 50 linhas — e o custo cresce com o acervo, não com a
-- página. Com poucos milhares de linhas ninguém nota; é exatamente por isso que
-- o índice entra agora, e não no dia em que alguém notar.
--
-- Parciais em `deleted_at is null` porque toda listagem filtra por isso: o
-- índice fica menor e cobre a consulta que existe, em vez da que não existe.
create index if not exists idx_payables_pagina
  on public.payables (tenant_id, due_on, id) where deleted_at is null;

create index if not exists idx_receivables_pagina
  on public.receivables (tenant_id, due_on, id) where deleted_at is null;

create index if not exists idx_assets_pagina
  on public.it_assets (tenant_id, asset_tag, id) where deleted_at is null;

create index if not exists idx_lines_pagina
  on public.telecom_lines (tenant_id, phone_number, id) where deleted_at is null;

create index if not exists idx_links_pagina
  on public.internet_links (tenant_id, contract_number, id) where deleted_at is null;

commit;
