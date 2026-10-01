-- =============================================================================
-- 0025 — As filas ganham cadastro próprio
-- =============================================================================
-- Sem DDL: `public.queues` existe desde a 0004, com a trigger
-- `trg_protect_default_queue` defendendo a fila padrão contra renome, desativação
-- e remoção. O que faltava eram as chaves — as filas eram semeadas e só mudavam
-- por SQL.
--
-- A trigger é o motivo de esta migração não precisar de nenhuma regra nova: a
-- proteção da fila padrão já mora no banco, "para que nenhuma rota
-- administrativa consiga burlar" (comentário da 0004). A tela só precisa traduzir
-- o erro dela para o português.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Chaves novas no catálogo
-- -----------------------------------------------------------------------------
-- Em sincronia com PERMISSION_CATALOG em src/lib/permissions.ts.
--
-- `sort_order` 131-133: entre `helpdesk.filas.ver` (130) e
-- `helpdesk.filas.configurar_regras` (135, da 0024). Ficam ANTES do roteamento
-- na matriz porque é essa a ordem de quem configura: primeiro existe a fila,
-- depois se decide o que cai nela.
--
-- Teto `gestor` nas três. Criar fila muda a estrutura de atendimento do cliente,
-- e o Operador de TI — papel efetivo `atendente` — fica de fora pelo mesmo
-- mecanismo que já o mantém fora de `configurar_regras`.
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('helpdesk.filas.criar', 'helpdesk', 'filas', 'criar',
   'Criar fila', 'gestor', 131),
  ('helpdesk.filas.editar', 'helpdesk', 'filas', 'editar',
   'Editar fila e pesos do score', 'gestor', 132),
  ('helpdesk.filas.inativar', 'helpdesk', 'filas', 'inativar',
   'Ativar/inativar fila', 'gestor', 133)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

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
