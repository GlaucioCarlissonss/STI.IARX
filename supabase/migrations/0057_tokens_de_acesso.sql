-- =============================================================================
-- 0057 — Token de acesso: redefinir senha e confirmar e-mail (Fase 1)
-- =============================================================================
-- ## O buraco que esta migração fecha
--
-- No modo local (docs/22) — que é o que a VPS da docs/24 roda —, a recuperação
-- de senha **não existe**. O cliente local responde isto:
--
--     async resetPasswordForEmail() {
--       /* Não há envio de e-mail no modo local ... */
--       return { data: {}, error: null }
--     }
--
-- Devolver sucesso e não enviar nada foi uma escolha honesta enquanto a tela era
-- só de desenvolvimento: inventar um link que "funciona" seria pior. Deixa de
-- ser aceitável agora que `sti.iarx.com.br` vai ter uma porta pública, onde
-- clicar em "esqueci a senha" é o que alguém vai fazer às onze da noite.
--
-- ## O que aqui é SQL e o que não é
--
-- É a mesma divisão da 0029: a regra de QUEM recebe vive no banco, onde os dados
-- estão; a conversa com o provedor vive no TypeScript, porque o banco não faz
-- chamada de rede. A fronteira continua sendo `email_outbox`.
--
-- **A senha NÃO é escrita aqui**, e isso é deliberado. A coluna
-- `auth.users.encrypted_password` não existe no schema das migrações — ela é
-- acrescentada pelos scripts (`preparar-banco-local.sh`, `primeiro-acesso.sh`),
-- e no Supabase quem manda nela é o GoTrue. Uma migração que a presumisse
-- quebraria no banco de validação e brigaria com o Supabase. Então o SQL cuida
-- do ciclo do token, e quem troca a senha é quem já sabe trocá-la.
--
-- ## O token é guardado como HASH
--
-- Mesmo modelo do painel de TV (0011) e da pesquisa de satisfação (0029): o que
-- fica na tabela é `sha256` do token, nunca o texto. Um dump de banco que vaze
-- não entrega nenhuma conta — o que o atacante leva é o hash, e com ele não se
-- monta o link.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A tabela
-- -----------------------------------------------------------------------------
create table public.auth_tokens (
  id          bigserial primary key,

  purpose     text not null check (purpose in ('password_reset', 'email_confirm')),
  token_hash  text not null unique,

  user_id     uuid not null references auth.users(id) on delete cascade,
  /* Nulo é permitido porque a Fase 2 vai confirmar e-mail de conta recém-criada,
     que pode não ter empresa ainda. Para redefinição de senha ele sempre vem
     preenchido — é dele que sai o `tenant_id` da caixa de saída. */
  tenant_id   uuid references public.tenants(id) on delete cascade,

  /* O e-mail de destino, copiado no momento da emissão. Não é redundância com
     `profiles.email`: se a pessoa trocar de e-mail depois de pedir o link, o
     link em trânsito tem de continuar valendo para onde foi enviado — e tem de
     ficar registrado para onde foi. */
  email       text not null check (email like '%@%'),

  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

comment on table public.auth_tokens is
  'Token de uso único para redefinir senha e confirmar e-mail. Guardado como hash, nunca em claro.';

/* A consulta que a validação faz: hash + finalidade, só os vivos. */
create index auth_tokens_vivos
  on public.auth_tokens (token_hash) where used_at is null;

/* E a varredura da limpeza, que olha os vencidos. */
create index auth_tokens_vencidos on public.auth_tokens (expires_at);

-- -----------------------------------------------------------------------------
-- 2. A caixa de saída aceita os dois novos tipos
-- -----------------------------------------------------------------------------
/*
 * `kind` é uma lista fechada de propósito (0029): um tipo novo entra por
 * migração, à vista, e não por alguém escrevendo texto livre numa inserção.
 *
 * A LISTA INTEIRA É REESCRITA, e por isso ela precisa conter tudo o que veio
 * antes. Escrevi a primeira versão disto copiando a lista da 0029 e
 * acrescentando os dois tipos novos — e assim apaguei `agent_alert` (0032),
 * `contract_expiring` e os dois de link (0041). O banco de validação acusou na
 * hora: `job_agent_alerts` parou com violação de check.
 *
 * A lição é do formato, não do descuido: uma restrição que se reescreve inteira
 * a cada migração acumula o risco de alguém copiar a versão errada. Quem
 * acrescentar o próximo tipo deve ler a restrição ATUAL
 * (`pg_get_constraintdef`), não a primeira migração que a definiu.
 */
alter table public.email_outbox drop constraint email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in (
    -- 0029
    'sla_warning', 'sla_critical', 'sla_breach',
    'satisfaction_invite', 'ticket_assigned', 'test',
    -- 0032
    'agent_alert',
    -- 0041
    'contract_expiring', 'link_down', 'link_restored',
    -- 0057, esta migração
    'password_reset', 'email_confirm'));

-- -----------------------------------------------------------------------------
-- 3. Emitir
-- -----------------------------------------------------------------------------
/*
 * Devolve o token EM CLARO para quem chamou — é a única vez que ele existe
 * legível — e guarda só o hash. Quem chama é a Server Action, que o usa para
 * montar o link e nada mais.
 *
 * ## Por que devolve NULL em vez de erro quando o e-mail não existe
 *
 * Porque a diferença entre "não existe" e "existe" é informação, e dá para
 * perguntar várias vezes. Uma tela que responde "e-mail não cadastrado" é um
 * verificador de contas de graça: alguém com uma lista de e-mails vazados
 * descobre, em minutos, quais delas têm conta aqui — e passa a saber onde vale
 * a pena tentar senha.
 *
 * A tela responde a mesma frase nos dois casos. Esta função é o que torna isso
 * verdade do lado de dentro, e não só uma frase bonita na interface.
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

  /* Sem conta, ou conta inativa: não emite nada e não conta isso a ninguém. */
  if v_perfil.id is null or v_perfil.is_active is not true then
    return null;
  end if;

  /*
   * ESPERA ENTRE PEDIDOS — a defesa contra usar esta tela como máquina de
   * inundar a caixa de outra pessoa.
   *
   * O formulário é público e só precisa de um endereço. Sem este freio, um
   * laço de shell manda centenas de e-mails legítimos, assinados pelo nosso
   * domínio, para alguém que não pediu nada — e o custo não é só o incômodo:
   * é o nosso domínio sendo denunciado como remetente de spam, o que derruba
   * TODO o e-mail do sistema, inclusive o aviso de SLA.
   *
   * Sessenta segundos. E devolve `null`, a mesma resposta de "e-mail não
   * existe": dizer "espere um minuto" confirmaria que a conta existe, que é
   * justamente o que a função toda evita.
   */
  if exists (
    select 1 from public.auth_tokens
     where user_id = v_perfil.id
       and purpose = p_purpose
       and created_at > now() - interval '60 seconds'
  ) then
    return null;
  end if;

  /*
   * Os links anteriores da mesma finalidade morrem agora.
   *
   * Sem isto, pedir "esqueci a senha" três vezes deixaria três links válidos
   * circulando em três e-mails — e o mais antigo, que pode ter vazado num
   * encaminhamento, continuaria abrindo a porta. Pedir de novo tem de invalidar
   * o anterior, que é o que a pessoa espera ao pedir de novo.
   */
  update public.auth_tokens
     set used_at = now()
   where user_id = v_perfil.id
     and purpose = p_purpose
     and used_at is null;

  /* 32 bytes aleatórios do gerador do Postgres, em hexadecimal. */
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
      'Confirme este endereço para ativar a sua conta. O link vale por %s\n'
      'minutos e só funciona uma vez.\n\n'
      '/confirmar-email/%s\n\n'
      'Se você não criou conta nenhuma, ignore este e-mail.\n',
      coalesce(v_perfil.full_name, 'tudo bem'), greatest(p_minutos, 5)::text, v_token);
  end if;

  /*
   * Vai para a caixa de saída SEM consultar `app.quer_notificacao()`, e isso é
   * uma decisão: quem desligou os avisos desligou aviso de SLA, não o próprio
   * caminho de volta para a conta. Deixar a preferência mandar aqui trancaria a
   * pessoa para fora com uma opção que ela marcou para outra coisa.
   *
   * `dedupe_key` nula de propósito: o link de agora substitui o de antes, e a
   * idempotência da 0029 impediria justamente o reenvio que a pessoa pediu.
   */
  insert into public.email_outbox (tenant_id, to_email, to_name, subject, body_text, kind)
  values (v_perfil.tenant_id, v_perfil.email, v_perfil.full_name, v_assunto, v_corpo, p_purpose);

  return v_token;
end;
$$;

comment on function app.emitir_token_de_acesso(text, text, integer) is
  'Emite token de uso único e enfileira o e-mail. Devolve null quando o e-mail não tem conta — sem revelar isso a quem perguntou.';

-- -----------------------------------------------------------------------------
-- 4. Consumir
-- -----------------------------------------------------------------------------
/*
 * As três condições num ÚNICO update, pelo mesmo motivo da 0029: conferir antes
 * e gravar depois abre a janela em que dois cliques simultâneos passam os dois.
 * Aqui isso significaria duas trocas de senha a partir do mesmo link.
 */
create or replace function public.consumir_token_de_acesso(p_token text, p_purpose text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid;
begin
  update public.auth_tokens
     set used_at = now()
   where token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and purpose = p_purpose
     and used_at is null
     and expires_at > now()
  returning user_id into v_user;

  return v_user;
end;
$$;

comment on function public.consumir_token_de_acesso(text, text) is
  'Gasta o token e devolve de quem ele é, ou null. Uso único garantido pelo próprio update.';

/*
 * Só devolve se o token vale — nunca diz POR QUE não vale.
 *
 * "Expirado" e "já usado" e "não existe" dão a mesma resposta, de propósito:
 * distinguir ajudaria quem está tentando adivinhar token muito mais do que
 * ajuda quem perdeu o prazo, e para esse a instrução útil é a mesma nos três
 * casos — peça outro link.
 */
create or replace function public.token_de_acesso_vale(p_token text, p_purpose text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.auth_tokens
     where token_hash = encode(digest(p_token, 'sha256'), 'hex')
       and purpose = p_purpose
       and used_at is null
       and expires_at > now());
$$;

comment on function public.token_de_acesso_vale(text, text) is
  'Diz se o link ainda abre, sem dizer por que não abre. A tela usa para escolher o que mostrar.';

-- -----------------------------------------------------------------------------
-- 5. Limpeza
-- -----------------------------------------------------------------------------
/*
 * Token vencido não serve para nada e é registro de quem pediu o quê e quando.
 * Guardá-lo para sempre é acumular rastro sem função.
 *
 * Sete dias depois do vencimento, e não no vencimento: a janela serve para
 * investigar "pedi e não chegou" na semana em que a pessoa reclama.
 */
create or replace function app.job_purge_auth_tokens()
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_run_id bigint;
  v_count  integer;
begin
  insert into public.job_runs (job) values ('purge_auth_tokens') returning id into v_run_id;

  delete from public.auth_tokens where expires_at < now() - interval '7 days';
  get diagnostics v_count = row_count;

  update public.job_runs
     set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;

  return v_count;
end;
$$;

/* A cadência esperada, para o alerta da 0055 saber quando ele parou. */
insert into public.job_expectations (job, rotulo, tolerancia_min, observacao)
values ('purge_auth_tokens', 'Purga de tokens de acesso', 2880,
        'Diária; dois dias de silêncio ainda são toleráveis.')
on conflict (job) do nothing;

-- -----------------------------------------------------------------------------
-- 6. RLS e privilégios
-- -----------------------------------------------------------------------------
/*
 * NINGUÉM lê esta tabela pela aplicação — nem administrador.
 *
 * Não há policy de `select` para `authenticated`, e isso não é esquecimento: um
 * administrador que lesse `auth_tokens` não veria token nenhum (só hash), mas
 * veria quem pediu redefinição e quando, que é informação sobre a vida de outra
 * pessoa sem nenhuma função operacional.
 *
 * O que o suporte precisa saber é outra pergunta — "o e-mail saiu?" —, e ela se
 * responde em `email_outbox`, que guarda situação, tentativas e último erro.
 * **Essa tela ainda não existe**: hoje a resposta exige `psql`. Está anotado
 * como pendência; a ausência dela não é motivo para abrir esta tabela, que
 * responderia outra coisa.
 *
 * As três funções acima são `security definer` e são a única porta.
 */
alter table public.auth_tokens enable row level security;
alter table public.auth_tokens force row level security;

/*
 * A recusa é ESCRITA, e não deixada implícita.
 *
 * Habilitar RLS sem policy nenhuma já nega tudo — mas nega do mesmo jeito que
 * nega a tabela de alguém que habilitou RLS e esqueceu a policy. No catálogo,
 * "decidi que ninguém lê" e "esqueci" ficam idênticos, e a asserção §1 de
 * `schema_test.sql` cobra policy justamente porque o segundo caso é comum.
 *
 * `using (false)` diz a mesma coisa em voz alta: ninguém lê pela aplicação,
 * de propósito, e quem vier depois lê a intenção em vez de adivinhá-la.
 */
create policy auth_tokens_ninguem_le on public.auth_tokens
  for select to authenticated
  using (false);

grant execute on function public.consumir_token_de_acesso(text, text) to anon, authenticated;
grant execute on function public.token_de_acesso_vale(text, text) to anon, authenticated;
/* `emitir` NÃO vai para `anon`: quem pede o link é a Server Action, que roda no
   servidor e aplica o limite de tentativas. Exposta ao navegador, ela seria uma
   máquina de disparar e-mail em nome de qualquer endereço. */
grant execute on function app.emitir_token_de_acesso(text, text, integer) to service_role;
grant execute on function app.job_purge_auth_tokens() to service_role;
grant select, insert, update, delete on public.auth_tokens to service_role;
grant usage on sequence public.auth_tokens_id_seq to service_role;
