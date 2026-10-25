-- =============================================================================
-- 0033 — Autoatendimento: base de conhecimento, catálogo e portal
-- =============================================================================
-- Onda 4 do plano de paridade (docs/12). As três partes servem ao mesmo fim:
-- **o chamado que não precisa ser aberto**.
--
-- POR QUE AS BASES DE CONHECIMENTO MORREM
-- ---------------------------------------
-- Quase todas morrem pelo mesmo motivo, e não é falta de recurso: ninguém
-- escreve. A tela de "novo artigo" fica em branco porque escrever um artigo é um
-- trabalho que não tem dono, não tem hora e não resolve o chamado que está na
-- fila agora.
--
-- Por isso a peça central desta migração não é a tabela `kb_articles`: é o
-- caminho **do chamado resolvido para o artigo**. Quem acabou de resolver um
-- problema tem o texto na cabeça e a solução na tela — é o único instante em que
-- escrever custa pouco. `app.kb_rascunho_do_chamado()` monta o rascunho com o
-- título, o problema e a solução já preenchidos a partir do próprio chamado.
--
-- AS TRÊS REUTILIZAÇÕES QUE EVITAM UM SEGUNDO MODELO DE DADOS
-- ----------------------------------------------------------
-- **1. `ticket_categories` serve aos artigos e ao catálogo.** Uma taxonomia
-- própria para a base de conhecimento pareceria mais limpa e seria pior: os
-- artigos sugeridos para um chamado viram uma junção pela categoria, em vez de
-- um segundo exercício de classificação que ninguém mantém sincronizado.
--
-- **2. O pedido do catálogo vira um TICKET**, com a fila, a prioridade e o SLA
-- que o item declarou. Não existe "pedido" como entidade paralela ao chamado —
-- teria o próprio estado, a própria fila e o próprio SLA, e a operação passaria a
-- olhar duas listas.
--
-- **3. O portal é uma TELA, não um modelo.** O `solicitante` já enxerga apenas os
-- próprios chamados pela policy de `tickets` desde a 0012. O portal não
-- acrescenta regra de acesso nenhuma: ele acrescenta um caminho curto para o que
-- a pessoa já podia fazer.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Busca em português, com acento tratado
-- -----------------------------------------------------------------------------
-- Sem `unaccent`, procurar por "manutencao" não acha "manutenção" — e metade de
-- quem digita numa caixa de busca não põe acento. Com ele, as duas formas caem no
-- mesmo termo.
--
-- A configuração precisa ser PRÓPRIA (e não `portuguese` alterada) por duas
-- razões: alterar a configuração do sistema afetaria qualquer outra busca que
-- apareça depois, e uma coluna gerada exige função imutável — `unaccent(text)`
-- sozinha não é imutável, mas `to_tsvector('<config>', texto)` é, porque a
-- configuração está fixada pelo nome.
create extension if not exists unaccent;

do $$
begin
  if not exists (select 1 from pg_ts_config where cfgname = 'portugues_sem_acento') then
    create text search configuration public.portugues_sem_acento (copy = portuguese);
    alter text search configuration public.portugues_sem_acento
      alter mapping for hword, hword_part, word
      with unaccent, portuguese_stem;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 2. Contador de leitura fora da trilha de auditoria
-- -----------------------------------------------------------------------------
-- `views` sobe a cada abertura de artigo. Auditado, encheria `audit_log` de
-- linhas dizendo "alguém leu" — e a trilha existe para responder "quem MEXEU
-- nisto?". É a mesma classe de `last_seen_at`, acrescentada na 0031: contador
-- mecânico, não fato de negócio. Editar o artigo continua auditado.
create or replace function app.audit_ignored_columns()
returns text[]
language sql
immutable
as $$
  select array[
    'updated_at','created_at','search_vector',
    'last_seen_at','last_snapshot_hash','last_snapshot_at',
    -- 0033: leitura de artigo é contagem, não edição.
    'views'
  ];
$$;

-- -----------------------------------------------------------------------------
-- 3. Artigos
-- -----------------------------------------------------------------------------
-- `body` é TEXTO SIMPLES, e não markdown ou HTML.
--
-- Markdown exigiria um renderizador (dependência) e um sanitizador (segunda
-- dependência, e a que ninguém lembra de atualizar). Um artigo é lido por
-- `solicitante` — inclusive de empresa-cliente — e renderizar markdown sem
-- sanitizar num texto que outra pessoa escreveu é XSS armazenado, servido para o
-- público mais amplo que esta aplicação tem.
--
-- Texto com quebras de linha responde "como trocar minha senha" tão bem quanto
-- markdown, e não tem como virar um incidente.
create table public.kb_articles (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  title         text not null check (length(trim(title)) between 3 and 200),
  /* Uma linha, mostrada na lista e no resultado da busca. Separada do corpo
     porque a primeira linha do corpo quase nunca é um bom resumo — ela costuma
     ser "Este artigo explica como...". */
  resumo        text check (resumo is null or length(resumo) <= 300),
  body          text not null check (length(trim(body)) >= 10),

  /* A MESMA taxonomia dos chamados. Ver a decisão 1 do cabeçalho. */
  category_id   uuid,

  status        text not null default 'rascunho'
                  check (status in ('rascunho', 'publicado', 'arquivado')),
  /* Quem pode ler. `interno` é a equipe; `solicitante` inclui quem abre chamado,
     que é o público do portal. O padrão é o mais restrito: artigo nasce interno
     e alguém decide publicá-lo para fora. */
  visibilidade  text not null default 'interno'
                  check (visibilidade in ('interno', 'solicitante')),

  /* O chamado que deu origem. É o que torna rastreável de onde veio o
     conhecimento — e o que permite perguntar "este problema já virou artigo?". */
  source_ticket_id uuid,

  author_id     uuid,
  published_at  timestamptz,
  views         integer not null default 0 check (views >= 0),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  search_vector tsvector generated always as (
    setweight(to_tsvector('public.portugues_sem_acento', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('public.portugues_sem_acento', coalesce(resumo, '')), 'B') ||
    setweight(to_tsvector('public.portugues_sem_acento', coalesce(body, '')), 'C')
  ) stored,

  constraint uq_kb_id_tenant unique (id, tenant_id),
  constraint fk_kb_categoria foreign key (category_id, tenant_id)
    references public.ticket_categories (id, tenant_id) on delete set null,
  constraint fk_kb_ticket foreign key (source_ticket_id, tenant_id)
    references public.tickets (id, tenant_id) on delete set null,
  constraint fk_kb_autor foreign key (author_id, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,
  -- Publicado sem data de publicação seria um artigo que não dá para ordenar
  -- por "mais recente", que é a ordenação que a lista usa.
  constraint kb_publicado_tem_data
    check (status <> 'publicado' or published_at is not null)
);

create index idx_kb_busca on public.kb_articles using gin (search_vector);
create index idx_kb_publicados on public.kb_articles (tenant_id, published_at desc)
  where status = 'publicado' and deleted_at is null;
create index idx_kb_categoria on public.kb_articles (tenant_id, category_id)
  where deleted_at is null;

comment on table public.kb_articles is
  'Artigos da base de conhecimento. Corpo em texto simples de propósito: markdown exigiria sanitizador, e o público inclui solicitante.';
comment on column public.kb_articles.source_ticket_id is
  'O chamado que originou o artigo. É o caminho que faz a base ser escrita: quem acabou de resolver tem o texto na cabeça.';

-- -----------------------------------------------------------------------------
-- 4. "Isto resolveu o seu problema?"
-- -----------------------------------------------------------------------------
-- Tabela, e não contador na linha do artigo. O contador seria mais simples e
-- deixaria a mesma pessoa votar vinte vezes — e a única pergunta que a base de
-- conhecimento precisa responder sobre si mesma é "quais artigos funcionam",
-- que um número inflado não responde.
create table public.kb_feedback (
  article_id  uuid not null,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null,
  util        boolean not null,
  comentario  text check (comentario is null or length(comentario) <= 1000),
  created_at  timestamptz not null default now(),

  primary key (article_id, user_id),
  constraint fk_kbf_article foreign key (article_id, tenant_id)
    references public.kb_articles (id, tenant_id) on delete cascade,
  constraint fk_kbf_user foreign key (user_id, tenant_id)
    references public.profiles (id, tenant_id) on delete cascade
);

comment on table public.kb_feedback is
  'Um voto por pessoa por artigo. Tabela e não contador: contador deixaria a mesma pessoa votar vinte vezes.';

-- -----------------------------------------------------------------------------
-- 5. Catálogo de serviços
-- -----------------------------------------------------------------------------
-- Reaproveita fila, prioridade e categoria dos chamados: o pedido VIRA um
-- chamado, então ele precisa nascer no lugar certo da operação.
create table public.service_catalog (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  name          text not null check (length(trim(name)) between 3 and 120),
  description   text,
  category_id   uuid,
  queue_id      uuid,
  priority_id   uuid,

  /* Preço de tabela. NULO não é zero: nulo significa "não tem preço publicado"
     (combina-se caso a caso), e zero significa "é de graça". A tela diz os dois
     de formas diferentes, e misturá-los faria um serviço sem preço aparecer como
     cortesia. */
  preco         numeric(14,2) check (preco is null or preco >= 0),
  unidade       text check (unidade is null or unidade in ('unidade', 'hora', 'mes', 'ponto', 'usuario')),

  /* O prazo PROMETIDO a quem pede, em horas úteis. Ele não substitui o SLA — o
     SLA continua sendo calculado pelo contrato. Este é a expectativa publicada,
     e existe porque "quanto tempo demora?" é a primeira pergunta de quem pede. */
  prazo_horas   integer check (prazo_horas is null or prazo_horas between 1 and 2000),

  requer_aprovacao boolean not null default false,

  /*
   * Os campos que o solicitante preenche. Forma:
   *   [{"chave":"ramal","rotulo":"Ramal desejado","tipo":"texto","obrigatorio":true}]
   *
   * `jsonb` e não tabelas: um formulário por serviço, com três campos em média,
   * modelado em tabela daria `service_fields` + `service_field_options` +
   * `ticket_field_values` — três tabelas e seis junções para renderizar um
   * formulário que ninguém consulta de forma atravessada. O preço do jsonb é não
   * poder consultar por campo, e é um preço que este caso não paga.
   */
  campos        jsonb not null default '[]'::jsonb check (jsonb_typeof(campos) = 'array'),

  is_active     boolean not null default true,
  sort_order    integer not null default 100,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  constraint uq_sc_id_tenant unique (id, tenant_id),
  constraint fk_sc_categoria foreign key (category_id, tenant_id)
    references public.ticket_categories (id, tenant_id) on delete set null,
  constraint fk_sc_fila foreign key (queue_id, tenant_id)
    references public.queues (id, tenant_id) on delete set null,
  constraint fk_sc_prioridade foreign key (priority_id, tenant_id)
    references public.ticket_priorities (id, tenant_id) on delete set null
);

create index idx_sc_ativos on public.service_catalog (tenant_id, sort_order, name)
  where is_active and deleted_at is null;

comment on table public.service_catalog is
  'Serviços que o solicitante pede pelo portal. O pedido vira um chamado na fila declarada aqui.';

-- -----------------------------------------------------------------------------
-- 6. Preço por cliente, e o que está incluído no contrato
-- -----------------------------------------------------------------------------
-- É o "incluídos automaticamente em contratos" do escopo. Sem esta tabela, o
-- preço seria o mesmo para todos os clientes — e a primeira negociação faria
-- alguém manter uma planilha paralela, que é onde o preço de verdade passaria a
-- morar.
create table public.service_catalog_clients (
  service_id          uuid not null,
  client_id           uuid not null,
  tenant_id           uuid not null references public.tenants(id) on delete cascade,

  /* Verdadeiro = este cliente não paga por este serviço: já está no contrato.
     É diferente de preço zero, que seria uma cortesia pontual. */
  incluso_no_contrato boolean not null default false,
  preco               numeric(14,2) check (preco is null or preco >= 0),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  primary key (service_id, client_id),
  constraint fk_scc_service foreign key (service_id, tenant_id)
    references public.service_catalog (id, tenant_id) on delete cascade,
  constraint fk_scc_client foreign key (client_id, tenant_id)
    references public.clients (id, tenant_id) on delete cascade,
  -- Incluído no contrato E com preço é contradição: ou está no pacote, ou custa.
  constraint scc_incluso_nao_tem_preco
    check (not incluso_no_contrato or preco is null)
);

comment on table public.service_catalog_clients is
  'Preço por cliente, e o que já está no contrato dele. Sem isto, o preço negociado viveria numa planilha paralela.';

-- -----------------------------------------------------------------------------
-- 7. O chamado lembra de onde veio
-- -----------------------------------------------------------------------------
alter table public.tickets
  add column if not exists service_id uuid,
  /* O que a pessoa preencheu no formulário do serviço. Copiado, não
     referenciado: o formulário do serviço muda, e o que foi pedido naquele dia é
     um fato histórico — mesmo raciocínio de `email_outbox.to_email`. */
  add column if not exists service_fields jsonb,
  /* O preço ACORDADO no momento do pedido. Também histórico: a tabela de preço
     sobe, e o que foi combinado continua tendo sido combinado. */
  add column if not exists service_price numeric(14,2)
    check (service_price is null or service_price >= 0);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'fk_ticket_service'
  ) then
    alter table public.tickets
      add constraint fk_ticket_service foreign key (service_id, tenant_id)
        references public.service_catalog (id, tenant_id) on delete set null;
  end if;
end
$$;

create index if not exists idx_tickets_service on public.tickets (tenant_id, service_id)
  where service_id is not null and deleted_at is null;

comment on column public.tickets.service_price is
  'Preço acordado no momento do pedido. Histórico: a tabela sobe, o que foi combinado continua combinado.';

-- -----------------------------------------------------------------------------
-- 8. O rascunho de artigo a partir de um chamado resolvido
-- -----------------------------------------------------------------------------
-- A peça central desta migração. Ver o cabeçalho: bases de conhecimento morrem
-- porque ninguém escreve, e o único instante em que escrever custa pouco é
-- logo depois de resolver.
--
-- A função NÃO cria o artigo: ela monta o texto. Criar automaticamente encheria
-- a base de rascunhos que ninguém revisou — e um artigo errado na base é pior
-- que artigo nenhum, porque quem o lê para de procurar.
create or replace function app.kb_rascunho_do_chamado(p_ticket_id uuid)
returns table (title text, resumo text, body text, category_id uuid)
language plpgsql
stable
security invoker
as $$
declare
  v_t       public.tickets;
  v_solucao text;
begin
  select * into v_t from public.tickets
   where id = p_ticket_id and deleted_at is null;
  if not found then
    return;  -- zero linhas: o RLS já nega o que não é desta sessão
  end if;

  /*
   * A solução é o último comentário PÚBLICO. O último comentário de todos
   * costuma ser uma nota interna ("fechei, era o cabo"), e o público é o que foi
   * escrito para alguém de fora entender — que é exatamente o registro de que um
   * artigo precisa.
   */
  select c.body into v_solucao
    from public.ticket_comments c
   where c.ticket_id = p_ticket_id
     and c.deleted_at is null
     and c.visibility = 'public'
   order by c.created_at desc
   limit 1;

  return query select
    v_t.title,
    left(coalesce(v_t.description, v_t.title), 300),
    format(
      E'## O problema\n\n%s\n\n## A solução\n\n%s\n\n---\nEscrito a partir do chamado #%s.',
      coalesce(nullif(trim(coalesce(v_t.description, '')), ''), '(descreva o sintoma como quem o relata o descreveria)'),
      coalesce(nullif(trim(coalesce(v_solucao, '')), ''), '(descreva o passo a passo da solução)'),
      v_t.ticket_number),
    v_t.category_id;
end;
$$;

comment on function app.kb_rascunho_do_chamado(uuid) is
  'Monta o texto de um artigo a partir de um chamado resolvido. NÃO cria o artigo: rascunho sem revisão humana enche a base de ruído.';

-- -----------------------------------------------------------------------------
-- 9. Artigos sugeridos para um chamado
-- -----------------------------------------------------------------------------
-- Pela categoria e pela busca no título. É a outra metade do ciclo: o artigo
-- escrito a partir de um chamado volta a aparecer no chamado seguinte parecido.
--
-- Deliberadamente simples. Semelhança semântica de verdade exigiria embeddings e
-- um modelo, que é a Onda 6 — e um artigo relevante achado por categoria vale
-- mais hoje que um artigo perfeito achado daqui a três meses.
create or replace function public.kb_sugestoes(p_ticket_id uuid, p_limite integer default 3)
returns table (id uuid, title text, resumo text, relevancia real)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with chamado as (
    select t.title, t.description, t.category_id, t.tenant_id
      from public.tickets t
     where t.id = p_ticket_id and t.deleted_at is null
  )
  select a.id, a.title, a.resumo,
         ts_rank(a.search_vector, c.consulta)
           -- Mesma categoria vale um empurrão, e não uma exclusão: o artigo certo
           -- às vezes está classificado em outro lugar.
           + case when a.category_id = ch.category_id then 0.5 else 0 end as relevancia
    from chamado ch
    cross join lateral (
      select websearch_to_tsquery('public.portugues_sem_acento',
                                  coalesce(ch.title, '') || ' ' || coalesce(ch.description, '')) as consulta
    ) c
    join public.kb_articles a
      on a.tenant_id = ch.tenant_id
     and a.status = 'publicado'
     and a.deleted_at is null
   where a.search_vector @@ c.consulta
      or a.category_id = ch.category_id
   order by relevancia desc, a.published_at desc
   limit greatest(1, least(p_limite, 10));
$$;

grant execute on function public.kb_sugestoes(uuid, integer) to authenticated;

comment on function public.kb_sugestoes(uuid, integer) is
  'Artigos que podem servir a um chamado. Categoria e busca textual — semelhança semântica é da Onda 6.';

-- -----------------------------------------------------------------------------
-- 10. Contar a leitura
-- -----------------------------------------------------------------------------
-- `security definer` porque quem lê pode ser `solicitante`, e a policy de escrita
-- de `kb_articles` exige papel de gestão. Sem isto, ou a contagem não acontece
-- para o público principal da base, ou a policy de escrita teria de ser afrouxada
-- para todo mundo poder gravar — e aí qualquer sessão editaria qualquer artigo.
create or replace function public.kb_registrar_leitura(p_article_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.kb_articles
     set views = views + 1
   where id = p_article_id
     and tenant_id = app.current_tenant_id()   -- o isolamento continua explícito
     and status = 'publicado'
     and deleted_at is null;
end;
$$;

revoke all on function public.kb_registrar_leitura(uuid) from public;
grant execute on function public.kb_registrar_leitura(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 11. Pedir um serviço do catálogo
-- -----------------------------------------------------------------------------
-- O preço é resolvido AQUI, no banco, e não na tela: cliente com o serviço
-- incluso no contrato paga nada, cliente com preço negociado paga o dele, e o
-- resto paga a tabela. Deixar essa escolha na aplicação significaria repeti-la
-- em cada lugar que mostrar um preço — e a primeira divergência entre o preço
-- mostrado e o preço cobrado é um problema comercial, não um defeito de tela.
create or replace function public.service_preco_para_cliente(
  p_service_id uuid,
  p_client_id  uuid
)
returns table (preco numeric, incluso boolean)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    case when cc.incluso_no_contrato then 0::numeric
         else coalesce(cc.preco, s.preco)
    end,
    coalesce(cc.incluso_no_contrato, false)
  from public.service_catalog s
  left join public.service_catalog_clients cc
    on cc.service_id = s.id and cc.client_id = p_client_id
  where s.id = p_service_id and s.deleted_at is null;
$$;

grant execute on function public.service_preco_para_cliente(uuid, uuid) to authenticated;

comment on function public.service_preco_para_cliente(uuid, uuid) is
  'O preço deste serviço para este cliente. Mora no banco para o preço mostrado e o cobrado não divergirem.';

-- -----------------------------------------------------------------------------
-- 12. RLS
-- -----------------------------------------------------------------------------
select app.harden_table('public.kb_articles');
select app.harden_table('public.kb_feedback');
select app.harden_table('public.service_catalog');
select app.harden_table('public.service_catalog_clients');

select app.attach_audit('public.kb_articles');
select app.attach_audit('public.service_catalog');
select app.attach_audit('public.service_catalog_clients');
-- `kb_feedback` NÃO é auditada: é a opinião de uma pessoa sobre um artigo, não um
-- cadastro. A trilha registraria "fulano achou útil", que a própria tabela já diz.

/*
 * A leitura de artigo tem duas portas, e a diferença entre elas é o ponto da
 * base de conhecimento existir:
 *
 *   · quem trabalha os chamados lê o que está publicado, interno ou não;
 *   · todo mundo — inclusive `solicitante` — lê o que foi publicado PARA
 *     solicitante.
 *
 * Rascunho e arquivado só aparecem para quem escreve.
 */
create policy kb_articles_select on public.kb_articles
  for select to authenticated
  using (
    tenant_id = app.current_tenant_id()
    and deleted_at is null
    and (
      app.has_permission('autoatendimento.base.escrever')
      or (status = 'publicado' and visibilidade = 'solicitante')
      or (status = 'publicado' and app.can_work_tickets())
    )
  );

create policy kb_articles_write on public.kb_articles
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('autoatendimento.base.escrever'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('autoatendimento.base.escrever'));

-- Cada pessoa vota uma vez e enxerga o próprio voto. Quem escreve na base vê
-- todos — é o que responde "quais artigos funcionam".
create policy kb_feedback_own on public.kb_feedback
  for all to authenticated
  using (
    tenant_id = app.current_tenant_id()
    and (user_id = app.current_user_id() or app.has_permission('autoatendimento.base.escrever'))
  )
  with check (tenant_id = app.current_tenant_id() and user_id = app.current_user_id());

-- O catálogo é lido por qualquer sessão do tenant: ele É a vitrine, e esconder a
-- vitrine de quem pode pedir esvazia o recurso.
create policy service_catalog_select on public.service_catalog
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and deleted_at is null);

create policy service_catalog_write on public.service_catalog
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('autoatendimento.catalogo.gerenciar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('autoatendimento.catalogo.gerenciar'));

-- Preço negociado é informação comercial: quem pede vê o PRÓPRIO preço pela
-- função `service_preco_para_cliente`, e não a tabela de preços dos outros.
create policy service_catalog_clients_rw on public.service_catalog_clients
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('autoatendimento.catalogo.gerenciar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('autoatendimento.catalogo.gerenciar'));

grant select, insert, update, delete on public.kb_articles to authenticated;
grant select, insert, update, delete on public.kb_feedback to authenticated;
grant select, insert, update, delete on public.service_catalog to authenticated;
grant select, insert, update, delete on public.service_catalog_clients to authenticated;

-- -----------------------------------------------------------------------------
-- 13. As duas visões
-- -----------------------------------------------------------------------------
-- Artigos com a contagem de votos. A pergunta que ela responde é "quais artigos
-- funcionam" — e a razão útil/visto importa mais que o número absoluto: 18 votos
-- em 20 leituras e 18 em 2.000 são histórias diferentes.
create or replace view public.vw_kb_articles
with (security_invoker = true) as
select
  a.id,
  a.tenant_id,
  a.title,
  a.resumo,
  a.category_id,
  c.name            as category_name,
  a.status,
  a.visibilidade,
  a.source_ticket_id,
  a.published_at,
  a.updated_at,
  a.views,
  count(*) filter (where f.util)              as uteis,
  count(*) filter (where f.util is false)     as inuteis,
  p.full_name       as author_name
from public.kb_articles a
left join public.kb_feedback f on f.article_id = a.id
left join public.ticket_categories c on c.id = a.category_id
left join public.profiles p on p.id = a.author_id
where a.deleted_at is null
group by a.id, c.name, p.full_name;

grant select on public.vw_kb_articles to authenticated;

comment on view public.vw_kb_articles is
  'Artigos com votos. A razão útil/visto diz mais que o número absoluto.';

-- O catálogo como a vitrine o mostra, com o nome da fila e da categoria.
create or replace view public.vw_service_catalog
with (security_invoker = true) as
select
  s.id,
  s.tenant_id,
  s.name,
  s.description,
  s.category_id,
  c.name          as category_name,
  s.queue_id,
  q.name          as queue_name,
  s.priority_id,
  s.preco,
  s.unidade,
  s.prazo_horas,
  s.requer_aprovacao,
  s.campos,
  s.is_active,
  s.sort_order,
  (select count(*) from public.tickets t
    where t.service_id = s.id and t.deleted_at is null) as pedidos
from public.service_catalog s
left join public.ticket_categories c on c.id = s.category_id
left join public.queues q on q.id = s.queue_id
where s.deleted_at is null;

grant select on public.vw_service_catalog to authenticated;

-- -----------------------------------------------------------------------------
-- 14. Catálogo de permissões
-- -----------------------------------------------------------------------------
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('autoatendimento', 'autoatendimento', null, null,
   'Autoatendimento', 'visualizador', 430),

  ('autoatendimento.base', 'autoatendimento', 'base', null,
   'Base de conhecimento', 'visualizador', 431),
  ('autoatendimento.base.ver', 'autoatendimento', 'base', 'ver',
   'Consultar artigos', 'visualizador', 432),
  ('autoatendimento.base.escrever', 'autoatendimento', 'base', 'escrever',
   'Escrever e publicar artigos', 'atendente', 433),

  ('autoatendimento.catalogo', 'autoatendimento', 'catalogo', null,
   'Catálogo de serviços', 'visualizador', 434),
  ('autoatendimento.catalogo.ver', 'autoatendimento', 'catalogo', 'ver',
   'Consultar o catálogo', 'visualizador', 435),
  ('autoatendimento.catalogo.pedir', 'autoatendimento', 'catalogo', 'pedir',
   'Pedir um serviço', 'solicitante', 436),
  ('autoatendimento.catalogo.gerenciar', 'autoatendimento', 'catalogo', 'gerenciar',
   'Cadastrar serviços e preços', 'gestor', 437)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

/*
 * O módulo entra nos perfis de sistema.
 *
 * `operador_ti` recebe o módulo inteiro porque escrever na base é parte de
 * atender — e, pelo raciocínio do cabeçalho, quem resolve é quem tem o texto na
 * cabeça. Os perfis financeiros recebem só a consulta: eles também abrem chamado
 * e também se beneficiam de achar a resposta antes.
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

        -- `autoatendimento` entra aqui: base de conhecimento e catálogo são
        -- operação de TI tanto quanto a fila de chamados.
        when 'gestor_ti' then c.module in
          ('helpdesk','inventario','telefonia','conectividade','mapas','sla',
           'clientes','fornecedores','tv','autoatendimento')

        -- O operador ganha o módulo INTEIRO, escrita inclusive: o artigo nasce do
        -- chamado resolvido, e quem acabou de resolver é quem tem o texto na
        -- cabeça. Uma base que só um redator pode escrever é uma base que não é
        -- escrita.
        when 'operador_ti' then
          c.module in ('helpdesk','autoatendimento')
          or (c.module in ('inventario','telefonia','conectividade','mapas')
              and (c.action is null or c.action = 'ver'))

        when 'gestor_financeiro' then
          c.module in ('financeiro','fornecedores')
          or (c.module = 'clientes' and (c.action is null or c.action = 'ver'))
          or (c.module = 'autoatendimento' and (c.action is null or c.action in ('ver','pedir')))
          or c.key in ('sla','sla.compliance','sla.compliance.ver')

        -- Lançar despesa e anexar comprovante É o trabalho do operador. Aprovar,
        -- pagar e configurar alçada não são — e continuam de fora.
        when 'operador_financeiro' then
          (c.module = 'financeiro'
            and (c.action is null
                 or c.action in ('ver','movimentar')
                 or (c.screen in ('titulos_pagar','titulos_receber')
                     and c.action in ('criar','editar','anexar','remover_anexo'))))
          -- Quem é do financeiro também abre chamado, e também se beneficia de
          -- achar a resposta antes de abrir.
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
