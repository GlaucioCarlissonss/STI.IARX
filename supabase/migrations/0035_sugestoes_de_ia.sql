-- =============================================================================
-- 0035 — Sugestões de IA: resposta, triagem e artigo
-- =============================================================================
-- Onda 6 do plano de paridade (docs/12).
--
-- A PALAVRA QUE DEFINE A ONDA INTEIRA É "SUGERIDA"
-- -----------------------------------------------
-- O plano pedia, nas três linhas: resposta sugerida, artigo com revisão humana,
-- triagem **sugerida e não aplicada**. Não é cautela decorativa — é o que separa
-- um recurso que a equipe liga de um que ela desliga na segunda semana.
--
-- Triagem aplicada sozinha muda a prioridade de um chamado, e prioridade muda o
-- SLA. Quando o prazo estourar, ninguém vai saber por que aquele chamado era
-- "alta": não houve ato humano, não há autor no histórico, e o chamado parece ter
-- nascido assim. Resposta enviada sozinha é pior ainda: ela vai para o cliente.
--
-- Por isso toda sugestão nasce como LINHA COM ESTADO `pendente`. Aceitar é um ato
-- humano, com quem e quando registrados. O chamado só muda pela mão de alguém — o
-- mesmo caminho de sempre, com as mesmas permissões e o mesmo histórico.
--
-- A IA NÃO ESCREVE NO CHAMADO
-- ---------------------------
-- Não há autor "IA" em `ticket_comments`, e isso é deliberado. A resposta
-- sugerida chega como TEXTO NA CAIXA de comentário, que a pessoa lê, corrige e
-- envia — como qualquer rascunho. Se ela envia, o comentário é dela, porque a
-- responsabilidade pelo que o cliente leu é de quem apertou enviar.
--
-- SEM CHAVE, TUDO CONTINUA FUNCIONANDO
-- ------------------------------------
-- `kb_sugestoes()` (0033) já devolve artigos por categoria e busca textual, sem
-- IA nenhuma. Sem chave configurada, o painel mostra exatamente isso, dizendo que
-- é isso. O recurso degrada para o caminho determinístico — não para um erro, e
-- muito menos para uma tela vazia que parece defeito.
--
-- É a mesma regra da caixa de saída de e-mail (0029) e dos canais (0034):
-- faltando configuração, o sistema faz o que dá e DIZ o que não fez.
--
-- O QUE SAI DAQUI, E QUEM DECIDE
-- ------------------------------
-- Mandar o texto de um chamado para um provedor externo é uma decisão sobre dado
-- de cliente, e não um detalhe de implementação. Então:
--
--   - nota interna NÃO vai, por padrão (`enviar_notas_internas = false`);
--   - a tela de configuração diz, em português, exatamente o que é enviado;
--   - nada é enviado sem alguém pedir: não há trabalho agendado que resuma a fila
--     inteira de madrugada, o que gastaria dinheiro em chamado que ninguém abriu.
--
-- ORÇAMENTO EM CENTAVOS, CONFERIDO ANTES DA CHAMADA
-- -------------------------------------------------
-- Um recurso que gasta dinheiro por clique precisa de teto, e o teto precisa ser
-- conferido ANTES de gastar — depois já gastou. `ai_settings` carrega o limite
-- mensal e o acumulado do mês, e a função de registro vira o mês sozinha.
--
-- Estourado o teto, o painel volta ao caminho determinístico e diz que o
-- orçamento do mês acabou. Não falha, não some: diz.
--
-- O TEXTO DO CHAMADO É DADO, NÃO INSTRUÇÃO
-- ----------------------------------------
-- Quem escreve o chamado é o cliente, e um chamado pode conter "ignore as
-- instruções anteriores". Três coisas tornam isso inofensivo aqui, e a terceira é
-- a que realmente importa:
--
--   1. o prompt diz que o conteúdo do chamado é dado a ser lido, não ordem;
--   2. a saída é presa a um esquema fixo (structured outputs), então o modelo não
--      tem como responder outra coisa senão preencher aqueles campos;
--   3. NADA é aplicado sozinho. O pior caso de uma injeção bem-sucedida é uma
--      sugestão ruim que alguém recusa.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Configuração por tenant
-- -----------------------------------------------------------------------------
-- Uma linha por tenant, criada sob demanda. Tenant sem linha = IA desligada, que
-- é o estado inicial de todo mundo.
create table public.ai_settings (
  tenant_id     uuid primary key references public.tenants(id) on delete cascade,

  enabled       boolean not null default false,

  /* Hoje só há um provedor. A coluna existe porque trocar de provedor é uma
     conversa comercial que acontece, e um CHECK é mais fácil de ampliar do que
     uma suposição espalhada pelo código. */
  provider      text not null default 'anthropic'
                  check (provider in ('anthropic')),

  /* O identificador do modelo, como o provedor o escreve. Texto livre de
     propósito: modelo novo sai sem avisar, e uma migração para trocar uma string
     seria o tipo de cerimônia que faz a equipe ficar na versão velha. */
  model         text not null default 'claude-opus-5-5'
                  check (length(trim(model)) between 3 and 80),

  /* Quanto esforço o modelo gasta pensando. Mais esforço custa mais e demora
     mais; para triagem, o barato basta. */
  effort        text not null default 'medium'
                  check (effort in ('low', 'medium', 'high')),

  /*
   * O NOME da variável de ambiente com a chave, nunca a chave (ADR-009).
   *
   * Mesmo contrato de `channels.secret_ref` (0034): uma chave de API numa linha
   * de tabela é uma chave que aparece em backup, em export de suporte e na tela
   * de quem tem select.
   */
  secret_ref    text check (secret_ref is null or secret_ref ~ '^[A-Z][A-Z0-9_]{2,60}$'),

  /* Cada recurso liga separado. Quem quer só a triagem não precisa aceitar a
     resposta sugerida junto — e são decisões diferentes, porque a resposta é a
     única que vai parar na frente do cliente. */
  sugerir_resposta boolean not null default true,
  sugerir_triagem  boolean not null default true,
  redigir_artigo   boolean not null default true,

  /*
   * Nota interna no prompt: DESLIGADO por padrão.
   *
   * A nota interna é onde se escreve "este cliente reclama de tudo" e "a senha do
   * servidor é...". Ligar isso pode melhorar a sugestão e é uma decisão sobre
   * dado sensível — então é escolha explícita, nunca herdada.
   */
  enviar_notas_internas boolean not null default false,

  /* Teto mensal em CENTAVOS. Inteiro, porque dinheiro em float é defeito. */
  limite_mensal_centavos integer not null default 5000
                  check (limite_mensal_centavos between 0 and 100000000),
  gasto_do_mes_centavos  integer not null default 0 check (gasto_do_mes_centavos >= 0),
  /* Primeiro dia do mês que `gasto_do_mes_centavos` está contando. */
  mes_de_referencia date not null default date_trunc('month', now())::date,

  tokens_entrada bigint not null default 0 check (tokens_entrada >= 0),
  tokens_saida   bigint not null default 0 check (tokens_saida >= 0),

  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.profiles(id) on delete set null,

  /* Ligado sem chave não funcionaria, e o sintoma seria um painel que gira para
     sempre. O banco recusa a combinação. */
  constraint ia_ligada_tem_credencial
    check (not enabled or secret_ref is not null)
);

comment on table public.ai_settings is
  'Configuração de IA por tenant. Guarda a REFERÊNCIA da credencial e o teto de gasto; nunca a chave.';

-- -----------------------------------------------------------------------------
-- 2. As sugestões
-- -----------------------------------------------------------------------------
create table public.ai_suggestions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  /* Toda sugestão é SOBRE um chamado. Não há sugestão solta: a pergunta "sugerir
     o quê?" sempre tem um chamado por trás, inclusive a do artigo. */
  ticket_id     uuid not null,

  kind          text not null check (kind in ('resposta', 'triagem', 'artigo')),

  /*
   * O conteúdo, no formato de cada tipo. `jsonb` e não colunas porque os três
   * tipos têm campos diferentes e um esquema novo não deve exigir migração:
   *
   *   resposta → { texto, confianca, artigos_citados[], precisa_de_pessoa }
   *   triagem  → { category_id, priority_id, justificativa, confianca }
   *   artigo   → { title, resumo, body }
   *
   * O validador do formato mora no TypeScript (zod), que é também o que o
   * provedor recebe como esquema de saída — uma definição só, nos dois lados.
   */
  payload       jsonb not null check (jsonb_typeof(payload) = 'object'),

  status        text not null default 'pendente'
                  check (status in ('pendente', 'aceita', 'recusada')),

  /* Quem pediu e quem decidiu. São pessoas diferentes com frequência: um pede a
     sugestão, outro atende o chamado. */
  requested_by  uuid,
  acted_by      uuid,
  acted_at      timestamptz,

  /* O que esta sugestão custou. Guardado por linha e não só no agregado porque a
     pergunta "qual recurso está consumindo o orçamento" só tem resposta assim. */
  model         text,
  tokens_entrada integer not null default 0 check (tokens_entrada >= 0),
  tokens_saida   integer not null default 0 check (tokens_saida >= 0),
  custo_centavos integer not null default 0 check (custo_centavos >= 0),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint uq_suggestion_id_tenant unique (id, tenant_id),
  constraint fk_sug_ticket foreign key (ticket_id, tenant_id)
    references public.tickets (id, tenant_id) on delete cascade,
  constraint fk_sug_requested_by foreign key (requested_by, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,
  constraint fk_sug_acted_by foreign key (acted_by, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,

  /* Decidida tem decisor e data; pendente não tem nenhum dos dois. Sem isto,
     "aceita por ninguém às nulo" seria um estado gravável — e é exatamente o
     estado que a onda inteira existe para impedir. */
  constraint sug_decidida_tem_autor
    check (
      (status = 'pendente' and acted_by is null and acted_at is null)
      or (status <> 'pendente' and acted_by is not null and acted_at is not null)
    )
);

-- A consulta do painel: as sugestões de um chamado, mais recente primeiro.
create index idx_sug_por_chamado
  on public.ai_suggestions (ticket_id, created_at desc);

-- O relatório de uso: quanto cada tipo gastou no período.
create index idx_sug_por_tenant
  on public.ai_suggestions (tenant_id, created_at desc);

/*
 * UMA sugestão pendente por chamado e por tipo.
 *
 * Sem o índice, clicar duas vezes em "sugerir resposta" cria duas sugestões
 * pendentes — e o painel mostraria as duas, cada uma com um botão de aceitar.
 * Pior: as duas teriam sido pagas.
 */
create unique index uq_sug_pendente
  on public.ai_suggestions (ticket_id, kind)
  where status = 'pendente';

comment on table public.ai_suggestions is
  'Sugestões de IA. Toda linha nasce pendente: aceitar é ato humano, com autor e data.';

-- -----------------------------------------------------------------------------
-- 3. Colunas que a trilha de auditoria ignora
-- -----------------------------------------------------------------------------
-- Contadores de uso mudam a cada chamada e não são fato de negócio — mesma classe
-- de `views` (0033) e `last_seen_at` (0031). Sem isto, cada sugestão gravaria uma
-- linha de auditoria dizendo que um contador subiu.
create or replace function app.audit_ignored_columns()
returns text[]
language sql
immutable
as $$
  select array[
    'updated_at','created_at','search_vector',
    'last_seen_at','last_snapshot_hash','last_snapshot_at',
    'views',
    -- 0035: contadores de consumo de IA.
    'gasto_do_mes_centavos','mes_de_referencia','tokens_entrada','tokens_saida'
  ];
$$;

-- -----------------------------------------------------------------------------
-- 4. Registro de consumo, com virada de mês
-- -----------------------------------------------------------------------------
/*
 * Soma o que uma chamada custou, virando o mês quando preciso.
 *
 * `security definer` porque o acumulado precisa subir mesmo quando quem pediu a
 * sugestão é um atendente que não tem (e não deve ter) permissão de escrever na
 * configuração. O isolamento é explícito: a função só mexe na linha do tenant que
 * recebeu por parâmetro, e quem a chama é o Server Action, que já resolveu o
 * tenant pela sessão.
 *
 * Não é um quarto uso de `service_role` (ADR-011): é `security definer`
 * concedida a `authenticated`, do mesmo jeito que `channel_ingest` (0034) é
 * concedida a `anon`.
 */
create or replace function public.ai_registrar_uso(
  p_tenant_id uuid,
  p_tokens_entrada integer,
  p_tokens_saida integer,
  p_centavos integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mes date := date_trunc('month', now())::date;
begin
  update public.ai_settings s
     set gasto_do_mes_centavos =
           case when s.mes_de_referencia < v_mes then 0 else s.gasto_do_mes_centavos end
           + greatest(p_centavos, 0),
         mes_de_referencia = v_mes,
         tokens_entrada = s.tokens_entrada + greatest(p_tokens_entrada, 0),
         tokens_saida   = s.tokens_saida   + greatest(p_tokens_saida, 0)
   where s.tenant_id = p_tenant_id;
end;
$$;

revoke all on function public.ai_registrar_uso(uuid, integer, integer, integer) from public;
grant execute on function public.ai_registrar_uso(uuid, integer, integer, integer) to authenticated;

comment on function public.ai_registrar_uso(uuid, integer, integer, integer) is
  'Acumula o consumo de IA do mês, virando o mês sozinha. Chamada depois de cada resposta do provedor.';

-- -----------------------------------------------------------------------------
-- 5. A pergunta que o Server Action faz ANTES de gastar
-- -----------------------------------------------------------------------------
/*
 * Devolve a configuração utilizável do tenant da sessão, já respondendo "dá para
 * chamar agora?".
 *
 * `security invoker`: ela lê `ai_settings` com as permissões de quem chamou. É
 * de propósito — mas a policy de leitura é generosa justamente para que o
 * atendente possa receber daqui o `modelo` e o `secret_ref` que o Server Action
 * vai usar. O que ela NÃO devolve é o resto da configuração administrativa.
 *
 * O mês é virado na leitura também: sem isso, no dia 1º o painel diria "orçamento
 * esgotado" até alguém pedir a primeira sugestão e o `update` rodar.
 */
create or replace function public.ai_config_utilizavel()
returns table (
  enabled boolean,
  model text,
  effort text,
  secret_ref text,
  sugerir_resposta boolean,
  sugerir_triagem boolean,
  redigir_artigo boolean,
  enviar_notas_internas boolean,
  tem_orcamento boolean,
  limite_mensal_centavos integer,
  gasto_do_mes_centavos integer
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    s.enabled,
    s.model,
    s.effort,
    s.secret_ref,
    s.sugerir_resposta,
    s.sugerir_triagem,
    s.redigir_artigo,
    s.enviar_notas_internas,
    /* Mês velho conta como zero gasto: a virada acontece na leitura e na
       escrita, porque as duas podem ser a primeira do mês. */
    case
      when s.mes_de_referencia < date_trunc('month', now())::date then true
      else s.gasto_do_mes_centavos < s.limite_mensal_centavos
    end,
    s.limite_mensal_centavos,
    case
      when s.mes_de_referencia < date_trunc('month', now())::date then 0
      else s.gasto_do_mes_centavos
    end
  from public.ai_settings s
  where s.tenant_id = app.current_tenant_id();
$$;

grant execute on function public.ai_config_utilizavel() to authenticated;

comment on function public.ai_config_utilizavel() is
  'A configuração de IA do tenant da sessão, com "dá para chamar agora?" já respondido. Zero linhas = IA desligada.';

-- -----------------------------------------------------------------------------
-- 6. O que vai no prompt
-- -----------------------------------------------------------------------------
/*
 * Monta o contexto do chamado para o prompt — no banco, e não na aplicação.
 *
 * Porque é aqui que mora a regra de o que pode sair. A aplicação monta o texto,
 * mas O QUE ELA RECEBE para montar é decidido pelo RLS (ela só enxerga chamado
 * que a sessão enxerga) e por esta função (nota interna só vem se o tenant
 * tiver ligado).
 *
 * Escrever a mesma filtragem num `select` da aplicação funcionaria igual hoje e
 * divergiria na primeira vez que alguém acrescentasse um campo.
 */
create or replace function public.ai_contexto_do_chamado(p_ticket_id uuid)
returns table (
  title text,
  description text,
  category_name text,
  priority_name text,
  status text,
  cliente text,
  comentarios jsonb
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with cfg as (
    select coalesce(
      (select s.enviar_notas_internas from public.ai_settings s
        where s.tenant_id = app.current_tenant_id()),
      false
    ) as notas
  )
  select
    t.title,
    t.description,
    c.name,
    /* `label`, e não `name`: é como a coluna de `ticket_priorities` se chama
       desde a 0002. */
    p.label,
    t.status,
    cl.trade_name,
    coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'autor', case when cm.visibility = 'public' then 'equipe ou cliente'
                                 else 'nota interna' end,
                   'texto', cm.body
                 )
                 order by cm.created_at
               )
          from public.ticket_comments cm, cfg
         where cm.ticket_id = t.id
           and cm.deleted_at is null
           /* A trava. Nota interna só entra se o tenant tiver pedido. */
           and (cm.visibility = 'public' or cfg.notas)
      ),
      '[]'::jsonb
    )
  from public.tickets t
  left join public.ticket_categories c on c.id = t.category_id
  left join public.ticket_priorities p on p.id = t.priority_id
  left join public.clients cl on cl.id = t.client_id
  where t.id = p_ticket_id and t.deleted_at is null;
$$;

grant execute on function public.ai_contexto_do_chamado(uuid) to authenticated;

comment on function public.ai_contexto_do_chamado(uuid) is
  'O contexto do chamado para o prompt. Nota interna só sai se o tenant tiver ligado — a decisão mora aqui, não na aplicação.';

-- -----------------------------------------------------------------------------
-- 7. RLS
-- -----------------------------------------------------------------------------
select app.harden_table('public.ai_settings');
select app.harden_table('public.ai_suggestions');

select app.attach_audit('public.ai_settings');
select app.attach_audit('public.ai_suggestions');

/*
 * A configuração é LIDA por quem atende e ESCRITA por quem administra.
 *
 * Ler é necessário: o atendente precisa saber se o recurso está ligado, qual é o
 * modelo e qual variável tem a chave — é o Server Action dele que faz a chamada.
 * O que ele não pode é mudar nada disso, e principalmente não pode mexer no teto
 * de gasto.
 *
 * Note que `secret_ref` é o NOME da variável, não o valor: lê-lo não dá acesso a
 * nada. Quem roda o processo é que tem o valor, e o Server Action roda no
 * servidor.
 */
create policy ai_settings_select on public.ai_settings
  for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and (app.has_permission('ia.sugestoes.ver')
              or app.has_permission('ia.config.ver')));

create policy ai_settings_rw on public.ai_settings
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('ia.config.gerenciar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('ia.config.gerenciar'));

create policy ai_suggestions_select on public.ai_suggestions
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('ia.sugestoes.ver'));

/* Pedir e decidir são a mesma permissão: quem pode usar a sugestão é quem pode
   criá-la. Separar daria o direito de encher a fila de sugestões a quem não pode
   resolvê-las. */
create policy ai_suggestions_write on public.ai_suggestions
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('ia.sugestoes.usar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('ia.sugestoes.usar'));

/*
 * O GRANT é separado da policy, e os dois precisam existir.
 *
 * Sem o GRANT, a negação chega como "permission denied for table" — um ERRO, e
 * não as zero linhas que todo o resto do sistema devolve. A aplicação espera zero
 * linhas (é o contrato de `.select('id')` + `length`), e uma exceção aqui viraria
 * uma mensagem técnica na tela em vez da frase em português.
 */
grant select, insert, update, delete on public.ai_settings to authenticated;
grant select, insert, update, delete on public.ai_suggestions to authenticated;

-- -----------------------------------------------------------------------------
-- 8. A visão do painel
-- -----------------------------------------------------------------------------
create or replace view public.vw_ai_suggestions
with (security_invoker = true) as
select
  s.id,
  s.tenant_id,
  s.ticket_id,
  s.kind,
  s.payload,
  s.status,
  s.model,
  s.tokens_entrada,
  s.tokens_saida,
  s.custo_centavos,
  s.created_at,
  s.acted_at,
  pedinte.full_name as requested_by_name,
  decisor.full_name as acted_by_name,
  t.ticket_number,
  t.title as ticket_title
from public.ai_suggestions s
join public.tickets t on t.id = s.ticket_id and t.deleted_at is null
left join public.profiles pedinte on pedinte.id = s.requested_by
left join public.profiles decisor on decisor.id = s.acted_by;

grant select on public.vw_ai_suggestions to authenticated;

comment on view public.vw_ai_suggestions is
  'As sugestões com nome de quem pediu e de quem decidiu. É o registro de que nada foi aplicado sozinho.';

-- -----------------------------------------------------------------------------
-- 9. Catálogo de permissões
-- -----------------------------------------------------------------------------
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('ia', 'ia', null, null, 'Sugestões de IA', 'atendente', 450),

  ('ia.sugestoes', 'ia', 'sugestoes', null, 'Sugestões nos chamados', 'atendente', 451),
  ('ia.sugestoes.ver', 'ia', 'sugestoes', 'ver',
   'Ver as sugestões', 'atendente', 452),
  ('ia.sugestoes.usar', 'ia', 'sugestoes', 'usar',
   'Pedir sugestão e aceitá-la', 'atendente', 453),

  ('ia.config', 'ia', 'config', null, 'Configuração da IA', 'admin', 454),
  ('ia.config.ver', 'ia', 'config', 'ver',
   'Consultar a configuração e o consumo', 'admin', 455),
  ('ia.config.gerenciar', 'ia', 'config', 'gerenciar',
   'Ligar a IA e definir o teto de gasto', 'admin', 456)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

/*
 * `ia.sugestoes.*` tem teto `atendente` porque pedir uma sugestão é atender: a
 * pessoa está com o chamado aberto na frente dela.
 *
 * `ia.config.*` tem teto `admin` por dois motivos independentes, e cada um
 * bastaria: a configuração guarda a referência da credencial, e ela define
 * QUANTO DINHEIRO o recurso pode gastar por mês.
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
        -- `ia` também: sugestão de resposta e de triagem é ferramenta de quem
        -- atende, e o teto `admin` da configuração já a mantém fora do alcance
        -- do gestor.
        when 'gestor_ti' then c.module in
          ('helpdesk','inventario','telefonia','conectividade','mapas','sla',
           'clientes','fornecedores','tv','autoatendimento','canais','ia')

        -- O operador lê e RESPONDE conversa — é o trabalho dele. Mas não liga nem
        -- desliga canal: isso guarda credencial.
        when 'operador_ti' then
          c.module in ('helpdesk','autoatendimento','ia')
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
  v_tenant record;
begin
  for v_tenant in select id from public.tenants loop
    perform app.seed_system_access_profiles(v_tenant.id);
  end loop;
end
$$;

commit;
