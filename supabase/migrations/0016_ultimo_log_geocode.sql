-- =============================================================================
-- 0016 — Último log de geocodificação por filial
--
-- A tela de mapas buscava os 200 logs mais recentes do TENANT inteiro e
-- deduplicava por filial em memória. Com um parque grande (muitas filiais,
-- várias tentativas cada), o log mais recente de uma filial pouco
-- geocodificada cai fora dos 200 e a tela conclui "nunca tentamos" quando na
-- verdade há histórico — só que mais antigo que o corte. Uma view com
-- `distinct on` resolve por construção, sem depender de nenhum limite.
-- =============================================================================

drop view if exists public.vw_branch_last_geocode_log;
create view public.vw_branch_last_geocode_log with (security_invoker = true) as
select distinct on (branch_id)
  tenant_id, branch_id, status, report_text, message, created_at
from public.geocode_logs
order by branch_id, created_at desc;

grant select on public.vw_branch_last_geocode_log to authenticated;
