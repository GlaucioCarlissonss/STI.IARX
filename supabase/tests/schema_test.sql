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

  -- A view `vw_telecom_costs` foi removida na 0026 por ser subconjunto estrito
  -- de `vw_telecom_dashboard`. A asserção migrou para a view que ficou, com o
  -- mesmo número e o mesmo recorte.
  perform app.assert(
    (select sum(monthly_total) from public.vw_telecom_dashboard
      where carrier = 'TIM' and status = 'active'
        and tenant_id = 'a0000000-0000-4000-8000-000000000001') = 189.90,
    'o painel de telefonia soma o custo por operadora');
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

  -- Caminho na convenção real ({tenant}/{entidade}/{id}/{arquivo}). Fixture com
  -- caminho inventado ensinaria a forma errada, e a seção 28 cobra a convenção nas
  -- cinco tabelas de anexo.
  insert into public.ticket_attachments
    (tenant_id, ticket_id, storage_path, file_name, mime_type, size_bytes)
  values ('a0000000-0000-4000-8000-000000000001', v_ticket,
          format('a0000000-0000-4000-8000-000000000001/tickets/%s/foto.png', v_ticket),
          'foto.png', 'image/png', 1024);

  perform app.assert(
    (select kind from public.ticket_attachments
      where storage_path like '%/foto.png') = 'image',
    'kind é derivado do MIME, não confiado ao cliente');

  insert into public.ticket_attachments
    (tenant_id, ticket_id, storage_path, file_name, mime_type, size_bytes)
  values ('a0000000-0000-4000-8000-000000000001', v_ticket,
          format('a0000000-0000-4000-8000-000000000001/tickets/%s/audio.mp3', v_ticket),
          'audio.mp3', 'audio/mpeg', 2048);
  perform app.assert(
    (select kind from public.ticket_attachments
      where storage_path like '%/audio.mp3') = 'audio',
    'áudio é classificado como audio');

  -- Cota: 500 MB por ticket. Um arquivo de 600 MB precisa ser recusado no banco.
  begin
    insert into public.ticket_attachments
      (tenant_id, ticket_id, storage_path, file_name, mime_type, size_bytes)
    values ('a0000000-0000-4000-8000-000000000001', v_ticket,
            format('a0000000-0000-4000-8000-000000000001/tickets/%s/gigante.mp4', v_ticket),
            'gigante.mp4', 'video/mp4', 600 * 1024 * 1024);
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

  -- Reabre a queda. Desde a 0022 o estado do link é DERIVADO dos eventos
  -- (`trg_link_event_syncs_state`), então fechar este evento aqui devolveria o
  -- NL-LINK-003 para "no ar" e a seção 19 deixaria de encontrar a filial vermelha
  -- do mapa. O que este bloco quer provar é a coluna gerada, não mudar o estado do
  -- parque — então ele desfaz o que fez.
  update public.link_availability_events set ended_at = null where id = v_event;
  perform app.assert(
    (select last_state from public.internet_links where id = v_link) = 'down',
    'o estado do link acompanha o evento reaberto');

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
  perform app.assert((select count(*) from public.permission_catalog) = 158,
    'catálogo de permissões tem as 158 entradas geradas de src/lib/permissions.ts');
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
  perform app.assert((select count(*) from public.permission_catalog) = 158,
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


-- =============================================================================
\echo '=== 24. A matriz de permissões contra os usuários do seed ==='
-- =============================================================================
-- As asserções da seção 22 provam a FUNÇÃO `app.has_permission()` com perfis
-- criados e destruídos ali mesmo. Esta seção prova a MATRIZ COMO ELA FICA no
-- ambiente que o seed entrega: dois usuários com o mesmo papel `gestor` e perfis
-- de acesso diferentes.
--
-- Este contraste é o motivo de o módulo de permissões existir. Se ele não for
-- verificado com os usuários reais, a regressão que reatribui o perfil-padrão a
-- todo mundo passa pelo CI sem barulho — o papel continua `gestor` nos dois e as
-- 118 policies de RLS não notam diferença nenhuma.
reset role;

-- Diego: Operador Financeiro. Lança movimentação, não cadastra conta.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(app.effective_base_role() = 'gestor',
    'Operador Financeiro mantém o teto de RLS do papel gestor');
  perform app.assert(app.has_permission('financeiro.contas_bancarias.ver'),
    'Operador Financeiro consulta conta bancária');
  perform app.assert(app.has_permission('financeiro.contas_bancarias.movimentar'),
    'Operador Financeiro lança movimentação');
  perform app.assert(not app.has_permission('financeiro.contas_bancarias.criar'),
    'Operador Financeiro NÃO cadastra conta bancária');
  perform app.assert(not app.has_permission('financeiro.contas_bancarias.transferir'),
    'Operador Financeiro NÃO transfere entre contas');
  -- O perfil não abre porta em outro módulo só porque o papel é gestor.
  perform app.assert(not app.has_permission('sla.definicoes.criar'),
    'Operador Financeiro NÃO configura SLA, apesar do papel gestor');
  perform app.assert(not app.has_permission('usuarios.perfis.editar'),
    'Operador Financeiro NÃO edita perfil de acesso');
end
$$;

-- Elis: Aprovador Financeiro. Consulta, e é aqui que se vê que consultar não é
-- movimentar — a distinção que o botão "Aprovar" vai depender.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000007","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(app.has_permission('financeiro.contas_bancarias.ver'),
    'Aprovador Financeiro consulta conta bancária');
  perform app.assert(not app.has_permission('financeiro.contas_bancarias.movimentar'),
    'Aprovador Financeiro NÃO lança movimentação');
  perform app.assert(not app.has_permission('financeiro.contas_bancarias.criar'),
    'Aprovador Financeiro NÃO cadastra conta bancária');
end
$$;

-- Gestor de TI: o outro lado do contraste. Mesmo papel `gestor`, e o financeiro
-- inteiro fechado.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(app.has_permission('sla.definicoes.criar'),
    'Gestor de TI configura SLA');
  perform app.assert(not app.has_permission('financeiro.contas_bancarias.ver'),
    'Gestor de TI NÃO enxerga conta bancária, apesar do papel gestor');
  perform app.assert(not app.has_permission('financeiro.centros_custo.criar'),
    'Gestor de TI NÃO cadastra centro de custo');
end
$$;

-- Solicitante: o piso. Precisa abrir ticket e nada além.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(app.has_permission('helpdesk.tickets.criar'),
    'Solicitante abre ticket — a razão de ele existir no sistema');
  perform app.assert(not app.has_permission('helpdesk.tickets.comentar_interno'),
    'Solicitante NÃO escreve comentário interno');
  perform app.assert(not app.has_permission('financeiro.contas_bancarias.ver'),
    'Solicitante NÃO enxerga o financeiro');
end
$$;

-- Todo usuário-semente com perfil alcança ALGUMA tela de módulo.
--
-- Esta asserção nasceu falhando e achou um defeito real: `Aprovador Financeiro`
-- não recebe o módulo de helpdesk — o que é correto —, e `requireScreen()`
-- mandava todo mundo negado para `/painel`, que negava de novo. Laço de
-- redirect. A correção foi `landingHref()` em `src/lib/navigation.ts`, que só
-- devolve tela permitida.
--
-- Aqui a cobrança é a precondição daquele helper: perfil que não alcança tela
-- nenhuma derruba a pessoa em `/conta` e deixa o produto inútil para ela.
do $$
declare
  v_user record;
  v_telas int;
begin
  for v_user in
    select id, full_name from public.profiles
    where tenant_id = 'a0000000-0000-4000-8000-000000000001'
      and access_profile_id is not null
  loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_user.id, 'role', 'authenticated')::text, true);
    select count(*) into v_telas
    from public.permission_catalog c
    where c.action = 'ver' and app.has_permission(c.key);
    perform app.assert(v_telas > 0,
      format('%s alcança ao menos uma tela — sem isso o login cai em /conta e nada mais',
             v_user.full_name));
  end loop;
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- E o destino de quem é do financeiro é o financeiro, não o helpdesk.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000007","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(not app.has_permission('helpdesk.painel.ver'),
    'Aprovador Financeiro não alcança o painel — é por isso que o redirect fixo laçava');
  perform app.assert(app.has_permission('financeiro.centros_custo.ver'),
    'Aprovador Financeiro alcança o financeiro, que é o destino que landingHref() escolhe');
end
$$;

-- O seed entrega o financeiro navegável. Tela financeira que abre vazia não
-- prova que a consulta funciona nem que a view calcula.
reset role;
do $$
begin
  perform app.assert((select count(*) from public.cost_centers) >= 4,
    'seed entrega centros de custo (a hierarquia de 3 níveis inclusive)');
  perform app.assert(
    (select count(*) from public.cost_centers c1
     join public.cost_centers c2 on c2.parent_id = c1.id
     join public.cost_centers c3 on c3.parent_id = c2.id) >= 1,
    'seed exercita os 3 níveis de centro de custo');
  perform app.assert(
    (select current_balance from public.vw_bank_account_balances where name = 'Operação')
      = 63300.00,
    'saldo derivado da conta Operação fecha em 63.300,00 (42.000 + 38.000 - 16.700)');
  perform app.assert(
    (select count(distinct bank_account_id) from public.bank_account_movements
     where transfer_group is not null) = 2,
    'a transferência do seed tem as duas metades, em contas diferentes');
  perform app.assert(
    (select sum(case when direction = 'in' then amount else -amount end)
     from public.bank_account_movements where transfer_group is not null) = 0,
    'as duas metades da transferência se anulam — dupla entrada de verdade');
end
$$;


-- =============================================================================
\echo '=== 25. Storage de anexos: bucket e autorização por caminho (0019) ==='
-- =============================================================================
-- O upload HTTP em si fala com a API de Storage e não pode ser exercitado aqui.
-- O que PODE ser provado é a decisão de autorização, que é onde mora o risco:
-- se a policy estiver errada, um tenant lê o anexo do outro.
reset role;

do $$
declare
  v_bucket record;
begin
  select * into v_bucket from storage.buckets where id = 'anexos';
  perform app.assert(v_bucket.id is not null, 'bucket `anexos` existe');
  perform app.assert(v_bucket.public = false,
    'bucket `anexos` é PRIVADO — público tornaria storage_path uma URL adivinhável');
  perform app.assert(v_bucket.file_size_limit = 26214400,
    'bucket tem limite de 25 MB por arquivo');
  -- A mesma lista está em src/lib/storage.ts. Divergir faria a aplicação aceitar
  -- um arquivo que o bucket recusa depois de subir a rede toda.
  perform app.assert(array_length(v_bucket.allowed_mime_types, 1) = 13,
    'bucket declara os 13 tipos aceitos, iguais aos de src/lib/storage.ts');
  perform app.assert('application/pdf' = any (v_bucket.allowed_mime_types),
    'PDF está entre os tipos aceitos');
  perform app.assert(not ('application/x-msdownload' = any (v_bucket.allowed_mime_types)),
    'executável NÃO está entre os tipos aceitos');
end
$$;

-- As funções de leitura de caminho, isoladas.
do $$
begin
  perform app.assert(
    app.storage_tenant('a0000000-0000-4000-8000-000000000001/tickets/abc/nota.pdf')
      = 'a0000000-0000-4000-8000-000000000001',
    'storage_tenant lê o primeiro segmento do caminho');
  -- Caminho malformado tem de devolver NULL, não levantar exceção: exceção
  -- dentro de policy vira erro 500 opaco em vez de negação limpa.
  perform app.assert(app.storage_tenant('nao-e-uuid/tickets/abc/nota.pdf') is null,
    'storage_tenant devolve NULL em caminho malformado, sem levantar exceção');
  perform app.assert(app.storage_tenant('arquivo-solto.pdf') is null,
    'storage_tenant devolve NULL em caminho sem pasta');
  perform app.assert(
    app.storage_entity('a0000000-0000-4000-8000-000000000001/tickets/abc/nota.pdf') = 'tickets',
    'storage_entity lê o segundo segmento');
end
$$;

-- O mapa de permissão. O `else null` é a decisão de segurança da migração.
do $$
begin
  perform app.assert(app.storage_permission_key('tickets', 'anexar') = 'helpdesk.tickets.anexar',
    'mapa de permissão cobre ticket');
  perform app.assert(app.storage_permission_key('ativos', 'remover') = 'inventario.ativos.remover_anexo',
    'mapa de permissão cobre ativo');
  perform app.assert(app.storage_permission_key('linhas', 'ver') = 'telefonia.linhas.ver',
    'mapa de permissão cobre linha');
  perform app.assert(app.storage_permission_key('faturas', 'anexar') is null,
    'entidade desconhecida NÃO tem chave — prefixo novo não nasce liberado');
  perform app.assert(app.storage_permission_key('tickets', 'inventar') is null,
    'verbo desconhecido NÃO tem chave');
  -- `links` esteve deliberadamente fora até a 0022, porque a tabela existia e a
  -- tela não. Entrou junto com a tela — que é a regra, não uma exceção.
  perform app.assert(app.storage_permission_key('links', 'anexar') = 'conectividade.links.anexar',
    'links entrou junto com a tela (0022)');
  perform app.assert(app.storage_permission_key('links', 'assinar') is null,
    'verbo desconhecido em links também NÃO tem chave');
  perform app.assert(
    (select count(*) from public.permission_catalog where action in ('anexar','remover_anexo')) = 10,
    'as 10 chaves de anexo entraram no catálogo (ticket, ativo, linha, título e link)');
end
$$;

-- -----------------------------------------------------------------------------
-- can_touch_attachment: a tabela-verdade
-- -----------------------------------------------------------------------------
-- Administrador IAR (tenant 1), que tem Admin do Cliente e portanto todas as
-- chaves que o teto `admin` alcança.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
declare
  v_ok   text := 'a0000000-0000-4000-8000-000000000001/tickets/11110000-0000-4000-8000-000000000001/x.pdf';
  v_outro text := 'a0000000-0000-4000-8000-000000000002/tickets/11110000-0000-4000-8000-000000000001/x.pdf';
begin
  perform app.assert(app.can_touch_attachment(v_ok, 'anexar'),
    'admin anexa no caminho do próprio tenant');
  perform app.assert(app.can_touch_attachment(v_ok, 'ver'),
    'admin consulta no caminho do próprio tenant');
  perform app.assert(app.can_touch_attachment(v_ok, 'remover'),
    'admin remove no caminho do próprio tenant');

  -- O caso que importa: caminho de OUTRO tenant.
  perform app.assert(not app.can_touch_attachment(v_outro, 'ver'),
    'NEGA caminho de outro tenant, mesmo com permissão de sobra');
  perform app.assert(not app.can_touch_attachment(v_outro, 'anexar'),
    'NEGA anexar em caminho de outro tenant');

  -- Profundidade. Sem esta checagem sobraria objeto solto sem entidade dona:
  -- anexo que nenhuma tela mostra e nenhuma cota conta.
  perform app.assert(
    not app.can_touch_attachment('a0000000-0000-4000-8000-000000000001/tickets/x.pdf', 'anexar'),
    'NEGA caminho com pasta faltando');
  perform app.assert(
    not app.can_touch_attachment(
      'a0000000-0000-4000-8000-000000000001/tickets/abc/sub/x.pdf', 'anexar'),
    'NEGA caminho com pasta sobrando');
  perform app.assert(not app.can_touch_attachment('x.pdf', 'anexar'),
    'NEGA arquivo na raiz do bucket');

  -- Entidade desconhecida. É aqui que a checagem explícita de `key is not null`
  -- se paga: sem ela, has_permission(NULL) percorreria zero ancestrais e diria
  -- TRUE, liberando justamente o prefixo que ninguém previu.
  perform app.assert(
    not app.can_touch_attachment(
      'a0000000-0000-4000-8000-000000000001/faturas/abc/x.pdf', 'anexar'),
    'NEGA entidade que não está no mapa');
end
$$;

-- Solicitante: pode anexar em ticket (é o print do erro), não pode remover.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
declare
  v_ticket text := 'a0000000-0000-4000-8000-000000000001/tickets/11110000-0000-4000-8000-000000000001/x.pdf';
  v_ativo  text := 'a0000000-0000-4000-8000-000000000001/ativos/11110000-0000-4000-8000-000000000001/x.pdf';
begin
  perform app.assert(app.can_touch_attachment(v_ticket, 'anexar'),
    'solicitante anexa no ticket — o print do erro é o anexo mais comum');
  perform app.assert(not app.can_touch_attachment(v_ticket, 'remover'),
    'solicitante NÃO remove anexo: apagaria evidência de ticket já escalado');
  perform app.assert(not app.can_touch_attachment(v_ativo, 'anexar'),
    'solicitante NÃO anexa em ativo');
end
$$;

-- Operador Financeiro: mesmo papel `gestor` do Gestor de TI, e nenhum anexo de TI.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
declare
  v_ativo text := 'a0000000-0000-4000-8000-000000000001/ativos/11110000-0000-4000-8000-000000000001/x.pdf';
begin
  perform app.assert(not app.can_touch_attachment(v_ativo, 'anexar'),
    'Operador Financeiro NÃO anexa em ativo, apesar do papel gestor');
  perform app.assert(not app.can_touch_attachment(v_ativo, 'ver'),
    'Operador Financeiro NÃO consulta anexo de ativo');
end
$$;

-- -----------------------------------------------------------------------------
-- As policies, exercitadas de verdade sobre storage.objects
-- -----------------------------------------------------------------------------
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  insert into storage.objects (bucket_id, name)
  values ('anexos',
    'a0000000-0000-4000-8000-000000000001/tickets/11110000-0000-4000-8000-000000000001/prova.pdf');
  perform app.assert(true, 'admin do tenant 1 grava objeto no próprio caminho');

  begin
    insert into storage.objects (bucket_id, name)
    values ('anexos',
      'a0000000-0000-4000-8000-000000000002/tickets/11110000-0000-4000-8000-000000000001/pirata.pdf');
    perform app.assert(false, 'não deveria gravar objeto no caminho de outro tenant');
  exception when insufficient_privilege then
    perform app.assert(true, 'policy de INSERT barra caminho de outro tenant');
  end;

  begin
    insert into storage.objects (bucket_id, name)
    values ('anexos',
      'a0000000-0000-4000-8000-000000000001/faturas/11110000-0000-4000-8000-000000000001/x.pdf');
    perform app.assert(false, 'não deveria gravar em prefixo fora do mapa');
  exception when insufficient_privilege then
    perform app.assert(true, 'policy de INSERT barra prefixo fora do mapa');
  end;
end
$$;

-- O tenant 2 não vê o objeto do tenant 1.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000099","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
begin
  perform app.assert(
    not exists (select 1 from storage.objects where name like 'a0000000-0000-4000-8000-000000000001/%'),
    'tenant 2 NÃO enxerga objeto do tenant 1 — a fronteira do Storage é a do banco');
end
$$;

reset role;
do $$
begin
  perform app.assert(
    (select count(*) from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname in ('anexos_select','anexos_insert','anexos_delete')) = 3,
    'as 3 policies do bucket existem');
  -- Ausência deliberada: trocar o conteúdo mantendo caminho e metadados seria
  -- substituição silenciosa de prova documental.
  perform app.assert(
    not exists (select 1 from pg_policies
                where schemaname = 'storage' and tablename = 'objects' and cmd = 'UPDATE'),
    'NÃO existe policy de UPDATE: corrigir anexo é remover e anexar de novo');
end
$$;
delete from storage.objects where bucket_id = 'anexos';


-- =============================================================================
\echo '=== 26. Títulos e alçada configurável (0020) ==='
-- =============================================================================
reset role;

-- A alçada como DADO: a tabela nasce vazia, e é isso que se prova primeiro.
do $$
begin
  perform app.assert((select count(*) from public.approval_rules) = 0,
    'approval_rules nasce VAZIA — a regra de alçada é decisão do cliente, não do código');
  perform app.assert(
    (select bool_and(not payable_approval_required) from public.tenants),
    'aprovação de título nasce DESLIGADA em todo tenant');
end
$$;

-- Desligada: nenhum nível exigido, e o título nasce aprovado.
do $$
declare v_t uuid := 'a0000000-0000-4000-8000-000000000001';
begin
  perform app.assert(
    app.required_approval_levels(v_t, 999999.00) = array[]::integer[],
    'sem aprovação exigida, required_approval_levels devolve vazio');
end
$$;

-- Ligada SEM regra: erro explícito. É o caso ambíguo, e deixar passar em silêncio
-- aprovaria sem alçada; deixar parado sem erro esconderia a causa.
do $$
declare v_t uuid := 'a0000000-0000-4000-8000-000000000001';
begin
  update public.tenants set payable_approval_required = true where id = v_t;
  begin
    perform app.required_approval_levels(v_t, 500.00);
    perform app.assert(false, 'deveria falhar: aprovação ligada e nenhuma faixa cadastrada');
  exception when check_violation then
    perform app.assert(true,
      'aprovação ligada sem faixa cadastrada levanta erro dizendo o que configurar');
  end;
end
$$;

-- Com faixas cadastradas, a alçada funciona. Os valores abaixo são do TESTE, não
-- do produto: servem para exercitar a função, e nenhum deles é semeado.
do $$
declare
  v_t uuid := 'a0000000-0000-4000-8000-000000000001';
  v_perfil uuid;
begin
  select id into v_perfil from public.access_profiles
  where tenant_id = v_t and system_key = 'aprovador_financeiro';

  insert into public.approval_rules
    (tenant_id, level, level_name, min_amount, max_amount, required_profile_id)
  values
    (v_t, 1, 'Coordenação', 0,       1000.00, v_perfil),
    (v_t, 2, 'Gerência',    1000.01, 10000.00, v_perfil),
    (v_t, 3, 'Diretoria',   10000.01, null,    v_perfil);

  perform app.assert(app.required_approval_levels(v_t, 500.00) = array[1],
    'valor baixo exige só o nível 1');
  perform app.assert(app.required_approval_levels(v_t, 5000.00) = array[2],
    'valor médio exige o nível 2');
  perform app.assert(app.required_approval_levels(v_t, 250000.00) = array[3],
    'faixa sem teto (max_amount nulo) cobre qualquer valor acima dela');
  -- A borda: 1000,00 é do nível 1 e 1000,01 é do nível 2. Faixa que se sobrepõe
  -- ou deixa vão no centavo é o defeito clássico de alçada.
  perform app.assert(app.required_approval_levels(v_t, 1000.00) = array[1],
    'borda inferior: 1.000,00 fica no nível 1');
  perform app.assert(app.required_approval_levels(v_t, 1000.01) = array[2],
    'borda superior: 1.000,01 sobe para o nível 2');
end
$$;

-- Escopo por centro de custo: a regra restrita vale só no centro dela.
do $$
declare
  v_t uuid := 'a0000000-0000-4000-8000-000000000001';
  v_cc uuid;
begin
  select id into v_cc from public.cost_centers where tenant_id = v_t and code = 'TI-MAO';
  insert into public.approval_rules
    (tenant_id, level, level_name, min_amount, max_amount, cost_center_id)
  values (v_t, 4, 'Aprovação da filial', 0, null, v_cc);

  perform app.assert(app.required_approval_levels(v_t, 500.00, v_cc) @> array[4],
    'regra restrita ao centro de custo entra quando o título é daquele centro');
  perform app.assert(not (app.required_approval_levels(v_t, 500.00) @> array[4]),
    'e NÃO entra quando o título não tem aquele centro');
end
$$;

-- -----------------------------------------------------------------------------
-- A máquina de estados do título
-- -----------------------------------------------------------------------------
do $$
declare
  v_t uuid := 'a0000000-0000-4000-8000-000000000001';
  v_id uuid;
  v_conta uuid;
begin
  select id into v_conta from public.bank_accounts where tenant_id = v_t and name = 'Operação';

  insert into public.payables (tenant_id, description, amount, due_on)
  values (v_t, 'Despesa de teste', 1500.00, current_date + 10)
  returning id into v_id;
  perform app.assert(
    (select status from public.payables where id = v_id) = 'draft',
    'título nasce em rascunho');

  -- Pagar sem aprovar é o caminho que a contabilidade proíbe.
  begin
    update public.payables set status = 'paid', paid_on = current_date,
      bank_account_id = v_conta where id = v_id;
    perform app.assert(false, 'não deveria ir de rascunho direto para pago');
  exception when check_violation then
    perform app.assert(true, 'rascunho NÃO vai direto para pago');
  end;

  update public.payables set status = 'pending_approval' where id = v_id;
  update public.payables set status = 'approved' where id = v_id;
  perform app.assert(
    (select approved_at is not null and approved_by is not null
     from public.payables where id = v_id),
    'aprovação carimba quem aprovou e quando, sem a aplicação precisar lembrar');

  -- Pago exige prova: quando e de qual conta.
  begin
    update public.payables set status = 'paid' where id = v_id;
    perform app.assert(false, 'não deveria virar pago sem data e conta');
  exception when check_violation then
    perform app.assert(true, 'pago exige data e conta bancária — pago sem rastro não prova nada');
  end;

  update public.payables set status = 'paid', paid_on = current_date,
    bank_account_id = v_conta where id = v_id;

  -- Pago é imutável no que importa.
  begin
    update public.payables set amount = 99.00 where id = v_id;
    perform app.assert(false, 'não deveria alterar valor de título pago');
  exception when check_violation then
    perform app.assert(true, 'título pago não tem valor alterado — descolaria da movimentação');
  end;

  -- Estorno volta para aprovado e limpa o rastro de pagamento.
  update public.payables set status = 'approved' where id = v_id;
  perform app.assert(
    (select paid_on is null from public.payables where id = v_id),
    'estorno limpa a data de pagamento — senão o relatório contaria como pago');

  delete from public.payables where id = v_id;
end
$$;

-- Rejeição exige motivo. Rejeitar sem dizer por quê devolve o título para alguém
-- que não sabe o que corrigir.
do $$
declare
  v_t uuid := 'a0000000-0000-4000-8000-000000000001';
  v_id uuid;
begin
  insert into public.payables (tenant_id, description, amount, due_on, status)
  values (v_t, 'Para rejeitar', 100.00, current_date + 5, 'pending_approval')
  returning id into v_id;
  begin
    update public.payables set status = 'rejected' where id = v_id;
    perform app.assert(false, 'não deveria rejeitar sem motivo');
  exception when check_violation then
    perform app.assert(true, 'rejeição exige motivo');
  end;
  update public.payables set status = 'rejected', rejection_reason = 'Sem nota fiscal'
  where id = v_id;
  perform app.assert(
    (select status from public.payables where id = v_id) = 'rejected',
    'rejeição com motivo é aceita');
  delete from public.payables where id = v_id;
end
$$;

-- Parcela é título próprio, ligado ao primeiro.
do $$
declare
  v_t uuid := 'a0000000-0000-4000-8000-000000000001';
  v_pai uuid;
begin
  insert into public.payables
    (tenant_id, description, amount, due_on, installment_number, installment_total)
  values (v_t, 'Compra em 3x', 300.00, current_date + 30, 1, 3)
  returning id into v_pai;
  insert into public.payables
    (tenant_id, description, amount, due_on, installment_number, installment_total,
     parent_payable_id)
  values
    (v_t, 'Compra em 3x', 300.00, current_date + 60, 2, 3, v_pai),
    (v_t, 'Compra em 3x', 300.00, current_date + 90, 3, 3, v_pai);
  perform app.assert(
    (select count(*) from public.payables where parent_payable_id = v_pai) = 2,
    'parcelas são títulos próprios ligados ao primeiro');
  -- Parcela 4 de 3 não existe.
  begin
    insert into public.payables
      (tenant_id, description, amount, due_on, installment_number, installment_total,
       parent_payable_id)
    values (v_t, 'Parcela impossível', 300.00, current_date, 4, 3, v_pai);
    perform app.assert(false, 'não deveria aceitar parcela 4 de 3');
  exception when check_violation then
    perform app.assert(true, 'parcela acima do total é recusada');
  end;
  delete from public.payables where id = v_pai;
  perform app.assert(
    (select count(*) from public.payables where parent_payable_id = v_pai) = 0,
    'apagar o título-pai leva as parcelas com ele');
end
$$;

-- Título a receber: sem aprovação, e a baixa exige prova.
do $$
declare
  v_t uuid := 'a0000000-0000-4000-8000-000000000001';
  v_id uuid;
  v_conta uuid;
  v_cli uuid;
begin
  select id into v_conta from public.bank_accounts where tenant_id = v_t and name = 'Operação';
  select id into v_cli from public.clients where tenant_id = v_t limit 1;

  insert into public.receivables (tenant_id, description, amount, due_on, client_id, status)
  values (v_t, 'Mensalidade de teste', 4200.00, current_date + 15, v_cli, 'open')
  returning id into v_id;

  begin
    update public.receivables set status = 'received' where id = v_id;
    perform app.assert(false, 'não deveria dar baixa sem data e conta');
  exception when check_violation then
    perform app.assert(true, 'baixa de recebimento exige data e conta');
  end;

  -- `received_amount` separado do valor original: recebimento parcial e desconto
  -- acontecem, e sobrescrever `amount` apagaria a diferença.
  update public.receivables set status = 'received', received_on = current_date,
    received_amount = 4000.00, bank_account_id = v_conta where id = v_id;
  perform app.assert(
    (select amount = 4200.00 and received_amount = 4000.00
     from public.receivables where id = v_id),
    'valor recebido é guardado à parte do valor do título — o desconto fica visível');

  delete from public.receivables where id = v_id;
end
$$;

-- Anexo de título entra no mapa do bucket, pela função substituída na 0020.
do $$
begin
  perform app.assert(
    app.storage_permission_key('titulos', 'anexar') = 'financeiro.titulos_pagar.anexar',
    'anexo de título entrou no mapa do Storage');
  perform app.assert(app.storage_permission_key('titulos', 'inventar') is null,
    'verbo desconhecido em título continua sem chave');
end
$$;

-- -----------------------------------------------------------------------------
-- Os perfis financeiros contra as telas novas
-- -----------------------------------------------------------------------------
-- Operador Financeiro: lança despesa, NÃO aprova e NÃO paga. É a separação de
-- função que o módulo de aprovação existe para garantir.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(app.has_permission('financeiro.titulos_pagar.ver'),
    'Operador Financeiro consulta títulos');
  perform app.assert(app.has_permission('financeiro.titulos_pagar.criar'),
    'Operador Financeiro lança despesa');
  perform app.assert(app.has_permission('financeiro.titulos_pagar.anexar'),
    'Operador Financeiro anexa o comprovante');
  perform app.assert(not app.has_permission('financeiro.titulos_pagar.aprovar'),
    'Operador Financeiro NÃO aprova — quem lança não autoriza');
  perform app.assert(not app.has_permission('financeiro.titulos_pagar.pagar'),
    'Operador Financeiro NÃO dá baixa no pagamento');
  perform app.assert(not app.has_permission('financeiro.titulos_pagar.configurar'),
    'Operador Financeiro NÃO mexe na alçada');
  perform app.assert(not app.has_permission('financeiro.contas_bancarias.criar'),
    'e continua sem cadastrar conta bancária — a mudança de regra foi cirúrgica');
end
$$;

-- Aprovador Financeiro: aprova, e nada mais.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000007","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(app.has_permission('financeiro.titulos_pagar.aprovar'),
    'Aprovador Financeiro aprova título');
  perform app.assert(not app.has_permission('financeiro.titulos_pagar.criar'),
    'Aprovador Financeiro NÃO lança despesa — quem autoriza não cria');
  perform app.assert(not app.has_permission('financeiro.titulos_pagar.pagar'),
    'Aprovador Financeiro NÃO dá baixa');
end
$$;

-- Gestor de TI: mesmo papel gestor, e o financeiro todo fechado.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(not app.has_permission('financeiro.titulos_pagar.ver'),
    'Gestor de TI NÃO enxerga título a pagar, apesar do papel gestor');
end
$$;

-- Isolamento: o tenant 2 não vê título nem alçada do tenant 1.
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000099","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
begin
  perform app.assert(
    not exists (select 1 from public.approval_rules
                where tenant_id = 'a0000000-0000-4000-8000-000000000001'),
    'tenant 2 NÃO vê a alçada do tenant 1');
  perform app.assert(
    not exists (select 1 from public.payables
                where tenant_id = 'a0000000-0000-4000-8000-000000000001'),
    'tenant 2 NÃO vê título do tenant 1');
end
$$;
reset role;

-- Limpa o que este teste criou, para não contaminar contagem de outra seção.
delete from public.approval_rules where tenant_id = 'a0000000-0000-4000-8000-000000000001';
update public.tenants set payable_approval_required = false
where id = 'a0000000-0000-4000-8000-000000000001';

-- =============================================================================
\echo '=== 27. Fluxo de caixa: a projeção (0021) ==='
-- =============================================================================
reset role;

-- A seção 26 deixou títulos criados. A projeção soma tudo que está em aberto,
-- então ela precisa de um palco conhecido — senão a asserção mediria o resíduo do
-- teste anterior em vez da função.
delete from public.payables;
delete from public.receivables;

-- Sem título nenhum: a projeção é o saldo, repetido. É o ponto de partida contra
-- o qual os deltas abaixo são medidos.
do $$
declare
  v_saldo0 numeric;
  v_saidas numeric;
begin
  select running_balance - net into v_saldo0
    from public.cash_flow_projection(12, 0) order by bucket_start limit 1;
  select sum(outflow) + sum(inflow) into v_saidas
    from public.cash_flow_projection(12, 0);
  perform app.assert(v_saidas = 0,
    'sem título em aberto a projeção não move nada');
  perform app.assert(
    (select count(*) from public.cash_flow_projection(12, 0)) = 12,
    'o horizonte devolve um balde por mês, inclusive mês sem movimento');
  perform app.assert(
    (select count(*) from public.cash_flow_projection(6, 0)) = 6,
    'o horizonte respeita o parâmetro');
  -- Teto de 36: o parâmetro chega da barra de endereço, e `?meses=100000` não
  -- pode virar cem mil linhas.
  perform app.assert(
    (select count(*) from public.cash_flow_projection(100000, 0)) = 36,
    'horizonte absurdo é limitado a 36 meses');
end
$$;

-- Cada situação, uma por uma. É a asserção que impede alguém "melhorar" a lista de
-- status e mudar o número do caixa sem perceber.
do $$
declare
  v_t     uuid := 'a0000000-0000-4000-8000-000000000001';
  v_conta uuid := 'c2220000-0000-4000-8000-000000000001';
  v_id    uuid;
  v_saldo0        numeric;
  v_total_saida   numeric;
  v_total_entrada numeric;
begin
  select running_balance - net into v_saldo0
    from public.cash_flow_projection(12, 0) order by bucket_start limit 1;

  -- ENTRA
  insert into public.payables (tenant_id, description, amount, due_on, status)
  values (v_t, 'Entra: aguardando aprovação', 1000.00, current_date + 20, 'pending_approval');
  insert into public.payables (tenant_id, description, amount, due_on, status)
  values (v_t, 'Entra: aprovado', 2000.00, current_date + 40, 'approved');
  -- Vencido e não pago é obrigação real: tem de continuar na conta.
  insert into public.payables (tenant_id, description, amount, due_on, status)
  values (v_t, 'Entra: vencido', 3000.00, current_date - 5, 'approved')
  returning id into v_id;
  update public.payables set status = 'scheduled' where id = v_id;

  -- NÃO ENTRA
  insert into public.payables (tenant_id, description, amount, due_on)
  values (v_t, 'Fora: rascunho', 5000.00, current_date + 20);

  insert into public.payables (tenant_id, description, amount, due_on, status)
  values (v_t, 'Fora: reprovado', 9000.00, current_date + 20, 'pending_approval')
  returning id into v_id;
  update public.payables set status = 'rejected', rejection_reason = 'Sem nota' where id = v_id;

  -- Pago já está no saldo bancário: contá-lo de novo seria contar duas vezes.
  insert into public.payables (tenant_id, description, amount, due_on, status)
  values (v_t, 'Fora: pago', 7000.00, current_date + 20, 'approved')
  returning id into v_id;
  update public.payables
     set status = 'paid', paid_on = current_date, bank_account_id = v_conta
   where id = v_id;

  insert into public.receivables (tenant_id, description, amount, due_on, status)
  values (v_t, 'Entra: aberto', 4000.00, current_date + 20, 'open');
  insert into public.receivables (tenant_id, description, amount, due_on)
  values (v_t, 'Fora: rascunho a receber', 8000.00, current_date + 20);
  insert into public.receivables (tenant_id, description, amount, due_on, status)
  values (v_t, 'Fora: recebido', 6000.00, current_date + 20, 'open')
  returning id into v_id;
  update public.receivables
     set status = 'received', received_on = current_date, received_amount = 6000.00,
         bank_account_id = v_conta
   where id = v_id;

  select sum(outflow), sum(inflow) into v_total_saida, v_total_entrada
    from public.cash_flow_projection(12, 0);

  perform app.assert(v_total_saida = 6000.00,
    'saídas = aguardando aprovação + aprovado + agendado; rascunho, reprovado e pago ficam fora');
  perform app.assert(v_total_entrada = 4000.00,
    'entradas = só recebível em aberto; rascunho e recebido ficam fora');

  -- O vencido cai no mês corrente e volta DESTACADO, para a tela poder dizer
  -- "isto é atraso, não previsão".
  perform app.assert(
    (select overdue_outflow from public.cash_flow_projection(12, 0)
     order by bucket_start limit 1) = 3000.00,
    'o título vencido aparece no primeiro balde, marcado como vencido');
  perform app.assert(
    (select peak_day from public.cash_flow_projection(12, 0)
     order by bucket_start limit 1) = current_date,
    'o vencido é pagável hoje, então hoje é o maior dia de saída do mês corrente');

  -- Saldo acumulado: cada balde é o anterior mais o resultado do próprio.
  perform app.assert(
    (select running_balance from public.cash_flow_projection(12, 0)
     order by bucket_start desc limit 1) = v_saldo0 + 4000.00 - 6000.00,
    'o saldo do último balde é o saldo de hoje mais o resultado de todo o período');
  perform app.assert(
    not exists (
      select 1 from (
        select running_balance, net,
               lag(running_balance) over (order by bucket_start) as anterior
        from public.cash_flow_projection(12, 0)
      ) x where anterior is not null and running_balance <> anterior + net
    ),
    'o saldo acumulado é sempre o balde anterior mais o resultado deste');

  -- A inadimplência só toca recebível. Se tocasse saída, "cenário pessimista"
  -- reduziria a conta a pagar, que é o oposto de pessimista.
  perform app.assert(
    (select sum(inflow) from public.cash_flow_projection(12, 100)) = 0,
    '100% de inadimplência zera as entradas');
  perform app.assert(
    (select sum(outflow) from public.cash_flow_projection(12, 100)) = 6000.00,
    'inadimplência NÃO mexe nas saídas');
  perform app.assert(
    (select sum(inflow) from public.cash_flow_projection(12, 25)) = 3000.00,
    '25% de inadimplência aplica sobre o recebível em aberto');
  perform app.assert(
    (select sum(inflow) from public.cash_flow_projection(12, -50)) = 4000.00,
    'percentual negativo é tratado como zero, não vira entrada inflada');
end
$$;

-- Movimento bancário datado no futuro: a armadilha que esta função evita.
-- `vw_bank_account_balances.current_balance` não tem corte de data, então o
-- lançamento futuro JÁ está lá — usar aquele saldo como ponto de partida e
-- projetar o mesmo mês contaria o valor duas vezes.
do $$
declare
  v_t     uuid := 'a0000000-0000-4000-8000-000000000001';
  v_conta uuid := 'c2220000-0000-4000-8000-000000000001';
  v_saldo_antes  numeric;
  v_saldo_depois numeric;
  v_saida_antes  numeric;
  v_saida_depois numeric;
  v_view         numeric;
begin
  select running_balance - net into v_saldo_antes
    from public.cash_flow_projection(12, 0) order by bucket_start limit 1;
  select sum(outflow) into v_saida_antes from public.cash_flow_projection(12, 0);

  insert into public.bank_account_movements
    (tenant_id, bank_account_id, direction, amount, moved_on, description)
  values (v_t, v_conta, 'out', 500.00, current_date + 15, 'Débito programado de teste');

  select running_balance - net into v_saldo_depois
    from public.cash_flow_projection(12, 0) order by bucket_start limit 1;
  select sum(outflow) into v_saida_depois from public.cash_flow_projection(12, 0);
  select sum(current_balance) into v_view from public.vw_bank_account_balances;

  perform app.assert(v_saldo_depois = v_saldo_antes,
    'movimento datado no futuro NÃO entra no saldo de hoje');
  perform app.assert(v_saida_depois = v_saida_antes + 500.00,
    'movimento datado no futuro entra na projeção, como saída do mês dele');
  -- As duas metades juntas: se a função usasse a view, o valor apareceria nas
  -- duas pontas.
  perform app.assert(v_view <> v_saldo_depois,
    'a view de saldo JÁ inclui o movimento futuro — é por isso que a projeção não a usa como D0');

  delete from public.bank_account_movements
   where description = 'Débito programado de teste';
end
$$;

-- Isolamento: a função é `security invoker`, então o RLS das tabelas base vale
-- dentro dela. Sem isso a projeção seria um furo por onde o tenant 2 leria o
-- caixa do tenant 1 agregado.
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000099","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
begin
  perform app.assert(
    (select coalesce(sum(outflow) + sum(inflow), 0) from public.cash_flow_projection(12, 0)) = 0,
    'tenant 2 não vê nenhum fluxo do tenant 1 na projeção');
  perform app.assert(
    (select coalesce(max(running_balance), 0) from public.cash_flow_projection(12, 0)) = 0,
    'nem o saldo bancário do tenant 1');
end
$$;
reset role;

-- Limpa o palco.
delete from public.payables;
delete from public.receivables;

-- =============================================================================
\echo '=== 28. Conectividade: links, eventos e anexos (0022) ==='
-- =============================================================================
reset role;

-- O estado do link passa a ser DERIVADO dos eventos. Antes da 0022 nada
-- sincronizava `internet_links.last_state`, e o protótipo fazia isso no cliente —
-- ou seja, o webhook do Zabbix teria escrito evento sem mexer no estado.
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_link uuid;
begin
  select id into v_link from public.internet_links where contract_number = 'NL-LINK-001';

  insert into public.link_availability_events (tenant_id, link_id, state, source, note)
  values (v_t, v_link, 'down', 'manual', 'Teste de queda');
  perform app.assert(
    (select last_state from public.internet_links where id = v_link) = 'down',
    'abrir queda marca o link como fora do ar');

  -- Uma queda aberta por link. Sem isso, dois webhooks duplicados abririam duas
  -- indisponibilidades e o tempo fora do ar seria contado em dobro.
  begin
    insert into public.link_availability_events (tenant_id, link_id, state, source)
    values (v_t, v_link, 'down', 'manual');
    perform app.assert(false, 'não deveria aceitar uma segunda queda aberta');
  exception when unique_violation then
    perform app.assert(true, 'no máximo UMA queda aberta por link');
  end;

  update public.link_availability_events set ended_at = now()
   where link_id = v_link and ended_at is null;
  perform app.assert(
    (select last_state from public.internet_links where id = v_link) = 'up',
    'fechar a queda devolve o link para no ar');
end
$$;

-- Link sem host monitorado NUNCA volta como "no ar": volta como "não monitorado".
-- Chamar as duas coisas pelo mesmo nome esconderia que falta configurar a
-- monitoração, e alarmaria sobre um link que pode estar perfeito.
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_link uuid;
begin
  select id into v_link from public.internet_links where contract_number = 'NL-LINK-002';
  update public.internet_links set monitoring_host = null where id = v_link;

  insert into public.link_availability_events (tenant_id, link_id, state, source)
  values (v_t, v_link, 'down', 'manual');
  update public.link_availability_events set ended_at = now()
   where link_id = v_link and ended_at is null;

  perform app.assert(
    (select last_state from public.internet_links where id = v_link) = 'unknown',
    'link sem host volta para NÃO MONITORADO, não para no ar');

  delete from public.link_availability_events where link_id = v_link;
  update public.internet_links set monitoring_host = '10.20.0.1' where id = v_link;
end
$$;

-- Caminho de anexo, nas CINCO tabelas de uma vez.
-- Esta é a asserção que pegaria o defeito corrigido no seed: o contrato do
-- NL-LINK-001 estava gravado com DOIS segmentos, e `app.can_touch_attachment()`
-- nega caminho que não tenha exatamente 3 pastas — o arquivo nunca poderia ser
-- baixado, e nenhum teste dizia isso.
do $$
declare
  t       text;
  v_fora  bigint;
begin
  foreach t in array array[
    'ticket_attachments', 'asset_attachments', 'telecom_line_attachments',
    'internet_link_attachments', 'payable_attachments'
  ]
  loop
    execute format($f$
      select count(*) from public.%s
      where array_length(storage.foldername(storage_path), 1) <> 3
         or app.storage_tenant(storage_path) is distinct from tenant_id
    $f$, t) into v_fora;
    perform app.assert(v_fora = 0,
      format('todo storage_path de %s segue a convenção {tenant}/{entidade}/{id}/{arquivo}', t));
  end loop;
end
$$;

-- O módulo novo tem de chegar aos perfis certos. As regras de
-- `app.seed_system_access_profiles()` são POR MÓDULO, e um módulo ausente da
-- lista do Gestor de TI não daria erro: daria menu faltando.
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(app.has_permission('conectividade.links.ver'),
    'Gestor de TI enxerga links de internet');
  perform app.assert(app.has_permission('conectividade.links.criar'),
    'Gestor de TI cadastra link — é parque de TI, não financeiro');
  perform app.assert(not app.has_permission('financeiro.fluxo_caixa.ver'),
    'Gestor de TI NÃO enxerga o fluxo de caixa');
end
$$;

-- Operador de TI: consulta, não cadastra. Mesma regra do inventário e da
-- telefonia.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(app.has_permission('conectividade.links.ver'),
    'Operador de TI consulta links');
  perform app.assert(not app.has_permission('conectividade.links.criar'),
    'Operador de TI NÃO cadastra link');
end
$$;

-- Gestor Financeiro: o oposto exato. A projeção é dele; o link não.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(app.has_permission('financeiro.fluxo_caixa.ver'),
    'Operador Financeiro enxerga a projeção de caixa');
  perform app.assert(not app.has_permission('conectividade.links.ver'),
    'Operador Financeiro NÃO enxerga links de internet');
end
$$;
reset role;

-- =============================================================================
\echo '=== 29. Áreas da filial e custódia de equipamento (0023) ==='
-- =============================================================================
reset role;

-- `fn_seed_branch_areas` é idempotente. Não é detalhe: a tela expõe o botão
-- "usar as áreas padrão", e clicar duas vezes é o comportamento esperado de
-- quem não tem certeza se clicou. Duplicar área destruiria o agrupamento que a
-- tabela existe para garantir.
do $$
declare
  v_branch uuid := '11110000-0000-4000-8000-000000000001';
  v_antes  integer;
  v_novas  integer;
begin
  select count(*) into v_antes from public.branch_areas where branch_id = v_branch;
  select public.seed_branch_areas(v_branch) into v_novas;
  perform app.assert(
    (select count(*) from public.branch_areas where branch_id = v_branch) = v_antes,
    'rodar as áreas padrão de novo não duplica nenhuma (uq_area_name é por lower(name))');
  perform app.assert(v_novas = 0,
    'e a função devolve zero, para a tela poder dizer "já tem todas"');
end
$$;

-- Área de OUTRA filial é recusada nas duas pontas — ativo e linha. São duas
-- triggers distintas (`validate_area_branch` com coluna diferente), e cobrir só
-- uma deixaria a outra livre para aceitar o incoerente.
do $$
declare
  v_area_manaus uuid;
  v_ativo_sp    uuid;
  v_linha_sp    uuid;
begin
  select a.id into v_area_manaus from public.branch_areas a
   where a.branch_id = '11110000-0000-4000-8000-000000000003' limit 1;
  select id into v_ativo_sp from public.it_assets
   where branch_id = '11110000-0000-4000-8000-000000000001' limit 1;
  select id into v_linha_sp from public.telecom_lines
   where branch_id = '11110000-0000-4000-8000-000000000001' limit 1;

  begin
    update public.it_assets set branch_area_id = v_area_manaus where id = v_ativo_sp;
    perform app.assert(false, 'não deveria aceitar área de outra filial no ativo');
  exception when others then
    perform app.assert(true, 'ativo recusa área que pertence a outra filial');
  end;

  begin
    update public.telecom_lines set company_area_id = v_area_manaus where id = v_linha_sp;
    perform app.assert(false, 'não deveria aceitar área de outra filial na linha');
  exception when others then
    perform app.assert(true, 'linha recusa área que pertence a outra filial');
  end;
end
$$;

-- Classificar área pela primeira vez (NULL → valor) é CLASSIFICAÇÃO, não
-- movimentação. A regra está na 0013 e nunca teve cobertura: sem ela, a
-- migração dos ativos legados geraria um evento falso de realocação por ativo.
do $$
declare
  v_ativo uuid;
  v_area  uuid;
  v_antes integer;
begin
  select id into v_ativo from public.it_assets
   where branch_id = '11110000-0000-4000-8000-000000000001'
     and branch_area_id is null limit 1;
  select a.id into v_area from public.branch_areas a
   where a.branch_id = '11110000-0000-4000-8000-000000000001' limit 1;

  select count(*) into v_antes from public.asset_assignments where asset_id = v_ativo;
  update public.it_assets set branch_area_id = v_area where id = v_ativo;
  perform app.assert(
    (select count(*) from public.asset_assignments where asset_id = v_ativo) = v_antes,
    'atribuir área a um ativo que não tinha NÃO gera evento de realocação');
end
$$;

-- O motivo chega à trigger. Esta é a asserção que prova que a RPC serve para
-- alguma coisa: um `update` direto gravaria `outro`, e o campo de motivo do
-- formulário não governaria nada.
do $$
declare
  v_ativo   uuid;
  v_dono    uuid;
  v_antes   uuid;
  v_eventos integer;
  v_ev      record;
begin
  -- Estado anterior e novo dono são LIDOS, não escritos à mão: seções anteriores
  -- mexem no parque, e um id fixo aqui faria o bloco medir um evento antigo em
  -- vez do que ele acabou de provocar. Foi exatamente o que aconteceu na
  -- primeira escrita deste teste: ele passou lendo evento de outra seção.
  select id, assigned_user_id into v_ativo, v_antes
    from public.it_assets where asset_tag = 'PAT-001042';
  select id into v_dono from public.profiles
   where tenant_id = 'a0000000-0000-4000-8000-000000000001'
     and id is distinct from v_antes and role <> 'super_admin'
   order by id limit 1;
  select count(*) into v_eventos from public.asset_assignments where asset_id = v_ativo;

  perform public.change_asset_custody(
    v_ativo, v_dono, '11110000-0000-4000-8000-000000000001', null,
    'substituicao', 'Notebook trocado por defeito na tela');

  perform app.assert(
    (select count(*) from public.asset_assignments where asset_id = v_ativo) = v_eventos + 1,
    'a transferência gera exatamente UM evento novo');

  select * into v_ev from public.asset_assignments
   where asset_id = v_ativo order by started_at desc limit 1;

  perform app.assert(v_ev.reason = 'substituicao',
    'o motivo informado chega à trigger pela mesma transação da RPC');
  perform app.assert(v_ev.reason_note = 'Notebook trocado por defeito na tela',
    'a observação também — `reason_note` existia desde a 0013 e nada a preenchia');
  perform app.assert(v_ev.user_id = v_dono,
    'o evento registra o novo responsável');
  perform app.assert(v_ev.previous_user_id is not distinct from v_antes,
    'e o responsável ANTERIOR, que é o que torna o histórico legível');
  perform app.assert(v_ev.event_type = 'assignment',
    'troca de responsável é `assignment`, não realocação');
end
$$;

-- O motivo NÃO vaza para a transação seguinte. É o que `is_local => true`
-- garante, e é o ponto inteiro do desenho: a conexão vem de um pool, e um
-- `set_config` global aplicaria o motivo de uma pessoa à requisição de outra.
-- Este `update` roda FORA do bloco acima, ou seja, em outra transação.
update public.it_assets
   set assigned_user_id = '22220000-0000-4000-8000-000000000003'
 where asset_tag = 'PAT-001042';

do $$
begin
  perform app.assert(
    (select reason from public.asset_assignments
      where asset_id = (select id from public.it_assets where asset_tag = 'PAT-001042')
      order by started_at desc limit 1) = 'outro',
    'o motivo não sobrevive à transação — escrita seguinte volta ao padrão `outro`');
end
$$;

-- Motivo fora do CHECK vira `outro` em vez de estourar. A RPC é chamada com o
-- que vier do formulário, e derrubar a operação por causa de um rótulo
-- desconhecido seria trocar um dado impreciso por nenhum dado.
do $$
declare
  v_ativo uuid;
  v_dono  uuid;
begin
  select id into v_ativo from public.it_assets where asset_tag = 'PAT-001043';
  select id into v_dono from public.profiles
   where tenant_id = 'a0000000-0000-4000-8000-000000000001' and role <> 'super_admin'
   order by id limit 1;

  -- Preparo: o ativo precisa TER um responsável para que tirá-lo seja devolução.
  -- Sem isto o bloco não mudaria nada, nenhum evento nasceria, e a asserção
  -- estaria lendo o evento de outra seção — foi assim que este teste passou
  -- errado na primeira escrita.
  perform public.change_asset_custody(
    v_ativo, v_dono, '11110000-0000-4000-8000-000000000001', null, 'aquisicao', null);

  perform public.change_asset_custody(
    v_ativo, null, '11110000-0000-4000-8000-000000000001', null, 'inventado', null);
  perform app.assert(
    (select reason from public.asset_assignments
      where asset_id = v_ativo order by started_at desc limit 1) = 'devolucao',
    'motivo desconhecido cai no padrão e a trigger deriva pelo que mudou (devolução)');
  perform app.assert(
    (select assigned_user_id from public.it_assets where id = v_ativo) is null,
    'e a devolução de fato tirou o responsável');
end
$$;

-- A RPC respeita o RLS: é `security invoker`, e o tenant 2 não alcança ativo do
-- tenant 1. Devolver NULL é o que permite a ação dizer "não encontrado ou sem
-- permissão" em vez de "salvo".
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000099","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
declare v_ativo uuid;
begin
  reset role;
  select id into v_ativo from public.it_assets where asset_tag = 'PAT-001043';
  set role rls_tester;
  perform app.assert(
    public.change_asset_custody(v_ativo, null, null, null, 'outro', null) is null,
    'tenant 2 não move a custódia de ativo do tenant 1 — a RPC devolve NULL');
end
$$;
reset role;

-- As chaves novas chegam aos perfis certos. `clientes.areas` e
-- `inventario.ativos.custodiar` caem em módulos que as regras já citam, mas
-- "cair no módulo certo" é suposição até alguém medir — foi supor isso que
-- deixou `conectividade` fora de todos os perfis na rodada anterior.
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(app.has_permission('clientes.areas.criar'),
    'Gestor de TI cadastra área da filial');
  perform app.assert(app.has_permission('inventario.ativos.custodiar'),
    'Gestor de TI transfere custódia');
end
$$;

set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(not app.has_permission('inventario.ativos.custodiar'),
    'Operador de TI NÃO transfere custódia — é ato patrimonial, não de atendimento');
  perform app.assert(app.has_permission('inventario.ativos.ver'),
    'mas continua consultando o parque');
end
$$;
reset role;

-- =============================================================================
\echo '=== 30. Roteamento automático de fila (0024) ==='
-- =============================================================================
-- Até a 0024 `queue_rules` existia, estava semeada, auditada e com índice de
-- avaliação — e NINGUÉM a lia: `fn_route_ticket`, prometida no comentário da
-- 0004, nunca tinha sido escrita. Estas asserções são o que separa "a tabela
-- existe" de "o roteamento funciona".
reset role;

-- As duas regras do seed apontam para categorias PAI e os tickets usam categorias
-- FILHAS. Com casamento exato, nenhuma delas dispararia nunca — o seed
-- demonstraria um recurso que não funciona.
do $$
declare
  v_t     uuid := 'a0000000-0000-4000-8000-000000000001';
  v_fila  uuid;
begin
  -- Linha móvel é filha de Telefonia; a regra aponta para Telefonia.
  select app.fn_route_ticket(v_t, 'd0000000-0000-4000-8000-000000000014',
                             'c0000000-0000-4000-8000-000000000003', null, null)
    into v_fila;
  perform app.assert(v_fila = 'e0000000-0000-4000-8000-000000000003',
    'categoria FILHA casa com a regra da categoria pai');

  -- E a própria categoria da regra continua casando.
  select app.fn_route_ticket(v_t, 'd0000000-0000-4000-8000-000000000001',
                             'c0000000-0000-4000-8000-000000000003', null, null)
    into v_fila;
  perform app.assert(v_fila = 'e0000000-0000-4000-8000-000000000002',
    'a própria categoria da regra também casa');

  -- Categoria sem regra: ninguém casa, e a trigger é quem decide o padrão.
  select app.fn_route_ticket(v_t, 'd0000000-0000-4000-8000-000000000013',
                             'c0000000-0000-4000-8000-000000000003', null, null)
    into v_fila;
  perform app.assert(v_fila is null,
    'categoria sem regra devolve NULL — a função não inventa destino');
end
$$;

-- O caminho de verdade: ticket criado sem fila. É esta asserção que teria
-- falhado antes da 0024.
do $$
declare v_qid uuid;
begin
  insert into public.tickets (tenant_id, title, priority_id, category_id, queue_id, requester_id)
  values ('a0000000-0000-4000-8000-000000000001', 'Celular sem sinal de dados',
          'c0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000014',
          null, '22220000-0000-4000-8000-000000000005')
  returning queue_id into v_qid;
  perform app.assert(v_qid = 'e0000000-0000-4000-8000-000000000003',
    'ticket sem fila é roteado pela regra, e não mais jogado na fila padrão');

  -- Fila escolhida na tela manda: quem escolheu sabe mais que a regra genérica.
  insert into public.tickets (tenant_id, title, priority_id, category_id, queue_id, requester_id)
  values ('a0000000-0000-4000-8000-000000000001', 'Celular, mas eu quero na Geral',
          'c0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000014',
          'e0000000-0000-4000-8000-000000000001', '22220000-0000-4000-8000-000000000005')
  returning queue_id into v_qid;
  perform app.assert(v_qid = 'e0000000-0000-4000-8000-000000000001',
    'fila escolhida explicitamente NÃO é sobrescrita pela regra');
end
$$;

-- Falhar fechado. Uma regra com chave errada de digitação viraria, na prática,
-- `{}` se as chaves desconhecidas fossem ignoradas — e mandaria TODO ticket para
-- aquela fila. Esta é a asserção que impede o erro de digitação de virar desastre.
do $$
declare
  v_t   uuid := 'a0000000-0000-4000-8000-000000000001';
  v_id  uuid;
  v_fila uuid;
begin
  insert into public.queue_rules (tenant_id, queue_id, name, conditions, sort_order)
  values (v_t, 'e0000000-0000-4000-8000-000000000002', 'Com erro de digitação',
          '{"categoy_id":"d0000000-0000-4000-8000-000000000013"}'::jsonb, 1)
  returning id into v_id;

  select app.fn_route_ticket(v_t, 'd0000000-0000-4000-8000-000000000013',
                             'c0000000-0000-4000-8000-000000000003', null, null)
    into v_fila;
  perform app.assert(v_fila is null,
    'chave desconhecida faz a regra NÃO casar — erro de digitação não pega todo ticket');
  delete from public.queue_rules where id = v_id;

  -- Condição vazia é regra inacabada, não curinga.
  insert into public.queue_rules (tenant_id, queue_id, name, conditions, sort_order)
  values (v_t, 'e0000000-0000-4000-8000-000000000002', 'Sem condição', '{}'::jsonb, 1)
  returning id into v_id;
  select app.fn_route_ticket(v_t, 'd0000000-0000-4000-8000-000000000013',
                             'c0000000-0000-4000-8000-000000000003', null, null)
    into v_fila;
  perform app.assert(v_fila is null,
    'condição vazia não casa com tudo — quem quer curinga usa a fila padrão');
  delete from public.queue_rules where id = v_id;
end
$$;

-- AND entre as chaves, ordem por sort_order, e regra desativada fora da conta.
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_id   uuid;
  v_id2  uuid;
  v_fila uuid;
begin
  insert into public.queue_rules (tenant_id, queue_id, name, conditions, sort_order)
  values (v_t, 'e0000000-0000-4000-8000-000000000002', 'ERP crítico',
          '{"category_id":"d0000000-0000-4000-8000-000000000013","priority_key":"critical"}'::jsonb, 5)
  returning id into v_id;

  select app.fn_route_ticket(v_t, 'd0000000-0000-4000-8000-000000000013',
                             'c0000000-0000-4000-8000-000000000001', null, null) into v_fila;
  perform app.assert(v_fila = 'e0000000-0000-4000-8000-000000000002',
    'as duas condições juntas casam');

  select app.fn_route_ticket(v_t, 'd0000000-0000-4000-8000-000000000013',
                             'c0000000-0000-4000-8000-000000000003', null, null) into v_fila;
  perform app.assert(v_fila is null,
    'uma das duas sozinha NÃO casa — a semântica é AND, não OR');

  -- Regra mais específica com sort_order menor ganha da genérica.
  insert into public.queue_rules (tenant_id, queue_id, name, conditions, sort_order)
  values (v_t, 'e0000000-0000-4000-8000-000000000003', 'ERP em geral',
          '{"category_id":"d0000000-0000-4000-8000-000000000013"}'::jsonb, 50)
  returning id into v_id2;
  select app.fn_route_ticket(v_t, 'd0000000-0000-4000-8000-000000000013',
                             'c0000000-0000-4000-8000-000000000001', null, null) into v_fila;
  perform app.assert(v_fila = 'e0000000-0000-4000-8000-000000000002',
    'a regra de sort_order menor decide primeiro');

  -- Desativar a primeira passa a vez para a seguinte.
  update public.queue_rules set is_active = false where id = v_id;
  select app.fn_route_ticket(v_t, 'd0000000-0000-4000-8000-000000000013',
                             'c0000000-0000-4000-8000-000000000001', null, null) into v_fila;
  perform app.assert(v_fila = 'e0000000-0000-4000-8000-000000000003',
    'regra desativada sai da avaliação e a próxima assume');

  delete from public.queue_rules where id in (v_id, v_id2);
end
$$;

-- A ordem dentro da trigger. A versão da 0005 resolvia a fila ANTES de derivar a
-- filial do solicitante: uma regra por filial enxergaria NULL e nunca casaria.
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_id   uuid;
  v_qid  uuid;
begin
  insert into public.queue_rules (tenant_id, queue_id, name, conditions, sort_order)
  values (v_t, 'e0000000-0000-4000-8000-000000000002', 'Tudo da Matriz SP',
          '{"branch_id":"11110000-0000-4000-8000-000000000001"}'::jsonb, 1)
  returning id into v_id;

  -- O ticket NÃO informa filial: ela vem da filial primária do solicitante.
  insert into public.tickets (tenant_id, title, priority_id, queue_id, requester_id)
  values (v_t, 'Sem filial informada, mas o solicitante tem',
          'c0000000-0000-4000-8000-000000000003', null, '22220000-0000-4000-8000-000000000005')
  returning queue_id into v_qid;

  perform app.assert(v_qid = 'e0000000-0000-4000-8000-000000000002',
    'a regra por filial enxerga a filial DERIVADA do solicitante');

  delete from public.queue_rules where id = v_id;
end
$$;

-- A chave nova e o teto de papel. O Operador de TI recebe o módulo `helpdesk`
-- inteiro pela regra do perfil; é o teto `gestor` da chave que o mantém fora.
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(app.has_permission('helpdesk.filas.configurar_regras'),
    'Gestor de TI configura regra de roteamento');
end
$$;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(not app.has_permission('helpdesk.filas.configurar_regras'),
    'Operador de TI NÃO configura — o teto da chave vence a regra do perfil');
  perform app.assert(app.has_permission('helpdesk.filas.ver'),
    'mas continua vendo as filas e as regras que explicam o destino do ticket');
end
$$;
reset role;

-- Isolamento: regra de um tenant não roteia ticket do outro.
do $$
begin
  perform app.assert(
    app.fn_route_ticket('a0000000-0000-4000-8000-000000000002',
      'd0000000-0000-4000-8000-000000000014', 'c0000000-0000-4000-8000-000000000003',
      null, null) is null,
    'as regras do tenant 1 não alcançam o tenant 2');
end
$$;

-- =============================================================================
\echo '=== 31. Cadastro de fila e painel de telefonia (0025) ==='
-- =============================================================================
reset role;

-- A fila padrão é protegida no BANCO desde a 0004, e é por isso que a tela não
-- repete a regra. Estas asserções são o que autoriza a tela a confiar nela — as
-- quatro proteções nunca tinham sido exercidas por teste.
do $$
declare v_padrao uuid;
begin
  select id into v_padrao from public.queues
   where tenant_id = 'a0000000-0000-4000-8000-000000000001' and is_system_default;

  begin
    update public.queues set name = 'Outro nome' where id = v_padrao;
    perform app.assert(false, 'não deveria renomear a fila padrão');
  exception when others then
    perform app.assert(true, 'a fila padrão não pode ser renomeada');
  end;

  begin
    update public.queues set slug = 'outro' where id = v_padrao;
    perform app.assert(false, 'não deveria trocar o identificador da fila padrão');
  exception when others then
    perform app.assert(true, 'o identificador da fila padrão não pode mudar');
  end;

  begin
    update public.queues set is_active = false where id = v_padrao;
    perform app.assert(false, 'não deveria desativar a fila padrão');
  exception when others then
    perform app.assert(true, 'a fila padrão não pode ser desativada');
  end;

  begin
    delete from public.queues where id = v_padrao;
    perform app.assert(false, 'não deveria remover a fila padrão');
  exception when others then
    perform app.assert(true, 'a fila padrão não pode ser removida');
  end;

  -- Uma padrão por tenant: o índice parcial único é o que impede duas.
  begin
    insert into public.queues (tenant_id, name, slug, is_system_default)
    values ('a0000000-0000-4000-8000-000000000001', 'Segunda padrão', 'segunda', true);
    perform app.assert(false, 'não deveria aceitar uma segunda fila padrão');
  exception when unique_violation then
    perform app.assert(true, 'só existe UMA fila padrão por tenant');
  end;
end
$$;

-- Fila comum muda e inativa normalmente — a proteção é só da padrão.
do $$
declare v_id uuid;
begin
  insert into public.queues (tenant_id, name, slug, description,
                             weight_criticality, weight_deadline, weight_age)
  values ('a0000000-0000-4000-8000-000000000001', 'Fila de teste', 'teste-0025',
          'Criada pelo teste de schema.', 40, 40, 20)
  returning id into v_id;

  update public.queues set is_active = false, name = 'Fila de teste renomeada' where id = v_id;
  perform app.assert(
    (select not is_active and name = 'Fila de teste renomeada' from public.queues where id = v_id),
    'fila comum é renomeada e inativada sem obstáculo');

  -- Identificador é único por tenant: é ele que vira endereço de tela.
  begin
    insert into public.queues (tenant_id, name, slug)
    values ('a0000000-0000-4000-8000-000000000001', 'Outra', 'teste-0025');
    perform app.assert(false, 'não deveria aceitar identificador repetido');
  exception when unique_violation then
    perform app.assert(true, 'identificador de fila é único por tenant');
  end;

  delete from public.queues where id = v_id;
end
$$;

-- `vw_telecom_dashboard` existia desde a 0013 e NINGUÉM a consultava. Agora ela
-- é a fonte da tela de telefonia — e os dois números que só ela calcula
-- (linha sem responsável, linha livre de fidelidade) passam a valer alguma coisa.
do $$
declare
  v_sem_dono bigint;
  v_livres   bigint;
  v_total    numeric;
begin
  select coalesce(sum(without_user), 0), coalesce(sum(free_to_cancel), 0),
         coalesce(sum(monthly_total), 0)
    into v_sem_dono, v_livres, v_total
    from public.vw_telecom_dashboard
   where tenant_id = 'a0000000-0000-4000-8000-000000000001';

  perform app.assert(
    v_sem_dono = (select count(*) from public.telecom_lines
                   where tenant_id = 'a0000000-0000-4000-8000-000000000001'
                     and assigned_user_id is null and deleted_at is null),
    'o painel conta como "sem responsável" exatamente as linhas sem responsável');

  perform app.assert(
    v_livres = (select count(*) from public.telecom_lines
                 where tenant_id = 'a0000000-0000-4000-8000-000000000001'
                   and deleted_at is null
                   and (loyalty_until is null or loyalty_until < current_date)),
    'e como "livre de fidelidade" as que não têm fidelidade vigente');

  perform app.assert(
    v_total = (select coalesce(sum(monthly_cost), 0) from public.telecom_lines
                where tenant_id = 'a0000000-0000-4000-8000-000000000001'
                  and deleted_at is null),
    'o custo somado do painel bate com a soma das linhas');
end
$$;

-- As chaves novas e o teto de papel, de novo — é a verificação que a 0022
-- ensinou a não pular.
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(app.has_permission('helpdesk.filas.criar'),
    'Gestor de TI cria fila');
  perform app.assert(app.has_permission('helpdesk.filas.editar'),
    'e edita os pesos do score');
end
$$;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(not app.has_permission('helpdesk.filas.criar'),
    'Operador de TI NÃO cria fila — estrutura de atendimento é decisão de gestão');
  perform app.assert(app.has_permission('helpdesk.filas.ver'),
    'mas continua vendo as filas que atende');
end
$$;
reset role;

-- =============================================================================
\echo '=== 32. Escopo por cliente e cor da empresa (0027) ==='
-- =============================================================================
reset role;

-- A FK composta é a única coisa aqui que protege alguma coisa: o foco é
-- VISUALIZAÇÃO, não autorização, mas apontar para o cliente de outro tenant
-- transformaria uma preferência em vazamento. Tem de ser impossível no banco,
-- não apenas improvável na aplicação.
do $$
declare
  v_outro uuid := 'f0000000-0000-4000-8000-0000000000ff';
begin
  insert into public.clients (id, tenant_id, legal_name)
  values (v_outro, 'a0000000-0000-4000-8000-000000000002', 'Cliente do outro tenant');

  begin
    update public.profiles set focused_client_id = v_outro
      where id = '22220000-0000-4000-8000-000000000001';
    perform app.assert(false, 'NÃO DEVERIA: foco apontou para cliente de outro tenant');
  exception when foreign_key_violation then
    perform app.assert(true, 'o foco não alcança cliente de outro tenant');
  end;

  -- E o do próprio tenant entra sem obstáculo.
  update public.profiles set focused_client_id = 'f0000000-0000-4000-8000-000000000001'
    where id = '22220000-0000-4000-8000-000000000001';
  perform app.assert(
    (select focused_client_id from public.profiles
      where id = '22220000-0000-4000-8000-000000000001')
      = 'f0000000-0000-4000-8000-000000000001',
    'e alcança o cliente do próprio tenant');
end
$$;

-- `on delete set null`: apagar o cliente não pode travar o login de quem estava
-- com ele em foco. O sintoma de um `restrict` aqui seria "não consigo excluir o
-- cliente" sem dizer que o motivo é a preferência de visualização de alguém.
do $$
begin
  delete from public.clients where id = 'f0000000-0000-4000-8000-0000000000ff';
  update public.profiles set focused_client_id = null
    where id = '22220000-0000-4000-8000-000000000001';
  perform app.assert(true, 'cliente de outro tenant removido sem resíduo');
end
$$;

-- A cor é dado com formato, não texto livre: sem o CHECK, um `style` com valor
-- inválido simplesmente não pinta, e ninguém descobre onde foi digitado errado.
do $$
declare
  v_c uuid := 'f0000000-0000-4000-8000-000000000001';
begin
  perform app.assert(
    (select color from public.clients where id = v_c) = '#64748b',
    'cliente nasce com a cor neutra do sistema, não com uma cor inventada');

  begin
    update public.clients set color = 'azul' where id = v_c;
    perform app.assert(false, 'NÃO DEVERIA: cor fora do formato foi aceita');
  exception when check_violation then
    perform app.assert(true, 'cor fora de #rrggbb é recusada');
  end;

  begin
    update public.clients set color = '#12345' where id = v_c;
    perform app.assert(false, 'NÃO DEVERIA: cor curta foi aceita');
  exception when check_violation then
    perform app.assert(true, 'e cor com menos de seis dígitos também');
  end;

  update public.clients set color = '#A1B2C3' where id = v_c;
  perform app.assert(
    (select color from public.clients where id = v_c) = '#A1B2C3',
    'maiúscula é cor válida — o hexadecimal não distingue caixa');
  update public.clients set color = '#64748b' where id = v_c;
end
$$;

-- A projeção de caixa sob foco. Esta é a asserção que importa: se o parâmetro
-- novo não chegasse aos predicados, a tela continuaria somando o título de
-- outro cliente e o total pareceria certo.
do $$
declare
  v_t         uuid := 'a0000000-0000-4000-8000-000000000001';
  v_meridiano uuid := 'f0000000-0000-4000-8000-000000000001';
  v_vertex    uuid := 'f0000000-0000-4000-8000-000000000002';
  v_fil_mer   uuid := '11110000-0000-4000-8000-000000000001';
  v_fil_vtx   uuid := '11110000-0000-4000-8000-000000000004';
  v_todos     numeric;
  v_focado    numeric;
begin
  delete from public.payables;
  delete from public.receivables;

  insert into public.payables (tenant_id, branch_id, description, amount, due_on, status) values
    (v_t, v_fil_mer, 'Meridiano',          100.00, current_date + 10, 'approved'),
    (v_t, v_fil_vtx, 'Vertex',             200.00, current_date + 10, 'approved'),
    (v_t, null,      'Do tenant inteiro',  400.00, current_date + 10, 'approved');

  select sum(outflow) into v_todos from public.cash_flow_projection(12, 0);
  perform app.assert(v_todos = 700.00, 'sem foco, a projeção soma os três títulos');

  select sum(outflow) into v_focado
    from public.cash_flow_projection(12, 0, null, null, v_meridiano);
  perform app.assert(v_focado = 500.00,
    'sob foco, entra o título da filial do cliente E o que não tem filial nenhuma');

  select sum(outflow) into v_focado
    from public.cash_flow_projection(12, 0, null, null, v_vertex);
  perform app.assert(v_focado = 600.00, 'e o foco do outro cliente troca só a parcela dele');

  -- Recebível tem `client_id` próprio, nulável: mesma regra, caminho diferente.
  insert into public.receivables (tenant_id, client_id, description, amount, due_on, status) values
    (v_t, v_meridiano, 'Mensalidade Meridiano', 90.00, current_date + 10, 'open'),
    (v_t, v_vertex,    'Mensalidade Vertex',    50.00, current_date + 10, 'open'),
    (v_t, null,        'Sem cliente',           30.00, current_date + 10, 'open');

  select sum(inflow) into v_focado
    from public.cash_flow_projection(12, 0, null, null, v_meridiano);
  perform app.assert(v_focado = 120.00,
    'o recebível sem cliente entra em qualquer foco, pela mesma regra');

  delete from public.payables;
  delete from public.receivables;
end
$$;

-- O `drop` antes do `create` não é zelo: sem ele existiriam DUAS funções com o
-- mesmo nome, e a chamada de quatro argumentos passaria a ser ambígua — erro em
-- execução, numa tela que hoje funciona.
do $$
begin
  perform app.assert(
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'cash_flow_projection') = 1,
    'existe UMA só cash_flow_projection — a assinatura antiga foi removida');
end
$$;

-- =============================================================================
\echo '=== 33. Agregados de paginação: a view conta o mesmo que a tabela (0028) ==='
-- =============================================================================
reset role;

-- Estas quatro views existem por um motivo só: quando a lista passar a vir
-- paginada, os indicadores no alto da tela precisam continuar contando o acervo
-- INTEIRO. Uma divergência aqui não daria erro em lugar nenhum — daria um número
-- com cara de fato e conteúdo errado, que é a pior saída possível.
--
-- Por isso cada asserção compara a view com a mesma conta feita direto na
-- tabela, em vez de comparar com um número escrito à mão, que envelheceria na
-- primeira vez que o seed mudasse.

do $$
declare
  v_t         uuid := 'a0000000-0000-4000-8000-000000000001';
  v_fil       uuid := '11110000-0000-4000-8000-000000000001';
  v_vertex    uuid := '11110000-0000-4000-8000-000000000004';
begin
  delete from public.payables;
  delete from public.receivables;

  insert into public.payables (tenant_id, branch_id, description, amount, due_on, status) values
    (v_t, v_fil,    'Vencido',        100.00, current_date - 5,  'approved'),
    (v_t, v_fil,    'A vencer em 3',  200.00, current_date + 3,  'approved'),
    (v_t, v_vertex, 'Outra filial',   400.00, current_date + 30, 'pending_approval'),
    (v_t, null,     'Sem filial',     800.00, current_date + 30, 'approved'),
    (v_t, v_fil,    'Pago',          1600.00, current_date - 20, 'draft');

  -- Totais: a view contra a tabela, sem número escrito à mão.
  perform app.assert(
    (select coalesce(sum(titulos), 0) from public.vw_payables_summary where tenant_id = v_t)
      = (select count(*) from public.payables where tenant_id = v_t and deleted_at is null),
    'a soma de títulos da view bate com a contagem da tabela');

  perform app.assert(
    (select coalesce(sum(total), 0) from public.vw_payables_summary where tenant_id = v_t)
      = (select coalesce(sum(amount), 0) from public.payables where tenant_id = v_t and deleted_at is null),
    'e a soma de valores também');

  perform app.assert(
    (select coalesce(sum(vencidos), 0) from public.vw_payables_summary where tenant_id = v_t)
      = (select count(*) from public.payables
          where tenant_id = v_t and deleted_at is null
            and due_on < current_date and status not in ('paid', 'cancelled')),
    'vencidos exclui pago e cancelado, exatamente como a tela');

  -- A coluna que a 0028 acrescentou, e a razão de ela existir: sem `branch_id`
  -- o indicador contaria o tenant inteiro enquanto a lista mostra uma empresa só.
  perform app.assert(
    (select coalesce(sum(total), 0) from public.vw_payables_summary
      where tenant_id = v_t and (branch_id = v_fil or branch_id is null))
      = 100.00 + 200.00 + 800.00 + 1600.00,
    'o agregado por filial soma a filial MAIS o que não tem filial — a regra do escopo');

  -- `coalesce` nos somatórios com filtro: sem nenhum vencido o resultado tem de
  -- ser 0, não NULL. NULL chegaria na tela como NaN no primeiro mês sem atraso.
  delete from public.payables where due_on < current_date;
  perform app.assert(
    (select coalesce(sum(total_vencido), -1) from public.vw_payables_summary where tenant_id = v_t) = 0,
    'sem título vencido o total vencido é zero, e não nulo');
end
$$;

do $$
declare
  v_t       uuid := 'a0000000-0000-4000-8000-000000000001';
  v_cliente uuid := 'f0000000-0000-4000-8000-000000000001';
  v_conta   uuid := 'c2220000-0000-4000-8000-000000000001';
begin
  delete from public.receivables;
  -- Nasce sempre em aberto: `app.receivables_guard()` recusa criar já recebido,
  -- e a baixa exige data e conta (`receivables_received_has_evidence`). O teste
  -- passa pelo mesmo caminho que a tela percorre.
  insert into public.receivables
    (tenant_id, client_id, description, amount, due_on, status) values
    (v_t, v_cliente, 'Em aberto',        500.00, current_date + 10, 'open'),
    (v_t, v_cliente, 'Vencido',          300.00, current_date - 2,  'open'),
    (v_t, v_cliente, 'Recebido a menos', 200.00, current_date - 30, 'open'),
    (v_t, null,      'Sem cliente',      100.00, current_date + 10, 'open');

  update public.receivables
     set status = 'received', received_on = current_date,
         bank_account_id = v_conta, received_amount = 180.00
   where tenant_id = v_t and description = 'Recebido a menos';

  perform app.assert(
    (select coalesce(sum(titulos), 0) from public.vw_receivables_summary where tenant_id = v_t)
      = (select count(*) from public.receivables where tenant_id = v_t and deleted_at is null),
    'a view de recebíveis conta o mesmo que a tabela');

  -- A conta que a tela chama de "diferença": onde desconto e recebimento parcial
  -- aparecem. Somar só o recebido esconderia a perda de 20.
  perform app.assert(
    (select coalesce(sum(diferenca_recebida), 0) from public.vw_receivables_summary where tenant_id = v_t)
      = 20.00,
    'a diferença entre combinado e recebido é 20, e não zero');

  -- Título baixado sem valor informado foi recebido integralmente: não entra na
  -- diferença. Sem o `coalesce` da view, ele entraria como o valor inteiro.
  insert into public.receivables
    (tenant_id, client_id, description, amount, due_on, status)
  values (v_t, v_cliente, 'Recebido sem valor', 700.00, current_date - 3, 'open');
  update public.receivables
     set status = 'received', received_on = current_date, bank_account_id = v_conta
   where tenant_id = v_t and description = 'Recebido sem valor';
  perform app.assert(
    (select coalesce(sum(diferenca_recebida), 0) from public.vw_receivables_summary where tenant_id = v_t)
      = 20.00,
    'e baixa sem valor informado continua valendo integral, sem inflar a diferença');

  delete from public.receivables;
end
$$;

do $$
declare
  v_t   uuid := 'a0000000-0000-4000-8000-000000000001';
  v_fil  uuid := '11110000-0000-4000-8000-000000000001';
  v_id   uuid;
  v_base bigint;
begin
  perform app.assert(
    (select coalesce(sum(ativos), 0) from public.vw_assets_summary where tenant_id = v_t)
      = (select count(*) from public.it_assets where tenant_id = v_t and deleted_at is null),
    'a view de inventário conta o mesmo que a tabela');

  perform app.assert(
    (select coalesce(sum(valor_total), 0) from public.vw_assets_summary where tenant_id = v_t)
      = (select coalesce(sum(acquisition_cost), 0) from public.it_assets
          where tenant_id = v_t and deleted_at is null),
    'e soma o mesmo valor de aquisição');

  -- O piso em `current_date` é a regra que a tela já aplica, com motivo escrito
  -- lá: sem ele, garantia vencida há anos ficaria para sempre em "vencendo nos
  -- próximos 90 dias", e o indicador vermelho permanente esconderia a que de
  -- fato vence semana que vem.
  -- Delta, e não valor absoluto: o seed já traz ativos com garantia, e uma
  -- asserção escrita como "= 0" mediria o seed em vez da regra. Esse erro já
  -- aconteceu duas vezes nesta base, nos testes de custódia.
  select coalesce(sum(garantia_90d), 0) into v_base
    from public.vw_assets_summary where tenant_id = v_t;

  insert into public.it_assets (tenant_id, branch_id, asset_tag, asset_type, status, warranty_until)
  values (v_t, v_fil, 'GARANTIA-VELHA', 'notebook', 'active', current_date - 400)
  returning id into v_id;
  perform app.assert(
    (select coalesce(sum(garantia_90d), 0) from public.vw_assets_summary where tenant_id = v_t)
      = v_base,
    'garantia vencida há muito tempo NÃO conta como vencendo em 90 dias');

  update public.it_assets set warranty_until = current_date + 30 where id = v_id;
  perform app.assert(
    (select coalesce(sum(garantia_90d), 0) from public.vw_assets_summary where tenant_id = v_t)
      = v_base + 1,
    'e a que vence em 30 dias conta');

  -- Equipamento baixado não tem garantia a renovar.
  update public.it_assets set status = 'retired' where id = v_id;
  perform app.assert(
    (select coalesce(sum(garantia_90d), 0) from public.vw_assets_summary where tenant_id = v_t)
      = v_base,
    'ativo baixado sai da conta de garantia');

  delete from public.it_assets where id = v_id;
end
$$;

do $$
declare
  v_t uuid := 'a0000000-0000-4000-8000-000000000001';
begin
  perform app.assert(
    (select coalesce(sum(links_count), 0) from public.vw_internet_dashboard where tenant_id = v_t)
      = (select count(*) from public.internet_links where tenant_id = v_t and deleted_at is null),
    'a view de links conta o mesmo que a tabela');

  -- A coluna que a 0028 acrescentou. "Não monitorado" é indicador da tela desde
  -- que o módulo ganhou interface, e a view de 2013 não o tinha.
  perform app.assert(
    (select coalesce(sum(links_unknown), 0) from public.vw_internet_dashboard where tenant_id = v_t)
      = (select count(*) from public.internet_links
          where tenant_id = v_t and deleted_at is null and last_state = 'unknown'),
    'links_unknown conta exatamente os links sem host monitorado');

  perform app.assert(
    (select coalesce(sum(monthly_total), 0) from public.vw_internet_dashboard
      where tenant_id = v_t and status = 'active')
      = (select coalesce(sum(monthly_cost), 0) from public.internet_links
          where tenant_id = v_t and deleted_at is null and status = 'active'),
    'e o custo mensal ativo bate com a soma dos links ativos');
end
$$;

-- Isolamento: as quatro views são `security_invoker`, então o RLS da tabela de
-- origem continua valendo. Sem isso, um agregado seria o caminho mais fácil para
-- descobrir quanto outro tenant tem a pagar — sem nunca ver uma linha dele.
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000099","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
begin
  perform app.assert((select count(*) from public.vw_payables_summary) = 0,
    'tenant 2 não enxerga o agregado de títulos a pagar do tenant 1');
  perform app.assert((select count(*) from public.vw_receivables_summary) = 0,
    'nem o de títulos a receber');
  perform app.assert((select count(*) from public.vw_assets_summary) = 0,
    'nem o do inventário');
  perform app.assert((select count(*) from public.vw_internet_dashboard) = 0,
    'nem o dos links');
end
$$;
reset role;

-- =============================================================================
\echo '=== 34. Notificação, trabalhos agendados e satisfação (0029/0030) ==='
-- =============================================================================
reset role;

-- Estas asserções existem porque as três funções de trabalho decidem QUEM é
-- avisado e QUANDO. Errar aqui não dá erro: dá silêncio quando devia avisar, ou
-- quarenta e-mails quando devia avisar uma vez. Nenhum dos dois aparece em teste
-- de tela.

-- -----------------------------------------------------------------------------
-- Alerta de SLA
-- -----------------------------------------------------------------------------
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_dono   uuid := '22220000-0000-4000-8000-000000000002';  -- gestor de TI
  v_fila   uuid;
  v_prio   uuid;
  v_ticket uuid;
  v_antes  integer;
begin
  delete from public.email_outbox;

  select id into v_fila from public.queues where tenant_id = v_t and is_system_default;
  select id into v_prio from public.ticket_priorities where tenant_id = v_t order by sort_order limit 1;

  insert into public.tickets (tenant_id, title, status, priority_id, queue_id, requester_id, assignee_id)
  values (v_t, 'Estourado para teste de alerta', 'open', v_prio, v_fila, v_dono, v_dono)
  returning id into v_ticket;

  -- Força o estado: prazo no passado, nada resolvido. `app.sla_state` devolve
  -- 'breached' por `now() > p_due`, sem depender dos percentuais do tenant.
  update public.sla_tracking
     set resolution_due_at = now() - interval '1 hour',
         resolved_at = null, resolution_breached = false,
         coverage = 'covered', is_paused = false
   where ticket_id = v_ticket;

  perform app.job_sla_alerts();
  perform app.assert(
    (select count(*) from public.email_outbox
      where ticket_id = v_ticket and kind = 'sla_breach') = 1,
    'prazo estourado enfileira UM aviso para o responsável');

  -- A asserção que mais importa: rodar de novo não duplica. O cron pode
  -- sobrepor, a chamada pode ser repetida, e ninguém recebe duas vezes.
  perform app.job_sla_alerts();
  perform app.job_sla_alerts();
  perform app.assert(
    (select count(*) from public.email_outbox
      where ticket_id = v_ticket and kind = 'sla_breach') = 1,
    'rodar três vezes continua sendo UM aviso — a chave de idempotência segura');

  -- Ticket reaberto é novo ciclo de atendimento: merece novo aviso.
  update public.tickets set reopened_count = reopened_count + 1 where id = v_ticket;
  perform app.job_sla_alerts();
  perform app.assert(
    (select count(*) from public.email_outbox
      where ticket_id = v_ticket and kind = 'sla_breach') = 2,
    'mas ticket reaberto gera um novo, porque a chave inclui o ciclo');

  -- Quem pediu silêncio recebe silêncio.
  delete from public.email_outbox;
  update public.tickets set reopened_count = reopened_count + 1 where id = v_ticket;
  insert into public.notification_preferences (tenant_id, user_id, kind, enabled)
  values (v_t, v_dono, 'sla_breach', false);
  perform app.job_sla_alerts();
  perform app.assert(
    (select count(*) from public.email_outbox where ticket_id = v_ticket) = 0,
    'opt-out silencia o aviso daquele tipo');
  delete from public.notification_preferences where user_id = v_dono;

  -- Ticket sem cobertura de SLA não tem prazo para estourar: avisar sobre ele
  -- seria cobrar uma promessa que ninguém fez.
  delete from public.email_outbox;
  update public.tickets set reopened_count = reopened_count + 1 where id = v_ticket;
  update public.sla_tracking set coverage = 'uncovered' where ticket_id = v_ticket;
  perform app.job_sla_alerts();
  perform app.assert(
    (select count(*) from public.email_outbox where ticket_id = v_ticket) = 0,
    'ticket sem cobertura de SLA não gera aviso');

  -- Pausado: o relógio parou, o aviso também.
  update public.sla_tracking set coverage = 'covered', is_paused = true where ticket_id = v_ticket;
  perform app.job_sla_alerts();
  perform app.assert(
    (select count(*) from public.email_outbox where ticket_id = v_ticket) = 0,
    'ticket com SLA pausado não gera aviso');

  -- Sem responsável, o aviso vai para quem pode agir. É o caso perigoso: ticket
  -- sem dono estourando em silêncio é a pior combinação possível.
  update public.sla_tracking set is_paused = false where ticket_id = v_ticket;
  update public.tickets set assignee_id = null, reopened_count = reopened_count + 1
   where id = v_ticket;
  perform app.job_sla_alerts();

  select count(*) into v_antes from public.profiles
   where tenant_id = v_t and is_active and role in ('gestor', 'admin') and email is not null;
  perform app.assert(
    (select count(*) from public.email_outbox where ticket_id = v_ticket) = v_antes,
    'ticket sem responsável avisa todos os gestores e admins ativos');

  delete from public.tickets where id = v_ticket;
end
$$;

-- -----------------------------------------------------------------------------
-- Fechamento automático — a regra que existia desde a 0002 e nunca rodou
-- -----------------------------------------------------------------------------
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_dono   uuid := '22220000-0000-4000-8000-000000000002';
  v_fila   uuid;
  v_prio   uuid;
  v_ticket uuid;
begin
  select id into v_fila from public.queues where tenant_id = v_t and is_system_default;
  select id into v_prio from public.ticket_priorities where tenant_id = v_t order by sort_order limit 1;

  insert into public.tickets (tenant_id, title, status, priority_id, queue_id, requester_id, assignee_id)
  values (v_t, 'Resolvido ontem', 'open', v_prio, v_fila, v_dono, v_dono)
  returning id into v_ticket;

  -- O caminho válido da máquina de estados: open → assigned → in_progress →
  -- resolved. Pular etapa é recusado pela trigger `tickets_before_update`, e o
  -- teste passa pelo mesmo caminho que a interface percorre.
  update public.tickets set status = 'assigned' where id = v_ticket;
  update public.tickets set status = 'in_progress' where id = v_ticket;
  update public.tickets set status = 'resolved', resolved_at = now() - interval '10 days'
   where id = v_ticket;

  -- Com 0, o recurso está DESLIGADO para o tenant. Sem o filtro `> 0`, todo
  -- ticket resolvido fecharia no mesmo instante em que foi resolvido, e a pessoa
  -- perderia a janela para dizer "não resolveu, não".
  update public.tenants set auto_close_after_days = 0 where id = v_t;
  perform app.job_auto_close();
  perform app.assert(
    (select status from public.tickets where id = v_ticket) = 'resolved',
    'auto_close_after_days = 0 desliga o fechamento automático');

  update public.tenants set auto_close_after_days = 3 where id = v_t;
  perform app.job_auto_close();
  perform app.assert(
    (select status from public.tickets where id = v_ticket) = 'closed',
    'resolvido há 10 dias com prazo de 3 é fechado');
  perform app.assert(
    (select change_source from public.tickets where id = v_ticket) = 'system',
    'e o fechamento fica marcado como do sistema, não como da interface');

  -- Resolvido agora NÃO fecha: o prazo é a janela da pessoa para reabrir.
  update public.tickets set status = 'in_progress' where id = v_ticket;
  update public.tickets set status = 'resolved', resolved_at = now() where id = v_ticket;
  perform app.job_auto_close();
  perform app.assert(
    (select status from public.tickets where id = v_ticket) = 'resolved',
    'resolvido agora não é fechado — a janela de reabertura é respeitada');

  delete from public.tickets where id = v_ticket;
end
$$;

-- -----------------------------------------------------------------------------
-- Pesquisa de satisfação
-- -----------------------------------------------------------------------------
do $$
declare
  v_t       uuid := 'a0000000-0000-4000-8000-000000000001';
  v_quem    uuid := '22220000-0000-4000-8000-000000000004';  -- solicitante
  v_dono    uuid := '22220000-0000-4000-8000-000000000002';
  v_fila    uuid;
  v_prio    uuid;
  v_ticket  uuid;
  v_corpo   text;
  v_token   text;
begin
  delete from public.email_outbox;

  select id into v_fila from public.queues where tenant_id = v_t and is_system_default;
  select id into v_prio from public.ticket_priorities where tenant_id = v_t order by sort_order limit 1;

  insert into public.tickets (tenant_id, title, status, priority_id, queue_id, requester_id, assignee_id)
  values (v_t, 'Para avaliar', 'open', v_prio, v_fila, v_quem, v_dono)
  returning id into v_ticket;

  -- Resolvido ainda NÃO convida: entre resolvido e fechado a pessoa pode
  -- reabrir, e perguntar "como foi?" para quem está prestes a dizer "não
  -- resolveu" é a pior hora de perguntar.
  update public.tickets set status = 'assigned' where id = v_ticket;
  update public.tickets set status = 'in_progress' where id = v_ticket;
  update public.tickets set status = 'resolved', resolved_at = now() where id = v_ticket;
  perform app.job_satisfaction_invites();
  perform app.assert(
    not exists (select 1 from public.ticket_satisfaction where ticket_id = v_ticket),
    'chamado resolvido ainda não recebe convite de avaliação');

  update public.tickets set status = 'closed', closed_at = now() where id = v_ticket;
  perform app.job_satisfaction_invites();
  perform app.assert(
    exists (select 1 from public.ticket_satisfaction where ticket_id = v_ticket),
    'chamado encerrado recebe o convite');
  perform app.assert(
    (select count(*) from public.email_outbox
      where ticket_id = v_ticket and kind = 'satisfaction_invite') = 1,
    'e o e-mail vai para quem ABRIU o chamado');
  perform app.assert(
    (select to_email from public.email_outbox where ticket_id = v_ticket)
      = (select email from public.profiles where id = v_quem),
    'o destinatário é o solicitante, não o responsável');

  perform app.job_satisfaction_invites();
  perform app.assert(
    (select count(*) from public.email_outbox where ticket_id = v_ticket) = 1,
    'rodar de novo não convida duas vezes');

  -- O token vai NO CORPO em claro e no banco só como hash. Vazamento do banco
  -- não entrega os links de avaliação.
  select body_text into v_corpo from public.email_outbox where ticket_id = v_ticket;
  v_token := substring(v_corpo from '/avaliar/([0-9a-f]+)');
  perform app.assert(v_token is not null and length(v_token) = 48,
    'o corpo carrega o link com o token em claro');
  perform app.assert(
    (select token_hash from public.ticket_satisfaction where ticket_id = v_ticket)
      = encode(digest(v_token, 'sha256'), 'hex'),
    'e a tabela guarda só o hash dele');
  perform app.assert(
    not exists (select 1 from public.ticket_satisfaction where token_hash = v_token),
    'o token em claro NÃO está na tabela');

  -- Responder: nota fora da escala é recusada antes de qualquer gravação.
  perform app.assert(public.submit_satisfaction(v_token, 6::smallint) = false,
    'nota 6 é recusada — a escala é de 1 a 5');
  perform app.assert(public.submit_satisfaction(v_token, 0::smallint) = false,
    'nota 0 também');
  perform app.assert(public.submit_satisfaction('token-inventado', 5::smallint) = false,
    'token inexistente é recusado');

  perform app.assert(public.submit_satisfaction(v_token, 4::smallint, '  ótimo  ') = true,
    'o token certo grava a nota');
  perform app.assert(
    (select score from public.ticket_satisfaction where ticket_id = v_ticket) = 4,
    'a nota gravada é a que foi enviada');
  perform app.assert(
    (select comment from public.ticket_satisfaction where ticket_id = v_ticket) = 'ótimo',
    'e o comentário chega aparado');

  -- Uma vez só. Sem isto, quem tivesse o link mudaria a nota quantas vezes
  -- quisesse — e a média viraria a opinião de quem clica mais.
  perform app.assert(public.submit_satisfaction(v_token, 1::smallint) = false,
    'o mesmo token não responde duas vezes');
  perform app.assert(
    (select score from public.ticket_satisfaction where ticket_id = v_ticket) = 4,
    'e a nota original não é sobrescrita');

  -- Expirado: avaliação de dois meses atrás mede memória, não atendimento.
  update public.ticket_satisfaction
     set answered_at = null, score = null, expires_at = now() - interval '1 day'
   where ticket_id = v_ticket;
  perform app.assert(public.submit_satisfaction(v_token, 5::smallint) = false,
    'link expirado não grava');

  -- A leitura do convite devolve o que a tela precisa, e nada além.
  update public.ticket_satisfaction set expires_at = now() + interval '30 days'
   where ticket_id = v_ticket;
  perform app.assert(
    (select count(*) from public.satisfaction_invite(v_token)) = 1,
    'satisfaction_invite encontra o convite pelo token');
  perform app.assert(
    (select count(*) from public.satisfaction_invite('nao-existe')) = 0,
    'e não encontra nada com token inventado');

  delete from public.tickets where id = v_ticket;
  delete from public.email_outbox;
end
$$;

-- -----------------------------------------------------------------------------
-- Quem pode disparar os trabalhos
-- -----------------------------------------------------------------------------
-- As três funções atravessam tenants por necessidade. Conceder execução a
-- `authenticated` transformaria qualquer pessoa logada num disparador de e-mail
-- para a base inteira — e essa é a diferença entre o terceiro uso DECLARADO da
-- chave de serviço e um buraco.
do $$
begin
  perform app.assert(
    not has_function_privilege('authenticated', 'app.job_sla_alerts()', 'execute'),
    'authenticated NÃO executa o trabalho de alerta de SLA');
  perform app.assert(
    not has_function_privilege('authenticated', 'app.job_auto_close()', 'execute'),
    'nem o de fechamento automático');
  perform app.assert(
    not has_function_privilege('authenticated', 'app.job_satisfaction_invites()', 'execute'),
    'nem o de convite de avaliação');
  perform app.assert(
    has_function_privilege('service_role', 'app.job_sla_alerts()', 'execute'),
    'e service_role executa — é o terceiro uso declarado no ADR-011');

  -- A resposta da pesquisa, ao contrário, é feita por quem não tem login.
  perform app.assert(
    has_function_privilege('anon', 'public.submit_satisfaction(text, smallint, text)', 'execute'),
    'responder a pesquisa é permitido a quem não tem conta — é o ponto dela');
end
$$;

-- -----------------------------------------------------------------------------
-- Quem pode LER a caixa de saída
-- -----------------------------------------------------------------------------
-- Ela contém o e-mail de outras pessoas.
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000004","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert((select count(*) from public.email_outbox) = 0,
    'solicitante não lê a caixa de saída');
  perform app.assert((select count(*) from public.job_runs) = 0,
    'nem o registro de execuções, que é da plataforma');
end
$$;
reset role;

-- =============================================================================
\echo '=== 35. O agente de inventário: inscrição, ingestão e conciliação (0031) ==='
-- =============================================================================
reset role;

-- Estas asserções existem porque a conciliação é a única parte deste sistema cujo
-- erro é SILENCIOSO E CARO ao mesmo tempo: casar errado não dá exceção, não enche
-- log e não aparece em teste de tela — aparece como "meu computador está duas
-- vezes no inventário", dito pelo cliente, depois de 200 máquinas instaladas.

-- -----------------------------------------------------------------------------
-- 35.1 O filtro de número de série de fábrica
-- -----------------------------------------------------------------------------
-- É a asserção mais importante do arquivo. Placa-mãe de montagem branca e máquina
-- virtual vêm com texto de preenchimento no lugar do serial, e casar por esse
-- valor juntaria o lote inteiro num ativo só.
do $$
begin
  perform app.assert(app.agent_serial_utilizavel('5CG9274QXZ'),
    'serial de verdade passa');
  perform app.assert(app.agent_serial_utilizavel('VMware-42 3f 1a'),
    'serial de máquina virtual com formato próprio também passa');

  perform app.assert(not app.agent_serial_utilizavel(null),
    'nulo não serve de chave');
  perform app.assert(not app.agent_serial_utilizavel('   '),
    'nem espaço em branco');
  perform app.assert(not app.agent_serial_utilizavel('123'),
    'nem três caracteres — curto demais para identificar máquina');
  perform app.assert(not app.agent_serial_utilizavel('To Be Filled By O.E.M.'),
    'o texto da Dell/AMI não é número de série');
  perform app.assert(not app.agent_serial_utilizavel('to be filled by o.e.m.'),
    'e o filtro não depende de caixa');
  perform app.assert(not app.agent_serial_utilizavel('Default string'),
    'nem o da Supermicro');
  perform app.assert(not app.agent_serial_utilizavel('System Serial Number'),
    'nem o texto genérico do SMBIOS');
  perform app.assert(not app.agent_serial_utilizavel('N/A'),
    'nem N/A');
  perform app.assert(not app.agent_serial_utilizavel('0000000000'),
    'nem um caractere repetido — não identifica nada');
  perform app.assert(not app.agent_serial_utilizavel('--------'),
    'inclusive quando o caractere é traço');
end
$$;

-- -----------------------------------------------------------------------------
-- 35.2 Inscrição: o token do tenant vira token da máquina
-- -----------------------------------------------------------------------------
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_fil    uuid := '11110000-0000-4000-8000-000000000002';
  v_enr    uuid;
  v_dev1   uuid;
  v_tok1   text;
  v_dev1b  uuid;
  v_tok1b  text;
  v_usos   integer;
  v_u1     uuid := '77770000-0000-4000-8000-000000000001';
begin
  delete from public.agent_devices where tenant_id = v_t;
  delete from public.agent_enrollments where tenant_id = v_t;

  insert into public.agent_enrollments (tenant_id, name, token_hash, branch_id, max_uses)
  values (v_t, 'Lote de teste', encode(digest('inv_token_bom', 'sha256'), 'hex'), v_fil, 2)
  returning id into v_enr;

  -- Token errado não diz por que está errado: devolve zero linha.
  perform app.assert(
    not exists (select 1 from public.agent_enroll('inv_token_errado',
      jsonb_build_object('device_uuid', v_u1::text))),
    'token de inscrição errado devolve zero linha, sem dizer o motivo');

  perform app.assert(
    not exists (select 1 from public.agent_enroll('inv_token_bom', '{}'::jsonb)),
    'e inscrição sem device_uuid também — é a identidade da máquina');

  select device_id, device_token into v_dev1, v_tok1
    from public.agent_enroll('inv_token_bom',
      jsonb_build_object('device_uuid', v_u1::text, 'hostname', 'NOTE-TESTE-1',
                         'os', 'windows', 'chassis', 'notebook', 'agent_version', '1.0.0'));

  perform app.assert(v_dev1 is not null, 'token bom inscreve a máquina');
  perform app.assert(v_tok1 like 'ag\_%', 'e devolve um token da máquina');
  perform app.assert(length(v_tok1) = 67,
    'de 32 bytes em hexa mais o prefixo — comprimento fixo, sem segredo curto');

  perform app.assert(
    (select token_hash from public.agent_devices where id = v_dev1)
      = encode(digest(v_tok1, 'sha256'), 'hex'),
    'e guarda o HASH, nunca o token em claro');

  perform app.assert(
    (select branch_id from public.agent_devices where id = v_dev1) = v_fil,
    'a filial vem do token: o técnico que instala na filial não classifica nada depois');

  select uses_count into v_usos from public.agent_enrollments where id = v_enr;
  perform app.assert(v_usos = 1, 'a inscrição consumiu uma vaga');

  -- Reinstalar o agente na mesma máquina: mesma linha, token novo, vaga intacta.
  select device_id, device_token into v_dev1b, v_tok1b
    from public.agent_enroll('inv_token_bom',
      jsonb_build_object('device_uuid', v_u1::text, 'hostname', 'NOTE-TESTE-1',
                         'agent_version', '1.1.0'));

  perform app.assert(v_dev1b = v_dev1,
    'reinstalar o agente na mesma máquina NÃO cria uma segunda linha');
  perform app.assert(v_tok1b <> v_tok1,
    'mas rotaciona o token — o antigo pode ter vazado no reinstalar');
  perform app.assert(
    (select uses_count from public.agent_enrollments where id = v_enr) = 1,
    'e não consome outra vaga: senão reinstalar 30 agentes gastaria o lote duas vezes');
  perform app.assert(
    (select agent_version from public.agent_devices where id = v_dev1) = '1.1.0',
    'a versão do agente é atualizada na reinscrição');

  -- O token antigo morre na hora.
  perform app.assert(
    (select status from public.agent_ingest_inventory(v_tok1, '{}'::jsonb)) = 'unauthorized',
    'o token antigo para de valer no instante da rotação');
end
$$;

-- -----------------------------------------------------------------------------
-- 35.3 Os limites do token de inscrição
-- -----------------------------------------------------------------------------
-- Se eles não valessem, o token vazado seria acesso de escrita permanente.
do $$
declare
  v_t   uuid := 'a0000000-0000-4000-8000-000000000001';
  v_e1  uuid;
begin
  -- Esgotado
  insert into public.agent_enrollments (tenant_id, name, token_hash, max_uses)
  values (v_t, 'Esgotado', encode(digest('inv_esgotado', 'sha256'), 'hex'), 1)
  returning id into v_e1;
  perform public.agent_enroll('inv_esgotado',
    jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000011'));
  perform app.assert(
    not exists (select 1 from public.agent_enroll('inv_esgotado',
      jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000012'))),
    'token com max_uses esgotado recusa a máquina seguinte');

  -- Vencido
  insert into public.agent_enrollments (tenant_id, name, token_hash, expires_at)
  values (v_t, 'Vencido', encode(digest('inv_vencido', 'sha256'), 'hex'),
          now() - interval '1 day');
  perform app.assert(
    not exists (select 1 from public.agent_enroll('inv_vencido',
      jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000013'))),
    'token vencido não inscreve');

  -- Revogado
  insert into public.agent_enrollments (tenant_id, name, token_hash, revoked_at)
  values (v_t, 'Revogado', encode(digest('inv_revogado', 'sha256'), 'hex'), now());
  perform app.assert(
    not exists (select 1 from public.agent_enroll('inv_revogado',
      jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000014'))),
    'nem token revogado');

  -- E a máquina revogada não volta sozinha. Se voltasse, revogar não serviria de
  -- nada: bastaria reinstalar o agente para desfazer a decisão.
  update public.agent_devices set revoked_at = now()
   where device_uuid = '77770000-0000-4000-8000-000000000011';
  insert into public.agent_enrollments (tenant_id, name, token_hash)
  values (v_t, 'Aberto', encode(digest('inv_aberto', 'sha256'), 'hex'));
  perform app.assert(
    not exists (select 1 from public.agent_enroll('inv_aberto',
      jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000011'))),
    'máquina revogada não se reinscreve: reinstalar o agente não desfaz a revogação');
end
$$;

-- -----------------------------------------------------------------------------
-- 35.4 Ingestão: inventário igual não vira linha nova
-- -----------------------------------------------------------------------------
do $$
declare
  v_t     uuid := 'a0000000-0000-4000-8000-000000000001';
  v_tok   text;
  v_dev   uuid;
  v_p     jsonb;
  v_r     record;
  v_visto timestamptz;
begin
  select device_id, device_token into v_dev, v_tok
    from public.agent_enroll('inv_aberto',
      jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000020',
                         'hostname', 'NOTE-INGEST', 'chassis', 'notebook'));

  v_p := jsonb_build_object(
    'sistema', jsonb_build_object(
      'hostname', 'NOTE-INGEST', 'os', 'windows', 'os_version', '10.0.19045',
      'chassi', 'notebook', 'fabricante', 'Dell Inc.', 'modelo', 'Latitude 5420',
      'numero_serie', '5CG9274QXZ'),
    'memoria', jsonb_build_object('total_bytes', 17179869184),
    'software', jsonb_build_array(
      jsonb_build_object('nome', 'Google Chrome', 'versao', '120.0', 'fabricante', 'Google LLC'),
      jsonb_build_object('nome', '7-Zip', 'versao', '23.01')),
    'agente', jsonb_build_object('versao', '1.0.0'));

  perform app.assert(
    (select status from public.agent_ingest_inventory('ag_token_que_nao_existe', v_p)) = 'unauthorized',
    'token de máquina desconhecido é recusado');

  select * into v_r from public.agent_ingest_inventory(v_tok, v_p);
  perform app.assert(v_r.status = 'stored', 'o primeiro inventário é guardado');
  perform app.assert(v_r.snapshot_id is not null, 'e gera um snapshot');
  perform app.assert(v_r.asset_id is not null, 'e já sai conciliado com um ativo');

  -- O MESMO inventário de novo: só o contato, sem linha nova.
  select last_seen_at into v_visto from public.agent_devices where id = v_dev;
  select * into v_r from public.agent_ingest_inventory(v_tok, v_p);
  perform app.assert(v_r.status = 'unchanged',
    'inventário idêntico devolve "unchanged"');
  perform app.assert(v_r.snapshot_id is null, 'e NÃO gera snapshot');
  perform app.assert(
    (select count(*) from public.agent_inventory_snapshots where device_id = v_dev) = 1,
    'o histórico continua com uma linha só — é o que o torna legível');
  perform app.assert(
    (select last_seen_at from public.agent_devices where id = v_dev) >= v_visto,
    'mas o contato É registrado: é assim que se distingue máquina parada de máquina igual');

  -- O carimbo da coleta chega separado justamente para não entrar no hash.
  select * into v_r from public.agent_ingest_inventory(v_tok, v_p, now() + interval '1 day');
  perform app.assert(v_r.status = 'unchanged',
    'coletar de novo uma hora depois não é uma mudança — o hash é só do conteúdo');

  -- Agora um pente de memória a menos. ISTO é uma mudança, e é a pergunta que
  -- paga o módulo: memória que some ou é defeito ou é furto.
  select * into v_r from public.agent_ingest_inventory(
    v_tok, jsonb_set(v_p, '{memoria,total_bytes}', '8589934592'::jsonb));
  perform app.assert(v_r.status = 'stored', 'metade da memória a menos é mudança');
  perform app.assert(
    (select count(*) from public.agent_inventory_snapshots where device_id = v_dev) = 2,
    'e vira a segunda linha do histórico, comparável com a primeira');
end
$$;

-- -----------------------------------------------------------------------------
-- 35.5 Software: o desinstalado não é apagado
-- -----------------------------------------------------------------------------
-- "Quem desinstalou o antivírus?" é pergunta de segurança, não de inventário.
-- Apagar a linha apagaria junto a resposta.
do $$
declare
  v_dev uuid;
  v_tok text;
  v_p   jsonb;
begin
  select id into v_dev from public.agent_devices
   where device_uuid = '77770000-0000-4000-8000-000000000020';

  perform app.assert(
    (select count(*) from public.agent_software where device_id = v_dev) = 2,
    'os dois programas do inventário viraram linha');
  perform app.assert(
    exists (select 1 from public.agent_software
             where device_id = v_dev and name = 'Google Chrome' and version = '120.0'),
    'com nome e versão');

  select device_token into v_tok from public.agent_enroll('inv_aberto',
    jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000020'));

  -- Novo inventário SEM o 7-Zip e com o Chrome atualizado.
  v_p := jsonb_build_object(
    'sistema', jsonb_build_object('hostname', 'NOTE-INGEST', 'numero_serie', '5CG9274QXZ'),
    'software', jsonb_build_array(
      jsonb_build_object('nome', 'Google Chrome', 'versao', '121.0')),
    'agente', jsonb_build_object('versao', '1.0.0'));
  perform public.agent_ingest_inventory(v_tok, v_p);

  perform app.assert(
    exists (select 1 from public.agent_software
             where device_id = v_dev and name = '7-Zip'),
    'o programa desinstalado NÃO é apagado');
  perform app.assert(
    (select count(*) from public.agent_software
      where device_id = v_dev and name = 'Google Chrome') = 2,
    'e a atualização vira outra linha: 120 e 121 são fatos diferentes');
end
$$;

-- -----------------------------------------------------------------------------
-- 35.6 Conciliação: nunca duplicar
-- -----------------------------------------------------------------------------
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_ativo  uuid;
  v_antes  integer;
  v_tok    text;
  v_dev    uuid;
  v_r      record;
begin
  select count(*) into v_antes from public.it_assets where tenant_id = v_t;

  -- (a) Casa por número de série com um ativo digitado à mão.
  insert into public.it_assets (tenant_id, asset_type, serial_number, asset_tag)
  values (v_t, 'notebook', 'SERIAL-CADASTRADO-1', 'PAT-9001')
  returning id into v_ativo;

  select device_id, device_token into v_dev, v_tok
    from public.agent_enroll('inv_aberto',
      jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000030',
                         'hostname', 'MAQ-SERIAL'));
  select * into v_r from public.agent_ingest_inventory(v_tok,
    jsonb_build_object('sistema', jsonb_build_object(
      'numero_serie', 'serial-cadastrado-1', 'fabricante', 'Lenovo')));

  perform app.assert(v_r.asset_id = v_ativo,
    'casa pelo número de série com o ativo que já existia');
  perform app.assert(
    (select match_method from public.agent_devices where id = v_dev) = 'serial',
    'e registra COMO casou — ativo casado por serial não precisa de olhar humano');
  perform app.assert(
    (select count(*) from public.it_assets where tenant_id = v_t) = v_antes + 1,
    'e NÃO criou um segundo ativo');

  -- (b) Casa pelo UUID já gravado, mesmo que alguém edite o serial no cadastro.
  update public.it_assets set serial_number = 'ALGUEM-CORRIGIU-A-MAO'
   where id = v_ativo;
  update public.agent_devices set it_asset_id = null, match_method = null
   where id = v_dev;
  select device_token into v_tok from public.agent_enroll('inv_aberto',
    jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000030'));
  select * into v_r from public.agent_ingest_inventory(v_tok,
    jsonb_build_object('sistema', jsonb_build_object(
      'numero_serie', 'serial-cadastrado-1', 'memo', 'muda o hash')));

  perform app.assert(v_r.asset_id = v_ativo,
    'o vínculo sobrevive a alguém editar o serial: o UUID da máquina é a segunda chave');
  perform app.assert(
    (select match_method from public.agent_devices where id = v_dev) = 'device_uuid',
    'e o método registrado passa a ser device_uuid');
end
$$;

-- -----------------------------------------------------------------------------
-- 35.7 Hostname só casa com ativo SEM número de série
-- -----------------------------------------------------------------------------
-- É a restrição mais delicada da conciliação. Nome de máquina se repete entre
-- equipamentos trocados — "NOTE-FISCAL" é o notebook do setor, não aquele
-- notebook. Sem a restrição, o inventário casaria o substituto com o substituído
-- e perderia os dois.
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_sem    uuid;
  v_com    uuid;
  v_tok    text;
  v_dev    uuid;
  v_r      record;
begin
  -- Ativo sem serial, identificado só pelo patrimônio = nome da máquina.
  insert into public.it_assets (tenant_id, asset_type, asset_tag)
  values (v_t, 'desktop', 'PC-RECEPCAO')
  returning id into v_sem;

  select device_id, device_token into v_dev, v_tok
    from public.agent_enroll('inv_aberto',
      jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000040',
                         'hostname', 'pc-recepcao', 'chassis', 'desktop'));
  select * into v_r from public.agent_ingest_inventory(v_tok,
    jsonb_build_object('sistema', jsonb_build_object('hostname', 'pc-recepcao')));

  perform app.assert(v_r.asset_id = v_sem,
    'casa por hostname com ativo que não tem serial nenhum');
  perform app.assert(
    (select match_method from public.agent_devices where id = v_dev) = 'hostname',
    'e marca hostname — que é o método que a tela destaca para revisão');

  -- Agora o oposto: ativo COM serial e mesmo nome. Não é a mesma máquina.
  insert into public.it_assets (tenant_id, asset_type, asset_tag, serial_number)
  values (v_t, 'desktop', 'PC-TROCADO', 'SERIAL-DO-ANTIGO')
  returning id into v_com;

  select device_id, device_token into v_dev, v_tok
    from public.agent_enroll('inv_aberto',
      jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000041',
                         'hostname', 'PC-TROCADO', 'chassis', 'desktop'));
  select * into v_r from public.agent_ingest_inventory(v_tok,
    jsonb_build_object('sistema', jsonb_build_object(
      'hostname', 'PC-TROCADO', 'numero_serie', 'SERIAL-DO-NOVO')));

  perform app.assert(v_r.asset_id <> v_com,
    'mas NÃO casa com ativo que tem outro serial, por mais que o nome bata');
  perform app.assert(
    (select match_method from public.agent_devices where id = v_dev) = 'created',
    'cria um ativo novo — o substituto não é o substituído');
end
$$;

-- -----------------------------------------------------------------------------
-- 35.8 Duas máquinas com o MESMO serial de fábrica viram DOIS ativos
-- -----------------------------------------------------------------------------
-- É o 35.1 provado de ponta a ponta. Sem o filtro, as 80 máquinas montadas do
-- mesmo lote casariam todas no mesmo ativo e o inventário mostraria 1 computador
-- onde há 80.
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_tk1  text;
  v_tk2  text;
  v_a1   uuid;
  v_a2   uuid;
begin
  select device_token into v_tk1 from public.agent_enroll('inv_aberto',
    jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000050',
                       'hostname', 'MONTADA-01', 'chassis', 'desktop'));
  select device_token into v_tk2 from public.agent_enroll('inv_aberto',
    jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000051',
                       'hostname', 'MONTADA-02', 'chassis', 'desktop'));

  select asset_id into v_a1 from public.agent_ingest_inventory(v_tk1,
    jsonb_build_object('sistema', jsonb_build_object(
      'hostname', 'MONTADA-01', 'numero_serie', 'To Be Filled By O.E.M.')));
  select asset_id into v_a2 from public.agent_ingest_inventory(v_tk2,
    jsonb_build_object('sistema', jsonb_build_object(
      'hostname', 'MONTADA-02', 'numero_serie', 'To Be Filled By O.E.M.')));

  perform app.assert(v_a1 is not null and v_a2 is not null, 'as duas entram no inventário');
  perform app.assert(v_a1 <> v_a2,
    'duas máquinas com o mesmo texto de fábrica no serial viram DOIS ativos');
  perform app.assert(
    (select serial_number from public.it_assets where id = v_a1) is null,
    'e o texto de fábrica não é gravado como se fosse número de série');
end
$$;

-- -----------------------------------------------------------------------------
-- 35.9 O agente preenche o que está em branco; não discute com gente
-- -----------------------------------------------------------------------------
do $$
declare
  v_t     uuid := 'a0000000-0000-4000-8000-000000000001';
  v_ativo uuid;
  v_tok   text;
  v_dev   uuid;
begin
  -- Alguém digitou o serial e o modelo; a marca ficou em branco.
  insert into public.it_assets (tenant_id, asset_type, serial_number, model)
  values (v_t, 'notebook', 'DIGITADO-PELA-PESSOA', 'Latitude 5420')
  returning id into v_ativo;

  select device_id, device_token into v_dev, v_tok
    from public.agent_enroll('inv_aberto',
      jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000060',
                         'hostname', 'MAQ-DIVERGENTE'));
  -- O agente liga por UUID depois de um primeiro casamento forçado, para o teste
  -- medir a divergência e não a criação.
  update public.agent_devices set it_asset_id = v_ativo, match_method = 'serial'
   where id = v_dev;

  perform public.agent_ingest_inventory(v_tok,
    jsonb_build_object('sistema', jsonb_build_object(
      'numero_serie', 'LIDO-PELO-AGENTE', 'fabricante', 'Dell Inc.',
      'modelo', 'Latitude 5430')));

  perform app.assert(
    (select serial_number from public.it_assets where id = v_ativo) = 'DIGITADO-PELA-PESSOA',
    'o agente NÃO sobrescreve o número de série que uma pessoa digitou');
  perform app.assert(
    (select brand from public.it_assets where id = v_ativo) = 'Dell Inc.',
    'mas preenche a marca, que estava em branco');
  perform app.assert(
    (select model from public.it_assets where id = v_ativo) = 'Latitude 5420',
    'e o modelo digitado continua valendo');

  perform app.assert(
    (select divergences -> 'serial_number' ->> 'cadastrado'
       from public.agent_devices where id = v_dev) = 'DIGITADO-PELA-PESSOA',
    'a divergência de serial fica registrada, com o lado do cadastro');
  perform app.assert(
    (select divergences -> 'serial_number' ->> 'agente'
       from public.agent_devices where id = v_dev) = 'LIDO-PELO-AGENTE',
    'e com o lado do agente — sobrescrever apagaria a correção, ignorar deixaria o erro');
  perform app.assert(
    (select divergences -> 'model' ->> 'agente'
       from public.agent_devices where id = v_dev) = 'Latitude 5430',
    'a divergência de modelo também');

  -- E o que é território do agente é dele: `specs -> 'agente'` é sobrescrito.
  perform app.assert(
    (select specs -> 'agente' ->> 'device_uuid' from public.it_assets where id = v_ativo)
      = '77770000-0000-4000-8000-000000000060',
    'o UUID da máquina fica gravado no ativo — é a segunda chave da conciliação');
end
$$;

-- -----------------------------------------------------------------------------
-- 35.10 O batimento não enche a trilha de auditoria
-- -----------------------------------------------------------------------------
-- 200 máquinas a cada 10 minutos são 28.800 contatos por dia. Auditado, cada um
-- viraria uma linha dizendo "o relógio andou", e a trilha — que existe para
-- responder "quem mexeu nisto?" — passaria a ter 99,9% de ruído.
do $$
declare
  v_dev   uuid;
  v_tok   text;
  v_antes bigint;
begin
  select id into v_dev from public.agent_devices
   where device_uuid = '77770000-0000-4000-8000-000000000020';
  select device_token into v_tok from public.agent_enroll('inv_aberto',
    jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000020'));

  -- Um inventário igual ao último: só o contato muda.
  perform public.agent_ingest_inventory(v_tok, jsonb_build_object(
    'sistema', jsonb_build_object('hostname', 'NOTE-INGEST', 'numero_serie', '5CG9274QXZ'),
    'software', jsonb_build_array(jsonb_build_object('nome', 'Google Chrome', 'versao', '121.0')),
    'agente', jsonb_build_object('versao', '1.0.0')));

  select count(*) into v_antes from public.audit_log
   where entity_type = 'agent_devices' and entity_id = v_dev::text;

  perform public.agent_ingest_inventory(v_tok, jsonb_build_object(
    'sistema', jsonb_build_object('hostname', 'NOTE-INGEST', 'numero_serie', '5CG9274QXZ'),
    'software', jsonb_build_array(jsonb_build_object('nome', 'Google Chrome', 'versao', '121.0')),
    'agente', jsonb_build_object('versao', '1.0.0')));

  perform app.assert(
    (select count(*) from public.audit_log
      where entity_type = 'agent_devices' and entity_id = v_dev::text) = v_antes,
    'contato de agente sem mudança NÃO vira linha de auditoria');

  -- Revogar, sim: é decisão de gente.
  update public.agent_devices set revoked_at = now() where id = v_dev;
  perform app.assert(
    (select count(*) from public.audit_log
      where entity_type = 'agent_devices' and entity_id = v_dev::text) > v_antes,
    'mas revogar vira: é decisão de gente, e é o que a trilha existe para registrar');
  update public.agent_devices set revoked_at = null where id = v_dev;

  -- O batimento é o mesmo sinal custando algumas centenas de bytes em vez de
  -- meio megabyte. Ele também não vira auditoria, pela mesma regra.
  select device_token into v_tok from public.agent_enroll('inv_aberto',
    jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000020'));
  perform app.assert(public.agent_heartbeat(v_tok, '1.4.0'),
    'o batimento aceita o token da máquina');
  perform app.assert(
    (select agent_version from public.agent_devices where id = v_dev) = '1.4.0',
    'e aproveita para registrar a versão do agente');
  perform app.assert(not public.agent_heartbeat('ag_token_inventado'),
    'e recusa token que não existe');

  update public.agent_devices set revoked_at = now() where id = v_dev;
  perform app.assert(not public.agent_heartbeat(v_tok),
    'máquina revogada não dá mais sinal de vida');
  update public.agent_devices set revoked_at = null where id = v_dev;
end
$$;

-- -----------------------------------------------------------------------------
-- 35.11 Um ativo tem no máximo um agente
-- -----------------------------------------------------------------------------
-- Dois agentes no mesmo ativo significa conciliação errada, e é melhor o banco
-- recusar do que a tela sumir com um dos dois sem explicar.
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_a    uuid;
  v_d1   uuid;
  v_d2   uuid;
  v_erro boolean := false;
begin
  select it_asset_id, id into v_a, v_d1 from public.agent_devices
   where tenant_id = v_t and it_asset_id is not null and revoked_at is null limit 1;
  select id into v_d2 from public.agent_devices
   where tenant_id = v_t and id <> v_d1 and revoked_at is null limit 1;

  begin
    update public.agent_devices set it_asset_id = v_a where id = v_d2;
  exception when unique_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro, 'o banco recusa dois agentes no mesmo ativo');
end
$$;

-- -----------------------------------------------------------------------------
-- 35.12 A visão da frota
-- -----------------------------------------------------------------------------
do $$
declare
  v_t   uuid := 'a0000000-0000-4000-8000-000000000001';
  v_dev uuid;
begin
  select id into v_dev from public.agent_devices
   where device_uuid = '77770000-0000-4000-8000-000000000020';

  perform app.assert(
    (select silencioso from public.vw_agent_fleet where device_id = v_dev) = false,
    'máquina que acabou de falar não está silenciosa');

  update public.agent_devices set last_seen_at = now() - interval '3 days' where id = v_dev;
  perform app.assert(
    (select silencioso from public.vw_agent_fleet where device_id = v_dev) = true,
    'máquina muda há três dias está silenciosa — o agente fala de 10 em 10 minutos');

  perform app.assert(
    (select count(*) from public.vw_agent_fleet f
      where f.tenant_id = v_t and f.branch_id is not null) >= 1,
    'a visão carrega branch_id: indicador sem a coluna do escopo conta o tenant inteiro');

  perform app.assert(
    not exists (select 1 from public.vw_agent_fleet f
                 join public.agent_devices d on d.id = f.device_id
                where d.revoked_at is not null),
    'máquina revogada sai da frota');
end
$$;

-- -----------------------------------------------------------------------------
-- 35.13 Quem enxerga, e quem executa
-- -----------------------------------------------------------------------------
do $$
begin
  -- O agente não tem conta e nunca vai ter: é um serviço.
  perform app.assert(
    has_function_privilege('anon', 'public.agent_enroll(text, jsonb)', 'execute'),
    'anon inscreve a máquina — ela não tem como ter login');
  perform app.assert(
    has_function_privilege('anon',
      'public.agent_ingest_inventory(text, jsonb, timestamptz)', 'execute'),
    'e manda o inventário');

  -- A conciliação é interna. Exposta, qualquer sessão religaria uma máquina a
  -- outro ativo sem passar por policy nenhuma.
  perform app.assert(
    not has_function_privilege('authenticated', 'app.agent_reconcile(uuid)', 'execute'),
    'mas NINGUÉM chama a conciliação de fora — nem authenticated');
  perform app.assert(
    not has_function_privilege('anon', 'app.agent_reconcile(uuid)', 'execute'),
    'nem anon');

  perform app.assert(
    has_function_privilege('anon', 'public.agent_heartbeat(text, text)', 'execute'),
    'e dá sinal de vida');

  -- E o quarto uso de service_role que esta onda NÃO abriu: as funções de
  -- ingestão são security definer justamente para não precisar dele.
  perform app.assert(
    (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'agent_ingest_inventory'),
    'a ingestão é security definer: é o que evita um quarto uso da chave de serviço');
end
$$;

-- Isolamento entre tenants e por permissão.
set role rls_tester;
set request.jwt.claims = '{"sub":"33330000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
begin
  perform app.assert((select count(*) from public.agent_devices) = 0,
    'tenant 2 não vê máquina do tenant 1');
  perform app.assert((select count(*) from public.agent_inventory_snapshots) = 0,
    'nem o inventário dela');
  perform app.assert((select count(*) from public.agent_software) = 0,
    'nem o software instalado nela');
  perform app.assert((select count(*) from public.agent_enrollments) = 0,
    'nem os tokens de inscrição dela');
  perform app.assert((select count(*) from public.vw_agent_fleet) = 0,
    'e a visão da frota respeita o mesmo limite');
end
$$;

-- Diego Moreira é operador financeiro: não tem `inventario.agentes.ver`.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert((select count(*) from public.agent_devices) = 0,
    'quem não tem a permissão da tela não vê a frota, mesmo no próprio tenant');
end
$$;

-- Ana Souza é operadora de TI: vê a frota, e não revoga.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
declare
  v_id uuid;
  v_n  integer;
begin
  perform app.assert((select count(*) from public.agent_devices) > 0,
    'operador de TI enxerga a frota');
  perform app.assert((select count(*) from public.agent_enrollments) = 0,
    'mas não os tokens de inscrição: token é credencial, e credencial é do administrador');

  select id into v_id from public.agent_devices limit 1;
  update public.agent_devices set revoked_at = now() where id = v_id;
  get diagnostics v_n = row_count;
  -- RLS nega devolvendo ZERO LINHAS, não erro. É por isso que toda escrita desta
  -- base confere `length` do retorno em vez de confiar na ausência de exceção.
  perform app.assert(v_n = 0,
    'e não revoga máquina: a negação do RLS chega como zero linhas, não como erro');
end
$$;
reset role;

-- =============================================================================
\echo '=== 36. Desempenho, retenção e alertas do agente (0032) ==='
-- =============================================================================
reset role;

-- Um alerta errado não dá erro: ou não chega (e o disco enche), ou chega oito
-- vezes por dia (e a pessoa cria uma regra de caixa de entrada que manda todos
-- para a lixeira — inclusive os que importam). As duas falhas são silenciosas e
-- só aparecem depois de instalado em duzentas máquinas.

-- -----------------------------------------------------------------------------
-- 36.1 Ingestão de métricas: o lote, e a idempotência do reenvio
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_tok  text;
  v_dev  uuid;
  v_r    record;
  v_base timestamptz := date_trunc('hour', now()) - interval '3 hours';
  v_lote jsonb;
begin
  delete from public.agent_metrics_raw;
  delete from public.agent_volume_samples;
  delete from public.agent_alerts;

  select device_id, device_token into v_dev, v_tok
    from public.agent_enroll('inv_aberto',
      jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000070',
                         'hostname', 'MAQ-METRICA', 'chassis', 'desktop'));

  perform app.assert(
    (select status from public.agent_ingest_metrics('ag_token_inventado', '[]'::jsonb)) = 'unauthorized',
    'token de máquina desconhecido é recusado na ingestão de métricas');

  v_lote := jsonb_build_array(
    jsonb_build_object('em', v_base, 'cpu', 20, 'mem_usada', 4000000000, 'mem_total', 8000000000,
      'volumes', jsonb_build_array(jsonb_build_object('ponto', 'C:', 'total', 1000, 'livre', 500))),
    jsonb_build_object('em', v_base + interval '5 min', 'cpu', 80, 'mem_usada', 6000000000, 'mem_total', 8000000000,
      'volumes', jsonb_build_array(jsonb_build_object('ponto', 'C:', 'total', 1000, 'livre', 300))));

  select * into v_r from public.agent_ingest_metrics(v_tok, v_lote);
  perform app.assert(v_r.status = 'stored' and v_r.aceitas = 2,
    'o lote de duas amostras entra inteiro');

  -- Reenviar o MESMO lote: é o que acontece quando a rede cai depois de o
  -- servidor gravar e antes de o agente receber a confirmação.
  select * into v_r from public.agent_ingest_metrics(v_tok, v_lote);
  perform app.assert(v_r.aceitas = 0,
    'reenviar o lote não aceita nada de novo');
  perform app.assert(
    (select count(*) from public.agent_metrics_raw where device_id = v_dev) = 2,
    'e NÃO duplica a amostra — senão a média da hora contaria a mesma leitura duas vezes');

  -- O volume vira UMA linha por hora, com o pior momento.
  perform app.assert(
    (select count(*) from public.agent_volume_samples where device_id = v_dev) = 1,
    'as duas amostras de volume viram uma linha por hora');
  perform app.assert(
    (select livre_min_bytes from public.agent_volume_samples where device_id = v_dev) = 300,
    'e o que fica é o MÍNIMO livre da hora, que é o que o alerta precisa');
  perform app.assert(
    (select amostras from public.agent_volume_samples where device_id = v_dev) = 2,
    'com a contagem de amostras da hora');

  -- O batimento também vale: mandar métrica é dar sinal de vida.
  perform app.assert(
    (select last_seen_at from public.agent_devices where id = v_dev) > now() - interval '1 minute',
    'enviar métrica registra o contato: a máquina acabou de falar');
end
$$;

-- -----------------------------------------------------------------------------
-- 36.2 O relógio da máquina de cliente erra
-- -----------------------------------------------------------------------------
-- Fuso mal configurado, bateria de placa-mãe acabada, imagem de máquina virtual
-- restaurada. Uma amostra com data de 2027 ficaria no topo de todo gráfico para
-- sempre, e a purga por retenção nunca a alcançaria.
do $$
declare
  v_tok text;
  v_dev uuid;
  v_r   record;
begin
  select id into v_dev from public.agent_devices
   where device_uuid = '77770000-0000-4000-8000-000000000070';
  select device_token into v_tok from public.agent_enroll('inv_aberto',
    jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000070'));

  select * into v_r from public.agent_ingest_metrics(v_tok, jsonb_build_array(
    jsonb_build_object('em', now() + interval '2 days', 'cpu', 10),
    jsonb_build_object('em', now() - interval '200 days', 'cpu', 10),
    jsonb_build_object('cpu', 10)));

  perform app.assert(v_r.aceitas = 0,
    'amostra do futuro, do passado remoto e sem data nenhuma são todas descartadas');
  perform app.assert(
    not exists (select 1 from public.agent_metrics_raw
                 where device_id = v_dev and collected_at > now() + interval '1 hour'),
    'e nenhuma delas ficou gravada');

  -- Uma hora de folga passa: cobre atraso de relógio honesto.
  select * into v_r from public.agent_ingest_metrics(v_tok, jsonb_build_array(
    jsonb_build_object('em', now() + interval '20 minutes', 'cpu', 10)));
  perform app.assert(v_r.aceitas = 1,
    'mas vinte minutos adiantado passa — relógio de máquina real atrasa e adianta');
end
$$;

-- -----------------------------------------------------------------------------
-- 36.3 Agregação por hora: só horas completas, e reprocessar não soma
-- -----------------------------------------------------------------------------
do $$
declare
  v_dev   uuid;
  v_hora  timestamptz := date_trunc('hour', now()) - interval '3 hours';
  v_antes integer;
begin
  select id into v_dev from public.agent_devices
   where device_uuid = '77770000-0000-4000-8000-000000000070';

  perform app.job_aggregate_metrics();

  perform app.assert(
    (select cpu_avg from public.agent_metrics_hourly where device_id = v_dev and hora = v_hora) = 50,
    'a média da hora é a média das amostras (20 e 80 = 50)');
  perform app.assert(
    (select cpu_max from public.agent_metrics_hourly where device_id = v_dev and hora = v_hora) = 80,
    'e o máximo fica junto: média de 40%% com picos de 100%% é uma máquina que trava');
  perform app.assert(
    (select mem_max_pct from public.agent_metrics_hourly where device_id = v_dev and hora = v_hora) = 75,
    'memória também, em percentual');
  perform app.assert(
    (select amostras from public.agent_metrics_hourly where device_id = v_dev and hora = v_hora) = 2,
    'com a contagem, para a tela saber se a hora está completa');

  -- A hora CORRENTE não é agregada: uma barra que encolhe e cresce sozinha é
  -- uma barra em que ninguém confia.
  perform app.assert(
    not exists (select 1 from public.agent_metrics_hourly
                 where device_id = v_dev and hora >= date_trunc('hour', now())),
    'a hora corrente NÃO é agregada enquanto não termina');

  -- Reprocessar substitui, não soma. Importa porque lote atrasado do agente
  -- acrescenta amostras a uma hora que já foi agregada.
  select amostras into v_antes from public.agent_metrics_hourly
   where device_id = v_dev and hora = v_hora;
  perform app.job_aggregate_metrics();
  perform app.assert(
    (select amostras from public.agent_metrics_hourly where device_id = v_dev and hora = v_hora) = v_antes,
    'reprocessar a mesma hora SUBSTITUI o agregado, não soma');
end
$$;

-- -----------------------------------------------------------------------------
-- 36.4 A histerese do alerta de disco
-- -----------------------------------------------------------------------------
-- É a asserção que impede o recurso mais útil do módulo de virar o motivo de as
-- pessoas criarem uma regra de caixa de entrada para ignorá-lo.
do $$
declare
  v_t   uuid := 'a0000000-0000-4000-8000-000000000001';
  v_dev uuid;
  v_fil uuid;
begin
  select id, branch_id into v_dev, v_fil from public.agent_devices
   where device_uuid = '77770000-0000-4000-8000-000000000070';

  delete from public.agent_alerts;
  delete from public.agent_volume_samples;
  delete from public.email_outbox;

  -- Limiar do tenant é 90 por padrão. 85% não abre.
  insert into public.agent_volume_samples (tenant_id, device_id, branch_id, ponto, hora, total_bytes, livre_min_bytes)
  values (v_t, v_dev, v_fil, 'C:', date_trunc('hour', now()), 1000, 150);
  perform app.job_agent_alerts();
  perform app.assert(
    not exists (select 1 from public.agent_alerts where device_id = v_dev and kind = 'disco_cheio'),
    '85%% de uso não abre alerta: o limiar do tenant é 90');

  -- 92% abre.
  update public.agent_volume_samples set livre_min_bytes = 80 where device_id = v_dev;
  perform app.job_agent_alerts();
  perform app.assert(
    (select count(*) from public.agent_alerts
      where device_id = v_dev and kind = 'disco_cheio' and fechado_em is null) = 1,
    '92%% abre UM alerta');
  perform app.assert(
    (select valor from public.agent_alerts where device_id = v_dev and kind = 'disco_cheio') = 92.00,
    'com o número que disparou, para a tela não recalcular');

  -- Rodar de novo não abre um segundo.
  perform app.job_agent_alerts();
  perform app.assert(
    (select count(*) from public.agent_alerts
      where device_id = v_dev and kind = 'disco_cheio') = 1,
    'rodar o trabalho de novo NÃO abre um segundo alerta para a mesma condição');

  /*
   * Agora a histerese. Com limiar 90 e fechamento em 85, um disco em 88% —
   * abaixo do limiar — CONTINUA com o alerta aberto. Sem essa folga, um disco
   * parado em 90,1% abriria e fecharia a cada ciclo, com um e-mail por vez.
   */
  update public.agent_volume_samples set livre_min_bytes = 120 where device_id = v_dev;
  perform app.job_agent_alerts();
  perform app.assert(
    (select fechado_em from public.agent_alerts
      where device_id = v_dev and kind = 'disco_cheio') is null,
    '88%% ainda NÃO fecha: é a histerese que impede o alerta de bater oito vezes por dia');

  -- 80% fecha.
  update public.agent_volume_samples set livre_min_bytes = 200 where device_id = v_dev;
  perform app.job_agent_alerts();
  perform app.assert(
    (select fechado_em from public.agent_alerts
      where device_id = v_dev and kind = 'disco_cheio') is not null,
    '80%% fecha — cinco pontos abaixo do limiar');

  -- E se encher de novo, abre OUTRO alerta: encher duas vezes são dois
  -- acontecimentos, e o segundo precisa avisar.
  update public.agent_volume_samples set livre_min_bytes = 50 where device_id = v_dev;
  perform app.job_agent_alerts();
  perform app.assert(
    (select count(*) from public.agent_alerts
      where device_id = v_dev and kind = 'disco_cheio') = 2,
    'encher de novo abre um alerta NOVO: são dois acontecimentos');
end
$$;

-- -----------------------------------------------------------------------------
-- 36.5 Dois volumes cheios na mesma máquina são dois alertas
-- -----------------------------------------------------------------------------
do $$
declare
  v_t   uuid := 'a0000000-0000-4000-8000-000000000001';
  v_dev uuid;
begin
  select id into v_dev from public.agent_devices
   where device_uuid = '77770000-0000-4000-8000-000000000070';

  insert into public.agent_volume_samples (tenant_id, device_id, ponto, hora, total_bytes, livre_min_bytes)
  values (v_t, v_dev, 'D:', date_trunc('hour', now()), 1000, 20);
  perform app.job_agent_alerts();

  perform app.assert(
    (select count(*) from public.agent_alerts
      where device_id = v_dev and kind = 'disco_cheio' and fechado_em is null) = 2,
    'C: e D: cheios são DOIS alertas: a chave inclui o ponto de montagem');
  perform app.assert(
    (select severidade from public.agent_alerts
      where device_id = v_dev and chave = 'D:' and fechado_em is null) = 'critico',
    'e 98%% é crítico, não apenas alerta');
end
$$;

-- -----------------------------------------------------------------------------
-- 36.6 Máquina muda
-- -----------------------------------------------------------------------------
-- É o alerta que justifica o módulo: agente parado não dá erro, não gera chamado,
-- simplesmente deixa de haver dado novo.
do $$
declare
  v_dev uuid;
begin
  select id into v_dev from public.agent_devices
   where device_uuid = '77770000-0000-4000-8000-000000000070';
  delete from public.agent_alerts where kind = 'maquina_muda';

  perform app.job_agent_alerts();
  perform app.assert(
    not exists (select 1 from public.agent_alerts where device_id = v_dev and kind = 'maquina_muda'),
    'máquina que acabou de falar não vira alerta');

  update public.agent_devices set last_seen_at = now() - interval '30 hours' where id = v_dev;
  perform app.job_agent_alerts();
  perform app.assert(
    (select count(*) from public.agent_alerts
      where device_id = v_dev and kind = 'maquina_muda' and fechado_em is null) = 1,
    'sem contato há 30 h abre alerta — o limiar do tenant é 24');

  update public.agent_devices set last_seen_at = now() where id = v_dev;
  perform app.job_agent_alerts();
  perform app.assert(
    (select fechado_em from public.agent_alerts
      where device_id = v_dev and kind = 'maquina_muda'
      order by aberto_em desc limit 1) is not null,
    'e voltar a falar fecha o alerta sozinho');

  -- Máquina revogada não vira alerta: ela foi tirada do parque de propósito.
  update public.agent_devices set last_seen_at = now() - interval '30 hours', revoked_at = now()
   where id = v_dev;
  delete from public.agent_alerts where kind = 'maquina_muda';
  perform app.job_agent_alerts();
  perform app.assert(
    not exists (select 1 from public.agent_alerts where device_id = v_dev and kind = 'maquina_muda'),
    'máquina revogada NÃO vira "muda": ela foi tirada do parque de propósito');
  update public.agent_devices set revoked_at = null, last_seen_at = now() where id = v_dev;
end
$$;

-- -----------------------------------------------------------------------------
-- 36.7 Serviço crítico fora do ar
-- -----------------------------------------------------------------------------
do $$
declare
  v_t   uuid := 'a0000000-0000-4000-8000-000000000001';
  v_dev uuid;
begin
  select id into v_dev from public.agent_devices
   where device_uuid = '77770000-0000-4000-8000-000000000070';
  delete from public.agent_alerts;
  delete from public.agent_metrics_raw where device_id = v_dev;

  insert into public.agent_metrics_raw (tenant_id, device_id, collected_at, cpu_percent, servicos_fora)
  values (v_t, v_dev, now() - interval '5 minutes', 10, array['antivirus', 'backup']);
  perform app.job_agent_alerts();

  perform app.assert(
    (select count(*) from public.agent_alerts
      where device_id = v_dev and kind = 'servico_fora' and fechado_em is null) = 2,
    'dois serviços fora são dois alertas, um por serviço');
  perform app.assert(
    (select severidade from public.agent_alerts
      where device_id = v_dev and kind = 'servico_fora' limit 1) = 'critico',
    'serviço crítico fora é crítico, não aviso');

  -- O antivírus voltou; o backup não.
  insert into public.agent_metrics_raw (tenant_id, device_id, collected_at, cpu_percent, servicos_fora)
  values (v_t, v_dev, now() - interval '1 minute', 10, array['backup']);
  perform app.job_agent_alerts();

  perform app.assert(
    (select fechado_em from public.agent_alerts
      where device_id = v_dev and kind = 'servico_fora' and chave = 'antivirus') is not null,
    'o serviço que voltou fecha o alerta dele');
  perform app.assert(
    (select fechado_em from public.agent_alerts
      where device_id = v_dev and kind = 'servico_fora' and chave = 'backup') is null,
    'e o que continua fora NÃO fecha junto');
end
$$;

-- -----------------------------------------------------------------------------
-- 36.8 SMART em falha vem do inventário, não das métricas
-- -----------------------------------------------------------------------------
do $$
declare
  v_dev uuid;
  v_tok text;
begin
  delete from public.agent_alerts;
  select device_token into v_tok from public.agent_enroll('inv_aberto',
    jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000071',
                       'hostname', 'MAQ-DISCO-RUIM'));
  select id into v_dev from public.agent_devices
   where device_uuid = '77770000-0000-4000-8000-000000000071';

  perform public.agent_ingest_inventory(v_tok, jsonb_build_object(
    'sistema', jsonb_build_object('hostname', 'MAQ-DISCO-RUIM'),
    'discos', jsonb_build_array(
      jsonb_build_object('modelo', 'ST1000DM010', 'saude', 'falha'),
      jsonb_build_object('modelo', 'Samsung 980', 'saude', 'ok'))));

  perform app.job_agent_alerts();
  perform app.assert(
    (select count(*) from public.agent_alerts
      where device_id = v_dev and kind = 'smart_falha' and fechado_em is null) = 1,
    'só o disco em falha vira alerta; o saudável não');
  perform app.assert(
    (select chave from public.agent_alerts where device_id = v_dev and kind = 'smart_falha') = 'ST1000DM010',
    'e o alerta diz QUAL disco — numa máquina com quatro, isso é a diferença entre trocar certo e errado');

  -- Trocado o disco, o alerta fecha sozinho na próxima coleta.
  select device_token into v_tok from public.agent_enroll('inv_aberto',
    jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000071'));
  perform public.agent_ingest_inventory(v_tok, jsonb_build_object(
    'sistema', jsonb_build_object('hostname', 'MAQ-DISCO-RUIM'),
    'discos', jsonb_build_array(
      jsonb_build_object('modelo', 'ST1000DM010', 'saude', 'ok'))));
  perform app.job_agent_alerts();
  perform app.assert(
    (select fechado_em from public.agent_alerts
      where device_id = v_dev and kind = 'smart_falha') is not null,
    'disco trocado fecha o alerta na coleta seguinte');
end
$$;

-- -----------------------------------------------------------------------------
-- 36.9 O aviso sai UMA vez por alerta
-- -----------------------------------------------------------------------------
-- "O cliente recebeu quarenta e-mails" é a falha clássica deste tipo de recurso.
do $$
declare
  v_t     uuid := 'a0000000-0000-4000-8000-000000000001';
  v_dev   uuid;
  v_antes integer;
begin
  delete from public.agent_alerts;
  delete from public.email_outbox;
  select id into v_dev from public.agent_devices
   where device_uuid = '77770000-0000-4000-8000-000000000070';

  insert into public.agent_volume_samples (tenant_id, device_id, ponto, hora, total_bytes, livre_min_bytes)
  values (v_t, v_dev, 'E:', date_trunc('hour', now()), 1000, 20)
  on conflict (device_id, ponto, hora) do update set livre_min_bytes = 20;

  perform app.job_agent_alerts();
  select count(*)::integer into v_antes from public.email_outbox where kind = 'agent_alert';
  perform app.assert(v_antes > 0, 'o alerta aberto enfileira aviso para gestores e admins');

  perform app.job_agent_alerts();
  perform app.job_agent_alerts();
  perform app.assert(
    (select count(*) from public.email_outbox where kind = 'agent_alert') = v_antes,
    'rodar o trabalho três vezes NÃO manda o aviso de novo');

  perform app.assert(
    (select notificado_em from public.agent_alerts
      where device_id = v_dev and chave = 'E:' and fechado_em is null) is not null,
    'e o alerta fica marcado como notificado, visível na própria tabela');

  -- Solicitante não recebe alerta de infraestrutura: não é trabalho dele.
  perform app.assert(
    not exists (
      select 1 from public.email_outbox o
       join public.profiles p on p.email = o.to_email and p.tenant_id = o.tenant_id
      where o.kind = 'agent_alert' and p.role = 'solicitante'),
    'solicitante NÃO recebe alerta de infraestrutura');
end
$$;

-- -----------------------------------------------------------------------------
-- 36.10 Quem pediu silêncio não recebe
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_dev  uuid;
  v_user uuid := '22220000-0000-4000-8000-000000000002';  -- gestor de TI
begin
  delete from public.agent_alerts;
  delete from public.email_outbox;
  delete from public.notification_preferences where user_id = v_user;
  select id into v_dev from public.agent_devices
   where device_uuid = '77770000-0000-4000-8000-000000000070';

  insert into public.notification_preferences (tenant_id, user_id, kind, enabled)
  values (v_t, v_user, 'agent_alert', false);

  insert into public.agent_volume_samples (tenant_id, device_id, ponto, hora, total_bytes, livre_min_bytes)
  values (v_t, v_dev, 'F:', date_trunc('hour', now()), 1000, 10)
  on conflict (device_id, ponto, hora) do update set livre_min_bytes = 10;
  perform app.job_agent_alerts();

  perform app.assert(
    not exists (
      select 1 from public.email_outbox o
       join public.profiles p on p.id = v_user
      where o.kind = 'agent_alert' and o.to_email = p.email),
    'quem desligou o aviso de alerta não recebe');
  perform app.assert(
    exists (select 1 from public.email_outbox where kind = 'agent_alert'),
    'mas os outros continuam recebendo: o silêncio é de uma pessoa, não do sistema');

  delete from public.notification_preferences where user_id = v_user;
end
$$;

-- -----------------------------------------------------------------------------
-- 36.11 Retenção
-- -----------------------------------------------------------------------------
-- Sem isto, `agent_metrics_raw` cresce para sempre. Um recurso que enche o disco
-- do servidor em silêncio é pior que um recurso que não existe.
do $$
declare
  v_t   uuid := 'a0000000-0000-4000-8000-000000000001';
  v_dev uuid;
begin
  select id into v_dev from public.agent_devices
   where device_uuid = '77770000-0000-4000-8000-000000000070';

  insert into public.agent_metrics_raw (tenant_id, device_id, collected_at, cpu_percent)
  values (v_t, v_dev, now() - interval '30 days', 10),
         (v_t, v_dev, now() - interval '2 days', 10)
  on conflict do nothing;

  insert into public.agent_metrics_hourly (tenant_id, device_id, hora, cpu_avg, cpu_max)
  values (v_t, v_dev, date_trunc('hour', now() - interval '400 days'), 10, 10),
         (v_t, v_dev, date_trunc('hour', now() - interval '30 days'), 10, 10)
  on conflict do nothing;

  perform app.job_purge_metrics();

  perform app.assert(
    not exists (select 1 from public.agent_metrics_raw
                 where device_id = v_dev and collected_at < now() - interval '8 days'),
    'o detalhe com mais de 7 dias (o padrão do tenant) é apagado');
  perform app.assert(
    exists (select 1 from public.agent_metrics_raw
             where device_id = v_dev and collected_at > now() - interval '3 days'),
    'e o recente fica');

  perform app.assert(
    not exists (select 1 from public.agent_metrics_hourly
                 where device_id = v_dev and hora < now() - interval '366 days'),
    'o agregado com mais de um ano é apagado');
  perform app.assert(
    exists (select 1 from public.agent_metrics_hourly
             where device_id = v_dev and hora > now() - interval '60 days'),
    'mas o de 30 dias fica: o agregado vive MUITO mais que o detalhe, porque responde outra pergunta');
end
$$;

-- -----------------------------------------------------------------------------
-- 36.12 A frota ganhou saúde, e o limiar passou a vir do tenant
-- -----------------------------------------------------------------------------
do $$
declare
  v_t   uuid := 'a0000000-0000-4000-8000-000000000001';
  v_dev uuid;
begin
  select id into v_dev from public.agent_devices
   where device_uuid = '77770000-0000-4000-8000-000000000070';
  update public.agent_devices set last_seen_at = now() - interval '10 hours' where id = v_dev;

  update public.tenants set agent_mute_hours = 24 where id = v_t;
  perform app.assert(
    (select silencioso from public.vw_agent_fleet where device_id = v_dev) = false,
    'com limiar de 24 h, dez horas de silêncio ainda não é "mudo"');

  update public.tenants set agent_mute_hours = 6 where id = v_t;
  perform app.assert(
    (select silencioso from public.vw_agent_fleet where device_id = v_dev) = true,
    'baixar o limiar do tenant para 6 h muda a resposta da view — o número mora num lugar só');
  update public.tenants set agent_mute_hours = 24 where id = v_t;

  perform app.assert(
    (select alertas_abertos from public.vw_agent_fleet where device_id = v_dev) >= 1,
    'a view traz a contagem de alertas abertos da máquina');
  perform app.assert(
    (select disco_mais_cheio_pct from public.vw_agent_fleet where device_id = v_dev) >= 90,
    'e o volume MAIS APERTADO — mostrar "o disco" sem dizer qual esconderia justamente o cheio');
end
$$;

-- -----------------------------------------------------------------------------
-- 36.13 Software visto de cima
-- -----------------------------------------------------------------------------
do $$
declare
  v_t uuid := 'a0000000-0000-4000-8000-000000000001';
begin
  perform app.assert(
    (select maquinas from public.vw_agent_software
      where tenant_id = v_t and name = 'Google Chrome') >= 1,
    'a view agrega o software pela frota');
  perform app.assert(
    (select versoes from public.vw_agent_software
      where tenant_id = v_t and name = 'Google Chrome') = 2,
    'contando versões distintas: é assim que se responde "quem ainda tem a versão antiga?"');
  perform app.assert(
    exists (select 1 from public.vw_agent_software
             where tenant_id = v_t and name = '7-Zip'),
    'e o desinstalado continua na lista, com a data em que foi visto pela última vez');
end
$$;

-- -----------------------------------------------------------------------------
-- 36.14 Acesso remoto: integração, não implementação
-- -----------------------------------------------------------------------------
do $$
declare
  v_t   uuid := 'a0000000-0000-4000-8000-000000000001';
  v_tok text;
  v_dev uuid;
begin
  select device_token into v_tok from public.agent_enroll('inv_aberto',
    jsonb_build_object('device_uuid', '77770000-0000-4000-8000-000000000070'));
  select id into v_dev from public.agent_devices
   where device_uuid = '77770000-0000-4000-8000-000000000070';

  perform app.assert(public.agent_set_remote_id(v_tok, '123456789'),
    'a máquina registra o próprio id no serviço de acesso remoto');
  perform app.assert(
    (select remote_id from public.agent_devices where id = v_dev) = '123456789',
    'e ele fica gravado');
  perform app.assert(not public.agent_set_remote_id('ag_inventado', '999'),
    'token que não vale não grava nada');

  -- O modelo de endereço exige {id}: um modelo sem ele geraria um link igual
  -- para as 200 máquinas, abrindo sempre a mesma.
  begin
    update public.tenants set agent_remote_url = 'https://mesh.exemplo.com/' where id = v_t;
    perform app.assert(false, 'modelo de endereço sem {id} tinha de ser recusado');
  exception when check_violation then
    perform app.assert(true, 'modelo de acesso remoto sem {id} é recusado pelo banco');
  end;

  update public.tenants set agent_remote_url = 'rustdesk://{id}' where id = v_t;
  perform app.assert(
    (select agent_remote_url from public.tenants where id = v_t) like '%{id}%',
    'e com {id} é aceito');
  update public.tenants set agent_remote_url = null where id = v_t;
end
$$;

-- -----------------------------------------------------------------------------
-- 36.15 Quem executa, e quem enxerga
-- -----------------------------------------------------------------------------
do $$
begin
  perform app.assert(
    has_function_privilege('anon', 'public.agent_ingest_metrics(text, jsonb)', 'execute'),
    'a máquina manda métrica sem ter conta — ela é um serviço');
  perform app.assert(
    has_function_privilege('anon', 'public.agent_set_remote_id(text, text)', 'execute'),
    'e registra o id de acesso remoto');

  perform app.assert(
    not has_function_privilege('authenticated', 'app.job_agent_alerts()', 'execute'),
    'mas o trabalho de alerta ninguém logado dispara');
  perform app.assert(
    not has_function_privilege('authenticated', 'app.job_purge_metrics()', 'execute'),
    'nem o de purga — ele APAGA dado');
  perform app.assert(
    has_function_privilege('service_role', 'app.job_purge_metrics()', 'execute'),
    'só service_role, pelo terceiro uso declarado no ADR-011');
end
$$;

-- Isolamento entre tenants e por permissão.
set role rls_tester;
set request.jwt.claims = '{"sub":"33330000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
begin
  perform app.assert((select count(*) from public.agent_metrics_raw) = 0,
    'tenant 2 não vê métrica do tenant 1');
  perform app.assert((select count(*) from public.agent_metrics_hourly) = 0,
    'nem o agregado');
  perform app.assert((select count(*) from public.agent_volume_samples) = 0,
    'nem o disco');
  perform app.assert((select count(*) from public.agent_alerts) = 0,
    'nem os alertas');
  perform app.assert((select count(*) from public.vw_agent_software) = 0,
    'nem o software agregado');
end
$$;

-- Diego Moreira é operador financeiro: não tem `inventario.agentes.ver`.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert((select count(*) from public.agent_alerts) = 0,
    'quem não tem a permissão da tela não vê alerta, mesmo no próprio tenant');
  perform app.assert((select count(*) from public.agent_metrics_hourly) = 0,
    'nem as métricas');
end
$$;

-- Ana Souza é operadora de TI: vê os alertas, e não fecha nenhum.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
declare
  v_id uuid;
  v_n  integer;
begin
  perform app.assert((select count(*) from public.agent_alerts) > 0,
    'operador de TI enxerga os alertas');

  select id into v_id from public.agent_alerts where fechado_em is null limit 1;
  update public.agent_alerts set fechado_em = now() where id = v_id;
  get diagnostics v_n = row_count;
  perform app.assert(v_n = 0,
    'e não fecha alerta à mão: a negação do RLS chega como zero linhas, não como erro');
end
$$;
reset role;

\echo ''
\echo '################  TODOS OS TESTES PASSARAM  ################'
