-- =============================================================================
-- Testes de schema, RLS e regras de negócio
-- =============================================================================
-- Executado por scripts/validate-migrations.sh contra o banco já semeado.
-- Falha ⇒ psql aborta (ON_ERROR_STOP) ⇒ CI vermelho.
--
-- Rodamos como um papel SEM bypassrls para que as policies realmente se apliquem;
-- como superusuário, todo teste de RLS passaria trivialmente e não provaria nada.
-- =============================================================================

\set ON_ERROR_STOP on
\timing off

create or replace function app.assert(p_condition boolean, p_label text)
returns void
language plpgsql
as $$
begin
  if p_condition is not true then
    raise exception 'FALHOU: %', p_label;
  end if;
  raise notice '  ok  %', p_label;
end;
$$;

-- Papel de teste que se submete ao RLS (o dono das tabelas escaparia dele).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'rls_tester') then
    create role rls_tester nologin;
  end if;
end
$$;
grant authenticated to rls_tester;

-- =============================================================================
\echo '=== 1. Cobertura de RLS ==='
-- =============================================================================
-- RNF-01: nenhuma tabela de negócio pode ficar sem RLS. Este teste é a rede de
-- proteção contra "criei uma tabela nova e esqueci a policy".
do $$
declare
  v_missing text;
begin
  select string_agg(c.relname, ', ')
    into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not c.relrowsecurity;

  perform app.assert(v_missing is null,
    'todas as tabelas de public têm RLS habilitado' ||
    coalesce(' (faltando: ' || v_missing || ')', ''));
end
$$;

do $$
declare
  v_missing text;
begin
  select string_agg(c.relname, ', ')
    into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relrowsecurity
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid);

  perform app.assert(v_missing is null,
    'toda tabela com RLS tem ao menos uma policy' ||
    coalesce(' (sem policy: ' || v_missing || ')', ''));
end
$$;

-- Views nunca podem rodar com os privilégios do dono (vazaria entre tenants).
do $$
declare
  v_bad text;
begin
  select string_agg(c.relname, ', ')
    into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'v'
    and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=true%';

  perform app.assert(v_bad is null,
    'todas as views usam security_invoker' || coalesce(' (faltando: ' || v_bad || ')', ''));
end
$$;

-- =============================================================================
\echo '=== 2. Isolamento multi-tenant e visibilidade por filial ==='
-- =============================================================================
-- Segundo tenant, para provar que o vazamento cruzado não acontece.
insert into public.tenants (id, name, slug) values
  ('a0000000-0000-4000-8000-000000000002', 'Outro Tenant', 'outro');
insert into auth.users (id, email, raw_app_meta_data) values
  ('22220000-0000-4000-8000-000000000099', 'intruso@outro.com',
   '{"tenant_id":"a0000000-0000-4000-8000-000000000002"}'::jsonb);
insert into public.profiles (id, tenant_id, role, full_name, email) values
  ('22220000-0000-4000-8000-000000000099', 'a0000000-0000-4000-8000-000000000002',
   'admin', 'Intruso', 'intruso@outro.com');

set role rls_tester;

-- --- admin do tenant 1: enxerga tudo do próprio tenant
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert((select count(*) from public.tickets) = 6, 'admin vê os 6 tickets do tenant');
  perform app.assert((select count(*) from public.clients) = 2, 'admin vê os 2 clientes do tenant');
  perform app.assert((select count(*) from public.it_assets) = 6, 'admin vê os 6 ativos do tenant');
end
$$;

-- --- admin do tenant 2: NÃO pode ver nada do tenant 1
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000099","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
begin
  perform app.assert((select count(*) from public.tickets) = 0,  'tenant 2 não vê tickets do tenant 1');
  perform app.assert((select count(*) from public.clients) = 0,  'tenant 2 não vê clientes do tenant 1');
  perform app.assert((select count(*) from public.it_assets) = 0,'tenant 2 não vê ativos do tenant 1');
  perform app.assert((select count(*) from public.telecom_lines) = 0, 'tenant 2 não vê linhas do tenant 1');
  -- O tenant 2 tem auditoria própria (o insert do seu perfil, acima); o que não
  -- pode acontecer é enxergar UMA linha sequer do tenant 1.
  perform app.assert(
    not exists (select 1 from public.audit_log
                 where tenant_id = 'a0000000-0000-4000-8000-000000000001'),
    'tenant 2 não vê auditoria do tenant 1');
end
$$;

-- --- Ana (atendente, filiais SP + Campinas)
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
declare
  v_manaus int;
begin
  select count(*) into v_manaus
  from public.tickets where branch_id = '11110000-0000-4000-8000-000000000003';

  perform app.assert(v_manaus = 0, 'atendente de SP/Campinas não vê ticket de Manaus');
  perform app.assert((select count(*) from public.tickets) = 5, 'Ana vê os 5 tickets das suas filiais');
  perform app.assert(
    (select count(*) from public.it_assets where branch_id = '11110000-0000-4000-8000-000000000003') = 0,
    'atendente de SP/Campinas não vê ativo de Manaus');
end
$$;

-- --- Bruno (atendente, só Manaus)
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000004","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert((select count(*) from public.tickets) = 1, 'Bruno vê apenas o ticket de Manaus');
end
$$;

-- --- Carla (solicitante): só os próprios tickets, e nada de comentário interno
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert((select count(*) from public.tickets) = 4,
    'solicitante vê apenas os tickets que abriu');
  perform app.assert((select count(*) from public.ticket_comments where visibility = 'internal') = 0,
    'solicitante NÃO enxerga comentário interno');
  perform app.assert((select count(*) from public.ticket_comments where visibility = 'public') = 1,
    'solicitante enxerga comentário público');
end
$$;

-- --- Gestor: tenant inteiro, inclusive comentário interno
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert((select count(*) from public.tickets) = 6, 'gestor vê todas as filiais');
  perform app.assert((select count(*) from public.ticket_comments where visibility = 'internal') = 1,
    'gestor enxerga comentário interno');
end
$$;

reset role;

-- =============================================================================
\echo '=== 3. Escalonamento de privilégio ==='
-- =============================================================================
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  begin
    update public.profiles set role = 'admin' where id = '22220000-0000-4000-8000-000000000005';
    raise exception 'FALHOU: solicitante conseguiu se promover a admin';
  exception
    when insufficient_privilege then
      raise notice '  ok  solicitante não consegue se auto-promover a admin';
  end;
end
$$;
reset role;

-- =============================================================================
\echo '=== 4. Máquina de estados do ticket (ADR-007) ==='
-- =============================================================================
do $$
declare
  v_id uuid;
begin
  select id into v_id from public.tickets where title = 'Solicitação de reset de senha';

  -- 'open' → 'resolved' não é transição declarada
  begin
    update public.tickets set status = 'resolved' where id = v_id;
    raise exception 'FALHOU: transição inválida open→resolved foi aceita';
  exception
    when check_violation then
      raise notice '  ok  transição inválida open→resolved é rejeitada pelo banco';
  end;

  -- Caminho válido
  update public.tickets set status = 'triage'      where id = v_id;
  update public.tickets set status = 'assigned'    where id = v_id;
  update public.tickets set status = 'in_progress' where id = v_id;
  update public.tickets set status = 'resolved'    where id = v_id;

  perform app.assert(
    (select resolved_at is not null from public.tickets where id = v_id),
    'resolved_at é carimbado automaticamente na resolução');

  -- Reabertura zera o carimbo e conta a reabertura
  update public.tickets set status = 'in_progress' where id = v_id;
  perform app.assert(
    (select resolved_at is null and reopened_count = 1 from public.tickets where id = v_id),
    'reabertura limpa resolved_at e incrementa reopened_count');
end
$$;

-- =============================================================================
\echo '=== 5. Fila padrão protegida (RF-FIL-01) ==='
-- =============================================================================
do $$
begin
  begin
    update public.queues set name = 'Renomeada' where is_system_default;
    raise exception 'FALHOU: fila padrão foi renomeada';
  exception when restrict_violation then
    raise notice '  ok  fila padrão não pode ser renomeada';
  end;

  begin
    delete from public.queues where is_system_default;
    raise exception 'FALHOU: fila padrão foi removida';
  exception when restrict_violation then
    raise notice '  ok  fila padrão não pode ser removida';
  end;

  begin
    update public.queues set is_active = false where is_system_default;
    raise exception 'FALHOU: fila padrão foi desativada';
  exception when restrict_violation then
    raise notice '  ok  fila padrão não pode ser desativada';
  end;
end
$$;

-- =============================================================================
\echo '=== 6. Resolução de SLA por precedência (RF-SLA) ==='
-- =============================================================================
do $$
declare
  v_def public.sla_definitions;
begin
  -- Infra + crítica + cliente Meridiano ⇒ regra mais específica: 5 / 60
  v_def := app.fn_resolve_sla(
    'a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
    '11110000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001');
  perform app.assert(v_def.first_response_minutes = 5 and v_def.resolution_minutes = 60,
    'contrato + categoria vence (5/60)');

  -- Crítica sem categoria no Meridiano ⇒ contrato do cliente: 10 / 120
  v_def := app.fn_resolve_sla(
    'a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
    '11110000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000001');
  perform app.assert(v_def.first_response_minutes = 10 and v_def.resolution_minutes = 120,
    'contrato do cliente vence sobre padrão do tenant (10/120)');

  -- Filial Manaus tem sobrescrita 24x7 ⇒ 15 / 180 (mais específico que o cliente)
  v_def := app.fn_resolve_sla(
    'a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
    '11110000-0000-4000-8000-000000000003', null,
    'c0000000-0000-4000-8000-000000000001');
  perform app.assert(v_def.first_response_minutes = 15 and v_def.resolution_minutes = 180,
    'sobrescrita de filial vence sobre contrato do cliente (15/180)');

  -- Cliente Vertex não tem contrato ⇒ cai no padrão do tenant: 15 / 240
  v_def := app.fn_resolve_sla(
    'a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002',
    '11110000-0000-4000-8000-000000000004', null,
    'c0000000-0000-4000-8000-000000000001');
  perform app.assert(v_def.first_response_minutes = 15 and v_def.resolution_minutes = 240,
    'sem contrato, cai no padrão do tenant (15/240)');
end
$$;

-- =============================================================================
\echo '=== 7. Medição de SLA: criação, pausa e retomada ==='
-- =============================================================================
do $$
declare
  v_id      uuid;
  v_track   public.sla_tracking;
  v_due_before timestamptz;
begin
  perform app.assert(
    (select count(*) from public.sla_tracking) = (select count(*) from public.tickets),
    'todo ticket recebe registro de sla_tracking automaticamente');

  select id into v_id from public.tickets where title = 'ERP lento ao emitir nota fiscal';
  select * into v_track from public.sla_tracking where ticket_id = v_id;

  perform app.assert(v_track.coverage = 'covered' and v_track.resolution_due_at is not null,
    'ticket coberto por SLA tem prazo de resolução calculado');

  -- Pausa: assigned → waiting_requester
  v_due_before := v_track.resolution_due_at;
  update public.tickets set status = 'waiting_requester' where id = v_id;

  perform app.assert((select is_paused from public.sla_tracking where ticket_id = v_id),
    'entrar em espera marca o SLA como pausado');
  perform app.assert(
    (select count(*) from public.sla_pauses where ticket_id = v_id and ended_at is null) = 1,
    'abre um intervalo de pausa aberto');

  -- Retomada
  update public.tickets set status = 'in_progress' where id = v_id;

  perform app.assert(not (select is_paused from public.sla_tracking where ticket_id = v_id),
    'sair da espera despausa o SLA');
  perform app.assert(
    (select count(*) from public.sla_pauses where ticket_id = v_id and ended_at is not null) = 1,
    'o intervalo de pausa é fechado com ended_at');
  perform app.assert(
    (select resolution_due_at >= v_due_before from public.sla_tracking where ticket_id = v_id),
    'o prazo de resolução é empurrado (nunca antecipado) após a pausa');
end
$$;

-- =============================================================================
\echo '=== 8. Primeira resposta e trilha de auditoria ==='
-- =============================================================================
do $$
declare
  v_id uuid;
  v_before int;
begin
  select id into v_id from public.tickets where title = 'Servidor de arquivos com disco cheio';

  perform app.assert((select first_response_at is null from public.tickets where id = v_id),
    'ticket sem resposta não tem first_response_at');

  insert into public.ticket_comments (tenant_id, ticket_id, author_id, body, visibility)
  values ('a0000000-0000-4000-8000-000000000001', v_id,
          '22220000-0000-4000-8000-000000000003', 'Analisando o volume.', 'public');

  perform app.assert((select first_response_at is not null from public.tickets where id = v_id),
    'comentário público de atendente carimba a primeira resposta');
  perform app.assert((select responded_at is not null from public.sla_tracking where ticket_id = v_id),
    'a medição de TFR é encerrada junto');

  -- Auditoria por trigger, mesmo em escrita direta por SQL (antipattern A-06)
  select count(*) into v_before from public.audit_log where entity_type = 'suppliers';
  update public.suppliers set rating = 4.9 where name = 'NetLink Telecom';
  perform app.assert(
    (select count(*) from public.audit_log where entity_type = 'suppliers') > v_before,
    'update em fornecedor gera linha de auditoria automaticamente');

  perform app.assert(
    (select changes -> 'rating' ->> 'new' = '4.9' from public.audit_log
      where entity_type = 'suppliers' order by created_at desc limit 1),
    'a auditoria registra o valor novo do campo alterado');

  -- ticket_history registra campo a campo
  perform app.assert(
    (select count(*) from public.ticket_history where field = 'status') > 0,
    'mudanças de status alimentam ticket_history');
end
$$;

-- =============================================================================
\echo '=== 9. Idempotência de integração (RF-INT-06) ==='
-- =============================================================================
do $$
begin
  insert into public.integration_events (tenant_id, integration_id, event_key, event_type, external_id)
  values ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001',
          'ONTASKADD:9001:1770000000', 'ONTASKADD', '9001');

  begin
    insert into public.integration_events (tenant_id, integration_id, event_key, event_type, external_id)
    values ('a0000000-0000-4000-8000-000000000001', '66660000-0000-4000-8000-000000000001',
            'ONTASKADD:9001:1770000000', 'ONTASKADD', '9001');
    raise exception 'FALHOU: evento duplicado foi aceito';
  exception when unique_violation then
    raise notice '  ok  reentrega do mesmo evento é bloqueada por constraint';
  end;
end
$$;

-- Um mesmo objeto externo nunca vira dois tickets (RF-INT-10)
do $$
declare
  v_pid uuid := 'c0000000-0000-4000-8000-000000000003';
  v_qid uuid := 'e0000000-0000-4000-8000-000000000001';
begin
  insert into public.tickets (tenant_id, title, priority_id, queue_id, source, source_system, external_id)
  values ('a0000000-0000-4000-8000-000000000001', 'Tarefa Bitrix 9002', v_pid, v_qid,
          'integration', 'bitrix24', '9002');

  begin
    insert into public.tickets (tenant_id, title, priority_id, queue_id, source, source_system, external_id)
    values ('a0000000-0000-4000-8000-000000000001', 'Tarefa Bitrix 9002 (duplicata)', v_pid, v_qid,
            'integration', 'bitrix24', '9002');
    raise exception 'FALHOU: ticket duplicado por external_id foi aceito';
  exception when unique_violation then
    raise notice '  ok  external_id + source_system é único por tenant';
  end;
end
$$;

-- =============================================================================
\echo '=== 10. Numeração, roteamento e views ==='
-- =============================================================================
do $$
declare
  v_max bigint;
  v_new bigint;
  v_qid uuid;
begin
  select max(ticket_number) into v_max from public.tickets;

  insert into public.tickets (tenant_id, title, priority_id, queue_id, requester_id)
  values ('a0000000-0000-4000-8000-000000000001', 'Ticket sem fila informada',
          'c0000000-0000-4000-8000-000000000003', null, '22220000-0000-4000-8000-000000000005')
  returning ticket_number, queue_id into v_new, v_qid;

  perform app.assert(v_new = v_max + 1, 'numeração sequencial por tenant sem lacunas');
  perform app.assert(
    (select is_system_default from public.queues where id = v_qid),
    'ticket sem fila cai na fila padrão do sistema');
  perform app.assert(
    (select branch_id = '11110000-0000-4000-8000-000000000001' from public.tickets where ticket_number = v_new),
    'filial é derivada da filial primária do solicitante');
  perform app.assert(
    (select client_id = 'f0000000-0000-4000-8000-000000000001' from public.tickets where ticket_number = v_new),
    'cliente é derivado da filial');
end
$$;

do $$
declare
  v_m record;
begin
  select * into v_m from public.vw_dashboard_metrics
  where tenant_id = 'a0000000-0000-4000-8000-000000000001';

  perform app.assert(v_m.open_total > 0, 'vw_dashboard_metrics devolve contadores');
  perform app.assert(v_m.critical_total >= 1, 'contador de críticos funciona');

  perform app.assert(
    (select count(*) from public.vw_tickets_enriched
      where tenant_id = 'a0000000-0000-4000-8000-000000000001'
        and resolution_state is not null) > 0,
    'vw_tickets_enriched calcula o semáforo de SLA');

  perform app.assert(
    (select count(*) from public.vw_tickets_enriched where queue_score is not null) > 0,
    'vw_tickets_enriched calcula o score de fila');

  perform app.assert(
    (select monthly_total from public.vw_telecom_costs
      where carrier = 'TIM' and status = 'active'
        and tenant_id = 'a0000000-0000-4000-8000-000000000001') = 189.90,
    'vw_telecom_costs soma custo por operadora');
end
$$;

-- =============================================================================
\echo '=== 11. Token de exibição da TV (ADR-006) ==='
-- =============================================================================
do $$
declare
  v_row record;
begin
  select * into v_row from app.resolve_dashboard_token('demo-tv-token-iaroffice');
  perform app.assert(v_row.tenant_id = 'a0000000-0000-4000-8000-000000000001',
    'token válido resolve para o tenant correto');

  perform app.assert(
    (select last_used_at is not null from public.dashboard_tokens
      where name = 'TV Recepção Matriz'),
    'uso do token registra last_used_at');

  perform app.assert(
    not exists (select 1 from app.resolve_dashboard_token('token-que-nao-existe')),
    'token inválido não resolve nada');

  update public.dashboard_tokens set revoked_at = now() where name = 'TV Recepção Matriz';
  perform app.assert(
    not exists (select 1 from app.resolve_dashboard_token('demo-tv-token-iaroffice')),
    'token revogado deixa de funcionar imediatamente');
  update public.dashboard_tokens set revoked_at = null where name = 'TV Recepção Matriz';

  perform app.assert(
    (select token_hash <> 'demo-tv-token-iaroffice' from public.dashboard_tokens
      where name = 'TV Recepção Matriz'),
    'o segredo do token não é armazenado em claro');
end
$$;

-- =============================================================================
\echo '=== 12. Ciclo de vida de ativos (RF-INV-02) ==='
-- =============================================================================
do $$
declare
  v_asset uuid;
  v_before int;
begin
  select id into v_asset from public.it_assets where asset_tag = 'PAT-001042';
  select count(*) into v_before from public.asset_assignments where asset_id = v_asset;

  update public.it_assets set assigned_user_id = '22220000-0000-4000-8000-000000000004'
   where id = v_asset;
  perform app.assert(
    (select count(*) from public.asset_assignments where asset_id = v_asset) = v_before + 1,
    'troca de responsável gera evento de atribuição no histórico');

  update public.it_assets set status = 'maintenance' where id = v_asset;
  perform app.assert(
    (select count(*) from public.asset_assignments
      where asset_id = v_asset and event_type = 'maintenance') = 1,
    'envio para manutenção gera evento de lifecycle');
end
$$;

-- =============================================================================
\echo '=== 13. Áreas por filial (Módulo 2 / 9) ==='
-- =============================================================================
do $$
declare
  v_sp uuid := '11110000-0000-4000-8000-000000000001';
  v_mao uuid := '11110000-0000-4000-8000-000000000003';
  v_area_sp uuid;
  v_area_mao uuid;
  v_asset uuid;
begin
  perform app.assert(
    (select count(*) from public.branch_areas where branch_id = v_sp) = 8,
    'seed de áreas cria o conjunto inicial da filial');

  -- Idempotência: rodar de novo não duplica.
  perform app.fn_seed_branch_areas(v_sp);
  perform app.assert(
    (select count(*) from public.branch_areas where branch_id = v_sp) = 8,
    'fn_seed_branch_areas é idempotente');

  -- Nome duplicado na mesma filial.
  begin
    insert into public.branch_areas (tenant_id, branch_id, name)
    values ('a0000000-0000-4000-8000-000000000001', v_sp, 'enfermagem');
    raise exception 'FALHOU: área duplicada foi aceita';
  exception when unique_violation then
    raise notice '  ok  nome de área duplicado na filial é recusado (case-insensitive)';
  end;

  select id into v_area_sp  from public.branch_areas where branch_id = v_sp  and name = 'TI';
  select id into v_area_mao from public.branch_areas where branch_id = v_mao and name = 'TI';
  select id into v_asset from public.it_assets where asset_tag = 'PAT-001042';

  perform app.assert(
    (select branch_area_id is not null from public.it_assets where id = v_asset),
    'ativos do seed recebem área da própria filial');

  -- Área de OUTRA filial deve ser rejeitada — a FK garante o tenant, não a filial.
  begin
    update public.it_assets set branch_area_id = v_area_mao where id = v_asset;
    raise exception 'FALHOU: ativo aceitou área de outra filial';
  exception when check_violation then
    raise notice '  ok  ativo não aceita área de outra filial';
  end;

  begin
    update public.telecom_lines set company_area_id = v_area_mao
     where phone_number = '+55 11 98800-1001';
    raise exception 'FALHOU: linha aceitou área de outra filial';
  exception when check_violation then
    raise notice '  ok  linha telefônica não aceita área de outra filial';
  end;

  -- Área com ativo vinculado não pode ser excluída (ON DELETE RESTRICT).
  begin
    delete from public.branch_areas where id = v_area_sp;
    raise exception 'FALHOU: área com ativos foi excluída';
  exception when foreign_key_violation then
    raise notice '  ok  área com ativos vinculados não pode ser excluída';
  end;
end
$$;

-- =============================================================================
\echo '=== 14. Custódia de equipamento (Módulo 4) ==='
-- =============================================================================
do $$
declare
  v_asset uuid;
  v_before int;
  v_row record;
begin
  select id into v_asset from public.it_assets where asset_tag = 'PAT-001043';
  select count(*) into v_before from public.asset_assignments where asset_id = v_asset;

  -- Motivo informado pela UI chega por variável de sessão; a gravação continua
  -- sendo do trigger.
  perform set_config('app.custody_reason', 'substituicao', false);
  update public.it_assets set assigned_user_id = '22220000-0000-4000-8000-000000000004'
   where id = v_asset;
  perform set_config('app.custody_reason', '', false);

  perform app.assert(
    (select count(*) from public.asset_assignments where asset_id = v_asset) = v_before + 1,
    'troca de responsável gera evento de custódia');

  select * into v_row from public.asset_custody_history
   where asset_id = v_asset order by changed_at desc limit 1;

  perform app.assert(v_row.previous_user_id = '22220000-0000-4000-8000-000000000003',
    'histórico grava o responsável ANTERIOR explicitamente');
  perform app.assert(v_row.current_user_id = '22220000-0000-4000-8000-000000000004',
    'histórico grava o responsável novo');
  perform app.assert(v_row.reason = 'substituicao',
    'motivo informado pela sessão é gravado no evento');
  perform app.assert(v_row.asset_tag = 'PAT-001043',
    'view de custódia traz os dados do ativo');

  -- Devolução (responsável para NULL) deve ser inferida sem motivo informado.
  update public.it_assets set assigned_user_id = null where id = v_asset;
  perform app.assert(
    exists (select 1 from public.asset_custody_history
             where asset_id = v_asset and reason = 'devolucao'),
    'devolução é inferida quando o responsável fica nulo');

  -- Cronologia dentro da mesma transação: sem clock_timestamp() os eventos
  -- criados no mesmo commit teriam horário idêntico e a timeline perderia a
  -- ordem. Comparamos distintos com o total em vez de fixar a contagem.
  perform app.assert(
    (select count(distinct changed_at) = count(*) from public.asset_custody_history
      where asset_id = v_asset),
    'eventos de custódia no mesmo commit têm horários distintos');

  -- Classificação inicial de área não é movimentação: o seed atribuiu área a
  -- todos os ativos e isso não deve ter gerado evento de custódia.
  perform app.assert(
    (select count(*) from public.asset_custody_history
      where asset_id = (select id from public.it_assets where asset_tag = 'PAT-002001')) = 0,
    'atribuir área pela primeira vez não gera evento de custódia');

  perform app.assert(
    (select count(*) from public.it_assets
      where assigned_user_id is null and status = 'active' and deleted_at is null) >= 1,
    'indicador de ativos sem responsável encontra o ativo devolvido');
end
$$;

-- =============================================================================
\echo '=== 15. Anexos de ticket: tipo e cota (Módulo 5) ==='
-- =============================================================================
do $$
declare
  v_ticket uuid;
begin
  select id into v_ticket from public.tickets where ticket_number = 1;

  insert into public.ticket_attachments
    (tenant_id, ticket_id, storage_path, file_name, mime_type, size_bytes)
  values ('a0000000-0000-4000-8000-000000000001', v_ticket,
          'a0/t1/foto.png', 'foto.png', 'image/png', 1024);

  perform app.assert(
    (select kind from public.ticket_attachments where storage_path = 'a0/t1/foto.png') = 'image',
    'kind é derivado do MIME, não confiado ao cliente');

  insert into public.ticket_attachments
    (tenant_id, ticket_id, storage_path, file_name, mime_type, size_bytes)
  values ('a0000000-0000-4000-8000-000000000001', v_ticket,
          'a0/t1/audio.mp3', 'audio.mp3', 'audio/mpeg', 2048);
  perform app.assert(
    (select kind from public.ticket_attachments where storage_path = 'a0/t1/audio.mp3') = 'audio',
    'áudio é classificado como audio');

  -- Cota: 500 MB por ticket. Um arquivo de 600 MB precisa ser recusado no banco.
  begin
    insert into public.ticket_attachments
      (tenant_id, ticket_id, storage_path, file_name, mime_type, size_bytes)
    values ('a0000000-0000-4000-8000-000000000001', v_ticket,
            'a0/t1/gigante.mp4', 'gigante.mp4', 'video/mp4', 600 * 1024 * 1024);
    raise exception 'FALHOU: cota de anexos foi furada';
  exception when check_violation then
    raise notice '  ok  cota de anexos do ticket é aplicada no banco';
  end;

  perform app.assert(app.fn_ticket_attachment_usage(v_ticket) = 3072,
    'consumo de anexos do ticket é somado corretamente');
end
$$;

-- =============================================================================
\echo '=== 16. Links de internet (Módulo 8) ==='
-- =============================================================================
do $$
declare
  v_link uuid;
  v_event bigint;
begin
  perform app.assert((select count(*) from public.internet_links) = 3,
    'seed cadastra os links de internet');

  select id into v_link from public.internet_links where contract_number = 'NL-LINK-003';

  perform app.assert(
    (select last_state from public.internet_links where id = v_link) = 'down',
    'link de Manaus está marcado como fora do ar');

  -- IP fixo sem endereço.
  begin
    insert into public.internet_links
      (tenant_id, branch_id, technology, carrier_name, has_static_ip, status)
    values ('a0000000-0000-4000-8000-000000000001', '11110000-0000-4000-8000-000000000001',
            'fiber', 'Teste', true, 'active');
    raise exception 'FALHOU: IP fixo sem endereço foi aceito';
  exception when check_violation then
    raise notice '  ok  IP fixo exige endereço informado';
  end;

  -- Link precisa de operadora, por cadastro ou por texto.
  begin
    insert into public.internet_links (tenant_id, branch_id, technology, status)
    values ('a0000000-0000-4000-8000-000000000001', '11110000-0000-4000-8000-000000000001',
            'radio', 'active');
    raise exception 'FALHOU: link sem operadora foi aceito';
  exception when check_violation then
    raise notice '  ok  link exige fornecedor cadastrado ou nome da operadora';
  end;

  -- Contrato duplicado por tenant.
  begin
    insert into public.internet_links
      (tenant_id, branch_id, technology, carrier_name, contract_number, status)
    values ('a0000000-0000-4000-8000-000000000001', '11110000-0000-4000-8000-000000000001',
            'fiber', 'Outra', 'nl-link-001', 'active');
    raise exception 'FALHOU: número de contrato duplicado foi aceito';
  exception when unique_violation then
    raise notice '  ok  número de contrato é único por tenant (case-insensitive)';
  end;

  -- Duração é coluna gerada: fecha o evento e confere.
  select id into v_event from public.link_availability_events where link_id = v_link;
  perform app.assert(
    (select duration_seconds is null from public.link_availability_events where id = v_event),
    'evento em aberto não tem duração');

  update public.link_availability_events
     set ended_at = started_at + interval '30 minutes' where id = v_event;
  perform app.assert(
    (select duration_seconds from public.link_availability_events where id = v_event) = 1800,
    'duração do evento é calculada pela coluna gerada');

  -- Idempotência do webhook de monitoração.
  insert into public.link_availability_events
    (tenant_id, link_id, state, source, external_event_id, ended_at)
  values ('a0000000-0000-4000-8000-000000000001', v_link, 'down', 'zabbix', 'zbx-991', now());
  begin
    insert into public.link_availability_events
      (tenant_id, link_id, state, source, external_event_id, ended_at)
    values ('a0000000-0000-4000-8000-000000000001', v_link, 'down', 'zabbix', 'zbx-991', now());
    raise exception 'FALHOU: evento de monitoração duplicado foi aceito';
  exception when unique_violation then
    raise notice '  ok  evento de monitoração é idempotente por ID externo';
  end;
end
$$;

-- =============================================================================
\echo '=== 17. SLA editável e transferência em massa (Módulo 1) ==='
-- =============================================================================
do $$
declare
  v_def uuid;
  v_preview record;
  v_moved integer;
  v_queue uuid := 'e0000000-0000-4000-8000-000000000003';  -- fila Telefonia
  v_ids uuid[];
begin
  -- Preview de impacto sobre a definição que mede tickets reais.
  select sla_definition_id into v_def from public.sla_tracking
   where sla_definition_id is not null limit 1;

  select * into v_preview from app.fn_sla_impact_preview(v_def);
  perform app.assert(v_preview.affected_open >= 1,
    'preview de impacto conta tickets em aberto medidos pela definição');

  -- Soft delete libera a combinação para ser recriada.
  update public.sla_definitions set deleted_at = now() where id = v_def;
  perform app.assert(
    (select deleted_at is not null from public.sla_definitions where id = v_def),
    'SLA aceita desativação por soft delete');
  update public.sla_definitions set deleted_at = null where id = v_def;

  -- Desempate customizado exige critério do catálogo fechado.
  begin
    update public.queues set tiebreaker = 'custom' where slug = 'infra';
    raise exception 'FALHOU: desempate custom sem critério foi aceito';
  exception when check_violation then
    raise notice '  ok  desempate custom exige critério do catálogo';
  end;

  update public.queues set tiebreaker = 'custom', tiebreaker_criterion = 'menor_prazo_restante'
   where slug = 'infra';
  raise notice '  ok  desempate custom aceita critério válido';

  -- Transferência em massa sem motivo.
  select array_agg(id) into v_ids from public.tickets
   where queue_id <> v_queue and deleted_at is null limit 1;

  begin
    perform app.fn_bulk_transfer_queue(v_ids, v_queue, '');
    raise exception 'FALHOU: transferência em massa sem motivo foi aceita';
  exception when check_violation then
    raise notice '  ok  transferência em massa exige motivo';
  end;

  select app.fn_bulk_transfer_queue(v_ids, v_queue, 'Consolidação da fila de telefonia')
    into v_moved;
  perform app.assert(v_moved >= 1, 'transferência em massa move os tickets');
  perform app.assert(
    (select count(*) from public.ticket_history
      where field = 'queue_transfer_reason'
        and new_value = 'Consolidação da fila de telefonia') >= 1,
    'transferência em massa grava o motivo no histórico de cada ticket');
end
$$;

-- =============================================================================
\echo '=== 18. Versionamento de mapeamento (Módulo 10) ==='
-- =============================================================================
do $$
declare
  v_int uuid := '66660000-0000-4000-8000-000000000001';
  v_before int;
  v_snapshot jsonb;
begin
  select count(*) into v_before from public.integration_mapping_versions
   where integration_id = v_int;
  perform app.assert(v_before > 0,
    'mapeamentos do seed já geraram versões por trigger');

  update public.integration_mappings set default_value = 'medium'
   where integration_id = v_int and target_field = 'priority_key';

  perform app.assert(
    (select count(*) from public.integration_mapping_versions where integration_id = v_int) > v_before,
    'alterar mapeamento cria versão nova');

  select snapshot into v_snapshot from public.integration_mapping_versions
   where integration_id = v_int order by version desc limit 1;
  perform app.assert(jsonb_typeof(v_snapshot) = 'array' and jsonb_array_length(v_snapshot) >= 10,
    'snapshot guarda o CONJUNTO completo de mapeamentos');
end
$$;

-- =============================================================================
\echo '=== 19. Views de mapa (Módulo 11) ==='
-- =============================================================================
do $$
declare
  v_row record;
begin
  perform app.assert(
    (select count(*) from public.branches
      where latitude is not null and tenant_id = 'a0000000-0000-4000-8000-000000000001') = 3,
    'três filiais têm coordenadas; a quarta fica sem, de propósito');

  -- Par de coordenadas: latitude sem longitude não pode existir.
  begin
    update public.branches set longitude = null
     where id = '11110000-0000-4000-8000-000000000001';
    raise exception 'FALHOU: coordenada pela metade foi aceita';
  exception when check_violation then
    raise notice '  ok  latitude e longitude só existem em par';
  end;

  select * into v_row from public.vw_map_internet
   where branch_id = '11110000-0000-4000-8000-000000000003';
  perform app.assert(v_row.links_down = 1 and v_row.marker_state = 'red',
    'mapa de links marca em vermelho a filial com link fora do ar');

  select * into v_row from public.vw_map_assets
   where branch_id = '11110000-0000-4000-8000-000000000001';
  perform app.assert(v_row.marker_state in ('red','amber','green'),
    'mapa de inventário calcula o semáforo na view');

  perform app.assert(
    (select count(*) from public.vw_map_area_breakdown
      where branch_id = '11110000-0000-4000-8000-000000000001') = 8,
    'detalhamento por área devolve as áreas da filial');

  perform app.assert(
    (select sum(assets_total) from public.vw_map_area_breakdown
      where branch_id = '11110000-0000-4000-8000-000000000001') > 0,
    'detalhamento por área conta os ativos alocados');

  perform app.assert(
    (select total_monthly_cost from public.vw_connectivity_cost
      where branch_id = '11110000-0000-4000-8000-000000000001')
    = (select coalesce(sum(monthly_cost),0) from public.telecom_lines
        where branch_id = '11110000-0000-4000-8000-000000000001' and status = 'active')
    + (select coalesce(sum(monthly_cost),0) from public.internet_links
        where branch_id = '11110000-0000-4000-8000-000000000001' and status = 'active'),
    'custo de conectividade soma telefonia + links da filial');

  perform app.assert(
    (select without_contract from public.vw_internet_dashboard
      where branch_id = '11110000-0000-4000-8000-000000000003' limit 1) = 1,
    'dashboard de links identifica link sem contrato anexado');
end
$$;

-- =============================================================================
\echo '=== 20. Isolamento das tabelas novas ==='
-- =============================================================================
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000099","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
begin
  perform app.assert((select count(*) from public.branch_areas) = 0,
    'tenant 2 não vê áreas do tenant 1');
  perform app.assert((select count(*) from public.internet_links) = 0,
    'tenant 2 não vê links do tenant 1');
  perform app.assert((select count(*) from public.internet_link_attachments) = 0,
    'tenant 2 não vê anexos de link do tenant 1');
  perform app.assert((select count(*) from public.vw_map_internet) = 0,
    'view de mapa respeita RLS via security_invoker');
  perform app.assert((select count(*) from public.vw_connectivity_cost) = 0,
    'view de custo consolidado respeita RLS');
end
$$;

-- Atendente de Manaus vê o link de Manaus, não os de São Paulo.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000004","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert((select count(*) from public.internet_links) = 1,
    'atendente de Manaus vê apenas o link da sua filial');
end
$$;
reset role;

\echo ''
\echo '################  TODOS OS TESTES PASSARAM  ################'
