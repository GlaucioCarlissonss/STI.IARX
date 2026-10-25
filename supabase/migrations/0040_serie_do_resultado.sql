-- =============================================================================
-- 0040 — A série do resultado: os três indicadores ao longo do tempo
-- =============================================================================
-- A 0039 responde "como estamos neste mês". Esta responde "estamos melhorando?"
-- — e é a pergunta que o gestor leva para a reunião, porque um número isolado
-- não diz se o mês foi bom: diz só que ele foi.
--
-- POR QUE UMA SÉRIE DOS TRÊS, E NÃO A SÉRIE DE CUSTO QUE JÁ EXISTE
-- -----------------------------------------------------------------
-- A tela de orçamento já traça o custo mês a mês. Repetir aquela linha aqui
-- seria enfeite — e foi escrito em docs/21 que seria.
--
-- O que não existe em lugar nenhum é o custo **ao lado** da conformidade e do
-- atraso, no mesmo eixo de tempo. É a leitura que o painel executivo do GSTI
-- entrega e que nenhuma tela deste repositório entregava: o mês em que o custo
-- subiu é o mesmo em que a conformidade caiu? O corte de custo de junho aparece
-- como atraso em agosto?
--
-- A série não RESPONDE essas perguntas — correlação não é causa, e três pontos
-- coincidentes não provam nada. Ela faz a pergunta ser possível, que é o que um
-- painel de gestão deve fazer.
--
-- O QUE ELA NÃO FAZ: INVENTAR O FUTURO
-- -------------------------------------
-- A série termina no mês corrente, mesmo quando a competência escolhida é
-- posterior. Um mês que ainda não aconteceu não tem conformidade nem atraso, e
-- desenhar a barra de custo de um mês futuro ao lado das realizadas diria que
-- ele já foi gasto. O que já está lançado para a frente é o indicador
-- "Compromisso — 12 meses", que é outra pergunta e tem outro nome.
--
-- O ÚLTIMO PONTO É O INDICADOR
-- -----------------------------
-- O ponto mais recente do gráfico tem de ser exatamente o número do cartão
-- acima dele. Um gráfico que discorda do indicador na mesma tela é o mesmo
-- defeito que a conferência da 0039 existe para pegar, só que desenhado — e
-- desenhado é pior, porque ninguém confere um pixel.
--
-- É por isso que o atraso do mês corrente vem de `vw_projects.atrasado`, a
-- mesma coluna que o indicador usa, e não do predicado histórico. Os dois
-- coincidem em todo caso real; divergem num único caso de digitação (entrega
-- registrada num mês futuro), e o schema_test prova a igualdade.
-- =============================================================================

begin;

create or replace function public.gestao_serie(
  p_client_id uuid,
  p_competence date,
  p_meses integer default 12
)
returns table (
  competencia date,
  gasto numeric,
  conformidade numeric,
  com_acordo integer,
  projetos_atrasados integer
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with limites as (
    select
      /* A série nunca passa do mês corrente: ver o cabeçalho. */
      least(p_competence, date_trunc('month', now())::date) as fim,
      /* Teto de 36 meses. Sem ele, `?meses=100000` na URL vira uma varredura
         de oito mil anos de `generate_series` — não é ataque, é alguém
         curioso, e o efeito é o mesmo. */
      least(greatest(coalesce(p_meses, 12), 1), 36) as n
  ),
  meses as (
    select generate_series(
             (l.fim - make_interval(months => l.n - 1))::date,
             l.fim,
             interval '1 month'
           )::date as m
    from limites l
  ),
  /*
   * Cada fonte é varrida UMA vez, agrupada por mês, e depois casada com a lista
   * de meses. A forma óbvia — uma subconsulta correlacionada por mês — custou
   * 1.250 ms com vinte e cinco mil chamados, porque reagrupava a base inteira
   * doze vezes. Era correta e inutilizável, que é como um defeito de
   * desempenho sempre se apresenta: o número certo, tarde demais.
   *
   * O recorte aqui é só o cliente, sem filtro de mês. É de propósito: `period`
   * é uma expressão agrupada (`date_trunc` sobre `created_at`), e um filtro
   * sobre ela não desce até a varredura dos chamados — ficaria pago o mesmo
   * trabalho, com a aparência de estar limitado.
   */
  gasto_por_mes as (
    select b.competence as m, sum(b.total) as total
    from public.vw_it_budget_monthly b
    where b.client_id = p_client_id
      and b.scenario_key = 'oficial'
    group by b.competence
  ),
  sla_por_mes as (
    select
      date_trunc('month', s.period)::date  as m,
      sum(s.tickets_with_sla)              as com_acordo,
      sum(s.resolution_breaches)           as fora
    from public.vw_sla_compliance s
    where s.client_id = p_client_id
    group by 1
  ),
  atraso_por_mes as (
    select m.m, count(*)::integer as atrasados
    from meses m
    join public.vw_projects p on p.client_id = p_client_id
    where case
            /* O mês corrente usa a MESMA coluna do indicador. Ver o cabeçalho. */
            when m.m = date_trunc('month', now())::date then p.atrasado
            /* Nos meses anteriores, "em atraso naquele mês": já tinha passado
               do previsto e ainda não havia sido entregue. Um projeto entregue
               em setembro esteve atrasado em julho e agosto — e é justamente
               essa história que a série mostra e o indicador de hoje não tem
               como contar. */
            else p.status not in ('cancelado', 'cancelada')
                 and p.planned_end_month < m.m
                 and (p.actual_end_month is null or p.actual_end_month > m.m)
          end
    group by m.m
  )
  select
    m.m,
    coalesce(g.total, 0) as gasto,
    /* Nulo, e não 100, quando não houve chamado com acordo no mês: é o mesmo
       contrato da 0039, e no gráfico ele vira buraco na linha. Um buraco ligado
       por uma reta ao ponto seguinte seria lido como "ficou constante", que é o
       contrário de "não houve medida". */
    case when coalesce(s.com_acordo, 0) > 0
         then round(((s.com_acordo - s.fora)::numeric / s.com_acordo) * 100, 1)
         else null end as conformidade,
    coalesce(s.com_acordo, 0)::integer as com_acordo,
    coalesce(a.atrasados, 0)           as projetos_atrasados
  from meses m
  left join gasto_por_mes  g on g.m = m.m
  left join sla_por_mes    s on s.m = m.m
  left join atraso_por_mes a on a.m = m.m
  order by m.m;
$$;

grant execute on function public.gestao_serie(uuid, date, integer) to authenticated;

comment on function public.gestao_serie(uuid, date, integer) is
  'Custo, conformidade e atraso no mesmo eixo de tempo. Termina no mês corrente, e o último ponto é igual ao indicador.';

commit;
