-- =============================================================================
-- 0061 — Convites: entrar numa empresa que já existe
-- =============================================================================
-- O segundo caminho da Fase 2. O primeiro (0060) cria empresa nova; este põe
-- gente numa que já tem dono.
--
-- ## Por que tabela própria, e não mais uma finalidade em `auth_tokens`
--
-- `auth_tokens.user_id` é NOT NULL e aponta para `auth.users`: todo token de lá
-- pertence a uma conta que já existe. O convite é o contrário — ele existe
-- justamente ANTES da conta, e é o que a cria. Forçá-lo naquela tabela exigiria
-- afrouxar a chave estrangeira para todos os outros usos, trocando uma garantia
-- real por economia de uma tabela.
--
-- ## Quem aceita convite NÃO precisa confirmar e-mail
--
-- O cadastro público (0060) manda um link de confirmação porque qualquer um
-- pode digitar o endereço de outra pessoa. Aqui o link JÁ foi para o endereço
-- convidado: abri-lo é a prova de que quem está ali lê aquela caixa — a mesma
-- prova que a confirmação produziria. Pedir de novo seria pedir duas vezes o
-- mesmo, e perder gente no caminho.
--
-- ## O e-mail que já tem conta
--
-- Uma pessoa pertence a UMA empresa: `profiles.id` é a chave primária e é o
-- próprio usuário. Convidar um endereço que já tem conta não pode, e a recusa
-- não aparece para quem convidou — senão a tela de convite viraria um
-- verificador de contas da instalação inteira, inclusive de outras empresas.
--
-- O dono do endereço é avisado por e-mail, que é onde a diferença pode aparecer
-- sem informar estranho nenhum. Mesma regra da 0060.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. O prazo, também parâmetro
-- -----------------------------------------------------------------------------
insert into public.platform_settings (chave, valor, rotulo, descricao) values
  ('invite_days', '7', 'Dias de validade do convite',
   'Quanto tempo um convite aceita ser usado. Curto de propósito: convite parado é endereço de e-mail esperando numa caixa.')
on conflict (chave) do nothing;

-- -----------------------------------------------------------------------------
-- 2. A tabela
-- -----------------------------------------------------------------------------
create table public.invites (
  id          bigserial primary key,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  email       text not null check (email like '%@%'),
  /* O papel que a pessoa terá. É o TETO do que ela poderá fazer, e por isso
     quem convida não pode escolher um acima do próprio — ver a trava abaixo. */
  role        text not null check (role in ('admin', 'gestor', 'atendente', 'solicitante')),

  token_hash  text not null unique,

  invited_by  uuid references public.profiles(id) on delete set null,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

comment on table public.invites is
  'Convite para entrar numa empresa existente. Token guardado como hash, uso único.';

/* Um convite VIVO por e-mail e empresa. Dois convites abertos para a mesma
   pessoa produziriam dois links válidos, e o mais antigo — que pode ter sido
   encaminhado — continuaria abrindo a porta. */
create unique index invites_um_vivo
  on public.invites (tenant_id, lower(email))
  where accepted_at is null and revoked_at is null;

create index invites_por_tenant on public.invites (tenant_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 3. Convidar
-- -----------------------------------------------------------------------------
/*
 * Devolve o token em claro para quem chamou — a Server Action, que monta o
 * link — ou `null` quando não há convite a fazer.
 *
 * `null` cobre dois casos muito diferentes, e isso é deliberado: o e-mail já
 * tem conta (em qualquer empresa), ou já existe convite vivo. Quem convida vê a
 * mesma confirmação nos dois, porque distinguir transformaria esta tela num
 * verificador de contas da instalação inteira.
 */
create or replace function app.convidar_para_empresa(
  p_tenant  uuid,
  p_email   text,
  p_role    text,
  p_por     uuid
)
returns text
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_token   text;
  v_dias    integer := app.parametro_numerico('invite_days', 7);
  v_papel   text;
  v_empresa text;
begin
  if p_role not in ('admin', 'gestor', 'atendente', 'solicitante') then
    raise exception 'papel desconhecido: %', p_role;
  end if;

  /*
   * NÃO SE CONVIDA PARA ACIMA DO PRÓPRIO PAPEL.
   *
   * Sem isto, um `gestor` convidaria alguém como `admin` e pediria a senha —
   * auto-promoção com um passo a mais. É a mesma regra que
   * `trg_profiles_no_escalation` já aplica na edição de usuário, e ela precisa
   * valer também na porta por onde entram usuários novos.
   */
  select role into v_papel from public.profiles where id = p_por;
  if v_papel is null or app.role_rank(p_role) > app.role_rank(v_papel) then
    raise exception 'não é possível convidar para um papel acima do seu'
      using errcode = 'insufficient_privilege';
  end if;

  /* Endereço que já tem conta, em qualquer empresa: nada a fazer aqui. Quem
     avisa o dono é a aplicação, por e-mail. */
  if exists (select 1 from public.profiles where lower(email) = lower(btrim(p_email))) then
    return null;
  end if;

  /* Convite vivo já existe: devolver o mesmo token seria impossível (só o hash
     ficou guardado), e emitir outro deixaria dois links válidos. */
  if exists (
    select 1 from public.invites
     where tenant_id = p_tenant
       and lower(email) = lower(btrim(p_email))
       and accepted_at is null and revoked_at is null
       and expires_at > now()
  ) then
    return null;
  end if;

  /* Convite vencido ou revogado não bloqueia um novo — mas sai do caminho do
     índice, que só olha os vivos. */
  update public.invites
     set revoked_at = now()
   where tenant_id = p_tenant
     and lower(email) = lower(btrim(p_email))
     and accepted_at is null and revoked_at is null;

  v_token := encode(gen_random_bytes(32), 'hex');
  select name into v_empresa from public.tenants where id = p_tenant;

  insert into public.invites (tenant_id, email, role, token_hash, invited_by, expires_at)
  values (p_tenant, lower(btrim(p_email)), p_role,
          encode(digest(v_token, 'sha256'), 'hex'), p_por,
          now() + make_interval(days => v_dias));

  insert into public.email_outbox (tenant_id, to_email, subject, body_text, kind)
  values (
    p_tenant, lower(btrim(p_email)),
    format('Convite para usar o STI na %s', v_empresa),
    format(
      E'Você foi convidado a usar o STI na empresa %s.\n\n'
      'Abra o endereço abaixo para criar a sua senha e entrar. O convite vale\n'
      'por %s dias e serve uma vez só.\n\n'
      '/convite/%s\n\n'
      'Se você não esperava este convite, ignore este e-mail. Nada foi criado\n'
      'em seu nome, e o convite deixa de valer sozinho.\n',
      v_empresa, v_dias::text, v_token),
    'invite');

  return v_token;
end;
$$;

/* O tipo novo na caixa de saída. A lista inteira é reescrita, então ela precisa
   conter tudo o que veio antes — foi assim que a 0057 apagou quatro tipos sem
   querer, e o banco de validação acusou. */
alter table public.email_outbox drop constraint email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in (
    'sla_warning', 'sla_critical', 'sla_breach',
    'satisfaction_invite', 'ticket_assigned', 'test',
    'agent_alert',
    'contract_expiring', 'link_down', 'link_restored',
    'password_reset', 'email_confirm',
    'signup_existing',
    -- 0061
    'invite'));

-- -----------------------------------------------------------------------------
-- 4. Ler o convite sem gastá-lo
-- -----------------------------------------------------------------------------
/*
 * A tela precisa dizer PARA QUAL EMPRESA a pessoa foi convidada antes de ela
 * digitar a senha — um formulário que não diz onde você está entrando é um
 * formulário que ninguém deveria preencher.
 *
 * Devolve o nome da empresa e o e-mail; nunca o papel, que é informação interna
 * de quem convidou, e nunca nada se o convite não valer.
 */
create or replace function public.convite_valido(p_token text)
returns table (empresa text, email text)
language sql
security definer
set search_path = public, pg_temp
as $$
  select t.name, i.email
    from public.invites i
    join public.tenants t on t.id = i.tenant_id
   where i.token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and i.accepted_at is null
     and i.revoked_at is null
     and i.expires_at > now();
$$;

-- -----------------------------------------------------------------------------
-- 5. Aceitar
-- -----------------------------------------------------------------------------
/*
 * Gasta o convite e cria a conta, numa transação só — pelo mesmo motivo da
 * 0060: três inserções em três tabelas, e parar no meio deixa lixo que ninguém
 * limpa e um e-mail ocupado por uma conta que não funciona.
 *
 * A conta nasce ATIVA. O link chegou no endereço convidado, e abri-lo é a prova
 * de que quem está ali lê aquela caixa — a mesma prova que a confirmação da
 * 0060 produz. Pedir confirmação depois seria pedir duas vezes o mesmo.
 */
create or replace function app.aceitar_convite(
  p_token text,
  p_nome  text,
  p_senha text
)
returns uuid
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_convite record;
  v_user    uuid;
begin
  /* O `update` que gasta o convite e o lê, numa instrução: conferir antes e
     gravar depois abriria a janela em que dois cliques simultâneos criam duas
     contas com o mesmo e-mail. */
  update public.invites
     set accepted_at = now()
   where token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and accepted_at is null
     and revoked_at is null
     and expires_at > now()
  returning tenant_id, email, role into v_convite;

  if v_convite.tenant_id is null then
    return null;
  end if;

  /* Entre a emissão e o aceite, o endereço pode ter ganhado conta por outro
     caminho. O convite já foi gasto acima — e isso é o certo: ele serviu, só
     não produziu conta. */
  if exists (select 1 from public.profiles where lower(email) = lower(v_convite.email)) then
    return null;
  end if;

  insert into auth.users (id, email, raw_app_meta_data)
  values (gen_random_uuid(), v_convite.email,
          jsonb_build_object('tenant_id', v_convite.tenant_id))
  returning id into v_user;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'auth' and table_name = 'users'
       and column_name = 'encrypted_password'
  ) then
    execute 'update auth.users set encrypted_password = crypt($1, gen_salt(''bf'')) where id = $2'
      using p_senha, v_user;
  end if;

  insert into public.profiles (id, tenant_id, role, full_name, email, is_active)
  values (v_user, v_convite.tenant_id, v_convite.role, btrim(p_nome), v_convite.email, true);

  return v_user;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Permissão, RLS e privilégios
-- -----------------------------------------------------------------------------
insert into public.permission_catalog (key, module, screen, action, label, min_base_role, sort_order)
values
  ('usuarios.convites', 'usuarios', 'convites', null, 'Convites', 'admin', 540),
  ('usuarios.convites.ver', 'usuarios', 'convites', 'ver', 'Ver convites enviados', 'admin', 541),
  ('usuarios.convites.criar', 'usuarios', 'convites', 'criar', 'Convidar alguém para a empresa', 'admin', 542),
  ('usuarios.convites.revogar', 'usuarios', 'convites', 'revogar', 'Revogar convite pendente', 'admin', 543)
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

alter table public.invites enable row level security;
alter table public.invites force row level security;

/*
 * Lê quem administra a PRÓPRIA empresa, e só a própria. O `token_hash` fica na
 * tabela, mas ele é hash: mesmo quem lê não consegue montar o link.
 */
create policy invites_select on public.invites
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('usuarios.convites.ver'));

/* Revogar é o único `update` que a aplicação faz — e só do que ainda não foi
   aceito. Convite aceito é história. */
create policy invites_update on public.invites
  for update to authenticated
  using (tenant_id = app.current_tenant_id()
         and app.has_permission('usuarios.convites.revogar')
         and accepted_at is null)
  with check (tenant_id = app.current_tenant_id());

grant select, update on public.invites to authenticated;
grant select, insert, update on public.invites to service_role;
grant usage on sequence public.invites_id_seq to service_role;
grant execute on function app.convidar_para_empresa(uuid, text, text, uuid) to service_role;
grant execute on function app.aceitar_convite(text, text, text) to service_role;
grant execute on function public.convite_valido(text) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7. Faxina
-- -----------------------------------------------------------------------------
/*
 * Convite vencido não serve, e guardá-lo para sempre é manter uma lista de
 * endereços de e-mail que alguém um dia quis convidar. Trinta dias depois do
 * vencimento: a janela serve para quem pergunta "eu convidei fulana mês
 * passado?".
 */
create or replace function app.job_purge_convites()
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_run_id bigint;
  v_count  integer;
begin
  insert into public.job_runs (job) values ('purge_convites') returning id into v_run_id;

  delete from public.invites
   where accepted_at is null
     and expires_at < now() - interval '30 days';
  get diagnostics v_count = row_count;

  update public.job_runs
     set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;

  return v_count;
end;
$$;

insert into public.job_expectations (job, rotulo, tolerancia_min, observacao)
values ('purge_convites', 'Purga de convites vencidos', 2880, 'Diária.')
on conflict (job) do nothing;

grant execute on function app.job_purge_convites() to service_role;
