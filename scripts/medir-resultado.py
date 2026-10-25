#!/usr/bin/env python3
"""
Mede o custo da visão de resultado com volume de verdade.

POR QUE ESTE SCRIPT EXISTE
--------------------------
`gestao_resultado()` monta cinco CTEs sobre três views, e `gestao_serie()` faz
doze varreduras das mesmas fontes. O schema_test prova que a aritmética está
certa — com dezenas de linhas. Nada ali diz o que acontece com um cliente de
centenas de projetos e dezenas de milhares de chamados no mês.

E essa é a diferença entre uma tela que abre e uma tela que ninguém usa: o
indicador continua CORRETO enquanto fica lento, então o defeito não aparece em
teste nenhum. Aparece no cliente grande, que é justamente quem mais precisa da
tela.

O que ele faz: cria um cliente de carga no banco de validação, enche de dado,
roda cada função cinco vezes e relata a MEDIANA — a média seria dominada pela
primeira execução, que paga o aquecimento do cache.

Exige o banco de validação de pé:
  npm run db:validate && python3 scripts/medir-resultado.py
"""
import os, re, statistics, subprocess, sys

PSQL = ['psql', '-h', '127.0.0.1', '-p', '5433', '-U', 'postgres',
        '-d', 'sti_iarx_validate', '-v', 'ON_ERROR_STOP=1', '-At', '-c']
ENV = dict(os.environ, PGPASSWORD='postgres')

# O orçamento. Não é um número de catálogo: é o ponto em que uma tela de gestão
# deixa de parecer instantânea para quem a abre numa reunião.
ORCAMENTO_MS = 400.0

TENANT = 'a0000000-0000-4000-8000-000000000001'
CLIENTE = 'cc000000-0000-4000-8000-0000000000ca'

# Volume de um cliente grande de verdade: três anos de orçamento, quatrocentos
# projetos e vinte e cinco mil chamados no mês medido.
BRANCHES, MESES, PROJETOS, CHAMADOS, FILAS = 20, 36, 400, 25_000, 12


def sql(texto: str) -> str:
    r = subprocess.run(PSQL + [texto], capture_output=True, text=True, env=ENV)
    if r.returncode != 0:
        print(r.stderr.strip(), file=sys.stderr)
        sys.exit(1)
    return r.stdout.strip()


CARGA = f"""
do $$
declare
  v_t   uuid := '{TENANT}';
  v_c   uuid := '{CLIENTE}';
  v_cen uuid;
  v_sim uuid;
  v_cat uuid;
  v_prio uuid;
  v_dono uuid := '22220000-0000-4000-8000-000000000001';
  v_comp date := date_trunc('month', now())::date;
begin
  /* Na ordem, e não `delete from clients` direto: a FK de `tickets` para
     cliente é `on delete set null`, e `tenant_id` é NOT NULL — apagar o cliente
     primeiro tenta zerar as duas colunas e falha. */
  delete from public.tickets       where client_id = v_c;
  delete from public.projects      where client_id = v_c;
  delete from public.it_cost_entries where client_id = v_c;
  delete from public.clients       where id = v_c;
  delete from public.queues where tenant_id = v_t and slug like 'carga-%';

  insert into public.clients (id, tenant_id, legal_name, trade_name)
  values (v_c, v_t, 'Carga Pesada S.A.', 'Carga');

  select id into v_cen from public.it_budget_scenarios where client_id = v_c and key = 'oficial';
  insert into public.it_budget_scenarios (tenant_id, client_id, key, name)
  values (v_t, v_c, 'simulacao', 'Simulação') returning id into v_sim;

  select id into v_cat from public.expense_categories where tenant_id = v_t and is_active limit 1;
  select id into v_prio from public.ticket_priorities where tenant_id = v_t order by sort_order limit 1;

  insert into public.branches (tenant_id, client_id, name)
  select v_t, v_c, 'Filial ' || i from generate_series(1, {BRANCHES}) i;

  insert into public.queues (tenant_id, name, slug)
  select v_t, 'Fila de carga ' || i, 'carga-' || i from generate_series(1, {FILAS}) i
  on conflict (tenant_id, slug) do nothing;

  -- Orçamento: 36 meses x 20 filiais, no oficial e no cenário de simulação.
  -- A simulação entra de propósito: ela dobra o volume que o filtro por cenário
  -- tem de descartar, que é parte do custo que se quer medir.
  insert into public.it_cost_entries
    (tenant_id, client_id, branch_id, expense_category_id, scenario_id, competence,
     amount, natureza, classificacao)
  select v_t, v_c, b.id, v_cat, cen.id,
         (v_comp - make_interval(months => m))::date,
         100 + (m * 7 % 900), 'pontual_unica',
         case when m % 3 = 0 then 'investimento' else 'despesa' end
  from public.branches b
  cross join generate_series(0, {MESES} - 1) m
  cross join (select v_cen as id union all select v_sim) cen
  where b.client_id = v_c;

  insert into public.projects
    (tenant_id, client_id, branch_id, name, start_month, planned_end_month,
     actual_end_month, status)
  select v_t, v_c,
         (select id from public.branches b where b.client_id = v_c offset (i % {BRANCHES}) limit 1),
         'Projeto de carga ' || i,
         (v_comp - make_interval(months => 12 + (i % 12)))::date,
         (v_comp - make_interval(months => (i % 12)))::date,
         case when i % 3 = 0 then (v_comp - make_interval(months => (i % 6)))::date else null end,
         case when i % 3 = 0 then 'concluido' else 'em_andamento' end
  from generate_series(1, {PROJETOS}) i;

  insert into public.tickets
    (tenant_id, client_id, title, priority_id, queue_id, requester_id, created_at)
  select v_t, v_c, 'Chamado de carga ' || i, v_prio,
         (select id from public.queues q
           where q.tenant_id = v_t and q.slug = 'carga-' || (1 + i % {FILAS})),
         v_dono,
         v_comp + make_interval(days => i % 27)
  from generate_series(1, {CHAMADOS}) i;

  update public.sla_tracking st
     set coverage = case when t.ticket_number % 10 = 0 then 'uncovered' else 'covered' end,
         resolution_breached = (t.ticket_number % 7 = 0)
    from public.tickets t
   where t.id = st.ticket_id and t.client_id = v_c;
end
$$;
"""

ALVOS = [
    ('gestao_resultado',
     f"select * from public.gestao_resultado('{CLIENTE}', date_trunc('month', now())::date)"),
    ('gestao_gasto_por_filial',
     f"select * from public.gestao_gasto_por_filial('{CLIENTE}', date_trunc('month', now())::date)"),
    ('gestao_serie (12 meses)',
     f"select * from public.gestao_serie('{CLIENTE}', date_trunc('month', now())::date, 12)"),
    ('gestao_serie (36 meses, o teto)',
     f"select * from public.gestao_serie('{CLIENTE}', date_trunc('month', now())::date, 36)"),
]

TEMPO = re.compile(r'Execution Time: ([0-9.]+) ms')


def medir(consulta: str, vezes: int = 5) -> float:
    tempos = []
    for _ in range(vezes):
        saida = sql('explain (analyze, timing off, summary on) ' + consulta)
        achado = TEMPO.search(saida)
        if not achado:
            print('não consegui ler o tempo de execução:\n' + saida, file=sys.stderr)
            sys.exit(1)
        tempos.append(float(achado.group(1)))
    return statistics.median(tempos)


print('==> Montando a carga (isto demora: são 25 mil chamados com trigger de SLA)')
sql(CARGA)

volume = sql(f"""
  select
    (select count(*) from public.it_cost_entries where client_id = '{CLIENTE}'),
    (select count(*) from public.projects where client_id = '{CLIENTE}'),
    (select count(*) from public.tickets where client_id = '{CLIENTE}')
""").replace('|', ' lançamentos · ')
print(f'    {volume.split("|")[0] if "|" in volume else volume}')

print(f'\n==> Mediana de 5 execuções, orçamento de {ORCAMENTO_MS:.0f} ms\n')
estourou = 0
for nome, consulta in ALVOS:
    ms = medir(consulta)
    marca = 'ok    ' if ms <= ORCAMENTO_MS else 'LENTO '
    if ms > ORCAMENTO_MS:
        estourou += 1
    print(f'  {marca} {nome:<34} {ms:8.1f} ms')

print()
if estourou:
    print(f'{estourou} função(ões) acima do orçamento de {ORCAMENTO_MS:.0f} ms.')
    sys.exit(1)
print('A visão de resultado responde dentro do orçamento com volume de cliente grande.')
