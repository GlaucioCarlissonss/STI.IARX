-- =============================================================================
-- 0026 — Remove `vw_telecom_costs`, que virou duplicata
-- =============================================================================
-- Faz parte da Entrega 2 da auditoria (docs/10). É a ÚNICA remoção no banco
-- desta entrega, e tem um critério estreito: a view é um subconjunto estrito de
-- outra que já existe, e nenhuma linha de aplicação a consulta.
--
--   vw_telecom_costs      → filial, operadora, situação, linhas, custo
--   vw_telecom_dashboard  → tudo isso MAIS área, tipo de linha, custo médio,
--                           linhas sem responsável e linhas livres de fidelidade
--
-- A tela de telefonia passou a ler a segunda na migração 0025, e a primeira
-- ficou sem nenhum leitor. Duas views sobre a mesma tabela, uma contida na
-- outra, é a duplicação que a auditoria mandou consolidar.
--
-- POR QUE AS OUTRAS DUAS VIEWS NÃO CONSULTADAS FICAM
-- --------------------------------------------------
-- `vw_payables_summary` (0020) e `vw_internet_dashboard` (0013) também não são
-- lidas por nenhuma tela, e mesmo assim permanecem. O critério não é "tem
-- leitor", é "tem duplicata": nenhuma das duas repete outra view, as duas
-- encodam uma agregação própria, e view não consultada não custa nada em tempo
-- de execução — não entra em bundle e não pesa em consulta que não a usa.
-- Removê-las seria apagar capacidade testada em nome de uma contagem.
-- =============================================================================

begin;

drop view if exists public.vw_telecom_costs;

commit;
