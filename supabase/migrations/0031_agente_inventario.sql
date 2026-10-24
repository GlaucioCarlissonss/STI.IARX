-- =============================================================================
-- 0031 — O agente nas máquinas, parte 1: inventário
-- =============================================================================
-- Onda 2 do plano de paridade (docs/12 §3). É a maior lacuna do produto: o
-- inventário existe desde a migração 0007 e **é digitado à mão**. Esta migração
-- é a metade no banco do agente que passa a preenchê-lo sozinho.
--
-- O QUE ESTA MIGRAÇÃO NÃO FAZ, DE PROPÓSITO
-- -----------------------------------------
-- Não cria `agent_metrics_raw`, `agent_metrics_hourly` nem `agent_alerts`. Elas
-- são a Onda 3 (desempenho e alertas), e criar tabela vazia uma onda antes não
-- adianta nada: a forma certa de uma série temporal depende de como o gráfico vai
-- lê-la, e isso só se sabe construindo o gráfico. Tabela criada "para já deixar
-- pronta" vira tabela migrada duas vezes.
--
-- AS QUATRO DECISÕES QUE IMPORTAM
-- -------------------------------
-- **1. O agente nunca carrega a `service_role`.** Ele se inscreve uma vez com um
-- token do tenant e recebe um token **próprio, daquela máquina**. Notebook
-- roubado se revoga sozinho, sem tocar nos outros 199. E as duas funções de
-- ingestão abaixo são `security definer` concedidas a `anon` — pelo mesmo
-- raciocínio da pesquisa de satisfação na 0029: a função é a única porta, só
-- aceita o token, e não devolve dado de mais ninguém. Dar a chave mestra a um
-- serviço que roda em 200 computadores de cliente seria desproporcional, e é por
-- isso que **esta migração NÃO acrescenta um quarto uso ao ADR-011**.
--
-- **2. Conciliar, nunca duplicar.** `serial_number` → UUID da máquina →
-- `hostname`, nessa ordem, e cada passo com uma razão (ver §6). Duplicata em
-- inventário não é um incômodo: é o fim da confiança no módulo. Quem abre a tela
-- e vê a própria máquina duas vezes não volta.
--
-- **3. O agente preenche o que está em branco; ele não discute com gente.** Se
-- alguém digitou o número de série e o agente leu outro, o agente **não
-- sobrescreve** — ele registra a divergência em `agent_devices.divergences`, e a
-- tela mostra. Sobrescrever apaga a correção que uma pessoa fez de propósito;
-- ignorar em silêncio deixa o erro para sempre. Mostrar é a única das três que
-- não perde informação.
--
-- **4. Inventário igual não vira linha nova.** O agente manda o inventário todo
-- dia; o conteúdo muda poucas vezes por ano. A ingestão compara o hash do
-- conteúdo (sem o carimbo de hora, senão nada seria igual) e, se não mudou, só
-- registra o contato. Sem isso, 200 máquinas × 365 dias = 73 mil snapshots
-- idênticos por ano, e a pergunta "o que mudou nesta máquina?" — que é o motivo
-- de a tabela existir — fica impossível de responder.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Colunas de contato mecânico ficam fora da auditoria
-- -----------------------------------------------------------------------------
-- `last_seen_at` muda a cada contato do agente: 200 máquinas a cada 10 minutos
-- são 28.800 atualizações por dia. Auditada, cada uma vira uma linha em
-- `audit_log` dizendo "o relógio andou" — e a trilha de auditoria, que existe
-- para responder "quem mexeu nisto?", passa a ter 99,9% de ruído.
--
-- São da mesma natureza de `updated_at`, que já estava na lista: carimbo de
-- contato mecânico, não fato de negócio. O que o agente faz de relevante —
-- inscrever, revogar, trocar de versão, conciliar com outro ativo — continua
-- auditado, porque são colunas diferentes.
create or replace function app.audit_ignored_columns()
returns text[]
language sql
immutable
as $$
  select array[
    'updated_at','created_at','search_vector',
    -- Acrescentadas na 0031. Ver o comentário acima: contato, não fato.
    'last_seen_at','last_snapshot_hash','last_snapshot_at'
  ];
$$;

comment on function app.audit_ignored_columns() is
  'Colunas que não geram linha de auditoria: carimbos de contato mecânico, não fatos de negócio.';

-- -----------------------------------------------------------------------------
-- 2. agent_enrollments — como uma máquina entra na frota
-- -----------------------------------------------------------------------------
-- O token de inscrição é do TENANT, não da máquina. Ele é digitado uma vez no
-- instalador (ou passado pela GPO) e serve para a máquina trocar de credencial:
-- entrega o token do tenant, recebe o token dela própria.
--
-- Isso é deliberadamente de uso limitado e revogável. Se o token vazar, o estrago
-- possível é alguém inscrever máquinas falsas no tenant — barulhento, visível na
-- tela de frota, e cortado por `max_uses`, `expires_at` ou `revoked_at`. Compare
-- com o desenho ingênuo (uma credencial fixa no instalador, igual para todos):
-- lá o vazamento dá acesso de escrita permanente e indistinguível.
create table public.agent_enrollments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  name         text not null check (length(trim(name)) between 1 and 120),

  -- SHA-256. O valor em claro aparece uma única vez, na criação — mesmo contrato
  -- de `dashboard_tokens` (ADR-006).
  token_hash   text not null unique,

  /* Filial padrão das máquinas inscritas por este token. É o jeito de o técnico
     que instala na filial de Londrina não ter de classificar nada depois: o token
     carrega o lugar. Nulo = sem filial, a ser classificada na tela. */
  branch_id    uuid,

  /* Nulo = sem limite. Posto, é o teto de máquinas que este token inscreve. Um
     token para um lote de 30 notebooks deve morrer na trigésima. */
  max_uses     integer check (max_uses is null or max_uses > 0),
  uses_count   integer not null default 0 check (uses_count >= 0),

  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint fk_ae_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete set null,
  constraint uq_ae_id_tenant unique (id, tenant_id)
);

create index idx_agent_enrollments_tenant on public.agent_enrollments (tenant_id)
  where revoked_at is null;

comment on table public.agent_enrollments is
  'Token de inscrição do tenant. A máquina troca este token pelo dela na primeira execução.';

-- -----------------------------------------------------------------------------
-- 3. agent_devices — uma linha por máquina
-- -----------------------------------------------------------------------------
-- `device_uuid` é gerado pelo agente na primeira execução e gravado em disco. É a
-- identidade que não muda: hostname muda quando o helpdesk renomeia a máquina, e
-- número de série vem vazio ou com texto de fábrica em placa branca e em máquina
-- virtual. O UUID é a única coisa estável, e é por isso que ele é a chave.
create table public.agent_devices (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,

  device_uuid     uuid not null,
  token_hash      text not null unique,

  hostname        text,
  os              text,               -- 'windows' | 'linux' | 'darwin'
  os_version      text,
  chassis         text,               -- 'notebook' | 'desktop' | 'server' | 'vm'
  agent_version   text,

  /* O ativo conciliado. Nulo significa "ainda não conciliado", o que só acontece
     entre a inscrição e o primeiro inventário — a conciliação precisa do
     conteúdo, não só do cadastro. */
  it_asset_id     uuid,

  /* COMO foi conciliado. Está aqui porque a tela precisa mostrar: um ativo casado
     por hostname merece um olhar humano, um casado por número de série não. */
  match_method    text check (match_method in ('serial','device_uuid','hostname','created')),

  /* O que o agente leu e o cadastro diz diferente. O agente não sobrescreve o que
     uma pessoa digitou (decisão 3 do cabeçalho) — ele deixa aqui, e a tela
     mostra. Forma: {"serial_number": {"cadastrado": "...", "agente": "..."}} */
  divergences     jsonb not null default '{}'::jsonb,

  branch_id       uuid,

  /* O hash do último inventário aceito. É o que faz inventário igual não virar
     linha nova — ver a decisão 4 do cabeçalho. */
  last_snapshot_hash text,
  last_snapshot_at   timestamptz,
  last_seen_at       timestamptz,

  revoked_at      timestamptz,
  enrollment_id   uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint uq_agent_device_uuid unique (tenant_id, device_uuid),
  constraint uq_ad_id_tenant unique (id, tenant_id),
  constraint fk_ad_asset foreign key (it_asset_id, tenant_id)
    references public.it_assets (id, tenant_id) on delete set null,
  constraint fk_ad_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete set null,
  constraint fk_ad_enrollment foreign key (enrollment_id, tenant_id)
    references public.agent_enrollments (id, tenant_id) on delete set null
);

-- Um ativo tem no máximo um agente. Dois agentes no mesmo ativo significa
-- conciliação errada, e é melhor que o banco recuse do que a tela some com um dos
-- dois sem explicar.
create unique index uq_agent_device_asset
  on public.agent_devices (tenant_id, it_asset_id)
  where it_asset_id is not null and revoked_at is null;

-- O índice da tela de frota: quem está mudo, por filial.
create index idx_agent_devices_contato
  on public.agent_devices (tenant_id, last_seen_at desc nulls last)
  where revoked_at is null;

comment on table public.agent_devices is
  'Uma linha por máquina com agente. O device_uuid é a identidade estável; o token é só desta máquina.';

-- -----------------------------------------------------------------------------
-- 4. agent_inventory_snapshots — o histórico que responde "o que mudou?"
-- -----------------------------------------------------------------------------
-- Inventário completo em `jsonb`, uma linha por MUDANÇA (não por coleta). A
-- comparação entre duas linhas consecutivas é a resposta para "sumiu memória
-- desta máquina?", que é a pergunta que paga o módulo: pente de RAM que some
-- entre uma coleta e outra ou é defeito ou é furto, e nos dois casos alguém
-- precisa saber hoje, não no inventário anual.
create table public.agent_inventory_snapshots (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  device_id     uuid not null,

  /* O conteúdo, sem carimbo de hora dentro: o hash é calculado sobre ele, e
     qualquer campo volátil aqui faria todo inventário parecer diferente. */
  payload       jsonb not null,
  payload_hash  text not null,

  collected_at  timestamptz not null,
  created_at    timestamptz not null default now(),

  constraint fk_ais_device foreign key (device_id, tenant_id)
    references public.agent_devices (id, tenant_id) on delete cascade
);

create index idx_snapshots_device
  on public.agent_inventory_snapshots (tenant_id, device_id, collected_at desc);

comment on table public.agent_inventory_snapshots is
  'Inventário completo por mudança, não por coleta. Duas linhas consecutivas respondem "o que mudou nesta máquina?".';

-- -----------------------------------------------------------------------------
-- 5. agent_software — o que está instalado
-- -----------------------------------------------------------------------------
-- Normalizado, e não só dentro do `jsonb` do snapshot, porque a pergunta é
-- sempre atravessada: "quem ainda tem Windows 10?", "em quantas máquinas tem
-- AutoCAD?" — e essa pergunta num campo jsonb por máquina é uma varredura da
-- frota inteira.
--
-- **Software desinstalado não é apagado.** Ele fica com o `last_seen_at` parado,
-- e é assim que se responde "quem desinstalou o antivírus?" — que é uma pergunta
-- de segurança, não de inventário. Apagar a linha apagaria junto a resposta.
create table public.agent_software (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  device_id     uuid not null,

  name          text not null check (length(trim(name)) between 1 and 300),
  version       text not null default '',
  publisher     text,
  installed_on  date,

  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),

  constraint fk_asw_device foreign key (device_id, tenant_id)
    references public.agent_devices (id, tenant_id) on delete cascade,
  -- `version` tem default '' e não é nula justamente para entrar na chave: em
  -- Postgres, `unique` não recusa duas linhas com nulo, e metade dos programas
  -- do Windows não declara versão.
  constraint uq_software_device unique (device_id, name, version)
);

create index idx_software_nome on public.agent_software (tenant_id, lower(name));

comment on table public.agent_software is
  'Software instalado por máquina. Desinstalado não é apagado: fica com last_seen_at parado.';

-- -----------------------------------------------------------------------------
-- 6. A conciliação — a função que não pode errar
-- -----------------------------------------------------------------------------
-- Número de série de fábrica é um campo que mente. Placa-mãe de montagem branca,
-- máquina virtual e lote de OEM vêm com texto de preenchimento no lugar do
-- serial: "To Be Filled By O.E.M.", "Default string", "System Serial Number".
--
-- Casar por esse valor é o pior defeito possível neste módulo: as 80 máquinas
-- montadas do mesmo lote casariam **todas no mesmo ativo**, e o inventário
-- mostraria 1 computador onde há 80. Por isso o serial passa por este filtro
-- antes de ser usado como chave, e não depois.
create or replace function app.agent_serial_utilizavel(p_serial text)
returns boolean
language sql
immutable
as $$
  select p_serial is not null
     and length(trim(p_serial)) >= 4
     and lower(trim(p_serial)) <> all (array[
           'to be filled by o.e.m.', 'to be filled by oem',
           'system serial number', 'default string', 'not specified',
           'not applicable', 'not available', 'none', 'null', 'n/a', 'na',
           'unknown', 'invalid', 'empty', 'no asset tag',
           '0123456789', 'xxxxxxx', 'serial', 'chassis serial number'
         ])
     -- Um único caractere repetido ("0000000", "-------") é a outra forma do
     -- mesmo problema: não identifica nada e casaria o lote inteiro.
     and length(trim(both substr(trim(p_serial), 1, 1) from trim(p_serial))) > 0;
$$;

comment on function app.agent_serial_utilizavel(text) is
  'Falso para os textos de fábrica que vêm no lugar do número de série. Casar por eles juntaria o lote inteiro num ativo só.';

/*
 * Liga a máquina ao ativo, ou cria o ativo.
 *
 * A ORDEM DAS TENTATIVAS, E O PORQUÊ DE CADA UMA
 * ----------------------------------------------
 * 1. **Número de série.** É o único identificador que o fabricante gravou e que
 *    atravessa reinstalação de sistema. Quando é utilizável, é definitivo.
 *
 * 2. **UUID da máquina já gravado no ativo.** Cobre o caso de alguém ter editado
 *    o serial no cadastro depois da primeira conciliação: a máquina é a mesma, o
 *    vínculo já foi estabelecido uma vez, e desfazê-lo criaria a duplicata.
 *
 * 3. **Hostname** — e **só contra ativo que não tem número de série nenhum**.
 *    Esta restrição é o ponto delicado: se o ativo TEM serial e o serial não
 *    casou no passo 1, então não são a mesma máquina, por mais que o nome
 *    bata. Nome de máquina se repete entre equipamentos trocados ("NOTE-FISCAL"
 *    é o notebook do setor, não aquele notebook), e sem esta restrição o
 *    inventário casaria o substituto com o substituído e perderia os dois.
 *
 * 4. **Cria.** Que é o ponto do agente: o inventário deixa de ser digitado.
 */
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

  select payload into v_payload
    from public.agent_inventory_snapshots
   where device_id = p_device_id
   order by collected_at desc
   limit 1;

  v_serial := nullif(trim(coalesce(v_payload -> 'sistema' ->> 'numero_serie', '')), '');
  v_brand  := nullif(trim(coalesce(v_payload -> 'sistema' ->> 'fabricante', '')), '');
  v_model  := nullif(trim(coalesce(v_payload -> 'sistema' ->> 'modelo', '')), '');

  -- Vínculo já estabelecido e ativo ainda vivo: está resolvido. Reconciliar de
  -- novo todo dia só daria chance de mudar de ideia com dado pior.
  if v_dev.it_asset_id is not null then
    select * into v_atual from public.it_assets
     where id = v_dev.it_asset_id and deleted_at is null;
    if found then
      v_asset  := v_atual.id;
      v_metodo := v_dev.match_method;
    end if;
  end if;

  -- 1. Número de série, se for um número de série de verdade.
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

  -- 2. UUID da máquina já gravado no ativo por uma conciliação anterior.
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

  -- 3. Hostname, e só contra ativo sem serial nenhum. Ver o comentário acima.
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

  -- 4. Cria. O tipo vem do chassi que o agente leu; `other` quando ele não soube,
  -- porque chutar 'desktop' num servidor de produção é pior que não classificar.
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
      v_dev.tenant_id,
      v_tipo,
      v_brand,
      v_model,
      case when app.agent_serial_utilizavel(v_serial) then trim(v_serial) end,
      -- `active` e não `in_stock`: a máquina está ligada e mandando inventário,
      -- então ela está em uso por definição. Nascer em estoque obrigaria alguém a
      -- mover 200 ativos à mão, que é exatamente o trabalho que o agente veio
      -- eliminar.
      'active',
      v_dev.branch_id,
      jsonb_build_object('agente', jsonb_build_object(
        'device_uuid', v_dev.device_uuid,
        'criado_pelo_agente', true
      )),
      'Cadastrado automaticamente pelo agente de inventário.'
    )
    returning id into v_asset;
    v_metodo := 'created';
  end if;

  select * into v_atual from public.it_assets where id = v_asset;

  /*
   * O agente preenche o que está em branco; ele não discute com gente.
   *
   * `coalesce` em cada campo: onde o cadastro tem valor, o valor do cadastro
   * fica. Onde está vazio, entra o que o agente leu. A divergência — cadastro
   * preenchido E diferente — não some: vai para `divergences` e aparece na tela.
   *
   * O `specs -> 'agente'` é território do agente e é sobrescrito inteiro: ali
   * ninguém digita.
   */
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
                        coalesce(specs, '{}'::jsonb),
                        '{agente}',
                        coalesce(v_payload, '{}'::jsonb)
                          || jsonb_build_object(
                               'device_uuid', v_dev.device_uuid,
                               'atualizado_em', now()),
                        true)
   where id = v_asset;

  update public.agent_devices
     set it_asset_id = v_asset,
         match_method = v_metodo,
         divergences = v_div
   where id = p_device_id;

  return v_asset;
end;
$$;

revoke all on function app.agent_reconcile(uuid) from public;

comment on function app.agent_reconcile(uuid) is
  'Liga a máquina ao ativo: serial → device_uuid → hostname → cria. Nunca duplica, nunca sobrescreve o que uma pessoa digitou.';

-- -----------------------------------------------------------------------------
-- 7. Inscrição — a máquina troca o token do tenant pelo dela
-- -----------------------------------------------------------------------------
-- `security definer` concedida a `anon`, pelo mesmo raciocínio de
-- `submit_satisfaction` na 0029: quem chama ainda não tem conta (e nunca vai ter
-- — é um serviço, não uma pessoa), a função é a única porta, ela só aceita o
-- token, e não devolve nada de mais ninguém.
--
-- **Reinstalar o agente na mesma máquina não cria uma segunda linha.** O
-- `device_uuid` vem gravado em disco e sobrevive à reinstalação do agente; quando
-- ele já existe, o token é rotacionado e a inscrição **não consome mais uma vaga
-- do `max_uses`**. Sem isso, um técnico reinstalando o agente em 30 máquinas
-- gastaria o token de 30 vagas pela segunda vez e o trigésimo primeiro
-- computador seria recusado sem motivo visível.
create or replace function public.agent_enroll(
  p_enrollment_token text,
  p_device           jsonb
)
returns table (device_id uuid, device_token text, tenant_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash   text := encode(digest(p_enrollment_token, 'sha256'), 'hex');
  v_enr    public.agent_enrollments;
  v_uuid   uuid;
  v_token  text;
  v_dev    public.agent_devices;
begin
  select * into v_enr from public.agent_enrollments
   where token_hash = v_hash
     and revoked_at is null
     and (expires_at is null or expires_at > now());
  if not found then
    return;  -- zero linhas. Quem chamou responde 401 sem saber mais que isso.
  end if;

  v_uuid := nullif(p_device ->> 'device_uuid', '')::uuid;
  if v_uuid is null then
    return;
  end if;

  select * into v_dev from public.agent_devices
   where agent_devices.tenant_id = v_enr.tenant_id and device_uuid = v_uuid;

  -- Máquina revogada não volta sozinha. Se ela voltasse, revogar não serviria de
  -- nada: bastaria reinstalar o agente para desfazer a decisão de quem revogou.
  if found and v_dev.revoked_at is not null then
    return;
  end if;

  if not found and v_enr.max_uses is not null and v_enr.uses_count >= v_enr.max_uses then
    return;
  end if;

  v_token := 'ag_' || encode(gen_random_bytes(32), 'hex');

  if found then
    update public.agent_devices set
        token_hash    = encode(digest(v_token, 'sha256'), 'hex'),
        hostname      = coalesce(nullif(p_device ->> 'hostname', ''), hostname),
        os            = coalesce(nullif(p_device ->> 'os', ''), os),
        os_version    = coalesce(nullif(p_device ->> 'os_version', ''), os_version),
        chassis       = coalesce(nullif(p_device ->> 'chassis', ''), chassis),
        agent_version = coalesce(nullif(p_device ->> 'agent_version', ''), agent_version),
        last_seen_at  = now()
     where id = v_dev.id
    returning * into v_dev;
  else
    insert into public.agent_devices (
      tenant_id, device_uuid, token_hash, hostname, os, os_version, chassis,
      agent_version, branch_id, enrollment_id, last_seen_at
    ) values (
      v_enr.tenant_id, v_uuid, encode(digest(v_token, 'sha256'), 'hex'),
      nullif(p_device ->> 'hostname', ''),
      nullif(p_device ->> 'os', ''),
      nullif(p_device ->> 'os_version', ''),
      nullif(p_device ->> 'chassis', ''),
      nullif(p_device ->> 'agent_version', ''),
      v_enr.branch_id, v_enr.id, now()
    )
    returning * into v_dev;

    update public.agent_enrollments
       set uses_count = uses_count + 1
     where id = v_enr.id;
  end if;

  return query select v_dev.id, v_token, v_dev.tenant_id;
end;
$$;

revoke all on function public.agent_enroll(text, jsonb) from public;
grant execute on function public.agent_enroll(text, jsonb) to anon, authenticated;

comment on function public.agent_enroll(text, jsonb) is
  'Troca o token do tenant pelo token da máquina. Reinscrição da mesma máquina rotaciona o token sem consumir vaga.';

-- -----------------------------------------------------------------------------
-- 8. Ingestão de inventário
-- -----------------------------------------------------------------------------
-- O hash é calculado sobre `p_payload` — que é só o conteúdo. O carimbo de hora
-- da coleta chega **separado**, em `p_collected_at`, e de propósito: um campo
-- volátil dentro do objeto hasheado faria todo inventário parecer diferente de
-- todo inventário, e a tabela de histórico voltaria a crescer 200 linhas por dia
-- com conteúdo idêntico — que é exatamente o que ela existe para evitar.
create or replace function public.agent_ingest_inventory(
  p_device_token text,
  p_payload      jsonb,
  p_collected_at timestamptz default now()
)
returns table (status text, asset_id uuid, snapshot_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash     text := encode(digest(p_device_token, 'sha256'), 'hex');
  v_dev      public.agent_devices;
  v_conteudo text := encode(digest(p_payload::text, 'sha256'), 'hex');
  v_snap     uuid;
  v_asset    uuid;
  v_item     jsonb;
begin
  select * into v_dev from public.agent_devices
   where token_hash = v_hash and revoked_at is null;
  if not found then
    return query select 'unauthorized'::text, null::uuid, null::uuid;
    return;
  end if;

  -- O contato é registrado SEMPRE, inclusive quando o inventário não mudou: é
  -- assim que a tela sabe distinguir "máquina parada" de "máquina igual".
  update public.agent_devices set
      last_seen_at  = now(),
      hostname      = coalesce(nullif(p_payload -> 'sistema' ->> 'hostname', ''), hostname),
      os            = coalesce(nullif(p_payload -> 'sistema' ->> 'os', ''), os),
      os_version    = coalesce(nullif(p_payload -> 'sistema' ->> 'os_version', ''), os_version),
      chassis       = coalesce(nullif(p_payload -> 'sistema' ->> 'chassi', ''), chassis),
      agent_version = coalesce(nullif(p_payload -> 'agente' ->> 'versao', ''), agent_version)
   where id = v_dev.id;

  if v_dev.last_snapshot_hash = v_conteudo then
    return query select 'unchanged'::text, v_dev.it_asset_id, null::uuid;
    return;
  end if;

  insert into public.agent_inventory_snapshots (
    tenant_id, device_id, payload, payload_hash, collected_at
  ) values (
    v_dev.tenant_id, v_dev.id, p_payload, v_conteudo, p_collected_at
  )
  returning id into v_snap;

  update public.agent_devices
     set last_snapshot_hash = v_conteudo,
         last_snapshot_at   = p_collected_at
   where id = v_dev.id;

  /*
   * Software: `insert ... on conflict do update` do que veio, e nada é apagado.
   * O que foi desinstalado fica com o `last_seen_at` parado — ver o comentário da
   * tabela. `coalesce(version, '')` porque metade dos programas do Windows não
   * declara versão e nulo não entra em chave única.
   */
  for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'software', '[]'::jsonb))
  loop
    continue when nullif(trim(coalesce(v_item ->> 'nome', '')), '') is null;
    insert into public.agent_software (
      tenant_id, device_id, name, version, publisher, installed_on, last_seen_at
    ) values (
      v_dev.tenant_id, v_dev.id,
      left(trim(v_item ->> 'nome'), 300),
      coalesce(nullif(trim(v_item ->> 'versao'), ''), ''),
      nullif(trim(coalesce(v_item ->> 'fabricante', '')), ''),
      (nullif(v_item ->> 'instalado_em', ''))::date,
      now()
    )
    on conflict (device_id, name, version) do update
      set last_seen_at = now(),
          publisher    = coalesce(excluded.publisher, agent_software.publisher);
  end loop;

  v_asset := app.agent_reconcile(v_dev.id);

  return query select 'stored'::text, v_asset, v_snap;
end;
$$;

revoke all on function public.agent_ingest_inventory(text, jsonb, timestamptz) from public;
grant execute on function public.agent_ingest_inventory(text, jsonb, timestamptz) to anon, authenticated;

comment on function public.agent_ingest_inventory(text, jsonb, timestamptz) is
  'Recebe o inventário de uma máquina. Inventário idêntico só registra o contato; mudado vira snapshot e concilia.';

-- -----------------------------------------------------------------------------
-- 8.1 Batimento — o sinal de vida, separado do inventário
-- -----------------------------------------------------------------------------
-- A tela precisa saber que a máquina está viva com granularidade de minutos; o
-- inventário muda poucas vezes por ano. Se o sinal de vida fosse "reenviar o
-- inventário", a conta seria: 200 máquinas × 144 envios por dia × ~500 KB de
-- lista de software = **14 GB por dia**, para transportar um dado que não mudou.
--
-- Esta função é o mesmo sinal custando algumas centenas de bytes. É por isso que
-- ela existe separada, e não como um parâmetro da ingestão.
create or replace function public.agent_heartbeat(
  p_device_token text,
  p_agent_version text default null
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
     set last_seen_at  = now(),
         agent_version = coalesce(nullif(trim(coalesce(p_agent_version, '')), ''), agent_version)
   where token_hash = v_hash and revoked_at is null
  returning id into v_id;

  return v_id is not null;
end;
$$;

revoke all on function public.agent_heartbeat(text, text) from public;
grant execute on function public.agent_heartbeat(text, text) to anon, authenticated;

comment on function public.agent_heartbeat(text, text) is
  'Sinal de vida da máquina. Separado da ingestão porque reenviar o inventário só para dizer "estou viva" custaria gigabytes por dia.';

-- -----------------------------------------------------------------------------
-- 9. RLS
-- -----------------------------------------------------------------------------
select app.harden_table('public.agent_enrollments');
select app.harden_table('public.agent_devices');
select app.harden_table('public.agent_inventory_snapshots');
select app.harden_table('public.agent_software');

select app.attach_audit('public.agent_enrollments');
-- `agent_devices` É auditada: a §1 desta migração tirou os carimbos de contato da
-- trilha justamente para que isto fosse possível. Revogar, conciliar com outro
-- ativo e trocar de versão ficam registrados; o batimento de dez em dez minutos
-- não.
select app.attach_audit('public.agent_devices');

-- O token de inscrição é credencial: só quem administra o tenant mexe.
create policy agent_enrollments_rw on public.agent_enrollments
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_config())
  with check (tenant_id = app.current_tenant_id() and app.can_manage_config());

-- Ver a frota acompanha ver o inventário: é a mesma tela, do outro lado.
create policy agent_devices_select on public.agent_devices
  for select to authenticated
  using (
    tenant_id = app.current_tenant_id()
    and app.has_permission('inventario.agentes.ver')
    and (branch_id is null or app.can_see_branch(branch_id))
  );

-- Revogar e reclassificar filial são escrita, e pedem a permissão de gerência.
-- `insert` não existe de propósito: máquina entra na frota pela inscrição, e mais
-- de lugar nenhum. Linha de máquina criada à mão seria uma máquina sem token, que
-- nunca manda inventário e fica muda para sempre na tela.
create policy agent_devices_update on public.agent_devices
  for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('inventario.agentes.gerenciar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('inventario.agentes.gerenciar'));

create policy agent_snapshots_select on public.agent_inventory_snapshots
  for select to authenticated
  using (
    tenant_id = app.current_tenant_id()
    and app.has_permission('inventario.agentes.ver')
  );

create policy agent_software_select on public.agent_software
  for select to authenticated
  using (
    tenant_id = app.current_tenant_id()
    and app.has_permission('inventario.agentes.ver')
  );

grant select, insert, update, delete on public.agent_enrollments to authenticated;
grant select, update on public.agent_devices to authenticated;
grant select on public.agent_inventory_snapshots to authenticated;
grant select on public.agent_software to authenticated;

-- -----------------------------------------------------------------------------
-- 10. A visão da frota
-- -----------------------------------------------------------------------------
-- Carrega `branch_id` pela lição da entrega 6: indicador sem a coluna do escopo
-- conta o tenant inteiro enquanto a lista ao lado mostra uma filial só, e os dois
-- números discordando na mesma tela é o tipo de defeito que ninguém reporta e
-- todo mundo nota.
--
-- `silencioso` é calculado aqui e não na aplicação porque a tela de frota, o
-- indicador do painel e (na Onda 3) o alerta precisam concordar sobre o que é
-- estar mudo. Três lugares calculando o mesmo limiar é três lugares para ele
-- divergir.
create or replace view public.vw_agent_fleet
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
  d.last_seen_at,
  d.last_snapshot_at,
  a.asset_tag,
  a.serial_number,
  a.brand,
  a.model,
  b.name              as branch_name,
  -- Mudo há mais de 24 horas. O agente fala de 10 em 10 minutos, então 24 horas
  -- não é um atraso de rede: é máquina desligada, desinstalada ou com defeito.
  (d.last_seen_at is null or d.last_seen_at < now() - interval '24 hours') as silencioso,
  d.divergences <> '{}'::jsonb as tem_divergencia,
  (select count(*) from public.agent_software s where s.device_id = d.id) as software_count
from public.agent_devices d
left join public.it_assets a on a.id = d.it_asset_id and a.deleted_at is null
left join public.branches  b on b.id = d.branch_id
where d.revoked_at is null;

grant select on public.vw_agent_fleet to authenticated;

comment on view public.vw_agent_fleet is
  'A frota com agente, já conciliada. O limiar de "silencioso" mora aqui para tela, painel e alerta concordarem.';

-- -----------------------------------------------------------------------------
-- 11. Catálogo de permissões
-- -----------------------------------------------------------------------------
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('inventario.agentes', 'inventario', 'agentes', null,
   'Agentes nas máquinas', 'visualizador', 425),
  ('inventario.agentes.ver', 'inventario', 'agentes', 'ver',
   'Consultar a frota com agente', 'visualizador', 426),
  ('inventario.agentes.gerenciar', 'inventario', 'agentes', 'gerenciar',
   'Inscrever e revogar máquinas', 'gestor', 427)
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

commit;
