-- =============================================================================
-- CONFERIR O BANCO DE PRODUÇÃO — somente leitura.
--
-- POR QUE ISTO NÃO É O `schema_test.sql`
-- --------------------------------------
-- Aquele CRIA empresa, usuário, fatura e movimento de estoque para provar que
-- as regras recusam o que devem recusar. É o comportamento certo contra um
-- banco descartável e catastrófico contra um banco com dados de cliente: ele
-- deixaria registros inventados no meio dos reais, e alguns dos cenários dele
-- passam por caminhos que escrevem.
--
-- Este arquivo não escreve NADA. Nenhum `insert`, nenhum `update`, nenhum
-- `create`. Só lê o catálogo do sistema e conta. Roda com segurança na
-- segunda-feira de manhã, com gente usando.
--
-- O QUE ELE PROVA, E POR QUE CADA UMA IMPORTA
-- -------------------------------------------
-- Tudo aqui é invariante de ISOLAMENTO — o que separa uma empresa da outra.
-- Nenhuma destas falhas se manifesta como erro: elas se manifestam como
-- alguém vendo dado alheio, o que ninguém reporta porque ninguém percebe.
--
-- Uso:  psql -v ON_ERROR_STOP=1 -f supabase/tests/conferir-producao.sql
--       (com -v migracoes=64 para conferir o livro-razão)
-- =============================================================================

\set ON_ERROR_STOP on
\timing off

\echo ''
\echo '=== Conferindo o banco (somente leitura) ==='

-- -----------------------------------------------------------------------------
-- 1. Toda tabela de `public` tem RLS LIGADA; toda tabela COM `tenant_id` tem
--    RLS FORÇADA.
--
-- `enable row level security` sozinho não alcança o DONO da tabela: o dono
-- continua enxergando tudo. Em Supabase o dono é `postgres`, e `postgres` é
-- quem roda migração e job. Sem o `force`, um job agendado lê a base inteira
-- achando que o RLS está cuidando disso.
--
-- POR QUE O `force` SÓ É COBRADO DE QUEM TEM `tenant_id`
-- ------------------------------------------------------
-- A primeira versão exigia `force` de TODA tabela, e reprovou duas:
-- `rental_contract_status_transitions` e `rental_equipment_status_transitions`.
-- Medidas, elas não têm `tenant_id` e a policy delas é `using (true)`: são
-- catálogos globais de transição de estado, iguais para todas as empresas.
-- Não há o que isolar, e `force` ali não protegeria nada — protegeria contra
-- o dono escrever, que é exatamente o que a migração que as popula faz.
--
-- Então o portão passou a medir o FATO (isolamento entre empresas) em vez do
-- proxy (`force` em toda tabela, que costuma andar junto com ele). A tabela
-- sem `tenant_id` é conferida pela seção 1b, que exige que ela esteja na lista
-- de catálogos globais declarados — assim uma tabela nova que ESQUEÇA o
-- `tenant_id` não passa por catálogo.
-- -----------------------------------------------------------------------------
do $$
declare
  v_sem_rls   text[];
  v_sem_force text[];
  v_total     int;
begin
  select coalesce(array_agg(c.relname order by c.relname), '{}')
    into v_sem_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

  select coalesce(array_agg(c.relname order by c.relname), '{}')
    into v_sem_force
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and c.relrowsecurity and not c.relforcerowsecurity
     and exists (select 1 from information_schema.columns col
                  where col.table_schema = 'public'
                    and col.table_name = c.relname
                    and col.column_name = 'tenant_id');

  if cardinality(v_sem_rls) > 0 then
    raise exception 'tabela(s) de public SEM RLS: %', array_to_string(v_sem_rls, ', ');
  end if;
  if cardinality(v_sem_force) > 0 then
    raise exception 'tabela(s) COM tenant_id, com RLS e SEM force (o dono escapa o isolamento): %',
      array_to_string(v_sem_force, ', ');
  end if;

  -- Guarda contra vacuidade: se o schema mudar de nome, as duas consultas
  -- acima não acham nada, os arrays ficam vazios e a seção aprova sem ter
  -- lido uma linha. Um portão que não encontra arquivo é indistinguível de um
  -- portão aprovando.
  select count(*) into v_total
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r';
  if v_total < 50 then
    raise exception 'só % tabela(s) em public — o banco está incompleto ou o schema mudou', v_total;
  end if;

  raise notice '  ok  % tabelas em public, RLS ligada e forçada onde há tenant_id', v_total;
end $$;

-- -----------------------------------------------------------------------------
-- 1b. Toda tabela SEM `tenant_id` está na lista de catálogos globais.
--
-- A tabela sem `tenant_id` é, por construção, visível a todas as empresas. Às
-- vezes isso é o certo — o catálogo de permissões, a lista de planos, as
-- transições de estado válidas, a própria tabela de empresas. Às vezes é uma
-- tabela nova em que alguém esqueceu a coluna, e aí TODA empresa passa a ver o
-- dado de TODAS, sem erro nenhum, até alguém reparar.
--
-- A lista existe para que a segunda hipótese não passe por catálogo. Cada nome
-- aqui é uma decisão escrita; acrescentar um sem motivo é a porta por onde o
-- vazamento entra.
-- -----------------------------------------------------------------------------
do $$
declare
  v_novas text[];
  v_catalogos text[] := array[
    'tenants',                              -- a própria lista de empresas
    'permission_catalog',                   -- as chaves do sistema, iguais para todos
    'planos',                               -- o catálogo comercial, lido até sem sessão
    'platform_settings',                    -- configuração da instalação inteira
    'ticket_status_transitions',            -- que estado vai para qual, global
    'rental_contract_status_transitions',   -- idem, contratos
    'rental_equipment_status_transitions',  -- idem, equipamentos
    'business_hours_holidays',              -- feriado nacional não é de uma empresa só
    'business_hours_intervals',             -- a grade de expediente padrão
    'job_expectations',                     -- o que cada trabalho agendado promete
    'job_runs',                             -- execução de job, da instalação
    'job_alert_episodes',                   -- alerta de job parado, da instalação
    'request_throttle'                      -- limite por origem, antes de haver sessão
  ];
begin
  select coalesce(array_agg(c.relname order by c.relname), '{}')
    into v_novas
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and not exists (select 1 from information_schema.columns col
                      where col.table_schema = 'public'
                        and col.table_name = c.relname
                        and col.column_name = 'tenant_id')
     and not (c.relname = any(v_catalogos));

  if cardinality(v_novas) > 0 then
    raise exception
      'tabela(s) SEM tenant_id e fora da lista de catálogos globais: %. '
      'Ou falta a coluna (e toda empresa vê o dado de todas), ou falta '
      'declarar o motivo nesta lista.', array_to_string(v_novas, ', ');
  end if;
  raise notice '  ok  % catálogo(s) global(is) declarado(s), e nenhuma tabela fora da lista',
    cardinality(v_catalogos);
end $$;

-- -----------------------------------------------------------------------------
-- 2. Toda tabela com RLS tem pelo menos UMA policy.
--
-- RLS ligada sem policy nenhuma nega tudo — o que parece seguro e é, na
-- verdade, uma tela que não carrega. A recusa deliberada se escreve
-- `using (false)`, que é uma policy e aparece aqui.
-- -----------------------------------------------------------------------------
do $$
declare v_mudas text[];
begin
  select coalesce(array_agg(c.relname order by c.relname), '{}')
    into v_mudas
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid);

  if cardinality(v_mudas) > 0 then
    raise exception 'tabela(s) com RLS e SEM policy (negam tudo, em silêncio): %',
      array_to_string(v_mudas, ', ');
  end if;
  raise notice '  ok  toda tabela com RLS tem policy';
end $$;

-- -----------------------------------------------------------------------------
-- 3. Toda view de `public` tem `security_invoker = true`.
--
-- Sem isso a view roda com o privilégio de QUEM A CRIOU. O dono é `postgres`,
-- que tem `bypassrls`: a view devolve as linhas de todas as empresas para
-- qualquer um que a consulte. É o vazamento mais silencioso deste schema,
-- porque a view continua funcionando — só que demais.
-- -----------------------------------------------------------------------------
do $$
declare
  v_abertas text[];
  v_total   int;
begin
  select coalesce(array_agg(c.relname order by c.relname), '{}'), count(*)
    into v_abertas, v_total
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
     and coalesce(
           (select option_value from pg_options_to_table(c.reloptions)
             where option_name = 'security_invoker'), 'false') <> 'true';

  if cardinality(v_abertas) > 0 then
    raise exception 'view(s) SEM security_invoker (rodam como postgres, que ignora RLS): %',
      array_to_string(v_abertas, ', ');
  end if;

  select count(*) into v_total
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v';
  if v_total < 1 then
    raise exception 'nenhuma view encontrada em public — o schema mudou de nome?';
  end if;
  raise notice '  ok  % view(s), todas com security_invoker', v_total;
end $$;

-- -----------------------------------------------------------------------------
-- 4. O catálogo de permissões chegou inteiro.
--
-- O piso é 264 — o que o repositório tinha quando esta conferência nasceu — e
-- não a igualdade. Migração nova ACRESCENTA chave, e exigir o número exato
-- faria esta seção ficar vermelha a cada entrega sem nada ter quebrado. O que
-- se quer impedir é o banco com MENOS do que o código espera: aí a tela some
-- do menu de quem deveria vê-la, sem erro nenhum.
-- -----------------------------------------------------------------------------
do $$
declare v_n int;
begin
  select count(*) into v_n from public.permission_catalog;
  if v_n < 264 then
    raise exception 'o catálogo tem % chaves; o código espera ao menos 264 — migração faltando?', v_n;
  end if;
  raise notice '  ok  catálogo de permissões com % chaves', v_n;
end $$;

-- -----------------------------------------------------------------------------
-- 5. O bucket de anexos existe, e NÃO é público.
--
-- Bucket público entrega anexo de chamado — contrato, nota fiscal, print de
-- tela com dado pessoal — a qualquer um com a URL, sem sessão. A 0019 o cria
-- privado; esta linha confere que ninguém o abriu depois pelo painel.
-- -----------------------------------------------------------------------------
do $$
declare v_publico boolean;
begin
  select public into v_publico from storage.buckets where id = 'anexos';
  if v_publico is null then
    raise exception 'o bucket "anexos" não existe — a migração 0019 não rodou';
  end if;
  if v_publico then
    raise exception 'o bucket "anexos" está PÚBLICO: qualquer um com a URL baixa anexo de chamado';
  end if;
  raise notice '  ok  bucket "anexos" existe e é privado';
end $$;

-- -----------------------------------------------------------------------------
-- 6. Nenhum dado de demonstração.
--
-- `seed.sql` é de desenvolvimento e não roda aqui. Mas ele JÁ foi rodado por
-- engano num banco de produção neste tipo de projeto, e o sintoma é cruel: o
-- sistema funciona, com empresas de mentira misturadas às de verdade, e quem
-- percebe primeiro é o cliente.
-- -----------------------------------------------------------------------------
do $$
declare v_n int;
begin
  select count(*) into v_n from public.tenants
   where id::text like 'a0000000-0000-4000-8000-%';
  if v_n > 0 then
    raise exception 'há % empresa(s) da SEMENTE neste banco — o seed de desenvolvimento rodou aqui', v_n;
  end if;
  raise notice '  ok  nenhum dado de demonstração';
end $$;

-- -----------------------------------------------------------------------------
-- 7. O livro-razão das migrações bate com o repositório.
--
-- O número vem de fora (`-v migracoes=N`), contado pelo script que chama: o
-- SQL não tem como listar arquivos, e escrever o número aqui à mão seria o
-- mesmo defeito que `conferir-numeros` existe para pegar.
-- -----------------------------------------------------------------------------
\if :{?migracoes}
-- O número entra por CONFIGURAÇÃO e não por `:migracoes` direto: o psql não
-- substitui variável dentro de `$$ ... $$`, e a primeira versão morreu com
-- "syntax error at or near \":\"" depois de sete seções verdes. Fora do
-- cifrão a substituição funciona, e é por isso que o `select` abaixo existe.
--
-- `set_config(..., false)` é de sessão, e aqui isso é correto: este arquivo é
-- somente leitura, roda na própria conexão e ela morre no fim. O que a
-- doutrina proíbe é `SET` de sessão carregando IDENTIDADE num pool — outra
-- coisa.
select set_config('sti.migracoes_no_disco', :'migracoes', false);
do $$
declare
  v_banco int;
  v_disco int := current_setting('sti.migracoes_no_disco')::int;
begin
  select count(*) into v_banco from app.schema_migrations;
  if v_banco <> v_disco then
    raise exception 'o banco tem % migração(ões) e o repositório tem % — falta rodar migrar.sh?',
      v_banco, v_disco;
  end if;
  raise notice '  ok  % migrações aplicadas, as mesmas do repositório', v_banco;
end $$;
\else
\echo '  --  livro-razão não conferido (passe -v migracoes=N)'
\endif

\echo ''
\echo '################  BANCO CONFERIDO  ################'
