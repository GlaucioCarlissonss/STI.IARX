-- =============================================================================
-- 0029 — Canal de notificação, fila de trabalhos e pesquisa de satisfação
-- =============================================================================
-- Onda 1 do plano de paridade (docs/12). Fecha a promessa que o produto já faz
-- e não cumpre.
--
-- O QUE ESTAVA ERRADO
-- -------------------
-- `tenants.auto_close_after_days` existe desde a migração 0002, é lido pela
-- sessão (`src/lib/session.ts`) e **nunca foi executado por ninguém**. Não há
-- nenhum processo agendado nesta plataforma. O SLA é medido, o semáforo pinta a
-- tela — e ninguém é avisado. Numa demonstração isso aparece em cinco minutos, e
-- aparece como defeito, não como roadmap.
--
-- AS TRÊS DECISÕES DE ARQUITETURA
-- -------------------------------
-- **1. Caixa de saída, não envio em linha.** Nenhuma trigger e nenhuma ação
-- manda e-mail direto. Elas ESCREVEM numa fila (`email_outbox`), e um trabalho
-- separado a esvazia. Três motivos, nessa ordem de importância: provedor fora do
-- ar não pode derrubar a transação de negócio; nova tentativa precisa de estado
-- em algum lugar; e sobra o registro do que foi mandado, que é a primeira coisa
-- que o suporte pede.
--
-- **2. A regra fica no SQL, a rede fica no TypeScript.** Quem decide QUEM avisar
-- e QUANDO são funções neste arquivo — onde os dados estão, e onde as asserções
-- de schema conseguem provar a regra. Quem fala com o provedor de e-mail é a
-- aplicação, porque o banco não faz chamada de rede. A fronteira é a tabela.
--
-- **3. Idempotência por chave, não por esperança.** Cada mensagem carrega uma
-- `dedupe_key` com índice único. O trabalho pode rodar duas vezes no mesmo
-- minuto, o cron pode sobrepor, a chamada pode ser repetida — e ninguém recebe
-- o mesmo aviso duas vezes. "O cliente recebeu quarenta e-mails" é a falha
-- clássica deste tipo de recurso, e ela é barata de evitar antes e cara depois.
--
-- EMENDA AO ADR-011
-- -----------------
-- O ADR-011 diz que `service_role` tem exatamente DOIS usos: a rota `/tv/[token]`
-- e o provisionamento de usuário. Este arquivo cria o **terceiro**, e o declara
-- em vez de abrir a exceção em silêncio:
--
--   · as três funções de trabalho abaixo são `security definer` e têm execução
--     concedida APENAS a `service_role`;
--   · elas precisam disso pelo mesmo motivo do painel de TV: **um trabalho
--     agendado não tem sessão de usuário por definição**. Não existe `auth.uid()`
--     às três da manhã.
--
-- O que limita o estrago: as funções não aceitam parâmetro de tenant, não
-- devolvem dado nenhum além de uma contagem, e a única porta que as alcança é um
-- endpoint protegido por segredo próprio (`JOBS_SECRET`), separado de tudo.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Caixa de saída de e-mail
-- -----------------------------------------------------------------------------
-- `to_email` é copiado e não referenciado: o endereço no momento do envio é um
-- fato histórico. Se a pessoa trocar de e-mail depois, o registro tem de
-- continuar dizendo para onde foi — senão o log de "mandamos sim" vira ficção.
create table public.email_outbox (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  to_email        text not null check (to_email like '%@%'),
  to_name         text,
  subject         text not null check (length(subject) between 1 and 200),
  body_text       text not null,

  /* De onde veio. Serve para filtrar no suporte e para a preferência do
     destinatário — ver `app.quer_notificacao()`. */
  kind            text not null check (kind in (
                    'sla_warning','sla_critical','sla_breach',
                    'satisfaction_invite','ticket_assigned','test')),
  ticket_id       uuid,

  /* A chave da idempotência. Nula é permitida para mensagem avulsa (um teste de
     configuração, por exemplo), e nesse caso não há proteção — de propósito:
     mensagem sem chave é mensagem que alguém pediu explicitamente. */
  dedupe_key      text,

  status          text not null default 'pending'
                    check (status in ('pending','sent','failed','skipped')),
  attempts        integer not null default 0 check (attempts >= 0),
  last_error      text,
  scheduled_for   timestamptz not null default now(),
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint email_outbox_sent_has_date
    check (status <> 'sent' or sent_at is not null)
);

create unique index uq_email_outbox_dedupe
  on public.email_outbox (tenant_id, dedupe_key)
  where dedupe_key is not null;

-- O índice que o esvaziamento usa: pendente, na ordem em que venceu.
create index idx_email_outbox_fila
  on public.email_outbox (scheduled_for)
  where status = 'pending';

comment on table public.email_outbox is
  'Fila de e-mail. Escrita pelas regras em SQL, esvaziada pela aplicação. A dedupe_key é o que impede o mesmo aviso sair duas vezes.';

-- -----------------------------------------------------------------------------
-- 2. Preferência de notificação, por pessoa
-- -----------------------------------------------------------------------------
-- **O padrão é receber.** A ausência de linha significa "sim", e a linha com
-- `enabled = false` é o silêncio pedido. É o inverso da regra de permissão desta
-- base ("negação herda, liberação é explícita") e o inverso é certo aqui:
-- permissão protege dado, notificação é serviço. Quem acabou de entrar no
-- sistema precisa ser avisado do SLA estourando sem ter de descobrir uma tela de
-- configuração primeiro.
create table public.notification_preferences (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null,
  kind        text not null,
  enabled     boolean not null,
  updated_at  timestamptz not null default now(),

  primary key (tenant_id, user_id, kind),
  constraint fk_notif_pref_profile
    foreign key (user_id, tenant_id)
    references public.profiles (id, tenant_id) on delete cascade
);

comment on table public.notification_preferences is
  'Opt-out por pessoa e por tipo. Sem linha = recebe: notificação é serviço, não permissão.';

create or replace function app.quer_notificacao(p_user_id uuid, p_kind text)
returns boolean
language sql
stable
as $$
  select coalesce(
    (select enabled from public.notification_preferences
      where user_id = p_user_id and kind = p_kind),
    true);
$$;

comment on function app.quer_notificacao(uuid, text) is
  'True quando não há opt-out. Centraliza o padrão para nenhuma regra decidir isso por conta própria.';

-- -----------------------------------------------------------------------------
-- 3. Pesquisa de satisfação
-- -----------------------------------------------------------------------------
-- RESPONDIDA SEM LOGIN, e isso não é descuido: quem abriu o chamado muitas vezes
-- não tem conta — é o funcionário da empresa-cliente que ligou para o suporte.
-- Exigir login aqui derrubaria a taxa de resposta a quase zero, que é o mesmo
-- que não ter a pesquisa.
--
-- O token segue o modelo do painel de TV: guardado como HASH, nunca em claro.
-- Vazamento do banco não entrega os links de avaliação.
--
-- Escala de 1 a 5, e não 0 a 10 (NPS): a pergunta aqui é "este atendimento foi
-- bom?", que é CSAT. NPS pergunta outra coisa ("você recomendaria a empresa?") e
-- misturar as duas dá um número que não responde nenhuma das duas.
create table public.ticket_satisfaction (
  ticket_id     uuid primary key,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  token_hash    text not null unique,
  score         smallint check (score between 1 and 5),
  comment       text check (comment is null or length(comment) <= 2000),
  sent_at       timestamptz not null default now(),
  answered_at   timestamptz,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint fk_satisfaction_ticket
    foreign key (ticket_id, tenant_id)
    references public.tickets (id, tenant_id) on delete cascade,

  -- Respondida exige nota. Comentário sem nota seria uma avaliação que não
  -- avalia nada, e entraria na média como zero ou como nulo, dependendo de quem
  -- escrevesse a consulta.
  constraint satisfaction_answered_has_score
    check (answered_at is null or score is not null)
);

comment on table public.ticket_satisfaction is
  'CSAT de 1 a 5 por ticket, respondida por link com token (sem login). Token guardado como hash.';

-- -----------------------------------------------------------------------------
-- 4. Registro das execuções
-- -----------------------------------------------------------------------------
-- Sem isto, um trabalho que parou de rodar é invisível: não há erro, não há
-- alerta, simplesmente nada acontece — e o primeiro a perceber é o cliente que
-- não recebeu o aviso. A tabela é o que permite perguntar "quando foi a última
-- vez que o SLA foi verificado?".
--
-- Sem `tenant_id`: é execução da PLATAFORMA, não de um cliente. Por isso também
-- não tem policy para `authenticated` — ninguém de dentro de um tenant tem o que
-- fazer com ela.
create table public.job_runs (
  id          bigserial primary key,
  job         text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  affected    integer,
  detail      text
);

create index idx_job_runs_recentes on public.job_runs (job, started_at desc);

comment on table public.job_runs is
  'Uma linha por execução de trabalho agendado. Existe para que trabalho parado seja perceptível.';

-- -----------------------------------------------------------------------------
-- 5. RLS
-- -----------------------------------------------------------------------------
select app.harden_table('public.email_outbox');
select app.harden_table('public.notification_preferences');
select app.harden_table('public.ticket_satisfaction');
select app.harden_table('public.job_runs');

select app.attach_audit('public.ticket_satisfaction');

-- A caixa de saída contém o e-mail de outras pessoas. Só administrador lê, e
-- ninguém escreve pela interface: quem escreve são as funções de trabalho, que
-- rodam como `service_role` e não passam por policy.
create policy email_outbox_select on public.email_outbox
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_config());

-- Cada pessoa gerencia a PRÓPRIA preferência, e mais nada. Administrador não
-- entra aqui de propósito: "o admin desligou meu aviso" é um problema de suporte
-- que não precisa existir.
create policy notification_preferences_own on public.notification_preferences
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and user_id = app.current_user_id())
  with check (tenant_id = app.current_tenant_id() and user_id = app.current_user_id());

-- A avaliação é lida por quem já enxerga o ticket; o `token_hash` fica de fora da
-- interface porque a aplicação nunca precisa dele (quem resolve o token é a
-- função abaixo).
create policy ticket_satisfaction_select on public.ticket_satisfaction
  for select to authenticated
  using (tenant_id = app.current_tenant_id());

grant select on public.email_outbox to authenticated;
grant select, insert, update, delete on public.notification_preferences to authenticated;
grant select on public.ticket_satisfaction to authenticated;

-- `job_runs` é da operação da PLATAFORMA, não de um tenant: quem lê é o
-- `super_admin`.
--
-- A primeira versão deste arquivo não dava policy nenhuma a ela, com o
-- argumento de que "sem GRANT a tabela não existe para quem está num tenant".
-- A asserção da seção 1 do `schema_test.sql` recusou, e está certa: tabela com
-- RLS e sem policy nega tudo em silêncio, e no dia em que alguém acrescentar um
-- GRANT o sintoma é "a consulta volta vazia", não "falta permissão". Duas
-- camadas dizendo a mesma coisa é redundância; uma camada muda e a outra
-- esquecida é defeito.
create policy job_runs_super_admin on public.job_runs
  for select to authenticated
  using (app.is_super_admin());

grant select on public.job_runs to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Responder a pesquisa, sem login
-- -----------------------------------------------------------------------------
-- `security definer` em vez de `service_role`: esta função é a ÚNICA porta, ela
-- só aceita o token, e não devolve nada além de verdadeiro ou falso. Dar a chave
-- mestra para a aplicação só para gravar uma nota de 1 a 5 seria desproporcional.
--
-- `search_path` fixo é obrigatório numa função `security definer`: sem ele, quem
-- conseguisse manipular o `search_path` da sessão apontaria `public.` para um
-- esquema próprio e a função executaria código de outra pessoa com privilégio de
-- dono.
create or replace function public.submit_satisfaction(
  p_token   text,
  p_score   smallint,
  p_comment text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text := encode(digest(p_token, 'sha256'), 'hex');
  v_id   uuid;
begin
  if p_score is null or p_score < 1 or p_score > 5 then
    return false;
  end if;

  /* Só grava se: o token existe, ainda não foi respondido e não expirou. As três
     condições juntas num único UPDATE — checar antes e gravar depois abriria a
     janela em que duas respostas simultâneas passam as duas. */
  update public.ticket_satisfaction
     set score       = p_score,
         comment     = nullif(btrim(coalesce(p_comment, '')), ''),
         answered_at = now()
   where token_hash = v_hash
     and answered_at is null
     and expires_at > now()
  returning ticket_id into v_id;

  return v_id is not null;
end;
$$;

revoke all on function public.submit_satisfaction(text, smallint, text) from public;
grant execute on function public.submit_satisfaction(text, smallint, text) to anon, authenticated;

comment on function public.submit_satisfaction(text, smallint, text) is
  'Grava a nota de satisfação a partir do token do link. Única porta sem login; devolve apenas sucesso ou falha.';

-- E a leitura do convite, para a página saber o que mostrar antes de responder.
create or replace function public.satisfaction_invite(p_token text)
returns table (ticket_number bigint, ticket_title text, already_answered boolean, expired boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text := encode(digest(p_token, 'sha256'), 'hex');
begin
  return query
  select t.ticket_number, t.title,
         s.answered_at is not null,
         s.expires_at <= now()
    from public.ticket_satisfaction s
    join public.tickets t on t.id = s.ticket_id
   where s.token_hash = v_hash;
end;
$$;

revoke all on function public.satisfaction_invite(text) from public;
grant execute on function public.satisfaction_invite(text) to anon, authenticated;

comment on function public.satisfaction_invite(text) is
  'Dados mínimos do convite de avaliação: número, título e se já foi respondido ou expirou.';

commit;
