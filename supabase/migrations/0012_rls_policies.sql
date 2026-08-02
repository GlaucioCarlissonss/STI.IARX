-- =============================================================================
-- 0012 — Policies de RLS (ADR-002, ADR-003)
-- =============================================================================
-- Todas as policies concentradas em um arquivo: o modelo de segurança inteiro
-- pode ser lido de uma vez, e a cobertura é verificável (ver supabase/tests).
--
-- Camadas, sempre nesta ordem:
--   1. tenant_id = app.current_tenant_id()        → isolamento entre assinantes
--   2. escopo de filial ou de autoria             → visibilidade dentro do tenant
--   3. papel                                      → o que pode escrever
--
-- `service_role` (Edge Functions, rota de TV) tem BYPASSRLS e não passa por aqui;
-- nesses dois pontos o isolamento é responsabilidade explícita do código.
-- =============================================================================

-- Privilégios de tabela. RLS filtra LINHAS, mas o GRANT ainda é necessário para
-- que o papel `authenticated` possa sequer tocar na tabela.
grant usage on schema public to anon, authenticated;
grant usage on schema app to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Helper: quem pode administrar cadastros do tenant
-- -----------------------------------------------------------------------------
create or replace function app.can_manage_config()
returns boolean
language sql
stable
as $$
  select coalesce(app.current_role() in ('super_admin','admin'), false);
$$;

create or replace function app.can_manage_records()
returns boolean
language sql
stable
as $$
  select coalesce(app.current_role() in ('super_admin','admin','gestor'), false);
$$;

-- Papéis que operam tickets (todos menos o solicitante puro).
create or replace function app.can_work_tickets()
returns boolean
language sql
stable
as $$
  select coalesce(app.current_role() in ('super_admin','admin','gestor','atendente'), false);
$$;

-- =============================================================================
-- tenants — cada um enxerga apenas o próprio
-- =============================================================================
create policy tenants_select on public.tenants
  for select to authenticated
  using (id = app.current_tenant_id() or app.is_super_admin());

create policy tenants_update on public.tenants
  for update to authenticated
  using (id = app.current_tenant_id() and app.can_manage_config())
  with check (id = app.current_tenant_id());

grant select, update on public.tenants to authenticated;

-- =============================================================================
-- profiles
-- =============================================================================
-- Todo membro do tenant enxerga os colegas (necessário para atribuir tickets,
-- mencionar pessoas e exibir nomes); apenas admin gerencia.
create policy profiles_select on public.profiles
  for select to authenticated
  using (tenant_id = app.current_tenant_id() or id = app.current_user_id() or app.is_super_admin());

create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.can_manage_config());

-- O próprio usuário edita seu perfil; admin edita qualquer um. A policy NÃO
-- impede troca de `role` por conta própria — isso é barrado pela trigger abaixo,
-- porque WITH CHECK não consegue comparar com o valor anterior.
create policy profiles_update on public.profiles
  for update to authenticated
  using (
    (tenant_id = app.current_tenant_id() and app.can_manage_config())
    or id = app.current_user_id()
  )
  with check (
    (tenant_id = app.current_tenant_id() and app.can_manage_config())
    or id = app.current_user_id()
  );

create policy profiles_delete on public.profiles
  for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_config());

-- Escalonamento de privilégio: sem isto, um `solicitante` poderia se promover a
-- `admin` com um simples update no próprio perfil, que a policy acima permite.
create or replace function app.prevent_self_privilege_escalation()
returns trigger
language plpgsql
as $$
begin
  if app.is_service_role() or app.current_user_id() is null then
    return new;                                  -- provisionamento pelo backend
  end if;

  if (new.role is distinct from old.role or new.tenant_id is distinct from old.tenant_id)
     and not app.can_manage_config() then
    raise exception 'Apenas administradores podem alterar papel ou tenant de um usuário'
      using errcode = 'insufficient_privilege';
  end if;

  -- Nem mesmo um admin se auto-promove a super_admin (papel da operação do SaaS).
  if new.role = 'super_admin' and old.role <> 'super_admin' and not app.is_super_admin() then
    raise exception 'Papel super_admin só pode ser concedido pela operação da plataforma'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger trg_profiles_no_escalation
  before update on public.profiles
  for each row execute function app.prevent_self_privilege_escalation();

grant select, insert, update, delete on public.profiles to authenticated;

-- =============================================================================
-- Cadastros administrados por admin/gestor, legíveis por todo o tenant
-- =============================================================================
-- Gerado em laço: são ~15 tabelas com exatamente a mesma forma de policy, e
-- escrevê-las à mão seria 15 chances de divergir uma delas.
do $$
declare
  t text;
  -- Só entram aqui tabelas que possuem coluna `tenant_id` própria.
  -- business_hours_intervals/holidays ficam de fora: pendem do calendário pai
  -- e recebem policy própria logo abaixo.
  read_write_tables text[] := array[
    'clients','branches','user_branches','business_hours',
    'ticket_priorities','ticket_categories','queues',
    'queue_members','queue_rules','sla_contracts','sla_definitions','suppliers',
    'supplier_contracts','dashboard_layouts','dashboard_tokens','integrations',
    'integration_mappings'
  ];
begin
  foreach t in array read_write_tables loop
    execute format($f$
      create policy %1$s_select on public.%1$s
        for select to authenticated
        using (tenant_id = app.current_tenant_id());
    $f$, t);

    execute format($f$
      create policy %1$s_insert on public.%1$s
        for insert to authenticated
        with check (tenant_id = app.current_tenant_id() and app.can_manage_records());
    $f$, t);

    execute format($f$
      create policy %1$s_update on public.%1$s
        for update to authenticated
        using (tenant_id = app.current_tenant_id() and app.can_manage_records())
        with check (tenant_id = app.current_tenant_id());
    $f$, t);

    execute format($f$
      create policy %1$s_delete on public.%1$s
        for delete to authenticated
        using (tenant_id = app.current_tenant_id() and app.can_manage_records());
    $f$, t);

    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end
$$;

-- Janelas e feriados não carregam tenant_id: o vínculo é pelo calendário pai.
grant select, insert, update, delete
  on public.business_hours_intervals, public.business_hours_holidays to authenticated;

create policy bhi_all on public.business_hours_intervals
  for all to authenticated
  using (exists (select 1 from public.business_hours bh
                 where bh.id = business_hours_id and bh.tenant_id = app.current_tenant_id()))
  with check (exists (select 1 from public.business_hours bh
                 where bh.id = business_hours_id and bh.tenant_id = app.current_tenant_id())
              and app.can_manage_records());

create policy bhh_all on public.business_hours_holidays
  for all to authenticated
  using (exists (select 1 from public.business_hours bh
                 where bh.id = business_hours_id and bh.tenant_id = app.current_tenant_id()))
  with check (exists (select 1 from public.business_hours bh
                 where bh.id = business_hours_id and bh.tenant_id = app.current_tenant_id())
              and app.can_manage_records());

-- =============================================================================
-- tickets — tenant + filial + autoria (ADR-003)
-- =============================================================================
create policy tickets_select on public.tickets
  for select to authenticated
  using (
    tenant_id = app.current_tenant_id()
    and (
         app.has_tenant_wide_access()                       -- admin, gestor
      or requester_id = app.current_user_id()               -- o que eu abri
      or (app.current_role() in ('atendente','visualizador') -- minhas filiais
          and branch_id = any (app.current_user_branch_ids()))
    )
  );

-- Qualquer membro do tenant abre ticket. Um solicitante não pode abrir "em nome
-- de" outra pessoa nem fora das suas filiais.
create policy tickets_insert on public.tickets
  for insert to authenticated
  with check (
    tenant_id = app.current_tenant_id()
    and (
         app.can_work_tickets()
      or (requester_id = app.current_user_id()
          and (branch_id is null or branch_id = any (app.current_user_branch_ids())))
    )
  );

create policy tickets_update on public.tickets
  for update to authenticated
  using (
    tenant_id = app.current_tenant_id()
    and app.can_work_tickets()
    and (app.has_tenant_wide_access() or branch_id = any (app.current_user_branch_ids()))
  )
  with check (tenant_id = app.current_tenant_id());

-- Sem DELETE: tickets usam soft delete (antipattern A-09). Só admin, e ainda
-- assim a rota da aplicação grava deleted_at em vez de remover.
create policy tickets_delete on public.tickets
  for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_config());

grant select, insert, update, delete on public.tickets to authenticated;

-- -----------------------------------------------------------------------------
-- Tabelas satélite do ticket: herdam a visibilidade do ticket pai
-- -----------------------------------------------------------------------------
create policy ticket_history_select on public.ticket_history
  for select to authenticated
  using (exists (select 1 from public.tickets t where t.id = ticket_id));

grant select on public.ticket_history to authenticated;

-- Comentário interno é invisível ao solicitante — é o ponto em que o produto
-- mais facilmente vaza informação para o cliente final.
create policy ticket_comments_select on public.ticket_comments
  for select to authenticated
  using (
    exists (select 1 from public.tickets t where t.id = ticket_id)
    and (visibility = 'public' or app.can_work_tickets())
  );

create policy ticket_comments_insert on public.ticket_comments
  for insert to authenticated
  with check (
    tenant_id = app.current_tenant_id()
    and exists (select 1 from public.tickets t where t.id = ticket_id)
    and (visibility = 'public' or app.can_work_tickets())
  );

create policy ticket_comments_update on public.ticket_comments
  for update to authenticated
  using (tenant_id = app.current_tenant_id() and author_id = app.current_user_id())
  with check (tenant_id = app.current_tenant_id());

grant select, insert, update on public.ticket_comments to authenticated;

create policy ticket_attachments_all on public.ticket_attachments
  for all to authenticated
  using (exists (select 1 from public.tickets t where t.id = ticket_id))
  with check (tenant_id = app.current_tenant_id()
              and exists (select 1 from public.tickets t where t.id = ticket_id));

grant select, insert, delete on public.ticket_attachments to authenticated;

create policy ticket_assets_all on public.ticket_assets
  for all to authenticated
  using (exists (select 1 from public.tickets t where t.id = ticket_id))
  with check (tenant_id = app.current_tenant_id() and app.can_work_tickets());

create policy ticket_lines_all on public.ticket_telecom_lines
  for all to authenticated
  using (exists (select 1 from public.tickets t where t.id = ticket_id))
  with check (tenant_id = app.current_tenant_id() and app.can_work_tickets());

grant select, insert, delete on public.ticket_assets, public.ticket_telecom_lines to authenticated;

-- Transições de status: catálogo global, leitura livre para autenticados.
create policy ticket_status_transitions_select on public.ticket_status_transitions
  for select to authenticated using (true);
grant select on public.ticket_status_transitions to authenticated;

-- =============================================================================
-- SLA — leitura acompanha o ticket; escrita é da trigger (service/definer)
-- =============================================================================
create policy sla_tracking_select on public.sla_tracking
  for select to authenticated
  using (exists (select 1 from public.tickets t where t.id = ticket_id));

create policy sla_pauses_select on public.sla_pauses
  for select to authenticated
  using (exists (select 1 from public.tickets t where t.id = ticket_id));

grant select on public.sla_tracking, public.sla_pauses to authenticated;

-- =============================================================================
-- Inventário — mesmo escopo de filial dos tickets (RF-USR-02)
-- =============================================================================
create policy it_assets_select on public.it_assets
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_see_branch(branch_id));

create policy it_assets_write on public.it_assets
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_records())
  with check (tenant_id = app.current_tenant_id() and app.can_manage_records());

create policy telecom_lines_select on public.telecom_lines
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_see_branch(branch_id));

create policy telecom_lines_write on public.telecom_lines
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_records())
  with check (tenant_id = app.current_tenant_id() and app.can_manage_records());

create policy asset_assignments_select on public.asset_assignments
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_see_branch(branch_id));

create policy asset_assignments_write on public.asset_assignments
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_records())
  with check (tenant_id = app.current_tenant_id() and app.can_manage_records());

grant select, insert, update, delete
  on public.it_assets, public.telecom_lines, public.asset_assignments to authenticated;

-- =============================================================================
-- Integrações — operação sensível: apenas admin
-- =============================================================================
-- integrations/integration_mappings já receberam policies no laço acima
-- (admin/gestor). Eventos e logs são somente leitura pela UI: quem escreve é a
-- Edge Function via service_role.
create policy integration_events_select on public.integration_events
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_records());

create policy integration_logs_select on public.integration_logs
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_records());

create policy integration_sync_state_select on public.integration_sync_state
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_records());

grant select on public.integration_events, public.integration_logs,
                public.integration_sync_state to authenticated;

-- =============================================================================
-- Auditoria — leitura restrita; ninguém escreve pela API (só a trigger)
-- =============================================================================
create policy audit_log_select on public.audit_log
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_records());

grant select on public.audit_log to authenticated;

-- Views herdam RLS das tabelas base via security_invoker (ver 0011).
grant select on public.vw_tickets_enriched, public.vw_dashboard_metrics,
                public.vw_agents_online, public.vw_sla_compliance,
                public.vw_telecom_costs to authenticated;

-- Sequências usadas por colunas identity/serial.
grant usage on all sequences in schema public to authenticated;
