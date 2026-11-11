-- =============================================================================
-- 0052 — As views da locação passam a respeitar o RLS
-- =============================================================================
-- CORREÇÃO DE ISOLAMENTO ENTRE TENANTS.
--
-- `vw_rental_allocations` (0049) e `vw_rental_consumption` (0050) nasceram sem
-- `security_invoker = true`. No Postgres esse é o padrão, e o padrão é o lado
-- perigoso: sem a opção, a view é executada com os privilégios do DONO. O dono
-- aqui é `postgres`, que tem `bypassrls` — então o RLS das tabelas de base não
-- se aplica, e a view devolve as linhas de todos os tenants para qualquer
-- sessão autenticada.
--
-- ## Como isto foi medido, e não deduzido
--
-- Em uma sessão `authenticated` com o claim de um tenant que **não existe**:
--
--   select count(*) from public.rental_contract_items;   -- 0   (a tabela obedece)
--   select count(*) from public.vw_rental_allocations;   -- 3   (a view não)
--   select count(*) from public.vw_rental_consumption;   -- 2
--
-- Três linhas de outro tenant visíveis para quem não é dele. Não era risco
-- teórico: era o vazamento acontecendo no banco de desenvolvimento.
--
-- ## Por que escapou
--
-- Não escapou da rede — escapou de mim. A asserção que cobra a opção em todas
-- as views de `public` existe desde a seção 1 de `supabase/tests/schema_test.sql`
-- e acusou as três assim que `scripts/validate-migrations.sh` rodou. O defeito
-- foi eu ter emendado duas fases sem rodar a validação de schema entre elas. A
-- lição não é "escrever mais asserções": é rodá-las a cada fase.
--
-- A correção é por migração nova, e não por edição das 0049/0050, porque um
-- banco que já aplicou aquelas migrações nunca mais as reaplica — editar o
-- passado deixaria o vazamento de pé exatamente onde ele já está.
-- =============================================================================

alter view public.vw_rental_allocations set (security_invoker = true);
alter view public.vw_rental_consumption set (security_invoker = true);

comment on view public.vw_rental_allocations is
  'Alocação com contrato, equipamento, modelo e local já resolvidos — a linha que a tela desenha. security_invoker preserva o RLS.';
comment on view public.vw_rental_consumption is
  'Consumo acumulado por alocação: o que o cálculo da fatura lê para apurar o excedente. security_invoker preserva o RLS.';
