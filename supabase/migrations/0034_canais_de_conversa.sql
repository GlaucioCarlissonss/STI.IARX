-- =============================================================================
-- 0034 — Canais de conversa: WhatsApp, e-mail, Bitrix24 e N8N
-- =============================================================================
-- Onda 5 do plano de paridade (docs/12), acrescida do que foi pedido depois:
-- além da API oficial da Meta, integração com Bitrix24 e N8N.
--
-- A OBSERVAÇÃO QUE DEFINIU O DESENHO
-- ----------------------------------
-- WhatsApp, e-mail, chat do Bitrix24 e o que o N8N trouxer de Telegram, Slack ou
-- SMS **são o mesmo problema**: uma conversa acontecendo em outro lugar precisa
-- virar um chamado, e as respostas do chamado precisam voltar para onde a pessoa
-- escreveu.
--
-- Construir quatro recursos resolveria quatro vezes a mesma coisa — e a quinta
-- ferramenta exigiria a quinta vez. O que esta migração cria é UM núcleo de
-- conversa com adaptadores finos por provedor. O N8N é o adaptador universal:
-- com um webhook genérico de entrada e uma URL genérica de saída, ele liga
-- qualquer canal sem esta base precisar conhecê-lo.
--
-- POR QUE NÃO REUSAR `integrations`
-- ---------------------------------
-- A tentação é grande — a tabela existe desde a 0009, tem token de entrada,
-- supressão de eco e regras de mapeamento. Mas ela resolve outro problema:
-- mapear um REGISTRO externo (uma tarefa do Bitrix24) para um chamado, campo a
-- campo, nos dois sentidos.
--
-- Uma conversa não tem campos a mapear: tem remetente, texto e, às vezes, mídia.
-- E tem um problema que `integrations` não tem — **em qual chamado esta mensagem
-- entra?** Sobrecarregar a tabela com os dois significados deixaria metade das
-- colunas vazia em metade das linhas, e as duas perguntas ("qual campo vira
-- qual?" e "qual conversa é esta?") passariam a morar no mesmo lugar sem se
-- falar.
--
-- As duas convivem: `/integracoes` continua sendo o lugar de olhar as duas.
--
-- O ECO, QUE É O DEFEITO CLÁSSICO DESTE RECURSO
-- ---------------------------------------------
-- A resposta de um atendente vira comentário no chamado; o comentário dispara o
-- envio para o WhatsApp; o WhatsApp confirma a entrega com um evento; o evento
-- vira comentário; o comentário dispara o envio... Em minutos a pessoa recebeu
-- quarenta mensagens.
--
-- Três coisas cortam isso, e as três estão aqui: a mensagem de ENTRADA registra
-- qual comentário ela gerou, a trigger de saída ignora comentários que já são
-- entrada, e o `external_id` tem índice único — reentrega do provedor (que o
-- WhatsApp faz por desenho) não vira segunda mensagem.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Canais
-- -----------------------------------------------------------------------------
-- Um canal é uma CONFIGURAÇÃO: "o WhatsApp da matriz", "o suporte@empresa.com".
-- Um tenant pode ter vários do mesmo tipo, e é comum que tenha — um número por
-- empresa-cliente é o arranjo normal de quem presta serviço para terceiros.
create table public.channels (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  name          text not null check (length(trim(name)) between 2 and 120),
  kind          text not null check (kind in ('whatsapp', 'email', 'bitrix24', 'n8n')),
  status        text not null default 'ativo' check (status in ('ativo', 'pausado', 'erro')),

  /* SHA-256 do token que vai na URL de entrada. O valor em claro aparece uma vez,
     na criação — mesmo contrato de `dashboard_tokens` (ADR-006) e de
     `agent_enrollments` (0031).

     Ele identifica o canal: o provedor chama
     `/api/canais/<token>` e é o token que diz qual canal é. Sem isso, a rota
     precisaria confiar num identificador no corpo — e o corpo é escrito por
     quem chama. */
  inbound_token_hash text not null unique,

  /* Para onde a resposta sai. No WhatsApp é a Graph API; no N8N é o webhook que
     o cliente criou; no Bitrix24 é o webhook de entrada dele. */
  outbound_url  text check (outbound_url is null or outbound_url like 'https://%'),

  /*
   * O NOME da variável de ambiente que guarda a credencial, nunca a credencial.
   *
   * É o ADR-009 aplicado: o banco guarda a referência, o ambiente guarda o
   * valor. Um token de acesso da Meta numa linha de tabela é um token que
   * aparece em backup, em export de suporte e na tela de quem tem select.
   */
  secret_ref    text check (secret_ref is null or secret_ref ~ '^[A-Z][A-Z0-9_]{2,60}$'),

  /* Específico do provedor: `phone_number_id` e `waba_id` no WhatsApp, o endereço
     monitorado no e-mail, o id do Open Line no Bitrix24. */
  config        jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),

  /* Onde o chamado nasce. `queue_id` e `priority_id` de `tickets` são NOT NULL,
     então sem padrão não há como criar chamado a partir de uma mensagem. */
  default_queue_id    uuid,
  default_priority_id uuid,
  /* Cliente padrão: usado quando o contato não resolve para ninguém conhecido.
     Nulo é legítimo — o chamado nasce sem cliente, e alguém classifica. */
  default_client_id   uuid,

  /*
   * Falso = as mensagens chegam e ficam registradas, e NÃO criam chamado.
   *
   * Serve para ligar um canal e observar o volume antes de deixá-lo abrir
   * chamado — que é o que se quer fazer com um número de WhatsApp divulgado
   * publicamente, antes de descobrir que 80% do tráfego é propaganda.
   */
  abre_chamado  boolean not null default true,

  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  constraint uq_channel_id_tenant unique (id, tenant_id),
  constraint fk_channel_queue foreign key (default_queue_id, tenant_id)
    references public.queues (id, tenant_id) on delete set null,
  constraint fk_channel_priority foreign key (default_priority_id, tenant_id)
    references public.ticket_priorities (id, tenant_id) on delete set null,
  constraint fk_channel_client foreign key (default_client_id, tenant_id)
    references public.clients (id, tenant_id) on delete set null,

  /* Canal que abre chamado precisa saber ONDE abrir. Deixar isso para o momento
     da primeira mensagem faria a mensagem ser perdida — e perdida em silêncio,
     porque quem escreveu no WhatsApp não vê erro nenhum. */
  constraint channel_abre_precisa_de_destino
    check (not abre_chamado or (default_queue_id is not null and default_priority_id is not null))
);

create index idx_channels_ativos on public.channels (tenant_id, kind)
  where status = 'ativo' and deleted_at is null;

comment on table public.channels is
  'Um canal de conversa configurado. O token de entrada identifica o canal; a credencial de saída mora no ambiente (ADR-009).';

-- -----------------------------------------------------------------------------
-- 2. Contatos
-- -----------------------------------------------------------------------------
-- Quem é `+5544999887766`?
--
-- Sem esta tabela, todo chamado vindo do WhatsApp é anônimo — e um chamado
-- anônimo não tem cliente, não tem filial, não tem SLA e não dá para responder a
-- pesquisa de satisfação. É a tabela que transforma "uma mensagem de um número"
-- em "um chamado da Fulana, da filial de Londrina".
create table public.channel_contacts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  channel_id    uuid not null,

  /* O identificador NO canal: telefone em E.164, endereço de e-mail, id de
     usuário do Bitrix24. Normalizado por quem recebe, não aqui — a normalização
     é específica do provedor. */
  external_id   text not null check (length(trim(external_id)) between 1 and 200),
  display_name  text,

  /* A pessoa, quando dá para saber. Nulo é o caso comum num número novo, e não é
     um defeito: a primeira mensagem de alguém que nunca escreveu não tem como
     resolver para um cadastro. */
  profile_id    uuid,
  client_id     uuid,
  branch_id     uuid,

  /*
   * Bloqueado: as mensagens continuam sendo registradas e NÃO viram chamado.
   *
   * Registrar em vez de descartar é deliberado. Um número bloqueado por engano
   * precisa ser descoberto, e "a mensagem sumiu" não deixa rastro para descobrir
   * nada. Além disso, o volume de um número bloqueado é a informação que diz se o
   * bloqueio ainda faz sentido.
   */
  bloqueado     boolean not null default false,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint uq_contact_no_canal unique (channel_id, external_id),
  constraint uq_contact_id_tenant unique (id, tenant_id),
  constraint fk_contact_channel foreign key (channel_id, tenant_id)
    references public.channels (id, tenant_id) on delete cascade,
  constraint fk_contact_profile foreign key (profile_id, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,
  constraint fk_contact_client foreign key (client_id, tenant_id)
    references public.clients (id, tenant_id) on delete set null,
  constraint fk_contact_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete set null
);

create index idx_contacts_tenant on public.channel_contacts (tenant_id, channel_id);

comment on table public.channel_contacts is
  'Quem é o número que escreveu. Sem isto, todo chamado vindo do WhatsApp é anônimo — sem cliente, sem filial e sem SLA.';

-- -----------------------------------------------------------------------------
-- 3. Conversas
-- -----------------------------------------------------------------------------
-- A conversa é o que responde "em qual chamado esta mensagem entra?".
--
-- A regra é uma só, e a decisão está nela: **uma conversa aberta por contato por
-- canal**. A mensagem seguinte do mesmo número entra no mesmo chamado enquanto
-- ele estiver aberto; quando ele fecha, a próxima mensagem abre outro.
--
-- A alternativa (uma conversa por mensagem) produziria um chamado por "bom dia",
-- e a fila do helpdesk viraria a caixa de entrada do WhatsApp. A outra
-- alternativa (uma conversa eterna) empilharia dois anos de assuntos diferentes
-- no mesmo chamado.
create table public.channel_conversations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  channel_id    uuid not null,
  contact_id    uuid not null,
  ticket_id     uuid,

  status        text not null default 'aberta' check (status in ('aberta', 'fechada')),
  /* O id da thread no provedor, quando ele tem um. O e-mail tem (`Message-ID` e
     `In-Reply-To`); o WhatsApp não. */
  external_thread_id text,

  last_message_at timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint uq_conversation_id_tenant unique (id, tenant_id),
  constraint fk_conv_channel foreign key (channel_id, tenant_id)
    references public.channels (id, tenant_id) on delete cascade,
  constraint fk_conv_contact foreign key (contact_id, tenant_id)
    references public.channel_contacts (id, tenant_id) on delete cascade,
  constraint fk_conv_ticket foreign key (ticket_id, tenant_id)
    references public.tickets (id, tenant_id) on delete set null
);

-- UMA conversa aberta por contato por canal. É a regra de threading, no banco:
-- duas mensagens simultâneas do mesmo número não podem produzir dois chamados.
create unique index uq_conversa_aberta
  on public.channel_conversations (channel_id, contact_id)
  where status = 'aberta';

create index idx_conversas_recentes
  on public.channel_conversations (tenant_id, last_message_at desc);

-- O caminho de volta: dado um chamado, qual conversa responder.
create index idx_conversas_por_ticket
  on public.channel_conversations (ticket_id)
  where status = 'aberta' and ticket_id is not null;

comment on table public.channel_conversations is
  'A thread. Uma conversa aberta por contato por canal: é a regra que impede a fila de virar a caixa de entrada do WhatsApp.';

-- -----------------------------------------------------------------------------
-- 4. Mensagens
-- -----------------------------------------------------------------------------
-- Entrada e saída na mesma tabela, porque a pergunta que se faz é sempre "o que
-- foi dito nesta conversa, em ordem" — e duas tabelas obrigariam a um `union` em
-- toda leitura.
create table public.channel_messages (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  channel_id    uuid not null,
  conversation_id uuid,

  direction     text not null check (direction in ('entrada', 'saida')),

  /*
   * O id da mensagem NO provedor. É a idempotência, e ela não é opcional: o
   * WhatsApp reentrega o webhook quando não recebe 200 rápido o bastante, por
   * desenho. Sem o índice único, uma reentrega vira uma segunda mensagem no
   * chamado — e o atendente lê a mesma pergunta duas vezes.
   *
   * Nulo é permitido para a SAÍDA antes de o provedor confirmar: aí o id ainda
   * não existe.
   */
  external_id   text,

  body          text,
  /* Mídia por referência, nunca por conteúdo: o WhatsApp entrega uma URL com
     prazo, e baixar o arquivo é decisão de outra onda. O que fica é o tipo, o
     nome e a URL — o bastante para saber que houve um anexo e ir buscá-lo. */
  media         jsonb not null default '[]'::jsonb check (jsonb_typeof(media) = 'array'),

  status        text not null default 'recebida'
                  check (status in ('recebida', 'na_fila', 'enviada', 'falhou', 'ignorada')),
  attempts      integer not null default 0 check (attempts >= 0),
  last_error    text,
  scheduled_for timestamptz not null default now(),
  sent_at       timestamptz,

  /* O comentário que esta mensagem gerou (entrada) ou de onde ela veio (saída).
     É a terceira trava contra o eco — ver o cabeçalho. */
  comment_id    uuid,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint fk_msg_channel foreign key (channel_id, tenant_id)
    references public.channels (id, tenant_id) on delete cascade,
  constraint fk_msg_conversation foreign key (conversation_id, tenant_id)
    references public.channel_conversations (id, tenant_id) on delete cascade,
  constraint fk_msg_comment foreign key (comment_id, tenant_id)
    references public.ticket_comments (id, tenant_id) on delete set null,

  constraint msg_enviada_tem_data
    check (status <> 'enviada' or sent_at is not null)
);

create unique index uq_msg_externo
  on public.channel_messages (channel_id, external_id)
  where external_id is not null;

-- O índice que a drenagem usa: o que está na fila, na ordem em que venceu.
create index idx_msg_fila
  on public.channel_messages (scheduled_for)
  where status = 'na_fila';

create index idx_msg_conversa
  on public.channel_messages (conversation_id, created_at);

comment on table public.channel_messages is
  'Toda mensagem, nos dois sentidos. O índice único por (canal, external_id) é o que faz reentrega do provedor não virar mensagem duplicada.';

-- -----------------------------------------------------------------------------
-- 5. A chave estrangeira que faltava em ticket_comments
-- -----------------------------------------------------------------------------
-- `channel_messages.comment_id` precisa apontar para `(id, tenant_id)`, e
-- `ticket_comments` só tinha a chave primária simples. É o padrão de chave
-- composta do ADR-001: sem ele, uma mensagem de um tenant poderia referenciar o
-- comentário de outro.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'uq_comment_id_tenant'
  ) then
    alter table public.ticket_comments
      add constraint uq_comment_id_tenant unique (id, tenant_id);
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 6. Entrada: a função que recebe de qualquer canal
-- -----------------------------------------------------------------------------
-- `security definer` concedida a `anon`, pelo mesmo raciocínio da 0031: quem
-- chama é um provedor, não uma pessoa; a função é a única porta; o tenant é
-- DERIVADO do token, e não existe parâmetro de tenant para falsificar.
--
-- Ela recebe a mensagem JÁ NORMALIZADA. A tradução do formato de cada provedor
-- (o `entry[].changes[].value.messages[]` da Meta, o payload do Bitrix24, o que o
-- N8N montar) acontece em TypeScript, onde a assinatura do webhook também é
-- conferida. O banco recebe sempre a mesma forma:
--
--   { "externo": "wamid.ABC", "de": "+5544999887766", "nome": "Fulana",
--     "texto": "bom dia, a impressora parou", "em": "2026-10-25T12:00:00Z",
--     "midia": [{"tipo":"image","nome":"foto.jpg","url":"https://..."}] }
create or replace function public.channel_ingest(
  p_token    text,
  p_mensagem jsonb
)
returns table (status text, ticket_id uuid, message_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash     text := encode(digest(p_token, 'sha256'), 'hex');
  v_canal    public.channels;
  v_externo  text := nullif(trim(coalesce(p_mensagem ->> 'externo', '')), '');
  v_de       text := nullif(trim(coalesce(p_mensagem ->> 'de', '')), '');
  v_texto    text := nullif(trim(coalesce(p_mensagem ->> 'texto', '')), '');
  v_quando   timestamptz := coalesce((nullif(p_mensagem ->> 'em', ''))::timestamptz, now());
  v_contato  public.channel_contacts;
  v_conversa public.channel_conversations;
  v_ticket   uuid;
  v_msg      uuid;
  v_comment  uuid;
  v_fechado  boolean;
begin
  select * into v_canal from public.channels
   where inbound_token_hash = v_hash
     -- `channels.status`, qualificado: a função tem um parâmetro de saída `status`,
     -- e sem a qualificação o Postgres recusa a referência como ambígua.
     and channels.status = 'ativo'
     and deleted_at is null;
  if not found then
    return query select 'unauthorized'::text, null::uuid, null::uuid;
    return;
  end if;

  if v_de is null then
    -- Sem remetente não há contato, e sem contato não há conversa. É recusa de
    -- forma, não de autorização: quem chamou acertou o token e errou o corpo.
    return query select 'malformed'::text, null::uuid, null::uuid;
    return;
  end if;

  update public.channels set last_inbound_at = now() where id = v_canal.id;

  -- --- Contato ---------------------------------------------------------------
  select * into v_contato from public.channel_contacts
   where channel_id = v_canal.id and external_id = v_de;

  if not found then
    insert into public.channel_contacts (
      tenant_id, channel_id, external_id, display_name, client_id, profile_id
    ) values (
      v_canal.tenant_id, v_canal.id, v_de,
      nullif(trim(coalesce(p_mensagem ->> 'nome', '')), ''),
      v_canal.default_client_id,
      /*
       * Tenta casar com um cadastro. No e-mail o identificador JÁ É o endereço,
       * então o casamento é exato; no WhatsApp compara só os dígitos, porque o
       * telefone no cadastro vem escrito de seis jeitos diferentes
       * ("(44) 99988-7766", "+5544999887766", "44999887766") e nenhum deles é o
       * formato que a Meta entrega.
       */
      (select p.id from public.profiles p
        where p.tenant_id = v_canal.tenant_id
          and p.is_active
          and (
            (v_canal.kind = 'email' and lower(p.email) = lower(v_de))
            or (v_canal.kind <> 'email'
                and p.phone is not null
                and regexp_replace(p.phone, '\D', '', 'g') <> ''
                -- Compara pelos últimos 8 dígitos: é o que sobrevive a DDI e DDD
                -- escritos (ou não) de jeitos diferentes nas duas pontas.
                and right(regexp_replace(p.phone, '\D', '', 'g'), 8)
                  = right(regexp_replace(v_de, '\D', '', 'g'), 8))
          )
        limit 1)
    )
    returning * into v_contato;
  elsif v_contato.display_name is null and nullif(trim(coalesce(p_mensagem ->> 'nome', '')), '') is not null then
    -- O nome do perfil do WhatsApp às vezes só vem na segunda mensagem.
    update public.channel_contacts
       set display_name = trim(p_mensagem ->> 'nome')
     where id = v_contato.id
    returning * into v_contato;
  end if;

  -- --- A mensagem, antes de qualquer efeito ----------------------------------
  -- Gravada primeiro e com `on conflict do nothing`: se o provedor reentregar, a
  -- função sai aqui sem criar chamado nem comentário. Fazer o contrário —
  -- registrar depois dos efeitos — deixaria a reentrega duplicar o comentário.
  insert into public.channel_messages (
    tenant_id, channel_id, direction, external_id, body, media, status, created_at
  ) values (
    v_canal.tenant_id, v_canal.id, 'entrada', v_externo, v_texto,
    coalesce(p_mensagem -> 'midia', '[]'::jsonb), 'recebida', v_quando
  )
  on conflict (channel_id, external_id) where external_id is not null do nothing
  returning id into v_msg;

  if v_msg is null then
    return query select 'duplicate'::text, null::uuid, null::uuid;
    return;
  end if;

  -- Contato bloqueado ou canal em observação: a mensagem FICA REGISTRADA e não
  -- vira chamado. Registrar em vez de descartar é o que permite descobrir um
  -- bloqueio feito por engano — "a mensagem sumiu" não deixa rastro.
  if v_contato.bloqueado or not v_canal.abre_chamado then
    update public.channel_messages set status = 'ignorada' where id = v_msg;
    return query select
      case when v_contato.bloqueado then 'blocked' else 'logged' end,
      null::uuid, v_msg;
    return;
  end if;

  -- --- Conversa --------------------------------------------------------------
  select * into v_conversa from public.channel_conversations
   where channel_id = v_canal.id
     and contact_id = v_contato.id
     and channel_conversations.status = 'aberta';

  if found then
    -- Chamado fechado encerra a conversa: o assunto seguinte é outro chamado.
    -- Sem isto, dois anos de assuntos diferentes se empilhariam no mesmo.
    select (t.status in ('closed', 'resolved')) into v_fechado
      from public.tickets t where t.id = v_conversa.ticket_id;

    if v_conversa.ticket_id is null or coalesce(v_fechado, true) then
      update public.channel_conversations set status = 'fechada' where id = v_conversa.id;
      v_conversa := null;
    end if;
  end if;

  if v_conversa.id is null then
    insert into public.tickets (
      tenant_id, title, description, status, priority_id, queue_id,
      client_id, branch_id, requester_id, source, change_source
    ) values (
      v_canal.tenant_id,
      -- O título é o começo da mensagem. Não é bonito e é o melhor disponível:
      -- quem escreve no WhatsApp não escreve assunto, e um título fixo ("Mensagem
      -- do WhatsApp") deixaria a fila inteira com o mesmo nome.
      left(coalesce(v_texto, 'Mensagem de ' || coalesce(v_contato.display_name, v_de)), 200),
      v_texto,
      'open',
      v_canal.default_priority_id,
      v_canal.default_queue_id,
      coalesce(v_contato.client_id, v_canal.default_client_id),
      v_contato.branch_id,
      v_contato.profile_id,
      -- `integration` e não `ui`: o chamado não nasceu de alguém na tela.
      'integration', 'integration'
    )
    returning id into v_ticket;

    insert into public.channel_conversations (
      tenant_id, channel_id, contact_id, ticket_id,
      external_thread_id, last_message_at
    ) values (
      v_canal.tenant_id, v_canal.id, v_contato.id, v_ticket,
      nullif(p_mensagem ->> 'thread', ''), v_quando
    )
    returning * into v_conversa;
  else
    v_ticket := v_conversa.ticket_id;

    -- Mensagem numa conversa aberta vira comentário PÚBLICO: foi escrita pela
    -- pessoa, e ela precisa poder ler a própria pergunta no chamado.
    insert into public.ticket_comments (
      tenant_id, ticket_id, author_id, body, visibility, source, external_id
    ) values (
      v_canal.tenant_id, v_ticket, v_contato.profile_id,
      coalesce(v_texto, '(mensagem sem texto)'),
      'public', 'integration', v_externo
    )
    returning id into v_comment;

    update public.channel_conversations
       set last_message_at = v_quando
     where id = v_conversa.id;
  end if;

  update public.channel_messages
     set conversation_id = v_conversa.id,
         comment_id      = v_comment
   where id = v_msg;

  return query select 'stored'::text, v_ticket, v_msg;
end;
$$;

revoke all on function public.channel_ingest(text, jsonb) from public;
grant execute on function public.channel_ingest(text, jsonb) to anon, authenticated;

comment on function public.channel_ingest(text, jsonb) is
  'Recebe uma mensagem já normalizada de qualquer canal. Idempotente por (canal, external_id); grava a mensagem ANTES de qualquer efeito.';

-- -----------------------------------------------------------------------------
-- 6.1 Que canal é este?
-- -----------------------------------------------------------------------------
-- A rota de entrada precisa saber QUAL PROVEDOR está falando antes de poder
-- interpretar o corpo — e, no caso da Meta, antes de poder conferir a assinatura
-- do webhook, que é feita sobre os bytes crus.
--
-- Ela devolve o mínimo para isso: o tipo, o estado e a configuração. **Não
-- devolve o tenant_id**, e é deliberado: a rota não precisa dele (quem amarra a
-- mensagem ao tenant é `channel_ingest`, pelo mesmo token), e não devolver é uma
-- coisa a menos que um defeito na rota poderia vazar.
create or replace function public.channel_por_token(p_token text)
returns table (kind text, status text, config jsonb, secret_ref text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.kind, c.status, c.config, c.secret_ref
    from public.channels c
   where c.inbound_token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and c.deleted_at is null;
$$;

revoke all on function public.channel_por_token(text) from public;
grant execute on function public.channel_por_token(text) to anon, authenticated;

comment on function public.channel_por_token(text) is
  'O tipo e a configuração do canal, a partir do token de entrada. Não devolve tenant_id: a rota não precisa dele.';

-- -----------------------------------------------------------------------------
-- 7. Saída: a resposta volta para onde a pessoa escreveu
-- -----------------------------------------------------------------------------
-- A trigger é o que torna isto omnichannel em vez de uma caixa de entrada: o
-- atendente responde no chamado, como sempre fez, e a resposta chega no WhatsApp
-- sem ele precisar saber que o chamado veio de lá.
--
-- As três condições são cada uma uma trava contra o eco:
--   1. só comentário PÚBLICO (nota interna é da equipe, e vazá-la seria grave);
--   2. só se houver conversa ABERTA para o chamado;
--   3. só se o comentário NÃO for ele próprio uma mensagem de entrada.
create or replace function app.channel_enfileirar_resposta()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conversa public.channel_conversations;
begin
  if new.visibility <> 'public' or new.deleted_at is not null then
    return new;
  end if;

  /*
   * A trava do eco.
   *
   * O comentário criado por `channel_ingest` tem `source = 'integration'` e
   * carrega o `external_id` da mensagem que o gerou. Reenviá-lo faria a pessoa
   * receber de volta o que ela acabou de escrever — e a confirmação disso
   * geraria outra mensagem, e assim por diante.
   *
   * Conferir `source` sozinho não bastaria: uma integração de tickets (0009)
   * também escreve com `source = 'integration'`, e aquele comentário DEVE sair
   * para o canal. O que distingue é o `external_id`, que só a entrada de canal
   * preenche.
   */
  if new.source = 'integration' and new.external_id is not null then
    return new;
  end if;

  select * into v_conversa from public.channel_conversations
   where ticket_id = new.ticket_id and status = 'aberta'
   limit 1;
  if not found then
    return new;
  end if;

  insert into public.channel_messages (
    tenant_id, channel_id, conversation_id, direction, body, status, comment_id
  ) values (
    new.tenant_id, v_conversa.channel_id, v_conversa.id, 'saida',
    new.body, 'na_fila', new.id
  );

  return new;
end;
$$;

create trigger trg_comment_para_canal
  after insert on public.ticket_comments
  for each row execute function app.channel_enfileirar_resposta();

comment on function app.channel_enfileirar_resposta() is
  'Comentário público num chamado com conversa aberta vira mensagem na fila de saída. As três condições são travas contra o eco.';

-- -----------------------------------------------------------------------------
-- 8. Quando o chamado fecha, a conversa fecha
-- -----------------------------------------------------------------------------
-- Fechar aqui, e não só preguiçosamente na próxima mensagem, é o que faz a caixa
-- de conversas refletir a realidade: uma conversa "aberta" cujo chamado foi
-- encerrado há duas semanas é uma linha que mente na tela de quem atende.
create or replace function app.channel_fechar_conversa()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('closed', 'resolved') and old.status not in ('closed', 'resolved') then
    update public.channel_conversations
       set status = 'fechada'
     where ticket_id = new.id and status = 'aberta';
  end if;
  return new;
end;
$$;

create trigger trg_ticket_fecha_conversa
  after update of status on public.tickets
  for each row execute function app.channel_fechar_conversa();

-- -----------------------------------------------------------------------------
-- 9. RLS
-- -----------------------------------------------------------------------------
select app.harden_table('public.channels');
select app.harden_table('public.channel_contacts');
select app.harden_table('public.channel_conversations');
select app.harden_table('public.channel_messages');

select app.attach_audit('public.channels');
select app.attach_audit('public.channel_contacts');
-- Conversas e mensagens NÃO são auditadas: elas são o próprio registro. Auditar
-- gravaria uma segunda cópia de cada mensagem em `audit_log` — a mesma aritmética
-- que tirou as métricas da trilha na 0032.

-- O canal guarda credencial por referência e token por hash. Só administrador.
create policy channels_rw on public.channels
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('canais.canais.gerenciar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('canais.canais.gerenciar'));

-- Mas quem atende precisa SABER que o canal existe, para ler o nome dele na
-- conversa. Uma policy de leitura separada, sem as colunas sensíveis expostas
-- pela view abaixo.
create policy channels_select on public.channels
  for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and (app.has_permission('canais.conversas.ver')
              or app.has_permission('canais.canais.ver')));

create policy channel_contacts_select on public.channel_contacts
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('canais.conversas.ver'));

-- Classificar um contato (dizer de qual cliente ele é, ou bloqueá-lo) é trabalho
-- de quem atende: é na conversa que se descobre quem é o número.
create policy channel_contacts_update on public.channel_contacts
  for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('canais.conversas.responder'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('canais.conversas.responder'));

create policy channel_conversations_select on public.channel_conversations
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('canais.conversas.ver'));

create policy channel_messages_select on public.channel_messages
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('canais.conversas.ver'));

grant select, insert, update, delete on public.channels to authenticated;
grant select, update on public.channel_contacts to authenticated;
grant select on public.channel_conversations to authenticated;
grant select on public.channel_messages to authenticated;

-- -----------------------------------------------------------------------------
-- 10. A caixa de conversas
-- -----------------------------------------------------------------------------
-- `inbound_token_hash` e `secret_ref` ficam de FORA de propósito: a tela de
-- conversas não precisa deles, e uma view que os carregasse os entregaria a quem
-- tem `canais.conversas.ver` — que é toda a equipe de atendimento.
create or replace view public.vw_channel_conversations
with (security_invoker = true) as
select
  c.id              as conversation_id,
  c.tenant_id,
  c.status,
  c.last_message_at,
  c.ticket_id,
  ch.id             as channel_id,
  ch.name           as channel_name,
  ch.kind           as channel_kind,
  ct.id             as contact_id,
  ct.external_id    as contact_external_id,
  ct.display_name   as contact_name,
  ct.bloqueado      as contact_bloqueado,
  ct.profile_id,
  p.full_name       as profile_name,
  cl.trade_name     as client_name,
  t.ticket_number,
  t.title           as ticket_title,
  t.status          as ticket_status,
  (select count(*) from public.channel_messages m
    where m.conversation_id = c.id) as mensagens,
  (select count(*) from public.channel_messages m
    where m.conversation_id = c.id and m.status = 'falhou') as falhas
from public.channel_conversations c
join public.channels ch on ch.id = c.channel_id
join public.channel_contacts ct on ct.id = c.contact_id
left join public.profiles p on p.id = ct.profile_id
left join public.clients cl on cl.id = ct.client_id
left join public.tickets t on t.id = c.ticket_id and t.deleted_at is null;

grant select on public.vw_channel_conversations to authenticated;

comment on view public.vw_channel_conversations is
  'A caixa de conversas. NÃO carrega o token nem a referência de credencial: ela é lida por toda a equipe de atendimento.';

-- -----------------------------------------------------------------------------
-- 11. Catálogo de permissões
-- -----------------------------------------------------------------------------
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('canais', 'canais', null, null, 'Canais de conversa', 'atendente', 440),

  ('canais.conversas', 'canais', 'conversas', null, 'Conversas', 'atendente', 441),
  ('canais.conversas.ver', 'canais', 'conversas', 'ver',
   'Ler as conversas', 'atendente', 442),
  ('canais.conversas.responder', 'canais', 'conversas', 'responder',
   'Responder e classificar contatos', 'atendente', 443),

  ('canais.canais', 'canais', 'canais', null, 'Configuração dos canais', 'admin', 444),
  ('canais.canais.ver', 'canais', 'canais', 'ver',
   'Consultar os canais configurados', 'admin', 445),
  ('canais.canais.gerenciar', 'canais', 'canais', 'gerenciar',
   'Ligar e desligar canais', 'admin', 446)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

/*
 * O módulo entra nos perfis de sistema.
 *
 * `canais.conversas.*` tem teto `atendente` porque ler e responder conversa É
 * atender — não faria sentido que quem trabalha a fila precisasse de permissão
 * extra para ler a pergunta que chegou pelo WhatsApp.
 *
 * `canais.canais.gerenciar` tem teto `admin` porque o canal guarda a referência
 * da credencial e emite o token de entrada: é configuração de infraestrutura, da
 * mesma natureza que emitir token de painel de TV.
 */
create or replace function app.seed_system_access_profiles(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile record;
begin
  insert into public.access_profiles (tenant_id, name, description, base_role, is_system, system_key)
  values
    (p_tenant_id, 'Admin do Cliente',
     'Acesso total ao ambiente do cliente.', 'admin', true, 'admin_cliente'),
    (p_tenant_id, 'Diretoria',
     'Leitura de tudo que o papel gestor alcança, sem escrita.', 'gestor', true, 'diretoria'),
    (p_tenant_id, 'Gestor de TI',
     'Operação de TI completa: helpdesk, inventário, telefonia, conectividade, mapas, SLA e cadastros.',
     'gestor', true, 'gestor_ti'),
    (p_tenant_id, 'Operador de TI',
     'Atende ticket e consulta inventário, telefonia e links; não cadastra.',
     'atendente', true, 'operador_ti'),
    (p_tenant_id, 'Gestor Financeiro',
     'Financeiro completo, mais fornecedores e leitura de clientes.', 'gestor', true, 'gestor_financeiro'),
    (p_tenant_id, 'Operador Financeiro',
     'Lança despesa e movimentação; não cadastra conta, não transfere e não aprova.',
     'gestor', true, 'operador_financeiro'),
    (p_tenant_id, 'Aprovador Financeiro',
     'Consulta o financeiro e aprova o que a alçada permitir.', 'gestor', true, 'aprovador_financeiro'),
    (p_tenant_id, 'Visualizador',
     'Somente leitura do que o papel visualizador alcança.', 'visualizador', true, 'visualizador'),
    (p_tenant_id, 'Solicitante',
     'Abre e acompanha os próprios tickets; consulta o que o papel alcança.',
     'solicitante', true, 'solicitante')
  on conflict do nothing;

  update public.access_profiles set description =
    'Operação de TI completa: helpdesk, inventário, telefonia, conectividade, mapas, SLA e cadastros.'
   where tenant_id = p_tenant_id and system_key = 'gestor_ti';
  update public.access_profiles set description =
    'Atende ticket e consulta inventário, telefonia e links; não cadastra.'
   where tenant_id = p_tenant_id and system_key = 'operador_ti';

  for v_profile in
    select id, base_role, system_key from public.access_profiles
    where tenant_id = p_tenant_id and is_system
  loop
    insert into public.permission_grants (tenant_id, profile_id, permission_key)
    select p_tenant_id, v_profile.id, c.key
    from public.permission_catalog c
    where app.role_rank(c.min_base_role) <= app.role_rank(v_profile.base_role)
      and case v_profile.system_key
        when 'admin_cliente' then true

        when 'diretoria'    then c.action is null or c.action = 'ver'
        when 'visualizador' then c.action is null or c.action = 'ver'

        -- `canais` entra aqui: conversa que vira chamado é operação de TI.
        when 'gestor_ti' then c.module in
          ('helpdesk','inventario','telefonia','conectividade','mapas','sla',
           'clientes','fornecedores','tv','autoatendimento','canais')

        -- O operador lê e RESPONDE conversa — é o trabalho dele. Mas não liga nem
        -- desliga canal: isso guarda credencial.
        when 'operador_ti' then
          c.module in ('helpdesk','autoatendimento')
          or (c.module = 'canais' and c.screen is distinct from 'canais')
          or (c.module in ('inventario','telefonia','conectividade','mapas')
              and (c.action is null or c.action = 'ver'))

        when 'gestor_financeiro' then
          c.module in ('financeiro','fornecedores')
          or (c.module = 'clientes' and (c.action is null or c.action = 'ver'))
          or (c.module = 'autoatendimento' and (c.action is null or c.action in ('ver','pedir')))
          or c.key in ('sla','sla.compliance','sla.compliance.ver')

        when 'operador_financeiro' then
          (c.module = 'financeiro'
            and (c.action is null
                 or c.action in ('ver','movimentar')
                 or (c.screen in ('titulos_pagar','titulos_receber')
                     and c.action in ('criar','editar','anexar','remover_anexo'))))
          or (c.module = 'autoatendimento' and (c.action is null or c.action in ('ver','pedir')))

        when 'aprovador_financeiro' then
          (c.module = 'financeiro'
            and (c.action is null
                 or c.action = 'ver'
                 or (c.screen = 'titulos_pagar' and c.action = 'aprovar')))
          or (c.module = 'autoatendimento' and (c.action is null or c.action in ('ver','pedir')))

        when 'solicitante' then true

        else false
      end
    on conflict do nothing;
  end loop;
end;
$$;

comment on function app.seed_system_access_profiles(uuid) is
  'Cria (idempotente) os perfis de sistema e suas concessões para um tenant.';

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
