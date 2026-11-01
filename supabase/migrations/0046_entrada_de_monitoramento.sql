-- =============================================================================
-- 0046 — A entrada de monitoramento: o Zabbix registra a queda sozinho
-- =============================================================================
-- É o item M8 / LG-07 da docs/18 §5, e o motivo pelo qual ele ficou aberto
-- estava escrito assim: *exige um Zabbix real para testar contra*.
--
-- O motivo era verdadeiro e a conclusão era errada. O que exige um Zabbix real
-- é provar que o SCRIPT DE MÍDIA dele foi configurado certo — isso é trabalho de
-- quem instala, e não dá para fazer daqui. O que não exige Zabbix nenhum é o
-- lado de cá: receber um POST, achar o link, abrir o evento, fechar o evento,
-- não duplicar quando a mesma notificação chegar duas vezes. Isso é contrato, e
-- contrato se testa com o corpo que o contrato promete.
--
-- Enquanto isso não existiu, a queda de link era registrada à mão — alguém
-- precisava ver o alerta no Zabbix e digitar aqui. Duas consequências: o
-- horário era o da digitação, não o da queda, e a disponibilidade do mês saía
-- otimista exatamente nos meses ruins, que são os que importam.
--
-- O QUE JÁ EXISTIA, E É POR ISSO QUE ESTA MIGRAÇÃO É PEQUENA
-- ----------------------------------------------------------
-- A 0021 já criou `link_availability_events` com `source in ('zabbix','manual',
-- 'api')` e, mais importante, com os dois índices que fazem o trabalho difícil:
--
--   · `uq_link_event_external` — único por (link, external_event_id): a mesma
--     notificação entregue duas vezes não vira dois eventos;
--   · `uq_link_event_open` — um único evento ABERTO por link: um segundo "caiu"
--     antes do "voltou" não abre um segundo buraco no histórico.
--
-- E `internet_links` já tem `monitoring_host` e `monitoring_external_id`, que
-- são por onde o alerta encontra o link.
--
-- POR QUE UM TOKEN NA URL, E NÃO UM CABEÇALHO
-- --------------------------------------------
-- Mesmo motivo de `/api/canais/<token>` (0034): o webhook do Zabbix é um script
-- de mídia que o operador cola, e exigir cabeçalho torna o recurso difícil
-- justamente para quem precisa usá-lo. O token identifica o tenant — e ele não
-- vem do corpo de propósito, porque o corpo é escrito por quem chama.
--
-- Guardado como SHA-256, como `channels`, `dashboard_tokens` e
-- `agent_enrollments`: um dump do banco não entrega credencial nenhuma.
--
-- POR QUE NÃO USA `service_role`
-- -------------------------------
-- Porque não precisa, e o ADR-011 tem exatamente três usos sancionados. A rota
-- chama uma função `security definer` que deriva o tenant DO TOKEN. Não há
-- parâmetro de tenant para alguém falsificar, e um defeito nesta rota não vira
-- acesso à base inteira. É o mesmo desenho do agente de inventário (0031).
-- =============================================================================
begin;

-- -----------------------------------------------------------------------------
-- 1. Onde o token mora
-- -----------------------------------------------------------------------------
create table public.monitoring_webhooks (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,

  /* Para distinguir "Zabbix da matriz" de "Zabbix do datacenter" quando houver
     dois. Sem nome, rotacionar o token certo vira adivinhação. */
  name       text not null check (length(trim(name)) between 2 and 120),

  /* SHA-256 do token que vai na URL. O valor em claro existe uma vez, na tela
     de quem o criou. */
  inbound_token_hash text not null unique,

  active     boolean not null default true,

  /* Quando esta entrada foi usada pela última vez. É a resposta para a pergunta
     que todo mundo faz primeiro — "o Zabbix está mesmo mandando?" — sem a qual
     a pessoa fica olhando para uma tela de links parada sem saber se é porque
     nada caiu ou porque nada chega. */
  last_seen_at timestamptz,

  created_at timestamptz not null default now(),
  created_by uuid,
  deleted_at timestamptz,

  /* ADR-001: a chave composta permite que qualquer filho referencie
     (id, tenant_id) e o banco garanta que o filho não atravessa tenant. */
  unique (id, tenant_id)
);

comment on table public.monitoring_webhooks is
  'Entradas de monitoramento (Zabbix e similares). Token por hash; o tenant sai do token.';

create index idx_monitoring_webhooks_tenant
  on public.monitoring_webhooks (tenant_id)
  where deleted_at is null;

alter table public.monitoring_webhooks enable row level security;
alter table public.monitoring_webhooks force row level security;

/* Quem administra conectividade administra a entrada. A leitura NÃO é aberta a
   quem só consulta links: a linha carrega o hash do token, e hash de token em
   tela de consulta é superfície que não precisa existir. */
create policy monitoring_webhooks_rw on public.monitoring_webhooks
  for all to authenticated
  using (tenant_id = app.current_tenant_id()
         and app.has_permission('conectividade.links.monitoramento'))
  with check (tenant_id = app.current_tenant_id()
              and app.has_permission('conectividade.links.monitoramento'));

grant select, insert, update, delete on public.monitoring_webhooks to authenticated;

select app.attach_audit('public.monitoring_webhooks');

-- -----------------------------------------------------------------------------
-- 2. Quem é o dono deste token
-- -----------------------------------------------------------------------------
create or replace function public.monitoring_por_token(p_token text)
returns table (webhook_id uuid, tenant_id uuid, name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select w.id, w.tenant_id, w.name
    from public.monitoring_webhooks w
   where w.inbound_token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and w.active
     and w.deleted_at is null;
$$;

revoke all on function public.monitoring_por_token(text) from public;
/* `service_role` junto, e não só `anon, authenticated` como nas migrações
   anteriores: no Supabase ele já tem execute em tudo por padrão, mas num banco
   local o privilégio vem de um `grant ... on all functions` que roda na CRIAÇÃO
   do banco — então toda função criada por uma migração posterior nasce fora
   dele. O sintoma é 42501 em código que roda com o papel de serviço, numa
   função recém-criada, e a investigação começa no lugar errado. */
grant execute on function public.monitoring_por_token(text) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. A entrada do evento
-- -----------------------------------------------------------------------------
/**
 * Recebe uma notificação de monitoramento e registra queda ou retorno.
 *
 * Devolve um `jsonb` em vez de levantar exceção para o caso normal, porque
 * quase tudo que pode dar errado aqui é operação, não programação: host que
 * ninguém cadastrou, notificação repetida, "voltou" de uma queda que este
 * sistema nunca viu. Cada um desses tem um nome no retorno, e é esse nome que a
 * rota devolve ao Zabbix — que o registra no próprio log de mídia. Um 500 mudo
 * faria o operador procurar no lugar errado.
 *
 * `p_state` aceita o vocabulário do Zabbix e o nosso: PROBLEM/OK vêm do
 * `{TRIGGER.STATUS}`, down/up são o que a tabela guarda.
 */
create or replace function public.link_event_ingest(
  p_token       text,
  p_host        text,
  p_external_id text,
  p_state       text,
  p_at          timestamptz default null,
  p_note        text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_webhook  record;
  v_link_id  uuid;
  v_estado   text;
  v_quando   timestamptz := coalesce(p_at, now());
  v_afetadas int;
begin
  select * into v_webhook from public.monitoring_por_token(p_token);
  if v_webhook.tenant_id is null then
    return jsonb_build_object('ok', false, 'motivo', 'token_desconhecido');
  end if;

  /* O carimbo de uso vem ANTES de qualquer recusa: saber que o Zabbix está
     falando é útil mesmo quando o que ele diz não casa com nada. Sem isso,
     "host errado" e "Zabbix nunca configurado" ficariam com o mesmo sintoma. */
  update public.monitoring_webhooks
     set last_seen_at = now()
   where id = v_webhook.webhook_id;

  v_estado := case lower(coalesce(p_state, ''))
                when 'problem' then 'down'
                when 'down'    then 'down'
                when 'ok'      then 'up'
                when 'up'      then 'up'
                when 'resolved' then 'up'
                else null
              end;
  if v_estado is null then
    return jsonb_build_object('ok', false, 'motivo', 'estado_invalido', 'recebido', p_state);
  end if;

  /* Acha o link: identificador externo primeiro, nome de host depois. O
     identificador é mais estável — renomear o host no Zabbix não deveria
     desligar o registro de disponibilidade. */
  select l.id into v_link_id
    from public.internet_links l
   where l.tenant_id = v_webhook.tenant_id
     and l.deleted_at is null
     and (
       (p_external_id is not null and l.monitoring_external_id = p_external_id)
       or (p_host is not null and lower(l.monitoring_host) = lower(p_host))
     )
   order by (l.monitoring_external_id = p_external_id) desc nulls last
   limit 1;

  if v_link_id is null then
    return jsonb_build_object('ok', false, 'motivo', 'link_nao_encontrado',
                              'host', p_host, 'external_id', p_external_id);
  end if;

  if v_estado = 'down' then
    begin
      insert into public.link_availability_events
        (tenant_id, link_id, state, started_at, source, external_event_id, note)
      values
        (v_webhook.tenant_id, v_link_id, 'down', v_quando, 'zabbix', p_external_id, p_note);
    exception
      /* Os dois índices únicos da 0021 fazendo o trabalho: entrega repetida
         (mesmo external_event_id) e "caiu" sobre um link já caído. Nenhum dos
         dois é erro — são o funcionamento normal de um monitor que reenvia. */
      when unique_violation then
        return jsonb_build_object('ok', true, 'acao', 'repetido', 'link_id', v_link_id);
    end;

    update public.internet_links
       set last_state = 'down', last_state_at = v_quando
     where id = v_link_id;

    return jsonb_build_object('ok', true, 'acao', 'aberto', 'link_id', v_link_id);
  end if;

  update public.link_availability_events
     set ended_at = v_quando,
         note     = coalesce(note, p_note)
   where link_id = v_link_id
     and ended_at is null;
  get diagnostics v_afetadas = row_count;

  update public.internet_links
     set last_state = 'up', last_state_at = v_quando
   where id = v_link_id;

  /* "Voltou" sem queda aberta não é erro: acontece quando o monitor é instalado
     com o link já no ar, ou quando a queda foi fechada à mão antes. Registrar
     um evento de zero segundo para fechar a simetria seria inventar um incidente
     que não houve. */
  return jsonb_build_object(
    'ok', true,
    'acao', case when v_afetadas > 0 then 'fechado' else 'sem_evento_aberto' end,
    'link_id', v_link_id
  );
end;
$$;

revoke all on function public.link_event_ingest(text, text, text, text, timestamptz, text) from public;
grant execute on function public.link_event_ingest(text, text, text, text, timestamptz, text)
  to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Quem pode administrar a entrada
-- -----------------------------------------------------------------------------
/* `gestor` e não `admin`: quem cuida de conectividade já cadastra link, suspende
   e registra queda à mão (0021). Exigir administrador para ligar o automático
   empurraria a operação de volta para o manual, que é o que esta migração veio
   tirar. */
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('conectividade.links.monitoramento', 'conectividade', 'links', 'monitoramento',
   'Configurar a entrada de monitoramento', 'gestor', 490)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

/*
 * Chave nova no catálogo não chega sozinha a quem já existe.
 *
 * `app.has_permission` exige uma concessão para CADA prefixo da chave, e as
 * concessões dos perfis de sistema foram gravadas quando o tenant nasceu. Sem
 * este passo, a permissão existiria no catálogo e não existiria para ninguém —
 * a tela simplesmente não apareceria, sem erro em lugar nenhum, que é o jeito
 * mais caro de descobrir o problema.
 *
 * `seed_system_access_profiles` é idempotente e já aplica o teto de
 * `min_base_role`: gestor e admin recebem; visualizador e diretoria, não,
 * porque a ação não é `ver`.
 */
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
