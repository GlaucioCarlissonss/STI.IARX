-- =============================================================================
-- 04 — RLS E POLICIES  (278 policies)
--
-- GERADO — não edite este arquivo.
--
-- Ele é lido do catálogo do PostgreSQL por
-- `scripts/gerar-artefatos-do-banco.py`, a partir de um banco feito só das
-- migrações. A fonte da verdade continua sendo `supabase/migrations/`; isto
-- aqui é o retrato consolidado do que elas produzem, para quem precisa LER o
-- schema inteiro de uma vez em vez de atravessar 64 arquivos.
--
-- Para mudar o schema: migração nova. Para atualizar este arquivo: rode o
-- gerador. `npm test` fica vermelho quando os dois divergem.
-- =============================================================================

-- O ISOLAMENTO ENTRE EMPRESAS MORA AQUI, e em nenhum outro lugar.
--
-- `enable row level security` sozinho não alcança o DONO da tabela — e o
-- dono é quem roda migração e trabalho agendado. O `force` é o que fecha
-- isso, e é por ele que a conferência de produção cobra em toda tabela que
-- tem `tenant_id`.
--
-- Tabela com RLS e SEM policy nega tudo, em silêncio: a tela não carrega e
-- não há erro. A recusa deliberada se escreve `using (false)`, que é uma
-- policy e aparece nesta lista.

alter table public.access_profiles enable row level security;
alter table public.access_profiles force row level security;
alter table public.agent_alerts enable row level security;
alter table public.agent_alerts force row level security;
alter table public.agent_devices enable row level security;
alter table public.agent_devices force row level security;
alter table public.agent_enrollments enable row level security;
alter table public.agent_enrollments force row level security;
alter table public.agent_inventory_snapshots enable row level security;
alter table public.agent_inventory_snapshots force row level security;
alter table public.agent_metrics_hourly enable row level security;
alter table public.agent_metrics_hourly force row level security;
alter table public.agent_metrics_raw enable row level security;
alter table public.agent_metrics_raw force row level security;
alter table public.agent_software enable row level security;
alter table public.agent_software force row level security;
alter table public.agent_volume_samples enable row level security;
alter table public.agent_volume_samples force row level security;
alter table public.ai_settings enable row level security;
alter table public.ai_settings force row level security;
alter table public.ai_suggestions enable row level security;
alter table public.ai_suggestions force row level security;
alter table public.approval_rules enable row level security;
alter table public.approval_rules force row level security;
alter table public.asset_assignments enable row level security;
alter table public.asset_assignments force row level security;
alter table public.asset_attachments enable row level security;
alter table public.asset_attachments force row level security;
alter table public.audit_log enable row level security;
alter table public.audit_log force row level security;
alter table public.auth_tokens enable row level security;
alter table public.auth_tokens force row level security;
alter table public.bank_account_movements enable row level security;
alter table public.bank_account_movements force row level security;
alter table public.bank_accounts enable row level security;
alter table public.bank_accounts force row level security;
alter table public.branch_areas enable row level security;
alter table public.branch_areas force row level security;
alter table public.branches enable row level security;
alter table public.branches force row level security;
alter table public.business_hours enable row level security;
alter table public.business_hours force row level security;
alter table public.business_hours_holidays enable row level security;
alter table public.business_hours_holidays force row level security;
alter table public.business_hours_intervals enable row level security;
alter table public.business_hours_intervals force row level security;
alter table public.channel_contacts enable row level security;
alter table public.channel_contacts force row level security;
alter table public.channel_conversations enable row level security;
alter table public.channel_conversations force row level security;
alter table public.channel_messages enable row level security;
alter table public.channel_messages force row level security;
alter table public.channels enable row level security;
alter table public.channels force row level security;
alter table public.clients enable row level security;
alter table public.clients force row level security;
alter table public.cost_centers enable row level security;
alter table public.cost_centers force row level security;
alter table public.dashboard_layouts enable row level security;
alter table public.dashboard_layouts force row level security;
alter table public.dashboard_tokens enable row level security;
alter table public.dashboard_tokens force row level security;
alter table public.email_outbox enable row level security;
alter table public.email_outbox force row level security;
alter table public.equipment_categories enable row level security;
alter table public.equipment_categories force row level security;
alter table public.equipment_manufacturers enable row level security;
alter table public.equipment_manufacturers force row level security;
alter table public.equipment_models enable row level security;
alter table public.equipment_models force row level security;
alter table public.expense_categories enable row level security;
alter table public.expense_categories force row level security;
alter table public.geocode_candidates enable row level security;
alter table public.geocode_candidates force row level security;
alter table public.geocode_logs enable row level security;
alter table public.geocode_logs force row level security;
alter table public.import_batches enable row level security;
alter table public.import_batches force row level security;
alter table public.import_rows enable row level security;
alter table public.import_rows force row level security;
alter table public.integration_events enable row level security;
alter table public.integration_events force row level security;
alter table public.integration_logs enable row level security;
alter table public.integration_logs force row level security;
alter table public.integration_mapping_versions enable row level security;
alter table public.integration_mapping_versions force row level security;
alter table public.integration_mappings enable row level security;
alter table public.integration_mappings force row level security;
alter table public.integration_sync_state enable row level security;
alter table public.integration_sync_state force row level security;
alter table public.integrations enable row level security;
alter table public.integrations force row level security;
alter table public.internet_link_attachments enable row level security;
alter table public.internet_link_attachments force row level security;
alter table public.internet_links enable row level security;
alter table public.internet_links force row level security;
alter table public.inventory_count_items enable row level security;
alter table public.inventory_count_items force row level security;
alter table public.inventory_counts enable row level security;
alter table public.inventory_counts force row level security;
alter table public.invites enable row level security;
alter table public.invites force row level security;
alter table public.it_assets enable row level security;
alter table public.it_assets force row level security;
alter table public.it_budget_closings enable row level security;
alter table public.it_budget_closings force row level security;
alter table public.it_budget_scenarios enable row level security;
alter table public.it_budget_scenarios force row level security;
alter table public.it_budget_targets enable row level security;
alter table public.it_budget_targets force row level security;
alter table public.it_cost_beneficiaries enable row level security;
alter table public.it_cost_beneficiaries force row level security;
alter table public.it_cost_entries enable row level security;
alter table public.it_cost_entries force row level security;
alter table public.job_alert_episodes enable row level security;
alter table public.job_alert_episodes force row level security;
alter table public.job_expectations enable row level security;
alter table public.job_expectations force row level security;
alter table public.job_runs enable row level security;
alter table public.job_runs force row level security;
alter table public.kb_articles enable row level security;
alter table public.kb_articles force row level security;
alter table public.kb_feedback enable row level security;
alter table public.kb_feedback force row level security;
alter table public.link_availability_events enable row level security;
alter table public.link_availability_events force row level security;
alter table public.meter_readings enable row level security;
alter table public.meter_readings force row level security;
alter table public.monitoring_webhooks enable row level security;
alter table public.monitoring_webhooks force row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_preferences force row level security;
alter table public.operation_locations enable row level security;
alter table public.operation_locations force row level security;
alter table public.part_balances enable row level security;
alter table public.part_balances force row level security;
alter table public.part_movements enable row level security;
alter table public.part_movements force row level security;
alter table public.part_stock_policies enable row level security;
alter table public.part_stock_policies force row level security;
alter table public.parts enable row level security;
alter table public.parts force row level security;
alter table public.payable_approvals enable row level security;
alter table public.payable_approvals force row level security;
alter table public.payable_attachments enable row level security;
alter table public.payable_attachments force row level security;
alter table public.payables enable row level security;
alter table public.payables force row level security;
alter table public.permission_catalog enable row level security;
alter table public.permission_catalog force row level security;
alter table public.permission_grants enable row level security;
alter table public.permission_grants force row level security;
alter table public.planos enable row level security;
alter table public.planos force row level security;
alter table public.platform_settings enable row level security;
alter table public.platform_settings force row level security;
alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.project_members enable row level security;
alter table public.project_members force row level security;
alter table public.project_tasks enable row level security;
alter table public.project_tasks force row level security;
alter table public.projects enable row level security;
alter table public.projects force row level security;
alter table public.purchase_order_items enable row level security;
alter table public.purchase_order_items force row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_orders force row level security;
alter table public.queue_members enable row level security;
alter table public.queue_members force row level security;
alter table public.queue_rules enable row level security;
alter table public.queue_rules force row level security;
alter table public.queues enable row level security;
alter table public.queues force row level security;
alter table public.receivables enable row level security;
alter table public.receivables force row level security;
alter table public.rental_contract_items enable row level security;
alter table public.rental_contract_items force row level security;
alter table public.rental_contract_status_transitions enable row level security;
alter table public.rental_contracts enable row level security;
alter table public.rental_contracts force row level security;
alter table public.rental_depots enable row level security;
alter table public.rental_depots force row level security;
alter table public.rental_equipment enable row level security;
alter table public.rental_equipment force row level security;
alter table public.rental_equipment_movements enable row level security;
alter table public.rental_equipment_movements force row level security;
alter table public.rental_equipment_status_transitions enable row level security;
alter table public.rental_invoice_items enable row level security;
alter table public.rental_invoice_items force row level security;
alter table public.rental_invoices enable row level security;
alter table public.rental_invoices force row level security;
alter table public.request_throttle enable row level security;
alter table public.request_throttle force row level security;
alter table public.service_approvals enable row level security;
alter table public.service_approvals force row level security;
alter table public.service_catalog enable row level security;
alter table public.service_catalog force row level security;
alter table public.service_catalog_clients enable row level security;
alter table public.service_catalog_clients force row level security;
alter table public.sla_contracts enable row level security;
alter table public.sla_contracts force row level security;
alter table public.sla_definitions enable row level security;
alter table public.sla_definitions force row level security;
alter table public.sla_pauses enable row level security;
alter table public.sla_pauses force row level security;
alter table public.sla_tracking enable row level security;
alter table public.sla_tracking force row level security;
alter table public.supplier_contracts enable row level security;
alter table public.supplier_contracts force row level security;
alter table public.suppliers enable row level security;
alter table public.suppliers force row level security;
alter table public.telecom_line_attachments enable row level security;
alter table public.telecom_line_attachments force row level security;
alter table public.telecom_lines enable row level security;
alter table public.telecom_lines force row level security;
alter table public.tenant_status_events enable row level security;
alter table public.tenant_status_events force row level security;
alter table public.tenants enable row level security;
alter table public.tenants force row level security;
alter table public.ticket_assets enable row level security;
alter table public.ticket_assets force row level security;
alter table public.ticket_attachments enable row level security;
alter table public.ticket_attachments force row level security;
alter table public.ticket_categories enable row level security;
alter table public.ticket_categories force row level security;
alter table public.ticket_comments enable row level security;
alter table public.ticket_comments force row level security;
alter table public.ticket_field_service enable row level security;
alter table public.ticket_field_service force row level security;
alter table public.ticket_history enable row level security;
alter table public.ticket_history force row level security;
alter table public.ticket_labor_entries enable row level security;
alter table public.ticket_labor_entries force row level security;
alter table public.ticket_parts_used enable row level security;
alter table public.ticket_parts_used force row level security;
alter table public.ticket_priorities enable row level security;
alter table public.ticket_priorities force row level security;
alter table public.ticket_satisfaction enable row level security;
alter table public.ticket_satisfaction force row level security;
alter table public.ticket_status_transitions enable row level security;
alter table public.ticket_status_transitions force row level security;
alter table public.ticket_telecom_lines enable row level security;
alter table public.ticket_telecom_lines force row level security;
alter table public.tickets enable row level security;
alter table public.tickets force row level security;
alter table public.user_branches enable row level security;
alter table public.user_branches force row level security;


-- ==========================================================================
-- AS POLICIES
-- ==========================================================================

-- public.access_profiles
create policy access_profiles_delete on public.access_profiles
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_config()));
create policy access_profiles_insert on public.access_profiles
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_config()));
create policy access_profiles_select on public.access_profiles
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy access_profiles_update on public.access_profiles
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_config()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.agent_alerts
create policy agent_alerts_select on public.agent_alerts
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('inventario.agentes.ver'::text) AND ((branch_id IS NULL) OR app.can_see_branch(branch_id))));
create policy agent_alerts_update on public.agent_alerts
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('inventario.agentes.gerenciar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('inventario.agentes.gerenciar'::text)));

-- public.agent_devices
create policy agent_devices_select on public.agent_devices
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('inventario.agentes.ver'::text) AND ((branch_id IS NULL) OR app.can_see_branch(branch_id))));
create policy agent_devices_update on public.agent_devices
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('inventario.agentes.gerenciar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('inventario.agentes.gerenciar'::text)));

-- public.agent_enrollments
create policy agent_enrollments_rw on public.agent_enrollments
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_config()))
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_config()));

-- public.agent_inventory_snapshots
create policy agent_snapshots_select on public.agent_inventory_snapshots
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('inventario.agentes.ver'::text)));

-- public.agent_metrics_hourly
create policy agent_metrics_hourly_select on public.agent_metrics_hourly
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('inventario.agentes.ver'::text) AND ((branch_id IS NULL) OR app.can_see_branch(branch_id))));

-- public.agent_metrics_raw
create policy agent_metrics_raw_select on public.agent_metrics_raw
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('inventario.agentes.ver'::text) AND ((branch_id IS NULL) OR app.can_see_branch(branch_id))));

-- public.agent_software
create policy agent_software_select on public.agent_software
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('inventario.agentes.ver'::text)));

-- public.agent_volume_samples
create policy agent_volume_samples_select on public.agent_volume_samples
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('inventario.agentes.ver'::text) AND ((branch_id IS NULL) OR app.can_see_branch(branch_id))));

-- public.ai_settings
create policy ai_settings_rw on public.ai_settings
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('ia.config.gerenciar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('ia.config.gerenciar'::text)));
create policy ai_settings_select on public.ai_settings
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND (app.has_permission('ia.sugestoes.ver'::text) OR app.has_permission('ia.config.ver'::text))));

-- public.ai_suggestions
create policy ai_suggestions_select on public.ai_suggestions
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('ia.sugestoes.ver'::text)));
create policy ai_suggestions_write on public.ai_suggestions
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('ia.sugestoes.usar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('ia.sugestoes.usar'::text)));

-- public.approval_rules
create policy approval_rules_delete on public.approval_rules
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy approval_rules_insert on public.approval_rules
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy approval_rules_select on public.approval_rules
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy approval_rules_update on public.approval_rules
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.asset_assignments
create policy asset_assignments_select on public.asset_assignments
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_see_branch(branch_id)));
create policy asset_assignments_write on public.asset_assignments
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));

-- public.asset_attachments
create policy asset_attachments_select on public.asset_attachments
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy asset_attachments_write on public.asset_attachments
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));

-- public.audit_log
create policy audit_log_select on public.audit_log
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));

-- public.auth_tokens
create policy auth_tokens_ninguem_le on public.auth_tokens
  for select to authenticated
  using (false);

-- public.bank_account_movements
create policy bank_account_movements_delete on public.bank_account_movements
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy bank_account_movements_insert on public.bank_account_movements
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy bank_account_movements_select on public.bank_account_movements
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy bank_account_movements_update on public.bank_account_movements
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.bank_accounts
create policy bank_accounts_delete on public.bank_accounts
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy bank_accounts_insert on public.bank_accounts
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy bank_accounts_select on public.bank_accounts
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy bank_accounts_update on public.bank_accounts
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.branch_areas
create policy branch_areas_select on public.branch_areas
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy branch_areas_write on public.branch_areas
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));

-- public.branches
create policy branches_delete on public.branches
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy branches_insert on public.branches
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy branches_select on public.branches
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy branches_update on public.branches
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.business_hours
create policy business_hours_delete on public.business_hours
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy business_hours_insert on public.business_hours
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy business_hours_select on public.business_hours
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy business_hours_update on public.business_hours
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.business_hours_holidays
create policy bhh_all on public.business_hours_holidays
  for all to authenticated
  using ((EXISTS ( SELECT 1
   FROM business_hours bh
  WHERE ((bh.id = business_hours_holidays.business_hours_id) AND (bh.tenant_id = app.current_tenant_id())))))
  with check (((EXISTS ( SELECT 1
   FROM business_hours bh
  WHERE ((bh.id = business_hours_holidays.business_hours_id) AND (bh.tenant_id = app.current_tenant_id())))) AND app.can_manage_records()));

-- public.business_hours_intervals
create policy bhi_all on public.business_hours_intervals
  for all to authenticated
  using ((EXISTS ( SELECT 1
   FROM business_hours bh
  WHERE ((bh.id = business_hours_intervals.business_hours_id) AND (bh.tenant_id = app.current_tenant_id())))))
  with check (((EXISTS ( SELECT 1
   FROM business_hours bh
  WHERE ((bh.id = business_hours_intervals.business_hours_id) AND (bh.tenant_id = app.current_tenant_id())))) AND app.can_manage_records()));

-- public.channel_contacts
create policy channel_contacts_select on public.channel_contacts
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('canais.conversas.ver'::text)));
create policy channel_contacts_update on public.channel_contacts
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('canais.conversas.responder'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('canais.conversas.responder'::text)));

-- public.channel_conversations
create policy channel_conversations_select on public.channel_conversations
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('canais.conversas.ver'::text)));

-- public.channel_messages
create policy channel_messages_select on public.channel_messages
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('canais.conversas.ver'::text)));

-- public.channels
create policy channels_rw on public.channels
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('canais.canais.gerenciar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('canais.canais.gerenciar'::text)));
create policy channels_select on public.channels
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND (app.has_permission('canais.conversas.ver'::text) OR app.has_permission('canais.canais.ver'::text))));

-- public.clients
create policy clients_delete on public.clients
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy clients_insert on public.clients
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy clients_select on public.clients
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy clients_update on public.clients
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.cost_centers
create policy cost_centers_delete on public.cost_centers
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy cost_centers_insert on public.cost_centers
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy cost_centers_select on public.cost_centers
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy cost_centers_update on public.cost_centers
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.dashboard_layouts
create policy dashboard_layouts_delete on public.dashboard_layouts
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy dashboard_layouts_insert on public.dashboard_layouts
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy dashboard_layouts_select on public.dashboard_layouts
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy dashboard_layouts_update on public.dashboard_layouts
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.dashboard_tokens
create policy dashboard_tokens_delete on public.dashboard_tokens
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy dashboard_tokens_insert on public.dashboard_tokens
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy dashboard_tokens_select on public.dashboard_tokens
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy dashboard_tokens_update on public.dashboard_tokens
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.email_outbox
create policy email_outbox_select on public.email_outbox
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_config()));

-- public.equipment_categories
create policy equipment_categories_select on public.equipment_categories
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.cadastros.ver'::text)));
create policy equipment_categories_write on public.equipment_categories
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.cadastros.gerenciar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.cadastros.gerenciar'::text)));

-- public.equipment_manufacturers
create policy equipment_manufacturers_select on public.equipment_manufacturers
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.cadastros.ver'::text)));
create policy equipment_manufacturers_write on public.equipment_manufacturers
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.cadastros.gerenciar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.cadastros.gerenciar'::text)));

-- public.equipment_models
create policy equipment_models_select on public.equipment_models
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND (app.has_permission('locacao.frota.ver'::text) OR app.has_permission('locacao.cadastros.ver'::text))));
create policy equipment_models_write on public.equipment_models
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.cadastros.gerenciar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.cadastros.gerenciar'::text)));

-- public.expense_categories
create policy expense_categories_delete on public.expense_categories
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy expense_categories_insert on public.expense_categories
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy expense_categories_select on public.expense_categories
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy expense_categories_update on public.expense_categories
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.geocode_candidates
create policy geocode_candidates_select on public.geocode_candidates
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_see_branch(branch_id)));
create policy geocode_candidates_write on public.geocode_candidates
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));

-- public.geocode_logs
create policy geocode_logs_insert on public.geocode_logs
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy geocode_logs_select on public.geocode_logs
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_see_branch(branch_id)));

-- public.import_batches
create policy import_batches_select on public.import_batches
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('sistema.planilhas.ver'::text)));
create policy import_batches_write on public.import_batches
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('sistema.planilhas.importar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('sistema.planilhas.importar'::text)));

-- public.import_rows
create policy import_rows_select on public.import_rows
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('sistema.planilhas.ver'::text)));
create policy import_rows_write on public.import_rows
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('sistema.planilhas.importar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('sistema.planilhas.importar'::text)));

-- public.integration_events
create policy integration_events_select on public.integration_events
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));

-- public.integration_logs
create policy integration_logs_select on public.integration_logs
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));

-- public.integration_mapping_versions
create policy integration_mapping_versions_select on public.integration_mapping_versions
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy integration_mapping_versions_write on public.integration_mapping_versions
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));

-- public.integration_mappings
create policy integration_mappings_delete on public.integration_mappings
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy integration_mappings_insert on public.integration_mappings
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy integration_mappings_select on public.integration_mappings
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy integration_mappings_update on public.integration_mappings
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.integration_sync_state
create policy integration_sync_state_select on public.integration_sync_state
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));

-- public.integrations
create policy integrations_delete on public.integrations
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy integrations_insert on public.integrations
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy integrations_select on public.integrations
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy integrations_update on public.integrations
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.internet_link_attachments
create policy internet_link_attachments_select on public.internet_link_attachments
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy internet_link_attachments_write on public.internet_link_attachments
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));

-- public.internet_links
create policy internet_links_select on public.internet_links
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_see_branch(branch_id)));
create policy internet_links_write on public.internet_links
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));

-- public.inventory_count_items
create policy inventory_items_select on public.inventory_count_items
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.contagens.ver'::text)));
create policy inventory_items_write on public.inventory_count_items
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.contagens.contar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.contagens.contar'::text)));

-- public.inventory_counts
create policy inventory_counts_select on public.inventory_counts
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.contagens.ver'::text)));
create policy inventory_counts_write on public.inventory_counts
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.contagens.contar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.contagens.contar'::text)));

-- public.invites
create policy invites_select on public.invites
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('usuarios.convites.ver'::text)));
create policy invites_update on public.invites
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('usuarios.convites.revogar'::text) AND (accepted_at IS NULL)))
  with check ((tenant_id = app.current_tenant_id()));

-- public.it_assets
create policy it_assets_select on public.it_assets
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_see_branch(branch_id)));
create policy it_assets_write on public.it_assets
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));

-- public.it_budget_closings
create policy orcamento_closings_select on public.it_budget_closings
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('financeiro.orcamento.ver'::text)));
create policy orcamento_closings_write on public.it_budget_closings
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('financeiro.orcamento.fechar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('financeiro.orcamento.fechar'::text)));

-- public.it_budget_scenarios
create policy orcamento_scenarios_select on public.it_budget_scenarios
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('financeiro.orcamento.ver'::text)));
create policy orcamento_scenarios_write on public.it_budget_scenarios
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('financeiro.orcamento.lancar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('financeiro.orcamento.lancar'::text)));

-- public.it_budget_targets
create policy orcamento_targets_select on public.it_budget_targets
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('financeiro.orcamento.ver'::text)));
create policy orcamento_targets_write on public.it_budget_targets
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('financeiro.orcamento.lancar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('financeiro.orcamento.lancar'::text)));

-- public.it_cost_beneficiaries
create policy orcamento_benef_select on public.it_cost_beneficiaries
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('financeiro.orcamento.ver'::text)));
create policy orcamento_benef_write on public.it_cost_beneficiaries
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('financeiro.orcamento.lancar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('financeiro.orcamento.lancar'::text)));

-- public.it_cost_entries
create policy orcamento_entries_select on public.it_cost_entries
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('financeiro.orcamento.ver'::text)));
create policy orcamento_entries_write on public.it_cost_entries
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('financeiro.orcamento.lancar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('financeiro.orcamento.lancar'::text)));

-- public.job_alert_episodes
create policy job_alert_episodes_select on public.job_alert_episodes
  for select to authenticated
  using (app.has_permission('auditoria.trabalhos.ver'::text));

-- public.job_expectations
create policy job_expectations_select on public.job_expectations
  for select to authenticated
  using (app.has_permission('auditoria.trabalhos.ver'::text));

-- public.job_runs
create policy job_runs_super_admin on public.job_runs
  for select to authenticated
  using (app.is_super_admin());

-- public.kb_articles
create policy kb_articles_select on public.kb_articles
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND (deleted_at IS NULL) AND (app.has_permission('autoatendimento.base.escrever'::text) OR ((status = 'publicado'::text) AND (visibilidade = 'solicitante'::text)) OR ((status = 'publicado'::text) AND app.can_work_tickets()))));
create policy kb_articles_write on public.kb_articles
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('autoatendimento.base.escrever'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('autoatendimento.base.escrever'::text)));

-- public.kb_feedback
create policy kb_feedback_own on public.kb_feedback
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND ((user_id = app.current_user_id()) OR app.has_permission('autoatendimento.base.escrever'::text))))
  with check (((tenant_id = app.current_tenant_id()) AND (user_id = app.current_user_id())));

-- public.link_availability_events
create policy link_availability_events_select on public.link_availability_events
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy link_availability_events_write on public.link_availability_events
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));

-- public.meter_readings
create policy meter_readings_insert on public.meter_readings
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.frota.mover'::text)));
create policy meter_readings_select on public.meter_readings
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.frota.ver'::text)));

-- public.monitoring_webhooks
create policy monitoring_webhooks_rw on public.monitoring_webhooks
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('conectividade.links.monitoramento'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('conectividade.links.monitoramento'::text)));

-- public.notification_preferences
create policy notification_preferences_own on public.notification_preferences
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND (user_id = app.current_user_id())))
  with check (((tenant_id = app.current_tenant_id()) AND (user_id = app.current_user_id())));

-- public.operation_locations
create policy operation_locations_select on public.operation_locations
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.contratos.ver'::text)));
create policy operation_locations_write on public.operation_locations
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.contratos.editar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.contratos.editar'::text)));

-- public.part_balances
create policy part_balances_select on public.part_balances
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.pecas.ver'::text)));

-- public.part_movements
create policy part_movements_insert on public.part_movements
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.pecas.movimentar'::text)));
create policy part_movements_select on public.part_movements
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.pecas.ver'::text)));

-- public.part_stock_policies
create policy part_policies_select on public.part_stock_policies
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.pecas.ver'::text)));
create policy part_policies_write on public.part_stock_policies
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.pecas.gerenciar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.pecas.gerenciar'::text)));

-- public.parts
create policy parts_select on public.parts
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.pecas.ver'::text)));
create policy parts_write on public.parts
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.pecas.gerenciar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.pecas.gerenciar'::text)));

-- public.payable_approvals
create policy payable_approvals_delete on public.payable_approvals
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy payable_approvals_insert on public.payable_approvals
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy payable_approvals_select on public.payable_approvals
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy payable_approvals_update on public.payable_approvals
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.payable_attachments
create policy payable_attachments_delete on public.payable_attachments
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy payable_attachments_insert on public.payable_attachments
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy payable_attachments_select on public.payable_attachments
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy payable_attachments_update on public.payable_attachments
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.payables
create policy payables_delete on public.payables
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy payables_insert on public.payables
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy payables_select on public.payables
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy payables_update on public.payables
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.permission_catalog
create policy permission_catalog_select on public.permission_catalog
  for select to authenticated
  using (true);

-- public.permission_grants
create policy permission_grants_delete on public.permission_grants
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_config()));
create policy permission_grants_insert on public.permission_grants
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_config()));
create policy permission_grants_select on public.permission_grants
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));

-- public.planos
create policy planos_select on public.planos
  for select to authenticated
  using (is_active);

-- public.platform_settings
create policy platform_settings_select on public.platform_settings
  for select to authenticated
  using ((app."current_role"() = 'super_admin'::text));

-- public.profiles
create policy profiles_delete on public.profiles
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_config()));
create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_config()));
create policy profiles_select on public.profiles
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) OR (id = app.current_user_id()) OR app.is_super_admin()));
create policy profiles_update on public.profiles
  for update to authenticated
  using ((((tenant_id = app.current_tenant_id()) AND app.can_manage_config()) OR (id = app.current_user_id())))
  with check ((((tenant_id = app.current_tenant_id()) AND app.can_manage_config()) OR (id = app.current_user_id())));

-- public.project_members
create policy members_select on public.project_members
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('projetos.projetos.ver'::text)));
create policy members_write on public.project_members
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('projetos.projetos.editar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('projetos.projetos.editar'::text)));

-- public.project_tasks
create policy tasks_delete on public.project_tasks
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('projetos.projetos.editar'::text)));
create policy tasks_insert on public.project_tasks
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('projetos.projetos.editar'::text)));
create policy tasks_select on public.project_tasks
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('projetos.projetos.ver'::text)));
create policy tasks_update on public.project_tasks
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND (app.has_permission('projetos.projetos.editar'::text) OR app.has_permission('projetos.projetos.executar'::text))))
  with check (((tenant_id = app.current_tenant_id()) AND (app.has_permission('projetos.projetos.editar'::text) OR app.has_permission('projetos.projetos.executar'::text))));

-- public.projects
create policy projects_delete on public.projects
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('projetos.projetos.excluir'::text)));
create policy projects_insert on public.projects
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('projetos.projetos.criar'::text)));
create policy projects_select on public.projects
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('projetos.projetos.ver'::text)));
create policy projects_update on public.projects
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('projetos.projetos.editar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('projetos.projetos.editar'::text)));

-- public.purchase_order_items
create policy purchase_items_select on public.purchase_order_items
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.compras.ver'::text)));
create policy purchase_items_write on public.purchase_order_items
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.compras.gerenciar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.compras.gerenciar'::text)));

-- public.purchase_orders
create policy purchase_orders_select on public.purchase_orders
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.compras.ver'::text)));
create policy purchase_orders_write on public.purchase_orders
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.compras.gerenciar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.compras.gerenciar'::text)));

-- public.queue_members
create policy queue_members_delete on public.queue_members
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy queue_members_insert on public.queue_members
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy queue_members_select on public.queue_members
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy queue_members_update on public.queue_members
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.queue_rules
create policy queue_rules_delete on public.queue_rules
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy queue_rules_insert on public.queue_rules
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy queue_rules_select on public.queue_rules
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy queue_rules_update on public.queue_rules
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.queues
create policy queues_delete on public.queues
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy queues_insert on public.queues
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy queues_select on public.queues
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy queues_update on public.queues
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.receivables
create policy receivables_delete on public.receivables
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy receivables_insert on public.receivables
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy receivables_select on public.receivables
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy receivables_update on public.receivables
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.rental_contract_items
create policy rental_contract_items_select on public.rental_contract_items
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.contratos.ver'::text)));
create policy rental_contract_items_write on public.rental_contract_items
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.contratos.alocar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.contratos.alocar'::text)));

-- public.rental_contract_status_transitions
create policy rental_contract_transitions_select on public.rental_contract_status_transitions
  for select to authenticated
  using (true);

-- public.rental_contracts
create policy rental_contracts_insert on public.rental_contracts
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.contratos.criar'::text)));
create policy rental_contracts_select on public.rental_contracts
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.contratos.ver'::text)));
create policy rental_contracts_update on public.rental_contracts
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.contratos.editar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.contratos.editar'::text)));

-- public.rental_depots
create policy rental_depots_select on public.rental_depots
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.frota.ver'::text)));
create policy rental_depots_write on public.rental_depots
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.cadastros.gerenciar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.cadastros.gerenciar'::text)));

-- public.rental_equipment
create policy rental_equipment_insert on public.rental_equipment
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.frota.criar'::text)));
create policy rental_equipment_select on public.rental_equipment
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.frota.ver'::text)));
create policy rental_equipment_update on public.rental_equipment
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND (app.has_permission('locacao.frota.editar'::text) OR app.has_permission('locacao.frota.mover'::text))))
  with check (((tenant_id = app.current_tenant_id()) AND (app.has_permission('locacao.frota.editar'::text) OR app.has_permission('locacao.frota.mover'::text))));

-- public.rental_equipment_movements
create policy rental_movements_select on public.rental_equipment_movements
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.frota.ver'::text)));

-- public.rental_equipment_status_transitions
create policy rental_transitions_select on public.rental_equipment_status_transitions
  for select to authenticated
  using (true);

-- public.rental_invoice_items
create policy rental_invoice_items_select on public.rental_invoice_items
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.faturamento.ver'::text)));
create policy rental_invoice_items_write on public.rental_invoice_items
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.faturamento.faturar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.faturamento.faturar'::text)));

-- public.rental_invoices
create policy rental_invoices_select on public.rental_invoices
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.faturamento.ver'::text)));
create policy rental_invoices_write on public.rental_invoices
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.faturamento.faturar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.faturamento.faturar'::text)));

-- public.request_throttle
create policy request_throttle_ninguem_le on public.request_throttle
  for select to authenticated
  using (false);

-- public.service_approvals
create policy service_approvals_select on public.service_approvals
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));

-- public.service_catalog
create policy service_catalog_select on public.service_catalog
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND (deleted_at IS NULL)));
create policy service_catalog_write on public.service_catalog
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('autoatendimento.catalogo.gerenciar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('autoatendimento.catalogo.gerenciar'::text)));

-- public.service_catalog_clients
create policy service_catalog_clients_rw on public.service_catalog_clients
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('autoatendimento.catalogo.gerenciar'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('autoatendimento.catalogo.gerenciar'::text)));

-- public.sla_contracts
create policy sla_contracts_delete on public.sla_contracts
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy sla_contracts_insert on public.sla_contracts
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy sla_contracts_select on public.sla_contracts
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy sla_contracts_update on public.sla_contracts
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.sla_definitions
create policy sla_definitions_delete on public.sla_definitions
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy sla_definitions_insert on public.sla_definitions
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy sla_definitions_select on public.sla_definitions
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy sla_definitions_update on public.sla_definitions
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.sla_pauses
create policy sla_pauses_select on public.sla_pauses
  for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM tickets t
  WHERE (t.id = sla_pauses.ticket_id))));

-- public.sla_tracking
create policy sla_tracking_select on public.sla_tracking
  for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM tickets t
  WHERE (t.id = sla_tracking.ticket_id))));

-- public.supplier_contracts
create policy supplier_contracts_delete on public.supplier_contracts
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy supplier_contracts_insert on public.supplier_contracts
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy supplier_contracts_select on public.supplier_contracts
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy supplier_contracts_update on public.supplier_contracts
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.suppliers
create policy suppliers_delete on public.suppliers
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy suppliers_insert on public.suppliers
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy suppliers_select on public.suppliers
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy suppliers_update on public.suppliers
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.telecom_line_attachments
create policy telecom_line_attachments_select on public.telecom_line_attachments
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy telecom_line_attachments_write on public.telecom_line_attachments
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));

-- public.telecom_lines
create policy telecom_lines_select on public.telecom_lines
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_see_branch(branch_id)));
create policy telecom_lines_write on public.telecom_lines
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));

-- public.tenant_status_events
create policy tenant_status_events_select on public.tenant_status_events
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));

-- public.tenants
create policy tenants_select on public.tenants
  for select to authenticated
  using (((id = app.current_tenant_id()) OR app.is_super_admin()));
create policy tenants_update on public.tenants
  for update to authenticated
  using (((id = app.current_tenant_id()) AND app.can_manage_config()))
  with check ((id = app.current_tenant_id()));

-- public.ticket_assets
create policy ticket_assets_all on public.ticket_assets
  for all to authenticated
  using ((EXISTS ( SELECT 1
   FROM tickets t
  WHERE (t.id = ticket_assets.ticket_id))))
  with check (((tenant_id = app.current_tenant_id()) AND app.can_work_tickets()));

-- public.ticket_attachments
create policy ticket_attachments_all on public.ticket_attachments
  for all to authenticated
  using ((EXISTS ( SELECT 1
   FROM tickets t
  WHERE (t.id = ticket_attachments.ticket_id))))
  with check (((tenant_id = app.current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM tickets t
  WHERE (t.id = ticket_attachments.ticket_id)))));

-- public.ticket_categories
create policy ticket_categories_delete on public.ticket_categories
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy ticket_categories_insert on public.ticket_categories
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy ticket_categories_select on public.ticket_categories
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy ticket_categories_update on public.ticket_categories
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.ticket_comments
create policy ticket_comments_insert on public.ticket_comments
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM tickets t
  WHERE (t.id = ticket_comments.ticket_id))) AND ((visibility = 'public'::text) OR app.can_work_tickets())));
create policy ticket_comments_select on public.ticket_comments
  for select to authenticated
  using (((EXISTS ( SELECT 1
   FROM tickets t
  WHERE (t.id = ticket_comments.ticket_id))) AND ((visibility = 'public'::text) OR app.can_work_tickets())));
create policy ticket_comments_update on public.ticket_comments
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND (author_id = app.current_user_id())))
  with check ((tenant_id = app.current_tenant_id()));

-- public.ticket_field_service
create policy field_service_select on public.ticket_field_service
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.manutencao.ver'::text)));
create policy field_service_write on public.ticket_field_service
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.manutencao.atender'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.manutencao.atender'::text)));

-- public.ticket_history
create policy ticket_history_select on public.ticket_history
  for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM tickets t
  WHERE (t.id = ticket_history.ticket_id))));

-- public.ticket_labor_entries
create policy labor_entries_select on public.ticket_labor_entries
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.manutencao.ver'::text)));
create policy labor_entries_write on public.ticket_labor_entries
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.manutencao.atender'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.manutencao.atender'::text)));

-- public.ticket_parts_used
create policy parts_used_select on public.ticket_parts_used
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.manutencao.ver'::text)));
create policy parts_used_write on public.ticket_parts_used
  for all to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.manutencao.atender'::text)))
  with check (((tenant_id = app.current_tenant_id()) AND app.has_permission('locacao.manutencao.atender'::text)));

-- public.ticket_priorities
create policy ticket_priorities_delete on public.ticket_priorities
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy ticket_priorities_insert on public.ticket_priorities
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy ticket_priorities_select on public.ticket_priorities
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy ticket_priorities_update on public.ticket_priorities
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- public.ticket_satisfaction
create policy ticket_satisfaction_select on public.ticket_satisfaction
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));

-- public.ticket_status_transitions
create policy ticket_status_transitions_select on public.ticket_status_transitions
  for select to authenticated
  using (true);

-- public.ticket_telecom_lines
create policy ticket_lines_all on public.ticket_telecom_lines
  for all to authenticated
  using ((EXISTS ( SELECT 1
   FROM tickets t
  WHERE (t.id = ticket_telecom_lines.ticket_id))))
  with check (((tenant_id = app.current_tenant_id()) AND app.can_work_tickets()));

-- public.tickets
create policy tickets_delete on public.tickets
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_config()));
create policy tickets_insert on public.tickets
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND (app.can_work_tickets() OR ((requester_id = app.current_user_id()) AND ((branch_id IS NULL) OR (branch_id = ANY (app.current_user_branch_ids())))))));
create policy tickets_select on public.tickets
  for select to authenticated
  using (((tenant_id = app.current_tenant_id()) AND (app.has_tenant_wide_access() OR (requester_id = app.current_user_id()) OR ((app."current_role"() = ANY (ARRAY['atendente'::text, 'visualizador'::text])) AND (branch_id = ANY (app.current_user_branch_ids()))))));
create policy tickets_update on public.tickets
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_work_tickets() AND (app.has_tenant_wide_access() OR (branch_id = ANY (app.current_user_branch_ids())))))
  with check ((tenant_id = app.current_tenant_id()));

-- public.user_branches
create policy user_branches_delete on public.user_branches
  for delete to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy user_branches_insert on public.user_branches
  for insert to authenticated
  with check (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()));
create policy user_branches_select on public.user_branches
  for select to authenticated
  using ((tenant_id = app.current_tenant_id()));
create policy user_branches_update on public.user_branches
  for update to authenticated
  using (((tenant_id = app.current_tenant_id()) AND app.can_manage_records()))
  with check ((tenant_id = app.current_tenant_id()));

-- storage.objects
create policy anexos_delete on storage.objects
  for delete to authenticated
  using (((bucket_id = 'anexos'::text) AND app.can_touch_attachment(name, 'remover'::text)));
create policy anexos_insert on storage.objects
  for insert to authenticated
  with check (((bucket_id = 'anexos'::text) AND app.can_touch_attachment(name, 'anexar'::text)));
create policy anexos_select on storage.objects
  for select to authenticated
  using (((bucket_id = 'anexos'::text) AND app.can_touch_attachment(name, 'ver'::text)));
