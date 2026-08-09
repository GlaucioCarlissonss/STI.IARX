-- =============================================================================
-- 0013 — Lacunas funcionais: áreas, anexos, custódia, links de internet
-- =============================================================================
-- Camada de dados dos módulos especificados em docs/06-lacunas-e-roadmap.md.
-- Cobre o que é inequívoco; o que depende de decisão do operador está listado
-- como lacuna global naquele documento e NÃO foi antecipado aqui.
-- =============================================================================

-- =============================================================================
-- MÓDULO 2 — Áreas por filial
-- =============================================================================
-- Tabela, e não campo texto: texto livre fragmenta o dado ("Enfermagem",
-- "enfermagem", "Enferm.") e destrói justamente o agrupamento por área que é o
-- objetivo do módulo — mesmo raciocínio de ticket_priorities (antipattern A-10).
create table public.branch_areas (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  branch_id  uuid not null,
  name       text not null check (length(btrim(name)) > 0),
  code       text,
  -- A natureza da área carrega peso operacional: em Home Care, parada na
  -- Enfermagem tem impacto assistencial que a Administração não tem.
  kind       text not null default 'administrativa'
               check (kind in ('assistencial','administrativa','apoio','tecnica')),
  is_active  boolean not null default true,
  sort_order smallint not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_area_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete cascade,
  constraint uq_area_id_tenant unique (id, tenant_id)
);

create unique index uq_area_name on public.branch_areas (branch_id, lower(name));
create index idx_areas_branch on public.branch_areas (tenant_id, branch_id, sort_order)
  where is_active;

comment on table public.branch_areas is
  'Subdivisões da filial. Base do detalhamento por área em inventário, telefonia, links e mapas.';

-- Áreas iniciais de uma filial nova. Sem isso, cadastrar 40 filiais significa
-- digitar as mesmas áreas 40 vezes — e a divergência de nomes que esta tabela
-- existe para evitar volta pela porta da frente.
create or replace function app.fn_seed_branch_areas(p_branch_id uuid)
returns integer
language plpgsql
as $$
declare
  v_tenant uuid;
  v_count  integer;
begin
  select tenant_id into v_tenant from public.branches where id = p_branch_id;
  if v_tenant is null then
    raise exception 'Filial % não encontrada', p_branch_id using errcode = 'foreign_key_violation';
  end if;

  insert into public.branch_areas (tenant_id, branch_id, name, kind, sort_order)
  select v_tenant, p_branch_id, v.name, v.kind, v.ord
  from (values
    ('Recepção',      'assistencial',  10),
    ('Enfermagem',    'assistencial',  20),
    ('Administração', 'administrativa',30),
    ('Financeiro',    'administrativa',40),
    ('TI',            'tecnica',       50),
    ('Logística',     'apoio',         60),
    ('Diretoria',     'administrativa',70),
    ('Estoque de TI', 'apoio',         80)
  ) as v(name, kind, ord)
  -- Idempotente: rodar de novo não duplica nem falha.
  on conflict do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Coerência área × filial. A FK composta garante o TENANT, não a FILIAL —
-- sem esta validação, um ativo de São Paulo poderia apontar para a
-- "Enfermagem" de Manaus. O nome da coluna de área vem em TG_ARGV porque
-- telecom_lines a chama de company_area_id.
create or replace function app.validate_area_branch()
returns trigger
language plpgsql
as $$
declare
  v_area_col   text := tg_argv[0];
  v_row        jsonb := to_jsonb(new);
  v_area       uuid  := nullif(v_row ->> v_area_col, '')::uuid;
  v_branch     uuid  := nullif(v_row ->> 'branch_id', '')::uuid;
  v_area_branch uuid;
begin
  if v_area is null then
    return new;
  end if;

  if v_branch is null then
    raise exception 'Não é possível informar área sem filial'
      using errcode = 'check_violation';
  end if;

  select branch_id into v_area_branch from public.branch_areas where id = v_area;

  if v_area_branch is distinct from v_branch then
    raise exception 'A área informada pertence a outra filial'
      using errcode = 'check_violation',
            hint = 'Selecione uma área da filial do próprio registro.';
  end if;

  return new;
end;
$$;

-- Área em ativos. Nullable no banco de propósito: a obrigatoriedade vive na UI
-- até que os ativos já cadastrados recebam área (LG-02). SET NOT NULL agora
-- quebraria a base existente.
alter table public.it_assets
  add column branch_area_id uuid,
  add constraint fk_asset_area foreign key (branch_area_id, tenant_id)
    references public.branch_areas (id, tenant_id) on delete restrict;

create index idx_assets_area on public.it_assets (tenant_id, branch_area_id)
  where deleted_at is null and branch_area_id is not null;

create trigger trg_assets_area_branch
  before insert or update of branch_area_id, branch_id on public.it_assets
  for each row execute function app.validate_area_branch('branch_area_id');

-- =============================================================================
-- MÓDULO 9 — Área da empresa nas linhas telefônicas
-- =============================================================================
-- Nome do campo segue o escopo (`company_area_id`), apontando para a MESMA
-- tabela de áreas do módulo 2 — dois cadastros de área divergiriam.
alter table public.telecom_lines
  add column company_area_id uuid,
  add constraint fk_line_area foreign key (company_area_id, tenant_id)
    references public.branch_areas (id, tenant_id) on delete restrict;

create index idx_lines_area on public.telecom_lines (tenant_id, company_area_id)
  where deleted_at is null and company_area_id is not null;

create trigger trg_lines_area_branch
  before insert or update of company_area_id, branch_id on public.telecom_lines
  for each row execute function app.validate_area_branch('company_area_id');

-- =============================================================================
-- MÓDULO 7 — Vigência de contrato da linha
-- =============================================================================
-- `loyalty_until` (já existente) e `contract_end` são coisas distintas:
-- fidelidade limita cancelamento sem multa; vigência é o prazo contratual.
alter table public.telecom_lines
  add column contract_number text,
  add column contract_start  date,
  add column contract_end    date,
  add constraint line_contract_period
    check (contract_end is null or contract_start is null or contract_end >= contract_start);

create index idx_lines_contract_end on public.telecom_lines (tenant_id, contract_end)
  where contract_end is not null and deleted_at is null and status <> 'cancelled';

-- Sustenta os indicadores de governança do módulo 6.
create index idx_lines_no_user on public.telecom_lines (tenant_id, branch_id)
  where assigned_user_id is null and status = 'active' and deleted_at is null;
create index idx_lines_filters on public.telecom_lines (tenant_id, branch_id, carrier, status)
  where deleted_at is null;

-- =============================================================================
-- MÓDULOS 3, 7, 8 — Anexos
-- =============================================================================
-- Uma tabela POR ENTIDADE, e não uma tabela `attachments` polimórfica:
-- (entity_type, entity_id) não admite FK, então nada impediria apontar para um
-- ativo excluído, e a limpeza em cascata passaria a depender de código. O custo
-- é repetir a estrutura três vezes; o ganho é integridade referencial que não
-- depende da disciplina de quem escreve a query.

create table public.asset_attachments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  asset_id       uuid not null,
  category       text not null check (category in ('document','photo')),
  kind           text not null check (kind in (
                   'nfe','cte','receipt','contract','warranty',
                   'photo_front','photo_back','photo_tag','photo_serial','photo_other')),
  storage_path   text not null unique,
  file_name      text not null,
  mime_type      text not null,
  size_bytes     bigint check (size_bytes > 0),
  is_primary     boolean not null default false,
  thumbnail_path text,
  -- Número/chave da NF-e. Sem FK porque não existe módulo fiscal na plataforma;
  -- quando existir, vira referência de verdade.
  invoice_ref    text,
  uploaded_by    uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint fk_asset_attach foreign key (asset_id, tenant_id)
    references public.it_assets (id, tenant_id) on delete cascade,
  constraint photo_is_image check (category <> 'photo' or mime_type like 'image/%')
);

-- UMA foto principal por ativo, garantida por índice em vez de a aplicação
-- "lembrar" de desmarcar a anterior.
create unique index uq_asset_primary_photo on public.asset_attachments (asset_id)
  where is_primary and category = 'photo';
create index idx_asset_attachments on public.asset_attachments (asset_id, category, created_at desc);

create table public.telecom_line_attachments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  line_id        uuid not null,
  kind           text not null check (kind in (
                   'contract','amendment','loyalty_term','cancellation','invoice','other')),
  storage_path   text not null unique,
  file_name      text not null,
  mime_type      text not null,
  size_bytes     bigint check (size_bytes > 0),
  valid_until    date,
  uploaded_by    uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint fk_line_attach foreign key (line_id, tenant_id)
    references public.telecom_lines (id, tenant_id) on delete cascade
);

create index idx_line_attachments on public.telecom_line_attachments (line_id, kind, created_at desc);

-- =============================================================================
-- MÓDULO 4 — Custódia do equipamento
-- =============================================================================
-- NÃO criamos `asset_custody_history`: `asset_assignments` já registra o
-- lifecycle por trigger, e duas tabelas alimentadas pelo mesmo evento divergem —
-- qualquer relatório passaria a depender de saber qual das duas é a verdade.
-- Estendemos a existente e expomos uma VIEW com o nome pedido pelo escopo.
alter table public.asset_assignments
  add column previous_user_id   uuid,
  add column previous_branch_id uuid,
  add column previous_area_id   uuid,
  add column branch_area_id     uuid,
  add column reason text not null default 'outro'
    check (reason in ('realocacao','devolucao','substituicao','baixa',
                      'manutencao','aquisicao','perda','outro')),
  add column reason_note text,
  add constraint fk_aa_prev_user foreign key (previous_user_id, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,
  add constraint fk_aa_prev_branch foreign key (previous_branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete set null,
  add constraint fk_aa_area foreign key (branch_area_id, tenant_id)
    references public.branch_areas (id, tenant_id) on delete set null,
  add constraint fk_aa_prev_area foreign key (previous_area_id, tenant_id)
    references public.branch_areas (id, tenant_id) on delete set null;

-- Trigger reescrita: agora grava o estado ANTERIOR explicitamente e deriva o
-- motivo. O motivo informado pela UI chega por variável de sessão
-- (`app.custody_reason`), o que mantém a gravação no banco — escrita por
-- importação, integração ou SQL direto continua auditada (antipattern A-06).
create or replace function app.assets_after_update_history()
returns trigger
language plpgsql
as $$
declare
  v_reason text := coalesce(nullif(current_setting('app.custody_reason', true), ''), 'outro');
begin
  if v_reason not in ('realocacao','devolucao','substituicao','baixa',
                      'manutencao','aquisicao','perda','outro') then
    v_reason := 'outro';
  end if;

  -- Atribuir área a um ativo que ainda não tinha (NULL → valor) é CLASSIFICAÇÃO
  -- inicial, não movimentação: durante a migração dos ativos legados (LG-02)
  -- isso geraria um evento falso de realocação para cada ativo da base.
  if new.assigned_user_id is distinct from old.assigned_user_id
     or new.branch_id is distinct from old.branch_id
     or (old.branch_area_id is not null
         and new.branch_area_id is distinct from old.branch_area_id) then

    -- Fecha o vínculo anterior ainda aberto. `clock_timestamp()` e não `now()`:
    -- `started_at` também usa o relógio real, e `now()` (horário da transação)
    -- seria ANTERIOR ao início de um vínculo criado no mesmo commit, violando
    -- a constraint `aa_valid_period`.
    update public.asset_assignments
       set ended_at = clock_timestamp()
     where asset_id = new.id and ended_at is null
       and event_type in ('assignment','relocation');

    insert into public.asset_assignments (
      tenant_id, asset_id, event_type,
      user_id, branch_id, branch_area_id,
      previous_user_id, previous_branch_id, previous_area_id,
      reason, performed_by
    ) values (
      new.tenant_id, new.id,
      case when new.assigned_user_id is distinct from old.assigned_user_id
           then 'assignment' else 'relocation' end,
      new.assigned_user_id, new.branch_id, new.branch_area_id,
      old.assigned_user_id, old.branch_id, old.branch_area_id,
      case
        when v_reason <> 'outro' then v_reason
        when new.assigned_user_id is null and old.assigned_user_id is not null then 'devolucao'
        when new.branch_id is distinct from old.branch_id then 'realocacao'
        else 'outro'
      end,
      app.current_user_id()
    );
  end if;

  if new.status is distinct from old.status and new.status in ('maintenance','retired','lost') then
    insert into public.asset_assignments (
      tenant_id, asset_id, event_type, user_id, branch_id, branch_area_id,
      previous_user_id, previous_branch_id, previous_area_id, reason, performed_by
    ) values (
      new.tenant_id, new.id,
      case new.status when 'maintenance' then 'maintenance'
                      when 'retired'     then 'retirement'
                      else 'loss' end,
      new.assigned_user_id, new.branch_id, new.branch_area_id,
      old.assigned_user_id, old.branch_id, old.branch_area_id,
      case new.status when 'maintenance' then 'manutencao'
                      when 'retired'     then 'baixa'
                      else 'perda' end,
      app.current_user_id()
    );
  end if;

  return null;
end;
$$;

-- `now()` devolve o horário da TRANSAÇÃO: duas mudanças de custódia no mesmo
-- commit receberiam timestamp idêntico e a timeline ficaria sem ordem definida.
-- `clock_timestamp()` avança dentro da transação e mantém a cronologia real.
alter table public.asset_assignments
  alter column started_at set default clock_timestamp();

-- Ativo em uso sem responsável: índice parcial sustenta o contador de
-- governança sem varrer a tabela.
create index idx_assets_no_owner on public.it_assets (tenant_id, branch_id)
  where assigned_user_id is null and deleted_at is null and status = 'active';

-- =============================================================================
-- MÓDULO 5 — Anexos de ticket: classificação e cota
-- =============================================================================
alter table public.ticket_attachments
  add column kind text not null default 'document'
    check (kind in ('image','audio','video','document')),
  add column thumbnail_path   text,
  add column duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  add column width  integer check (width  is null or width  > 0),
  add column height integer check (height is null or height > 0),
  -- 'skipped' enquanto não houver decisão sobre antivírus (LG-03). A coluna
  -- existe desde já para não exigir migração depois.
  add column scan_status text not null default 'skipped'
    check (scan_status in ('pending','clean','infected','skipped'));

create index idx_ticket_attachments_kind on public.ticket_attachments (ticket_id, kind);

alter table public.tenants
  add column attachment_quota_mb integer not null default 500
    check (attachment_quota_mb between 1 and 100000);

-- `kind` derivado do MIME real: extensão informada pelo cliente não é fonte
-- de verdade.
create or replace function app.derive_attachment_kind()
returns trigger
language plpgsql
as $$
begin
  new.kind := case
    when new.mime_type like 'image/%' then 'image'
    when new.mime_type like 'audio/%' then 'audio'
    when new.mime_type like 'video/%' then 'video'
    else 'document'
  end;
  return new;
end;
$$;

create trigger trg_attachment_kind
  before insert or update of mime_type on public.ticket_attachments
  for each row execute function app.derive_attachment_kind();

create or replace function app.fn_ticket_attachment_usage(p_ticket_id uuid)
returns bigint
language sql
stable
as $$
  select coalesce(sum(size_bytes), 0)::bigint
  from public.ticket_attachments
  where ticket_id = p_ticket_id;
$$;

-- Cota validada NO BANCO: dois uploads simultâneos furariam um limite
-- verificado apenas na aplicação.
create or replace function app.enforce_ticket_attachment_quota()
returns trigger
language plpgsql
as $$
declare
  v_quota_mb integer;
  v_used     bigint;
begin
  select attachment_quota_mb into v_quota_mb from public.tenants where id = new.tenant_id;
  v_used := app.fn_ticket_attachment_usage(new.ticket_id);

  if v_used + coalesce(new.size_bytes, 0) > v_quota_mb::bigint * 1024 * 1024 then
    raise exception
      'Cota de anexos do ticket excedida (limite % MB, em uso % MB)',
      v_quota_mb, round(v_used / 1048576.0, 1)
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger trg_attachment_quota
  before insert on public.ticket_attachments
  for each row execute function app.enforce_ticket_attachment_quota();

-- =============================================================================
-- MÓDULO 8 — Links de internet
-- =============================================================================
create table public.internet_links (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  branch_id       uuid not null,
  branch_area_id  uuid,

  contract_number text,
  -- Operadora vem de `suppliers` quando cadastrada; `carrier_name` é o escape
  -- para não travar o registro de um link urgente por falta de cadastro.
  supplier_id     uuid,
  carrier_name    text,

  technology      text not null check (technology in (
                    'fiber','radio','satellite','mobile_4g','mobile_5g','xdsl','other')),
  download_mbps   integer check (download_mbps is null or download_mbps > 0),
  upload_mbps     integer check (upload_mbps is null or upload_mbps > 0),
  guaranteed_mbps integer check (guaranteed_mbps is null or guaranteed_mbps > 0),

  has_static_ip   boolean not null default false,
  static_ip       inet,                       -- tipo nativo valida o endereço

  cpe_brand       text,
  cpe_model       text,
  cpe_serial      text,
  cpe_asset_id    uuid,                       -- quando o CPE é patrimônio próprio

  status          text not null default 'active'
                    check (status in ('active','suspended','cancelled')),
  monthly_cost    numeric(12,2) check (monthly_cost is null or monthly_cost >= 0),

  activated_on    date,
  cancelled_on    date,
  contract_start  date,
  contract_end    date,
  loyalty_until   date,

  monitoring_host        text,
  monitoring_external_id text,
  -- 'unknown' é o estado honesto de um link não monitorado. Nunca 'down':
  -- "não sei" e "está fora" são informações diferentes para quem opera.
  last_state      text not null default 'unknown' check (last_state in ('up','down','unknown')),
  last_state_at   timestamptz,

  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint fk_link_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete cascade,
  constraint fk_link_area foreign key (branch_area_id, tenant_id)
    references public.branch_areas (id, tenant_id) on delete restrict,
  constraint fk_link_supplier foreign key (supplier_id, tenant_id)
    references public.suppliers (id, tenant_id) on delete set null,
  constraint fk_link_cpe foreign key (cpe_asset_id, tenant_id)
    references public.it_assets (id, tenant_id) on delete set null,
  constraint uq_link_id_tenant unique (id, tenant_id),
  constraint link_static_ip_pair check (not has_static_ip or static_ip is not null),
  constraint link_cancel_needs_date check (status <> 'cancelled' or cancelled_on is not null),
  constraint link_contract_period
    check (contract_end is null or contract_start is null or contract_end >= contract_start),
  constraint link_has_carrier check (supplier_id is not null or carrier_name is not null)
);

create unique index uq_link_contract on public.internet_links (tenant_id, upper(contract_number))
  where contract_number is not null and deleted_at is null;
create index idx_links_branch on public.internet_links (tenant_id, branch_id, status)
  where deleted_at is null;
create index idx_links_down on public.internet_links (tenant_id, branch_id)
  where last_state = 'down' and status = 'active' and deleted_at is null;
create index idx_links_contract_end on public.internet_links (tenant_id, contract_end)
  where contract_end is not null and deleted_at is null and status <> 'cancelled';

create trigger trg_links_area_branch
  before insert or update of branch_area_id, branch_id on public.internet_links
  for each row execute function app.validate_area_branch('branch_area_id');

create table public.internet_link_attachments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  link_id      uuid not null,
  kind         text not null check (kind in (
                 'contract','amendment','loyalty_term','cancellation',
                 'installation_report','other')),
  storage_path text not null unique,
  file_name    text not null,
  mime_type    text not null,
  size_bytes   bigint check (size_bytes > 0),
  valid_until  date,
  uploaded_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint fk_link_attach foreign key (link_id, tenant_id)
    references public.internet_links (id, tenant_id) on delete cascade
);

create index idx_link_attachments on public.internet_link_attachments (link_id, kind, created_at desc);

-- Histórico de indisponibilidade. `duration_seconds` é coluna gerada para não
-- recalcular a duração em todo relatório de uptime.
create table public.link_availability_events (
  id                bigint generated always as identity primary key,
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  link_id           uuid not null,
  state             text not null check (state in ('up','down')),
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  duration_seconds  integer generated always as (
                      case when ended_at is null then null
                           else greatest(extract(epoch from (ended_at - started_at))::integer, 0)
                      end) stored,
  source            text not null default 'manual' check (source in ('zabbix','manual','api')),
  external_event_id text,
  note              text,
  constraint fk_link_event foreign key (link_id, tenant_id)
    references public.internet_links (id, tenant_id) on delete cascade,
  constraint link_event_period check (ended_at is null or ended_at >= started_at)
);

-- Idempotência do webhook de monitoração, mesmo padrão do Integration Hub.
create unique index uq_link_event_external on public.link_availability_events (link_id, external_event_id)
  where external_event_id is not null;
create index idx_link_events on public.link_availability_events (link_id, started_at desc);
create unique index uq_link_event_open on public.link_availability_events (link_id)
  where ended_at is null;

-- =============================================================================
-- MÓDULO 1 — SLA e filas editáveis
-- =============================================================================
alter table public.sla_definitions
  add column name text,
  add column deleted_at timestamptz;

-- A unicidade passa a ignorar definições removidas: sem isso, uma combinação
-- só poderia ser recriada se o registro antigo fosse apagado de verdade.
drop index if exists uq_slad_combo;
create unique index uq_slad_combo on public.sla_definitions (
  tenant_id,
  coalesce(contract_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid),
  priority_id
) where deleted_at is null;

-- Sustenta o preview de impacto.
create index idx_sla_tracking_definition on public.sla_tracking (sla_definition_id)
  where resolved_at is null;

alter table public.queues
  add column tiebreaker text not null default 'fifo'
    check (tiebreaker in ('fifo','lifo','custom')),
  -- Catálogo fechado, não expressão livre: expressão arbitrária num ORDER BY
  -- é injeção de SQL e risco de query impagável (LG-05).
  add column tiebreaker_criterion text
    check (tiebreaker_criterion is null or tiebreaker_criterion in (
      'menor_prazo_restante','maior_tempo_espera','cliente_prioritario')),
  add constraint queue_custom_needs_criterion
    check (tiebreaker <> 'custom' or tiebreaker_criterion is not null);

-- Preview de impacto: conta pelo vínculo REAL gravado em sla_tracking, não
-- re-resolvendo a precedência — é o que de fato mede aqueles tickets.
create or replace function app.fn_sla_impact_preview(p_definition_id uuid)
returns table (affected_open bigint, affected_at_risk bigint, affected_breached bigint)
language sql
stable
as $$
  select
    count(*) filter (where t.status not in ('resolved','closed')),
    count(*) filter (where t.status not in ('resolved','closed')
                       and app.sla_state(st.resolution_due_at, st.resolved_at,
                                         st.resolution_breached, tn.sla_warning_pct,
                                         tn.sla_critical_pct, st.started_at)
                           in ('warning','critical')),
    count(*) filter (where t.status not in ('resolved','closed')
                       and (st.resolution_breached
                            or (st.resolution_due_at is not null and now() > st.resolution_due_at)))
  from public.sla_tracking st
  join public.tickets t  on t.id = st.ticket_id and t.deleted_at is null
  join public.tenants tn on tn.id = st.tenant_id
  where st.sla_definition_id = p_definition_id;
$$;

-- Transferência em massa numa transação: um laço na aplicação pode falhar no
-- meio e deixar parte dos tickets movida.
create or replace function app.fn_bulk_transfer_queue(
  p_ticket_ids uuid[],
  p_queue_id   uuid,
  p_reason     text
)
returns integer
language plpgsql
as $$
declare
  v_moved integer;
begin
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Informe o motivo da transferência (mínimo 3 caracteres)'
      using errcode = 'check_violation';
  end if;

  update public.tickets
     set queue_id = p_queue_id, change_source = 'ui'
   where id = any (p_ticket_ids)
     and deleted_at is null
     and queue_id <> p_queue_id;

  get diagnostics v_moved = row_count;

  -- O motivo é intenção do usuário: a trigger de histórico registra a troca de
  -- fila, mas não conhece o porquê.
  insert into public.ticket_history
    (tenant_id, ticket_id, actor_id, field, new_value, change_source, reason)
  select t.tenant_id, t.id, app.current_user_id(),
         'queue_transfer_reason', btrim(p_reason), 'ui', btrim(p_reason)
  from public.tickets t
  where t.id = any (p_ticket_ids) and t.queue_id = p_queue_id;

  return v_moved;
end;
$$;

-- =============================================================================
-- MÓDULO 10 — Versionamento de mapeamento de integração
-- =============================================================================
alter table public.integrations
  add column polling_endpoint  text,
  add column auth_header_name  text,
  -- Rotação de credencial: guarda a REFERÊNCIA nova até o teste passar.
  -- O valor do segredo continua fora do banco (ADR-009).
  add column secret_ref_pending text,
  add column secret_rotated_at  timestamptz,
  add column last_test_at       timestamptz,
  add column last_test_ok       boolean;

create table public.integration_mapping_versions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  integration_id uuid not null,
  version        integer not null,
  -- Snapshot do CONJUNTO: um mapeamento isolado de uma versão antiga não faz
  -- sentido sem os outros, e o rollback vira uma escrita atômica.
  snapshot       jsonb not null,
  note           text,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint fk_imv_integration foreign key (integration_id, tenant_id)
    references public.integrations (id, tenant_id) on delete cascade,
  constraint uq_mapping_version unique (integration_id, version),
  constraint snapshot_is_array check (jsonb_typeof(snapshot) = 'array')
);

create index idx_mapping_versions on public.integration_mapping_versions (integration_id, version desc);

-- Versiona ANTES de aplicar a mudança, e por trigger: assim o rollback existe
-- mesmo quando alguém edita o mapeamento por SQL direto.
create or replace function app.snapshot_mapping_version()
returns trigger
language plpgsql
as $$
declare
  v_integration uuid := coalesce(new.integration_id, old.integration_id);
  v_tenant      uuid := coalesce(new.tenant_id, old.tenant_id);
  v_next        integer;
  v_snapshot    jsonb;
begin
  select coalesce(max(version), 0) + 1 into v_next
  from public.integration_mapping_versions where integration_id = v_integration;

  select coalesce(jsonb_agg(to_jsonb(m) - 'id' - 'created_at' - 'updated_at'), '[]'::jsonb)
    into v_snapshot
  from public.integration_mappings m
  where m.integration_id = v_integration;

  insert into public.integration_mapping_versions
    (tenant_id, integration_id, version, snapshot, created_by)
  values (v_tenant, v_integration, v_next, v_snapshot, app.current_user_id());

  return null;
end;
$$;

create trigger trg_mapping_version
  after insert or update or delete on public.integration_mappings
  for each row execute function app.snapshot_mapping_version();

-- =============================================================================
-- MÓDULO 11 — Geolocalização das filiais
-- =============================================================================
alter table public.branches
  add column latitude  numeric(9,6) check (latitude  is null or latitude  between -90  and 90),
  add column longitude numeric(9,6) check (longitude is null or longitude between -180 and 180),
  add column geocoded_at timestamptz,
  -- Saber a procedência da coordenada importa para poder corrigi-la.
  add column geocode_source text
    check (geocode_source is null or geocode_source in ('manual','nominatim','google','mapbox')),
  add constraint branch_geo_pair
    check ((latitude is null) = (longitude is null));

create index idx_branches_geo on public.branches (tenant_id)
  where latitude is not null and longitude is not null and deleted_at is null;

-- =============================================================================
-- Views de mapa e de análise
-- =============================================================================
-- `security_invoker = true` em todas: o mapa e os dashboards mostram
-- exclusivamente o que o usuário logado pode ver, e os totais ficam coerentes
-- com o escopo dele — não com o do tenant.

create view public.vw_map_tickets with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name,
  b.city, b.state, b.latitude, b.longitude,
  count(t.id) filter (where t.status not in ('resolved','closed'))                    as open_total,
  count(t.id) filter (where t.status in ('assigned','in_progress'))                   as in_progress_total,
  count(t.id) filter (where t.status not in ('resolved','closed') and p.weight >= 80)  as critical_total,
  count(t.id) filter (where t.status not in ('resolved','closed')
                        and (st.resolution_breached
                             or (st.resolution_due_at is not null and now() > st.resolution_due_at)))
                                                                                      as breached_total,
  case
    when count(t.id) filter (where t.status not in ('resolved','closed')
                               and (p.weight >= 80 or st.resolution_breached
                                    or (st.resolution_due_at is not null and now() > st.resolution_due_at))) > 0
      then 'red'
    when count(t.id) filter (where t.status not in ('resolved','closed')
                               and st.resolution_due_at is not null
                               and now() >= st.started_at
                                 + (st.resolution_due_at - st.started_at) * 0.75) > 0
      then 'amber'
    else 'green'
  end as marker_state
from public.branches b
left join public.tickets t on t.branch_id = b.id and t.deleted_at is null
left join public.ticket_priorities p on p.id = t.priority_id
left join public.sla_tracking st on st.ticket_id = t.id
where b.deleted_at is null
group by b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude;

create view public.vw_map_assets with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name,
  b.city, b.state, b.latitude, b.longitude,
  count(a.id)                                                       as assets_total,
  count(a.id) filter (where a.status = 'active')                     as assets_active,
  count(a.id) filter (where a.status = 'maintenance')                as assets_maintenance,
  count(a.id) filter (where a.status = 'active' and a.assigned_user_id is null)
                                                                     as assets_without_owner,
  case
    when count(a.id) filter (where a.status = 'active' and a.assigned_user_id is null) > 0 then 'red'
    when count(a.id) filter (where a.status = 'maintenance') > 0 then 'amber'
    else 'green'
  end as marker_state
from public.branches b
left join public.it_assets a on a.branch_id = b.id and a.deleted_at is null
where b.deleted_at is null
group by b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude;

create view public.vw_map_telecom with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name,
  b.city, b.state, b.latitude, b.longitude,
  count(l.id) filter (where l.status = 'active')                    as lines_active,
  count(l.id) filter (where l.status = 'suspended')                 as lines_suspended,
  count(l.id) filter (where l.status = 'cancelled')                 as lines_cancelled,
  coalesce(sum(l.monthly_cost) filter (where l.status = 'active'), 0) as monthly_cost_active,
  case
    when count(l.id) filter (where l.status = 'suspended') > 0 then 'red'
    when count(l.id) filter (where l.status = 'active' and l.assigned_user_id is null) > 0 then 'amber'
    else 'green'
  end as marker_state
from public.branches b
left join public.telecom_lines l on l.branch_id = b.id and l.deleted_at is null
where b.deleted_at is null
group by b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude;

create view public.vw_map_internet with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name,
  b.city, b.state, b.latitude, b.longitude,
  count(k.id) filter (where k.status = 'active')                              as links_active,
  count(k.id) filter (where k.status = 'active' and k.last_state = 'down')    as links_down,
  count(k.id) filter (where k.status = 'active' and k.last_state = 'unknown') as links_unmonitored,
  coalesce(sum(k.monthly_cost) filter (where k.status = 'active'), 0)          as monthly_cost_active,
  case
    when count(k.id) filter (where k.status = 'active' and k.last_state = 'down') > 0 then 'red'
    when count(k.id) filter (where k.status = 'active' and k.last_state = 'unknown') > 0 then 'amber'
    else 'green'
  end as marker_state
from public.branches b
left join public.internet_links k on k.branch_id = b.id and k.deleted_at is null
where b.deleted_at is null
group by b.tenant_id, b.id, b.name, b.city, b.state, b.latitude, b.longitude;

-- Detalhamento do popup do marcador. Tickets NÃO entram: não possuem dimensão
-- de área no modelo atual (ver LG-13 em docs/06-lacunas-e-roadmap.md).
create view public.vw_map_area_breakdown with (security_invoker = true) as
select
  ar.tenant_id, ar.branch_id, ar.id as area_id, ar.name as area_name, ar.kind, ar.sort_order,
  (select count(*) from public.it_assets a
    where a.branch_area_id = ar.id and a.deleted_at is null)          as assets_total,
  (select count(*) from public.telecom_lines l
    where l.company_area_id = ar.id and l.deleted_at is null
      and l.status = 'active')                                        as lines_active,
  (select count(*) from public.internet_links k
    where k.branch_area_id = ar.id and k.deleted_at is null
      and k.status = 'active')                                        as links_active
from public.branch_areas ar
where ar.is_active;

-- Dashboard de telefonia (módulo 6), agregado por todas as dimensões filtráveis.
create view public.vw_telecom_dashboard with (security_invoker = true) as
select
  l.tenant_id, l.branch_id, b.name as branch_name,
  l.company_area_id, ar.name as area_name,
  l.carrier, l.line_type, l.status,
  count(*)                                              as lines_count,
  coalesce(sum(l.monthly_cost), 0)                      as monthly_total,
  round(avg(l.monthly_cost), 2)                         as monthly_avg,
  count(*) filter (where l.assigned_user_id is null)    as without_user,
  count(*) filter (where l.loyalty_until is null or l.loyalty_until < current_date)
                                                        as free_to_cancel
from public.telecom_lines l
left join public.branches b     on b.id = l.branch_id
left join public.branch_areas ar on ar.id = l.company_area_id
where l.deleted_at is null
group by l.tenant_id, l.branch_id, b.name, l.company_area_id, ar.name,
         l.carrier, l.line_type, l.status;

-- Dashboard de links (módulo 8).
create view public.vw_internet_dashboard with (security_invoker = true) as
select
  k.tenant_id, k.branch_id, b.name as branch_name,
  coalesce(s.name, k.carrier_name) as carrier,
  k.technology, k.status,
  count(*)                                          as links_count,
  coalesce(sum(k.monthly_cost), 0)                  as monthly_total,
  count(*) filter (where k.last_state = 'down')     as links_down,
  count(*) filter (where k.contract_end is not null
                     and k.contract_end <= current_date + 90) as expiring_90d,
  count(*) filter (where not exists (
    select 1 from public.internet_link_attachments la
    where la.link_id = k.id and la.kind = 'contract'))        as without_contract
from public.internet_links k
left join public.branches b  on b.id = k.branch_id
left join public.suppliers s on s.id = k.supplier_id
where k.deleted_at is null
group by k.tenant_id, k.branch_id, b.name, coalesce(s.name, k.carrier_name),
         k.technology, k.status;

-- Custo de conectividade consolidado por filial: telefonia + links na mesma
-- leitura, que é o relatório pedido no escopo do módulo 8.
create view public.vw_connectivity_cost with (security_invoker = true) as
select
  b.tenant_id, b.id as branch_id, b.name as branch_name, b.city, b.state,
  coalesce(tel.lines_active, 0)  as lines_active,
  coalesce(tel.lines_cost, 0)    as telecom_monthly_cost,
  coalesce(net.links_active, 0)  as links_active,
  coalesce(net.links_cost, 0)    as internet_monthly_cost,
  coalesce(tel.lines_cost, 0) + coalesce(net.links_cost, 0) as total_monthly_cost
from public.branches b
left join (
  select branch_id, count(*) as lines_active, sum(coalesce(monthly_cost,0)) as lines_cost
  from public.telecom_lines where status = 'active' and deleted_at is null group by branch_id
) tel on tel.branch_id = b.id
left join (
  select branch_id, count(*) as links_active, sum(coalesce(monthly_cost,0)) as links_cost
  from public.internet_links where status = 'active' and deleted_at is null group by branch_id
) net on net.branch_id = b.id
where b.deleted_at is null;

-- View com o nome pedido pelo escopo do módulo 4, sobre a tabela que já existe.
create view public.asset_custody_history with (security_invoker = true) as
select
  aa.id, aa.tenant_id, aa.asset_id,
  a.asset_tag, a.model, a.asset_type,
  aa.previous_user_id, pu.full_name as previous_user_name,
  aa.user_id          as current_user_id, cu.full_name as current_user_name,
  aa.previous_branch_id, aa.branch_id, aa.previous_area_id, aa.branch_area_id,
  aa.event_type, aa.reason, aa.reason_note,
  aa.performed_by, pb.full_name as performed_by_name,
  aa.started_at as changed_at
from public.asset_assignments aa
join public.it_assets a on a.id = aa.asset_id
left join public.profiles pu on pu.id = aa.previous_user_id
left join public.profiles cu on cu.id = aa.user_id
left join public.profiles pb on pb.id = aa.performed_by
where aa.event_type in ('assignment','relocation','return','retirement','loss');

-- =============================================================================
-- RLS e auditoria das tabelas novas
-- =============================================================================
select app.harden_table('public.branch_areas');
select app.harden_table('public.asset_attachments');
select app.harden_table('public.telecom_line_attachments');
select app.harden_table('public.internet_links');
select app.harden_table('public.internet_link_attachments');
select app.harden_table('public.link_availability_events');
select app.harden_table('public.integration_mapping_versions');

-- Cadastros com a mesma forma de policy dos demais: leitura para o tenant,
-- escrita para admin/gestor. Gerado em laço para não divergir uma delas.
do $$
declare
  t text;
  tables text[] := array[
    'branch_areas','asset_attachments','telecom_line_attachments',
    'internet_link_attachments','link_availability_events','integration_mapping_versions'
  ];
begin
  foreach t in array tables loop
    execute format($f$
      create policy %1$s_select on public.%1$s
        for select to authenticated using (tenant_id = app.current_tenant_id());
    $f$, t);
    execute format($f$
      create policy %1$s_write on public.%1$s
        for all to authenticated
        using (tenant_id = app.current_tenant_id() and app.can_manage_records())
        with check (tenant_id = app.current_tenant_id() and app.can_manage_records());
    $f$, t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end
$$;

-- Links seguem o escopo de filial do inventário: um atendente vê a
-- conectividade das filiais que atende, não a do tenant inteiro.
create policy internet_links_select on public.internet_links
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_see_branch(branch_id));

create policy internet_links_write on public.internet_links
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_records())
  with check (tenant_id = app.current_tenant_id() and app.can_manage_records());

grant select, insert, update, delete on public.internet_links to authenticated;

grant select on
  public.vw_map_tickets, public.vw_map_assets, public.vw_map_telecom,
  public.vw_map_internet, public.vw_map_area_breakdown,
  public.vw_telecom_dashboard, public.vw_internet_dashboard,
  public.vw_connectivity_cost, public.asset_custody_history
  to authenticated;

select app.attach_audit('public.branch_areas');
select app.attach_audit('public.internet_links');
select app.attach_audit('public.asset_attachments');
select app.attach_audit('public.telecom_line_attachments');
select app.attach_audit('public.internet_link_attachments');
