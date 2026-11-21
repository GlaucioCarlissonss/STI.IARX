-- =============================================================================
-- 0062 — A vigência da assinatura passa a valer
-- =============================================================================
-- O defeito que esta migração fecha é o maior que havia para quem vai VENDER
-- este sistema: `tenants.status` existia desde a 0001 e **ninguém o lia**.
--
-- Medido antes de escrever: nenhuma ocorrência de `status` em `src/lib/session.ts`
-- nem em `src/proxy.ts`. Avaliação vencida, empresa suspensa e empresa cancelada
-- funcionavam exatamente como uma ativa. `trial_ends_on` era gravado pela 0060 e
-- lido por ninguém.
--
-- Na prática: toda empresa que se cadastrasse usaria o sistema para sempre, de
-- graça, e não havia como suspender nem quem parasse de pagar nem quem abusasse.
--
-- ## Por que a tranca fica no BANCO, e não só na aplicação
--
-- A mesma razão da RLS: a aplicação é um caminho, não o único. Um job, uma Edge
-- Function ou uma rota nova esquecida escreveriam numa empresa cancelada sem
-- passar por tela nenhuma. `app.tenant_em_vigencia()` responde a pergunta uma
-- vez, e quem precisa chama.
--
-- ## O que a suspensão NÃO faz
--
-- Não apaga nada, não esconde dado e não impede LER. Uma empresa suspensa
-- continua podendo consultar o que é dela e exportar — tirar o acesso ao
-- próprio histórico de quem atrasou uma fatura é reter dado alheio como garantia,
-- e isso não é cobrança, é outra coisa. O que ela perde é ESCREVER.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Os parâmetros do aviso
-- -----------------------------------------------------------------------------
insert into public.platform_settings (chave, valor, rotulo, descricao) values
  ('trial_aviso_dias', '7', 'Dias de aviso antes de vencer',
   'Com quantos dias de antecedência o administrador é avisado de que a avaliação acaba. O aviso sai uma vez por empresa, não todo dia.'),
  ('suspensao_automatica', 'true', 'Suspender ao vencer a avaliação',
   'Se a avaliação vencida suspende a empresa sozinha. Desligado, o prazo vence e o status fica como está — útil para quem vende por contrato assinado fora do sistema.')
on conflict (chave) do nothing;

-- -----------------------------------------------------------------------------
-- 2. A pergunta, respondida num lugar só
-- -----------------------------------------------------------------------------
/*
 * `trial` conta como vigência ENQUANTO o prazo não venceu — e o vencimento é
 * conferido aqui, não só pelo job. Se dependesse do job, uma empresa ficaria
 * usando o sistema entre o vencimento e a próxima execução, e um agendador
 * parado daria uso ilimitado sem ninguém notar.
 *
 * `stable` e não `immutable`: a resposta muda com `current_date`.
 */
create or replace function app.tenant_em_vigencia(p_status text, p_trial_ate date)
returns boolean
language sql
stable
as $$
  select case
    when p_status = 'active' then true
    when p_status = 'trial'  then coalesce(p_trial_ate, current_date) >= current_date
    else false   -- suspended, cancelled, e o que vier depois
  end;
$$;

comment on function app.tenant_em_vigencia(text, date) is
  'A empresa pode ESCREVER? Ler continua permitido mesmo fora de vigência.';

/** A mesma pergunta para a empresa da sessão corrente. */
create or replace function app.em_vigencia()
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select coalesce(
    (select app.tenant_em_vigencia(t.status, t.trial_ends_on)
       from public.tenants t where t.id = app.current_tenant_id()),
    /* Sem tenant na sessão não há o que barrar: é o caso do `super_admin` da
       plataforma e o das rotas públicas, que têm as próprias trancas. */
    true);
$$;

grant execute on function app.tenant_em_vigencia(text, date) to authenticated, service_role;
grant execute on function app.em_vigencia() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. A visão que a tela de assinatura lê
-- -----------------------------------------------------------------------------
/* A coluna do plano nasce aqui, e o CATÁLOGO vem na 0063. Invertido, a view
   teria de ser reescrita uma migração depois — e view reescrita é view que
   alguém esquece de atualizar num dos dois lugares. */
alter table public.tenants add column if not exists plano_id uuid;

/*
 * `security_invoker = true` como toda view desta base: sem ele a view roda com
 * os privilégios do dono (`postgres`, que tem `bypassrls`) e a RLS deixa de
 * valer — uma empresa veria a assinatura das outras.
 */
create or replace view public.vw_assinatura
with (security_invoker = true) as
select
  t.id                as tenant_id,
  t.name,
  t.status,
  t.trial_ends_on,
  app.tenant_em_vigencia(t.status, t.trial_ends_on) as em_vigencia,
  case
    when t.status = 'trial' and t.trial_ends_on is not null
      then t.trial_ends_on - current_date
    else null
  end                 as dias_restantes,
  t.plano_id,
  t.created_at
from public.tenants t;

comment on view public.vw_assinatura is
  'A situação da assinatura da empresa da sessão. Lê sob RLS como todas as outras.';

grant select on public.vw_assinatura to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. O histórico — porque suspender alguém é ato, e ato tem autor
-- -----------------------------------------------------------------------------
create table public.tenant_status_events (
  id          bigserial primary key,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  de          text,
  para        text not null,
  motivo      text,
  /* `null` quando foi o job: ninguém clicou, e inventar um autor humano para
     uma decisão automática é pior que admitir que não houve um. */
  por         uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

comment on table public.tenant_status_events is
  'Quem mudou a situação da empresa, quando e por quê. `por` nulo = o job.';

create index idx_tenant_status_events on public.tenant_status_events (tenant_id, created_at desc);

alter table public.tenant_status_events enable row level security;
alter table public.tenant_status_events force row level security;

/* A empresa lê o próprio histórico. Saber por que foi suspensa é o mínimo que
   se deve a quem foi — e esconder isso transforma a cobrança em mistério. */
create policy tenant_status_events_select on public.tenant_status_events
  for select to authenticated
  using (tenant_id = app.current_tenant_id());

grant select on public.tenant_status_events to authenticated;
grant select, insert on public.tenant_status_events to service_role;
grant usage on sequence public.tenant_status_events_id_seq to service_role;

/* O gatilho grava sozinho. Depender de cada caminho lembrar de registrar é como
   a trilha de auditoria desta base já decidiu NÃO fazer: o caminho esquecido é
   justamente o que ninguém revisa. */
create or replace function app.registrar_mudanca_de_status()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    insert into public.tenant_status_events (tenant_id, de, para, por)
    values (new.id, old.status, new.status, app.current_user_id());
  end if;
  return new;
end;
$$;

create trigger trg_tenants_status_evento
  after update on public.tenants
  for each row execute function app.registrar_mudanca_de_status();

-- -----------------------------------------------------------------------------
-- 5. O trabalho agendado: avisar antes, suspender depois
-- -----------------------------------------------------------------------------
/*
 * AVISAR ANTES É PARTE DO PRODUTO, não cortesia.
 *
 * Uma empresa que descobre o vencimento ao ser barrada perde o dia de trabalho
 * e a confiança junto. O aviso sai UMA VEZ por empresa — repetir todo dia faz o
 * aviso virar ruído, e no terceiro dia ninguém lê.
 *
 * "Uma vez" é garantido pela caixa de saída: se já existe aviso com esta
 * finalidade para esta empresa nos últimos 30 dias, não sai outro.
 */
create or replace function app.job_vigencia_das_assinaturas()
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_run_id    bigint;
  v_avisados  integer := 0;
  v_suspensos integer := 0;
  v_dias      integer := app.parametro_numerico('trial_aviso_dias', 7);
  v_auto      boolean := app.parametro_ligado('suspensao_automatica', true);
  v_t         record;
begin
  insert into public.job_runs (job) values ('vigencia_assinaturas') returning id into v_run_id;

  -- 1. Avisar quem está perto de vencer.
  for v_t in
    select t.id, t.name, t.trial_ends_on, t.trial_ends_on - current_date as faltam
      from public.tenants t
     where t.status = 'trial'
       and t.trial_ends_on is not null
       and t.trial_ends_on >= current_date
       and t.trial_ends_on - current_date <= v_dias
       and not exists (
         select 1 from public.email_outbox o
          where o.tenant_id = t.id
            and o.kind = 'trial_ending'
            and o.created_at > now() - interval '30 days')
  loop
    /* Para TODOS os administradores da empresa, e não só para quem cadastrou:
       quem abriu a conta pode ter saído, e um aviso endereçado a alguém que não
       trabalha mais ali é um aviso que não chega. */
    insert into public.email_outbox (tenant_id, to_email, subject, body_text, kind)
    select t.id, p.email,
      format('A sua avaliação do STI acaba em %s dia(s)', v_t.faltam),
      format(
        E'A avaliação da %s acaba em %s, daqui a %s dia(s).\n\n'
        'Depois disso a equipe continua ENTRANDO e CONSULTANDO tudo normalmente —\n'
        'nada é apagado e nada fica escondido. O que para é o cadastro de coisas\n'
        'novas: abrir chamado, lançar título, registrar medição.\n\n'
        '/assinatura\n\n'
        'Se já combinou a contratação, ignore este aviso.\n',
        t.name, to_char(v_t.trial_ends_on, 'DD/MM/YYYY'), v_t.faltam),
      'trial_ending'
      from public.tenants t
      join public.profiles p on p.tenant_id = t.id and p.role = 'admin' and p.is_active
     where t.id = v_t.id;

    v_avisados := v_avisados + 1;
  end loop;

  -- 2. Suspender quem venceu, se o parâmetro mandar.
  if v_auto then
    for v_t in
      select t.id, t.name from public.tenants t
       where t.status = 'trial'
         and t.trial_ends_on is not null
         and t.trial_ends_on < current_date
    loop
      /* `trial_ends_on` vai a null porque o CHECK da 0060 exige que ele exista
         se, e somente se, o status for `trial`. Sair de `trial` sem limpá-lo
         derrubaria a própria atualização. */
      update public.tenants
         set status = 'suspended', trial_ends_on = null
       where id = v_t.id;

      /* O gatilho da seção 4 já registrou a mudança; aqui se acrescenta o
         MOTIVO, que o gatilho não tem como saber. */
      update public.tenant_status_events
         set motivo = 'Avaliação vencida'
       where tenant_id = v_t.id and para = 'suspended' and motivo is null
         and created_at > now() - interval '1 minute';

      insert into public.email_outbox (tenant_id, to_email, subject, body_text, kind)
      select v_t.id, p.email,
        'A avaliação do STI terminou',
        format(
          E'A avaliação da %s terminou.\n\n'
          'A equipe continua entrando e consultando tudo — nada foi apagado. O que\n'
          'está suspenso é o cadastro de coisas novas, até a contratação.\n\n'
          '/assinatura\n',
          v_t.name),
        'trial_ended'
        from public.profiles p
       where p.tenant_id = v_t.id and p.role = 'admin' and p.is_active;

      v_suspensos := v_suspensos + 1;
    end loop;
  end if;

  update public.job_runs
     set finished_at = now(), ok = true, affected = v_avisados + v_suspensos
   where id = v_run_id;

  return v_avisados + v_suspensos;
end;
$$;

grant execute on function app.job_vigencia_das_assinaturas() to service_role;

insert into public.job_expectations (job, rotulo, tolerancia_min, observacao)
values ('vigencia_assinaturas', 'Vigência das assinaturas', 2880,
        'Diária. Avisa antes de vencer e suspende o que venceu.')
on conflict (job) do nothing;

-- Os dois tipos novos na caixa de saída. A lista inteira é reescrita, então ela
-- precisa conter tudo o que veio antes — foi assim que a 0057 apagou quatro
-- tipos sem querer, e o banco de validação acusou.
alter table public.email_outbox drop constraint email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in (
    'sla_warning', 'sla_critical', 'sla_breach',
    'satisfaction_invite', 'ticket_assigned', 'test',
    'agent_alert',
    'contract_expiring', 'link_down', 'link_restored',
    'password_reset', 'email_confirm',
    'signup_existing',
    'invite',
    -- 0062
    'trial_ending', 'trial_ended'));

-- -----------------------------------------------------------------------------
-- 6. Quem opera a plataforma pode mudar a situação
-- -----------------------------------------------------------------------------
/*
 * `super_admin` é papel da OPERAÇÃO DA PLATAFORMA, não de nenhuma empresa — é
 * quem vende, cobra e atende. Ele não entra pela RLS das empresas (não tem
 * tenant), então esta função é `security definer` e confere o papel por dentro.
 */
create or replace function app.mudar_situacao_da_empresa(
  p_tenant uuid,
  p_status text,
  p_motivo text,
  p_trial_ate date default null
)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_papel text;
begin
  select role into v_papel from public.profiles where id = app.current_user_id();
  if v_papel is distinct from 'super_admin' then
    raise exception 'apenas a operação da plataforma muda a situação de uma empresa'
      using errcode = 'insufficient_privilege';
  end if;

  if p_status not in ('trial', 'active', 'suspended', 'cancelled') then
    raise exception 'situação desconhecida: %', p_status;
  end if;

  /* O CHECK da 0060 amarra os dois campos: `trial` exige prazo, e o resto exige
     que não haja. Resolver isso aqui evita que cada chamada tenha de lembrar. */
  update public.tenants
     set status = p_status,
         trial_ends_on = case when p_status = 'trial'
                              then coalesce(p_trial_ate, current_date + app.parametro_numerico('trial_days', 90))
                              else null end
   where id = p_tenant;

  update public.tenant_status_events
     set motivo = p_motivo
   where tenant_id = p_tenant and motivo is null
     and created_at > now() - interval '1 minute';
end;
$$;

grant execute on function app.mudar_situacao_da_empresa(uuid, text, text, date) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 7. A permissão de ver a própria assinatura
-- -----------------------------------------------------------------------------
insert into public.permission_catalog (key, module, screen, action, label, min_base_role, sort_order)
values
  ('ambiente.assinatura', 'ambiente', 'assinatura', null, 'Assinatura', 'admin', 560),
  ('ambiente.assinatura.ver', 'ambiente', 'assinatura', 'ver', 'Ver a situação da assinatura', 'admin', 561)
on conflict (key) do update
  set label = excluded.label, min_base_role = excluded.min_base_role, sort_order = excluded.sort_order;

/* A regra dos perfis de sistema reaplicada — ver a 0058. Toda migração que
   acrescenta permissão termina assim, senão a chave nova não chega a quem já
   tem banco e a tela fica escura sem erro nenhum. */
do $$
declare v_tenant uuid;
begin
  for v_tenant in select id from public.tenants loop
    perform app.seed_system_access_profiles(v_tenant);
  end loop;
end
$$;
