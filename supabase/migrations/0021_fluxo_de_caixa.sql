-- =============================================================================
-- 0021 — Fluxo de caixa: projeção sobre o que já está lançado
-- =============================================================================
-- Fecha o MÓDULO 7 de docs/07. Não cria tabela nenhuma: a projeção é derivada de
-- `bank_accounts` + `bank_account_movements` + `payables` + `receivables`, todos
-- entregues nas migrações 0018 e 0020.
--
-- O QUE ESTA TELA PROJETA, E O QUE ELA NÃO PROJETA
-- ------------------------------------------------
-- Projeta o COMPROMETIDO: um título aprovado com vencimento em 10/nov é uma
-- obrigação registrada, não estimativa. Isso é dado real.
--
-- NÃO projeta tendência. `payables.paid_on` está vazio nesta base — não há
-- histórico de pagamento —, então nada de média de atraso, sazonalidade ou
-- previsão de faturamento. Número inventado com casa decimal parece mais
-- confiável que número nenhum, e é pior.
--
-- POR QUE NO BANCO E NÃO EM TYPESCRIPT
-- ------------------------------------
-- "Qual situação conta como previsto" é regra financeira, e aqui ela pode ser
-- PROVADA: `supabase/tests/schema_test.sql` roda contra PostgreSQL real com papel
-- sem `bypassrls`. O vitest desta base não tem banco.
--
-- POR QUE NÃO É `security definer`
-- --------------------------------
-- Nada aqui precisa furar o RLS. Sendo invoker, a consulta enxerga exatamente o
-- que a sessão enxerga — inclusive o escopo por filial. E não há fachada em `app`
-- como a de `required_approval_levels_for()` porque não há parâmetro de tenant a
-- proteger: o tenant vem do RLS das tabelas base.
-- =============================================================================

begin;

/**
 * Projeção de caixa por mês.
 *
 * O QUE ENTRA (e cada exclusão tem motivo, não é esquecimento):
 *
 *   payables.draft             NÃO — alguém ainda digitando não é compromisso.
 *   payables.pending_approval  SIM — a despesa já foi incorrida; excluir deixaria
 *                                    a projeção otimista. Volta somada, e a tela
 *                                    mostra o valor à parte para quem quiser
 *                                    subtrair.
 *   payables.approved          SIM
 *   payables.scheduled         SIM
 *   payables.rejected          NÃO — não será pago.
 *   payables.paid              NÃO — já está no saldo bancário. Incluir seria
 *                                    contar o mesmo dinheiro duas vezes.
 *   payables.cancelled         NÃO
 *
 *   receivables.open           SIM — única entrada prevista.
 *   receivables.draft          NÃO — não emitido.
 *   receivables.received       NÃO — já está no saldo.
 *   receivables.cancelled      NÃO
 *
 * TÍTULO VENCIDO E NÃO PAGO é obrigação real: não pode sumir da conta. Entra no
 * mês corrente com dia efetivo = hoje (`greatest(due_on, current_date)`) e volta
 * destacado em `overdue_inflow`/`overdue_outflow`, para a tela poder dizer quanto
 * do mês atual é atraso e não previsão.
 *
 * SALDO DE D0 — a armadilha que este código evita:
 * `vw_bank_account_balances.current_balance` NÃO tem corte de data, e
 * `bank_account_movements.moved_on` é uma `date` livre. Um lançamento datado no
 * futuro já está dentro daquele saldo hoje. Usá-lo como ponto de partida e depois
 * projetar o mesmo mês contaria o valor duas vezes. Aqui o saldo de D0 é
 * `opening_balance` mais os movimentos ATÉ hoje, e os movimentos futuros entram
 * como terceiro braço da projeção.
 *
 * INADIMPLÊNCIA é parâmetro, não regra: nenhum percentual está escrito em
 * documento de negócio algum, e três percentuais escolhidos por mim seriam regra
 * inventada com cara de fato. Mesma decisão da alçada na 0020, que nasce vazia.
 * Padrão 0 = todos os recebíveis entram integralmente.
 *
 * FILTRO POR CONTA BANCÁRIA foi deliberadamente NÃO implementado, embora docs/07
 * o cite. Título em aberto quase nunca tem `bank_account_id` — a conta só é
 * gravada na baixa —, então filtrar por conta esvaziaria a projeção e pareceria
 * "não há nada a pagar". Filtro que mente é pior que filtro ausente.
 */
create or replace function public.cash_flow_projection(
  p_months           integer default 12,
  p_delinquency_rate numeric default 0,
  p_branch_id        uuid    default null,
  p_cost_center_id   uuid    default null
)
returns table (
  bucket_start      date,
  inflow            numeric,
  outflow           numeric,
  net               numeric,
  running_balance   numeric,
  payables_count    integer,
  receivables_count integer,
  overdue_inflow    numeric,
  overdue_outflow   numeric,
  peak_day          date,
  peak_day_outflow  numeric
)
language sql
stable
as $$
with p as (
  -- Teto de 36 meses e piso de 1: o parâmetro vem da barra de endereço, e
  -- `?meses=100000` geraria cem mil linhas sem que ninguém tivesse pedido isso.
  select
    greatest(1, least(coalesce(p_months, 12), 36))                    as months,
    least(greatest(coalesce(p_delinquency_rate, 0), 0), 100) / 100.0  as rate,
    date_trunc('month', current_date)::date                           as first_month
),
baldes as (
  select (p.first_month + make_interval(months => n::int))::date as bucket_start
  from p, generate_series(0, p.months - 1) as n
),
horizonte as (
  select (max(bucket_start) + interval '1 month' - interval '1 day')::date as ate
  from baldes
),
-- Movimentos de conta não excluída. `bank_account_movements` não tem
-- `deleted_at`; a junção é o que impede somar movimento de conta apagada.
movimentos as (
  select m.direction, m.amount, m.moved_on, m.cost_center_id
  from public.bank_account_movements m
  join public.bank_accounts a
    on a.id = m.bank_account_id and a.deleted_at is null
),
saldo_d0 as (
  select
    (select coalesce(sum(opening_balance), 0)
       from public.bank_accounts where deleted_at is null)
  + (select coalesce(sum(case when direction = 'in' then amount else -amount end), 0)
       from movimentos where moved_on <= current_date)
    as valor
),
fluxos as (
  select
    greatest(pa.due_on, current_date) as efetivo,
    0::numeric                        as entrada,
    pa.amount                         as saida,
    (pa.due_on < current_date)        as vencido,
    1                                 as e_pagar,
    0                                 as e_receber
  from public.payables pa
  where pa.deleted_at is null
    and pa.status in ('pending_approval', 'approved', 'scheduled')
    and (p_branch_id is null or pa.branch_id = p_branch_id)
    and (p_cost_center_id is null or pa.cost_center_id = p_cost_center_id)

  union all

  select
    greatest(re.due_on, current_date),
    round(re.amount * (1 - (select rate from p)), 2),
    0::numeric,
    (re.due_on < current_date),
    0, 1
  from public.receivables re
  where re.deleted_at is null
    and re.status = 'open'
    and (p_branch_id is null or re.branch_id = p_branch_id)
    and (p_cost_center_id is null or re.cost_center_id = p_cost_center_id)

  union all

  -- Movimento bancário datado no futuro: já existe, ainda não aconteceu.
  -- Sai da conta quando há filtro de filial porque movimento bancário não tem
  -- filial — atribuí-lo a uma seria inventar o dado.
  select
    mv.moved_on,
    case when mv.direction = 'in'  then mv.amount else 0 end,
    case when mv.direction = 'out' then mv.amount else 0 end,
    false, 0, 0
  from movimentos mv
  where mv.moved_on > current_date
    and p_branch_id is null
    and (p_cost_center_id is null or mv.cost_center_id = p_cost_center_id)
),
por_balde as (
  select
    date_trunc('month', f.efetivo)::date              as bucket_start,
    sum(f.entrada)                                    as inflow,
    sum(f.saida)                                      as outflow,
    coalesce(sum(f.entrada) filter (where f.vencido), 0) as overdue_inflow,
    coalesce(sum(f.saida)   filter (where f.vencido), 0) as overdue_outflow,
    sum(f.e_pagar)                                    as payables_count,
    sum(f.e_receber)                                  as receivables_count
  from fluxos f
  where f.efetivo <= (select ate from horizonte)
  group by 1
),
-- Maior dia de saída DENTRO de cada mês: dá a granularidade de dia sem devolver
-- uma linha por dia. É observação, não alarme — quem lê decide o que fazer com
-- "12/nov concentra 40% do mês".
picos as (
  select
    date_trunc('month', f.efetivo)::date as bucket_start,
    f.efetivo                            as dia,
    sum(f.saida)                         as saida_dia,
    row_number() over (
      partition by date_trunc('month', f.efetivo)
      order by sum(f.saida) desc, f.efetivo
    ) as rn
  from fluxos f
  where f.efetivo <= (select ate from horizonte)
    and f.saida > 0
  group by 1, 2
)
select
  b.bucket_start,
  coalesce(q.inflow, 0),
  coalesce(q.outflow, 0),
  coalesce(q.inflow, 0) - coalesce(q.outflow, 0),
  (select valor from saldo_d0)
    + sum(coalesce(q.inflow, 0) - coalesce(q.outflow, 0))
        over (order by b.bucket_start rows between unbounded preceding and current row),
  coalesce(q.payables_count, 0)::integer,
  coalesce(q.receivables_count, 0)::integer,
  q.overdue_inflow,
  q.overdue_outflow,
  pk.dia,
  coalesce(pk.saida_dia, 0)
from baldes b
left join por_balde q on q.bucket_start = b.bucket_start
left join picos    pk on pk.bucket_start = b.bucket_start and pk.rn = 1
order by b.bucket_start;
$$;

revoke all on function public.cash_flow_projection(integer, numeric, uuid, uuid) from public;
grant execute on function public.cash_flow_projection(integer, numeric, uuid, uuid) to authenticated;

comment on function public.cash_flow_projection(integer, numeric, uuid, uuid) is
  'Projeção mensal de caixa sobre títulos comprometidos. `security invoker`: enxerga o que a sessão enxerga.';

-- -----------------------------------------------------------------------------
-- Chaves novas no catálogo
-- -----------------------------------------------------------------------------
-- Em sincronia com PERMISSION_CATALOG em src/lib/permissions.ts.
--
-- DUAS chaves, e só duas: a tela não escreve nada. Uma chave `configurar` não
-- governaria coisa alguma — o percentual de inadimplência é parâmetro de consulta,
-- não configuração gravada —, e chave que não governa nada é o defeito já
-- corrigido em seis chaves nesta base.
--
-- Ficar DENTRO do módulo `financeiro`, em vez de virar módulo próprio, é o que faz
-- `app.seed_system_access_profiles()` conceder a tela ao Gestor Financeiro
-- automaticamente (regra `c.module = 'financeiro'`) e o `.ver` ao Operador e ao
-- Aprovador (regra `c.action = 'ver'`), sem tocar na função.
--
-- `sort_order` 890-891: continua depois da última chave do módulo
-- (`financeiro.contas_bancarias.transferir`, 880 na 0017), que é a mesma posição
-- que as entradas ocupam no array de `src/lib/permissions.ts`. Manter a ordem do
-- banco igual à ordem do TypeScript evita que a matriz de perfis e o catálogo
-- contem histórias diferentes.
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('financeiro.fluxo_caixa', 'financeiro', 'fluxo_caixa', null,
   'Fluxo de caixa', 'gestor', 890),
  ('financeiro.fluxo_caixa.ver', 'financeiro', 'fluxo_caixa', 'ver',
   'Consultar a projeção', 'gestor', 891)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

-- Perfis de sistema já provisionados não conhecem as chaves novas. A função
-- expressa as concessões como REGRA sobre o catálogo, então rodá-la de novo
-- distribui as chaves novas sem duplicar as antigas.
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
