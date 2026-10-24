-- =============================================================================
-- 0032 — O agente, parte 2: desempenho, retenção e alertas
-- =============================================================================
-- Onda 3 do plano de paridade (docs/12). A Onda 2 respondeu "o que esta máquina
-- é"; esta responde "como ela está" — e, mais importante, **avisa sem ninguém
-- perguntar**.
--
-- A DECISÃO QUE GOVERNA O ARQUIVO INTEIRO
-- ---------------------------------------
-- Métrica de desempenho **não entra na linha do ativo**. `it_assets` é um
-- registro: uma linha por equipamento, que muda raramente. Guardar o último
-- `cpu_percent` ali parece prático e destrói a tabela de três jeitos: perde-se o
-- histórico (que é o ponto), todo `update` dispara a trigger de auditoria
-- enchendo `audit_log` de ruído, e a linha passa a ser reescrita a cada cinco
-- minutos numa tabela que o resto do sistema referencia por chave estrangeira.
--
-- AS TRÊS CAMADAS, E POR QUE SÃO TRÊS
-- -----------------------------------
-- **1. `agent_metrics_raw` — o detalhe, com vida curta.** É onde se vê o pico de
-- CPU das 14h32. 200 máquinas a cada 5 minutos são 57.600 linhas por dia; com
-- retenção de 7 dias, 400 mil linhas. Isso o Postgres serve sem reclamar.
--
-- **2. `agent_metrics_hourly` — o resumo, com vida longa.** É o que o gráfico lê.
-- A mesma frota vira 4.800 linhas por dia, e um ano cabe em 1,7 milhão.
--
-- **3. `agent_volume_samples` — o disco, já agregado por hora na entrada.** Esta
-- é a que foge do padrão, de propósito: ela guarda o **mínimo de espaço livre da
-- hora**, não cada amostra. O mínimo é exatamente o que um alerta de disco
-- precisa, e agregar na entrada em vez de depois evita uma quarta tabela crua
-- multiplicada pelo número de volumes de cada máquina.
--
-- A HISTERESE DOS ALERTAS
-- -----------------------
-- Um disco parado em 90,1% abriria e fecharia alerta a cada ciclo, mandando um
-- e-mail por vez. Por isso o alerta **abre** no limiar e **fecha** cinco pontos
-- abaixo dele. Sem a folga, o recurso mais útil deste módulo viraria o motivo de
-- as pessoas criarem uma regra de caixa de entrada para ignorá-lo — e aí os
-- alertas de verdade somem junto.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Configuração por tenant
-- -----------------------------------------------------------------------------
-- Na tabela `tenants`, onde `auto_close_after_days`, `sla_warning_pct` e
-- `attachment_quota_mb` já moram. Uma tabela separada só para o agente seria um
-- segundo lugar para procurar configuração, e a pergunta "onde fica o limiar de
-- disco?" não deve ter duas respostas possíveis.
alter table public.tenants
  add column if not exists agent_disk_alert_pct smallint not null default 90
    check (agent_disk_alert_pct between 50 and 99),
  add column if not exists agent_mute_hours integer not null default 24
    check (agent_mute_hours between 1 and 720),
  add column if not exists agent_metrics_retention_days integer not null default 7
    check (agent_metrics_retention_days between 1 and 90),
  /* Modelo de endereço para acesso remoto. Ex.: `rustdesk://{id}` ou
     `https://mesh.exemplo.com/?node={id}`. Vazio = o recurso não aparece.

     O ADR do plano é explícito: controle remoto de tela NÃO é construído aqui —
     é NAT traversal, relay, codec, latência e segurança, um produto inteiro.
     O que cabe a esta plataforma é guardar o id da máquina no serviço escolhido
     e oferecer o link. */
  add column if not exists agent_remote_url text
    check (agent_remote_url is null or agent_remote_url like '%{id}%');

comment on column public.tenants.agent_disk_alert_pct is
  'Percentual de uso em que o alerta de disco abre. Ele fecha 5 pontos abaixo — ver a histerese em app.job_agent_alerts().';
comment on column public.tenants.agent_remote_url is
  'Modelo de endereço de acesso remoto, com {id}. Vazio desliga o recurso. A plataforma não implementa controle remoto: ela integra.';

-- -----------------------------------------------------------------------------
-- 2. O id da máquina no serviço de acesso remoto
-- -----------------------------------------------------------------------------
alter table public.agent_devices
  add column if not exists remote_id text;

comment on column public.agent_devices.remote_id is
  'Id desta máquina no serviço de acesso remoto (RustDesk, MeshCentral). Lido pelo agente, nunca digitado.';

-- -----------------------------------------------------------------------------
-- 3. Métricas cruas
-- -----------------------------------------------------------------------------
-- `branch_id` é COPIADO de `agent_devices` em vez de buscado por junção. É
-- desnormalização deliberada, pela lição da entrega 6: o indicador do painel
-- precisa do escopo, e uma junção com `agent_devices` em cada consulta de série
-- temporal é o tipo de custo que só aparece quando a frota cresce.
create table public.agent_metrics_raw (
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  device_id       uuid not null,
  branch_id       uuid,
  collected_at    timestamptz not null,

  cpu_percent     smallint check (cpu_percent between 0 and 100),
  mem_used_bytes  bigint check (mem_used_bytes >= 0),
  mem_total_bytes bigint check (mem_total_bytes >= 0),
  uptime_s        bigint check (uptime_s >= 0),

  /* Os serviços críticos que estavam FORA neste instante. Vazio é o normal, e
     por isso a coluna guarda a exceção e não o estado completo: guardar "estes
     40 serviços estão no ar" a cada cinco minutos seria gravar a mesma lista
     100 mil vezes por dia para descobrir o dia em que um sumiu. */
  servicos_fora   text[] not null default '{}',

  /*
   * A chave primária é (device_id, collected_at), e ela é a idempotência.
   *
   * O agente guarda as amostras numa fila local e reenvia o lote quando a rede
   * volta. Sem a chave, um reenvio duplicaria cada amostra — e a média da hora
   * passaria a ser calculada sobre a mesma leitura contada duas vezes.
   */
  primary key (device_id, collected_at),
  constraint fk_amr_device foreign key (device_id, tenant_id)
    references public.agent_devices (id, tenant_id) on delete cascade
);

-- BRIN e não B-tree: a tabela é escrita em ordem de tempo e varrida por faixa de
-- tempo, que é exatamente o caso em que o BRIN custa alguns kilobytes onde o
-- B-tree custaria dezenas de megabytes.
create index idx_metrics_raw_tempo on public.agent_metrics_raw using brin (collected_at);
create index idx_metrics_raw_tenant on public.agent_metrics_raw (tenant_id, collected_at desc);

comment on table public.agent_metrics_raw is
  'Amostras de desempenho, retenção curta. A chave (device_id, collected_at) é o que faz o reenvio da fila do agente não duplicar leitura.';

-- -----------------------------------------------------------------------------
-- 4. Métricas por hora
-- -----------------------------------------------------------------------------
-- O que o gráfico lê. Guarda média E máximo porque as duas respondem perguntas
-- diferentes: a média diz se a máquina está pequena para o trabalho, o máximo diz
-- se ela trava. Uma média de 40% com picos de 100% é uma máquina que trava, e a
-- média sozinha esconderia isso.
create table public.agent_metrics_hourly (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  device_id     uuid not null,
  branch_id     uuid,
  hora          timestamptz not null,

  cpu_avg       smallint check (cpu_avg between 0 and 100),
  cpu_max       smallint check (cpu_max between 0 and 100),
  mem_avg_pct   smallint check (mem_avg_pct between 0 and 100),
  mem_max_pct   smallint check (mem_max_pct between 0 and 100),
  amostras      integer not null default 0 check (amostras >= 0),

  primary key (device_id, hora),
  constraint fk_amh_device foreign key (device_id, tenant_id)
    references public.agent_devices (id, tenant_id) on delete cascade
);

create index idx_metrics_hourly_tenant on public.agent_metrics_hourly (tenant_id, hora desc);

comment on table public.agent_metrics_hourly is
  'Agregado por hora, retenção longa. É o que o gráfico lê. Média e máximo juntos porque respondem perguntas diferentes.';

-- -----------------------------------------------------------------------------
-- 5. Espaço em disco, já agregado por hora na entrada
-- -----------------------------------------------------------------------------
-- Guarda o MÍNIMO de espaço livre da hora, e não cada amostra. O mínimo é o que
-- um alerta de disco precisa saber, e agregar na entrada evita uma tabela crua
-- multiplicada pelo número de volumes de cada máquina.
--
-- `total_bytes` também fica: sem ele não dá para calcular percentual, e o
-- tamanho do volume muda (alguém estende a partição). Guardar o último visto da
-- hora é suficiente — ninguém redimensiona disco de hora em hora.
create table public.agent_volume_samples (
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  device_id       uuid not null,
  branch_id       uuid,
  ponto           text not null check (length(ponto) between 1 and 120),
  hora            timestamptz not null,

  total_bytes     bigint not null check (total_bytes > 0),
  livre_min_bytes bigint not null check (livre_min_bytes >= 0),
  amostras        integer not null default 1 check (amostras >= 0),

  primary key (device_id, ponto, hora),
  constraint fk_avs_device foreign key (device_id, tenant_id)
    references public.agent_devices (id, tenant_id) on delete cascade,
  constraint avs_livre_cabe_no_total check (livre_min_bytes <= total_bytes)
);

create index idx_volume_samples_tenant on public.agent_volume_samples (tenant_id, hora desc);

comment on table public.agent_volume_samples is
  'Espaço em disco por volume, agregado por hora na entrada. Guarda o MÍNIMO livre da hora, que é o que o alerta precisa.';

-- -----------------------------------------------------------------------------
-- 6. Alertas
-- -----------------------------------------------------------------------------
-- Um alerta é um ESTADO, não um evento: ele abre, fica aberto enquanto a
-- condição vale, e fecha. A alternativa — uma linha por detecção — produziria
-- 288 linhas por dia dizendo "o disco continua cheio", e a pergunta "o que está
-- errado agora?" viraria uma consulta com `distinct on`.
create table public.agent_alerts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  device_id   uuid not null,
  branch_id   uuid,

  kind        text not null check (kind in (
                'disco_cheio', 'maquina_muda', 'servico_fora', 'smart_falha')),

  /* O que, dentro da máquina, disparou: o ponto de montagem, o nome do serviço,
     o modelo do disco. Vazio para o que é da máquina inteira (`maquina_muda`).
     Entra na chave de unicidade: dois discos cheios na mesma máquina são dois
     alertas, e precisam ser. */
  chave       text not null default '',

  severidade  text not null default 'alerta' check (severidade in ('aviso', 'alerta', 'critico')),
  mensagem    text not null,
  /* O número que disparou, para a tela mostrar sem recalcular. */
  valor       numeric(6,2),

  aberto_em   timestamptz not null default now(),
  fechado_em  timestamptz,
  notificado_em timestamptz,

  constraint fk_aa_device foreign key (device_id, tenant_id)
    references public.agent_devices (id, tenant_id) on delete cascade,
  constraint uq_aa_id_tenant unique (id, tenant_id)
);

-- Um alerta ABERTO por (máquina, tipo, chave). É o que torna a detecção
-- idempotente: o trabalho pode rodar de minuto em minuto sem abrir o mesmo
-- alerta de novo.
create unique index uq_alerta_aberto
  on public.agent_alerts (device_id, kind, chave)
  where fechado_em is null;

create index idx_alertas_abertos
  on public.agent_alerts (tenant_id, aberto_em desc)
  where fechado_em is null;

comment on table public.agent_alerts is
  'Alerta é estado, não evento: abre, fica aberto, fecha. O índice único por (máquina, tipo, chave) aberto é o que torna a detecção idempotente.';

-- -----------------------------------------------------------------------------
-- 7. A caixa de saída aprende um tipo novo
-- -----------------------------------------------------------------------------
alter table public.email_outbox drop constraint if exists email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in (
    'sla_warning','sla_critical','sla_breach',
    'satisfaction_invite','ticket_assigned','test',
    -- 0032: alerta do agente de inventário.
    'agent_alert'));

-- -----------------------------------------------------------------------------
-- 8. Ingestão de métricas
-- -----------------------------------------------------------------------------
-- Recebe um LOTE de amostras, não uma. O agente amostra de 5 em 5 minutos e
-- envia de 10 em 10: mandar uma requisição por amostra dobraria o número de
-- conexões para transportar a mesma informação, e deixaria metade do lote
-- perdida quando a rede caísse no meio.
--
-- `security definer` concedida a `anon`, pelo mesmo raciocínio da 0031: a função
-- é a única porta, só aceita o token da máquina, e o tenant é DERIVADO do token —
-- não existe parâmetro de tenant para falsificar.
create or replace function public.agent_ingest_metrics(
  p_device_token text,
  p_amostras     jsonb
)
returns table (status text, aceitas integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash    text := encode(digest(p_device_token, 'sha256'), 'hex');
  v_dev     public.agent_devices;
  v_item    jsonb;
  v_vol     jsonb;
  v_quando  timestamptz;
  v_aceitas integer := 0;
begin
  select * into v_dev from public.agent_devices
   where token_hash = v_hash and revoked_at is null;
  if not found then
    return query select 'unauthorized'::text, 0;
    return;
  end if;

  -- Enviar métrica também é dar sinal de vida: a máquina acabou de falar.
  update public.agent_devices set last_seen_at = now() where id = v_dev.id;

  for v_item in select * from jsonb_array_elements(coalesce(p_amostras, '[]'::jsonb))
  loop
    v_quando := (nullif(v_item ->> 'em', ''))::timestamptz;
    continue when v_quando is null;

    /*
     * Amostra do futuro é recusada. O relógio de máquina de cliente erra — por
     * fuso mal configurado, por bateria de placa-mãe acabada, por imagem de
     * máquina virtual restaurada. Uma amostra com data de 2027 ficaria no topo
     * de todo gráfico para sempre, e a purga por retenção nunca a alcançaria.
     *
     * Uma hora de folga cobre atraso de relógio honesto sem deixar passar o
     * erro grosseiro.
     */
    continue when v_quando > now() + interval '1 hour';
    -- E do passado remoto também: fila local represada por meses não deve
    -- ressuscitar dado que a retenção já teria apagado.
    continue when v_quando < now() - interval '90 days';

    insert into public.agent_metrics_raw (
      tenant_id, device_id, branch_id, collected_at,
      cpu_percent, mem_used_bytes, mem_total_bytes, uptime_s, servicos_fora
    ) values (
      v_dev.tenant_id, v_dev.id, v_dev.branch_id, v_quando,
      least(100, greatest(0, (v_item ->> 'cpu')::numeric))::smallint,
      nullif(v_item ->> 'mem_usada', '')::bigint,
      nullif(v_item ->> 'mem_total', '')::bigint,
      nullif(v_item ->> 'ligada_s', '')::bigint,
      coalesce(
        (select array_agg(x) from jsonb_array_elements_text(
           coalesce(v_item -> 'servicos_fora', '[]'::jsonb)) as t(x)),
        '{}')
    )
    -- Reenvio do lote não duplica: a chave primária já tem a amostra.
    on conflict (device_id, collected_at) do nothing;

    /*
     * Amostra repetida encerra o item AQUI, antes dos volumes.
     *
     * A primeira versão deste código pulava só a métrica e seguia para os
     * volumes, e a idempotência ficava pela metade: o reenvio de um lote — que
     * acontece sempre que a rede cai entre o servidor gravar e o agente receber
     * a confirmação — somava de novo em `amostras`, e a tela passava a dizer
     * que a hora teve o dobro de leituras que teve. Foi encontrado por asserção
     * de schema, não em produção.
     */
    continue when not found;
    v_aceitas := v_aceitas + 1;

    -- Volumes, agregados por hora já na entrada.
    for v_vol in select * from jsonb_array_elements(coalesce(v_item -> 'volumes', '[]'::jsonb))
    loop
      continue when nullif(trim(coalesce(v_vol ->> 'ponto', '')), '') is null;
      continue when coalesce((v_vol ->> 'total')::bigint, 0) <= 0;

      insert into public.agent_volume_samples (
        tenant_id, device_id, branch_id, ponto, hora,
        total_bytes, livre_min_bytes, amostras
      ) values (
        v_dev.tenant_id, v_dev.id, v_dev.branch_id,
        left(trim(v_vol ->> 'ponto'), 120),
        date_trunc('hour', v_quando),
        (v_vol ->> 'total')::bigint,
        least((v_vol ->> 'livre')::bigint, (v_vol ->> 'total')::bigint),
        1
      )
      on conflict (device_id, ponto, hora) do update
        -- `least`: o que fica é o PIOR momento da hora, que é o que o alerta
        -- precisa. `greatest` no total porque partição estendida no meio da hora
        -- deve valer a partir dali, senão o percentual sairia errado para cima.
        set livre_min_bytes = least(public.agent_volume_samples.livre_min_bytes, excluded.livre_min_bytes),
            total_bytes     = greatest(public.agent_volume_samples.total_bytes, excluded.total_bytes),
            amostras        = public.agent_volume_samples.amostras + 1;
    end loop;
  end loop;

  return query select 'stored'::text, v_aceitas;
end;
$$;

revoke all on function public.agent_ingest_metrics(text, jsonb) from public;
grant execute on function public.agent_ingest_metrics(text, jsonb) to anon, authenticated;

comment on function public.agent_ingest_metrics(text, jsonb) is
  'Recebe um lote de amostras. Idempotente por (device_id, collected_at); volumes já entram agregados por hora.';

-- -----------------------------------------------------------------------------
-- 9. O id de acesso remoto
-- -----------------------------------------------------------------------------
-- Separado da ingestão porque ele muda quase nunca (o RustDesk gera o id uma vez
-- e o guarda), e porque a máquina pode não ter o serviço instalado — caso em que
-- esta função simplesmente nunca é chamada.
create or replace function public.agent_set_remote_id(
  p_device_token text,
  p_remote_id    text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text := encode(digest(p_device_token, 'sha256'), 'hex');
  v_id   uuid;
begin
  update public.agent_devices
     set remote_id = nullif(left(trim(coalesce(p_remote_id, '')), 120), '')
   where token_hash = v_hash and revoked_at is null
  returning id into v_id;

  return v_id is not null;
end;
$$;

revoke all on function public.agent_set_remote_id(text, text) from public;
grant execute on function public.agent_set_remote_id(text, text) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 10. Agregação por hora
-- -----------------------------------------------------------------------------
-- Só horas COMPLETAS. Agregar a hora corrente produziria uma linha que muda a
-- cada execução do trabalho — e um gráfico cuja última barra encolhe e cresce
-- sozinha é um gráfico em que ninguém confia.
create or replace function app.job_aggregate_metrics()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id bigint;
  v_count  integer := 0;
begin
  insert into public.job_runs (job) values ('aggregate_metrics') returning id into v_run_id;

  with completas as (
    select
      r.tenant_id,
      r.device_id,
      /* A filial MAIS RECENTE da hora, e não uma qualquer: a máquina pode ter
         sido reclassificada no meio do período, e o agregado deve ficar onde ela
         está agora. (`max()` não existe para uuid, e não seria o certo aqui
         mesmo que existisse — ordenaria por bytes do identificador.) */
      (array_agg(r.branch_id order by r.collected_at desc))[1] as branch_id,
      date_trunc('hour', r.collected_at)              as hora,
      round(avg(r.cpu_percent))::smallint             as cpu_avg,
      max(r.cpu_percent)                              as cpu_max,
      round(avg(
        case when r.mem_total_bytes > 0
          then r.mem_used_bytes::numeric * 100 / r.mem_total_bytes end))::smallint as mem_avg_pct,
      round(max(
        case when r.mem_total_bytes > 0
          then r.mem_used_bytes::numeric * 100 / r.mem_total_bytes end))::smallint as mem_max_pct,
      count(*)::integer                               as amostras
    from public.agent_metrics_raw r
    where r.collected_at < date_trunc('hour', now())
    group by r.tenant_id, r.device_id, date_trunc('hour', r.collected_at)
  ),
  gravadas as (
    insert into public.agent_metrics_hourly as h
      (tenant_id, device_id, branch_id, hora, cpu_avg, cpu_max, mem_avg_pct, mem_max_pct, amostras)
    select tenant_id, device_id, branch_id, hora, cpu_avg, cpu_max, mem_avg_pct, mem_max_pct, amostras
      from completas
    -- Reprocessar a mesma hora é seguro: a linha é substituída pelo recálculo, e
    -- não somada. Importa porque um lote atrasado do agente pode acrescentar
    -- amostras a uma hora que já foi agregada.
    on conflict (device_id, hora) do update
      set cpu_avg     = excluded.cpu_avg,
          cpu_max     = excluded.cpu_max,
          mem_avg_pct = excluded.mem_avg_pct,
          mem_max_pct = excluded.mem_max_pct,
          amostras    = excluded.amostras,
          branch_id   = excluded.branch_id
    returning 1
  )
  select count(*)::integer into v_count from gravadas;

  update public.job_runs set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;
  return v_count;
end;
$$;

revoke all on function app.job_aggregate_metrics() from public;
grant execute on function app.job_aggregate_metrics() to service_role;

-- -----------------------------------------------------------------------------
-- 11. Retenção
-- -----------------------------------------------------------------------------
-- Sem isto, `agent_metrics_raw` cresce para sempre. Um recurso que enche o disco
-- do servidor em silêncio é pior que um recurso que não existe — e o prazo é por
-- tenant porque quem tem 20 máquinas pode querer 30 dias de detalhe, e quem tem
-- 2.000 não pode.
create or replace function app.job_purge_metrics()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id bigint;
  v_count  integer := 0;
  v_n      integer;
  v_tenant record;
begin
  insert into public.job_runs (job) values ('purge_metrics') returning id into v_run_id;

  for v_tenant in select id, agent_metrics_retention_days from public.tenants loop
    delete from public.agent_metrics_raw
     where tenant_id = v_tenant.id
       and collected_at < now() - make_interval(days => v_tenant.agent_metrics_retention_days);
    get diagnostics v_n = row_count;
    v_count := v_count + v_n;
  end loop;

  /*
   * O agregado por hora e o de volume vivem um ano, e não o prazo do detalhe.
   *
   * São a mesma informação com outra granularidade: o detalhe responde "o que
   * houve às 14h32 de ontem" e envelhece rápido; o agregado responde "esta
   * máquina está pequena para o trabalho há seis meses", que é a pergunta que
   * justifica uma compra — e que ninguém faz dentro de sete dias.
   */
  delete from public.agent_metrics_hourly where hora < now() - interval '1 year';
  get diagnostics v_n = row_count;
  v_count := v_count + v_n;

  delete from public.agent_volume_samples where hora < now() - interval '1 year';
  get diagnostics v_n = row_count;
  v_count := v_count + v_n;

  -- Alerta fechado há mais de 180 dias já cumpriu o papel de prova.
  delete from public.agent_alerts
   where fechado_em is not null and fechado_em < now() - interval '180 days';
  get diagnostics v_n = row_count;
  v_count := v_count + v_n;

  update public.job_runs set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;
  return v_count;
end;
$$;

revoke all on function app.job_purge_metrics() from public;
grant execute on function app.job_purge_metrics() to service_role;

-- -----------------------------------------------------------------------------
-- 12. Os alertas
-- -----------------------------------------------------------------------------
-- Abre o que passou a valer, fecha o que deixou de valer, e enfileira UM e-mail
-- por abertura.
--
-- A histerese está aqui: abre em `agent_disk_alert_pct`, fecha cinco pontos
-- abaixo. Um disco parado em 90,1% com limiar de 90 abriria e fecharia a cada
-- ciclo — e um alerta que chega oito vezes por dia é um alerta que as pessoas
-- filtram para a lixeira, levando junto os que importam.
create or replace function app.job_agent_alerts()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id bigint;
  v_count  integer := 0;
  v_n      integer;
begin
  insert into public.job_runs (job) values ('agent_alerts') returning id into v_run_id;

  -- ---------------------------------------------------------------------------
  -- 12.1 Disco cheio
  -- ---------------------------------------------------------------------------
  with ultimo as (
    select distinct on (v.device_id, v.ponto)
      v.device_id, v.tenant_id, v.branch_id, v.ponto, v.total_bytes, v.livre_min_bytes,
      round((v.total_bytes - v.livre_min_bytes)::numeric * 100 / v.total_bytes, 2) as uso_pct,
      t.agent_disk_alert_pct
    from public.agent_volume_samples v
    join public.tenants t on t.id = v.tenant_id and t.deleted_at is null
    join public.agent_devices d on d.id = v.device_id and d.revoked_at is null
    -- Amostra velha não vale para alerta: ela diria "o disco estava cheio há três
    -- dias", e a máquina pode ter sido limpa desde então.
    where v.hora > now() - interval '6 hours'
    order by v.device_id, v.ponto, v.hora desc
  ),
  abre as (
    insert into public.agent_alerts (tenant_id, device_id, branch_id, kind, chave, severidade, mensagem, valor)
    select u.tenant_id, u.device_id, u.branch_id, 'disco_cheio', u.ponto,
           case when u.uso_pct >= 97 then 'critico' else 'alerta' end,
           format('O volume %s está com %s%% de uso (%s livres).',
                  u.ponto,
                  trim(to_char(u.uso_pct, '990D9')),
                  pg_size_pretty(u.livre_min_bytes)),
           u.uso_pct
      from ultimo u
     where u.uso_pct >= u.agent_disk_alert_pct
    on conflict do nothing
    returning 1
  ),
  fecha as (
    update public.agent_alerts a
       set fechado_em = now()
      from ultimo u
     where a.device_id = u.device_id
       and a.kind = 'disco_cheio'
       and a.chave = u.ponto
       and a.fechado_em is null
       -- Cinco pontos de folga: é a histerese.
       and u.uso_pct < u.agent_disk_alert_pct - 5
    returning 1
  )
  select (select count(*) from abre) + (select count(*) from fecha) into v_n;
  v_count := v_count + v_n;

  -- ---------------------------------------------------------------------------
  -- 12.2 Máquina muda
  -- ---------------------------------------------------------------------------
  -- É o alerta que justifica o módulo. Agente parado é invisível por natureza:
  -- não dá erro, não gera chamado, simplesmente deixa de haver dado novo — e o
  -- inventário envelhece sem avisar ninguém.
  with estado as (
    select d.id as device_id, d.tenant_id, d.branch_id, d.hostname, d.last_seen_at,
           (d.last_seen_at is null or d.last_seen_at < now() - make_interval(hours => t.agent_mute_hours)) as muda,
           t.agent_mute_hours
      from public.agent_devices d
      join public.tenants t on t.id = d.tenant_id and t.deleted_at is null
     where d.revoked_at is null
  ),
  abre as (
    insert into public.agent_alerts (tenant_id, device_id, branch_id, kind, chave, severidade, mensagem)
    select e.tenant_id, e.device_id, e.branch_id, 'maquina_muda', '', 'alerta',
           format('%s não dá sinal há mais de %s horas.',
                  coalesce(e.hostname, 'A máquina'), e.agent_mute_hours)
      from estado e
     where e.muda
    on conflict do nothing
    returning 1
  ),
  fecha as (
    update public.agent_alerts a
       set fechado_em = now()
      from estado e
     where a.device_id = e.device_id
       and a.kind = 'maquina_muda'
       and a.fechado_em is null
       and not e.muda
    returning 1
  )
  select (select count(*) from abre) + (select count(*) from fecha) into v_n;
  v_count := v_count + v_n;

  -- ---------------------------------------------------------------------------
  -- 12.3 Serviço crítico fora do ar
  -- ---------------------------------------------------------------------------
  with ultima as (
    select distinct on (r.device_id)
      r.device_id, r.tenant_id, r.branch_id, r.servicos_fora, r.collected_at, d.hostname
    from public.agent_metrics_raw r
    join public.agent_devices d on d.id = r.device_id and d.revoked_at is null
    where r.collected_at > now() - interval '2 hours'
    order by r.device_id, r.collected_at desc
  ),
  fora as (
    select u.device_id, u.tenant_id, u.branch_id, u.hostname, s as servico
      from ultima u, unnest(u.servicos_fora) as s
  ),
  abre as (
    insert into public.agent_alerts (tenant_id, device_id, branch_id, kind, chave, severidade, mensagem)
    select f.tenant_id, f.device_id, f.branch_id, 'servico_fora', f.servico, 'critico',
           format('O serviço %s está fora do ar em %s.', f.servico, coalesce(f.hostname, 'uma máquina'))
      from fora f
    on conflict do nothing
    returning 1
  ),
  fecha as (
    update public.agent_alerts a
       set fechado_em = now()
      from ultima u
     where a.device_id = u.device_id
       and a.kind = 'servico_fora'
       and a.fechado_em is null
       and not (a.chave = any (u.servicos_fora))
    returning 1
  )
  select (select count(*) from abre) + (select count(*) from fecha) into v_n;
  v_count := v_count + v_n;

  -- ---------------------------------------------------------------------------
  -- 12.4 SMART em falha
  -- ---------------------------------------------------------------------------
  -- Vem do INVENTÁRIO, não das métricas: a saúde do disco é lida na coleta
  -- diária. Entra aqui porque o lugar certo de um alerta é junto dos outros
  -- alertas — e porque "o disco vai morrer" é a informação mais acionável que
  -- este módulo produz.
  with discos as (
    select d.id as device_id, d.tenant_id, d.branch_id, d.hostname,
           coalesce(disco ->> 'modelo', disco ->> 'dispositivo', 'disco') as modelo,
           disco ->> 'saude' as saude
      from public.agent_devices d
      /*
       * O inventário corrente é o que o `last_snapshot_hash` do dispositivo
       * aponta — não "o mais recente por `collected_at`".
       *
       * A diferença importa quando duas coletas carregam o mesmo carimbo de
       * hora, o que acontece com relógio travado na máquina de cliente (e, aqui,
       * com duas ingestões na mesma transação). `order by collected_at desc
       * limit 1` sobre o empate escolhe uma das duas sem critério, e o alerta de
       * SMART passa a abrir e fechar conforme o humor do planejador. O hash é
       * exato: ele é a definição de "o que está instalado agora".
       */
      join lateral (
        select s.payload
          from public.agent_inventory_snapshots s
         where s.device_id = d.id
           and s.payload_hash = d.last_snapshot_hash
         limit 1
      ) ultimo on true,
      lateral jsonb_array_elements(coalesce(ultimo.payload -> 'discos', '[]'::jsonb)) as disco
     where d.revoked_at is null
  ),
  abre as (
    insert into public.agent_alerts (tenant_id, device_id, branch_id, kind, chave, severidade, mensagem)
    select x.tenant_id, x.device_id, x.branch_id, 'smart_falha', x.modelo,
           case when x.saude = 'falha' then 'critico' else 'aviso' end,
           format('O disco %s em %s reporta SMART em "%s".',
                  x.modelo, coalesce(x.hostname, 'uma máquina'), x.saude)
      from discos x
     where x.saude in ('falha', 'atencao')
    on conflict do nothing
    returning 1
  ),
  fecha as (
    update public.agent_alerts a
       set fechado_em = now()
      from discos x
     where a.device_id = x.device_id
       and a.kind = 'smart_falha'
       and a.chave = x.modelo
       and a.fechado_em is null
       and x.saude not in ('falha', 'atencao')
    returning 1
  )
  select (select count(*) from abre) + (select count(*) from fecha) into v_n;
  v_count := v_count + v_n;

  -- ---------------------------------------------------------------------------
  -- 12.5 Avisar — uma vez por alerta
  -- ---------------------------------------------------------------------------
  -- `notificado_em` é o que garante o "uma vez": a `dedupe_key` sozinha também
  -- garantiria, mas deixaria a fila tentando gravar a mesma linha a cada ciclo
  -- e descartando por conflito. Marcar na origem é mais barato e deixa visível,
  -- na própria tabela de alertas, quais já saíram.
  with novos as (
    select a.*, d.hostname
      from public.agent_alerts a
      join public.agent_devices d on d.id = a.device_id
     where a.fechado_em is null
       and a.notificado_em is null
  ),
  alvos as (
    select n.*, p.id as user_id, p.email, p.full_name
      from novos n
      join public.profiles p
        on p.tenant_id = n.tenant_id
       and p.is_active
       and p.role in ('gestor', 'admin')
       and p.email is not null
     where app.quer_notificacao(p.id, 'agent_alert')
  ),
  gravadas as (
    insert into public.email_outbox
      (tenant_id, to_email, to_name, subject, body_text, kind, dedupe_key)
    select
      a.tenant_id, a.email, a.full_name,
      format('[Inventário] %s — %s',
             case a.kind
               when 'disco_cheio'  then 'Disco cheio'
               when 'maquina_muda' then 'Máquina sem contato'
               when 'servico_fora' then 'Serviço fora do ar'
               else                     'Disco com defeito'
             end,
             coalesce(a.hostname, 'máquina sem nome')),
      format(E'%s\n\nVeja a máquina em /inventario/agentes/%s', a.mensagem, a.device_id),
      'agent_alert',
      -- O id do alerta na chave: alerta que reabre depois de fechar é outro
      -- alerta, e deve avisar de novo.
      format('agent_alert:%s:%s', a.id, a.user_id)
    from alvos a
    on conflict do nothing
    returning 1
  )
  select count(*)::integer into v_n from gravadas;
  v_count := v_count + v_n;

  update public.agent_alerts
     set notificado_em = now()
   where fechado_em is null and notificado_em is null;

  update public.job_runs set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;
  return v_count;
end;
$$;

revoke all on function app.job_agent_alerts() from public;
grant execute on function app.job_agent_alerts() to service_role;

comment on function app.job_agent_alerts() is
  'Abre, fecha e notifica os alertas do agente. A histerese de 5 pontos no disco é o que impede o alerta de bater oito vezes por dia.';

-- -----------------------------------------------------------------------------
-- 13. RLS
-- -----------------------------------------------------------------------------
select app.harden_table('public.agent_metrics_raw');
select app.harden_table('public.agent_metrics_hourly');
select app.harden_table('public.agent_volume_samples');
select app.harden_table('public.agent_alerts');

-- As três tabelas de métrica NÃO são auditadas. São escritas por máquina, a cada
-- cinco minutos, e nunca editadas por gente: auditar seria gravar uma segunda
-- cópia de tudo em `audit_log` — a mesma aritmética que tirou `last_seen_at` da
-- trilha na migração 0031, só que pior.
select app.attach_audit('public.agent_alerts');

create policy agent_metrics_raw_select on public.agent_metrics_raw
  for select to authenticated
  using (
    tenant_id = app.current_tenant_id()
    and app.has_permission('inventario.agentes.ver')
    and (branch_id is null or app.can_see_branch(branch_id))
  );

create policy agent_metrics_hourly_select on public.agent_metrics_hourly
  for select to authenticated
  using (
    tenant_id = app.current_tenant_id()
    and app.has_permission('inventario.agentes.ver')
    and (branch_id is null or app.can_see_branch(branch_id))
  );

create policy agent_volume_samples_select on public.agent_volume_samples
  for select to authenticated
  using (
    tenant_id = app.current_tenant_id()
    and app.has_permission('inventario.agentes.ver')
    and (branch_id is null or app.can_see_branch(branch_id))
  );

create policy agent_alerts_select on public.agent_alerts
  for select to authenticated
  using (
    tenant_id = app.current_tenant_id()
    and app.has_permission('inventario.agentes.ver')
    and (branch_id is null or app.can_see_branch(branch_id))
  );

-- Fechar um alerta à mão é escrita, e pede a permissão de gerência. `insert` não
-- existe: alerta nasce da detecção, e mais de lugar nenhum. Um alerta digitado
-- seria um alerta que o trabalho nunca fecharia, porque não há condição que
-- deixe de valer.
create policy agent_alerts_update on public.agent_alerts
  for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('inventario.agentes.gerenciar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('inventario.agentes.gerenciar'));

grant select on public.agent_metrics_raw to authenticated;
grant select on public.agent_metrics_hourly to authenticated;
grant select on public.agent_volume_samples to authenticated;
grant select, update on public.agent_alerts to authenticated;

-- -----------------------------------------------------------------------------
-- 14. A frota ganha o estado de saúde
-- -----------------------------------------------------------------------------
-- A view é refeita (e não alterada) porque `create or replace view` não aceita
-- acrescentar coluna no meio nem mudar tipo. `drop view` descarta os GRANTs —
-- lição da migração 0028 —, então eles são refeitos logo abaixo.
drop view if exists public.vw_agent_fleet;

create view public.vw_agent_fleet
with (security_invoker = true) as
select
  d.id                as device_id,
  d.tenant_id,
  d.branch_id,
  d.device_uuid,
  d.hostname,
  d.os,
  d.os_version,
  d.chassis,
  d.agent_version,
  d.it_asset_id,
  d.match_method,
  d.divergences,
  d.remote_id,
  d.last_seen_at,
  d.last_snapshot_at,
  a.asset_tag,
  a.serial_number,
  a.brand,
  a.model,
  b.name              as branch_name,
  /*
   * O limiar de "mudo" passou a vir do tenant (0032). Ele estava fixo em 24
   * horas, e continua sendo esse o padrão — o que mudou é que agora a tela, o
   * alerta e o indicador leem o MESMO número, em vez de três lugares concordando
   * por coincidência até alguém mexer num deles.
   */
  (d.last_seen_at is null or d.last_seen_at < now() - make_interval(hours => t.agent_mute_hours))
                      as silencioso,
  d.divergences <> '{}'::jsonb as tem_divergencia,
  (select count(*) from public.agent_software s where s.device_id = d.id) as software_count,
  (select count(*) from public.agent_alerts al
    where al.device_id = d.id and al.fechado_em is null) as alertas_abertos,
  -- O último retrato de desempenho, para a lista mostrar sem uma segunda consulta.
  (select h.cpu_avg from public.agent_metrics_hourly h
    where h.device_id = d.id order by h.hora desc limit 1) as cpu_ultima_hora,
  (select h.mem_avg_pct from public.agent_metrics_hourly h
    where h.device_id = d.id order by h.hora desc limit 1) as mem_ultima_hora,
  -- O volume mais apertado da máquina. É o número que decide se ela precisa de
  -- atenção, e mostrar o "disco" sem dizer qual esconderia justamente o cheio.
  (select round((v.total_bytes - v.livre_min_bytes)::numeric * 100 / v.total_bytes)
     from public.agent_volume_samples v
    where v.device_id = d.id and v.hora > now() - interval '24 hours'
    order by (v.total_bytes - v.livre_min_bytes)::numeric / v.total_bytes desc
    limit 1) as disco_mais_cheio_pct
from public.agent_devices d
join public.tenants t on t.id = d.tenant_id
left join public.it_assets a on a.id = d.it_asset_id and a.deleted_at is null
left join public.branches  b on b.id = d.branch_id
where d.revoked_at is null;

grant select on public.vw_agent_fleet to authenticated;

comment on view public.vw_agent_fleet is
  'A frota com agente, já conciliada, com saúde e alertas. O limiar de "silencioso" vem do tenant para tela, alerta e indicador concordarem.';

-- -----------------------------------------------------------------------------
-- 15. Software instalado, visto de cima
-- -----------------------------------------------------------------------------
-- Responde "quem ainda tem o sistema antigo?" e "em quantas máquinas tem este
-- programa?". A pergunta é sempre atravessada — uma linha por programa, não por
-- máquina —, e por isso é view e não consulta na tela: a mesma agregação estaria
-- escrita em três lugares na semana seguinte.
create or replace view public.vw_agent_software
with (security_invoker = true) as
select
  s.tenant_id,
  s.name,
  /*
   * Agrupa por NOME, não por (nome, fabricante).
   *
   * Metade dos programas do Windows não declara fabricante, e a declaração varia
   * entre versões do mesmo programa ("Google LLC", "Google Inc.", vazio).
   * Agrupando pelos dois, o mesmo programa vira duas e três linhas na tela — e
   * "quem ainda tem a versão antiga?" deixa de ter uma resposta, passa a ter
   * três parciais.
   *
   * `max()` ignora nulo, então o fabricante mostrado é um dos declarados, se
   * algum foi. Programas de fabricantes diferentes com o mesmo nome existem e são
   * raros; o nome é o que as pessoas procuram.
   */
  max(s.publisher) as publisher,
  count(distinct s.device_id)::integer as maquinas,
  count(distinct s.version)::integer   as versoes,
  max(s.last_seen_at)                  as visto_por_ultimo,
  -- Quantas máquinas ainda tinham o programa na ÚLTIMA coleta. A diferença para
  -- `maquinas` é quem desinstalou, e é a informação que a tela destaca.
  count(distinct s.device_id) filter (
    where s.last_seen_at > now() - interval '7 days')::integer as maquinas_atuais
from public.agent_software s
join public.agent_devices d on d.id = s.device_id and d.revoked_at is null
group by s.tenant_id, s.name;

grant select on public.vw_agent_software to authenticated;

comment on view public.vw_agent_software is
  'Software agregado pela frota. A diferença entre maquinas e maquinas_atuais é quem desinstalou.';

-- -----------------------------------------------------------------------------
-- 16. Catálogo de permissões
-- -----------------------------------------------------------------------------
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('inventario.software', 'inventario', 'software', null,
   'Software instalado', 'visualizador', 428),
  ('inventario.software.ver', 'inventario', 'software', 'ver',
   'Consultar o software da frota', 'visualizador', 429)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

do $$
declare
  v_tenant uuid;
begin
  for v_tenant in select id from public.tenants loop
    perform app.seed_system_access_profiles(v_tenant);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- 17. A conciliação passa a ler o inventário CORRENTE, e não o mais recente
-- -----------------------------------------------------------------------------
-- Mesma correção da §12.4, aplicada à função da migração 0031: ela escolhia o
-- snapshot por `order by collected_at desc limit 1`, e duas coletas com o mesmo
-- carimbo de hora — relógio travado na máquina de cliente — deixavam a escolha
-- ao acaso. O efeito seria conciliar usando um inventário antigo, o que muda o
-- número de série considerado.
--
-- Só esta linha mudou. O resto é idêntico à 0031, e o comentário longo de lá
-- continua valendo.
create or replace function app.agent_reconcile(p_device_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dev      public.agent_devices;
  v_payload  jsonb;
  v_serial   text;
  v_brand    text;
  v_model    text;
  v_asset    uuid;
  v_metodo   text;
  v_tipo     text;
  v_atual    public.it_assets;
  v_div      jsonb := '{}'::jsonb;
begin
  select * into v_dev from public.agent_devices where id = p_device_id;
  if not found then
    return null;
  end if;

  -- A mudança: o corrente é o que o hash do dispositivo aponta.
  select payload into v_payload
    from public.agent_inventory_snapshots
   where device_id = p_device_id
     and payload_hash = v_dev.last_snapshot_hash
   limit 1;

  v_serial := nullif(trim(coalesce(v_payload -> 'sistema' ->> 'numero_serie', '')), '');
  v_brand  := nullif(trim(coalesce(v_payload -> 'sistema' ->> 'fabricante', '')), '');
  v_model  := nullif(trim(coalesce(v_payload -> 'sistema' ->> 'modelo', '')), '');

  if v_dev.it_asset_id is not null then
    select * into v_atual from public.it_assets
     where id = v_dev.it_asset_id and deleted_at is null;
    if found then
      v_asset  := v_atual.id;
      v_metodo := v_dev.match_method;
    end if;
  end if;

  if v_asset is null and app.agent_serial_utilizavel(v_serial) then
    select id into v_asset from public.it_assets
     where tenant_id = v_dev.tenant_id
       and deleted_at is null
       and upper(serial_number) = upper(trim(v_serial))
     limit 1;
    if v_asset is not null then
      v_metodo := 'serial';
    end if;
  end if;

  if v_asset is null then
    select id into v_asset from public.it_assets
     where tenant_id = v_dev.tenant_id
       and deleted_at is null
       and specs -> 'agente' ->> 'device_uuid' = v_dev.device_uuid::text
     limit 1;
    if v_asset is not null then
      v_metodo := 'device_uuid';
    end if;
  end if;

  if v_asset is null and nullif(trim(coalesce(v_dev.hostname, '')), '') is not null then
    select id into v_asset from public.it_assets
     where tenant_id = v_dev.tenant_id
       and deleted_at is null
       and serial_number is null
       and upper(coalesce(asset_tag, '')) = upper(trim(v_dev.hostname))
     limit 1;
    if v_asset is not null then
      v_metodo := 'hostname';
    end if;
  end if;

  if v_asset is null then
    v_tipo := case lower(coalesce(v_dev.chassis, ''))
                when 'notebook' then 'notebook'
                when 'laptop'   then 'notebook'
                when 'desktop'  then 'desktop'
                when 'server'   then 'server'
                else 'other'
              end;

    insert into public.it_assets (
      tenant_id, asset_type, brand, model, serial_number, status, branch_id, specs, notes
    ) values (
      v_dev.tenant_id, v_tipo, v_brand, v_model,
      case when app.agent_serial_utilizavel(v_serial) then trim(v_serial) end,
      'active', v_dev.branch_id,
      jsonb_build_object('agente', jsonb_build_object(
        'device_uuid', v_dev.device_uuid, 'criado_pelo_agente', true)),
      'Cadastrado automaticamente pelo agente de inventário.'
    )
    returning id into v_asset;
    v_metodo := 'created';
  end if;

  select * into v_atual from public.it_assets where id = v_asset;

  if v_atual.serial_number is not null
     and app.agent_serial_utilizavel(v_serial)
     and upper(v_atual.serial_number) <> upper(trim(v_serial)) then
    v_div := v_div || jsonb_build_object('serial_number', jsonb_build_object(
      'cadastrado', v_atual.serial_number, 'agente', trim(v_serial)));
  end if;
  if v_atual.model is not null and v_model is not null
     and lower(v_atual.model) <> lower(v_model) then
    v_div := v_div || jsonb_build_object('model', jsonb_build_object(
      'cadastrado', v_atual.model, 'agente', v_model));
  end if;

  update public.it_assets set
      brand         = coalesce(brand, v_brand),
      model         = coalesce(model, v_model),
      serial_number = coalesce(
                        serial_number,
                        case when app.agent_serial_utilizavel(v_serial) then trim(v_serial) end),
      specs         = jsonb_set(
                        coalesce(specs, '{}'::jsonb), '{agente}',
                        coalesce(v_payload, '{}'::jsonb)
                          || jsonb_build_object('device_uuid', v_dev.device_uuid,
                                                'atualizado_em', now()),
                        true)
   where id = v_asset;

  update public.agent_devices
     set it_asset_id = v_asset, match_method = v_metodo, divergences = v_div
   where id = p_device_id;

  return v_asset;
end;
$$;

revoke all on function app.agent_reconcile(uuid) from public;

commit;
