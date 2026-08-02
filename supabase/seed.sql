-- =============================================================================
-- Seed de demonstração — tenant "IAR Office" com dados realistas
-- =============================================================================
-- Em produção os usuários nascem no Supabase Auth (signup/convite) e o trigger de
-- provisionamento cria o profile. Aqui inserimos em auth.users diretamente porque
-- é ambiente local de desenvolvimento e queremos um dataset navegável.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Tenant
-- -----------------------------------------------------------------------------
insert into public.tenants (id, name, slug, cnpj) values
  ('a0000000-0000-4000-8000-000000000001', 'IAR Office Soluções', 'iaroffice', '12.345.678/0001-90');

-- -----------------------------------------------------------------------------
-- Calendário de atendimento: comercial 08–12 / 13–18, seg a sex
-- -----------------------------------------------------------------------------
insert into public.business_hours (id, tenant_id, name, timezone, is_default) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'Comercial (seg–sex)', 'America/Sao_Paulo', true),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   '24x7', 'America/Sao_Paulo', false);

update public.business_hours set is_24x7 = true where id = 'b0000000-0000-4000-8000-000000000002';

insert into public.business_hours_intervals (business_hours_id, weekday, starts_at, ends_at)
select 'b0000000-0000-4000-8000-000000000001', d, s, e
from generate_series(1, 5) as d,
     (values ('08:00'::time, '12:00'::time), ('13:00'::time, '18:00'::time)) as v(s, e);

insert into public.business_hours_holidays (business_hours_id, holiday_date, name) values
  ('b0000000-0000-4000-8000-000000000001', '2026-09-07', 'Independência'),
  ('b0000000-0000-4000-8000-000000000001', '2026-10-12', 'Nossa Senhora Aparecida'),
  ('b0000000-0000-4000-8000-000000000001', '2026-11-02', 'Finados'),
  ('b0000000-0000-4000-8000-000000000001', '2026-11-15', 'Proclamação da República'),
  ('b0000000-0000-4000-8000-000000000001', '2026-12-25', 'Natal');

-- -----------------------------------------------------------------------------
-- Prioridades — o `weight` alimenta o score de fila (RF-FIL-03)
-- -----------------------------------------------------------------------------
insert into public.ticket_priorities (id, tenant_id, key, label, weight, color, sort_order) values
  ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'critical', 'Crítica', 100, '#dc2626', 1),
  ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'high',     'Alta',     75, '#ea580c', 2),
  ('c0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'medium',   'Média',    45, '#ca8a04', 3),
  ('c0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'low',      'Baixa',    20, '#0891b2', 4);

-- -----------------------------------------------------------------------------
-- Categorias e subcategorias
-- -----------------------------------------------------------------------------
insert into public.ticket_categories (id, tenant_id, parent_id, name) values
  ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null, 'Infraestrutura'),
  ('d0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', null, 'Sistemas'),
  ('d0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', null, 'Telefonia'),
  ('d0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', null, 'Acessos');

insert into public.ticket_categories (id, tenant_id, parent_id, name) values
  ('d0000000-0000-4000-8000-000000000011', 'a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'Rede / Internet'),
  ('d0000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'Servidores'),
  ('d0000000-0000-4000-8000-000000000013', 'a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', 'ERP'),
  ('d0000000-0000-4000-8000-000000000014', 'a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000003', 'Linha móvel'),
  ('d0000000-0000-4000-8000-000000000015', 'a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000004', 'Reset de senha');

-- -----------------------------------------------------------------------------
-- Filas — a primeira é a padrão do sistema, protegida por trigger (RF-FIL-01)
-- -----------------------------------------------------------------------------
insert into public.queues (id, tenant_id, name, slug, description, is_system_default) values
  ('e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'Atendimento Geral', 'geral', 'Fila padrão do sistema. Recebe todo ticket sem roteamento específico.', true);

insert into public.queues (id, tenant_id, name, slug, description, weight_criticality, weight_deadline, weight_age) values
  ('e0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'Infraestrutura', 'infra', 'Rede, servidores e datacenter.', 70, 25, 5),
  ('e0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001',
   'Telefonia', 'telefonia', 'Linhas móveis e fixas.', 50, 30, 20);

-- Roteamento: categoria Telefonia → fila Telefonia; Infraestrutura → fila Infra.
insert into public.queue_rules (tenant_id, queue_id, name, conditions, sort_order) values
  ('a0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000003',
   'Telefonia por categoria',
   '{"category_id":"d0000000-0000-4000-8000-000000000003"}'::jsonb, 10),
  ('a0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002',
   'Infra por categoria',
   '{"category_id":"d0000000-0000-4000-8000-000000000001"}'::jsonb, 20);

-- -----------------------------------------------------------------------------
-- Clientes e filiais
-- -----------------------------------------------------------------------------
insert into public.clients (id, tenant_id, legal_name, trade_name, cnpj) values
  ('f0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'Grupo Meridiano Alimentos S.A.', 'Meridiano', '11.222.333/0001-44'),
  ('f0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'Construtora Vertex Ltda.', 'Vertex', '55.666.777/0001-88');

insert into public.branches (id, tenant_id, client_id, name, code, city, state, timezone, business_hours_id) values
  ('11110000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
   'Meridiano — Matriz São Paulo', 'MER-SP', 'São Paulo', 'SP', 'America/Sao_Paulo', 'b0000000-0000-4000-8000-000000000001'),
  ('11110000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
   'Meridiano — CD Campinas', 'MER-CPQ', 'Campinas', 'SP', 'America/Sao_Paulo', 'b0000000-0000-4000-8000-000000000001'),
  ('11110000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
   'Meridiano — Filial Manaus', 'MER-MAO', 'Manaus', 'AM', 'America/Manaus', 'b0000000-0000-4000-8000-000000000002'),
  ('11110000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002',
   'Vertex — Sede', 'VTX-SED', 'Belo Horizonte', 'MG', 'America/Sao_Paulo', 'b0000000-0000-4000-8000-000000000001');

-- -----------------------------------------------------------------------------
-- Usuários
-- -----------------------------------------------------------------------------
-- O claim tenant_id vai em app_metadata (ADR-002) — nunca em user_metadata.
insert into auth.users (id, email, raw_app_meta_data) values
  ('22220000-0000-4000-8000-000000000001', 'admin@iaroffice.com.br',
   '{"tenant_id":"a0000000-0000-4000-8000-000000000001"}'::jsonb),
  ('22220000-0000-4000-8000-000000000002', 'gestor@iaroffice.com.br',
   '{"tenant_id":"a0000000-0000-4000-8000-000000000001"}'::jsonb),
  ('22220000-0000-4000-8000-000000000003', 'ana.atendente@iaroffice.com.br',
   '{"tenant_id":"a0000000-0000-4000-8000-000000000001"}'::jsonb),
  ('22220000-0000-4000-8000-000000000004', 'bruno.atendente@iaroffice.com.br',
   '{"tenant_id":"a0000000-0000-4000-8000-000000000001"}'::jsonb),
  ('22220000-0000-4000-8000-000000000005', 'carla.solicitante@meridiano.com.br',
   '{"tenant_id":"a0000000-0000-4000-8000-000000000001"}'::jsonb);

insert into public.profiles (id, tenant_id, role, full_name, email, last_seen_at) values
  ('22220000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'admin',       'Administrador IAR', 'admin@iaroffice.com.br', now()),
  ('22220000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'gestor',      'Gestor de Serviços', 'gestor@iaroffice.com.br', now()),
  ('22220000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'atendente',   'Ana Souza',          'ana.atendente@iaroffice.com.br', now()),
  ('22220000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'atendente',   'Bruno Lima',         'bruno.atendente@iaroffice.com.br', now() - interval '2 hours'),
  ('22220000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'solicitante', 'Carla Dias',         'carla.solicitante@meridiano.com.br', null);

-- Ana vê 2 filiais; Bruno vê apenas Manaus. É esse contraste que exercita o ADR-003.
insert into public.user_branches (user_id, branch_id, tenant_id, is_primary) values
  ('22220000-0000-4000-8000-000000000003', '11110000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', true),
  ('22220000-0000-4000-8000-000000000003', '11110000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', false),
  ('22220000-0000-4000-8000-000000000004', '11110000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', true),
  ('22220000-0000-4000-8000-000000000005', '11110000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', true);

insert into public.queue_members (queue_id, user_id, tenant_id, is_lead) values
  ('e0000000-0000-4000-8000-000000000001', '22220000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', true),
  ('e0000000-0000-4000-8000-000000000001', '22220000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', false),
  ('e0000000-0000-4000-8000-000000000002', '22220000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', true);

-- -----------------------------------------------------------------------------
-- SLA — contrato do cliente + sobrescrita de filial + padrão do tenant
-- -----------------------------------------------------------------------------
insert into public.sla_contracts (id, tenant_id, client_id, branch_id, name, business_hours_id) values
  ('33330000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-000000000001', null, 'Meridiano — Padrão', 'b0000000-0000-4000-8000-000000000001'),
  -- Manaus opera 24x7: sobrescreve o contrato do grupo (RF-SLA-07)
  ('33330000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-000000000001', '11110000-0000-4000-8000-000000000003', 'Meridiano — Manaus 24x7',
   'b0000000-0000-4000-8000-000000000002');

-- Padrão do tenant (contract_id NULL): rede de segurança para qualquer combinação.
insert into public.sla_definitions (tenant_id, contract_id, category_id, priority_id,
                                    first_response_minutes, resolution_minutes, business_hours_id)
values
  ('a0000000-0000-4000-8000-000000000001', null, null, 'c0000000-0000-4000-8000-000000000001',  15,  240, 'b0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000001', null, null, 'c0000000-0000-4000-8000-000000000002',  60,  480, 'b0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000001', null, null, 'c0000000-0000-4000-8000-000000000003', 240, 1440, 'b0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000001', null, null, 'c0000000-0000-4000-8000-000000000004', 480, 2880, 'b0000000-0000-4000-8000-000000000001');

-- Contrato Meridiano: mais agressivo em crítica/alta.
insert into public.sla_definitions (tenant_id, contract_id, category_id, priority_id,
                                    first_response_minutes, resolution_minutes)
values
  ('a0000000-0000-4000-8000-000000000001', '33330000-0000-4000-8000-000000000001', null, 'c0000000-0000-4000-8000-000000000001', 10, 120),
  ('a0000000-0000-4000-8000-000000000001', '33330000-0000-4000-8000-000000000001', null, 'c0000000-0000-4000-8000-000000000002', 30, 360),
  -- Infra crítica no Meridiano é ainda mais apertada (contrato + categoria)
  ('a0000000-0000-4000-8000-000000000001', '33330000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 5, 60),
  -- Manaus 24x7
  ('a0000000-0000-4000-8000-000000000001', '33330000-0000-4000-8000-000000000002', null, 'c0000000-0000-4000-8000-000000000001', 15, 180);

-- -----------------------------------------------------------------------------
-- Fornecedores
-- -----------------------------------------------------------------------------
insert into public.suppliers (id, tenant_id, name, legal_name, cnpj, email, services, rating) values
  ('44440000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'NetLink Telecom',
   'NetLink Telecomunicações Ltda.', '99.888.777/0001-66', 'suporte@netlink.com.br',
   array['link dedicado','MPLS','telefonia'], 4.2),
  ('44440000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'TechParts Assistência',
   'TechParts Comércio e Serviços Ltda.', '88.777.666/0001-55', 'os@techparts.com.br',
   array['manutenção de hardware','garantia estendida'], 3.8);

insert into public.supplier_contracts (tenant_id, supplier_id, contract_number, description,
                                       starts_on, monthly_cost, response_sla_minutes, resolution_sla_minutes)
values
  ('a0000000-0000-4000-8000-000000000001', '44440000-0000-4000-8000-000000000001', 'NL-2026-001',
   'Link dedicado 500Mb matriz + backup', '2026-01-01', 4800.00, 30, 240),
  ('a0000000-0000-4000-8000-000000000001', '44440000-0000-4000-8000-000000000002', 'TP-2026-014',
   'Manutenção corretiva de notebooks', '2026-03-01', 1200.00, 240, 2880);

-- -----------------------------------------------------------------------------
-- Inventário de TI
-- -----------------------------------------------------------------------------
insert into public.it_assets (tenant_id, asset_tag, serial_number, asset_type, brand, model,
                              status, branch_id, assigned_user_id, supplier_id,
                              acquisition_date, warranty_until, acquisition_cost)
values
  ('a0000000-0000-4000-8000-000000000001', 'PAT-001042', 'SN-DELL-77A1', 'notebook', 'Dell', 'Latitude 5450',
   'active', '11110000-0000-4000-8000-000000000001', '22220000-0000-4000-8000-000000000005',
   '44440000-0000-4000-8000-000000000002', '2025-04-10', '2028-04-10', 6890.00),
  ('a0000000-0000-4000-8000-000000000001', 'PAT-001043', 'SN-DELL-77A2', 'notebook', 'Dell', 'Latitude 5450',
   'active', '11110000-0000-4000-8000-000000000001', '22220000-0000-4000-8000-000000000003',
   '44440000-0000-4000-8000-000000000002', '2025-04-10', '2028-04-10', 6890.00),
  ('a0000000-0000-4000-8000-000000000001', 'PAT-002001', 'SN-HPE-DL380-01', 'server', 'HPE', 'ProLiant DL380 Gen11',
   'active', '11110000-0000-4000-8000-000000000002', null, null, '2024-08-01', '2029-08-01', 48200.00),
  ('a0000000-0000-4000-8000-000000000001', 'PAT-003011', 'SN-SAM-A55-11', 'smartphone', 'Samsung', 'Galaxy A55',
   'active', '11110000-0000-4000-8000-000000000003', '22220000-0000-4000-8000-000000000004',
   null, '2025-11-20', '2026-11-20', 2199.00),
  ('a0000000-0000-4000-8000-000000000001', 'PAT-004002', null, 'software_license', 'Microsoft', 'M365 Business Premium',
   'active', '11110000-0000-4000-8000-000000000001', null, null, '2026-01-01', '2027-01-01', 0.00),
  ('a0000000-0000-4000-8000-000000000001', 'PAT-001099', 'SN-LEN-T14-09', 'notebook', 'Lenovo', 'ThinkPad T14',
   'maintenance', '11110000-0000-4000-8000-000000000002', null,
   '44440000-0000-4000-8000-000000000002', '2023-02-15', '2026-02-15', 5400.00);

-- -----------------------------------------------------------------------------
-- Linhas telefônicas
-- -----------------------------------------------------------------------------
insert into public.telecom_lines (tenant_id, phone_number, carrier, plan_name, line_type, status,
                                  branch_id, assigned_user_id, device_asset_id,
                                  monthly_cost, activated_on, loyalty_until)
select
  'a0000000-0000-4000-8000-000000000001', v.num, v.carrier, v.plan, v.ltype, v.status,
  v.branch, v.usr,
  (select id from public.it_assets where asset_tag = 'PAT-003011'),
  v.cost, v.act, v.loyal
from (values
  ('+55 11 98800-1001', 'Vivo',  'Controle 20GB', 'control',  'active',    '11110000-0000-4000-8000-000000000001'::uuid, '22220000-0000-4000-8000-000000000003'::uuid,  79.90, '2025-06-01'::date, '2026-06-01'::date),
  ('+55 11 98800-1002', 'Vivo',  'Pós 50GB',      'postpaid', 'active',    '11110000-0000-4000-8000-000000000001'::uuid, null,                                          129.90, '2025-06-01'::date, '2026-06-01'::date),
  ('+55 19 98800-2001', 'Claro', 'Pós 30GB',      'postpaid', 'active',    '11110000-0000-4000-8000-000000000002'::uuid, null,                                           99.90, '2024-09-15'::date, null),
  ('+55 92 98800-3001', 'TIM',   'Pós 100GB',     'postpaid', 'active',    '11110000-0000-4000-8000-000000000003'::uuid, '22220000-0000-4000-8000-000000000004'::uuid, 189.90, '2025-11-20'::date, '2027-11-20'::date),
  ('+55 92 98800-3002', 'TIM',   'Pré',           'prepaid',  'suspended', '11110000-0000-4000-8000-000000000003'::uuid, null,                                            0.00, '2024-01-10'::date, null)
) as v(num, carrier, plan, ltype, status, branch, usr, cost, act, loyal);

-- Uma linha cancelada, para o relatório de custos ter histórico.
insert into public.telecom_lines (tenant_id, phone_number, carrier, plan_name, line_type, status,
                                  branch_id, monthly_cost, activated_on, cancelled_on)
values ('a0000000-0000-4000-8000-000000000001', '+55 31 98800-4001', 'Claro', 'Pós 20GB', 'postpaid',
        'cancelled', '11110000-0000-4000-8000-000000000004', 89.90, '2023-05-01', '2026-05-31');

-- -----------------------------------------------------------------------------
-- Dashboard de TV
-- -----------------------------------------------------------------------------
insert into public.dashboard_layouts (id, tenant_id, name, slug, is_default, refresh_seconds, config) values
  ('55550000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'War Room — Operação', 'war-room', true, 45,
   '{"tiles":["open_total","in_progress_total","critical_total","sla_at_risk","sla_breached","agents_online","avg_resolution_minutes_24h","resolved_today"],"featured_queue":"geral","theme":"dark"}'::jsonb);

-- Token de demonstração. Segredo em claro: "demo-tv-token-iaroffice" (ADR-006 — em
-- produção o valor é gerado aleatoriamente e exibido uma única vez).
insert into public.dashboard_tokens (tenant_id, layout_id, name, token_hash, created_by) values
  ('a0000000-0000-4000-8000-000000000001', '55550000-0000-4000-8000-000000000001',
   'TV Recepção Matriz',
   encode(digest('demo-tv-token-iaroffice', 'sha256'), 'hex'),
   '22220000-0000-4000-8000-000000000001');

-- -----------------------------------------------------------------------------
-- Integração Bitrix24 (RF-INT-08)
-- -----------------------------------------------------------------------------
-- Token inbound de demonstração em claro: "demo-bitrix-app-token".
insert into public.integrations (id, tenant_id, name, slug, source_system, direction, status,
                                 auth_type, secret_ref, inbound_token_hash, base_url, config)
values
  ('66660000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'Bitrix24 — Tarefas', 'bitrix24-tarefas', 'bitrix24', 'bidirectional', 'active',
   'webhook_token',
   'BITRIX24_INBOUND_WEBHOOK_URL',                                 -- nome do secret, não o valor (ADR-009)
   encode(digest('demo-bitrix-app-token', 'sha256'), 'hex'),
   'https://exemplo.bitrix24.com.br',
   '{"default_queue_slug":"geral","default_priority_key":"medium","default_branch_code":"MER-SP"}'::jsonb);

-- Mapeamento Bitrix24 → SaaS (seção 4.2.2 do escopo)
insert into public.integration_mappings (tenant_id, integration_id, source_path, target_field, transform, value_map, is_required)
values
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'TITLE',          'title',        'direct',        '{}'::jsonb, true),
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'DESCRIPTION',    'description',  'html_to_text',  '{}'::jsonb, false),
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'CREATED_DATE',   'created_at',   'datetime',      '{}'::jsonb, false),
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'DEADLINE',       'deadline',     'datetime',      '{}'::jsonb, false),
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'RESPONSIBLE_ID', 'assignee_id',  'user_by_external_id', '{}'::jsonb, false),
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'CREATED_BY',     'requester_id', 'user_by_external_id', '{}'::jsonb, false),
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'GROUP_ID',       'queue_id',     'queue_by_external_id', '{}'::jsonb, false),
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'TAGS',           'tags',         'direct',        '{}'::jsonb, false),
  -- Bitrix24: PRIORITY 2=alta, 1=média, 0=baixa
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'PRIORITY',       'priority_key', 'value_map',
   '{"2":"high","1":"medium","0":"low"}'::jsonb, false),
  -- Bitrix24: STATUS 2=pendente, 3=em execução, 4=aguardando controle, 5=concluída, 6=adiada, 7=recusada
  ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001', 'STATUS',         'status',       'value_map',
   '{"2":"open","3":"in_progress","4":"waiting_third_party","5":"resolved","6":"waiting_requester","7":"closed"}'::jsonb, false);

-- -----------------------------------------------------------------------------
-- Tickets de demonstração
-- -----------------------------------------------------------------------------
insert into public.tickets (tenant_id, title, description, status, priority_id, category_id, queue_id,
                            branch_id, requester_id, assignee_id, created_at, tags)
values
  ('a0000000-0000-4000-8000-000000000001', 'Link de internet da matriz oscilando',
   'Desde as 08h a conexão cai a cada poucos minutos. Afeta todo o andar comercial.',
   'in_progress', 'c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000011',
   'e0000000-0000-4000-8000-000000000002', '11110000-0000-4000-8000-000000000001',
   '22220000-0000-4000-8000-000000000005', '22220000-0000-4000-8000-000000000003',
   now() - interval '3 hours', array['rede','urgente']),

  ('a0000000-0000-4000-8000-000000000001', 'ERP lento ao emitir nota fiscal',
   'Emissão leva mais de 2 minutos por nota.',
   'assigned', 'c0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000013',
   'e0000000-0000-4000-8000-000000000001', '11110000-0000-4000-8000-000000000001',
   '22220000-0000-4000-8000-000000000005', '22220000-0000-4000-8000-000000000003',
   now() - interval '1 day', array['erp']),

  ('a0000000-0000-4000-8000-000000000001', 'Solicitação de reset de senha',
   'Usuário bloqueado após tentativas.',
   'open', 'c0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000015',
   'e0000000-0000-4000-8000-000000000001', '11110000-0000-4000-8000-000000000001',
   '22220000-0000-4000-8000-000000000005', null,
   now() - interval '20 minutes', array['acesso']),

  ('a0000000-0000-4000-8000-000000000001', 'Linha +55 92 98800-3001 sem sinal de dados',
   'Aparelho sem 4G desde ontem à noite.',
   'waiting_third_party', 'c0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000014',
   'e0000000-0000-4000-8000-000000000003', '11110000-0000-4000-8000-000000000003',
   null, '22220000-0000-4000-8000-000000000004',
   now() - interval '2 days', array['telefonia']),

  ('a0000000-0000-4000-8000-000000000001', 'Servidor de arquivos com disco cheio',
   'Volume /dados em 96% de uso.',
   'open', 'c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000012',
   'e0000000-0000-4000-8000-000000000002', '11110000-0000-4000-8000-000000000002',
   null, null,
   now() - interval '5 days', array['servidor','capacidade']),

  ('a0000000-0000-4000-8000-000000000001', 'Troca de notebook — colaborador novo',
   'Preparar equipamento com imagem padrão.',
   'resolved', 'c0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000002',
   'e0000000-0000-4000-8000-000000000001', '11110000-0000-4000-8000-000000000001',
   '22220000-0000-4000-8000-000000000005', '22220000-0000-4000-8000-000000000003',
   now() - interval '4 days', array['hardware']);

-- Vincula o ticket de rede ao servidor e o de telefonia à linha (RF-INV-03).
insert into public.ticket_assets (ticket_id, asset_id, tenant_id)
select t.id, a.id, t.tenant_id
from public.tickets t, public.it_assets a
where t.title = 'Servidor de arquivos com disco cheio' and a.asset_tag = 'PAT-002001';

insert into public.ticket_telecom_lines (ticket_id, line_id, tenant_id)
select t.id, l.id, t.tenant_id
from public.tickets t, public.telecom_lines l
where t.title like 'Linha +55 92%' and l.phone_number = '+55 92 98800-3001';

-- Comentários
insert into public.ticket_comments (tenant_id, ticket_id, author_id, body, visibility)
select t.tenant_id, t.id, '22220000-0000-4000-8000-000000000003',
       'Abrimos chamado na operadora sob protocolo 884512. Aguardando retorno.', 'public'
from public.tickets t where t.title = 'Link de internet da matriz oscilando';

insert into public.ticket_comments (tenant_id, ticket_id, author_id, body, visibility)
select t.tenant_id, t.id, '22220000-0000-4000-8000-000000000003',
       'Verificar se o contrato NL-2026-001 cobre SLA de 4h — cliente vai cobrar.', 'internal'
from public.tickets t where t.title = 'Link de internet da matriz oscilando';

commit;
