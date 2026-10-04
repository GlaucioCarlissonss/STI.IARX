-- =============================================================================
-- 0027 — Escopo por cliente e cor por empresa
-- =============================================================================
-- Entrega 3 da auditoria (docs/10). Duas colunas, e uma distinção que precisa
-- ficar registrada antes delas.
--
-- O QUE ESTE ESCOPO É, E O QUE ELE NÃO É
-- --------------------------------------
-- **Não é fronteira de segurança.** O isolamento entre empresas-cliente de
-- tenants diferentes continua sendo `tenant_id`, no JWT, aplicado por 162
-- policies de RLS (ADR-002). Nada aqui mexe nisso, e nada aqui deve ser confiado
-- para esse fim.
--
-- **É foco de trabalho.** Quem atende cinco clientes passa o dia inteiro dentro
-- de um deles, e hoje precisa filtrar tela por tela. `focused_client_id` guarda
-- essa escolha por pessoa, e a camada de dados a aplica em toda entidade que
-- tenha relação com cliente.
--
-- Por que NÃO virou policy de RLS: o Gestor de TI atende vários clientes de
-- propósito, e uma policy por cliente esconderia dele o parque que ele administra
-- — transformaria uma preferência de visualização em perda de acesso. Escopo que
-- o próprio usuário escolhe e desfaz não pertence à camada que decide o que ele
-- PODE ver.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. O cliente em foco, por pessoa
-- -----------------------------------------------------------------------------
-- `null` = todos os clientes, que é o padrão e o estado de quem nunca escolheu.
--
-- FK composta `(focused_client_id, tenant_id)`: é o mesmo padrão do ADR-001 em
-- toda a base, e é o que impede uma pessoa de um tenant apontar para o cliente de
-- outro. `on delete set null` porque apagar um cliente não deve travar o login de
-- quem estava com ele em foco.
alter table public.profiles
  add column focused_client_id uuid,
  add constraint fk_profile_focused_client
    foreign key (focused_client_id, tenant_id)
    references public.clients (id, tenant_id) on delete set null;

comment on column public.profiles.focused_client_id is
  'Cliente em foco desta pessoa. NULL = todos. Visualização, não autorização.';

-- -----------------------------------------------------------------------------
-- 2. Cor da empresa
-- -----------------------------------------------------------------------------
-- Pedida para a repaginada: cada empresa-cliente recebe uma cor, e ela identifica
-- o cliente onde quer que ele apareça — seletor, cabeçalho, marcador de mapa.
--
-- Mesmo formato de `ticket_priorities.color` (0004): texto `#rrggbb` com CHECK.
-- Guardar a cor como dado, e não como mapa de nomes no código, é o que permite o
-- cliente novo nascer com identidade sem ninguém editar um arquivo.
--
-- O padrão é o cinza neutro do sistema: cor inventada por omissão daria a dois
-- clientes a mesma cor sem ninguém decidir isso.
alter table public.clients
  add column color text not null default '#64748b'
    constraint clients_color_hex check (color ~ '^#[0-9a-fA-F]{6}$');

comment on column public.clients.color is
  'Cor de identificação da empresa na interface. Dado, não constante de código.';

-- -----------------------------------------------------------------------------
-- 3. A projeção de caixa passa a entender o foco
-- -----------------------------------------------------------------------------
-- Sem isto, o Fluxo de caixa seria a ÚNICA tela financeira a ignorar o foco, e
-- duas telas abertas lado a lado mostrariam totais diferentes para o mesmo
-- período sem explicar por quê. Número que diverge sem explicação é pior que
-- número ausente.
--
-- É `drop` e não `create or replace`: em Postgres a lista de argumentos faz parte
-- da identidade da função, então `create or replace` com um parâmetro a mais
-- criaria uma SEGUNDA função, e a chamada de quatro argumentos passaria a ser
-- ambígua. O `drop` explícito é o que garante que existe uma só.
--
-- O corpo é o da 0021, inalterado. Mudam três predicados, e só eles:
--
--   payables     `branch_id` é nulável — título sem filial é do tenant inteiro e
--                entra em qualquer foco. Omiti-lo encolheria a saída projetada.
--   receivables  tem `client_id` próprio, também nulável, mesma regra.
--   movimentos   lançamento bancário não tem filial NEM cliente. Sob foco ele sai
--                da conta, exatamente como já saía sob filtro de filial:
--                atribuí-lo a um cliente seria inventar o dado.
--
-- Continua `security invoker`: o RLS de `payables` e `receivables` segue valendo,
-- e o foco só ESTREITA o que a sessão já enxergava.
drop function if exists public.cash_flow_projection(integer, numeric, uuid, uuid);

create or replace function public.cash_flow_projection(
  p_months           integer default 12,
  p_delinquency_rate numeric default 0,
  p_branch_id        uuid    default null,
  p_cost_center_id   uuid    default null,
  p_client_id        uuid    default null
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
    and (p_client_id is null or pa.branch_id is null or pa.branch_id in (
          select b.id from public.branches b where b.client_id = p_client_id))
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
    and (p_client_id is null or re.client_id is null or re.client_id = p_client_id)
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
    and p_client_id is null
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

revoke all on function public.cash_flow_projection(integer, numeric, uuid, uuid, uuid) from public;
grant execute on function public.cash_flow_projection(integer, numeric, uuid, uuid, uuid) to authenticated;

comment on function public.cash_flow_projection(integer, numeric, uuid, uuid, uuid) is
  'Projeção mensal de caixa sobre títulos comprometidos. `security invoker`: enxerga o que a sessão enxerga.';

commit;
