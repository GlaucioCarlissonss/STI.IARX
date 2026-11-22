-- =============================================================================
-- 05 — VIEWS  (37)
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

-- TODA VIEW LEVA `security_invoker = true`, e isso não é zelo.
--
-- Sem ele a view roda com o privilégio de QUEM A CRIOU. O dono é
-- `postgres`, que tem `bypassrls`: a view devolveria as linhas de todas as
-- empresas para qualquer um que a consultasse. É o vazamento mais
-- silencioso deste schema, porque a view continua funcionando — só que
-- demais. `conferir-producao.sql` cobra isso de cada uma.


-- asset_custody_history
create view public.asset_custody_history with (security_invoker = true) as
 SELECT aa.id,
    aa.tenant_id,
    aa.asset_id,
    a.asset_tag,
    a.model,
    a.asset_type,
    aa.previous_user_id,
    pu.full_name AS previous_user_name,
    aa.user_id AS current_user_id,
    cu.full_name AS current_user_name,
    aa.previous_branch_id,
    aa.branch_id,
    aa.previous_area_id,
    aa.branch_area_id,
    aa.event_type,
    aa.reason,
    aa.reason_note,
    aa.performed_by,
    pb.full_name AS performed_by_name,
    aa.started_at AS changed_at
   FROM asset_assignments aa
     JOIN it_assets a ON a.id = aa.asset_id
     LEFT JOIN profiles pu ON pu.id = aa.previous_user_id
     LEFT JOIN profiles cu ON cu.id = aa.user_id
     LEFT JOIN profiles pb ON pb.id = aa.performed_by
  WHERE aa.event_type = ANY (ARRAY['assignment'::text, 'relocation'::text, 'return'::text, 'retirement'::text, 'loss'::text]);

-- vw_agent_fleet
create view public.vw_agent_fleet with (security_invoker = true) as
 SELECT d.id AS device_id,
    d.tenant_id,
    d.branch_id,
    d.device_uuid,
    d.hostname,
    d.os,
    d.os_version,
    d.chassis,
    d.agent_version,
    d.it_asset_id,
    d.match_method,
    d.divergences,
    d.remote_id,
    d.last_seen_at,
    d.last_snapshot_at,
    a.asset_tag,
    a.serial_number,
    a.brand,
    a.model,
    b.name AS branch_name,
    d.last_seen_at IS NULL OR d.last_seen_at < (now() - make_interval(hours => t.agent_mute_hours)) AS silencioso,
    d.divergences <> '{}'::jsonb AS tem_divergencia,
    ( SELECT count(*) AS count
           FROM agent_software s
          WHERE s.device_id = d.id) AS software_count,
    ( SELECT count(*) AS count
           FROM agent_alerts al
          WHERE al.device_id = d.id AND al.fechado_em IS NULL) AS alertas_abertos,
    ( SELECT h.cpu_avg
           FROM agent_metrics_hourly h
          WHERE h.device_id = d.id
          ORDER BY h.hora DESC
         LIMIT 1) AS cpu_ultima_hora,
    ( SELECT h.mem_avg_pct
           FROM agent_metrics_hourly h
          WHERE h.device_id = d.id
          ORDER BY h.hora DESC
         LIMIT 1) AS mem_ultima_hora,
    ( SELECT round((v.total_bytes - v.livre_min_bytes)::numeric * 100::numeric / v.total_bytes::numeric) AS round
           FROM agent_volume_samples v
          WHERE v.device_id = d.id AND v.hora > (now() - '24:00:00'::interval)
          ORDER BY ((v.total_bytes - v.livre_min_bytes)::numeric / v.total_bytes::numeric) DESC
         LIMIT 1) AS disco_mais_cheio_pct
   FROM agent_devices d
     JOIN tenants t ON t.id = d.tenant_id
     LEFT JOIN it_assets a ON a.id = d.it_asset_id AND a.deleted_at IS NULL
     LEFT JOIN branches b ON b.id = d.branch_id
  WHERE d.revoked_at IS NULL;

-- vw_agent_software
create view public.vw_agent_software with (security_invoker = true) as
 SELECT s.tenant_id,
    s.name,
    max(s.publisher) AS publisher,
    count(DISTINCT s.device_id)::integer AS maquinas,
    count(DISTINCT s.version)::integer AS versoes,
    max(s.last_seen_at) AS visto_por_ultimo,
    count(DISTINCT s.device_id) FILTER (WHERE s.last_seen_at > (now() - '7 days'::interval))::integer AS maquinas_atuais
   FROM agent_software s
     JOIN agent_devices d ON d.id = s.device_id AND d.revoked_at IS NULL
  GROUP BY s.tenant_id, s.name;

-- vw_agents_online
create view public.vw_agents_online with (security_invoker = true) as
 SELECT tenant_id,
    count(*) FILTER (WHERE last_seen_at >= (now() - '00:05:00'::interval)) AS agents_online,
    count(*) AS agents_total
   FROM profiles p
  WHERE is_active AND (role = ANY (ARRAY['atendente'::text, 'gestor'::text, 'admin'::text]))
  GROUP BY tenant_id;

-- vw_ai_suggestions
create view public.vw_ai_suggestions with (security_invoker = true) as
 SELECT s.id,
    s.tenant_id,
    s.ticket_id,
    s.kind,
    s.payload,
    s.status,
    s.model,
    s.tokens_entrada,
    s.tokens_saida,
    s.custo_centavos,
    s.created_at,
    s.acted_at,
    pedinte.full_name AS requested_by_name,
    decisor.full_name AS acted_by_name,
    t.ticket_number,
    t.title AS ticket_title
   FROM ai_suggestions s
     JOIN tickets t ON t.id = s.ticket_id AND t.deleted_at IS NULL
     LEFT JOIN profiles pedinte ON pedinte.id = s.requested_by
     LEFT JOIN profiles decisor ON decisor.id = s.acted_by;

-- vw_assets_summary
create view public.vw_assets_summary with (security_invoker = true) as
 SELECT tenant_id,
    branch_id,
    status,
    count(*) AS ativos,
    COALESCE(sum(acquisition_cost), 0::numeric) AS valor_total,
    count(*) FILTER (WHERE warranty_until IS NOT NULL AND warranty_until >= CURRENT_DATE AND warranty_until <= (CURRENT_DATE + 90) AND status <> 'retired'::text) AS garantia_90d
   FROM it_assets a
  WHERE deleted_at IS NULL
  GROUP BY tenant_id, branch_id, status;

-- vw_assinatura
create view public.vw_assinatura with (security_invoker = true) as
 SELECT id AS tenant_id,
    name,
    status,
    trial_ends_on,
    app.tenant_em_vigencia(status, trial_ends_on) AS em_vigencia,
        CASE
            WHEN status = 'trial'::text AND trial_ends_on IS NOT NULL THEN trial_ends_on - CURRENT_DATE
            ELSE NULL::integer
        END AS dias_restantes,
    plano_id,
    created_at
   FROM tenants t;

-- vw_bank_account_balances
create view public.vw_bank_account_balances with (security_invoker = true) as
 SELECT a.id AS bank_account_id,
    a.tenant_id,
    a.name,
    a.bank_name,
    a.account_type,
    a.status,
    a.opening_balance,
    a.credit_limit,
    COALESCE(sum(
        CASE
            WHEN m.direction = 'in'::text THEN m.amount
            ELSE NULL::numeric
        END), 0::numeric) AS total_in,
    COALESCE(sum(
        CASE
            WHEN m.direction = 'out'::text THEN m.amount
            ELSE NULL::numeric
        END), 0::numeric) AS total_out,
    a.opening_balance + COALESCE(sum(
        CASE
            WHEN m.direction = 'in'::text THEN m.amount
            ELSE NULL::numeric
        END), 0::numeric) - COALESCE(sum(
        CASE
            WHEN m.direction = 'out'::text THEN m.amount
            ELSE NULL::numeric
        END), 0::numeric) AS current_balance,
    count(m.id) FILTER (WHERE m.reconciled_at IS NULL) AS unreconciled_count,
    max(m.moved_on) AS last_movement_on
   FROM bank_accounts a
     LEFT JOIN bank_account_movements m ON m.bank_account_id = a.id
  WHERE a.deleted_at IS NULL
  GROUP BY a.id, a.tenant_id, a.name, a.bank_name, a.account_type, a.status, a.opening_balance, a.credit_limit;

-- vw_branch_addresses
create view public.vw_branch_addresses with (security_invoker = true) as
 SELECT b.tenant_id,
    b.id AS branch_id,
    b.name AS branch_name,
    b.client_id,
    COALESCE(c.trade_name, c.legal_name) AS client_name,
    b.street,
    b.street_number,
    b.address_complement,
    b.district,
    b.city,
    b.state,
    b.postal_code,
    fn_format_address(b.street, b.street_number, b.address_complement, b.district, b.city, b.state::text, b.postal_code) AS address_formatted,
    b.address_complete,
    b.latitude,
    b.longitude,
    b.geocode_precision,
    b.geocoded_address,
    b.place_id,
    b.geocode_status,
    b.geocode_stale,
    b.geocode_verified_at,
    b.geocode_provider,
    ( SELECT count(*) AS count
           FROM geocode_candidates gc
          WHERE gc.branch_id = b.id) AS pending_candidates,
    ( SELECT l.message
           FROM geocode_logs l
          WHERE l.branch_id = b.id
          ORDER BY l.created_at DESC
         LIMIT 1) AS last_message,
    ( SELECT l.created_at
           FROM geocode_logs l
          WHERE l.branch_id = b.id
          ORDER BY l.created_at DESC
         LIMIT 1) AS last_attempt_at
   FROM branches b
     JOIN clients c ON c.id = b.client_id
  WHERE b.deleted_at IS NULL;

-- vw_branch_last_geocode_log
create view public.vw_branch_last_geocode_log with (security_invoker = true) as
 SELECT DISTINCT ON (branch_id) tenant_id,
    branch_id,
    status,
    report_text,
    message,
    created_at
   FROM geocode_logs
  ORDER BY branch_id, created_at DESC;

-- vw_channel_conversations
create view public.vw_channel_conversations with (security_invoker = true) as
 SELECT c.id AS conversation_id,
    c.tenant_id,
    c.status,
    c.last_message_at,
    c.ticket_id,
    ch.id AS channel_id,
    ch.name AS channel_name,
    ch.kind AS channel_kind,
    ct.id AS contact_id,
    ct.external_id AS contact_external_id,
    ct.display_name AS contact_name,
    ct.bloqueado AS contact_bloqueado,
    ct.profile_id,
    p.full_name AS profile_name,
    cl.trade_name AS client_name,
    t.ticket_number,
    t.title AS ticket_title,
    t.status AS ticket_status,
    ( SELECT count(*) AS count
           FROM channel_messages m
          WHERE m.conversation_id = c.id) AS mensagens,
    ( SELECT count(*) AS count
           FROM channel_messages m
          WHERE m.conversation_id = c.id AND m.status = 'falhou'::text) AS falhas
   FROM channel_conversations c
     JOIN channels ch ON ch.id = c.channel_id
     JOIN channel_contacts ct ON ct.id = c.contact_id
     LEFT JOIN profiles p ON p.id = ct.profile_id
     LEFT JOIN clients cl ON cl.id = ct.client_id
     LEFT JOIN tickets t ON t.id = c.ticket_id AND t.deleted_at IS NULL;

-- vw_connectivity_cost
create view public.vw_connectivity_cost with (security_invoker = true) as
 SELECT b.tenant_id,
    b.id AS branch_id,
    b.name AS branch_name,
    b.city,
    b.state,
    COALESCE(tel.lines_active, 0::bigint) AS lines_active,
    COALESCE(tel.lines_cost, 0::numeric) AS telecom_monthly_cost,
    COALESCE(net.links_active, 0::bigint) AS links_active,
    COALESCE(net.links_cost, 0::numeric) AS internet_monthly_cost,
    COALESCE(tel.lines_cost, 0::numeric) + COALESCE(net.links_cost, 0::numeric) AS total_monthly_cost
   FROM branches b
     LEFT JOIN ( SELECT telecom_lines.branch_id,
            count(*) AS lines_active,
            sum(COALESCE(telecom_lines.monthly_cost, 0::numeric)) AS lines_cost
           FROM telecom_lines
          WHERE telecom_lines.status = 'active'::text AND telecom_lines.deleted_at IS NULL
          GROUP BY telecom_lines.branch_id) tel ON tel.branch_id = b.id
     LEFT JOIN ( SELECT internet_links.branch_id,
            count(*) AS links_active,
            sum(COALESCE(internet_links.monthly_cost, 0::numeric)) AS links_cost
           FROM internet_links
          WHERE internet_links.status = 'active'::text AND internet_links.deleted_at IS NULL
          GROUP BY internet_links.branch_id) net ON net.branch_id = b.id
  WHERE b.deleted_at IS NULL;

-- vw_dashboard_metrics
create view public.vw_dashboard_metrics with (security_invoker = true) as
 SELECT t.tenant_id,
    count(*) FILTER (WHERE t.status <> ALL (ARRAY['resolved'::text, 'closed'::text])) AS open_total,
    count(*) FILTER (WHERE t.status = 'open'::text) AS open_new,
    count(*) FILTER (WHERE t.status = ANY (ARRAY['assigned'::text, 'in_progress'::text])) AS in_progress_total,
    count(*) FILTER (WHERE t.status = ANY (ARRAY['waiting_requester'::text, 'waiting_third_party'::text])) AS waiting_total,
    count(*) FILTER (WHERE (t.status <> ALL (ARRAY['resolved'::text, 'closed'::text])) AND p.weight >= 80) AS critical_total,
    count(*) FILTER (WHERE (t.status <> ALL (ARRAY['resolved'::text, 'closed'::text])) AND st.resolution_due_at IS NOT NULL AND NOT st.resolution_breached AND now() >= (st.started_at + (st.resolution_due_at - st.started_at) * (tn.sla_warning_pct::numeric / 100.0)::double precision)) AS sla_at_risk,
    count(*) FILTER (WHERE (t.status <> ALL (ARRAY['resolved'::text, 'closed'::text])) AND (st.resolution_breached OR st.resolution_due_at IS NOT NULL AND now() > st.resolution_due_at)) AS sla_breached,
    count(*) FILTER (WHERE t.resolved_at >= date_trunc('day'::text, now())) AS resolved_today,
    count(*) FILTER (WHERE t.created_at >= date_trunc('day'::text, now())) AS created_today,
    round(avg(EXTRACT(epoch FROM t.resolved_at - t.created_at) / 60.0) FILTER (WHERE t.resolved_at >= (now() - '24:00:00'::interval)))::integer AS avg_resolution_minutes_24h
   FROM tickets t
     JOIN tenants tn ON tn.id = t.tenant_id
     JOIN ticket_priorities p ON p.id = t.priority_id
     LEFT JOIN sla_tracking st ON st.ticket_id = t.id
  WHERE t.deleted_at IS NULL
  GROUP BY t.tenant_id;

-- vw_email_outbox_resumo
create view public.vw_email_outbox_resumo with (security_invoker = true) as
 SELECT tenant_id,
    count(*) AS total,
    count(*) FILTER (WHERE status = 'pending'::text) AS pendentes,
    count(*) FILTER (WHERE status = 'sent'::text) AS enviadas,
    count(*) FILTER (WHERE status = 'failed'::text) AS falhadas,
    count(*) FILTER (WHERE status = 'skipped'::text) AS puladas,
    count(*) FILTER (WHERE status = 'pending'::text AND scheduled_for < (now() - '01:00:00'::interval)) AS paradas,
    max(created_at) AS ultima_entrada,
    max(sent_at) AS ultimo_envio
   FROM email_outbox o
  GROUP BY tenant_id;

-- vw_field_service_cost
create view public.vw_field_service_cost with (security_invoker = true) as
 SELECT ticket_id,
    tenant_id,
    equipment_id,
    contract_item_id,
    kind,
    billable_to,
    cost_limit,
    approved_at,
    COALESCE(( SELECT sum(l.amount) AS sum
           FROM ticket_labor_entries l
          WHERE l.ticket_id = f.ticket_id), 0::numeric) AS labor_cost,
    COALESCE(( SELECT sum(pu.amount) AS sum
           FROM ticket_parts_used pu
          WHERE pu.ticket_id = f.ticket_id), 0::numeric) AS parts_cost,
    COALESCE(( SELECT sum(l.amount) AS sum
           FROM ticket_labor_entries l
          WHERE l.ticket_id = f.ticket_id), 0::numeric) + COALESCE(( SELECT sum(pu.amount) AS sum
           FROM ticket_parts_used pu
          WHERE pu.ticket_id = f.ticket_id), 0::numeric) AS total_cost,
    COALESCE(( SELECT sum(l.hours) AS sum
           FROM ticket_labor_entries l
          WHERE l.ticket_id = f.ticket_id), 0::numeric) AS total_hours
   FROM ticket_field_service f;

-- vw_internet_dashboard
create view public.vw_internet_dashboard with (security_invoker = true) as
 SELECT k.tenant_id,
    k.branch_id,
    b.name AS branch_name,
    COALESCE(s.name, k.carrier_name) AS carrier,
    k.technology,
    k.status,
    count(*) AS links_count,
    COALESCE(sum(k.monthly_cost), 0::numeric) AS monthly_total,
    count(*) FILTER (WHERE k.last_state = 'down'::text) AS links_down,
    count(*) FILTER (WHERE k.last_state = 'unknown'::text) AS links_unknown,
    count(*) FILTER (WHERE k.status <> 'cancelled'::text AND k.contract_end IS NOT NULL AND k.contract_end <= (CURRENT_DATE + 90)) AS expiring_90d,
    count(*) FILTER (WHERE k.status <> 'cancelled'::text AND k.contract_end IS NOT NULL AND k.contract_end < CURRENT_DATE) AS expirados,
    count(*) FILTER (WHERE NOT (EXISTS ( SELECT 1
           FROM internet_link_attachments la
          WHERE la.link_id = k.id AND la.kind = 'contract'::text))) AS without_contract
   FROM internet_links k
     LEFT JOIN branches b ON b.id = k.branch_id
     LEFT JOIN suppliers s ON s.id = k.supplier_id
  WHERE k.deleted_at IS NULL
  GROUP BY k.tenant_id, k.branch_id, b.name, (COALESCE(s.name, k.carrier_name)), k.technology, k.status;

-- vw_it_budget_monthly
create view public.vw_it_budget_monthly with (security_invoker = true) as
 SELECT e.tenant_id,
    e.client_id,
    e.scenario_id,
    e.competence,
    e.expense_category_id,
    cat.name AS category_name,
    e.branch_id,
    b.name AS branch_name,
    sum(e.amount) AS total,
    sum(e.amount) FILTER (WHERE e.classificacao = 'despesa'::text) AS total_despesa,
    sum(e.amount) FILTER (WHERE e.classificacao = 'investimento'::text) AS total_investimento,
    sum(e.amount) FILTER (WHERE e.origem = 'manual'::text) AS total_manual,
    sum(e.amount) FILTER (WHERE e.origem = 'planilha'::text) AS total_planilha,
    sum(e.amount) FILTER (WHERE e.origem = 'projecao'::text) AS total_projecao,
    sum(e.amount) FILTER (WHERE e.origem = 'titulo_a_pagar'::text) AS total_titulos,
    sum(e.amount) FILTER (WHERE e.consumo = 'compartilhado'::text) AS total_compartilhado,
    count(*) AS lancamentos,
    sc.key AS scenario_key
   FROM it_cost_entries e
     JOIN expense_categories cat ON cat.id = e.expense_category_id
     JOIN it_budget_scenarios sc ON sc.id = e.scenario_id
     LEFT JOIN branches b ON b.id = e.branch_id
  WHERE e.deleted_at IS NULL
  GROUP BY e.tenant_id, e.client_id, e.scenario_id, e.competence, e.expense_category_id, cat.name, e.branch_id, b.name, sc.key;

-- vw_it_cost_entries
create view public.vw_it_cost_entries with (security_invoker = true) as
 SELECT e.id,
    e.tenant_id,
    e.client_id,
    e.branch_id,
    e.competence,
    e.amount,
    e.description,
    e.natureza,
    e.classificacao,
    e.consumo,
    e.origem,
    e.payable_id,
    e.installment_number,
    e.installment_total,
    e.recurrence_until,
    e.scenario_id,
    e.created_at,
    c.trade_name AS client_name,
    b.name AS branch_name,
    cat.name AS category_name,
    cc.name AS cost_center_name,
    s.name AS supplier_name,
    sc.key AS scenario_key,
    sc.name AS scenario_name,
    app.competencia_fechada(e.client_id, e.competence) AS competencia_fechada,
    ( SELECT count(*) AS count
           FROM it_cost_beneficiaries bn
          WHERE bn.entry_id = e.id) AS beneficiadas
   FROM it_cost_entries e
     JOIN clients c ON c.id = e.client_id
     JOIN expense_categories cat ON cat.id = e.expense_category_id
     JOIN it_budget_scenarios sc ON sc.id = e.scenario_id
     LEFT JOIN branches b ON b.id = e.branch_id
     LEFT JOIN cost_centers cc ON cc.id = e.cost_center_id
     LEFT JOIN suppliers s ON s.id = e.supplier_id
  WHERE e.deleted_at IS NULL;

-- vw_job_health
create view public.vw_job_health with (security_invoker = true) as
 SELECT job,
    count(*) AS execucoes,
    max(started_at) AS ultima_execucao,
    (array_agg(ok ORDER BY started_at DESC, id DESC))[1] AS ultimo_ok,
    (array_agg(detail ORDER BY started_at DESC, id DESC))[1] AS ultimo_detalhe,
    (array_agg(affected ORDER BY started_at DESC, id DESC))[1] AS ultimo_afetados,
    count(*) FILTER (WHERE ok IS FALSE) AS falhas,
    EXTRACT(epoch FROM now() - max(started_at)) / 60::numeric AS minutos_desde
   FROM job_runs r
  GROUP BY job;

-- vw_kb_articles
create view public.vw_kb_articles with (security_invoker = true) as
 SELECT a.id,
    a.tenant_id,
    a.title,
    a.resumo,
    a.category_id,
    c.name AS category_name,
    a.status,
    a.visibilidade,
    a.source_ticket_id,
    a.published_at,
    a.updated_at,
    a.views,
    count(*) FILTER (WHERE f.util) AS uteis,
    count(*) FILTER (WHERE f.util IS FALSE) AS inuteis,
    p.full_name AS author_name
   FROM kb_articles a
     LEFT JOIN kb_feedback f ON f.article_id = a.id
     LEFT JOIN ticket_categories c ON c.id = a.category_id
     LEFT JOIN profiles p ON p.id = a.author_id
  WHERE a.deleted_at IS NULL
  GROUP BY a.id, c.name, p.full_name;

-- vw_map_area_breakdown
create view public.vw_map_area_breakdown with (security_invoker = true) as
 SELECT tenant_id,
    branch_id,
    id AS area_id,
    name AS area_name,
    kind,
    sort_order,
    ( SELECT count(*) AS count
           FROM it_assets a
          WHERE a.branch_area_id = ar.id AND a.deleted_at IS NULL) AS assets_total,
    ( SELECT count(*) AS count
           FROM telecom_lines l
          WHERE l.company_area_id = ar.id AND l.deleted_at IS NULL AND l.status = 'active'::text) AS lines_active,
    ( SELECT count(*) AS count
           FROM internet_links k
          WHERE k.branch_area_id = ar.id AND k.deleted_at IS NULL AND k.status = 'active'::text) AS links_active
   FROM branch_areas ar
  WHERE is_active;

-- vw_map_assets
create view public.vw_map_assets with (security_invoker = true) as
 SELECT b.tenant_id,
    b.id AS branch_id,
    b.name AS branch_name,
    b.city,
    b.state,
    b.latitude,
    b.longitude,
    b.geocode_precision,
    b.geocoded_address,
    b.place_id,
    b.geocode_status,
    b.geocode_stale,
    b.address_complete,
    fn_format_address(b.street, b.street_number, b.address_complement, b.district, b.city, b.state::text, b.postal_code) AS address_formatted,
    count(a.id) AS assets_total,
    count(a.id) FILTER (WHERE a.status = 'active'::text) AS assets_active,
    count(a.id) FILTER (WHERE a.status = 'maintenance'::text) AS assets_maintenance,
    count(a.id) FILTER (WHERE a.status = 'active'::text AND a.assigned_user_id IS NULL) AS assets_without_owner,
        CASE
            WHEN count(a.id) FILTER (WHERE a.status = 'active'::text AND a.assigned_user_id IS NULL) > 0 THEN 'red'::text
            WHEN count(a.id) FILTER (WHERE a.status = 'maintenance'::text) > 0 THEN 'amber'::text
            ELSE 'green'::text
        END AS marker_state
   FROM branches b
     LEFT JOIN it_assets a ON a.branch_id = b.id AND a.deleted_at IS NULL
  WHERE b.deleted_at IS NULL
  GROUP BY b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude, b.geocode_precision, b.geocoded_address, b.place_id, b.geocode_status, b.geocode_stale, b.address_complete, b.street, b.street_number, b.address_complement, b.district, b.postal_code;

-- vw_map_internet
create view public.vw_map_internet with (security_invoker = true) as
 SELECT b.tenant_id,
    b.id AS branch_id,
    b.name AS branch_name,
    b.city,
    b.state,
    b.latitude,
    b.longitude,
    b.geocode_precision,
    b.geocoded_address,
    b.place_id,
    b.geocode_status,
    b.geocode_stale,
    b.address_complete,
    fn_format_address(b.street, b.street_number, b.address_complement, b.district, b.city, b.state::text, b.postal_code) AS address_formatted,
    count(k.id) FILTER (WHERE k.status = 'active'::text) AS links_active,
    count(k.id) FILTER (WHERE k.status = 'active'::text AND k.last_state = 'down'::text) AS links_down,
    count(k.id) FILTER (WHERE k.status = 'active'::text AND k.last_state = 'unknown'::text) AS links_unmonitored,
    COALESCE(sum(k.monthly_cost) FILTER (WHERE k.status = 'active'::text), 0::numeric) AS monthly_cost_active,
        CASE
            WHEN count(k.id) FILTER (WHERE k.status = 'active'::text AND k.last_state = 'down'::text) > 0 THEN 'red'::text
            WHEN count(k.id) FILTER (WHERE k.status = 'active'::text AND k.last_state = 'unknown'::text) > 0 THEN 'amber'::text
            ELSE 'green'::text
        END AS marker_state
   FROM branches b
     LEFT JOIN internet_links k ON k.branch_id = b.id AND k.deleted_at IS NULL
  WHERE b.deleted_at IS NULL
  GROUP BY b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude, b.geocode_precision, b.geocoded_address, b.place_id, b.geocode_status, b.geocode_stale, b.address_complete, b.street, b.street_number, b.address_complement, b.district, b.postal_code;

-- vw_map_telecom
create view public.vw_map_telecom with (security_invoker = true) as
 SELECT b.tenant_id,
    b.id AS branch_id,
    b.name AS branch_name,
    b.city,
    b.state,
    b.latitude,
    b.longitude,
    b.geocode_precision,
    b.geocoded_address,
    b.place_id,
    b.geocode_status,
    b.geocode_stale,
    b.address_complete,
    fn_format_address(b.street, b.street_number, b.address_complement, b.district, b.city, b.state::text, b.postal_code) AS address_formatted,
    count(l.id) FILTER (WHERE l.status = 'active'::text) AS lines_active,
    count(l.id) FILTER (WHERE l.status = 'suspended'::text) AS lines_suspended,
    count(l.id) FILTER (WHERE l.status = 'cancelled'::text) AS lines_cancelled,
    COALESCE(sum(l.monthly_cost) FILTER (WHERE l.status = 'active'::text), 0::numeric) AS monthly_cost_active,
        CASE
            WHEN count(l.id) FILTER (WHERE l.status = 'suspended'::text) > 0 THEN 'red'::text
            WHEN count(l.id) FILTER (WHERE l.status = 'active'::text AND l.assigned_user_id IS NULL) > 0 THEN 'amber'::text
            ELSE 'green'::text
        END AS marker_state
   FROM branches b
     LEFT JOIN telecom_lines l ON l.branch_id = b.id AND l.deleted_at IS NULL
  WHERE b.deleted_at IS NULL
  GROUP BY b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude, b.geocode_precision, b.geocoded_address, b.place_id, b.geocode_status, b.geocode_stale, b.address_complete, b.street, b.street_number, b.address_complement, b.district, b.postal_code;

-- vw_map_tickets
create view public.vw_map_tickets with (security_invoker = true) as
 SELECT b.tenant_id,
    b.id AS branch_id,
    b.name AS branch_name,
    b.city,
    b.state,
    b.latitude,
    b.longitude,
    b.geocode_precision,
    b.geocoded_address,
    b.place_id,
    b.geocode_status,
    b.geocode_stale,
    b.address_complete,
    fn_format_address(b.street, b.street_number, b.address_complement, b.district, b.city, b.state::text, b.postal_code) AS address_formatted,
    count(t.id) FILTER (WHERE t.status <> ALL (ARRAY['resolved'::text, 'closed'::text])) AS open_total,
    count(t.id) FILTER (WHERE t.status = ANY (ARRAY['assigned'::text, 'in_progress'::text])) AS in_progress_total,
    count(t.id) FILTER (WHERE (t.status <> ALL (ARRAY['resolved'::text, 'closed'::text])) AND p.weight >= 80) AS critical_total,
    count(t.id) FILTER (WHERE (t.status <> ALL (ARRAY['resolved'::text, 'closed'::text])) AND (st.resolution_breached OR st.resolution_due_at IS NOT NULL AND now() > st.resolution_due_at)) AS breached_total,
        CASE
            WHEN count(t.id) FILTER (WHERE (t.status <> ALL (ARRAY['resolved'::text, 'closed'::text])) AND (p.weight >= 80 OR st.resolution_breached OR st.resolution_due_at IS NOT NULL AND now() > st.resolution_due_at)) > 0 THEN 'red'::text
            WHEN count(t.id) FILTER (WHERE (t.status <> ALL (ARRAY['resolved'::text, 'closed'::text])) AND st.resolution_due_at IS NOT NULL AND now() >= (st.started_at + (st.resolution_due_at - st.started_at) * 0.75::double precision)) > 0 THEN 'amber'::text
            ELSE 'green'::text
        END AS marker_state
   FROM branches b
     LEFT JOIN tickets t ON t.branch_id = b.id AND t.deleted_at IS NULL
     LEFT JOIN ticket_priorities p ON p.id = t.priority_id
     LEFT JOIN sla_tracking st ON st.ticket_id = t.id
  WHERE b.deleted_at IS NULL
  GROUP BY b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude, b.geocode_precision, b.geocoded_address, b.place_id, b.geocode_status, b.geocode_stale, b.address_complete, b.street, b.street_number, b.address_complement, b.district, b.postal_code;

-- vw_part_stock
create view public.vw_part_stock with (security_invoker = true) as
 SELECT p.id AS part_id,
    p.tenant_id,
    p.sku,
    p.name,
    p.unit,
    p.category,
    p.average_cost,
    p.is_active,
    d.id AS depot_id,
    d.name AS depot_name,
    COALESCE(b.quantity, 0::numeric) AS quantity,
    b.last_movement_at,
    pol.min_quantity,
    pol.max_quantity,
    pol.lead_time_days,
        CASE
            WHEN pol.min_quantity IS NULL THEN NULL::numeric
            WHEN COALESCE(b.quantity, 0::numeric) > pol.min_quantity THEN 0::numeric
            ELSE GREATEST(pol.max_quantity - COALESCE(b.quantity, 0::numeric), 0::numeric)
        END AS suggested_purchase,
        CASE
            WHEN pol.min_quantity IS NULL THEN 'sem_politica'::text
            WHEN COALESCE(b.quantity, 0::numeric) <= 0::numeric THEN 'zerado'::text
            WHEN COALESCE(b.quantity, 0::numeric) < pol.min_quantity THEN 'abaixo'::text
            WHEN COALESCE(b.quantity, 0::numeric) = pol.min_quantity THEN 'no_limite'::text
            ELSE 'em_nivel'::text
        END AS level,
    COALESCE(b.quantity, 0::numeric) * p.average_cost AS stock_value
   FROM parts p
     JOIN rental_depots d ON d.tenant_id = p.tenant_id AND d.deleted_at IS NULL
     LEFT JOIN part_balances b ON b.part_id = p.id AND b.depot_id = d.id
     LEFT JOIN part_stock_policies pol ON pol.part_id = p.id AND pol.depot_id = d.id
  WHERE p.deleted_at IS NULL AND (b.id IS NOT NULL OR pol.id IS NOT NULL);

-- vw_payables_summary
create view public.vw_payables_summary with (security_invoker = true) as
 SELECT tenant_id,
    branch_id,
    status,
    count(*) AS titulos,
    COALESCE(sum(amount), 0::numeric) AS total,
    count(*) FILTER (WHERE due_on < CURRENT_DATE AND (status <> ALL (ARRAY['paid'::text, 'cancelled'::text]))) AS vencidos,
    COALESCE(sum(amount) FILTER (WHERE due_on < CURRENT_DATE AND (status <> ALL (ARRAY['paid'::text, 'cancelled'::text]))), 0::numeric) AS total_vencido,
    count(*) FILTER (WHERE due_on >= CURRENT_DATE AND due_on <= (CURRENT_DATE + 7) AND (status <> ALL (ARRAY['paid'::text, 'cancelled'::text]))) AS vence_em_7_dias
   FROM payables p
  WHERE deleted_at IS NULL
  GROUP BY tenant_id, branch_id, status;

-- vw_project_tasks
create view public.vw_project_tasks with (security_invoker = true) as
 SELECT t.id,
    t.tenant_id,
    t.project_id,
    t.parent_task_id,
    t.name,
    t.start_month,
    t.planned_end_month,
    t.actual_end_month,
    t.assignee,
    t.status,
    p.name AS project_name,
    p.client_id,
    p.branch_id,
    b.name AS branch_name,
    app.atraso_em_meses(t.planned_end_month, t.actual_end_month, t.status) AS meses_atraso,
    app.desvio_em_meses(t.planned_end_month, t.actual_end_month, t.status) AS desvio_meses,
    app.atraso_em_meses(t.planned_end_month, t.actual_end_month, t.status) > 0 AS atrasado,
    ( SELECT count(*) AS count
           FROM project_tasks f
          WHERE f.parent_task_id = t.id AND f.deleted_at IS NULL) AS total_subtarefas
   FROM project_tasks t
     JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
     LEFT JOIN branches b ON b.id = p.branch_id
  WHERE t.deleted_at IS NULL;

-- vw_projects
create view public.vw_projects with (security_invoker = true) as
 SELECT p.id,
    p.tenant_id,
    p.client_id,
    p.branch_id,
    p.name,
    p.description,
    p.start_month,
    p.planned_end_month,
    p.actual_end_month,
    p.status,
    p.created_at,
    c.trade_name AS client_name,
    b.name AS branch_name,
    app.meses_entre(p.start_month, p.planned_end_month) + 1 AS duracao_planejada_meses,
    app.atraso_em_meses(p.planned_end_month, p.actual_end_month, p.status) AS meses_atraso,
    app.desvio_em_meses(p.planned_end_month, p.actual_end_month, p.status) AS desvio_meses,
    app.atraso_em_meses(p.planned_end_month, p.actual_end_month, p.status) > 0 AS atrasado,
    ( SELECT count(*) AS count
           FROM project_tasks t
          WHERE t.project_id = p.id AND t.deleted_at IS NULL) AS total_tarefas,
    ( SELECT count(*) AS count
           FROM project_tasks t
          WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.actual_end_month IS NOT NULL) AS tarefas_entregues,
    ( SELECT count(*) AS count
           FROM project_tasks t
          WHERE t.project_id = p.id AND t.deleted_at IS NULL AND app.atraso_em_meses(t.planned_end_month, t.actual_end_month, t.status) > 0) AS tarefas_atrasadas
   FROM projects p
     JOIN clients c ON c.id = p.client_id
     LEFT JOIN branches b ON b.id = p.branch_id
  WHERE p.deleted_at IS NULL;

-- vw_receivables_summary
create view public.vw_receivables_summary with (security_invoker = true) as
 SELECT tenant_id,
    client_id,
    status,
    count(*) AS titulos,
    COALESCE(sum(amount), 0::numeric) AS total,
    count(*) FILTER (WHERE due_on < CURRENT_DATE AND status = 'open'::text) AS vencidos,
    COALESCE(sum(amount) FILTER (WHERE due_on < CURRENT_DATE AND status = 'open'::text), 0::numeric) AS total_vencido,
    COALESCE(sum(amount - COALESCE(received_amount, amount)) FILTER (WHERE status = 'received'::text), 0::numeric) AS diferenca_recebida
   FROM receivables r
  WHERE deleted_at IS NULL
  GROUP BY tenant_id, client_id, status;

-- vw_rental_allocations
create view public.vw_rental_allocations with (security_invoker = true) as
 SELECT i.id,
    i.tenant_id,
    i.contract_id,
    c.code AS contract_code,
    c.status AS contract_status,
    c.client_id,
    i.equipment_id,
    e.asset_tag,
    e.status AS equipment_status,
    e.meter_kind,
    e.meter_reading,
    m.name AS model_name,
    i.operation_location_id,
    l.name AS location_name,
    i.status,
    i.monthly_price,
    i.franchise,
    i.excess_price,
    i.delivered_on,
    i.returned_on,
    i.meter_at_delivery,
    i.meter_at_return
   FROM rental_contract_items i
     JOIN rental_contracts c ON c.id = i.contract_id
     JOIN rental_equipment e ON e.id = i.equipment_id
     JOIN equipment_models m ON m.id = e.model_id
     LEFT JOIN operation_locations l ON l.id = i.operation_location_id
  WHERE i.deleted_at IS NULL;

-- vw_rental_consumption
create view public.vw_rental_consumption with (security_invoker = true) as
 SELECT i.id AS contract_item_id,
    i.tenant_id,
    i.contract_id,
    i.equipment_id,
    e.asset_tag,
    e.meter_kind,
    i.monthly_price,
    i.franchise,
    i.excess_price,
    i.delivered_on,
    i.returned_on,
    i.meter_at_delivery,
    i.meter_at_return,
    e.meter_reading AS meter_now,
    COALESCE(i.meter_at_return, e.meter_reading) - COALESCE(i.meter_at_delivery, 0::numeric) AS meter_used
   FROM rental_contract_items i
     JOIN rental_equipment e ON e.id = i.equipment_id
  WHERE i.deleted_at IS NULL AND (i.status = ANY (ARRAY['delivered'::text, 'returned'::text]));

-- vw_service_catalog
create view public.vw_service_catalog with (security_invoker = true) as
 SELECT s.id,
    s.tenant_id,
    s.name,
    s.description,
    s.category_id,
    c.name AS category_name,
    s.queue_id,
    q.name AS queue_name,
    s.priority_id,
    s.preco,
    s.unidade,
    s.prazo_horas,
    s.requer_aprovacao,
    s.campos,
    s.is_active,
    s.sort_order,
    ( SELECT count(*) AS count
           FROM tickets t
          WHERE t.service_id = s.id AND t.deleted_at IS NULL) AS pedidos
   FROM service_catalog s
     LEFT JOIN ticket_categories c ON c.id = s.category_id
     LEFT JOIN queues q ON q.id = s.queue_id
  WHERE s.deleted_at IS NULL;

-- vw_sla_compliance
create view public.vw_sla_compliance with (security_invoker = true) as
 SELECT t.tenant_id,
    date_trunc('month'::text, t.created_at) AS period,
    t.queue_id,
    q.name AS queue_name,
    t.assignee_id,
    t.client_id,
    count(*) AS tickets_total,
    count(*) FILTER (WHERE st.coverage = 'covered'::text) AS tickets_with_sla,
    count(*) FILTER (WHERE st.response_breached) AS response_breaches,
    count(*) FILTER (WHERE st.resolution_breached) AS resolution_breaches,
    round(100.0 * count(*) FILTER (WHERE st.coverage = 'covered'::text AND NOT st.resolution_breached)::numeric / NULLIF(count(*) FILTER (WHERE st.coverage = 'covered'::text), 0)::numeric, 2) AS resolution_compliance_pct,
    round(100.0 * count(*) FILTER (WHERE st.coverage = 'covered'::text AND NOT st.response_breached)::numeric / NULLIF(count(*) FILTER (WHERE st.coverage = 'covered'::text), 0)::numeric, 2) AS response_compliance_pct
   FROM tickets t
     JOIN queues q ON q.id = t.queue_id
     LEFT JOIN sla_tracking st ON st.ticket_id = t.id
  WHERE t.deleted_at IS NULL
  GROUP BY t.tenant_id, (date_trunc('month'::text, t.created_at)), t.queue_id, q.name, t.assignee_id, t.client_id;

-- vw_telecom_dashboard
create view public.vw_telecom_dashboard with (security_invoker = true) as
 SELECT l.tenant_id,
    l.branch_id,
    b.name AS branch_name,
    l.company_area_id,
    ar.name AS area_name,
    l.carrier,
    l.line_type,
    l.status,
    count(*) AS lines_count,
    COALESCE(sum(l.monthly_cost), 0::numeric) AS monthly_total,
    round(avg(l.monthly_cost), 2) AS monthly_avg,
    count(*) FILTER (WHERE l.assigned_user_id IS NULL) AS without_user,
    count(*) FILTER (WHERE l.loyalty_until IS NULL OR l.loyalty_until < CURRENT_DATE) AS free_to_cancel
   FROM telecom_lines l
     LEFT JOIN branches b ON b.id = l.branch_id
     LEFT JOIN branch_areas ar ON ar.id = l.company_area_id
  WHERE l.deleted_at IS NULL
  GROUP BY l.tenant_id, l.branch_id, b.name, l.company_area_id, ar.name, l.carrier, l.line_type, l.status;

-- vw_tickets_enriched
create view public.vw_tickets_enriched with (security_invoker = true) as
 SELECT t.id,
    t.tenant_id,
    t.ticket_number,
    t.title,
    t.description,
    t.status,
    t.tags,
    t.source,
    t.source_system,
    t.external_id,
    t.external_url,
    t.created_at,
    t.updated_at,
    t.first_response_at,
    t.resolved_at,
    t.closed_at,
    t.reopened_count,
    t.priority_id,
    p.key AS priority_key,
    p.label AS priority_label,
    p.color AS priority_color,
    p.weight AS priority_weight,
    t.queue_id,
    q.name AS queue_name,
    q.slug AS queue_slug,
    t.category_id,
    c.name AS category_name,
    parent.name AS category_parent_name,
    t.branch_id,
    b.name AS branch_name,
    b.timezone AS branch_timezone,
    t.client_id,
    cl.legal_name AS client_name,
    t.assignee_id,
    ua.full_name AS assignee_name,
    t.requester_id,
    ur.full_name AS requester_name,
    t.supplier_id,
    s.name AS supplier_name,
    st.response_due_at,
    st.resolution_due_at,
    st.responded_at,
    st.response_breached,
    st.resolution_breached,
    st.is_paused,
    st.paused_minutes,
    st.coverage AS sla_coverage,
    app.sla_state(st.response_due_at, st.responded_at, st.response_breached, tn.sla_warning_pct, tn.sla_critical_pct, st.started_at) AS response_state,
    app.sla_state(st.resolution_due_at, st.resolved_at, st.resolution_breached, tn.sla_warning_pct, tn.sla_critical_pct, st.started_at) AS resolution_state,
        CASE
            WHEN st.resolution_due_at IS NULL THEN NULL::numeric
            WHEN st.resolution_due_at >= now() THEN app.fn_business_minutes_between(now(), st.resolution_due_at, st.business_hours_id)
            ELSE - app.fn_business_minutes_between(st.resolution_due_at, now(), st.business_hours_id)
        END AS minutes_to_resolution_due,
    app.queue_score(p.weight, st.started_at, st.resolution_due_at, st.resolution_breached, t.created_at, q.weight_criticality, q.weight_deadline, q.weight_age) AS queue_score
   FROM tickets t
     JOIN tenants tn ON tn.id = t.tenant_id
     JOIN ticket_priorities p ON p.id = t.priority_id
     JOIN queues q ON q.id = t.queue_id
     LEFT JOIN ticket_categories c ON c.id = t.category_id
     LEFT JOIN ticket_categories parent ON parent.id = c.parent_id
     LEFT JOIN branches b ON b.id = t.branch_id
     LEFT JOIN clients cl ON cl.id = t.client_id
     LEFT JOIN profiles ua ON ua.id = t.assignee_id
     LEFT JOIN profiles ur ON ur.id = t.requester_id
     LEFT JOIN suppliers s ON s.id = t.supplier_id
     LEFT JOIN sla_tracking st ON st.ticket_id = t.id
  WHERE t.deleted_at IS NULL;

-- vw_job_alerts
create view public.vw_job_alerts with (security_invoker = true) as
 SELECT e.job,
    e.rotulo,
    e.tolerancia_min,
    h.ultima_execucao,
    h.ultimo_ok,
    h.ultimo_detalhe,
    h.minutos_desde,
        CASE
            WHEN h.ultima_execucao IS NULL THEN 'nunca_rodou'::text
            WHEN h.ultimo_ok IS FALSE THEN 'falhou'::text
            WHEN h.minutos_desde > e.tolerancia_min::numeric THEN 'parou'::text
            ELSE 'ok'::text
        END AS situacao
   FROM job_expectations e
     LEFT JOIN vw_job_health h ON h.job = e.job
  WHERE e.ativo;
