-- =============================================================================
-- 02 — ÍNDICES  (226)
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

-- Só os índices PRÓPRIOS. Os que o PostgreSQL cria sozinho para sustentar
-- chave primária e restrição de unicidade ficam de fora: eles já estão no
-- arquivo 01, dentro da constraint que os pede, e repeti-los aqui faria
-- este arquivo falhar ao ser executado sobre o outro.


-- access_profiles
CREATE INDEX idx_access_profiles_tenant ON public.access_profiles USING btree (tenant_id) WHERE is_active;
CREATE UNIQUE INDEX uq_access_profiles_name ON public.access_profiles USING btree (tenant_id, lower(name));
CREATE UNIQUE INDEX uq_access_profiles_system_key ON public.access_profiles USING btree (tenant_id, system_key) WHERE (system_key IS NOT NULL);

-- agent_alerts
CREATE INDEX idx_alertas_abertos ON public.agent_alerts USING btree (tenant_id, aberto_em DESC) WHERE (fechado_em IS NULL);
CREATE UNIQUE INDEX uq_alerta_aberto ON public.agent_alerts USING btree (device_id, kind, chave) WHERE (fechado_em IS NULL);

-- agent_devices
CREATE INDEX idx_agent_devices_contato ON public.agent_devices USING btree (tenant_id, last_seen_at DESC NULLS LAST) WHERE (revoked_at IS NULL);
CREATE UNIQUE INDEX uq_agent_device_asset ON public.agent_devices USING btree (tenant_id, it_asset_id) WHERE ((it_asset_id IS NOT NULL) AND (revoked_at IS NULL));

-- agent_enrollments
CREATE INDEX idx_agent_enrollments_tenant ON public.agent_enrollments USING btree (tenant_id) WHERE (revoked_at IS NULL);

-- agent_inventory_snapshots
CREATE INDEX idx_snapshots_device ON public.agent_inventory_snapshots USING btree (tenant_id, device_id, collected_at DESC);

-- agent_metrics_hourly
CREATE INDEX idx_metrics_hourly_tenant ON public.agent_metrics_hourly USING btree (tenant_id, hora DESC);

-- agent_metrics_raw
CREATE INDEX idx_metrics_raw_tempo ON public.agent_metrics_raw USING brin (collected_at);
CREATE INDEX idx_metrics_raw_tenant ON public.agent_metrics_raw USING btree (tenant_id, collected_at DESC);

-- agent_software
CREATE INDEX idx_software_nome ON public.agent_software USING btree (tenant_id, lower(name));

-- agent_volume_samples
CREATE INDEX idx_volume_samples_tenant ON public.agent_volume_samples USING btree (tenant_id, hora DESC);

-- ai_suggestions
CREATE INDEX idx_sug_por_chamado ON public.ai_suggestions USING btree (ticket_id, created_at DESC);
CREATE INDEX idx_sug_por_tenant ON public.ai_suggestions USING btree (tenant_id, created_at DESC);
CREATE UNIQUE INDEX uq_sug_pendente ON public.ai_suggestions USING btree (ticket_id, kind) WHERE (status = 'pendente'::text);

-- approval_rules
CREATE INDEX idx_approval_rules_tenant ON public.approval_rules USING btree (tenant_id, level) WHERE is_active;

-- asset_assignments
CREATE INDEX idx_aa_asset ON public.asset_assignments USING btree (asset_id, started_at DESC);
CREATE INDEX idx_aa_user ON public.asset_assignments USING btree (tenant_id, user_id) WHERE (user_id IS NOT NULL);

-- asset_attachments
CREATE INDEX idx_asset_attachments ON public.asset_attachments USING btree (asset_id, category, created_at DESC);
CREATE UNIQUE INDEX uq_asset_primary_photo ON public.asset_attachments USING btree (asset_id) WHERE (is_primary AND (category = 'photo'::text));

-- audit_log
CREATE INDEX idx_audit_actor ON public.audit_log USING btree (actor_id, created_at DESC) WHERE (actor_id IS NOT NULL);
CREATE INDEX idx_audit_entidade ON public.audit_log USING btree (tenant_id, entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_entity ON public.audit_log USING btree (entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_recente ON public.audit_log USING btree (tenant_id, created_at DESC);
CREATE INDEX idx_audit_tenant ON public.audit_log USING btree (tenant_id, created_at DESC);

-- auth_tokens
CREATE INDEX auth_tokens_vencidos ON public.auth_tokens USING btree (expires_at);
CREATE INDEX auth_tokens_vivos ON public.auth_tokens USING btree (token_hash) WHERE (used_at IS NULL);

-- bank_account_movements
CREATE INDEX idx_movements_account ON public.bank_account_movements USING btree (bank_account_id, moved_on DESC);
CREATE INDEX idx_movements_tenant ON public.bank_account_movements USING btree (tenant_id, moved_on DESC);
CREATE INDEX idx_movements_transfer ON public.bank_account_movements USING btree (transfer_group) WHERE (transfer_group IS NOT NULL);
CREATE INDEX idx_movements_unreconciled ON public.bank_account_movements USING btree (tenant_id, moved_on) WHERE (reconciled_at IS NULL);

-- bank_accounts
CREATE INDEX idx_bank_accounts_tenant ON public.bank_accounts USING btree (tenant_id) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX uq_bank_accounts_identity ON public.bank_accounts USING btree (tenant_id, bank_code, agency, account_number) WHERE ((deleted_at IS NULL) AND (account_number IS NOT NULL));

-- branch_areas
CREATE INDEX idx_areas_branch ON public.branch_areas USING btree (tenant_id, branch_id, sort_order) WHERE is_active;
CREATE UNIQUE INDEX uq_area_name ON public.branch_areas USING btree (branch_id, lower(name));

-- branches
CREATE INDEX idx_branches_client ON public.branches USING btree (client_id) WHERE (deleted_at IS NULL);
CREATE INDEX idx_branches_geo ON public.branches USING btree (tenant_id) WHERE ((latitude IS NOT NULL) AND (longitude IS NOT NULL) AND (deleted_at IS NULL));
CREATE INDEX idx_branches_geo_imprecise ON public.branches USING btree (tenant_id) WHERE ((deleted_at IS NULL) AND (latitude IS NOT NULL) AND ((geocode_precision IS NULL) OR (geocode_precision = ANY (ARRAY['approximate'::text, 'geometric_center'::text]))));
CREATE INDEX idx_branches_tenant ON public.branches USING btree (tenant_id) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX uq_branches_client_code ON public.branches USING btree (client_id, upper(code)) WHERE ((code IS NOT NULL) AND (deleted_at IS NULL));

-- business_hours
CREATE INDEX idx_business_hours_tenant ON public.business_hours USING btree (tenant_id);
CREATE UNIQUE INDEX uq_business_hours_default ON public.business_hours USING btree (tenant_id) WHERE is_default;

-- business_hours_intervals
CREATE INDEX idx_bhi_lookup ON public.business_hours_intervals USING btree (business_hours_id, weekday, starts_at);

-- channel_contacts
CREATE INDEX idx_contacts_tenant ON public.channel_contacts USING btree (tenant_id, channel_id);

-- channel_conversations
CREATE INDEX idx_conversas_por_ticket ON public.channel_conversations USING btree (ticket_id) WHERE ((status = 'aberta'::text) AND (ticket_id IS NOT NULL));
CREATE INDEX idx_conversas_recentes ON public.channel_conversations USING btree (tenant_id, last_message_at DESC);
CREATE UNIQUE INDEX uq_conversa_aberta ON public.channel_conversations USING btree (channel_id, contact_id) WHERE (status = 'aberta'::text);

-- channel_messages
CREATE INDEX idx_msg_conversa ON public.channel_messages USING btree (conversation_id, created_at);
CREATE INDEX idx_msg_fila ON public.channel_messages USING btree (scheduled_for) WHERE (status = 'na_fila'::text);
CREATE UNIQUE INDEX uq_msg_externo ON public.channel_messages USING btree (channel_id, external_id) WHERE (external_id IS NOT NULL);

-- channels
CREATE INDEX idx_channels_ativos ON public.channels USING btree (tenant_id, kind) WHERE ((status = 'ativo'::text) AND (deleted_at IS NULL));

-- clients
CREATE INDEX idx_clients_tenant ON public.clients USING btree (tenant_id) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX uq_clients_tenant_cnpj ON public.clients USING btree (tenant_id, cnpj) WHERE ((cnpj IS NOT NULL) AND (deleted_at IS NULL));

-- cost_centers
CREATE INDEX idx_cost_centers_branch ON public.cost_centers USING btree (branch_id) WHERE (branch_id IS NOT NULL);
CREATE INDEX idx_cost_centers_parent ON public.cost_centers USING btree (parent_id);
CREATE INDEX idx_cost_centers_tenant ON public.cost_centers USING btree (tenant_id) WHERE is_active;
CREATE UNIQUE INDEX uq_cost_centers_code ON public.cost_centers USING btree (tenant_id, lower(code));

-- dashboard_layouts
CREATE UNIQUE INDEX uq_layout_default ON public.dashboard_layouts USING btree (tenant_id) WHERE is_default;

-- dashboard_tokens
CREATE INDEX idx_dashboard_tokens_tenant ON public.dashboard_tokens USING btree (tenant_id) WHERE (revoked_at IS NULL);

-- email_outbox
CREATE INDEX idx_email_outbox_fila ON public.email_outbox USING btree (scheduled_for) WHERE (status = 'pending'::text);
CREATE INDEX idx_email_outbox_recentes ON public.email_outbox USING btree (tenant_id, created_at DESC);
CREATE UNIQUE INDEX uq_email_outbox_dedupe ON public.email_outbox USING btree (tenant_id, dedupe_key) WHERE (dedupe_key IS NOT NULL);

-- equipment_categories
CREATE UNIQUE INDEX equipment_categories_code_uk ON public.equipment_categories USING btree (tenant_id, lower(code)) WHERE (deleted_at IS NULL);

-- equipment_manufacturers
CREATE UNIQUE INDEX equipment_manufacturers_name_uk ON public.equipment_manufacturers USING btree (tenant_id, lower(name)) WHERE (deleted_at IS NULL);

-- equipment_models
CREATE INDEX equipment_models_category_idx ON public.equipment_models USING btree (tenant_id, category_id);
CREATE UNIQUE INDEX equipment_models_code_uk ON public.equipment_models USING btree (tenant_id, lower(code)) WHERE (deleted_at IS NULL);

-- expense_categories
CREATE INDEX idx_expense_categories_tenant ON public.expense_categories USING btree (tenant_id) WHERE is_active;
CREATE UNIQUE INDEX uq_expense_categories_code ON public.expense_categories USING btree (tenant_id, lower(code));

-- geocode_candidates
CREATE INDEX idx_geocode_candidates_branch ON public.geocode_candidates USING btree (tenant_id, branch_id, ordinal);

-- geocode_logs
CREATE INDEX idx_geocode_logs_branch ON public.geocode_logs USING btree (tenant_id, branch_id, created_at DESC);

-- import_batches
CREATE INDEX import_batches_tenant_idx ON public.import_batches USING btree (tenant_id, created_at DESC);

-- import_rows
CREATE INDEX import_rows_batch_idx ON public.import_rows USING btree (batch_id, line_number);
CREATE INDEX import_rows_recusadas_idx ON public.import_rows USING btree (batch_id) WHERE (outcome = 'reject'::text);

-- integration_events
CREATE INDEX idx_events_external ON public.integration_events USING btree (integration_id, external_id) WHERE (external_id IS NOT NULL);
CREATE INDEX idx_events_pending ON public.integration_events USING btree (integration_id, received_at) WHERE (status = 'pending'::text);
CREATE INDEX idx_events_tenant ON public.integration_events USING btree (tenant_id, received_at DESC);

-- integration_logs
CREATE INDEX idx_logs_errors ON public.integration_logs USING btree (tenant_id, created_at DESC) WHERE (outcome = ANY (ARRAY['error'::text, 'retry'::text]));
CREATE INDEX idx_logs_integration ON public.integration_logs USING btree (integration_id, created_at DESC);

-- integration_mapping_versions
CREATE INDEX idx_mapping_versions ON public.integration_mapping_versions USING btree (integration_id, version DESC);

-- integration_mappings
CREATE INDEX idx_mappings_integration ON public.integration_mappings USING btree (integration_id);

-- integrations
CREATE INDEX idx_integrations_lookup ON public.integrations USING btree (source_system, slug) WHERE (status = 'active'::text);
CREATE INDEX idx_integrations_tenant ON public.integrations USING btree (tenant_id, status);

-- internet_link_attachments
CREATE INDEX idx_link_attachments ON public.internet_link_attachments USING btree (link_id, kind, created_at DESC);

-- internet_links
CREATE INDEX idx_links_branch ON public.internet_links USING btree (tenant_id, branch_id, status) WHERE (deleted_at IS NULL);
CREATE INDEX idx_links_contract_end ON public.internet_links USING btree (tenant_id, contract_end) WHERE ((contract_end IS NOT NULL) AND (deleted_at IS NULL) AND (status <> 'cancelled'::text));
CREATE INDEX idx_links_down ON public.internet_links USING btree (tenant_id, branch_id) WHERE ((last_state = 'down'::text) AND (status = 'active'::text) AND (deleted_at IS NULL));
CREATE INDEX idx_links_pagina ON public.internet_links USING btree (tenant_id, contract_number, id) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX uq_link_contract ON public.internet_links USING btree (tenant_id, upper(contract_number)) WHERE ((contract_number IS NOT NULL) AND (deleted_at IS NULL));

-- inventory_count_items
CREATE UNIQUE INDEX inventory_count_items_uk ON public.inventory_count_items USING btree (count_id, part_id);

-- inventory_counts
CREATE UNIQUE INDEX inventory_counts_code_uk ON public.inventory_counts USING btree (tenant_id, lower(code));

-- invites
CREATE INDEX invites_por_tenant ON public.invites USING btree (tenant_id, created_at DESC);
CREATE UNIQUE INDEX invites_um_vivo ON public.invites USING btree (tenant_id, lower(email)) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL));

-- it_assets
CREATE INDEX idx_assets_area ON public.it_assets USING btree (tenant_id, branch_area_id) WHERE ((deleted_at IS NULL) AND (branch_area_id IS NOT NULL));
CREATE INDEX idx_assets_branch ON public.it_assets USING btree (tenant_id, branch_id, status) WHERE (deleted_at IS NULL);
CREATE INDEX idx_assets_no_owner ON public.it_assets USING btree (tenant_id, branch_id) WHERE ((assigned_user_id IS NULL) AND (deleted_at IS NULL) AND (status = 'active'::text));
CREATE INDEX idx_assets_pagina ON public.it_assets USING btree (tenant_id, asset_tag, id) WHERE (deleted_at IS NULL);
CREATE INDEX idx_assets_user ON public.it_assets USING btree (tenant_id, assigned_user_id) WHERE (deleted_at IS NULL);
CREATE INDEX idx_assets_warranty ON public.it_assets USING btree (tenant_id, warranty_until) WHERE ((deleted_at IS NULL) AND (warranty_until IS NOT NULL));
CREATE UNIQUE INDEX uq_asset_serial ON public.it_assets USING btree (tenant_id, upper(serial_number)) WHERE ((serial_number IS NOT NULL) AND (deleted_at IS NULL));
CREATE UNIQUE INDEX uq_asset_tag ON public.it_assets USING btree (tenant_id, upper(asset_tag)) WHERE ((asset_tag IS NOT NULL) AND (deleted_at IS NULL));

-- it_cost_beneficiaries
CREATE INDEX idx_benef_filial ON public.it_cost_beneficiaries USING btree (branch_id);

-- it_cost_entries
CREATE INDEX idx_entries_cenario ON public.it_cost_entries USING btree (scenario_id, competence) WHERE (deleted_at IS NULL);
CREATE INDEX idx_entries_competencia ON public.it_cost_entries USING btree (tenant_id, client_id, competence) WHERE (deleted_at IS NULL);
CREATE INDEX idx_entries_serie ON public.it_cost_entries USING btree (parent_entry_id) WHERE (parent_entry_id IS NOT NULL);
CREATE UNIQUE INDEX uq_entry_por_titulo ON public.it_cost_entries USING btree (payable_id) WHERE ((payable_id IS NOT NULL) AND (deleted_at IS NULL));

-- job_alert_episodes
CREATE INDEX job_alert_episodes_a_avisar ON public.job_alert_episodes USING btree (aberto_em) WHERE ((avisado_em IS NULL) AND (fechado_em IS NULL));
CREATE UNIQUE INDEX job_alert_episodes_um_aberto ON public.job_alert_episodes USING btree (job) WHERE (fechado_em IS NULL);
CREATE INDEX job_alert_episodes_volta_a_avisar ON public.job_alert_episodes USING btree (fechado_em) WHERE ((volta_avisada_em IS NULL) AND (fechado_em IS NOT NULL) AND (avisado_em IS NOT NULL));

-- job_runs
CREATE INDEX idx_job_runs_recentes ON public.job_runs USING btree (job, started_at DESC);

-- kb_articles
CREATE INDEX idx_kb_busca ON public.kb_articles USING gin (search_vector);
CREATE INDEX idx_kb_categoria ON public.kb_articles USING btree (tenant_id, category_id) WHERE (deleted_at IS NULL);
CREATE INDEX idx_kb_publicados ON public.kb_articles USING btree (tenant_id, published_at DESC) WHERE ((status = 'publicado'::text) AND (deleted_at IS NULL));

-- link_availability_events
CREATE INDEX idx_link_events ON public.link_availability_events USING btree (link_id, started_at DESC);
CREATE UNIQUE INDEX uq_link_event_external ON public.link_availability_events USING btree (link_id, external_event_id) WHERE (external_event_id IS NOT NULL);
CREATE UNIQUE INDEX uq_link_event_open ON public.link_availability_events USING btree (link_id) WHERE (ended_at IS NULL);

-- meter_readings
CREATE UNIQUE INDEX meter_readings_dia_uk ON public.meter_readings USING btree (equipment_id, read_on, source);
CREATE INDEX meter_readings_equipment_idx ON public.meter_readings USING btree (tenant_id, equipment_id, read_on DESC);

-- monitoring_webhooks
CREATE INDEX idx_monitoring_webhooks_tenant ON public.monitoring_webhooks USING btree (tenant_id) WHERE (deleted_at IS NULL);

-- operation_locations
CREATE INDEX operation_locations_client_idx ON public.operation_locations USING btree (tenant_id, client_id) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX operation_locations_name_uk ON public.operation_locations USING btree (tenant_id, client_id, lower(name)) WHERE (deleted_at IS NULL);

-- part_balances
CREATE INDEX part_balances_tenant_idx ON public.part_balances USING btree (tenant_id);
CREATE UNIQUE INDEX part_balances_uk ON public.part_balances USING btree (part_id, depot_id);

-- part_movements
CREATE INDEX part_movements_part_idx ON public.part_movements USING btree (tenant_id, part_id, depot_id, created_at DESC);
CREATE INDEX part_movements_ticket_idx ON public.part_movements USING btree (ticket_id) WHERE (ticket_id IS NOT NULL);

-- part_stock_policies
CREATE UNIQUE INDEX part_stock_policies_uk ON public.part_stock_policies USING btree (part_id, depot_id);

-- parts
CREATE UNIQUE INDEX parts_sku_uk ON public.parts USING btree (tenant_id, lower(sku)) WHERE (deleted_at IS NULL);
CREATE INDEX parts_tenant_idx ON public.parts USING btree (tenant_id) WHERE (deleted_at IS NULL);

-- payable_approvals
CREATE INDEX idx_payable_approvals_payable ON public.payable_approvals USING btree (payable_id, level);

-- payable_attachments
CREATE INDEX idx_payable_attachments ON public.payable_attachments USING btree (payable_id, kind);

-- payables
CREATE INDEX idx_payables_pagina ON public.payables USING btree (tenant_id, due_on, id) WHERE (deleted_at IS NULL);
CREATE INDEX idx_payables_parent ON public.payables USING btree (parent_payable_id) WHERE (parent_payable_id IS NOT NULL);
CREATE INDEX idx_payables_status ON public.payables USING btree (tenant_id, status) WHERE (deleted_at IS NULL);
CREATE INDEX idx_payables_supplier ON public.payables USING btree (supplier_id) WHERE (deleted_at IS NULL);
CREATE INDEX idx_payables_tenant_due ON public.payables USING btree (tenant_id, due_on) WHERE (deleted_at IS NULL);

-- permission_catalog
CREATE INDEX idx_permission_catalog_module ON public.permission_catalog USING btree (module, sort_order);

-- permission_grants
CREATE INDEX idx_permission_grants_tenant ON public.permission_grants USING btree (tenant_id, permission_key);

-- planos
CREATE INDEX idx_planos_publicos ON public.planos USING btree (ordem) WHERE (publico AND is_active);

-- profiles
CREATE INDEX idx_profiles_access_profile ON public.profiles USING btree (access_profile_id) WHERE (access_profile_id IS NOT NULL);
CREATE INDEX idx_profiles_presence ON public.profiles USING btree (tenant_id, last_seen_at DESC) WHERE (is_active AND (role = ANY (ARRAY['atendente'::text, 'gestor'::text, 'admin'::text])));
CREATE INDEX idx_profiles_tenant ON public.profiles USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);
CREATE UNIQUE INDEX uq_profiles_tenant_email ON public.profiles USING btree (tenant_id, lower(email)) WHERE (tenant_id IS NOT NULL);

-- project_tasks
CREATE INDEX idx_tasks_pai ON public.project_tasks USING btree (parent_task_id) WHERE (parent_task_id IS NOT NULL);
CREATE INDEX idx_tasks_prazo ON public.project_tasks USING btree (tenant_id, planned_end_month) WHERE (deleted_at IS NULL);
CREATE INDEX idx_tasks_projeto ON public.project_tasks USING btree (project_id) WHERE (deleted_at IS NULL);

-- projects
CREATE INDEX idx_projects_cliente ON public.projects USING btree (tenant_id, client_id) WHERE (deleted_at IS NULL);
CREATE INDEX idx_projects_prazo ON public.projects USING btree (tenant_id, planned_end_month) WHERE (deleted_at IS NULL);

-- purchase_order_items
CREATE INDEX purchase_order_items_order_idx ON public.purchase_order_items USING btree (order_id);

-- purchase_orders
CREATE UNIQUE INDEX purchase_orders_code_uk ON public.purchase_orders USING btree (tenant_id, lower(code)) WHERE (deleted_at IS NULL);
CREATE INDEX purchase_orders_tenant_idx ON public.purchase_orders USING btree (tenant_id, status) WHERE (deleted_at IS NULL);

-- queue_members
CREATE INDEX idx_queue_members_user ON public.queue_members USING btree (user_id);

-- queue_rules
CREATE INDEX idx_queue_rules_eval ON public.queue_rules USING btree (tenant_id, sort_order) WHERE is_active;

-- queues
CREATE INDEX idx_queues_tenant ON public.queues USING btree (tenant_id) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX uq_queue_single_default ON public.queues USING btree (tenant_id) WHERE is_system_default;

-- receivables
CREATE INDEX idx_receivables_client ON public.receivables USING btree (client_id) WHERE (deleted_at IS NULL);
CREATE INDEX idx_receivables_pagina ON public.receivables USING btree (tenant_id, due_on, id) WHERE (deleted_at IS NULL);
CREATE INDEX idx_receivables_status ON public.receivables USING btree (tenant_id, status) WHERE (deleted_at IS NULL);
CREATE INDEX idx_receivables_tenant_due ON public.receivables USING btree (tenant_id, due_on) WHERE (deleted_at IS NULL);

-- rental_contract_items
CREATE INDEX rental_contract_items_contract_idx ON public.rental_contract_items USING btree (tenant_id, contract_id) WHERE (deleted_at IS NULL);
CREATE INDEX rental_contract_items_equipment_idx ON public.rental_contract_items USING btree (tenant_id, equipment_id) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX rental_contract_items_uma_viva ON public.rental_contract_items USING btree (equipment_id) WHERE ((deleted_at IS NULL) AND (status = ANY (ARRAY['reserved'::text, 'delivered'::text])));

-- rental_contracts
CREATE INDEX rental_contracts_client_idx ON public.rental_contracts USING btree (tenant_id, client_id) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX rental_contracts_code_uk ON public.rental_contracts USING btree (tenant_id, lower(code)) WHERE (deleted_at IS NULL);
CREATE INDEX rental_contracts_status_idx ON public.rental_contracts USING btree (tenant_id, status) WHERE (deleted_at IS NULL);

-- rental_depots
CREATE UNIQUE INDEX rental_depots_name_uk ON public.rental_depots USING btree (tenant_id, lower(name)) WHERE (deleted_at IS NULL);
CREATE INDEX rental_depots_tenant_idx ON public.rental_depots USING btree (tenant_id) WHERE (deleted_at IS NULL);

-- rental_equipment
CREATE INDEX rental_equipment_model_idx ON public.rental_equipment USING btree (tenant_id, model_id) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX rental_equipment_serial_uk ON public.rental_equipment USING btree (tenant_id, lower(serial_number)) WHERE ((deleted_at IS NULL) AND (serial_number IS NOT NULL));
CREATE INDEX rental_equipment_status_idx ON public.rental_equipment USING btree (tenant_id, status) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX rental_equipment_tag_uk ON public.rental_equipment USING btree (tenant_id, lower(asset_tag)) WHERE (deleted_at IS NULL);

-- rental_equipment_movements
CREATE INDEX rental_equipment_movements_eq_idx ON public.rental_equipment_movements USING btree (tenant_id, equipment_id, created_at DESC);

-- rental_invoice_items
CREATE INDEX rental_invoice_items_invoice_idx ON public.rental_invoice_items USING btree (tenant_id, invoice_id);

-- rental_invoices
CREATE UNIQUE INDEX rental_invoices_competencia_uk ON public.rental_invoices USING btree (contract_id, competence) WHERE ((deleted_at IS NULL) AND (status <> 'cancelled'::text));
CREATE UNIQUE INDEX rental_invoices_number_uk ON public.rental_invoices USING btree (tenant_id, lower(number)) WHERE (deleted_at IS NULL);
CREATE INDEX rental_invoices_status_idx ON public.rental_invoices USING btree (tenant_id, status, competence DESC) WHERE (deleted_at IS NULL);

-- request_throttle
CREATE INDEX request_throttle_janela ON public.request_throttle USING btree (janela_inicio);

-- service_approvals
CREATE INDEX idx_service_approvals_pendentes ON public.service_approvals USING btree (tenant_id, requested_at) WHERE (status = 'pendente'::text);

-- service_catalog
CREATE INDEX idx_sc_ativos ON public.service_catalog USING btree (tenant_id, sort_order, name) WHERE (is_active AND (deleted_at IS NULL));

-- sla_contracts
CREATE INDEX idx_slac_lookup ON public.sla_contracts USING btree (tenant_id, client_id, branch_id) WHERE is_active;

-- sla_definitions
CREATE UNIQUE INDEX uq_slad_combo ON public.sla_definitions USING btree (tenant_id, COALESCE(contract_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid), priority_id) WHERE (deleted_at IS NULL);

-- sla_pauses
CREATE INDEX idx_sla_pauses_ticket ON public.sla_pauses USING btree (ticket_id, started_at DESC);
CREATE UNIQUE INDEX uq_sla_pause_open ON public.sla_pauses USING btree (ticket_id) WHERE (ended_at IS NULL);

-- sla_tracking
CREATE INDEX idx_sla_tracking_breached ON public.sla_tracking USING btree (tenant_id) WHERE (resolution_breached OR response_breached);
CREATE INDEX idx_sla_tracking_definition ON public.sla_tracking USING btree (sla_definition_id) WHERE (resolved_at IS NULL);
CREATE INDEX idx_sla_tracking_due ON public.sla_tracking USING btree (tenant_id, resolution_due_at) WHERE (NOT resolution_breached);

-- supplier_contracts
CREATE INDEX idx_supplier_contracts ON public.supplier_contracts USING btree (tenant_id, supplier_id) WHERE is_active;

-- suppliers
CREATE INDEX idx_suppliers_services ON public.suppliers USING gin (services);
CREATE INDEX idx_suppliers_tenant ON public.suppliers USING btree (tenant_id) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX uq_supplier_cnpj ON public.suppliers USING btree (tenant_id, cnpj) WHERE ((cnpj IS NOT NULL) AND (deleted_at IS NULL));

-- telecom_line_attachments
CREATE INDEX idx_line_attachments ON public.telecom_line_attachments USING btree (line_id, kind, created_at DESC);

-- telecom_lines
CREATE INDEX idx_lines_area ON public.telecom_lines USING btree (tenant_id, company_area_id) WHERE ((deleted_at IS NULL) AND (company_area_id IS NOT NULL));
CREATE INDEX idx_lines_branch ON public.telecom_lines USING btree (tenant_id, branch_id, status) WHERE (deleted_at IS NULL);
CREATE INDEX idx_lines_contract_end ON public.telecom_lines USING btree (tenant_id, contract_end) WHERE ((contract_end IS NOT NULL) AND (deleted_at IS NULL) AND (status <> 'cancelled'::text));
CREATE INDEX idx_lines_cost ON public.telecom_lines USING btree (tenant_id, carrier, status) WHERE (deleted_at IS NULL);
CREATE INDEX idx_lines_filters ON public.telecom_lines USING btree (tenant_id, branch_id, carrier, status) WHERE (deleted_at IS NULL);
CREATE INDEX idx_lines_no_user ON public.telecom_lines USING btree (tenant_id, branch_id) WHERE ((assigned_user_id IS NULL) AND (status = 'active'::text) AND (deleted_at IS NULL));
CREATE INDEX idx_lines_pagina ON public.telecom_lines USING btree (tenant_id, phone_number, id) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX uq_line_number ON public.telecom_lines USING btree (tenant_id, phone_number) WHERE (deleted_at IS NULL);

-- tenant_status_events
CREATE INDEX idx_tenant_status_events ON public.tenant_status_events USING btree (tenant_id, created_at DESC);

-- ticket_assets
CREATE INDEX idx_ticket_assets_asset ON public.ticket_assets USING btree (asset_id);

-- ticket_attachments
CREATE INDEX idx_attachments_ticket ON public.ticket_attachments USING btree (ticket_id);
CREATE INDEX idx_ticket_attachments_kind ON public.ticket_attachments USING btree (ticket_id, kind);

-- ticket_categories
CREATE INDEX idx_categories_parent ON public.ticket_categories USING btree (parent_id);
CREATE UNIQUE INDEX uq_category_name ON public.ticket_categories USING btree (tenant_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

-- ticket_comments
CREATE INDEX idx_comments_ticket ON public.ticket_comments USING btree (ticket_id, created_at) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX uq_comment_external ON public.ticket_comments USING btree (tenant_id, ticket_id, external_id) WHERE (external_id IS NOT NULL);

-- ticket_field_service
CREATE INDEX ticket_field_service_equipment_idx ON public.ticket_field_service USING btree (tenant_id, equipment_id);

-- ticket_history
CREATE INDEX idx_ticket_history_tenant ON public.ticket_history USING btree (tenant_id, created_at DESC);
CREATE INDEX idx_ticket_history_ticket ON public.ticket_history USING btree (ticket_id, created_at DESC);

-- ticket_labor_entries
CREATE INDEX ticket_labor_entries_ticket_idx ON public.ticket_labor_entries USING btree (tenant_id, ticket_id);

-- ticket_parts_used
CREATE INDEX ticket_parts_used_part_idx ON public.ticket_parts_used USING btree (part_id) WHERE (part_id IS NOT NULL);
CREATE INDEX ticket_parts_used_ticket_idx ON public.ticket_parts_used USING btree (tenant_id, ticket_id);

-- ticket_priorities
CREATE INDEX idx_priorities_tenant ON public.ticket_priorities USING btree (tenant_id, sort_order);

-- ticket_telecom_lines
CREATE INDEX idx_ticket_lines_line ON public.ticket_telecom_lines USING btree (line_id);

-- tickets
CREATE INDEX idx_tickets_assignee ON public.tickets USING btree (tenant_id, assignee_id, status) WHERE ((deleted_at IS NULL) AND (status <> ALL (ARRAY['resolved'::text, 'closed'::text])));
CREATE INDEX idx_tickets_branch_open ON public.tickets USING btree (tenant_id, branch_id, status) WHERE ((deleted_at IS NULL) AND (status <> ALL (ARRAY['resolved'::text, 'closed'::text])));
CREATE INDEX idx_tickets_dashboard ON public.tickets USING btree (tenant_id, status, priority_id) WHERE ((deleted_at IS NULL) AND (status <> ALL (ARRAY['resolved'::text, 'closed'::text])));
CREATE INDEX idx_tickets_queue_open ON public.tickets USING btree (tenant_id, queue_id, created_at) WHERE ((deleted_at IS NULL) AND (status <> ALL (ARRAY['resolved'::text, 'closed'::text])));
CREATE INDEX idx_tickets_requester ON public.tickets USING btree (tenant_id, requester_id, created_at DESC) WHERE (deleted_at IS NULL);
CREATE INDEX idx_tickets_service ON public.tickets USING btree (tenant_id, service_id) WHERE ((service_id IS NOT NULL) AND (deleted_at IS NULL));
CREATE INDEX idx_tickets_supplier ON public.tickets USING btree (tenant_id, supplier_id) WHERE ((supplier_id IS NOT NULL) AND (deleted_at IS NULL));
CREATE INDEX idx_tickets_tags ON public.tickets USING gin (tags);
CREATE UNIQUE INDEX uq_ticket_external ON public.tickets USING btree (tenant_id, source_system, external_id) WHERE ((external_id IS NOT NULL) AND (deleted_at IS NULL));

-- user_branches
CREATE INDEX idx_user_branches_branch ON public.user_branches USING btree (branch_id);
CREATE UNIQUE INDEX uq_user_branches_primary ON public.user_branches USING btree (user_id) WHERE is_primary;
