-- =============================================================================
-- 0030 — Os três trabalhos agendados
-- =============================================================================
-- A regra de QUEM avisar e QUANDO mora aqui, no SQL, pelo motivo dito na 0029:
-- é onde os dados estão, e é onde as asserções de schema conseguem provar a
-- regra. A aplicação só esvazia a caixa de saída.
--
-- As três funções são `security definer` com execução concedida apenas a
-- `service_role`, e `set search_path` fixo. Um trabalho agendado não tem sessão
-- de usuário por definição — não existe `auth.uid()` às três da manhã.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Alerta de SLA
-- -----------------------------------------------------------------------------
-- **Quem recebe.** O responsável pelo ticket. Quando não há responsável — que é
-- justamente o caso perigoso — o aviso vai para quem pode fazer alguma coisa a
-- respeito: os papéis `gestor` e `admin` ativos do tenant. Ticket sem dono
-- estourando SLA em silêncio é a pior combinação possível.
--
-- **Quantas vezes.** Uma por pessoa, por estado, por vida do ticket. A chave de
-- idempotência inclui `reopened_count`: ticket reaberto é um novo ciclo de
-- atendimento e merece novo aviso, mas ticket parado em `critical` por três dias
-- não gera três avisos por dia.
--
-- **O que NÃO entra.** `coverage <> 'covered'` fica de fora: ticket que nenhuma
-- definição de SLA alcançou não tem prazo para estourar. Avisar sobre ele seria
-- cobrar uma promessa que ninguém fez — e esconderia os que têm prazo de
-- verdade no meio do ruído.
create or replace function app.job_sla_alerts()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id bigint;
  v_count  integer := 0;
begin
  insert into public.job_runs (job) values ('sla_alerts') returning id into v_run_id;

  with candidatos as (
    select
      t.id            as ticket_id,
      t.tenant_id,
      t.ticket_number,
      t.title,
      t.assignee_id,
      t.reopened_count,
      app.sla_state(st.resolution_due_at, st.resolved_at, st.resolution_breached,
                    tn.sla_warning_pct, tn.sla_critical_pct, st.started_at) as estado
    from public.tickets t
    join public.sla_tracking st on st.ticket_id = t.id
    join public.tenants tn      on tn.id = t.tenant_id
    where t.deleted_at is null
      and tn.deleted_at is null
      and t.status not in ('resolved', 'closed')
      and st.coverage = 'covered'
      and not st.is_paused
  ),
  alvos as (
    select c.*, p.id as user_id, p.email, p.full_name
    from candidatos c
    join public.profiles p
      on p.tenant_id = c.tenant_id
     and p.is_active
     and (
       -- com responsável: só ele
       (c.assignee_id is not null and p.id = c.assignee_id)
       -- sem responsável: quem pode agir
       or (c.assignee_id is null and p.role in ('gestor', 'admin'))
     )
    where c.estado in ('warning', 'critical', 'breached')
      and p.email is not null
  ),
  gravadas as (
    insert into public.email_outbox
      (tenant_id, to_email, to_name, subject, body_text, kind, ticket_id, dedupe_key)
    select
      a.tenant_id,
      a.email,
      a.full_name,
      case a.estado
        when 'warning'  then format('[SLA] Prazo se aproximando — chamado #%s', a.ticket_number)
        when 'critical' then format('[SLA] Prazo crítico — chamado #%s', a.ticket_number)
        else                 format('[SLA] Prazo ESTOURADO — chamado #%s', a.ticket_number)
      end,
      format(
        E'Chamado #%s — %s\n\n%s\n\nAbra o chamado em /tickets/%s',
        a.ticket_number, a.title,
        case a.estado
          when 'warning'  then 'O prazo de resolução está se aproximando.'
          when 'critical' then 'O prazo de resolução está perto de estourar.'
          else                 'O prazo de resolução foi ultrapassado.'
        end,
        a.ticket_id),
      case a.estado
        when 'warning'  then 'sla_warning'
        when 'critical' then 'sla_critical'
        else                 'sla_breach'
      end,
      a.ticket_id,
      format('sla:%s:%s:%s:%s', a.ticket_id, a.reopened_count, a.estado, a.user_id)
    from alvos a
    where app.quer_notificacao(
            a.user_id,
            case a.estado
              when 'warning'  then 'sla_warning'
              when 'critical' then 'sla_critical'
              else                 'sla_breach'
            end)
    -- A chave única faz o resto: o que já foi enfileirado não entra de novo.
    on conflict do nothing
    returning 1
  )
  select count(*) into v_count from gravadas;

  update public.job_runs
     set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;

  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Fechamento automático
-- -----------------------------------------------------------------------------
-- `tenants.auto_close_after_days` existe desde a migração 0002 e **nunca foi
-- executado**. Esta função é o que faltava.
--
-- `0` desliga o recurso para aquele tenant — e por isso o filtro é `> 0`, não
-- `>= 0`: com zero, todo ticket resolvido fecharia no mesmo instante em que foi
-- resolvido, e a pessoa perderia a janela para dizer "não resolveu, não".
--
-- A transição `resolved → closed` já existe em `ticket_status_transitions`
-- (migração 0005), então a trigger de máquina de estados aceita. Não há regra
-- nova aqui: há a execução da regra que já estava declarada.
--
-- `change_source = 'system'` distingue o fechamento automático do manual no
-- histórico — e é o que a sincronização reversa usa para não ecoar de volta para
-- a integração (ADR-008).
create or replace function app.job_auto_close()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id bigint;
  v_count  integer := 0;
begin
  insert into public.job_runs (job) values ('auto_close') returning id into v_run_id;

  with fechados as (
    update public.tickets t
       set status = 'closed',
           closed_at = now(),
           change_source = 'system'
      from public.tenants tn
     where tn.id = t.tenant_id
       and t.deleted_at is null
       and tn.deleted_at is null
       and t.status = 'resolved'
       and t.resolved_at is not null
       and tn.auto_close_after_days > 0
       and t.resolved_at < now() - make_interval(days => tn.auto_close_after_days)
    returning 1
  )
  select count(*) into v_count from fechados;

  update public.job_runs
     set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;

  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Convite de avaliação
-- -----------------------------------------------------------------------------
-- Vai para quem ABRIU o chamado, e só depois de ele estar fechado.
--
-- **Por que no fechamento e não na resolução:** entre resolvido e fechado a
-- pessoa ainda pode reabrir. Perguntar "como foi o atendimento?" para quem está
-- prestes a dizer "não resolveu" é a pior hora possível para perguntar.
--
-- **O token.** Gerado aqui em claro, guardado só como hash, e escrito no corpo
-- da mensagem como caminho relativo (`/avaliar/<token>`). Quem completa o
-- endereço é a aplicação, no momento do envio — o banco não conhece o domínio
-- público, e inventá-lo numa coluna seria a terceira cópia de uma configuração
-- que já vive em `NEXT_PUBLIC_SITE_URL`.
--
-- O corpo da mensagem carrega o token em claro até o envio. É o mesmo nível de
-- exposição do próprio e-mail, a caixa de saída só é legível por administrador, e
-- a aplicação apaga o corpo depois de enviar — ver `drenarCaixaDeSaida`.
--
-- **Validade de 30 dias:** avaliação de um atendimento de dois meses atrás não
-- mede atendimento, mede memória.
create or replace function app.job_satisfaction_invites()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id bigint;
  v_count  integer := 0;
  v_t      record;
  v_token  text;
begin
  insert into public.job_runs (job) values ('satisfaction_invites') returning id into v_run_id;

  for v_t in
    select t.id, t.tenant_id, t.ticket_number, t.title, p.id as user_id, p.email, p.full_name
      from public.tickets t
      join public.profiles p on p.id = t.requester_id and p.tenant_id = t.tenant_id
      join public.tenants tn on tn.id = t.tenant_id
     where t.deleted_at is null
       and tn.deleted_at is null
       and t.status = 'closed'
       and t.closed_at is not null
       -- Janela de 7 dias: o trabalho não vai varrer o histórico inteiro toda
       -- noite procurando chamado fechado em 2024.
       and t.closed_at > now() - interval '7 days'
       and p.email is not null
       and p.is_active
       and not exists (select 1 from public.ticket_satisfaction s where s.ticket_id = t.id)
       and app.quer_notificacao(p.id, 'satisfaction_invite')
  loop
    v_token := encode(gen_random_bytes(24), 'hex');

    insert into public.ticket_satisfaction (ticket_id, tenant_id, token_hash, expires_at)
    values (v_t.id, v_t.tenant_id,
            encode(digest(v_token, 'sha256'), 'hex'),
            now() + interval '30 days')
    on conflict (ticket_id) do nothing;

    if found then
      insert into public.email_outbox
        (tenant_id, to_email, to_name, subject, body_text, kind, ticket_id, dedupe_key)
      values (
        v_t.tenant_id, v_t.email, v_t.full_name,
        format('Como foi o atendimento do chamado #%s?', v_t.ticket_number),
        format(
          E'Olá, %s.\n\nO chamado #%s — %s — foi encerrado.\n\n'
          'Responda em menos de um minuto, clicando na nota de 1 a 5:\n'
          '/avaliar/%s\n\nO link vale por 30 dias.',
          coalesce(v_t.full_name, 'tudo bem'), v_t.ticket_number, v_t.title, v_token),
        'satisfaction_invite', v_t.id,
        format('csat:%s', v_t.id))
      on conflict do nothing;

      v_count := v_count + 1;
    end if;
  end loop;

  update public.job_runs
     set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;

  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Quem pode executar
-- -----------------------------------------------------------------------------
-- Só `service_role`. `authenticated` NÃO recebe: as três funções leem e escrevem
-- atravessando tenants, e é exatamente por isso que elas são o terceiro uso
-- declarado da chave de serviço (ver o cabeçalho da 0029). Conceder a
-- `authenticated` transformaria qualquer pessoa logada num disparador de e-mail
-- para a base inteira.
revoke all on function app.job_sla_alerts() from public;
revoke all on function app.job_auto_close() from public;
revoke all on function app.job_satisfaction_invites() from public;

grant execute on function app.job_sla_alerts() to service_role;
grant execute on function app.job_auto_close() to service_role;
grant execute on function app.job_satisfaction_invites() to service_role;

comment on function app.job_sla_alerts() is
  'Enfileira avisos de SLA (warning/critical/breach). Uma vez por pessoa, estado e vida do ticket.';
comment on function app.job_auto_close() is
  'Fecha ticket resolvido há mais de tenants.auto_close_after_days. Executa a regra que existia desde a 0002 e nunca rodou.';
comment on function app.job_satisfaction_invites() is
  'Cria o convite de CSAT dos chamados fechados nos últimos 7 dias e enfileira o e-mail com o link de token.';

-- -----------------------------------------------------------------------------
-- 5. A tela de satisfação no catálogo
-- -----------------------------------------------------------------------------
-- Duas chaves, dentro de `helpdesk` — e ficar dentro dele não é detalhe: é o que
-- faz `app.seed_system_access_profiles()` conceder a tela ao Gestor de TI e ao
-- Operador de TI automaticamente (regra `c.module = 'helpdesk'`), e o `.ver` à
-- Diretoria e ao Visualizador, sem tocar na função. Módulo novo escaparia da
-- função — foi o que aconteceu com `conectividade` na 0022.
--
-- `sort_order` 136-137: logo depois de `helpdesk.filas.configurar_regras` (135),
-- que é a última chave do módulo.
--
-- **Não existe chave para RESPONDER a pesquisa.** Quem responde é o solicitante,
-- por link com token, muitas vezes sem conta nenhuma no sistema. Permissão para
-- isso não governaria nada — e chave que não governa nada é configuração morta,
-- defeito já corrigido seis vezes nesta base.
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('helpdesk.satisfacao', 'helpdesk', 'satisfacao', null,
   'Satisfação', 'atendente', 136),
  ('helpdesk.satisfacao.ver', 'helpdesk', 'satisfacao', 'ver',
   'Consultar as avaliações', 'atendente', 137)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

-- Os perfis de sistema dos tenants que já existem precisam receber as chaves
-- novas: a função é idempotente e só acrescenta.
do $$
declare
  v_tenant uuid;
begin
  for v_tenant in select id from public.tenants loop
    perform app.seed_system_access_profiles(v_tenant);
  end loop;
end
$$;

commit;
