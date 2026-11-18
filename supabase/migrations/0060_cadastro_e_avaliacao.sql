-- =============================================================================
-- 0060 — Cadastro público: empresa em avaliação e confirmação de e-mail
-- =============================================================================
-- A Fase 2 do plano de `sti.iarx.com.br`. Ela abre uma porta para a internet, e
-- por isso só veio depois das defesas: freio por origem (0059), token de uso
-- único (0057), visibilidade do e-mail (0058) e conta inativa que de fato não
-- entra — este último era um defeito, não um recurso, e foi corrigido antes.
--
-- ## Conta nasce INATIVA, e é isso que torna a confirmação real
--
-- Não há "pendente de confirmação" como estado novo: já existe `is_active`, e
-- desde a correção anterior ele barra o login e derruba a sessão. Confirmar o
-- e-mail é ativar. Um estado a mais descreveria a mesma coisa duas vezes, e
-- quando dois campos dizem o mesmo um deles acaba errado.
--
-- ## O prazo de avaliação é PARÂMETRO, e da plataforma
--
-- Noventa dias é o padrão, não uma constante no código. E não cabe em
-- `tenants`: no momento em que a pessoa se cadastra, o tenant ainda não existe
-- — é justamente o prazo que decide quando ele vence. Por isso uma tabela de
-- parâmetros da PLATAFORMA, sem `tenant_id`, como `job_expectations`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Parâmetros da plataforma
-- -----------------------------------------------------------------------------
create table public.platform_settings (
  chave      text primary key,
  valor      text not null,
  rotulo     text not null,
  descricao  text,
  updated_at timestamptz not null default now()
);

comment on table public.platform_settings is
  'Parâmetros da instalação inteira, sem tenant. O que vale antes de existir empresa.';

insert into public.platform_settings (chave, valor, rotulo, descricao) values
  ('trial_days', '90', 'Dias de avaliação',
   'Quanto tempo uma empresa criada por cadastro público tem antes de a avaliação vencer.'),
  ('signup_aberto', 'true', 'Cadastro público aberto',
   'Quando falso, /criar-conta recusa. O convite continua funcionando — é o freio para fechar a porta sem derrubar quem já foi convidado.')
on conflict (chave) do nothing;

/*
 * Lê um parâmetro numérico com padrão.
 *
 * O padrão no código não é duplicação do dado: é o que mantém o sistema de pé
 * se alguém apagar a linha. Uma instalação sem `trial_days` não pode parar de
 * aceitar cadastro — ela usa noventa e segue.
 */
create or replace function app.parametro_numerico(p_chave text, p_padrao integer)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select nullif(regexp_replace(valor, '\D', '', 'g'), '')::integer
       from public.platform_settings where chave = p_chave),
    p_padrao);
$$;

create or replace function app.parametro_ligado(p_chave text, p_padrao boolean)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select lower(valor) in ('true','t','1','sim') from public.platform_settings where chave = p_chave),
    p_padrao);
$$;

-- -----------------------------------------------------------------------------
-- 2. A empresa em avaliação
-- -----------------------------------------------------------------------------
/*
 * `trial` entra na lista de situações. As três que existiam descrevem empresa
 * que já foi contratada; nenhuma descreve a que está experimentando — e usar
 * `active` para ela apagaria a diferença exatamente onde ela importa, que é na
 * hora de cobrar ou de encerrar.
 */
alter table public.tenants drop constraint if exists tenants_status_check;
alter table public.tenants add constraint tenants_status_check
  check (status in ('trial', 'active', 'suspended', 'cancelled'));

alter table public.tenants add column if not exists trial_ends_on date;

comment on column public.tenants.trial_ends_on is
  'Quando a avaliação vence. Nulo em empresa contratada — avaliação é estado de entrada, não propriedade permanente.';

/*
 * Avaliação sem fim é produto de graça para sempre; fim sem registro é cliente
 * perdido sem saber por quê. A data é obrigatória enquanto o estado for `trial`,
 * e some quando a empresa é contratada.
 */
alter table public.tenants add constraint tenants_trial_tem_prazo
  check ((status = 'trial') = (trial_ends_on is not null));

-- -----------------------------------------------------------------------------
-- 3. Confirmar e-mail de conta que ainda não está ativa
-- -----------------------------------------------------------------------------
/*
 * A 0057 recusava emitir token para conta inativa — e estava certa para
 * redefinição de senha: conta desativada não deve receber caminho de volta.
 *
 * Para CONFIRMAÇÃO é o contrário: a conta nasce inativa justamente porque ainda
 * não confirmou, e recusar o token trancaria toda conta nova para fora. É o
 * mesmo campo com dois significados — "desativada por alguém" e "ainda não
 * confirmada" —, e a diferença está na finalidade do token, não no estado.
 */
create or replace function app.emitir_token_de_acesso(
  p_email   text,
  p_purpose text,
  p_minutos integer default 60
)
returns text
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_perfil  record;
  v_token   text;
  v_assunto text;
  v_corpo   text;
begin
  if p_purpose not in ('password_reset', 'email_confirm') then
    raise exception 'finalidade de token desconhecida: %', p_purpose;
  end if;

  select p.id, p.tenant_id, p.email, p.full_name, p.is_active
    into v_perfil
    from public.profiles p
   where lower(p.email) = lower(btrim(p_email))
   limit 1;

  if v_perfil.id is null then
    return null;
  end if;

  /* Redefinição exige conta ativa; confirmação exige o contrário — ver o
     comentário acima. */
  if p_purpose = 'password_reset' and v_perfil.is_active is not true then
    return null;
  end if;
  if p_purpose = 'email_confirm' and v_perfil.is_active is true then
    /* Já confirmou: não há o que confirmar, e reenviar o link daria a quem
       pediu a confirmação de que a conta existe e está ativa. */
    return null;
  end if;

  if exists (
    select 1 from public.auth_tokens
     where user_id = v_perfil.id
       and purpose = p_purpose
       and created_at > now() - interval '60 seconds'
  ) then
    return null;
  end if;

  update public.auth_tokens
     set used_at = now()
   where user_id = v_perfil.id
     and purpose = p_purpose
     and used_at is null;

  v_token := encode(gen_random_bytes(32), 'hex');

  insert into public.auth_tokens (purpose, token_hash, user_id, tenant_id, email, expires_at)
  values (
    p_purpose,
    encode(digest(v_token, 'sha256'), 'hex'),
    v_perfil.id,
    v_perfil.tenant_id,
    v_perfil.email,
    now() + make_interval(mins => greatest(p_minutos, 5)));

  if p_purpose = 'password_reset' then
    v_assunto := 'Redefinir a sua senha';
    v_corpo := format(
      E'Olá, %s.\n\n'
      'Alguém pediu para redefinir a senha desta conta. Se foi você, abra o\n'
      'endereço abaixo. Ele vale por %s minutos e só funciona uma vez.\n\n'
      '/nova-senha/%s\n\n'
      'Se não foi você, ignore este e-mail: a senha continua a mesma, e este\n'
      'link deixa de valer sozinho. Nada precisa ser feito.\n',
      coalesce(v_perfil.full_name, 'tudo bem'), greatest(p_minutos, 5)::text, v_token);
  else
    v_assunto := 'Confirme o seu e-mail';
    v_corpo := format(
      E'Olá, %s.\n\n'
      'Confirme este endereço para ativar a sua conta no STI. O link vale por\n'
      '%s minutos e só funciona uma vez.\n\n'
      '/confirmar-email/%s\n\n'
      'Enquanto não confirmar, a conta existe e não entra — é assim que\n'
      'garantimos que ninguém cria conta com o endereço de outra pessoa.\n\n'
      'Se você não se cadastrou, ignore este e-mail: sem a confirmação, a conta\n'
      'não serve para nada e é apagada sozinha.\n',
      coalesce(v_perfil.full_name, 'tudo bem'), greatest(p_minutos, 5)::text, v_token);
  end if;

  insert into public.email_outbox (tenant_id, to_email, to_name, subject, body_text, kind)
  values (v_perfil.tenant_id, v_perfil.email, v_perfil.full_name, v_assunto, v_corpo, p_purpose);

  return v_token;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Criar a empresa e o primeiro administrador, numa transação só
-- -----------------------------------------------------------------------------
/*
 * ## Por que isto é UMA função, e não três chamadas da aplicação
 *
 * São três inserções em três tabelas, e qualquer parada no meio deixa lixo que
 * ninguém vai limpar: empresa sem dono, usuário sem perfil, perfil sem empresa.
 * Pior, o e-mail fica "ocupado" por uma conta que não funciona — e a pessoa não
 * consegue nem se cadastrar de novo, nem entrar.
 *
 * Numa função, ou tudo acontece ou nada acontece.
 *
 * ## A senha entra por EXECUTE com parâmetro
 *
 * `auth.users.encrypted_password` não existe no schema das migrações: ela é
 * acrescentada pelos scripts, e no Supabase quem manda nela é o GoTrue. Uma
 * migração que a presumisse quebraria o banco de validação.
 *
 * Daí o `execute ... using`: ele só roda se a coluna existir, e passa a senha
 * como PARÂMETRO, nunca interpolada no texto. Interpolar com `%L` seria seguro
 * contra injeção e ainda assim escreveria a senha em claro no log de
 * instruções, se ele estiver ligado.
 */
create or replace function app.criar_empresa_em_avaliacao(
  p_email   text,
  p_nome    text,
  p_empresa text,
  p_senha   text,
  p_esferas text[] default array['management']
)
returns uuid
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_tenant uuid;
  v_user   uuid;
  v_slug   text;
  v_dias   integer := app.parametro_numerico('trial_days', 90);
begin
  if not app.parametro_ligado('signup_aberto', true) then
    raise exception 'cadastro público está fechado'
      using errcode = 'check_violation';
  end if;

  /* E-mail já em uso: a aplicação trata ANTES, mandando o aviso de "você já tem
     conta". Aqui é a última tranca, para o caso de duas tentativas simultâneas
     passarem pela verificação da aplicação ao mesmo tempo. */
  if exists (select 1 from public.profiles where lower(email) = lower(btrim(p_email))) then
    raise exception 'e-mail já cadastrado'
      using errcode = 'unique_violation';
  end if;

  /* Um identificador legível e único, derivado do nome. O sufixo aleatório
     evita que duas empresas com o mesmo nome colidam — e colidir aqui travaria
     o cadastro da segunda sem explicação nenhuma para ela. */
  v_slug := regexp_replace(lower(unaccent_simples(btrim(p_empresa))), '[^a-z0-9]+', '-', 'g');
  v_slug := trim(both '-' from left(coalesce(nullif(v_slug, ''), 'empresa'), 40));
  v_slug := v_slug || '-' || substr(encode(gen_random_bytes(4), 'hex'), 1, 6);

  insert into public.tenants (name, slug, status, trial_ends_on, spheres)
  values (btrim(p_empresa), v_slug, 'trial', current_date + v_dias, p_esferas)
  returning id into v_tenant;

  insert into auth.users (id, email, raw_app_meta_data)
  values (gen_random_uuid(), lower(btrim(p_email)),
          jsonb_build_object('tenant_id', v_tenant))
  returning id into v_user;

  /* A senha, só se a coluna existir — ver o cabeçalho. */
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'auth' and table_name = 'users'
       and column_name = 'encrypted_password'
  ) then
    execute 'update auth.users set encrypted_password = crypt($1, gen_salt(''bf'')) where id = $2'
      using p_senha, v_user;
  end if;

  /*
   * `is_active = false`: a conta existe e NÃO entra até confirmar o e-mail.
   * É o mesmo campo que barra conta desativada, e é por isso que ele precisava
   * funcionar antes desta migração existir.
   */
  insert into public.profiles (id, tenant_id, role, full_name, email, is_active)
  values (v_user, v_tenant, 'admin', btrim(p_nome), lower(btrim(p_email)), false);

  return v_user;
end;
$$;

/* Minúsculas sem acento, para o identificador. Sem depender da extensão
   `unaccent`, que não está instalada e exigiria privilégio de superusuário. */
create or replace function public.unaccent_simples(p_texto text)
returns text
language sql
immutable
as $$
  select translate(p_texto,
    'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC');
$$;

-- -----------------------------------------------------------------------------
-- 4.1 Quando o e-mail JÁ TEM conta
-- -----------------------------------------------------------------------------
/*
 * ## O caso que todo cadastro público tem, e quase todos tratam mal
 *
 * Alguém digita um e-mail que já está cadastrado. Há três saídas, e duas são
 * ruins:
 *
 *  - **"Este e-mail já está em uso"** na tela: resolve para quem errou e entrega
 *    a qualquer um um verificador de contas. É a mesma falha que a tela de
 *    redefinição evita com tanto cuidado — não adianta fechar uma porta e
 *    deixar a outra aberta no mesmo prédio.
 *  - **Silêncio total**: não vaza nada e abandona quem simplesmente esqueceu que
 *    já tinha conta. Essa pessoa vai tentar de novo, e de novo.
 *
 * A terceira é esta: a tela responde o mesmo de sempre, e **o aviso vai para o
 * e-mail**. Quem é dono do endereço descobre; quem está sondando, não — porque
 * a resposta na tela não mudou e ele não lê a caixa alheia.
 *
 * E o aviso NÃO leva link de redefinição: mandar um caminho de troca de senha
 * para quem não pediu transformaria esta mensagem na ferramenta que ela deveria
 * impedir. Ele diz onde entrar e lembra que existe "esqueci a senha" — dois
 * cliques a mais, e nenhum token em trânsito.
 */
alter table public.email_outbox drop constraint email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in (
    'sla_warning', 'sla_critical', 'sla_breach',
    'satisfaction_invite', 'ticket_assigned', 'test',
    'agent_alert',
    'contract_expiring', 'link_down', 'link_restored',
    'password_reset', 'email_confirm',
    -- 0060
    'signup_existing'));

create or replace function app.avisar_conta_existente(p_email text)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_perfil record;
begin
  select p.id, p.tenant_id, p.email, p.full_name, p.is_active
    into v_perfil
    from public.profiles p
   where lower(p.email) = lower(btrim(p_email))
   limit 1;

  if v_perfil.id is null then
    return;
  end if;

  /* Mesmo freio da emissão de token: sem ele, esta função vira o caminho para
     inundar a caixa de alguém que já tem conta — justamente o que o resto desta
     migração tenta evitar. */
  if exists (
    select 1 from public.email_outbox
     where kind = 'signup_existing'
       and lower(to_email) = lower(v_perfil.email)
       and created_at > now() - interval '1 hour'
  ) then
    return;
  end if;

  insert into public.email_outbox (tenant_id, to_email, to_name, subject, body_text, kind)
  values (
    v_perfil.tenant_id, v_perfil.email, v_perfil.full_name,
    'Você já tem conta no STI',
    format(
      E'Olá, %s.\n\n'
      'Alguém tentou criar uma conta no STI com este endereço — e ele já tem\n'
      'uma. Se foi você, não precisa cadastrar de novo: é só entrar.\n\n'
      '/login\n\n'
      'Esqueceu a senha? A própria tela de entrada tem o caminho para\n'
      'redefini-la.\n\n'
      'Se não foi você, ignore este e-mail. Nada foi criado e nada mudou na sua\n'
      'conta — este aviso existe só para você saber.\n',
      coalesce(v_perfil.full_name, 'tudo bem')),
    'signup_existing');
end;
$$;

grant execute on function app.avisar_conta_existente(text) to service_role;

-- -----------------------------------------------------------------------------
-- 5. Confirmar
-- -----------------------------------------------------------------------------
/*
 * Gasta o token e ativa a conta, no mesmo caminho. Devolve se deu certo.
 *
 * O `update` do perfil vem DEPOIS do consumo do token e depende dele: sem isso,
 * dois cliques simultâneos no mesmo link ativariam a conta duas vezes — o que
 * aqui é inofensivo, mas o mesmo descuido num fluxo de pagamento não seria.
 */
create or replace function public.confirmar_email_com_token(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid;
begin
  v_user := public.consumir_token_de_acesso(p_token, 'email_confirm');
  if v_user is null then
    return false;
  end if;

  update public.profiles set is_active = true where id = v_user;
  return true;
end;
$$;

/*
 * "Ainda não confirmou" e "foi desativada" são o mesmo `is_active = false`, e
 * precisam de conselhos OPOSTOS na tela de entrada:
 *
 *   não confirmou  → abra o link que está no seu e-mail
 *   desativada     → procure o administrador da sua empresa
 *
 * Dar o segundo a quem precisa do primeiro trava a pessoa no primeiro minuto de
 * uso, procurando um administrador que é ela mesma.
 *
 * A diferença não precisa de campo novo — ela está nos fatos: conta que nunca
 * confirmou tem token de confirmação vivo esperando. Um campo a mais diria o
 * mesmo que este, e quando dois campos dizem o mesmo um deles acaba errado.
 *
 * `security definer` porque `auth_tokens` não é legível por ninguém, de
 * propósito (0057). Esta função devolve só um sim ou não sobre a própria conta
 * de quem acabou de provar a senha.
 */
create or replace function public.conta_aguarda_confirmacao(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.auth_tokens
     where user_id = p_user
       and purpose = 'email_confirm'
       and used_at is null
       and expires_at > now());
$$;

grant execute on function public.conta_aguarda_confirmacao(uuid) to authenticated;
grant execute on function public.confirmar_email_com_token(text) to anon, authenticated;
grant execute on function app.criar_empresa_em_avaliacao(text, text, text, text, text[]) to service_role;
grant execute on function app.parametro_numerico(text, integer) to service_role, authenticated;
grant execute on function app.parametro_ligado(text, boolean) to service_role, authenticated;

-- -----------------------------------------------------------------------------
-- 6. Faxina: conta que nunca confirmou
-- -----------------------------------------------------------------------------
/*
 * Cadastro sem confirmação deixa empresa vazia e e-mail ocupado. O e-mail
 * ocupado é o que dói: a pessoa que digitou errado e nunca confirmou não
 * consegue se cadastrar de novo com o mesmo endereço.
 *
 * Sete dias, e só o que nunca teve nenhuma atividade. O prazo é generoso de
 * propósito — apagar cedo demais atingiria quem só demorou a abrir o e-mail.
 */
create or replace function app.job_purge_cadastros_abandonados()
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_run_id bigint;
  v_count  integer;
begin
  insert into public.job_runs (job) values ('purge_cadastros') returning id into v_run_id;

  with mortos as (
    delete from public.tenants t
     where t.status = 'trial'
       and t.created_at < now() - interval '7 days'
       /* Nenhuma conta confirmada: se ao menos uma pessoa entrou, a empresa é
          de alguém e não se apaga por inatividade. */
       and not exists (
         select 1 from public.profiles p where p.tenant_id = t.id and p.is_active)
       /* E nenhum chamado: empresa com trabalho dentro não é abandono. */
       and not exists (select 1 from public.tickets k where k.tenant_id = t.id)
    returning t.id)
  select count(*) into v_count from mortos;

  update public.job_runs
     set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;

  return v_count;
end;
$$;

insert into public.job_expectations (job, rotulo, tolerancia_min, observacao)
values ('purge_cadastros', 'Purga de cadastros abandonados', 2880,
        'Diária; libera o e-mail de quem se cadastrou e nunca confirmou.')
on conflict (job) do nothing;

grant execute on function app.job_purge_cadastros_abandonados() to service_role;

-- -----------------------------------------------------------------------------
-- 7. RLS
-- -----------------------------------------------------------------------------
alter table public.platform_settings enable row level security;
alter table public.platform_settings force row level security;

/*
 * Parâmetro da plataforma é leitura de quem administra a plataforma. Um
 * administrador de empresa não decide por quanto tempo OUTRAS empresas avaliam
 * o produto — e `app.is_super_admin()` é o papel que existe para isso.
 */
create policy platform_settings_select on public.platform_settings
  for select to authenticated
  using (app.current_role() = 'super_admin');

grant select on public.platform_settings to authenticated;
grant select, insert, update on public.platform_settings to service_role;
