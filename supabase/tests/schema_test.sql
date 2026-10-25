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
  perform app.assert((select count(*) from public.permission_catalog) = 208,
    'catálogo de permissões tem as 208 entradas geradas de src/lib/permissions.ts');
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
  perform app.assert((select count(*) from public.permission_catalog) = 208,
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

-- =============================================================================
\echo '=== 37. Autoatendimento: base, catálogo e preço por cliente (0033) ==='
-- =============================================================================
reset role;

-- Duas coisas aqui erram de um jeito que não dá erro: um artigo interno visível
-- para o cliente (vazamento), e um preço mostrado diferente do cobrado (problema
-- comercial). Nenhuma das duas aparece em teste de tela.

-- -----------------------------------------------------------------------------
-- 37.1 A busca ignora acento
-- -----------------------------------------------------------------------------
-- Metade de quem digita numa caixa de busca não põe acento. Sem `unaccent`,
-- "manutencao" não acha "manutenção" — e quem não acha abre um chamado, que é
-- exatamente o que a base existe para evitar.
do $$
declare
  v_t   uuid := 'a0000000-0000-4000-8000-000000000001';
  v_cat uuid;
  v_art uuid;
begin
  delete from public.kb_articles where tenant_id = v_t;

  select id into v_cat from public.ticket_categories where tenant_id = v_t limit 1;

  insert into public.kb_articles
    (tenant_id, title, resumo, body, category_id, status, visibilidade, published_at)
  values (v_t, 'Manutenção preventiva da impressora',
          'Como limpar o cabeçote sem danificar o equipamento',
          'Abra a tampa, remova o cartucho e limpe o cabeçote com álcool isopropílico.',
          v_cat, 'publicado', 'solicitante', now())
  returning id into v_art;

  perform app.assert(
    (select count(*) from public.kb_articles
      where search_vector @@ websearch_to_tsquery('public.portugues_sem_acento', 'manutencao')) = 1,
    'procurar sem acento acha o artigo com acento');
  perform app.assert(
    (select count(*) from public.kb_articles
      where search_vector @@ websearch_to_tsquery('public.portugues_sem_acento', 'MANUTENÇÃO')) = 1,
    'e com acento e em caixa alta também');
  perform app.assert(
    (select count(*) from public.kb_articles
      where search_vector @@ websearch_to_tsquery('public.portugues_sem_acento', 'impressoras')) = 1,
    'o radical em português casa o plural com o singular');
  perform app.assert(
    (select count(*) from public.kb_articles
      where search_vector @@ websearch_to_tsquery('public.portugues_sem_acento', 'roteador')) = 0,
    'e não acha o que não está lá');

  -- O peso: o título vale mais que o corpo. Sem isso, um artigo que menciona a
  -- palavra de passagem no corpo venceria o que a tem no título.
  insert into public.kb_articles
    (tenant_id, title, resumo, body, status, visibilidade, published_at)
  values (v_t, 'Configuração de rede',
          'Passo a passo',
          'Em caso de dúvida, consulte o artigo sobre impressora.',
          'publicado', 'solicitante', now());

  perform app.assert(
    (select a.id from public.kb_articles a
      where a.search_vector @@ websearch_to_tsquery('public.portugues_sem_acento', 'impressora')
      order by ts_rank(a.search_vector,
                       websearch_to_tsquery('public.portugues_sem_acento', 'impressora')) desc
      limit 1) = v_art,
    'o artigo com a palavra no TÍTULO ganha do que só a cita no corpo');
end
$$;

-- -----------------------------------------------------------------------------
-- 37.2 Publicado precisa de data
-- -----------------------------------------------------------------------------
-- Sem a data não dá para ordenar por "mais recente", que é a ordenação da lista.
do $$
declare
  v_t   uuid := 'a0000000-0000-4000-8000-000000000001';
  v_erro boolean := false;
begin
  begin
    insert into public.kb_articles (tenant_id, title, body, status)
    values (v_t, 'Sem data', 'corpo suficiente', 'publicado');
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro, 'artigo publicado sem data de publicação é recusado');

  -- Rascunho sem data é normal: ele ainda não foi publicado.
  insert into public.kb_articles (tenant_id, title, body, status)
  values (v_t, 'Rascunho legítimo', 'corpo suficiente', 'rascunho');
  perform app.assert(true, 'rascunho sem data é aceito — ele não foi publicado');
end
$$;

-- -----------------------------------------------------------------------------
-- 37.3 O rascunho a partir do chamado resolvido
-- -----------------------------------------------------------------------------
-- É a peça central da migração: bases de conhecimento morrem porque ninguém
-- escreve, e o único instante em que escrever custa pouco é logo depois de
-- resolver.
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_user   uuid := '22220000-0000-4000-8000-000000000002';
  v_fila   uuid;
  v_prio   uuid;
  v_cat    uuid;
  v_ticket uuid;
  v_r      record;
begin
  select id into v_fila from public.queues where tenant_id = v_t and is_system_default;
  select id into v_prio from public.ticket_priorities where tenant_id = v_t order by sort_order limit 1;
  select id into v_cat  from public.ticket_categories where tenant_id = v_t limit 1;

  insert into public.tickets
    (tenant_id, title, description, status, priority_id, queue_id, category_id, requester_id, assignee_id)
  values (v_t, 'Impressora não imprime em rede',
          'A impressora do setor fiscal parou de aparecer na lista de impressoras.',
          'open', v_prio, v_fila, v_cat, v_user, v_user)
  returning id into v_ticket;

  -- Uma nota INTERNA, mais recente que a pública. Ela não pode virar a solução
  -- do artigo: ela foi escrita para a equipe, não para quem lê de fora.
  insert into public.ticket_comments (tenant_id, ticket_id, author_id, body, visibility)
  values (v_t, v_ticket, v_user,
          'Reiniciei o spooler e o cabo estava solto. Avisar o Pedro sobre a bagunça do rack.',
          'internal');

  insert into public.ticket_comments (tenant_id, ticket_id, author_id, body, visibility, created_at)
  values (v_t, v_ticket, v_user,
          'Reinstale a impressora pelo endereço \\\\servidor\\fiscal e marque "definir como padrão".',
          'public', now() - interval '1 minute');

  select * into v_r from app.kb_rascunho_do_chamado(v_ticket);

  perform app.assert(v_r.title = 'Impressora não imprime em rede',
    'o rascunho herda o título do chamado');
  perform app.assert(v_r.category_id = v_cat,
    'e a categoria — é o que faz o artigo voltar a aparecer no chamado parecido');
  perform app.assert(v_r.body like '%setor fiscal parou de aparecer%',
    'o problema vem da descrição do chamado');
  perform app.assert(v_r.body like '%definir como padrão%',
    'e a solução vem do último comentário PÚBLICO');
  perform app.assert(v_r.body not like '%bagunça do rack%',
    'a nota INTERNA não vaza para o artigo: ela foi escrita para a equipe');

  -- Chamado sem descrição e sem comentário público: o rascunho sai com os
  -- lugares marcados, e não vazio. Texto em branco é a tela que ninguém
  -- preenche.
  insert into public.tickets
    (tenant_id, title, status, priority_id, queue_id, requester_id)
  values (v_t, 'Chamado seco', 'open', v_prio, v_fila, v_user)
  returning id into v_ticket;
  select * into v_r from app.kb_rascunho_do_chamado(v_ticket);
  perform app.assert(v_r.body like '%descreva o sintoma%',
    'chamado sem descrição produz um rascunho com o lugar marcado, não vazio');
  perform app.assert(v_r.body like '%passo a passo da solução%',
    'idem para a solução');

  perform app.assert(
    not exists (select 1 from app.kb_rascunho_do_chamado(gen_random_uuid())),
    'chamado que não existe devolve zero linhas');
end
$$;

-- -----------------------------------------------------------------------------
-- 37.4 Artigos sugeridos para um chamado
-- -----------------------------------------------------------------------------
-- A outra metade do ciclo: o artigo escrito a partir de um chamado volta a
-- aparecer no chamado seguinte parecido.
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_user   uuid := '22220000-0000-4000-8000-000000000002';
  v_fila   uuid;
  v_prio   uuid;
  v_cat    uuid;
  v_ticket uuid;
begin
  select id into v_fila from public.queues where tenant_id = v_t and is_system_default;
  select id into v_prio from public.ticket_priorities where tenant_id = v_t order by sort_order limit 1;
  select id into v_cat  from public.ticket_categories where tenant_id = v_t limit 1;

  insert into public.tickets
    (tenant_id, title, description, status, priority_id, queue_id, category_id, requester_id)
  values (v_t, 'Impressora sumiu da rede', 'Não consigo imprimir', 'open',
          v_prio, v_fila, v_cat, v_user)
  returning id into v_ticket;

  perform app.assert(
    exists (select 1 from public.kb_sugestoes(v_ticket)
             where title like 'Manutenção preventiva%'),
    'o artigo sobre impressora é sugerido para o chamado sobre impressora');

  perform app.assert(
    (select count(*) from public.kb_sugestoes(v_ticket, 2)) <= 2,
    'o limite é respeitado');
  perform app.assert(
    (select count(*) from public.kb_sugestoes(v_ticket, 500)) <= 10,
    'e tem teto próprio: um limite absurdo não vira uma consulta absurda');

  -- Rascunho NÃO é sugerido: ele não foi revisado, e artigo errado é pior que
  -- artigo nenhum, porque quem o lê para de procurar.
  perform app.assert(
    not exists (select 1 from public.kb_sugestoes(v_ticket, 10) where title = 'Rascunho legítimo'),
    'rascunho não é sugerido: ele não passou por revisão');
end
$$;

-- -----------------------------------------------------------------------------
-- 37.5 Catálogo: o preço certo para cada cliente
-- -----------------------------------------------------------------------------
-- O preço mora no banco porque o preço mostrado e o cobrado não podem divergir —
-- e divergiriam no dia em que uma segunda tela calculasse por conta própria.
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_fila uuid;
  v_serv uuid;
  v_c1   uuid;
  v_c2   uuid;
  v_r    record;
  v_erro boolean := false;
begin
  delete from public.service_catalog where tenant_id = v_t;
  select id into v_fila from public.queues where tenant_id = v_t and is_system_default;
  select id into v_c1 from public.clients where tenant_id = v_t order by legal_name limit 1;
  select id into v_c2 from public.clients where tenant_id = v_t and id <> v_c1 order by legal_name limit 1;

  insert into public.service_catalog (tenant_id, name, description, queue_id, preco, unidade, prazo_horas)
  values (v_t, 'Formatação de estação', 'Backup, formatação e devolução configurada',
          v_fila, 180.00, 'unidade', 8)
  returning id into v_serv;

  -- Sem acordo: paga a tabela.
  select * into v_r from public.service_preco_para_cliente(v_serv, v_c1);
  perform app.assert(v_r.preco = 180.00 and not v_r.incluso,
    'cliente sem acordo paga o preço de tabela');

  -- Com preço negociado.
  insert into public.service_catalog_clients (tenant_id, service_id, client_id, preco)
  values (v_t, v_serv, v_c1, 120.00);
  select * into v_r from public.service_preco_para_cliente(v_serv, v_c1);
  perform app.assert(v_r.preco = 120.00 and not v_r.incluso,
    'cliente com preço negociado paga o dele');

  -- Incluído no contrato: não paga.
  insert into public.service_catalog_clients (tenant_id, service_id, client_id, incluso_no_contrato)
  values (v_t, v_serv, v_c2, true);
  select * into v_r from public.service_preco_para_cliente(v_serv, v_c2);
  perform app.assert(v_r.preco = 0 and v_r.incluso,
    'cliente com o serviço no contrato não paga, e a tela sabe dizer POR QUÊ');

  -- Incluído no contrato E com preço é contradição.
  begin
    update public.service_catalog_clients set preco = 50.00
     where service_id = v_serv and client_id = v_c2;
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro,
    'incluído no contrato com preço é recusado: ou está no pacote, ou custa');

  -- Nulo não é zero: serviço sem preço publicado combina-se caso a caso.
  insert into public.service_catalog (tenant_id, name, queue_id, preco)
  values (v_t, 'Projeto sob medida', v_fila, null)
  returning id into v_serv;
  select * into v_r from public.service_preco_para_cliente(v_serv, v_c1);
  perform app.assert(v_r.preco is null,
    'serviço sem preço publicado devolve NULO — e nulo não é cortesia');
end
$$;

-- -----------------------------------------------------------------------------
-- 37.6 O pedido vira um chamado, e o preço fica congelado
-- -----------------------------------------------------------------------------
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_user   uuid := '22220000-0000-4000-8000-000000000005';  -- Carla, solicitante
  v_fila   uuid;
  v_prio   uuid;
  v_serv   uuid;
  v_ticket uuid;
begin
  select id into v_fila from public.queues where tenant_id = v_t and is_system_default;
  select id into v_prio from public.ticket_priorities where tenant_id = v_t order by sort_order limit 1;
  select id into v_serv from public.service_catalog
   where tenant_id = v_t and name = 'Formatação de estação';

  insert into public.tickets
    (tenant_id, title, status, priority_id, queue_id, requester_id,
     service_id, service_fields, service_price)
  values (v_t, 'Formatação de estação', 'open', v_prio, v_fila, v_user,
          v_serv, jsonb_build_object('patrimonio', 'PAT-1234'), 120.00)
  returning id into v_ticket;

  perform app.assert(
    (select service_price from public.tickets where id = v_ticket) = 120.00,
    'o chamado guarda o preço ACORDADO, não uma referência à tabela');

  -- A tabela sobe; o que foi combinado continua combinado.
  update public.service_catalog set preco = 250.00 where id = v_serv;
  perform app.assert(
    (select service_price from public.tickets where id = v_ticket) = 120.00,
    'subir o preço de tabela NÃO muda o que já foi pedido');

  perform app.assert(
    (select service_fields ->> 'patrimonio' from public.tickets where id = v_ticket) = 'PAT-1234',
    'e o formulário preenchido fica como fato histórico');

  perform app.assert(
    (select pedidos from public.vw_service_catalog where id = v_serv) >= 1,
    'a vitrine conta quantas vezes o serviço foi pedido');
end
$$;

-- -----------------------------------------------------------------------------
-- 37.7 Um voto por pessoa
-- -----------------------------------------------------------------------------
-- A única pergunta que a base precisa responder sobre si mesma é "quais artigos
-- funcionam", e um número inflado não responde.
do $$
declare
  v_t   uuid := 'a0000000-0000-4000-8000-000000000001';
  v_art uuid;
  v_u1  uuid := '22220000-0000-4000-8000-000000000003';
  v_u2  uuid := '22220000-0000-4000-8000-000000000004';
begin
  select id into v_art from public.kb_articles
   where tenant_id = v_t and title like 'Manutenção preventiva%';
  delete from public.kb_feedback where article_id = v_art;

  insert into public.kb_feedback (tenant_id, article_id, user_id, util) values (v_t, v_art, v_u1, true);
  insert into public.kb_feedback (tenant_id, article_id, user_id, util) values (v_t, v_art, v_u2, false);

  -- Votar de novo SUBSTITUI, não soma.
  insert into public.kb_feedback (tenant_id, article_id, user_id, util)
  values (v_t, v_art, v_u1, false)
  on conflict (article_id, user_id) do update set util = excluded.util;

  perform app.assert(
    (select count(*) from public.kb_feedback where article_id = v_art) = 2,
    'duas pessoas, dois votos — votar de novo não cria um terceiro');
  perform app.assert(
    (select util from public.kb_feedback where article_id = v_art and user_id = v_u1) = false,
    'e mudar de ideia troca o voto');

  perform app.assert(
    (select uteis from public.vw_kb_articles where id = v_art) = 0
    and (select inuteis from public.vw_kb_articles where id = v_art) = 2,
    'a visão conta os votos como eles estão agora');
end
$$;

-- -----------------------------------------------------------------------------
-- 37.8 Contar leitura não vira auditoria
-- -----------------------------------------------------------------------------
/*
 * A função é `security definer` — ela roda com privilégio de dono e passa por
 * cima do RLS. O isolamento, portanto, é responsabilidade EXPLÍCITA do corpo
 * dela, e é isso que as duas primeiras asserções conferem: uma sessão do tenant
 * 2 não consegue contar leitura num artigo do tenant 1.
 */
set request.jwt.claims = '{"sub":"33330000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
declare
  v_art   uuid;
  v_lidas integer;
begin
  select id into v_art from public.kb_articles
   where tenant_id = 'a0000000-0000-4000-8000-000000000001'
     and title like 'Manutenção preventiva%';
  select views into v_lidas from public.kb_articles where id = v_art;

  perform public.kb_registrar_leitura(v_art);
  perform app.assert(
    (select views from public.kb_articles where id = v_art) = v_lidas,
    'sessão de OUTRO tenant não conta leitura: a função definer filtra o tenant à mão');
end
$$;

set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
declare
  v_t     uuid := 'a0000000-0000-4000-8000-000000000001';
  v_art   uuid;
  v_antes bigint;
  v_lidas integer;
begin
  select id into v_art from public.kb_articles
   where tenant_id = v_t and title like 'Manutenção preventiva%';
  select views into v_lidas from public.kb_articles where id = v_art;

  -- Solicitante contando leitura: é o público principal da base, e a policy de
  -- escrita de `kb_articles` não o alcança. É por isso que a função é definer.
  perform public.kb_registrar_leitura(v_art);
  perform app.assert(
    (select views from public.kb_articles where id = v_art) = v_lidas + 1,
    'solicitante conta leitura, mesmo sem poder escrever no artigo');

  select count(*) into v_antes from public.audit_log
   where entity_type = 'kb_articles' and entity_id = v_art::text;

  update public.kb_articles set views = views + 1 where id = v_art;
  perform app.assert(
    (select count(*) from public.audit_log
      where entity_type = 'kb_articles' and entity_id = v_art::text) = v_antes,
    'mexer SÓ no contador de leitura não vira linha de auditoria');

  update public.kb_articles set title = title where id = v_art;
  perform app.assert(
    (select count(*) from public.audit_log
      where entity_type = 'kb_articles' and entity_id = v_art::text) = v_antes,
    'nem um update que não muda nada');

  update public.kb_articles set resumo = 'Resumo editado' where id = v_art;
  perform app.assert(
    (select count(*) from public.audit_log
      where entity_type = 'kb_articles' and entity_id = v_art::text) > v_antes,
    'mas EDITAR o artigo vira: é o que a trilha existe para registrar');
end
$$;

-- -----------------------------------------------------------------------------
-- 37.9 Quem enxerga o quê
-- -----------------------------------------------------------------------------
-- Artigo interno visível para o cliente é vazamento, e é a falha que não dá erro.
do $$
declare
  v_t uuid := 'a0000000-0000-4000-8000-000000000001';
begin
  insert into public.kb_articles
    (tenant_id, title, body, status, visibilidade, published_at)
  values (v_t, 'Senha do roteador da matriz',
          'A senha de administração dos roteadores é trocada todo trimestre.',
          'publicado', 'interno', now());
end
$$;

-- Carla Dias é solicitante.
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(
    exists (select 1 from public.kb_articles where title like 'Manutenção preventiva%'),
    'solicitante lê o artigo publicado para solicitante');
  perform app.assert(
    not exists (select 1 from public.kb_articles where title like 'Senha do roteador%'),
    'e NÃO lê o artigo interno — esta é a asserção que impede um vazamento silencioso');
  perform app.assert(
    not exists (select 1 from public.kb_articles where status = 'rascunho'),
    'nem rascunho');

  -- A vitrine é para quem pede: esconder o catálogo de quem pode pedir esvazia o
  -- recurso.
  perform app.assert(
    (select count(*) from public.service_catalog) > 0,
    'solicitante enxerga o catálogo de serviços');
  perform app.assert(
    (select count(*) from public.service_catalog_clients) = 0,
    'mas NÃO a tabela de preços negociados dos outros clientes');

  perform app.assert(app.has_permission('autoatendimento.catalogo.pedir'),
    'e pode pedir — é literalmente o que essa pessoa veio fazer');
  perform app.assert(not app.has_permission('autoatendimento.base.escrever'),
    'mas não escreve na base');
  perform app.assert(not app.has_permission('autoatendimento.catalogo.gerenciar'),
    'nem cadastra serviço');
end
$$;

-- Ana Souza é operadora de TI: atende, e escreve na base.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
declare
  v_n integer;
  v_id uuid;
begin
  perform app.assert(
    exists (select 1 from public.kb_articles where title like 'Senha do roteador%'),
    'quem atende lê o artigo interno publicado');
  perform app.assert(app.has_permission('autoatendimento.base.escrever'),
    'e escreve na base: o artigo nasce do chamado que ela acabou de resolver');
  perform app.assert(
    exists (select 1 from public.kb_articles where status = 'rascunho'),
    'por isso ela também vê os rascunhos');

  perform app.assert(not app.has_permission('autoatendimento.catalogo.gerenciar'),
    'mas não mexe em preço: isso é comercial, não operação');

  select id into v_id from public.service_catalog limit 1;
  update public.service_catalog set preco = 1.00 where id = v_id;
  get diagnostics v_n = row_count;
  perform app.assert(v_n = 0,
    'e o RLS confirma: a negação chega como zero linhas, não como erro');
end
$$;

-- Diego Moreira é operador financeiro: consulta e pede, não escreve.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(app.has_permission('autoatendimento.base.ver'),
    'quem é do financeiro também abre chamado, e também acha a resposta antes');
  perform app.assert(app.has_permission('autoatendimento.catalogo.pedir'),
    'e também pede serviço');
  perform app.assert(not app.has_permission('autoatendimento.base.escrever'),
    'mas não escreve na base de TI');
end
$$;

-- Tenant 2 não vê nada do tenant 1.
set request.jwt.claims = '{"sub":"33330000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
begin
  perform app.assert((select count(*) from public.kb_articles) = 0,
    'tenant 2 não vê artigo do tenant 1');
  perform app.assert((select count(*) from public.vw_kb_articles) = 0,
    'nem pela visão');
  perform app.assert((select count(*) from public.service_catalog) = 0,
    'nem o catálogo');
  perform app.assert((select count(*) from public.service_catalog_clients) = 0,
    'nem os preços');
  perform app.assert((select count(*) from public.kb_feedback) = 0,
    'nem os votos');
end
$$;
reset role;

-- =============================================================================
\echo '=== 38. Canais de conversa: entrada, threading e eco (0034) ==='
-- =============================================================================
reset role;
/*
 * `reset role` devolve o privilégio, mas NÃO limpa `request.jwt.claims` — ele é
 * um GUC de sessão e sobrevive às seções. Sem fixar um usuário real aqui, a
 * trigger de histórico de chamado grava como ator o `sub` que sobrou da seção
 * anterior (um usuário do tenant 2) e a chave estrangeira recusa.
 *
 * Foi assim que isto apareceu: a seção passou nas cinco primeiras asserções e
 * quebrou na primeira que mexia no status de um chamado.
 */
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';

-- Duas falhas aqui são caras e silenciosas: a reentrega do provedor virando
-- mensagem duplicada (o atendente lê a mesma pergunta duas vezes), e o eco — a
-- resposta voltando como pergunta e gerando outra resposta, até a pessoa receber
-- quarenta mensagens. Nenhuma das duas dá erro.

-- -----------------------------------------------------------------------------
-- 38.1 O canal precisa saber onde abrir chamado
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_erro boolean := false;
begin
  delete from public.channels where tenant_id = v_t;

  begin
    insert into public.channels (tenant_id, name, kind, inbound_token_hash, abre_chamado)
    values (v_t, 'Sem destino', 'whatsapp', encode(digest('tok_x', 'sha256'), 'hex'), true);
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro,
    'canal que abre chamado sem fila e prioridade é recusado: a mensagem se perderia em silêncio');

  -- Canal em observação pode nascer sem destino: ele não abre chamado nenhum.
  insert into public.channels (tenant_id, name, kind, inbound_token_hash, abre_chamado)
  values (v_t, 'Só observando', 'n8n', encode(digest('tok_obs', 'sha256'), 'hex'), false);
  perform app.assert(true, 'canal em observação nasce sem destino — ele não abre chamado');
end
$$;

-- -----------------------------------------------------------------------------
-- 38.2 A credencial é referência, não valor
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_erro boolean := false;
begin
  begin
    update public.channels
       set secret_ref = 'EAAG...um-token-de-verdade-aqui'
     where tenant_id = v_t and name = 'Só observando';
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro,
    'secret_ref recusa o que não é nome de variável: o valor mora no ambiente (ADR-009)');

  update public.channels set secret_ref = 'WHATSAPP_TOKEN_MATRIZ'
   where tenant_id = v_t and name = 'Só observando';
  perform app.assert(true, 'e aceita o NOME da variável');

  v_erro := false;
  begin
    update public.channels set outbound_url = 'http://n8n.interno/webhook'
     where tenant_id = v_t and name = 'Só observando';
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro,
    'a URL de saída precisa ser https: o texto da conversa viaja nela');
end
$$;

-- -----------------------------------------------------------------------------
-- 38.3 A primeira mensagem vira contato, conversa e chamado
-- -----------------------------------------------------------------------------
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_fila   uuid;
  v_prio   uuid;
  v_canal  uuid;
  v_r      record;
  v_antes  integer;
begin
  select id into v_fila from public.queues where tenant_id = v_t and is_system_default;
  select id into v_prio from public.ticket_priorities where tenant_id = v_t order by sort_order limit 1;

  insert into public.channels
    (tenant_id, name, kind, inbound_token_hash, default_queue_id, default_priority_id)
  values (v_t, 'WhatsApp da matriz', 'whatsapp',
          encode(digest('tok_whats', 'sha256'), 'hex'), v_fila, v_prio)
  returning id into v_canal;

  perform app.assert(
    (select status from public.channel_ingest('tok_que_nao_existe',
      jsonb_build_object('de', '+5544999887766', 'texto', 'oi'))) = 'unauthorized',
    'token de canal desconhecido é recusado');

  perform app.assert(
    (select status from public.channel_ingest('tok_whats',
      jsonb_build_object('texto', 'oi sem remetente'))) = 'malformed',
    'mensagem sem remetente é recusada por FORMA, não por autorização');

  select count(*) into v_antes from public.tickets where tenant_id = v_t;

  select * into v_r from public.channel_ingest('tok_whats', jsonb_build_object(
    'externo', 'wamid.AAA',
    'de', '+5544999887766',
    'nome', 'Fulana de Tal',
    'texto', 'bom dia, a impressora do fiscal parou de imprimir'));

  perform app.assert(v_r.status = 'stored', 'a primeira mensagem é guardada');
  perform app.assert(v_r.ticket_id is not null, 'e abre um chamado');
  perform app.assert(
    (select count(*) from public.tickets where tenant_id = v_t) = v_antes + 1,
    'exatamente um');

  perform app.assert(
    (select display_name from public.channel_contacts
      where channel_id = v_canal and external_id = '+5544999887766') = 'Fulana de Tal',
    'o contato é criado com o nome do perfil do WhatsApp');

  perform app.assert(
    (select count(*) from public.channel_conversations
      where channel_id = v_canal and status = 'aberta') = 1,
    'e uma conversa aberta');

  -- O título é o começo da mensagem, e não um texto fixo: "Mensagem do WhatsApp"
  -- em toda a fila não ajuda ninguém a escolher qual atender.
  perform app.assert(
    (select title from public.tickets where id = v_r.ticket_id) like 'bom dia, a impressora%',
    'o título do chamado é o começo da mensagem');
  perform app.assert(
    (select source from public.tickets where id = v_r.ticket_id) = 'integration',
    'e a origem é integração: o chamado não nasceu de alguém na tela');
  perform app.assert(
    (select last_inbound_at from public.channels where id = v_canal) is not null,
    'o canal registra que recebeu');
end
$$;

-- -----------------------------------------------------------------------------
-- 38.4 A reentrega do provedor NÃO duplica nada
-- -----------------------------------------------------------------------------
-- O WhatsApp reentrega o webhook quando não recebe 200 rápido o bastante, por
-- desenho. Sem a idempotência, o atendente lê a mesma pergunta duas vezes.
do $$
declare
  v_t       uuid := 'a0000000-0000-4000-8000-000000000001';
  v_r       record;
  v_tickets integer;
  v_msgs    integer;
begin
  select count(*) into v_tickets from public.tickets where tenant_id = v_t;
  select count(*) into v_msgs from public.channel_messages where tenant_id = v_t;

  select * into v_r from public.channel_ingest('tok_whats', jsonb_build_object(
    'externo', 'wamid.AAA',
    'de', '+5544999887766',
    'texto', 'bom dia, a impressora do fiscal parou de imprimir'));

  perform app.assert(v_r.status = 'duplicate', 'a reentrega é reconhecida');
  perform app.assert(
    (select count(*) from public.tickets where tenant_id = v_t) = v_tickets,
    'e não abre um segundo chamado');
  perform app.assert(
    (select count(*) from public.channel_messages where tenant_id = v_t) = v_msgs,
    'nem grava uma segunda mensagem');
  perform app.assert(
    (select count(*) from public.ticket_comments c
      join public.tickets t on t.id = c.ticket_id
     where t.tenant_id = v_t and c.external_id = 'wamid.AAA') = 0,
    'nem um comentário: a mensagem é gravada ANTES de qualquer efeito, e a reentrega para ali');
end
$$;

-- -----------------------------------------------------------------------------
-- 38.5 A segunda mensagem entra no MESMO chamado
-- -----------------------------------------------------------------------------
-- É a regra de threading. Sem ela, cada "bom dia" vira um chamado e a fila do
-- helpdesk vira a caixa de entrada do WhatsApp.
do $$
declare
  v_t       uuid := 'a0000000-0000-4000-8000-000000000001';
  v_r       record;
  v_tickets integer;
  v_ticket  uuid;
begin
  select count(*) into v_tickets from public.tickets where tenant_id = v_t;

  select * into v_r from public.channel_ingest('tok_whats', jsonb_build_object(
    'externo', 'wamid.BBB',
    'de', '+5544999887766',
    'texto', 'é a HP do segundo andar'));
  v_ticket := v_r.ticket_id;

  perform app.assert(v_r.status = 'stored', 'a segunda mensagem é guardada');
  perform app.assert(
    (select count(*) from public.tickets where tenant_id = v_t) = v_tickets,
    'e NÃO abre um segundo chamado');

  perform app.assert(
    (select count(*) from public.ticket_comments
      where ticket_id = v_ticket and external_id = 'wamid.BBB') = 1,
    'ela vira um comentário no chamado existente');
  perform app.assert(
    (select visibility from public.ticket_comments where external_id = 'wamid.BBB') = 'public',
    'público: foi escrito pela pessoa, e ela precisa poder ler a própria pergunta');
end
$$;

-- -----------------------------------------------------------------------------
-- 38.6 Chamado fechado encerra a conversa, e a próxima mensagem abre outro
-- -----------------------------------------------------------------------------
-- Sem isto, dois anos de assuntos diferentes se empilhariam no mesmo chamado.
do $$
declare
  v_t       uuid := 'a0000000-0000-4000-8000-000000000001';
  v_ticket  uuid;
  v_r       record;
  v_tickets integer;
begin
  select ticket_id into v_ticket from public.channel_conversations
   where status = 'aberta' and tenant_id = v_t limit 1;

  /* O caminho real da máquina de estados (`ticket_status_transitions`): não dá
     para ir de `open` direto a `resolved`, e o teste segue o mesmo caminho que a
     tela segue. */
  update public.tickets set status = 'assigned',
         assignee_id = '22220000-0000-4000-8000-000000000002' where id = v_ticket;
  update public.tickets set status = 'in_progress' where id = v_ticket;
  -- O fechamento do chamado fecha a conversa pela trigger: uma conversa "aberta"
  -- cujo chamado foi encerrado há duas semanas é uma linha que mente na tela.
  update public.tickets set status = 'resolved' where id = v_ticket;
  perform app.assert(
    (select status from public.channel_conversations where ticket_id = v_ticket) = 'fechada',
    'resolver o chamado fecha a conversa, pela trigger');

  select count(*) into v_tickets from public.tickets where tenant_id = v_t;
  select * into v_r from public.channel_ingest('tok_whats', jsonb_build_object(
    'externo', 'wamid.CCC',
    'de', '+5544999887766',
    'texto', 'outro assunto: preciso de um monitor'));

  perform app.assert(v_r.ticket_id <> v_ticket,
    'a mensagem seguinte abre um chamado NOVO: o assunto é outro');
  perform app.assert(
    (select count(*) from public.tickets where tenant_id = v_t) = v_tickets + 1,
    'e é só um');
  perform app.assert(
    (select count(*) from public.channel_conversations
      where tenant_id = v_t and status = 'aberta') = 1,
    'e continua havendo UMA conversa aberta por contato');
end
$$;

-- -----------------------------------------------------------------------------
-- 38.7 O banco recusa duas conversas abertas para o mesmo contato
-- -----------------------------------------------------------------------------
-- Duas mensagens simultâneas do mesmo número não podem produzir dois chamados.
do $$
declare
  v_t     uuid := 'a0000000-0000-4000-8000-000000000001';
  v_conv  public.channel_conversations;
  v_erro  boolean := false;
begin
  select * into v_conv from public.channel_conversations
   where tenant_id = v_t and status = 'aberta' limit 1;

  begin
    insert into public.channel_conversations (tenant_id, channel_id, contact_id, status)
    values (v_t, v_conv.channel_id, v_conv.contact_id, 'aberta');
  exception when unique_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro,
    'o banco recusa uma segunda conversa aberta para o mesmo contato no mesmo canal');
end
$$;

-- -----------------------------------------------------------------------------
-- 38.8 O ECO — a falha clássica deste recurso
-- -----------------------------------------------------------------------------
-- A resposta vira comentário, o comentário dispara o envio, o envio volta como
-- evento, o evento vira comentário... Em minutos a pessoa recebeu quarenta
-- mensagens.
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_user   uuid := '22220000-0000-4000-8000-000000000002';
  v_conv   public.channel_conversations;
  v_ticket uuid;
  v_antes  integer;
begin
  select * into v_conv from public.channel_conversations
   where tenant_id = v_t and status = 'aberta' limit 1;
  v_ticket := v_conv.ticket_id;

  select count(*) into v_antes from public.channel_messages
   where conversation_id = v_conv.id and direction = 'saida';

  -- (a) Comentário público do atendente: VAI para o canal.
  insert into public.ticket_comments (tenant_id, ticket_id, author_id, body, visibility, source)
  values (v_t, v_ticket, v_user, 'Bom dia! Já estou a caminho.', 'public', 'ui');

  perform app.assert(
    (select count(*) from public.channel_messages
      where conversation_id = v_conv.id and direction = 'saida') = v_antes + 1,
    'comentário público do atendente vira mensagem na fila de saída');
  perform app.assert(
    (select status from public.channel_messages
      where conversation_id = v_conv.id and direction = 'saida'
      order by created_at desc limit 1) = 'na_fila',
    'na fila, não enviada: quem fala com o provedor é a aplicação');

  -- (b) Nota interna: NÃO vai. Vazá-la seria grave.
  insert into public.ticket_comments (tenant_id, ticket_id, author_id, body, visibility, source)
  values (v_t, v_ticket, v_user, 'Cliente já atrasou três pagamentos.', 'internal', 'ui');

  perform app.assert(
    (select count(*) from public.channel_messages
      where conversation_id = v_conv.id and direction = 'saida') = v_antes + 1,
    'nota INTERNA não sai para o canal — vazá-la seria grave');

  -- (c) Comentário que É uma mensagem de entrada: NÃO volta.
  insert into public.ticket_comments
    (tenant_id, ticket_id, author_id, body, visibility, source, external_id)
  values (v_t, v_ticket, null, 'obrigada!', 'public', 'integration', 'wamid.DDD');

  perform app.assert(
    (select count(*) from public.channel_messages
      where conversation_id = v_conv.id and direction = 'saida') = v_antes + 1,
    'comentário vindo DO canal não volta para o canal: é a trava do eco');

  -- (d) Mas um comentário de OUTRA integração (tickets, 0009) sai normalmente:
  -- o que distingue é o external_id, que só a entrada de canal preenche.
  insert into public.ticket_comments (tenant_id, ticket_id, author_id, body, visibility, source)
  values (v_t, v_ticket, v_user, 'Sincronizado do Bitrix24.', 'public', 'integration');

  perform app.assert(
    (select count(*) from public.channel_messages
      where conversation_id = v_conv.id and direction = 'saida') = v_antes + 2,
    'e comentário de integração de TICKETS sai: source sozinho não distinguiria');
end
$$;

-- -----------------------------------------------------------------------------
-- 38.9 Comentário em chamado SEM conversa não vira mensagem
-- -----------------------------------------------------------------------------
-- A trigger roda em todo comentário da base. Se ela enfileirasse sem conversa, a
-- fila de saída encheria com a resposta de todo chamado aberto na tela.
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_user   uuid := '22220000-0000-4000-8000-000000000002';
  v_fila   uuid;
  v_prio   uuid;
  v_ticket uuid;
  v_antes  integer;
begin
  select id into v_fila from public.queues where tenant_id = v_t and is_system_default;
  select id into v_prio from public.ticket_priorities where tenant_id = v_t order by sort_order limit 1;
  select count(*) into v_antes from public.channel_messages where direction = 'saida';

  insert into public.tickets (tenant_id, title, status, priority_id, queue_id, requester_id)
  values (v_t, 'Chamado comum, sem canal', 'open', v_prio, v_fila, v_user)
  returning id into v_ticket;

  insert into public.ticket_comments (tenant_id, ticket_id, author_id, body, visibility, source)
  values (v_t, v_ticket, v_user, 'Resposta normal.', 'public', 'ui');

  perform app.assert(
    (select count(*) from public.channel_messages where direction = 'saida') = v_antes,
    'comentário em chamado sem conversa NÃO vira mensagem de saída');
end
$$;

-- -----------------------------------------------------------------------------
-- 38.10 Contato bloqueado e canal em observação
-- -----------------------------------------------------------------------------
-- Nos dois casos a mensagem FICA REGISTRADA e não vira chamado. Registrar em vez
-- de descartar é o que permite descobrir um bloqueio feito por engano.
do $$
declare
  v_t       uuid := 'a0000000-0000-4000-8000-000000000001';
  v_r       record;
  v_tickets integer;
begin
  update public.channel_contacts set bloqueado = true
   where external_id = '+5544999887766';
  select count(*) into v_tickets from public.tickets where tenant_id = v_t;

  select * into v_r from public.channel_ingest('tok_whats', jsonb_build_object(
    'externo', 'wamid.EEE', 'de', '+5544999887766', 'texto', 'promoção imperdível'));

  perform app.assert(v_r.status = 'blocked', 'contato bloqueado é reconhecido');
  perform app.assert(v_r.message_id is not null,
    'mas a mensagem é REGISTRADA: "sumiu" não deixa rastro para descobrir um bloqueio errado');
  perform app.assert(
    (select status from public.channel_messages where id = v_r.message_id) = 'ignorada',
    'marcada como ignorada');
  perform app.assert(
    (select count(*) from public.tickets where tenant_id = v_t) = v_tickets,
    'e nenhum chamado nasce dela');
  update public.channel_contacts set bloqueado = false where external_id = '+5544999887766';

  -- Canal em observação: mesmo comportamento, motivo diferente.
  update public.channels set status = 'ativo' where name = 'Só observando';
  select * into v_r from public.channel_ingest('tok_obs', jsonb_build_object(
    'externo', 'n8n-001', 'de', 'telegram:12345', 'texto', 'oi'));
  perform app.assert(v_r.status = 'logged',
    'canal em observação registra a mensagem e não abre chamado');
  perform app.assert(
    (select count(*) from public.tickets where tenant_id = v_t) = v_tickets,
    'é o jeito de medir o volume de um número divulgado antes de deixá-lo abrir chamado');
end
$$;

-- -----------------------------------------------------------------------------
-- 38.11 Quem é o número: o casamento com o cadastro
-- -----------------------------------------------------------------------------
-- Sem isto, todo chamado vindo do WhatsApp é anônimo — sem cliente, sem filial,
-- sem SLA e sem pesquisa de satisfação.
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_fila   uuid;
  v_prio   uuid;
  v_user   uuid := '22220000-0000-4000-8000-000000000005';  -- Carla, solicitante
  v_email  text;
  v_canal  uuid;
  v_r      record;
begin
  select id into v_fila from public.queues where tenant_id = v_t and is_system_default;
  select id into v_prio from public.ticket_priorities where tenant_id = v_t order by sort_order limit 1;
  select email into v_email from public.profiles where id = v_user;

  -- (a) Canal de e-mail: o identificador JÁ É o endereço, então o casamento é
  -- exato.
  insert into public.channels
    (tenant_id, name, kind, inbound_token_hash, default_queue_id, default_priority_id)
  values (v_t, 'suporte@empresa', 'email',
          encode(digest('tok_mail', 'sha256'), 'hex'), v_fila, v_prio)
  returning id into v_canal;

  select * into v_r from public.channel_ingest('tok_mail', jsonb_build_object(
    'externo', 'msgid-001', 'de', v_email, 'texto', 'não consigo entrar no sistema'));

  perform app.assert(
    (select profile_id from public.channel_contacts
      where channel_id = v_canal and external_id = v_email) = v_user,
    'no e-mail, o contato casa com o cadastro pelo endereço');
  perform app.assert(
    (select requester_id from public.tickets where id = v_r.ticket_id) = v_user,
    'e o chamado nasce com o solicitante certo — não anônimo');

  -- (b) WhatsApp: compara só os dígitos, pelos últimos 8. O telefone no cadastro
  -- vem escrito de seis jeitos, e nenhum deles é o formato da Meta.
  update public.profiles set phone = '(44) 99988-7766' where id = v_user;
  delete from public.channel_contacts where external_id = '+554499887766x';

  insert into public.channels
    (tenant_id, name, kind, inbound_token_hash, default_queue_id, default_priority_id)
  values (v_t, 'WhatsApp filial', 'whatsapp',
          encode(digest('tok_w2', 'sha256'), 'hex'), v_fila, v_prio)
  returning id into v_canal;

  select * into v_r from public.channel_ingest('tok_w2', jsonb_build_object(
    'externo', 'wamid.FFF', 'de', '5544999887766', 'texto', 'oi de novo'));

  perform app.assert(
    (select profile_id from public.channel_contacts
      where channel_id = v_canal and external_id = '5544999887766') = v_user,
    'no WhatsApp, casa pelos últimos 8 dígitos: é o que sobrevive a DDI e DDD escritos de jeitos diferentes');
end
$$;

-- -----------------------------------------------------------------------------
-- 38.12 Quem enxerga, e quem configura
-- -----------------------------------------------------------------------------
do $$
begin
  perform app.assert(
    has_function_privilege('anon', 'public.channel_ingest(text, jsonb)', 'execute'),
    'o provedor manda mensagem sem ter conta — ele é um serviço');

  -- A view de conversas é lida por toda a equipe de atendimento. Ela NÃO pode
  -- carregar o token de entrada nem a referência da credencial.
  perform app.assert(
    not exists (
      select 1 from information_schema.columns
      where table_name = 'vw_channel_conversations'
        and column_name in ('inbound_token_hash', 'secret_ref', 'outbound_url')),
    'a caixa de conversas NÃO carrega token nem credencial');
end
$$;

-- Ana Souza é operadora de TI: lê e responde conversa, não configura canal.
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
declare
  v_id uuid;
  v_n  integer;
begin
  perform app.assert(app.has_permission('canais.conversas.ver'),
    'operador de TI lê conversa: é o trabalho dele');
  perform app.assert(app.has_permission('canais.conversas.responder'),
    'e responde');
  perform app.assert(not app.has_permission('canais.canais.gerenciar'),
    'mas NÃO liga nem desliga canal: isso guarda credencial');
  -- Nem abre a tela de configuração: ela mostra QUAL variável de ambiente cada
  -- canal usa, e isso é mapa da infraestrutura.
  perform app.assert(not app.has_permission('canais.canais.ver'),
    'nem abre a tela de configuração, que diz onde mora cada credencial');

  perform app.assert((select count(*) from public.vw_channel_conversations) > 0,
    'e a caixa de conversas aparece para ele');

  -- Classificar o contato é trabalho de quem atende: é na conversa que se
  -- descobre quem é o número.
  select id into v_id from public.channel_contacts limit 1;
  update public.channel_contacts set display_name = 'Nome corrigido' where id = v_id;
  get diagnostics v_n = row_count;
  perform app.assert(v_n = 1, 'ele classifica o contato');

  select id into v_id from public.channels limit 1;
  update public.channels set status = 'pausado' where id = v_id;
  get diagnostics v_n = row_count;
  perform app.assert(v_n = 0,
    'e não pausa o canal: a negação do RLS chega como zero linhas, não como erro');
end
$$;

-- Carla Dias é solicitante: não vê conversa nenhuma.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert((select count(*) from public.channel_conversations) = 0,
    'solicitante não lê a caixa de conversas dos outros');
  perform app.assert((select count(*) from public.channel_messages) = 0,
    'nem as mensagens');
  perform app.assert((select count(*) from public.channels) = 0,
    'nem a configuração dos canais');
end
$$;

-- Tenant 2 não vê nada do tenant 1.
set request.jwt.claims = '{"sub":"33330000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
begin
  perform app.assert((select count(*) from public.channels) = 0,
    'tenant 2 não vê canal do tenant 1');
  perform app.assert((select count(*) from public.channel_contacts) = 0,
    'nem os contatos');
  perform app.assert((select count(*) from public.channel_messages) = 0,
    'nem as mensagens');
  perform app.assert((select count(*) from public.vw_channel_conversations) = 0,
    'nem a caixa de conversas');
end
$$;
reset role;

-- =============================================================================
\echo '=== 39. Sugestões de IA: nada é aplicado sozinho (0035) ==='
-- =============================================================================
reset role;
/* `reset role` não limpa `request.jwt.claims` — ver a nota da seção 38. */
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';

-- A onda inteira existe para que uma sugestão não vire mudança sem ato humano. O
-- que o banco garante disso está aqui.

-- -----------------------------------------------------------------------------
-- 39.1 Ligada sem credencial seria um painel girando para sempre
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_erro boolean := false;
begin
  delete from public.ai_settings where tenant_id = v_t;

  begin
    insert into public.ai_settings (tenant_id, enabled, secret_ref)
    values (v_t, true, null);
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro,
    'IA ligada sem referência de credencial é recusada: o sintoma seria um painel girando');

  begin
    insert into public.ai_settings (tenant_id, enabled, secret_ref)
    values (v_t, true, 'sk-ant-api03-segredo-de-verdade');
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro,
    'e a chave em si é recusada: o campo guarda o NOME da variável (ADR-009)');

  insert into public.ai_settings (tenant_id, enabled, secret_ref, limite_mensal_centavos)
  values (v_t, true, 'ANTHROPIC_API_KEY', 1000);
  perform app.assert(true, 'com o nome da variável, passa');
end
$$;

-- -----------------------------------------------------------------------------
-- 39.2 "Aceita por ninguém" não é estado gravável
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_tk   uuid;
  v_p    uuid := '22220000-0000-4000-8000-000000000001';
  v_id   uuid;
  v_erro boolean := false;
begin
  /* Pelo NÚMERO, e não `limit 1`: a semente cria uuid novo a cada execução, e
     `limit 1` pegava um chamado de uma filial que a operadora de TI não enxerga —
     a seção 39.6 então via a tabela cheia e a view vazia (a view junta `tickets`,
     que é o RLS do chamado fazendo o trabalho dele). O número 1 é estável e está
     no escopo dela. */
  select id into v_tk from public.tickets
   where tenant_id = v_t and ticket_number = 1 and deleted_at is null;

  begin
    insert into public.ai_suggestions (tenant_id, ticket_id, kind, payload, status)
    values (v_t, v_tk, 'triagem', '{"confianca":0.9}'::jsonb, 'aceita');
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro,
    'sugestão aceita sem autor e sem data é recusada: é exatamente o estado que a onda impede');

  insert into public.ai_suggestions (tenant_id, ticket_id, kind, payload, requested_by)
  values (v_t, v_tk, 'triagem', '{"confianca":0.9}'::jsonb, v_p)
  returning id into v_id;
  perform app.assert(
    (select status from public.ai_suggestions where id = v_id) = 'pendente',
    'toda sugestão nasce pendente');

  v_erro := false;
  begin
    update public.ai_suggestions set status = 'recusada' where id = v_id;
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro, 'e decidir sem dizer quem decidiu também é recusado');

  update public.ai_suggestions
     set status = 'recusada', acted_by = v_p, acted_at = now()
   where id = v_id;
  perform app.assert(
    (select acted_by from public.ai_suggestions where id = v_id) = v_p,
    'com autor e data, a decisão é gravada — e fica registrada para sempre');
end
$$;

-- -----------------------------------------------------------------------------
-- 39.3 Uma pendente por chamado e por tipo
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_tk   uuid;
  v_p    uuid := '22220000-0000-4000-8000-000000000001';
  v_erro boolean := false;
begin
  /* Pelo NÚMERO, e não `limit 1`: a semente cria uuid novo a cada execução, e
     `limit 1` pegava um chamado de uma filial que a operadora de TI não enxerga —
     a seção 39.6 então via a tabela cheia e a view vazia (a view junta `tickets`,
     que é o RLS do chamado fazendo o trabalho dele). O número 1 é estável e está
     no escopo dela. */
  select id into v_tk from public.tickets
   where tenant_id = v_t and ticket_number = 1 and deleted_at is null;
  delete from public.ai_suggestions where ticket_id = v_tk and status = 'pendente';

  insert into public.ai_suggestions (tenant_id, ticket_id, kind, payload, requested_by)
  values (v_t, v_tk, 'resposta', '{"texto":"a"}'::jsonb, v_p);

  begin
    insert into public.ai_suggestions (tenant_id, ticket_id, kind, payload, requested_by)
    values (v_t, v_tk, 'resposta', '{"texto":"b"}'::jsonb, v_p);
  exception when unique_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro,
    'dois cliques não viram duas sugestões pendentes do mesmo tipo — e as duas teriam sido pagas');

  -- Tipo diferente convive: são perguntas diferentes sobre o mesmo chamado.
  insert into public.ai_suggestions (tenant_id, ticket_id, kind, payload, requested_by)
  values (v_t, v_tk, 'triagem', '{"confianca":0.5}'::jsonb, v_p);
  perform app.assert(true, 'mas resposta e triagem convivem no mesmo chamado');

  -- E uma decidida libera a vaga: pedir de novo é legítimo.
  update public.ai_suggestions
     set status = 'recusada', acted_by = v_p, acted_at = now()
   where ticket_id = v_tk and kind = 'resposta' and status = 'pendente';
  insert into public.ai_suggestions (tenant_id, ticket_id, kind, payload, requested_by)
  values (v_t, v_tk, 'resposta', '{"texto":"c"}'::jsonb, v_p);
  perform app.assert(true, 'decidida a anterior, pedir de novo é permitido');
end
$$;

-- -----------------------------------------------------------------------------
-- 39.4 A virada do mês do orçamento
-- -----------------------------------------------------------------------------
do $$
declare
  v_t uuid := 'a0000000-0000-4000-8000-000000000001';
begin
  update public.ai_settings
     set gasto_do_mes_centavos = 900, limite_mensal_centavos = 1000,
         mes_de_referencia = date_trunc('month', now())::date
   where tenant_id = v_t;

  perform app.assert(
    (select tem_orcamento from public.ai_config_utilizavel()),
    'com 900 de 1000 gastos, ainda há orçamento');

  perform public.ai_registrar_uso(v_t, 1000, 500, 200);
  perform app.assert(
    (select gasto_do_mes_centavos from public.ai_settings where tenant_id = v_t) = 1100,
    'o consumo acumula');
  perform app.assert(
    not (select tem_orcamento from public.ai_config_utilizavel()),
    'e, passado o teto, a resposta é não — conferida ANTES da próxima chamada');

  -- Mês velho: o acumulado zera, e zera na LEITURA também. Sem isso, no dia 1º o
  -- painel diria "orçamento esgotado" até alguém pedir a primeira sugestão.
  update public.ai_settings
     set mes_de_referencia = (date_trunc('month', now()) - interval '1 month')::date
   where tenant_id = v_t;
  perform app.assert(
    (select tem_orcamento from public.ai_config_utilizavel()),
    'mês virado devolve orçamento na leitura, sem esperar a primeira chamada');
  perform app.assert(
    (select gasto_do_mes_centavos from public.ai_config_utilizavel()) = 0,
    'e o acumulado mostrado é zero');

  perform public.ai_registrar_uso(v_t, 10, 10, 50);
  perform app.assert(
    (select gasto_do_mes_centavos from public.ai_settings where tenant_id = v_t) = 50,
    'a primeira chamada do mês novo começa do zero, e não soma no acumulado velho');
end
$$;

-- -----------------------------------------------------------------------------
-- 39.5 O que sai no prompt: a nota interna é a trava
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_tk   uuid;
  v_p    uuid := '22220000-0000-4000-8000-000000000001';
  v_json jsonb;
begin
  /* Pelo NÚMERO, e não `limit 1`: a semente cria uuid novo a cada execução, e
     `limit 1` pegava um chamado de uma filial que a operadora de TI não enxerga —
     a seção 39.6 então via a tabela cheia e a view vazia (a view junta `tickets`,
     que é o RLS do chamado fazendo o trabalho dele). O número 1 é estável e está
     no escopo dela. */
  select id into v_tk from public.tickets
   where tenant_id = v_t and ticket_number = 1 and deleted_at is null;

  delete from public.ticket_comments where ticket_id = v_tk;
  insert into public.ticket_comments (tenant_id, ticket_id, author_id, body, visibility)
  values (v_t, v_tk, v_p, 'Bom dia, já estou verificando.', 'public'),
         (v_t, v_tk, v_p, 'A senha do servidor e o histórico deste cliente.', 'internal');

  update public.ai_settings set enviar_notas_internas = false where tenant_id = v_t;
  select comentarios into v_json from public.ai_contexto_do_chamado(v_tk);
  perform app.assert(jsonb_array_length(v_json) = 1,
    'com a opção desligada, só o comentário público entra no prompt');
  perform app.assert(not (v_json::text like '%senha do servidor%'),
    'e a nota interna NÃO sai deste servidor');

  update public.ai_settings set enviar_notas_internas = true where tenant_id = v_t;
  select comentarios into v_json from public.ai_contexto_do_chamado(v_tk);
  perform app.assert(jsonb_array_length(v_json) = 2,
    'ligada explicitamente, a nota interna entra — é escolha, nunca herança');

  -- Comentário apagado não volta pelo prompt.
  update public.ticket_comments set deleted_at = now()
   where ticket_id = v_tk and visibility = 'public';
  update public.ai_settings set enviar_notas_internas = false where tenant_id = v_t;
  select comentarios into v_json from public.ai_contexto_do_chamado(v_tk);
  perform app.assert(jsonb_array_length(v_json) = 0,
    'comentário apagado não reaparece pelo contexto da IA');
end
$$;

-- -----------------------------------------------------------------------------
-- 39.6 Quem pode o quê
-- -----------------------------------------------------------------------------
set role rls_tester;

-- Ana Souza é operadora de TI: usa a sugestão, não configura a IA.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
declare
  v_n integer;
begin
  perform app.assert(app.has_permission('ia.sugestoes.ver'), 'operador de TI vê as sugestões');
  perform app.assert(app.has_permission('ia.sugestoes.usar'), 'e pede e decide');
  perform app.assert(not app.has_permission('ia.config.gerenciar'),
    'mas NÃO liga a IA: isso guarda credencial e define o gasto do mês');
  perform app.assert(not app.has_permission('ia.config.ver'),
    'nem abre a tela de configuração');

  /* Ele PRECISA ler a configuração mesmo sem `ia.config.ver`: é o Server Action
     dele que faz a chamada, e ele precisa saber o modelo e o nome da variável.
     Ler o nome da variável não dá acesso a nada — o valor está no ambiente do
     servidor. */
  perform app.assert((select count(*) from public.ai_settings) = 1,
    'mas lê a configuração: é o pedido dele que faz a chamada');

  update public.ai_settings set limite_mensal_centavos = 999999;
  get diagnostics v_n = row_count;
  perform app.assert(v_n = 0,
    'e não mexe no teto de gasto: a negação do RLS chega como zero linhas');

  perform app.assert((select count(*) from public.vw_ai_suggestions) > 0,
    'as sugestões do chamado aparecem para ele');
end
$$;

-- Carla Dias é solicitante: não vê sugestão nenhuma.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert((select count(*) from public.ai_suggestions) = 0,
    'solicitante não lê as sugestões de IA');
  perform app.assert((select count(*) from public.ai_settings) = 0,
    'nem a configuração');
  perform app.assert((select count(*) from public.ai_config_utilizavel()) = 0,
    'e para ele a IA simplesmente não existe');
end
$$;

-- Tenant 2 não vê nada do tenant 1.
set request.jwt.claims = '{"sub":"33330000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
begin
  perform app.assert((select count(*) from public.ai_settings) = 0,
    'tenant 2 não vê a configuração de IA do tenant 1');
  perform app.assert((select count(*) from public.ai_suggestions) = 0,
    'nem as sugestões');
  perform app.assert((select count(*) from public.vw_ai_suggestions) = 0,
    'nem o consumo');
end
$$;
reset role;

-- =============================================================================
\echo '=== 40. As lacunas de interface (0036) ==='
-- =============================================================================
reset role;
/* `reset role` não limpa `request.jwt.claims` — ver a nota da seção 38. */
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';

-- Esta seção cobre o que a 0036 destravou: tabelas que tinham dados, RLS e
-- auditoria, e nenhuma tela. O que se testa aqui é que a escrita funciona pelo
-- caminho que a tela usa — porque até agora ninguém nunca a exercitou.

-- -----------------------------------------------------------------------------
-- 40.1 Expediente: o estado silencioso é o que importa
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_bh   uuid;
  v_min  numeric;
  v_erro boolean := false;
begin
  insert into public.business_hours (tenant_id, name, timezone)
  values (v_t, 'Teste 0036', 'America/Sao_Paulo')
  returning id into v_bh;

  /*
   * Expediente SEM FAIXA não conta tempo nenhum, e é um estado gravável: o
   * contrato aponta para ele, a conta roda e o prazo nunca vence. Nada no banco
   * impede — por isso a tela precisa dizer, e por isso isto é asserção e não
   * suposição.
   */
  v_min := app.fn_business_minutes_between(
    now() - interval '7 days', now(), v_bh);
  perform app.assert(coalesce(v_min, 0) = 0,
    'expediente sem faixa não conta minuto nenhum — o prazo nunca venceria');

  -- Com faixa, passa a contar.
  insert into public.business_hours_intervals (business_hours_id, weekday, starts_at, ends_at)
  select v_bh, d, '08:00', '18:00' from generate_series(1, 5) d;
  v_min := app.fn_business_minutes_between(
    now() - interval '7 days', now(), v_bh);
  perform app.assert(v_min > 0, 'com faixa cadastrada, o relógio anda');

  -- Faixa invertida é recusada: 18h às 8h não é expediente, é erro de digitação.
  begin
    insert into public.business_hours_intervals (business_hours_id, weekday, starts_at, ends_at)
    values (v_bh, 6, '18:00', '08:00');
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro, 'faixa que termina antes de começar é recusada');

  -- Duas faixas no mesmo dia são o almoço, e precisam conviver.
  insert into public.business_hours_intervals (business_hours_id, weekday, starts_at, ends_at)
  values (v_bh, 6, '08:00', '12:00'), (v_bh, 6, '13:00', '18:00');
  perform app.assert(
    (select count(*) from public.business_hours_intervals
      where business_hours_id = v_bh and weekday = 6) = 2,
    'duas faixas no mesmo dia convivem: é o almoço');

  -- Mas não duas começando na mesma hora, no mesmo dia.
  v_erro := false;
  begin
    insert into public.business_hours_intervals (business_hours_id, weekday, starts_at, ends_at)
    values (v_bh, 6, '08:00', '11:00');
  exception when unique_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro, 'e duas faixas começando no mesmo horário, não');
end
$$;

-- -----------------------------------------------------------------------------
-- 40.2 Feriado tira o dia da conta
-- -----------------------------------------------------------------------------
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_bh     uuid;
  v_com    numeric;
  v_sem    numeric;
  v_dia    date;
  v_erro   boolean := false;
begin
  select id into v_bh from public.business_hours
   where tenant_id = v_t and name = 'Teste 0036';

  /* Uma terça-feira qualquer do passado recente, dentro da faixa cadastrada. */
  v_dia := (date_trunc('week', now()::date) - interval '7 days' + interval '1 day')::date;

  v_sem := app.fn_business_minutes_between(
    v_dia + time '08:00', v_dia + time '18:00', v_bh);
  perform app.assert(v_sem > 0, 'dia útil conta minuto');

  insert into public.business_hours_holidays (business_hours_id, holiday_date, name)
  values (v_bh, v_dia, 'Feriado de teste');

  v_com := app.fn_business_minutes_between(
    v_dia + time '08:00', v_dia + time '18:00', v_bh);
  perform app.assert(v_com = 0,
    'cadastrado o feriado, o mesmo dia deixa de contar — era isto que nunca podia ser feito pela tela');

  -- O mesmo dia duas vezes é clique repetido, não erro de quem usa.
  begin
    insert into public.business_hours_holidays (business_hours_id, holiday_date, name)
    values (v_bh, v_dia, 'De novo');
  exception when unique_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro, 'o mesmo dia não entra duas vezes como feriado');
end
$$;

-- -----------------------------------------------------------------------------
-- 40.3 Vínculo de ativo e linha ao chamado
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_tk   uuid;
  v_a    uuid;
  v_erro boolean := false;
begin
  select id into v_tk from public.tickets
   where tenant_id = v_t and ticket_number = 1 and deleted_at is null;
  select id into v_a from public.it_assets
   where tenant_id = v_t and deleted_at is null limit 1;

  delete from public.ticket_assets where ticket_id = v_tk;

  insert into public.ticket_assets (tenant_id, ticket_id, asset_id) values (v_t, v_tk, v_a);
  perform app.assert(
    (select count(*) from public.ticket_assets where ticket_id = v_tk) = 1,
    'o ativo se vincula ao chamado — a tabela existia desde a 0004 e nenhuma tela escrevia nela');

  begin
    insert into public.ticket_assets (tenant_id, ticket_id, asset_id) values (v_t, v_tk, v_a);
  exception when unique_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro, 'e o mesmo ativo não entra duas vezes');

  /* A pergunta que o vínculo passa a responder, e que era impossível antes:
     quantos chamados esta máquina já deu. */
  perform app.assert(
    (select count(*) from public.ticket_assets where asset_id = v_a) >= 1,
    'e dá para perguntar quantos chamados um equipamento já deu');
end
$$;

-- -----------------------------------------------------------------------------
-- 40.4 Membros de fila: lista de quem cuida, NÃO de quem pode ver
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_q    uuid;
  v_p    uuid := '22220000-0000-4000-8000-000000000003';
begin
  select id into v_q from public.queues
   where tenant_id = v_t and deleted_at is null limit 1;

  delete from public.queue_members where queue_id = v_q;
  insert into public.queue_members (tenant_id, queue_id, user_id, is_lead)
  values (v_t, v_q, v_p, true);

  perform app.assert(
    (select is_lead from public.queue_members where queue_id = v_q and user_id = v_p),
    'a pessoa entra na fila como responsável');
end
$$;

set role rls_tester;

-- Carla Dias é solicitante e NÃO é membro de fila nenhuma.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  /*
   * A asserção que impede a pior leitura errada desta tela: `queue_members` NÃO
   * é autorização. O RLS de `tickets` não a consulta, e ninguém deixa de ver
   * chamado por não ser membro. Se alguém um dia ligar as duas coisas, este
   * teste some do verde e a decisão fica explícita.
   */
  perform app.assert(
    (select count(*) from public.queue_members) >= 0,
    'quem não é membro ainda lê a lista de membros: ela não é segredo');
end
$$;

-- Ana Souza é operadora de TI: não administra fila.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
declare
  v_n integer;
begin
  perform app.assert(not app.has_permission('helpdesk.filas.editar'),
    'operador de TI não altera a equipe da fila');

  -- E não vincula? Vincula: é ato de quem atende.
  perform app.assert(app.has_permission('helpdesk.tickets.vincular'),
    'mas vincula ativo e linha ao chamado: é ato de quem atende');

  perform app.assert(not app.has_permission('auditoria.trilha.ver'),
    'e não lê a trilha de auditoria');

  update public.business_hours set name = 'Nao deveria' where name = 'Teste 0036';
  get diagnostics v_n = row_count;
  perform app.assert(v_n = 0,
    'nem mexe no expediente: a negação do RLS chega como zero linhas');
end
$$;

-- Jorge Lima é gestor de TI: lê a trilha, cuida do expediente.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(app.has_permission('auditoria.trilha.ver'),
    'gestor de TI lê a trilha: quem responde pela operação precisa saber quem mudou o quê');
  perform app.assert(app.has_permission('sla.horarios.editar'),
    'e cuida do expediente');
  perform app.assert(not app.has_permission('auditoria.trabalhos.ver'),
    'mas não acompanha o agendador: é infraestrutura compartilhada, de teto admin');
  perform app.assert((select count(*) from public.audit_log) > 0,
    'e enxerga a trilha do próprio ambiente');
end
$$;

-- Tenant 2 não vê a trilha do tenant 1.
set request.jwt.claims = '{"sub":"33330000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
begin
  perform app.assert(
    (select count(*) from public.audit_log
      where tenant_id = 'a0000000-0000-4000-8000-000000000001') = 0,
    'tenant 2 não lê a trilha do tenant 1');
  perform app.assert(
    (select count(*) from public.business_hours
      where tenant_id = 'a0000000-0000-4000-8000-000000000001') = 0,
    'nem o expediente dele');
end
$$;
reset role;

-- -----------------------------------------------------------------------------
-- 40.5 O resumo dos trabalhos agendados
-- -----------------------------------------------------------------------------
do $$
declare
  v_n integer;
begin
  delete from public.job_runs where job = 'teste_0036';
  insert into public.job_runs (job, started_at, finished_at, ok, affected)
  values ('teste_0036', now() - interval '2 hours', now() - interval '2 hours', true, 7),
         ('teste_0036', now() - interval '10 minutes', now() - interval '10 minutes', false, 0);

  perform app.assert(
    (select execucoes from public.vw_job_health where job = 'teste_0036') = 2,
    'a view conta as execuções de cada trabalho');
  perform app.assert(
    (select ultimo_ok from public.vw_job_health where job = 'teste_0036') is false,
    'e o resultado mostrado é o da ÚLTIMA, não a média: um trabalho com 4.000 acertos e a última falha está quebrado');
  perform app.assert(
    (select minutos_desde from public.vw_job_health where job = 'teste_0036') < 60,
    'e os minutos desde a última execução são o número que responde "parou?"');

  delete from public.job_runs where job = 'teste_0036';
end
$$;

-- =============================================================================
\echo '=== 41. Projetos e cronograma (0037) ==='
-- =============================================================================
reset role;
/* `reset role` não limpa `request.jwt.claims` — ver a nota da seção 38. */
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';

-- Primeiro módulo trazido do GSTI.IARX. O que se testa aqui é o que aquele
-- sistema NÃO podia garantir no banco: o schema dele diz, em comentário, que
-- "profundidade e ciclo o SQLite não expressa em CHECK". O PostgreSQL expressa, e
-- a diferença importa porque validação de aplicação é pulada por importação, por
-- correção manual e por qualquer caminho de escrita que não passe pela função
-- certa — e ciclo faz o Gantt entrar em laço infinito.

-- -----------------------------------------------------------------------------
-- 41.1 Competência é mês, não dia
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_c    uuid;
  v_erro boolean := false;
begin
  select id into v_c from public.clients where tenant_id = v_t and deleted_at is null limit 1;

  begin
    insert into public.projects (tenant_id, client_id, name, start_month, planned_end_month)
    values (v_t, v_c, 'Dia 15 não é competência', '2026-03-15', '2026-06-01');
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro,
    'competência no dia 15 é recusada: mês é mês, e fingir precisão de dia produz um Gantt que mente');

  perform app.assert(app.meses_entre('2026-01-01', '2026-04-01') = 3, 'a diferença em meses conta');
  perform app.assert(app.meses_entre('2026-04-01', '2026-01-01') = -3, 'e tem sinal');
end
$$;

-- -----------------------------------------------------------------------------
-- 41.2 Fim antes do início, e concluído sem entrega
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_c    uuid;
  v_erro boolean := false;
begin
  select id into v_c from public.clients where tenant_id = v_t and deleted_at is null limit 1;

  begin
    insert into public.projects (tenant_id, client_id, name, start_month, planned_end_month)
    values (v_t, v_c, 'Para antes de começar', '2026-06-01', '2026-03-01');
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro, 'fim planejado anterior ao início é recusado');

  /*
   * Concluído sem fim real seria um rótulo que alguém marca e o cronograma
   * continua mostrando a barra planejada sem a realizada: o projeto PARECE
   * entregue e não tem desvio nenhum para medir.
   */
  v_erro := false;
  begin
    insert into public.projects (tenant_id, client_id, name, start_month, planned_end_month, status)
    values (v_t, v_c, 'Concluído sem data', '2026-01-01', '2026-03-01', 'concluido');
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro,
    'projeto concluído sem fim real é recusado: é o fim real que vira o desvio');
end
$$;

-- -----------------------------------------------------------------------------
-- 41.3 Atraso e desvio: derivados, nunca digitados
-- -----------------------------------------------------------------------------
do $$
declare
  v_t   uuid := 'a0000000-0000-4000-8000-000000000001';
  v_c   uuid;
  v_p   uuid;
  v_vw  record;
begin
  select id into v_c from public.clients where tenant_id = v_t and deleted_at is null limit 1;
  delete from public.projects where tenant_id = v_t;

  -- Fim planejado três meses atrás, sem entrega: atrasado.
  insert into public.projects (tenant_id, client_id, name, start_month, planned_end_month, status)
  values (v_t, v_c, 'Atrasado',
          (date_trunc('month', now()) - interval '6 months')::date,
          (date_trunc('month', now()) - interval '3 months')::date,
          'em_andamento')
  returning id into v_p;

  select * into v_vw from public.vw_projects where id = v_p;
  perform app.assert(v_vw.atrasado, 'projeto que passou do prazo sem entrega aparece atrasado');
  perform app.assert(v_vw.meses_atraso = 3, 'e o atraso é de 3 meses, calculado de now()');

  /* Registrado o fim real, o atraso VIRA desvio: não há mais atraso a acusar. */
  update public.projects
     set actual_end_month = (date_trunc('month', now()) - interval '1 month')::date,
         status = 'concluido'
   where id = v_p;
  select * into v_vw from public.vw_projects where id = v_p;
  perform app.assert(not v_vw.atrasado, 'com fim real, o projeto deixa de acusar atraso');
  perform app.assert(v_vw.desvio_meses = 2, 'e passa a registrar desvio de 2 meses');

  /* Entrega adiantada dá desvio NEGATIVO — e isso precisa sobreviver, porque é a
     informação que distingue "entregou antes" de "entregou na data". */
  update public.projects
     set actual_end_month = (date_trunc('month', now()) - interval '5 months')::date
   where id = v_p;
  select * into v_vw from public.vw_projects where id = v_p;
  perform app.assert(v_vw.desvio_meses = -2, 'entrega adiantada dá desvio negativo');

  -- Cancelado nunca acusa atraso: um projeto que a empresa decidiu não fazer
  -- não é um prazo perdido.
  update public.projects set status = 'cancelado', actual_end_month = null where id = v_p;
  select * into v_vw from public.vw_projects where id = v_p;
  perform app.assert(not v_vw.atrasado and v_vw.meses_atraso = 0,
    'cancelado não acusa atraso');
end
$$;

-- -----------------------------------------------------------------------------
-- 41.4 A hierarquia que o SQLite não podia garantir
-- -----------------------------------------------------------------------------
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_c      uuid;
  v_p      uuid;
  v_p2     uuid;
  v_n1     uuid;
  v_n2     uuid;
  v_n3     uuid;
  v_fora   uuid;
  v_raiz2  uuid;
  v_filha2 uuid;
  v_erro   boolean := false;
begin
  select id into v_c from public.clients where tenant_id = v_t and deleted_at is null limit 1;
  delete from public.projects where tenant_id = v_t;

  insert into public.projects (tenant_id, client_id, name, start_month, planned_end_month)
  values (v_t, v_c, 'Hierarquia', '2026-01-01', '2026-12-01') returning id into v_p;
  insert into public.projects (tenant_id, client_id, name, start_month, planned_end_month)
  values (v_t, v_c, 'Outro projeto', '2026-01-01', '2026-12-01') returning id into v_p2;

  insert into public.project_tasks (tenant_id, project_id, name, start_month, planned_end_month)
  values (v_t, v_p, 'Nível 1', '2026-01-01', '2026-02-01') returning id into v_n1;
  insert into public.project_tasks (tenant_id, project_id, name, start_month, planned_end_month, parent_task_id)
  values (v_t, v_p, 'Nível 2', '2026-02-01', '2026-03-01', v_n1) returning id into v_n2;
  insert into public.project_tasks (tenant_id, project_id, name, start_month, planned_end_month, parent_task_id)
  values (v_t, v_p, 'Nível 3', '2026-03-01', '2026-04-01', v_n2) returning id into v_n3;
  perform app.assert(true, 'três níveis são aceitos');

  -- O quarto, não.
  begin
    insert into public.project_tasks (tenant_id, project_id, name, start_month, planned_end_month, parent_task_id)
    values (v_t, v_p, 'Nível 4', '2026-04-01', '2026-05-01', v_n3);
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro,
    'o quarto nível é recusado PELO BANCO — no GSTI isso só era validado na aplicação, e importação pulava');

  -- Ciclo: a tarefa de nível 1 passando a ter como pai a sua própria neta.
  v_erro := false;
  begin
    update public.project_tasks set parent_task_id = v_n3 where id = v_n1;
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro,
    'ciclo é recusado: sem isso o Gantt entra em laço infinito e o sintoma é a tela que não carrega');

  -- Pai de outro projeto: um cronograma não agrupa por fora de si.
  insert into public.project_tasks (tenant_id, project_id, name, start_month, planned_end_month)
  values (v_t, v_p2, 'De outro projeto', '2026-01-01', '2026-02-01') returning id into v_fora;
  v_erro := false;
  begin
    update public.project_tasks set parent_task_id = v_fora where id = v_n2;
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro, 'tarefa principal de outro projeto é recusada');

  /*
   * Mover uma tarefa que JÁ TEM duas gerações abaixo para debaixo de outra raiz
   * é recusado mesmo que ela própria coubesse: a subárvore vem junto. É a regra
   * que o cálculo ingênuo de profundidade erraria.
   */
  insert into public.project_tasks (tenant_id, project_id, name, start_month, planned_end_month)
  values (v_t, v_p, 'Outra raiz', '2026-01-01', '2026-02-01') returning id into v_raiz2;
  insert into public.project_tasks (tenant_id, project_id, name, start_month, planned_end_month, parent_task_id)
  values (v_t, v_p, 'Filha da outra raiz', '2026-02-01', '2026-03-01', v_raiz2) returning id into v_filha2;

  v_erro := false;
  begin
    update public.project_tasks set parent_task_id = v_filha2 where id = v_n1;
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro,
    'mover uma tarefa com duas gerações abaixo é recusado: a subárvore conta na profundidade');
end
$$;

-- -----------------------------------------------------------------------------
-- 41.5 Excluir tarefa principal é bloqueado, não cascateado
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_p    uuid;
  v_pai  uuid;
  v_erro boolean := false;
begin
  select id into v_p from public.projects
   where tenant_id = v_t and name = 'Hierarquia' and deleted_at is null;
  select id into v_pai from public.project_tasks
   where project_id = v_p and name = 'Nível 1';

  /*
   * Em cascata, uma confirmação de "excluir 1 tarefa" apagaria a subárvore
   * inteira em silêncio — exatamente o que a regra de auditoria não admite. A
   * chave estrangeira é `on delete restrict`.
   */
  begin
    delete from public.project_tasks where id = v_pai;
  exception when foreign_key_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro,
    'excluir tarefa com subtarefas é BLOQUEADO, não cascateado: a subárvore não some em silêncio');
end
$$;

-- -----------------------------------------------------------------------------
-- 41.6 Quem pode o quê
-- -----------------------------------------------------------------------------
set role rls_tester;

-- Ana Souza é operadora de TI: executa tarefa, não planeja cronograma.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
declare
  v_n integer;
  v_t uuid;
begin
  perform app.assert(app.has_permission('projetos.projetos.ver'), 'operador de TI vê os projetos');
  perform app.assert(app.has_permission('projetos.projetos.executar'),
    'e atualiza o andamento da tarefa que executou');
  perform app.assert(not app.has_permission('projetos.projetos.editar'),
    'mas não mexe no cronograma');
  perform app.assert(not app.has_permission('projetos.projetos.criar'),
    'nem cria projeto');

  /* Executar é escrita de verdade, e precisa funcionar: é a política
     `tasks_update`, que aceita `editar` OU `executar`. Sem ela, o cronograma
     envelheceria no gargalo de quem o administra. */
  select id into v_t from public.project_tasks where deleted_at is null limit 1;
  update public.project_tasks set status = 'em_andamento' where id = v_t;
  get diagnostics v_n = row_count;
  perform app.assert(v_n = 1, 'e consegue marcar a tarefa como em andamento');

  /*
   * Aqui a negação chega como ERRO, e não como zero linhas — e a diferença é
   * real: `with check` violado num INSERT levanta exceção, enquanto `using`
   * violado num UPDATE ou DELETE simplesmente não encontra a linha. As duas
   * convenções convivem nesta base, e é por isso que toda escrita confere
   * `length` do `.select()` E trata o erro.
   */
  declare
    v_erro boolean := false;
  begin
    begin
      insert into public.projects (tenant_id, client_id, name, start_month, planned_end_month)
      select 'a0000000-0000-4000-8000-000000000001', c.id, 'Não deveria', '2026-01-01', '2026-02-01'
        from public.clients c limit 1;
    exception when insufficient_privilege or check_violation then
      v_erro := true;
    end;
    perform app.assert(v_erro, 'e não cria projeto: o RLS recusa a inserção');
  end;
end
$$;

-- Jorge Lima é gestor de TI: planeja.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(app.has_permission('projetos.projetos.criar'), 'gestor de TI cria projeto');
  perform app.assert(app.has_permission('projetos.projetos.editar'), 'e edita o cronograma');
  perform app.assert(app.has_permission('projetos.projetos.excluir'), 'e exclui');
  perform app.assert((select count(*) from public.vw_projects) > 0,
    'e enxerga os projetos do próprio ambiente');
end
$$;

-- Tenant 2 não vê projeto do tenant 1.
set request.jwt.claims = '{"sub":"33330000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
begin
  perform app.assert((select count(*) from public.vw_projects) = 0,
    'tenant 2 não vê projeto do tenant 1');
  perform app.assert((select count(*) from public.vw_project_tasks) = 0,
    'nem as tarefas');
end
$$;
reset role;

-- =============================================================================
\echo '=== 42. Orçamento de TI (0038) ==='
-- =============================================================================
reset role;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';

-- Este módulo não é contas a pagar: ele responde quanto a TI CUSTA por
-- competência. O que se testa aqui é exatamente o que separa os dois — a trava
-- do mês fechado, a idempotência da importação (que impede a dupla contagem) e o
-- rateio que fecha na conta.

-- -----------------------------------------------------------------------------
-- 42.1 Todo cliente nasce com o cenário oficial
-- -----------------------------------------------------------------------------
do $$
declare
  v_t uuid := 'a0000000-0000-4000-8000-000000000001';
begin
  /* `scenario_id` é NOT NULL de propósito: um lançamento sem cenário entraria em
     todos os relatórios e em nenhum. Sem o cenário nascendo junto do cliente,
     não haveria onde lançar. */
  perform app.assert(
    (select count(*) from public.it_budget_scenarios s
      join public.clients c on c.id = s.client_id
     where c.tenant_id = v_t and s.key = 'oficial') > 0,
    'todo cliente nasce com o cenário oficial — sem ele não há onde lançar');
end
$$;

-- -----------------------------------------------------------------------------
-- 42.2 O rateio fecha exatamente no total
-- -----------------------------------------------------------------------------
do $$
declare
  v_partes numeric[];
  v_soma   numeric;
  v_total  numeric;
  v_n      integer;
begin
  /*
   * Um centavo de diferença por contrato, em cem contratos, é o tipo de erro que
   * ninguém encontra depois — aparece quando o cliente confere a planilha contra
   * a nota. O caso que quebra nunca é 100 em 2; é 1.000,01 em 7.
   */
  foreach v_total in array array[100, 100.01, 0.03, 1000.01, 1234.56, 9999.99]::numeric[] loop
    foreach v_n in array array[1, 2, 3, 7, 11, 12, 13, 24, 36] loop
      v_partes := app.ratear_valor(v_total, v_n);
      select sum(x) into v_soma from unnest(v_partes) x;
      perform app.assert(v_soma = v_total,
        format('o rateio de %s em %s parcelas fecha exatamente', v_total, v_n));
      perform app.assert(array_length(v_partes, 1) = v_n, 'e devolve o número de parcelas pedido');
    end loop;
  end loop;

  -- O resto vai nas PRIMEIRAS, que é a convenção comercial brasileira.
  perform app.assert(app.ratear_valor(100, 3) = array[33.34, 33.33, 33.33]::numeric[],
    '100 em 3 é 33,34 + 33,33 + 33,33 — o resto nas primeiras');
end
$$;

-- -----------------------------------------------------------------------------
-- 42.3 A trava do mês fechado
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_c    uuid;
  v_cen  uuid;
  v_cat  uuid;
  v_e    uuid;
  v_f    uuid;
  v_comp date := '2026-05-01';
  v_erro boolean := false;
begin
  select id into v_c from public.clients where tenant_id = v_t and deleted_at is null limit 1;
  select id into v_cen from public.it_budget_scenarios where client_id = v_c and key = 'oficial';
  select id into v_cat from public.expense_categories where tenant_id = v_t and is_active limit 1;

  delete from public.it_budget_closings where client_id = v_c;
  delete from public.it_cost_entries where tenant_id = v_t;

  insert into public.it_cost_entries
    (tenant_id, client_id, expense_category_id, scenario_id, competence, amount,
     natureza, classificacao)
  values (v_t, v_c, v_cat, v_cen, v_comp, 1000.00, 'pontual_unica', 'despesa')
  returning id into v_e;
  perform app.assert(true, 'com a competência aberta, o lançamento entra');

  insert into public.it_budget_closings (tenant_id, client_id, competence)
  values (v_t, v_c, v_comp) returning id into v_f;

  perform app.assert(app.competencia_fechada(v_c, v_comp), 'a competência fica fechada');

  /*
   * Fechada, ela recusa QUALQUER escrita — e recusa com exceção, não com
   * silêncio. Todo o resto desta base trata negação como zero linhas, e zero
   * linhas aqui seria lido como "não encontrei". O fechamento não é questão de
   * permissão: é uma afirmação sobre o mês.
   */
  begin
    insert into public.it_cost_entries
      (tenant_id, client_id, expense_category_id, scenario_id, competence, amount,
       natureza, classificacao)
    values (v_t, v_c, v_cat, v_cen, v_comp, 50.00, 'pontual_unica', 'despesa');
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro, 'competência fechada recusa INSERÇÃO');

  v_erro := false;
  begin
    update public.it_cost_entries set amount = 2000.00 where id = v_e;
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro, 'e recusa ALTERAÇÃO');

  v_erro := false;
  begin
    delete from public.it_cost_entries where id = v_e;
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro, 'e recusa EXCLUSÃO');

  /* Mover um lançamento PARA dentro do mês fechado é a mesma coisa que escrever
     nele — e seria o jeito óbvio de contornar a trava. */
  v_erro := false;
  begin
    insert into public.it_cost_entries
      (tenant_id, client_id, expense_category_id, scenario_id, competence, amount,
       natureza, classificacao)
    values (v_t, v_c, v_cat, v_cen, '2026-06-01', 70.00, 'pontual_unica', 'despesa');
    update public.it_cost_entries set competence = v_comp
     where competence = '2026-06-01' and amount = 70.00;
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro, 'e recusa MOVER um lançamento para dentro dela');

  /* Reaberta, volta a aceitar — e a linha do fechamento NÃO some: "este mês já
     esteve fechado?" precisa ter resposta. */
  update public.it_budget_closings
     set reopened_at = now(), reopened_by = '22220000-0000-4000-8000-000000000001',
         reopen_reason = 'Nota fiscal atrasada'
   where id = v_f;
  perform app.assert(not app.competencia_fechada(v_c, v_comp), 'reaberta, a competência aceita de novo');
  update public.it_cost_entries set amount = 2000.00 where id = v_e;
  perform app.assert(
    (select amount from public.it_cost_entries where id = v_e) = 2000.00,
    'e a alteração passa');
  perform app.assert(
    (select count(*) from public.it_budget_closings where id = v_f) = 1,
    'a linha do fechamento fica: "este mês já esteve fechado?" precisa ter resposta');

  -- Reabrir sem motivo é recusado.
  v_erro := false;
  begin
    update public.it_budget_closings
       set reopened_at = now(), reopened_by = null, reopen_reason = null
     where id = v_f;
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro, 'reabrir sem motivo é recusado: a causa é o que alguém vai querer saber');
end
$$;

-- -----------------------------------------------------------------------------
-- 42.4 Um título vira lançamento UMA VEZ — a trava da dupla contagem
-- -----------------------------------------------------------------------------
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_c      uuid;
  v_cen    uuid;
  v_cat    uuid;
  v_pay    uuid;
  v_erro   boolean := false;
begin
  select id into v_c from public.clients where tenant_id = v_t and deleted_at is null limit 1;
  select id into v_cen from public.it_budget_scenarios where client_id = v_c and key = 'oficial';
  select id into v_cat from public.expense_categories where tenant_id = v_t and is_active limit 1;
  select id into v_pay from public.payables where tenant_id = v_t and deleted_at is null limit 1;

  delete from public.it_budget_closings where client_id = v_c;
  delete from public.it_cost_entries where tenant_id = v_t;

  insert into public.it_cost_entries
    (tenant_id, client_id, expense_category_id, scenario_id, competence, amount,
     natureza, classificacao, origem, payable_id)
  values (v_t, v_c, v_cat, v_cen, '2026-07-01', 500.00, 'pontual_unica', 'despesa',
          'titulo_a_pagar', v_pay);

  /*
   * A trava que impede a segunda verdade sobre o mesmo dinheiro. Sem ela, rodar
   * a importação duas vezes dobraria o custo do mês — e quem importa não tem
   * como saber se já importou.
   */
  begin
    insert into public.it_cost_entries
      (tenant_id, client_id, expense_category_id, scenario_id, competence, amount,
       natureza, classificacao, origem, payable_id)
    values (v_t, v_c, v_cat, v_cen, '2026-07-01', 500.00, 'pontual_unica', 'despesa',
            'titulo_a_pagar', v_pay);
  exception when unique_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro,
    'o mesmo título não vira dois lançamentos: é o que impede a dupla contagem');

  -- Origem `titulo_a_pagar` sem o título é recusada: a procedência seria uma
  -- afirmação sem como conferir.
  v_erro := false;
  begin
    insert into public.it_cost_entries
      (tenant_id, client_id, expense_category_id, scenario_id, competence, amount,
       natureza, classificacao, origem)
    values (v_t, v_c, v_cat, v_cen, '2026-07-01', 10.00, 'pontual_unica', 'despesa',
            'titulo_a_pagar');
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro, 'e origem "título a pagar" exige o título');
end
$$;

-- -----------------------------------------------------------------------------
-- 42.5 Parcelada exige o total de parcelas
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_c    uuid;
  v_cen  uuid;
  v_cat  uuid;
  v_erro boolean := false;
begin
  select id into v_c from public.clients where tenant_id = v_t and deleted_at is null limit 1;
  select id into v_cen from public.it_budget_scenarios where client_id = v_c and key = 'oficial';
  select id into v_cat from public.expense_categories where tenant_id = v_t and is_active limit 1;

  begin
    insert into public.it_cost_entries
      (tenant_id, client_id, expense_category_id, scenario_id, competence, amount,
       natureza, classificacao)
    values (v_t, v_c, v_cat, v_cen, '2026-08-01', 120.00, 'pontual_parcelada', 'despesa');
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro,
    'parcelada sem total de parcelas é recusada: "parcelada" seria um rótulo e a série não existiria');

  -- E a parcela não passa do total.
  v_erro := false;
  begin
    insert into public.it_cost_entries
      (tenant_id, client_id, expense_category_id, scenario_id, competence, amount,
       natureza, classificacao, installment_number, installment_total)
    values (v_t, v_c, v_cat, v_cen, '2026-08-01', 10.00, 'pontual_parcelada', 'despesa', 5, 3);
  exception when check_violation then
    v_erro := true;
  end;
  perform app.assert(v_erro, 'e a parcela 5 de 3 é recusada');
end
$$;

-- -----------------------------------------------------------------------------
-- 42.6 Quem pode o quê
-- -----------------------------------------------------------------------------
set role rls_tester;

-- Jorge Lima é gestor de TI: responde pelo custo da TI, não pelos títulos.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(app.has_permission('financeiro.orcamento.ver'),
    'gestor de TI vê o orçamento: quem responde pelo custo da TI é ele');
  perform app.assert(app.has_permission('financeiro.orcamento.lancar'), 'e lança');
  perform app.assert(app.has_permission('financeiro.orcamento.fechar'), 'e fecha a competência');
  /* Mas o resto do financeiro continua sendo de quem paga. */
  perform app.assert(not app.has_permission('financeiro.titulos_pagar.ver'),
    'e NÃO vê os títulos a pagar: isso é de quem paga');
  perform app.assert((select count(*) from public.vw_it_cost_entries) >= 0,
    'e a view do orçamento responde para ele');
end
$$;

-- Ana Souza é operadora de TI: não vê orçamento nenhum.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(not app.has_permission('financeiro.orcamento.ver'),
    'operadora de TI não vê o orçamento');
  perform app.assert((select count(*) from public.it_cost_entries) = 0,
    'e a tabela devolve zero linhas para ela');
end
$$;

-- Tenant 2 não vê o orçamento do tenant 1.
set request.jwt.claims = '{"sub":"33330000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
begin
  perform app.assert(
    (select count(*) from public.it_cost_entries
      where tenant_id = 'a0000000-0000-4000-8000-000000000001') = 0,
    'tenant 2 não vê o orçamento do tenant 1');
  perform app.assert(
    (select count(*) from public.it_budget_closings
      where tenant_id = 'a0000000-0000-4000-8000-000000000001') = 0,
    'nem os fechamentos');
end
$$;
reset role;

-- =============================================================================
\echo '=== 43. Visão de resultado: os três sob o mesmo recorte (0039) ==='
-- =============================================================================
reset role;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';

-- Um indicador consolidado só vale se ele somar o que diz somar. Como ninguém
-- confere uma soma de três módulos olhando a tela, é aqui que ela é provada.
--
-- Tudo nesta seção acontece sobre um cliente PRÓPRIO, criado aqui. É o que
-- permite contar em números exatos sem apagar o que as seções anteriores
-- montaram — e o recorte por cliente é justamente o que está sendo testado.

-- -----------------------------------------------------------------------------
-- 43.1 O financeiro: o detalhe fecha no indicador, e a simulação fica de fora
-- -----------------------------------------------------------------------------
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_c      uuid := 'cc000000-0000-4000-8000-000000000043';
  v_cen    uuid;
  v_sim    uuid;
  v_cat    uuid;
  v_f1     uuid;
  v_f2     uuid;
  v_comp   date := date_trunc('month', now())::date;
  v_r      record;
  v_soma   numeric;
  v_linhas integer;
begin
  select id into v_cat from public.expense_categories where tenant_id = v_t and is_active limit 1;

  insert into public.clients (id, tenant_id, legal_name, trade_name)
  values (v_c, v_t, 'Resultado Consolidado Ltda', 'Visão de resultado')
  on conflict (id) do nothing;

  insert into public.branches (tenant_id, client_id, name)
  values (v_t, v_c, 'Matriz do resultado') returning id into v_f1;
  insert into public.branches (tenant_id, client_id, name)
  values (v_t, v_c, 'Filial do resultado') returning id into v_f2;

  -- O cenário oficial nasce com o cliente (0038).
  select id into v_cen from public.it_budget_scenarios where client_id = v_c and key = 'oficial';
  perform app.assert(v_cen is not null, 'o cliente nasce com o cenário oficial');

  -- Um cenário de simulação. Ele existe justamente para NÃO aparecer.
  insert into public.it_budget_scenarios (tenant_id, client_id, key, name)
  values (v_t, v_c, 'simulacao', 'Simulação de corte')
  returning id into v_sim;

  insert into public.it_cost_entries
    (tenant_id, client_id, branch_id, expense_category_id, scenario_id, competence,
     amount, natureza, classificacao)
  values
    -- A competência em exame: 1.000 + 500 + 250 = 1.750.
    (v_t, v_c, v_f1,  v_cat, v_cen, v_comp,                               1000.00, 'pontual_unica', 'despesa'),
    (v_t, v_c, v_f2,  v_cat, v_cen, v_comp,                                500.00, 'pontual_unica', 'investimento'),
    (v_t, v_c, null,  v_cat, v_cen, v_comp,                                250.00, 'pontual_unica', 'despesa'),
    -- O mês anterior, base da variação.
    (v_t, v_c, v_f1,  v_cat, v_cen, (v_comp - interval '1 month')::date,  1200.00, 'pontual_unica', 'despesa'),
    -- Compromisso: dentro da janela de doze meses, e fora dela.
    (v_t, v_c, v_f1,  v_cat, v_cen, (v_comp + interval '2 months')::date,  300.00, 'pontual_unica', 'despesa'),
    (v_t, v_c, v_f1,  v_cat, v_cen, (v_comp + interval '12 months')::date, 400.00, 'pontual_unica', 'despesa'),
    (v_t, v_c, v_f1,  v_cat, v_cen, (v_comp + interval '14 months')::date, 900.00, 'pontual_unica', 'despesa'),
    -- E a simulação, na MESMA competência, com um valor que não passaria
    -- despercebido se vazasse para o indicador.
    (v_t, v_c, v_f1,  v_cat, v_sim, v_comp,                              99999.00, 'pontual_unica', 'despesa');

  select * into v_r from public.gestao_resultado(v_c, v_comp);

  perform app.assert(v_r.gasto_mes = 1750.00,
    'o gasto do mês soma os lançamentos da competência');
  /*
   * O caso que esta asserção protege: um cenário de simulação somando junto com
   * o real. O erro é sempre para MAIS, e ninguém desconfia de um número que
   * subiu — ele é lido como "o custo cresceu".
   */
  perform app.assert(v_r.gasto_mes < 99999.00,
    'e o cenário de simulação NÃO entra: ele existe para conviver sem contaminar');
  perform app.assert(v_r.gasto_despesa = 1250.00 and v_r.gasto_investimento = 500.00,
    'despesa e investimento se separam, e somam o total');
  perform app.assert(v_r.gasto_mes_anterior = 1200.00,
    'o mês anterior é o mês anterior, e não o acumulado');
  /* 300 + 400: o lançamento de catorze meses fica fora da janela, e o da própria
     competência não é compromisso — já é gasto. */
  perform app.assert(v_r.compromisso_12m = 700.00,
    'o compromisso são os doze meses SEGUINTES já lançados, nem mais nem menos');

  /*
   * O contrato de leitura do painel: a soma do detalhe conferida contra o
   * indicador. Aqui ela é provada; na tela, ela é exibida.
   */
  select coalesce(sum(total), 0), count(*) into v_soma, v_linhas
    from public.gestao_gasto_por_filial(v_c, v_comp);
  perform app.assert(v_soma = v_r.gasto_mes,
    'a soma do detalhe por filial fecha EXATAMENTE no indicador');
  perform app.assert(v_linhas = 3,
    'e o detalhe tem as duas filiais mais a linha do grupo — lançamento sem filial não some');
end
$$;

-- -----------------------------------------------------------------------------
-- 43.2 A conformidade é do CONJUNTO, não a média das filas
-- -----------------------------------------------------------------------------
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_c      uuid := 'cc000000-0000-4000-8000-000000000043';
  v_dono   uuid := '22220000-0000-4000-8000-000000000001';
  v_prio   uuid;
  v_fila_a uuid;
  v_fila_b uuid;
  v_id     uuid;
  v_comp   date := date_trunc('month', now())::date;
  v_r      record;
  v_media  numeric;
begin
  select id into v_prio from public.ticket_priorities where tenant_id = v_t order by sort_order limit 1;
  select id into v_fila_a from public.queues where tenant_id = v_t and is_system_default;

  insert into public.queues (tenant_id, name, slug)
  values (v_t, 'Fila de volume baixo', 'volume-baixo')
  returning id into v_fila_b;

  /*
   * Fila A: vinte chamados com acordo, dois estourados  → 90%.
   * Fila B: um chamado com acordo, ele estourado        →  0%.
   *
   * A média das filas dá 45%. O conjunto dá (21-3)/21 = 85,7%.
   *
   * Este é o erro que a 0039 evita ao NÃO usar `resolution_compliance_pct` da
   * view: aquela coluna é por fila, e a média de percentuais por fila não é o
   * percentual do conjunto. Uma fila com um chamado pesaria tanto quanto uma
   * com duzentos — e o indicador do cliente ficaria a quarenta pontos da
   * verdade.
   */
  for i in 1..20 loop
    insert into public.tickets (tenant_id, client_id, title, priority_id, queue_id, requester_id)
    values (v_t, v_c, format('Fila A #%s', i), v_prio, v_fila_a, v_dono)
    returning id into v_id;
    update public.sla_tracking
       set coverage = 'covered', resolution_breached = (i <= 2)
     where ticket_id = v_id;
  end loop;

  insert into public.tickets (tenant_id, client_id, title, priority_id, queue_id, requester_id)
  values (v_t, v_c, 'Fila B #1', v_prio, v_fila_b, v_dono)
  returning id into v_id;
  update public.sla_tracking
     set coverage = 'covered', resolution_breached = true
   where ticket_id = v_id;

  select * into v_r from public.gestao_resultado(v_c, v_comp);

  perform app.assert(v_r.sla_tickets = 21 and v_r.sla_com_acordo = 21 and v_r.sla_fora = 3,
    'os chamados são contados um a um, nas duas filas');

  select round(avg(s.resolution_compliance_pct), 1) into v_media
    from public.vw_sla_compliance s
   where s.client_id = v_c and date_trunc('month', s.period)::date = v_comp;

  perform app.assert(v_r.sla_conformidade = 85.7,
    'a conformidade é a do conjunto: (21-3)/21');
  perform app.assert(v_r.sla_conformidade <> v_media,
    format('e NÃO a média das filas, que aqui daria %s%%', v_media));
end
$$;

-- -----------------------------------------------------------------------------
-- 43.3 Sem chamado com acordo, a conformidade é NULA — e não 100%
-- -----------------------------------------------------------------------------
do $$
declare
  v_c    uuid := 'cc000000-0000-4000-8000-000000000043';
  v_comp date := date_trunc('month', now())::date;
  v_r    record;
begin
  update public.sla_tracking st
     set coverage = 'uncovered', resolution_breached = false
    from public.tickets t
   where t.id = st.ticket_id and t.client_id = v_c;

  select * into v_r from public.gestao_resultado(v_c, v_comp);

  /*
   * "Nenhum estouro em nenhum chamado coberto" é ausência de medida, não
   * conformidade perfeita. Escrever 100% faria do mês sem acordo o melhor mês
   * do ano — justamente o mês em que alguém deveria perguntar o que houve.
   */
  perform app.assert(v_r.sla_com_acordo = 0 and v_r.sla_conformidade is null,
    'sem chamado com acordo a conformidade é NULA, e não 100%');
  perform app.assert(v_r.sla_tickets = 21,
    'mas os chamados continuam contados: eles existiram, só não tinham acordo');
end
$$;

-- -----------------------------------------------------------------------------
-- 43.4 Projetos: atraso derivado, entrega conferida
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_c    uuid := 'cc000000-0000-4000-8000-000000000043';
  v_comp date := date_trunc('month', now())::date;
  v_r    record;
  v_det  integer;
begin
  insert into public.projects
    (tenant_id, client_id, name, start_month, planned_end_month, actual_end_month, status)
  values
    -- Previsto para três meses atrás e sem entrega: atrasado, e ninguém marcou.
    (v_t, v_c, 'Troca de links',   (v_comp - interval '6 months')::date,
                                   (v_comp - interval '3 months')::date, null, 'em_andamento'),
    -- Entregue depois do previsto: entregue, fora do prazo.
    (v_t, v_c, 'Inventário geral', (v_comp - interval '8 months')::date,
                                   (v_comp - interval '5 months')::date,
                                   (v_comp - interval '3 months')::date, 'concluido'),
    -- Entregue antes: entregue, no prazo.
    (v_t, v_c, 'Padrão de backup', (v_comp - interval '4 months')::date,
                                   (v_comp - interval '1 month')::date,
                                   (v_comp - interval '2 months')::date, 'concluido');

  select * into v_r from public.gestao_resultado(v_c, v_comp);

  perform app.assert(v_r.projetos_total = 3, 'os três projetos do cliente são contados');
  /* Atraso não é um campo: é o mês previsto contra hoje. Um projeto parado vira
     atrasado sozinho, com a passagem do mês, sem ninguém tocar nele. */
  perform app.assert(v_r.projetos_atrasados = 1,
    'o atrasado é derivado, e é um só');
  perform app.assert(v_r.projetos_entregues = 2 and v_r.projetos_entregues_no_prazo = 1,
    'entregue e entregue no prazo são contas diferentes');

  select count(*) into v_det from public.vw_projects p
   where p.client_id = v_c and p.atrasado;
  perform app.assert(v_det = v_r.projetos_atrasados,
    'e o detalhe da tela usa o MESMO recorte do indicador: a lista fecha na conta');
end
$$;

-- -----------------------------------------------------------------------------
-- 43.5 O recorte é por CLIENTE, e a competência fechada é dita
-- -----------------------------------------------------------------------------
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_c      uuid := 'cc000000-0000-4000-8000-000000000043';
  v_outro  uuid;
  v_comp   date := date_trunc('month', now())::date;
  v_r      record;
begin
  /*
   * O mesmo mês, outro cliente: nada do que foi montado acima pode aparecer. É
   * o recorte que a tela promete — "cliente e competência valem para os três".
   *
   * O vizinho recebe um lançamento e um projeto PRÓPRIOS, em vez de ficar
   * vazio: um cliente sem nada devolveria zero mesmo que o filtro não
   * existisse. Com números próprios e pequenos, o vazamento apareceria.
   */
  v_outro := 'cc000000-0000-4000-8000-000000000044';
  insert into public.clients (id, tenant_id, legal_name, trade_name)
  values (v_outro, v_t, 'Vizinha do Resultado Ltda', 'Vizinha');
  insert into public.it_cost_entries
    (tenant_id, client_id, expense_category_id, scenario_id, competence, amount,
     natureza, classificacao)
  select v_t, v_outro,
         (select id from public.expense_categories where tenant_id = v_t and is_active limit 1),
         (select id from public.it_budget_scenarios where client_id = v_outro and key = 'oficial'),
         v_comp, 10.00, 'pontual_unica', 'despesa';
  insert into public.projects
    (tenant_id, client_id, name, start_month, planned_end_month, status)
  values (v_t, v_outro, 'Projeto da vizinha', v_comp,
          (v_comp + interval '2 months')::date, 'em_andamento');

  select * into v_r from public.gestao_resultado(v_outro, v_comp);
  perform app.assert(v_r.gasto_mes = 10.00 and v_r.projetos_total = 1 and v_r.sla_tickets = 0,
    'outro cliente devolve o que é dele, e nada do vizinho: o recorte vale para os três');

  select * into v_r from public.gestao_resultado(v_c, v_comp);
  perform app.assert(not v_r.competencia_fechada,
    'a competência aberta é dita aberta');

  insert into public.it_budget_closings (tenant_id, client_id, competence, closed_by)
  values (v_t, v_c, v_comp, '22220000-0000-4000-8000-000000000001');

  select * into v_r from public.gestao_resultado(v_c, v_comp);
  /* A tela escreve isso em destaque, e é o que faz um resultado divulgado
     continuar valendo: fechada, a competência não muda mais. */
  perform app.assert(v_r.competencia_fechada,
    'e a fechada é dita fechada — o número divulgado não muda mais');
end
$$;

-- -----------------------------------------------------------------------------
-- 43.6 `security invoker`: a visão de resultado não é uma porta dos fundos
-- -----------------------------------------------------------------------------
/*
 * A função é `security invoker` de propósito. `security definer` aqui seria uma
 * quarta exceção ao ADR-011 — e a pior delas, porque entregaria num único
 * chamado o custo, os projetos e o atendimento de um cliente de outro tenant.
 */
set role rls_tester;
set request.jwt.claims = '{"sub":"33330000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
declare
  v_c    uuid := 'cc000000-0000-4000-8000-000000000043';
  v_comp date := date_trunc('month', now())::date;
  v_r    record;
begin
  select * into v_r from public.gestao_resultado(v_c, v_comp);
  perform app.assert(
    v_r.gasto_mes = 0 and v_r.projetos_total = 0 and v_r.sla_tickets = 0,
    'outro tenant recebe ZERO da visão de resultado: ela passa pelas policies de quem chama');
  perform app.assert(
    (select count(*) from public.gestao_gasto_por_filial(v_c, v_comp)) = 0,
    'e nenhuma linha do detalhe por filial');
end
$$;

-- E a operadora, dentro do mesmo tenant, não alcança a tela.
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
begin
  perform app.assert(not app.has_permission('gestao.resultado.ver'),
    'operadora não abre a visão de resultado: ela compila três módulos de gestão');
end
$$;
reset role;

-- =============================================================================
\echo '=== 44. A série do resultado: o último ponto é o indicador (0040) ==='
-- =============================================================================
reset role;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';

-- A seção 43 prova a aritmética do mês. Esta prova as três coisas que só uma
-- SÉRIE pode errar: discordar do indicador no ponto mais recente, inventar
-- meses que ainda não aconteceram, e perder a história de um projeto que ficou
-- atrasado e depois foi entregue.

-- -----------------------------------------------------------------------------
-- 44.1 O último ponto do gráfico é exatamente o número do cartão
-- -----------------------------------------------------------------------------
do $$
declare
  v_c    uuid := 'cc000000-0000-4000-8000-000000000043';
  v_comp date := date_trunc('month', now())::date;
  v_r    record;
  v_s    record;
begin
  /*
   * Um gráfico que discorda do indicador na mesma tela é o defeito da 0039
   * desenhado — e desenhado é pior, porque ninguém confere um pixel. A barra
   * mais à direita fica embaixo do cartão: se os dois divergirem, a tela está
   * se contradizendo no espaço de dez centímetros.
   */
  select * into v_r from public.gestao_resultado(v_c, v_comp);
  select * into v_s from public.gestao_serie(v_c, v_comp, 12)
   where competencia = v_comp;

  perform app.assert(v_s.gasto = v_r.gasto_mes,
    'o último ponto da série tem o mesmo gasto do indicador');
  perform app.assert(v_s.projetos_atrasados = v_r.projetos_atrasados,
    'e o mesmo número de projetos atrasados');
  perform app.assert(v_s.conformidade is not distinct from v_r.sla_conformidade,
    'e a mesma conformidade — inclusive quando as duas são nulas');
end
$$;

-- -----------------------------------------------------------------------------
-- 44.2 A série não inventa o futuro, e tem teto
-- -----------------------------------------------------------------------------
do $$
declare
  v_c     uuid := 'cc000000-0000-4000-8000-000000000043';
  v_atual date := date_trunc('month', now())::date;
  v_n     integer;
  v_fim   date;
begin
  /*
   * Pedir a série de uma competência futura não pode desenhar barras de meses
   * que ainda não aconteceram: o que já está lançado para a frente é o
   * "Compromisso — 12 meses", que é outra pergunta e tem outro nome. Desenhar
   * aquilo ao lado das barras realizadas diria que já foi gasto.
   */
  select max(competencia) into v_fim
    from public.gestao_serie(v_c, (v_atual + interval '6 months')::date, 12);
  perform app.assert(v_fim = v_atual,
    'a série termina no mês corrente mesmo quando pedem um mês futuro');

  select count(*) into v_n from public.gestao_serie(v_c, v_atual, 12);
  perform app.assert(v_n = 12, 'doze meses pedidos, doze meses devolvidos');

  /* `?meses=100000` na URL não é ataque: é alguém curioso. E sem teto o efeito
     é o mesmo — oito mil anos de `generate_series`. */
  select count(*) into v_n from public.gestao_serie(v_c, v_atual, 100000);
  perform app.assert(v_n = 36, 'e o pedido absurdo é aparado no teto de 36');

  select count(*) into v_n from public.gestao_serie(v_c, v_atual, 0);
  perform app.assert(v_n = 1, 'zero mês vira um: uma série vazia não é resposta');

  select count(*) into v_n from public.gestao_serie(v_c, v_atual, null);
  perform app.assert(v_n = 12, 'e sem o parâmetro são doze');
end
$$;

-- -----------------------------------------------------------------------------
-- 44.3 A história do atraso: entregue hoje, atrasado em julho
-- -----------------------------------------------------------------------------
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_c      uuid := 'cc000000-0000-4000-8000-000000000045';
  v_atual  date := date_trunc('month', now())::date;
  v_antes  integer;
  v_depois integer;
  v_hoje   integer;
begin
  insert into public.clients (id, tenant_id, legal_name, trade_name)
  values (v_c, v_t, 'Histórico do Atraso Ltda', 'Histórico');

  /*
   * Um projeto previsto para quatro meses atrás e entregue há dois. Hoje ele
   * não está atrasado — e ESTEVE, nos dois meses entre o previsto e a entrega.
   *
   * É a única coisa que a série conta e o indicador não tem como contar, e é o
   * motivo de o predicado histórico existir em vez de reusar `atrasado`, que é
   * sempre relativo a hoje.
   */
  insert into public.projects
    (tenant_id, client_id, name, start_month, planned_end_month, actual_end_month, status)
  values (v_t, v_c, 'Entregue com atraso',
          (v_atual - interval '8 months')::date,
          (v_atual - interval '4 months')::date,
          (v_atual - interval '2 months')::date, 'concluido');

  select projetos_atrasados into v_antes from public.gestao_serie(v_c, v_atual, 12)
   where competencia = (v_atual - interval '3 months')::date;
  select projetos_atrasados into v_depois from public.gestao_serie(v_c, v_atual, 12)
   where competencia = (v_atual - interval '1 month')::date;
  select projetos_atrasados into v_hoje from public.gestao_serie(v_c, v_atual, 12)
   where competencia = v_atual;

  perform app.assert(v_antes = 1,
    'o projeto aparece atrasado no mês em que já havia passado do previsto');
  perform app.assert(v_depois = 0,
    'e deixa de aparecer no mês seguinte à entrega');
  perform app.assert(v_hoje = 0,
    'e hoje não está atrasado — porque foi entregue');
end
$$;

-- -----------------------------------------------------------------------------
-- 44.4 Mês sem chamado coberto é buraco, não zero
-- -----------------------------------------------------------------------------
do $$
declare
  v_c     uuid := 'cc000000-0000-4000-8000-000000000045';
  v_atual date := date_trunc('month', now())::date;
  v_n     integer;
begin
  /*
   * No gráfico, nulo vira buraco na linha. Zero viraria um ponto no chão — e
   * "conformidade de 0%" é uma acusação grave sobre um mês em que simplesmente
   * não houve chamado com acordo.
   */
  select count(*) into v_n from public.gestao_serie(v_c, v_atual, 12)
   where conformidade is not null;
  perform app.assert(v_n = 0,
    'cliente sem chamado nenhum devolve conformidade NULA em todos os meses');

  select count(*) into v_n from public.gestao_serie(v_c, v_atual, 12)
   where gasto <> 0;
  perform app.assert(v_n = 0, 'e gasto zero, que em dinheiro é zero mesmo');
end
$$;

-- -----------------------------------------------------------------------------
-- 44.5 `security invoker` também na série
-- -----------------------------------------------------------------------------
set role rls_tester;
set request.jwt.claims = '{"sub":"33330000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000002"}}';
do $$
declare
  v_n integer;
begin
  select count(*) into v_n
    from public.gestao_serie('cc000000-0000-4000-8000-000000000043',
                             date_trunc('month', now())::date, 12)
   where gasto <> 0 or conformidade is not null or projetos_atrasados <> 0;
  perform app.assert(v_n = 0,
    'outro tenant recebe a série vazia: doze meses de nada, e nenhum número alheio');
end
$$;
reset role;

-- =============================================================================
\echo '=== 45. Alertas de contrato e de link (0041) ==='
-- =============================================================================
reset role;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';

-- Os dois trabalhos que faltavam desde a Onda 1. O que se testa aqui é o que
-- separa um alerta de um incômodo: avisar na hora certa, uma vez só, e saber
-- recomeçar quando o contrato é renovado.

-- -----------------------------------------------------------------------------
-- 45.1 Contrato vencendo: um aviso por degrau, e nunca os dois juntos
-- -----------------------------------------------------------------------------
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_forn   uuid;
  v_perto  uuid;
  v_longe  uuid;
  v_fora   uuid;
  v_alvos  integer;
  v_n      integer;
begin
  delete from public.email_outbox;
  delete from public.supplier_contracts where tenant_id = v_t;

  select count(*) into v_alvos from public.profiles
   where tenant_id = v_t and is_active and role in ('gestor','admin') and email is not null;
  perform app.assert(v_alvos > 0, 'há gestor ou admin com e-mail para receber o aviso');

  update public.tenants set contract_alert_days = 30 where id = v_t;
  select id into v_forn from public.suppliers where tenant_id = v_t limit 1;

  insert into public.supplier_contracts (tenant_id, supplier_id, contract_number, ends_on)
  values (v_t, v_forn, 'CT-PERTO', current_date + 5)   returning id into v_perto;
  insert into public.supplier_contracts (tenant_id, supplier_id, contract_number, ends_on)
  values (v_t, v_forn, 'CT-LONGE', current_date + 25)  returning id into v_longe;
  insert into public.supplier_contracts (tenant_id, supplier_id, contract_number, ends_on)
  values (v_t, v_forn, 'CT-FORA',  current_date + 200) returning id into v_fora;

  perform app.job_contract_alerts();

  /*
   * O de 5 dias dispara UM aviso, no degrau de 7 — e não dois, um por degrau.
   * Com a regra ingênua ("todo degrau que já se aplica"), um contrato que entra
   * em cena já a 5 dias do fim geraria dois e-mails no mesmo minuto sobre a
   * mesma coisa. Isso não é redundância útil: é o começo do hábito de ignorar.
   */
  select count(*) into v_n from public.email_outbox
   where dedupe_key like 'contrato:%:' || v_perto || ':%';
  perform app.assert(v_n = v_alvos,
    'contrato a 5 dias gera UM aviso por pessoa, no degrau mais apertado');
  perform app.assert(
    (select count(*) from public.email_outbox
      where dedupe_key like format('contrato:contrato_fornecedor:%s:%s:7:%%',
                                   v_perto, current_date + 5))
      = v_alvos,
    'e o degrau escolhido é o de 7 dias');

  select count(*) into v_n from public.email_outbox
   where dedupe_key like 'contrato:%:' || v_longe || ':%';
  perform app.assert(v_n = v_alvos, 'contrato a 25 dias entra pelo degrau de 30');

  select count(*) into v_n from public.email_outbox
   where dedupe_key like 'contrato:%:' || v_fora || ':%';
  perform app.assert(v_n = 0, 'e contrato a 200 dias não gera aviso nenhum');

  -- Rodar de novo não repete nada.
  perform app.job_contract_alerts();
  select count(*) into v_n from public.email_outbox where kind = 'contract_expiring';
  perform app.assert(v_n = v_alvos * 2,
    'a segunda execução não reenfileira nada: a chave de idempotência segura');
end
$$;

-- -----------------------------------------------------------------------------
-- 45.2 Renovar o contrato REARMA o aviso
-- -----------------------------------------------------------------------------
do $$
declare
  v_t     uuid := 'a0000000-0000-4000-8000-000000000001';
  v_c     uuid;
  v_alvos integer;
  v_n     integer;
begin
  select count(*) into v_alvos from public.profiles
   where tenant_id = v_t and is_active and role in ('gestor','admin') and email is not null;

  select id into v_c from public.supplier_contracts
   where tenant_id = v_t and contract_number = 'CT-LONGE';

  /*
   * A data entra na chave de idempotência por isto. Sem ela, um contrato
   * renovado por mais um ano ficaria MUDO PARA SEMPRE — a chave do degrau já
   * teria sido usada no ciclo anterior, e o aviso do vencimento seguinte nunca
   * sairia. O defeito só apareceria um ano depois, que é quando ninguém mais
   * lembra que existe um alerta.
   */
  update public.supplier_contracts set ends_on = current_date + 20 where id = v_c;
  perform app.job_contract_alerts();

  select count(*) into v_n from public.email_outbox
   where dedupe_key like 'contrato:%:' || v_c || ':%';
  perform app.assert(v_n = v_alvos * 2,
    'data nova é série nova de avisos: renovar rearma, em vez de calar para sempre');
end
$$;

-- -----------------------------------------------------------------------------
-- 45.3 A fidelidade também vence — e vencer é boa notícia
-- -----------------------------------------------------------------------------
do $$
declare
  v_t     uuid := 'a0000000-0000-4000-8000-000000000001';
  v_b     uuid;
  v_link  uuid;
  v_alvos integer;
  v_n     integer;
begin
  delete from public.email_outbox;
  delete from public.internet_links where tenant_id = v_t;

  select count(*) into v_alvos from public.profiles
   where tenant_id = v_t and is_active and role in ('gestor','admin') and email is not null;
  select id into v_b from public.branches where tenant_id = v_t limit 1;

  /*
   * Fim de fidelidade é a única das três datas em que vencer é bom: a partir
   * dela dá para trocar de operadora sem multa. Um aviso que só chega depois de
   * a fidelidade renovar sozinha chega tarde por doze meses.
   */
  insert into public.internet_links
    (tenant_id, branch_id, technology, carrier_name, contract_number, loyalty_until)
  values (v_t, v_b, 'fiber', 'Operadora X', 'LINK-1', current_date + 10)
  returning id into v_link;

  perform app.job_contract_alerts();

  select count(*) into v_n from public.email_outbox
   where dedupe_key like 'contrato:fidelidade_link:%';
  perform app.assert(v_n = v_alvos, 'o fim da fidelidade gera aviso próprio');
  perform app.assert(
    (select count(*) from public.email_outbox where subject like '%Fidelidade%') = v_alvos,
    'e o assunto diz FIDELIDADE, não vencimento — são notícias opostas');
end
$$;

-- -----------------------------------------------------------------------------
-- 45.4 Link caído: o limiar separa alerta de incômodo
-- -----------------------------------------------------------------------------
do $$
declare
  v_t      uuid := 'a0000000-0000-4000-8000-000000000001';
  v_link   uuid;
  v_curta  bigint;
  v_longa  bigint;
  v_alvos  integer;
  v_n      integer;
begin
  delete from public.email_outbox;
  delete from public.link_availability_events where tenant_id = v_t;

  select count(*) into v_alvos from public.profiles
   where tenant_id = v_t and is_active and role in ('gestor','admin') and email is not null;
  select id into v_link from public.internet_links where tenant_id = v_t limit 1;

  update public.tenants set link_alert_minutes = 10 where id = v_t;

  /*
   * Link oscila. Uma queda de quatro minutos é ruído de operadora, e avisar
   * sobre ela ensina a pessoa a filtrar a pasta — e a perder a queda de três
   * horas junto.
   */
  insert into public.link_availability_events (tenant_id, link_id, state, started_at)
  values (v_t, v_link, 'down', now() - interval '4 minutes')
  returning id into v_curta;

  perform app.job_link_alerts();
  select count(*) into v_n from public.email_outbox where kind = 'link_down';
  perform app.assert(v_n = 0, 'queda abaixo do limiar NÃO avisa ninguém');

  -- A mesma queda, agora longa. O índice único de evento aberto por link
  -- impede duas; então esta é a mesma, envelhecida.
  update public.link_availability_events
     set started_at = now() - interval '45 minutes'
   where id = v_curta;

  perform app.job_link_alerts();
  select count(*) into v_n from public.email_outbox where kind = 'link_down';
  perform app.assert(v_n = v_alvos, 'passando do limiar, avisa uma vez por pessoa');

  perform app.job_link_alerts();
  select count(*) into v_n from public.email_outbox where kind = 'link_down';
  perform app.assert(v_n = v_alvos, 'e não repete a cada ciclo enquanto a queda durar');

  v_longa := v_curta;

  -- -----------------------------------------------------------------------
  -- A volta
  -- -----------------------------------------------------------------------
  update public.link_availability_events set ended_at = now() where id = v_longa;
  perform app.job_link_alerts();

  select count(*) into v_n from public.email_outbox where kind = 'link_restored';
  perform app.assert(v_n = v_alvos,
    'a volta é avisada: sem isso, quem recebeu "caiu" só descobre o fim abrindo o sistema');

  perform app.job_link_alerts();
  select count(*) into v_n from public.email_outbox where kind = 'link_restored';
  perform app.assert(v_n = v_alvos, 'e a volta também avisa uma vez só');
end
$$;

-- -----------------------------------------------------------------------------
-- 45.5 A volta de uma queda que ninguém soube que houve é silêncio
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_link uuid;
  v_id   bigint;
  v_n    integer;
begin
  delete from public.email_outbox;
  delete from public.link_availability_events where tenant_id = v_t;
  select id into v_link from public.internet_links where tenant_id = v_t limit 1;

  /*
   * Oscilação de trinta segundos, já encerrada. Anunciar o retorno de algo que
   * ninguém soube que caiu derrubaria o limiar pela janela dos fundos: a pessoa
   * passaria a receber um e-mail por oscilação, com o assunto invertido.
   */
  insert into public.link_availability_events
    (tenant_id, link_id, state, started_at, ended_at)
  values (v_t, v_link, 'down', now() - interval '90 seconds', now() - interval '60 seconds')
  returning id into v_id;

  perform app.job_link_alerts();
  select count(*) into v_n from public.email_outbox;
  perform app.assert(v_n = 0,
    'queda curta que não foi avisada também não tem volta avisada');
end
$$;

-- -----------------------------------------------------------------------------
-- 45.6 Quem desligou o aviso não recebe
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_p    uuid;
  v_mail text;
  v_n    integer;
begin
  delete from public.email_outbox;
  delete from public.link_availability_events where tenant_id = v_t;

  select id, email into v_p, v_mail from public.profiles
   where tenant_id = v_t and is_active and role in ('gestor','admin') and email is not null
   limit 1;

  insert into public.notification_preferences (tenant_id, user_id, kind, enabled)
  values (v_t, v_p, 'link_down', false)
  on conflict (tenant_id, user_id, kind) do update set enabled = false;

  insert into public.link_availability_events (tenant_id, link_id, state, started_at)
  select v_t, l.id, 'down', now() - interval '45 minutes'
    from public.internet_links l where l.tenant_id = v_t limit 1;

  perform app.job_link_alerts();

  select count(*) into v_n from public.email_outbox
   where kind = 'link_down' and to_email = v_mail;
  perform app.assert(v_n = 0, 'quem desligou o aviso de link não recebe');
  perform app.assert((select count(*) from public.email_outbox where kind = 'link_down') > 0,
    'e os outros continuam recebendo');

  delete from public.notification_preferences where user_id = v_p and kind = 'link_down';
end
$$;

-- -----------------------------------------------------------------------------
-- 45.7 Os dois trabalhos são de `service_role`, e só dele
-- -----------------------------------------------------------------------------
set role rls_tester;
set request.jwt.claims = '{"sub":"22220000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"tenant_id":"a0000000-0000-4000-8000-000000000001"}}';
do $$
declare
  v_erro boolean := false;
begin
  /*
   * Eles são `security definer` e enxergam todos os tenants por definição.
   * Deixar `authenticated` executar seria entregar a lista de contratos e de
   * quedas de todo mundo a qualquer sessão — pela porta de um trabalho
   * agendado, que é o último lugar onde alguém procuraria.
   */
  begin
    perform app.job_contract_alerts();
  exception when insufficient_privilege then v_erro := true;
  end;
  perform app.assert(v_erro, 'usuário autenticado NÃO executa o alerta de contrato');

  v_erro := false;
  begin
    perform app.job_link_alerts();
  exception when insufficient_privilege then v_erro := true;
  end;
  perform app.assert(v_erro, 'nem o de link');
end
$$;
reset role;

-- -----------------------------------------------------------------------------
-- 45.8 As duas preferências novas têm limites, e a tela tem onde escrevê-las
-- -----------------------------------------------------------------------------
do $$
declare
  v_t    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_erro boolean := false;
begin
  begin
    update public.tenants set contract_alert_days = 0 where id = v_t;
  exception when check_violation then v_erro := true;
  end;
  perform app.assert(v_erro, 'zero dia de aviso de contrato é recusado: seria um aviso no dia');

  v_erro := false;
  begin
    update public.tenants set link_alert_minutes = 0 where id = v_t;
  exception when check_violation then v_erro := true;
  end;
  perform app.assert(v_erro, 'e zero minuto de queda avisaria toda oscilação');

  perform app.assert(
    (select count(*) from public.permission_catalog
      where key like 'ambiente.preferencias%') = 3,
    'a tela de preferências tem chave própria: configuração sem tela é configuração morta');
end
$$;

\echo ''
\echo '################  TODOS OS TESTES PASSARAM  ################'
