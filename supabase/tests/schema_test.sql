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

-- =============================================================================
\echo '=== 21. Endereço estruturado e geolocalização (0015) ==='
-- =============================================================================
reset role;
do $$
declare
  v_sp uuid := '11110000-0000-4000-8000-000000000001';
  v_mao uuid := '11110000-0000-4000-8000-000000000003';
  v_vtx uuid := '11110000-0000-4000-8000-000000000004';
  v_ok boolean;
  v_lat numeric;
begin
  -- Completude é regra do banco, não do formulário.
  perform app.assert(
    (select address_complete from public.branches where id = v_sp),
    'filial com os quatro campos é marcada como endereço completo');
  perform app.assert(
    not (select address_complete from public.branches where id = v_mao),
    'filial sem número NÃO é endereço completo');
  perform app.assert(
    not (select address_complete from public.branches where id = v_vtx),
    'filial sem endereço nenhum NÃO é endereço completo');

  -- CEP fora de formato não entra.
  begin
    update public.branches set postal_code = '1310200' where id = v_sp;
    perform app.assert(false, 'CEP sem máscara deveria ser rejeitado pelo CHECK');
  exception when check_violation then
    perform app.assert(true, 'CEP fora do formato 99999-999 é rejeitado');
  end;

  -- Endereço formatado sai na ordem dos Correios.
  perform app.assert(
    public.fn_format_address('Avenida Paulista','1578',null,'Bela Vista','São Paulo','sp','01310-200')
      = 'Avenida Paulista, 1578, Bela Vista, São Paulo/SP, 01310-200',
    'fn_format_address monta o endereço em uma linha');
  perform app.assert(
    public.fn_format_address('Avenida Paulista','1578','Sala 402','Bela Vista','São Paulo','SP','01310-200')
      like '%1578 - Sala 402%',
    'complemento entra depois do número');
  perform app.assert(
    public.fn_format_address(null,null,null,null,null,null,null) is null,
    'endereço vazio devolve null, não string de vírgulas');

  -- Mudar o endereço invalida a coordenada anterior.
  update public.branches set street = 'Avenida Brigadeiro Faria Lima' where id = v_sp;
  select geocode_stale into v_ok from public.branches where id = v_sp;
  perform app.assert(v_ok, 'alterar logradouro marca a coordenada como desatualizada');
  perform app.assert(
    (select geocode_status from public.branches where id = v_sp) = 'pending',
    'alterar endereço devolve o status para pending');

  -- Gravar coordenada nova limpa a pendência e registra a verificação.
  update public.branches
     set latitude = -23.5670, longitude = -46.6930, geocode_precision = 'rooftop',
         geocode_status = 'ok'
   where id = v_sp;
  select geocode_stale into v_ok from public.branches where id = v_sp;
  perform app.assert(not v_ok, 'gravar coordenada nova limpa o sinal de desatualizada');
  perform app.assert(
    (select geocode_verified_at from public.branches where id = v_sp) is not null,
    'gravar coordenada registra o instante da verificação');

  -- Endereço e coordenada no MESMO update não podem marcar desatualizado: é o
  -- que o geocodificador faz, e um falso positivo aqui deixaria toda filial
  -- geocodificada aparecendo como pendente.
  update public.branches
     set street = 'Avenida Paulista', street_number = '1578',
         latitude = -23.5613, longitude = -46.6565
   where id = v_sp;
  select geocode_stale into v_ok from public.branches where id = v_sp;
  perform app.assert(not v_ok,
    'endereço e coordenada gravados juntos não marcam desatualizado');

  -- Log é append-only e guarda o rastro completo.
  insert into public.geocode_logs (tenant_id, branch_id, input_address, status, provider,
                                   latitude, longitude, formatted_address, precision, message)
  values ('a0000000-0000-4000-8000-000000000001', v_sp,
          '{"street":"Avenida Paulista","streetNumber":"1578"}'::jsonb,
          'ok', 'google-geocoding', -23.5613, -46.6565,
          'Av. Paulista, 1578 - Bela Vista, São Paulo - SP', 'rooftop', null);
  perform app.assert((select count(*) from public.geocode_logs where branch_id = v_sp) = 1,
    'log de geocodificação é gravado');

  begin
    insert into public.geocode_logs (tenant_id, branch_id, input_address, status)
    values ('a0000000-0000-4000-8000-000000000001', v_sp, '{}'::jsonb, 'inventado');
    perform app.assert(false, 'status inválido no log deveria ser rejeitado');
  exception when check_violation then
    perform app.assert(true, 'log aceita apenas os códigos de status do fluxo');
  end;

  -- Candidatos de múltiplas correspondências: dois por filial, ordinais únicos.
  insert into public.geocode_candidates (tenant_id, branch_id, ordinal, latitude, longitude,
                                         formatted_address, precision)
  values ('a0000000-0000-4000-8000-000000000001', v_sp, 1, -23.561, -46.656, 'Torre A', 'rooftop'),
         ('a0000000-0000-4000-8000-000000000001', v_sp, 2, -23.562, -46.657, 'Torre B', 'rooftop');
  perform app.assert((select count(*) from public.geocode_candidates where branch_id = v_sp) = 2,
    'candidatos ficam registrados até a confirmação do operador');

  begin
    insert into public.geocode_candidates (tenant_id, branch_id, ordinal, latitude, longitude,
                                           formatted_address, precision)
    values ('a0000000-0000-4000-8000-000000000001', v_sp, 1, -23.563, -46.658, 'Torre C', 'rooftop');
    perform app.assert(false, 'ordinal repetido deveria violar a unicidade');
  exception when unique_violation then
    perform app.assert(true, 'ordinal de candidato é único por filial');
  end;

  begin
    insert into public.geocode_candidates (tenant_id, branch_id, ordinal, latitude, longitude,
                                           formatted_address, precision)
    values ('a0000000-0000-4000-8000-000000000001', v_sp, 9, -100, -46.658, 'Fora do planeta', 'rooftop');
    perform app.assert(false, 'latitude fora de faixa deveria ser rejeitada');
  exception when check_violation then
    perform app.assert(true, 'latitude de candidato é validada');
  end;

  -- A view de endereços expõe o que a tela de cadastro precisa.
  perform app.assert(
    (select pending_candidates from public.vw_branch_addresses where branch_id = v_sp) = 2,
    'vw_branch_addresses conta os candidatos pendentes');
  perform app.assert(
    (select address_formatted from public.vw_branch_addresses where branch_id = v_sp) like 'Avenida Paulista, 1578%',
    'vw_branch_addresses traz o endereço formatado');
  select latitude into v_lat from public.vw_branch_addresses where branch_id = v_sp;
  perform app.assert(v_lat is not null, 'vw_branch_addresses traz a coordenada atual');
end
$$;

-- FK composta: candidato de um tenant não pode apontar filial de outro.
do $$
begin
  begin
    insert into public.geocode_candidates (tenant_id, branch_id, ordinal, latitude, longitude,
                                           formatted_address, precision)
    -- Ordinal livre de propósito: com ordinal repetido a unicidade dispara
    -- ANTES da FK e o teste passaria pelo motivo errado.
    values ('a0000000-0000-4000-8000-000000000002', '11110000-0000-4000-8000-000000000001',
            7, -23.5, -46.6, 'Vazamento', 'rooftop');
    perform app.assert(false, 'candidato cross-tenant deveria ser rejeitado pelo banco');
  exception when foreign_key_violation then
    perform app.assert(true, 'FK composta impede candidato apontando filial de outro tenant');
  end;
end
$$;

-- Isolamento e append-only sob RLS, com papel sem BYPASSRLS.
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000099","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
begin
  perform app.assert((select count(*) from public.geocode_logs) = 0,
    'tenant 2 não vê log de geocodificação do tenant 1');
  perform app.assert((select count(*) from public.geocode_candidates) = 0,
    'tenant 2 não vê candidatos do tenant 1');
  perform app.assert((select count(*) from public.vw_branch_addresses) = 0,
    'vw_branch_addresses respeita RLS via security_invoker');
end
$$;

-- Gestor do tenant 1 enxerga o log, mas não consegue apagá-lo.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert((select count(*) from public.geocode_logs) >= 1,
    'gestor do tenant 1 vê o log de geocodificação');
  begin
    delete from public.geocode_logs;
    perform app.assert(false, 'log de geocodificação não deveria aceitar DELETE');
  exception when insufficient_privilege then
    perform app.assert(true, 'log de geocodificação é append-only para authenticated');
  end;
end
$$;
reset role;


-- =============================================================================
\echo '=== 22. Perfis de acesso e permissões granulares (0017) ==='
-- =============================================================================
reset role;

-- O catálogo do banco tem de casar com PERMISSION_CATALOG de src/lib/permissions.ts.
-- A contagem é a trava mais barata contra divergência: acrescentar permissão no
-- TypeScript sem regenerar o INSERT derruba o CI aqui, em vez de virar um
-- checkbox que não governa nada.
do $$
begin
  perform app.assert((select count(*) from public.permission_catalog) = 108,
    'catálogo de permissões tem as 108 entradas geradas de src/lib/permissions.ts');
  perform app.assert(
    not exists (
      select 1 from public.permission_catalog c
      where c.screen is not null
        and not exists (select 1 from public.permission_catalog p where p.key = c.module)
    ),
    'toda tela do catálogo tem o módulo dela cadastrado');
  perform app.assert(
    not exists (
      select 1 from public.permission_catalog c
      where c.action is not null
        and not exists (
          select 1 from public.permission_catalog p
          where p.key = c.module || '.' || c.screen)
    ),
    'toda ação do catálogo tem a tela dela cadastrada');
end
$$;

-- Todo tenant nasce com os perfis de sistema, e todo usuário com papel
-- conhecido recebe um. Sem isso o ambiente subiria com tudo negado.
do $$
begin
  perform app.assert(
    (select count(distinct system_key) from public.access_profiles
     where tenant_id = 'a0000000-0000-4000-8000-000000000001' and is_system) = 9,
    'os 9 perfis de sistema são semeados por tenant');
  perform app.assert(
    not exists (
      select 1 from public.profiles
      where tenant_id is not null and role <> 'super_admin' and access_profile_id is null
    ),
    'nenhum usuário de tenant ficou sem perfil de acesso');
end
$$;

-- Grant fora do teto do perfil é recusado na escrita — o checkbox não chega a
-- existir marcado no banco.
do $$
declare
  v_profile uuid;
begin
  insert into public.access_profiles (tenant_id, name, base_role)
  values ('a0000000-0000-4000-8000-000000000001', 'Teste Teto', 'gestor')
  returning id into v_profile;

  begin
    insert into public.permission_grants (tenant_id, profile_id, permission_key)
    values ('a0000000-0000-4000-8000-000000000001', v_profile, 'usuarios.perfis.editar');
    perform app.assert(false, 'grant acima do teto do perfil não deveria ser aceito');
  exception when check_violation then
    perform app.assert(true, 'grant acima do teto do perfil é recusado');
  end;

  delete from public.access_profiles where id = v_profile;
end
$$;

-- Perfil de sistema é contrato da plataforma: aceita ativar/inativar e nada mais.
do $$
begin
  begin
    update public.access_profiles set name = 'Renomeado'
    where tenant_id = 'a0000000-0000-4000-8000-000000000001' and system_key = 'visualizador';
    perform app.assert(false, 'perfil de sistema não deveria aceitar renomeação');
  exception when insufficient_privilege then
    perform app.assert(true, 'perfil de sistema recusa renomeação');
  end;
end
$$;

-- Herança de negação, com perfil controlado: só consulta de inventário.
do $$
declare
  v_profile uuid;
  v_antigo  uuid;
begin
  select access_profile_id into v_antigo from public.profiles
  where id = '22220000-0000-4000-8000-000000000002';

  perform set_config('request.jwt.claims', '', true);
  insert into public.access_profiles (tenant_id, name, base_role)
  values ('a0000000-0000-4000-8000-000000000001', 'Teste Granular', 'gestor')
  returning id into v_profile;

  insert into public.permission_grants (tenant_id, profile_id, permission_key)
  values ('a0000000-0000-4000-8000-000000000001', v_profile, 'inventario'),
         ('a0000000-0000-4000-8000-000000000001', v_profile, 'inventario.ativos'),
         ('a0000000-0000-4000-8000-000000000001', v_profile, 'inventario.ativos.ver');

  update public.profiles set access_profile_id = v_profile
  where id = '22220000-0000-4000-8000-000000000002';

  set local role rls_tester;
  set local request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';

  perform app.assert(app.has_permission('inventario.ativos.ver'),
    'permissão concedida em módulo, tela e ação é exercível');
  perform app.assert(not app.has_permission('inventario.ativos.criar'),
    'liberar a tela NÃO libera a ação não concedida');
  perform app.assert(not app.has_permission('sla.definicoes.criar'),
    'módulo não concedido nega ação de outro módulo');

  reset role;
  perform set_config('request.jwt.claims', '', true);
  -- Grant órfão: a ação sobrevive, o módulo não. É o caso da despromoção mal
  -- feita, em que a versão ingênua de has_permission liberaria a ação.
  delete from public.permission_grants
  where profile_id = v_profile and permission_key = 'inventario';

  set local role rls_tester;
  set local request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
  perform app.assert(not app.has_permission('inventario.ativos.ver'),
    'grant órfão de ação, sem o módulo, não vale — negação herda para baixo');
  reset role;
  perform set_config('request.jwt.claims', '', true);

  update public.profiles set access_profile_id = v_antigo
  where id = '22220000-0000-4000-8000-000000000002';
  delete from public.access_profiles where id = v_profile;
end
$$;

-- effective_base_role: o perfil restringe o RLS e nunca o eleva.
do $$
declare
  v_restrito uuid;
  v_alto     uuid;
  v_antigo_g uuid;
  v_antigo_a uuid;
begin
  select access_profile_id into v_antigo_g from public.profiles
  where id = '22220000-0000-4000-8000-000000000002';
  select access_profile_id into v_antigo_a from public.profiles
  where id = '22220000-0000-4000-8000-000000000003';

  perform set_config('request.jwt.claims', '', true);
  insert into public.access_profiles (tenant_id, name, base_role)
  values ('a0000000-0000-4000-8000-000000000001', 'Teste Restrito', 'visualizador')
  returning id into v_restrito;
  insert into public.access_profiles (tenant_id, name, base_role)
  values ('a0000000-0000-4000-8000-000000000001', 'Teste Alto', 'admin')
  returning id into v_alto;

  -- Gestor com perfil de teto visualizador perde a escrita.
  update public.profiles set access_profile_id = v_restrito
  where id = '22220000-0000-4000-8000-000000000002';
  set local role rls_tester;
  set local request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
  perform app.assert(app.effective_base_role() = 'visualizador',
    'perfil mais restrito rebaixa o papel efetivo do gestor');
  perform app.assert(not app.can_manage_records(),
    'gestor com perfil de teto visualizador perde can_manage_records');
  reset role;

  -- Atendente com perfil de teto admin NÃO é promovido.
  update public.profiles set access_profile_id = v_alto
  where id = '22220000-0000-4000-8000-000000000003';
  set local role rls_tester;
  set local request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
  perform app.assert(app.effective_base_role() = 'atendente',
    'perfil de teto alto não promove o papel do usuário');
  perform app.assert(not app.can_manage_config(),
    'atendente com perfil de teto admin continua sem can_manage_config');
  reset role;
  perform set_config('request.jwt.claims', '', true);

  update public.profiles set access_profile_id = v_antigo_g
  where id = '22220000-0000-4000-8000-000000000002';
  update public.profiles set access_profile_id = v_antigo_a
  where id = '22220000-0000-4000-8000-000000000003';
  delete from public.access_profiles where id in (v_restrito, v_alto);
end
$$;

-- Ninguém troca o próprio perfil de acesso: a trigger de 0012 só olhava
-- `role` e `tenant_id`, então esta era uma porta aberta para auto-promoção.
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
declare
  v_outro uuid;
begin
  select id into v_outro from public.access_profiles
  where tenant_id = 'a0000000-0000-4000-8000-000000000001' and system_key = 'visualizador';
  begin
    update public.profiles set access_profile_id = v_outro
    where id = '22220000-0000-4000-8000-000000000001';
    perform app.assert(false, 'admin não deveria trocar o próprio perfil de acesso');
  exception when insufficient_privilege then
    perform app.assert(true, 'trocar o próprio perfil de acesso é recusado');
  end;
end
$$;

-- Atendente não administra perfis nem concede permissão a si mesmo.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert((select count(*) from public.access_profiles) >= 9,
    'atendente lê os perfis do tenant (o formulário de usuário precisa listar)');
  begin
    insert into public.access_profiles (tenant_id, name, base_role)
    values ('a0000000-0000-4000-8000-000000000001', 'Perfil Pirata', 'admin');
    perform app.assert(false, 'atendente não deveria criar perfil de acesso');
  exception when insufficient_privilege then
    perform app.assert(true, 'atendente é barrado ao criar perfil de acesso');
  end;
end
$$;

-- Isolamento entre tenants.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000099","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
begin
  perform app.assert(
    not exists (
      select 1 from public.access_profiles
      where tenant_id = 'a0000000-0000-4000-8000-000000000001'),
    'tenant 2 não vê perfil de acesso do tenant 1');
  perform app.assert(
    not exists (
      select 1 from public.permission_grants
      where tenant_id = 'a0000000-0000-4000-8000-000000000001'),
    'tenant 2 não vê concessão do tenant 1');
  perform app.assert((select count(*) from public.permission_catalog) = 108,
    'catálogo é global: visível para qualquer tenant');
end
$$;
reset role;


-- =============================================================================
\echo '=== 23. Base do financeiro: centros de custo e contas (0018) ==='
-- =============================================================================
reset role;

-- Correção estrutural: sem esta unique, nenhum título poderá referenciar o
-- contrato do fornecedor por FK composta.
do $$
begin
  perform app.assert(
    exists (
      select 1 from pg_constraint
      where conname = 'uq_supplier_contracts_id_tenant'
        and conrelid = 'public.supplier_contracts'::regclass),
    'supplier_contracts passou a ter unique (id, tenant_id) para FK composta');
end
$$;

-- Profundidade de centro de custo: 3 níveis passam, o 4º não.
do $$
declare
  n1 uuid; n2 uuid; n3 uuid;
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.cost_centers (tenant_id, code, name)
  values ('a0000000-0000-4000-8000-000000000001', 'CC-1', 'Operação') returning id into n1;
  insert into public.cost_centers (tenant_id, code, name, parent_id)
  values ('a0000000-0000-4000-8000-000000000001', 'CC-1.1', 'Campo', n1) returning id into n2;
  insert into public.cost_centers (tenant_id, code, name, parent_id)
  values ('a0000000-0000-4000-8000-000000000001', 'CC-1.1.1', 'Enfermagem', n2) returning id into n3;
  perform app.assert(true, 'centro de custo aceita 3 níveis');

  begin
    insert into public.cost_centers (tenant_id, code, name, parent_id)
    values ('a0000000-0000-4000-8000-000000000001', 'CC-1.1.1.1', 'Quarto nível', n3);
    perform app.assert(false, 'centro de custo não deveria aceitar o 4º nível');
  exception when check_violation then
    perform app.assert(true, 'centro de custo recusa o 4º nível');
  end;

  -- Ciclo: apontar o avô para o neto giraria para sempre sem a saída da trigger.
  begin
    update public.cost_centers set parent_id = n3 where id = n1;
    perform app.assert(false, 'hierarquia não deveria aceitar ciclo');
  exception when check_violation then
    perform app.assert(true, 'hierarquia de centro de custo recusa ciclo');
  end;

  -- Código é único por tenant, ignorando maiúsculas.
  begin
    insert into public.cost_centers (tenant_id, code, name)
    values ('a0000000-0000-4000-8000-000000000001', 'cc-1', 'Duplicado');
    perform app.assert(false, 'código de centro de custo deveria ser único por tenant');
  exception when unique_violation then
    perform app.assert(true, 'código de centro de custo é único por tenant (case-insensitive)');
  end;

  delete from public.cost_centers where id in (n3, n2, n1);
end
$$;

-- Saldo derivado e transferência de dupla entrada.
do $$
declare
  ca uuid; cb uuid; grp uuid := gen_random_uuid();
  v_saldo numeric;
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.bank_accounts (tenant_id, name, bank_name, account_number, opening_balance)
  values ('a0000000-0000-4000-8000-000000000001', 'Operação', 'Banco X', '111', 1000)
  returning id into ca;
  insert into public.bank_accounts (tenant_id, name, bank_name, account_number, opening_balance)
  values ('a0000000-0000-4000-8000-000000000001', 'Investimento', 'Banco X', '222', 500)
  returning id into cb;

  insert into public.bank_account_movements
    (tenant_id, bank_account_id, direction, amount, moved_on, description)
  values ('a0000000-0000-4000-8000-000000000001', ca, 'in', 250, current_date, 'Recebimento'),
         ('a0000000-0000-4000-8000-000000000001', ca, 'out', 100, current_date, 'Taxa');

  select current_balance into v_saldo from public.vw_bank_account_balances where bank_account_id = ca;
  perform app.assert(v_saldo = 1150,
    'saldo da conta é derivado: inicial 1000 + 250 - 100 = 1150');

  -- Valor negativo é recusado: o sinal é responsabilidade de `direction`.
  begin
    insert into public.bank_account_movements
      (tenant_id, bank_account_id, direction, amount, moved_on, description)
    values ('a0000000-0000-4000-8000-000000000001', ca, 'out', -50, current_date, 'Absurdo');
    perform app.assert(false, 'movimentação de valor negativo não deveria ser aceita');
  exception when check_violation then
    perform app.assert(true, 'movimentação exige valor positivo');
  end;

  -- Transferência válida: duas metades, contas distintas, mesmo valor.
  insert into public.bank_account_movements
    (tenant_id, bank_account_id, direction, amount, moved_on, description, transfer_group)
  values ('a0000000-0000-4000-8000-000000000001', ca, 'out', 300, current_date, 'Para investimento', grp),
         ('a0000000-0000-4000-8000-000000000001', cb, 'in',  300, current_date, 'Da operação', grp);
  perform app.assert(
    (select current_balance from public.vw_bank_account_balances where bank_account_id = ca) = 850
    and (select current_balance from public.vw_bank_account_balances where bank_account_id = cb) = 800,
    'transferência interna move saldo das duas contas por dupla entrada');

  delete from public.bank_account_movements where bank_account_id in (ca, cb);
  delete from public.bank_accounts where id in (ca, cb);
end
$$;

-- Meia transferência é recusada no COMMIT — a trigger é deferrable justamente
-- para a primeira metade não derrubar a inserção da segunda.
do $$
declare
  ca uuid;
begin
  perform set_config('request.jwt.claims', '', true);
  begin
    insert into public.bank_accounts (tenant_id, name, bank_name, account_number)
    values ('a0000000-0000-4000-8000-000000000001', 'Temp', 'Banco Y', '999') returning id into ca;
    insert into public.bank_account_movements
      (tenant_id, bank_account_id, direction, amount, moved_on, description, transfer_group)
    values ('a0000000-0000-4000-8000-000000000001', ca, 'out', 10, current_date, 'Meia', gen_random_uuid());
    -- Força a checagem diferida sem encerrar o bloco externo.
    set constraints all immediate;
    perform app.assert(false, 'meia transferência não deveria passar');
  exception when check_violation then
    perform app.assert(true, 'transferência com uma só metade é recusada');
  end;
end
$$;

-- Isolamento e escrita restrita a quem administra registros.
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  begin
    insert into public.bank_accounts (tenant_id, name, bank_name)
    values ('a0000000-0000-4000-8000-000000000001', 'Pirata', 'Banco Z');
    perform app.assert(false, 'atendente não deveria criar conta bancária');
  exception when insufficient_privilege then
    perform app.assert(true, 'atendente é barrado ao criar conta bancária');
  end;
end
$$;

set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000099","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
begin
  perform app.assert(
    not exists (select 1 from public.cost_centers
                where tenant_id = 'a0000000-0000-4000-8000-000000000001'),
    'tenant 2 não vê centro de custo do tenant 1');
  perform app.assert(
    not exists (select 1 from public.vw_bank_account_balances
                where tenant_id = 'a0000000-0000-4000-8000-000000000001'),
    'vw_bank_account_balances respeita RLS via security_invoker');
end
$$;
reset role;

\echo ''
\echo '################  TODOS OS TESTES PASSARAM  ################'
