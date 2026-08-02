-- =============================================================================
-- 0005 — Tickets: máquina de estados, numeração, comentários, anexos, histórico
-- =============================================================================

-- Contador de numeração legível por tenant (RF-TCK-10). Fica em `tenants` para
-- que o incremento seja um UPDATE de uma linha só — serialização natural por
-- tenant, sem lacunas, e sem tabela extra de contadores.
alter table public.tenants add column ticket_seq bigint not null default 0;

-- -----------------------------------------------------------------------------
-- ticket_status_transitions — a máquina de estados é DADO, não código (ADR-007)
-- -----------------------------------------------------------------------------
-- Tabela global (regra do produto, não do tenant). Alterar o fluxo é inserir
-- linha, não fazer deploy.
create table public.ticket_status_transitions (
  from_status text not null,
  to_status   text not null,
  description text,
  primary key (from_status, to_status)
);

insert into public.ticket_status_transitions (from_status, to_status, description) values
  ('open',                'triage',              'Início da triagem'),
  ('open',                'assigned',            'Atribuição direta'),
  ('open',                'closed',              'Cancelamento antes da triagem'),
  ('triage',              'assigned',            'Atribuição após triagem'),
  ('triage',              'open',                'Devolvido para a fila'),
  ('triage',              'closed',              'Descartado na triagem'),
  ('assigned',            'in_progress',         'Atendimento iniciado'),
  ('assigned',            'open',                'Devolvido para a fila'),
  ('assigned',            'waiting_requester',   'Aguardando o solicitante'),
  ('assigned',            'waiting_third_party', 'Aguardando terceiro'),
  ('in_progress',         'waiting_requester',   'Aguardando o solicitante'),
  ('in_progress',         'waiting_third_party', 'Aguardando terceiro'),
  ('in_progress',         'resolved',            'Resolvido'),
  ('in_progress',         'assigned',            'Reatribuído'),
  ('in_progress',         'open',                'Devolvido para a fila'),
  ('waiting_requester',   'in_progress',         'Retorno do solicitante'),
  ('waiting_requester',   'resolved',            'Resolvido durante a espera'),
  ('waiting_requester',   'closed',              'Fechado por falta de retorno'),
  ('waiting_third_party', 'in_progress',         'Retorno do terceiro'),
  ('waiting_third_party', 'resolved',            'Resolvido durante a espera'),
  ('resolved',            'closed',              'Confirmado / fechamento automático'),
  ('resolved',            'in_progress',         'Reaberto'),
  ('closed',              'in_progress',         'Reaberto após fechamento');

-- Estados que param o relógio de SLA (RF-SLA-05).
create or replace function app.status_pauses_sla(p_status text)
returns boolean
language sql
immutable
as $$
  select p_status in ('waiting_requester', 'waiting_third_party');
$$;

-- Estados considerados "em aberto" para dashboard e filas.
create or replace function app.status_is_open(p_status text)
returns boolean
language sql
immutable
as $$
  select p_status not in ('resolved', 'closed');
$$;

-- -----------------------------------------------------------------------------
-- tickets
-- -----------------------------------------------------------------------------
create table public.tickets (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  ticket_number  bigint not null,

  title          text not null check (length(btrim(title)) > 0),
  description    text,

  status         text not null default 'open'
                   check (status in ('open','triage','assigned','in_progress',
                                     'waiting_requester','waiting_third_party',
                                     'resolved','closed')),
  priority_id    uuid not null,
  category_id    uuid,
  queue_id       uuid not null,

  client_id      uuid,
  branch_id      uuid,
  requester_id   uuid,
  assignee_id    uuid,
  supplier_id    uuid,     -- FK adicionada em 0008 (suppliers ainda não existe)

  tags           text[] not null default '{}',

  -- Rastreabilidade de origem (RF-INT-10)
  source         text not null default 'ui' check (source in ('ui','api','integration','email')),
  source_system  text,
  external_id    text,
  external_url   text,
  -- Origem da última mudança: base da supressão de eco na sync reversa (ADR-008)
  change_source  text not null default 'ui' check (change_source in ('ui','api','integration','system')),

  first_response_at timestamptz,
  resolved_at       timestamptz,
  closed_at         timestamptz,
  reopened_count    integer not null default 0,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,

  constraint fk_tickets_priority foreign key (priority_id, tenant_id)
    references public.ticket_priorities (id, tenant_id),
  constraint fk_tickets_category foreign key (category_id, tenant_id)
    references public.ticket_categories (id, tenant_id) on delete set null,
  constraint fk_tickets_queue foreign key (queue_id, tenant_id)
    references public.queues (id, tenant_id),
  constraint fk_tickets_client foreign key (client_id, tenant_id)
    references public.clients (id, tenant_id) on delete set null,
  constraint fk_tickets_branch foreign key (branch_id, tenant_id)
    references public.branches (id, tenant_id) on delete set null,
  constraint fk_tickets_requester foreign key (requester_id, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,
  constraint fk_tickets_assignee foreign key (assignee_id, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,
  constraint uq_ticket_number unique (tenant_id, ticket_number),
  constraint uq_ticket_id_tenant unique (id, tenant_id),
  -- Origem externa exige o par completo, senão a rastreabilidade fica pela metade.
  constraint tickets_external_pair check (
    (external_id is null and source_system is null)
    or (external_id is not null and source_system is not null)
  )
);

-- Idempotência de integração (RF-INT-06): o mesmo objeto externo nunca vira 2 tickets.
create unique index uq_ticket_external
  on public.tickets (tenant_id, source_system, external_id)
  where external_id is not null and deleted_at is null;

-- Índices desenhados para as três consultas quentes do produto.
-- 1) Visão de fila: filtra fila + aberto, ordena por prioridade/idade.
create index idx_tickets_queue_open on public.tickets (tenant_id, queue_id, created_at)
  where deleted_at is null and status not in ('resolved','closed');
-- 2) Escopo por filial (RLS de atendente).
create index idx_tickets_branch_open on public.tickets (tenant_id, branch_id, status)
  where deleted_at is null and status not in ('resolved','closed');
-- 3) "Meus tickets".
create index idx_tickets_assignee on public.tickets (tenant_id, assignee_id, status)
  where deleted_at is null and status not in ('resolved','closed');
create index idx_tickets_requester on public.tickets (tenant_id, requester_id, created_at desc)
  where deleted_at is null;
-- Índice parcial que sustenta os contadores do dashboard sem varrer a tabela (ADR-005).
create index idx_tickets_dashboard on public.tickets (tenant_id, status, priority_id)
  where deleted_at is null and status not in ('resolved','closed');
create index idx_tickets_tags on public.tickets using gin (tags);

-- -----------------------------------------------------------------------------
-- Numeração e roteamento na criação
-- -----------------------------------------------------------------------------
create or replace function app.tickets_before_insert()
returns trigger
language plpgsql
as $$
declare
  v_next bigint;
begin
  if new.ticket_number is null or new.ticket_number = 0 then
    update public.tenants
       set ticket_seq = ticket_seq + 1
     where id = new.tenant_id
    returning ticket_seq into v_next;

    if v_next is null then
      raise exception 'Tenant % inexistente', new.tenant_id using errcode = 'foreign_key_violation';
    end if;
    new.ticket_number := v_next;
  end if;

  -- Sem fila informada, cai na fila padrão do sistema (RF-FIL-01).
  if new.queue_id is null then
    select id into new.queue_id
    from public.queues
    where tenant_id = new.tenant_id and is_system_default
    limit 1;

    if new.queue_id is null then
      raise exception 'Tenant % não possui fila padrão configurada', new.tenant_id
        using errcode = 'not_null_violation';
    end if;
  end if;

  -- Filial não informada: deriva do solicitante quando ele tem filial primária.
  if new.branch_id is null and new.requester_id is not null then
    select ub.branch_id into new.branch_id
    from public.user_branches ub
    where ub.user_id = new.requester_id and ub.is_primary
    limit 1;
  end if;

  -- Cliente é derivado da filial — evita divergência entre os dois campos.
  if new.branch_id is not null then
    select b.client_id into new.client_id from public.branches b where b.id = new.branch_id;
  end if;

  return new;
end;
$$;

create trigger trg_tickets_before_insert
  before insert on public.tickets
  for each row execute function app.tickets_before_insert();

-- -----------------------------------------------------------------------------
-- Máquina de estados + carimbos de ciclo de vida (ADR-007)
-- -----------------------------------------------------------------------------
create or replace function app.tickets_before_update()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if not exists (
      select 1 from public.ticket_status_transitions t
      where t.from_status = old.status and t.to_status = new.status
    ) then
      raise exception 'Transição de status inválida: % → %', old.status, new.status
        using errcode = 'check_violation',
              hint = 'Consulte public.ticket_status_transitions para os fluxos permitidos.';
    end if;

    if new.status = 'resolved' then
      new.resolved_at := coalesce(new.resolved_at, now());
    end if;

    if new.status = 'closed' then
      new.closed_at := coalesce(new.closed_at, now());
    end if;

    -- Reabertura: limpa os carimbos para que a próxima resolução seja medida de novo.
    if app.status_is_open(new.status) and not app.status_is_open(old.status) then
      new.reopened_count := old.reopened_count + 1;
      new.resolved_at := null;
      new.closed_at := null;
    end if;
  end if;

  -- Cliente acompanha a filial automaticamente.
  if new.branch_id is distinct from old.branch_id and new.branch_id is not null then
    select b.client_id into new.client_id from public.branches b where b.id = new.branch_id;
  end if;

  return new;
end;
$$;

create trigger trg_tickets_before_update
  before update on public.tickets
  for each row execute function app.tickets_before_update();

-- -----------------------------------------------------------------------------
-- ticket_history — audit trail (RF-TCK-05)
-- -----------------------------------------------------------------------------
create table public.ticket_history (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  ticket_id     uuid not null references public.tickets(id) on delete cascade,
  actor_id      uuid references public.profiles(id) on delete set null,
  field         text not null,
  old_value     text,
  new_value     text,
  change_source text not null default 'ui',
  reason        text,
  created_at    timestamptz not null default now()
);

create index idx_ticket_history_ticket on public.ticket_history (ticket_id, created_at desc);
create index idx_ticket_history_tenant on public.ticket_history (tenant_id, created_at desc);

-- Gravado por TRIGGER, não pela aplicação (antipattern A-06): assim, mudanças
-- feitas por integração, job ou SQL direto também ficam auditadas.
create or replace function app.tickets_after_update_history()
returns trigger
language plpgsql
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  v_key text;
  v_ignored text[] := array['updated_at','change_source','ticket_number','tenant_id','id'];
begin
  for v_key in select jsonb_object_keys(v_new) loop
    if v_key = any (v_ignored) then
      continue;
    end if;
    if v_new -> v_key is distinct from v_old -> v_key then
      insert into public.ticket_history
        (tenant_id, ticket_id, actor_id, field, old_value, new_value, change_source)
      values
        (new.tenant_id, new.id, app.current_user_id(), v_key,
         nullif(v_old ->> v_key, ''), nullif(v_new ->> v_key, ''), new.change_source);
    end if;
  end loop;
  return null;
end;
$$;

create trigger trg_tickets_history
  after update on public.tickets
  for each row execute function app.tickets_after_update_history();

-- -----------------------------------------------------------------------------
-- Comentários e anexos
-- -----------------------------------------------------------------------------
create table public.ticket_comments (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  ticket_id  uuid not null,
  author_id  uuid,
  body       text not null check (length(btrim(body)) > 0),
  -- 'internal' nunca é exposto ao solicitante (aplicado via RLS em 0011).
  visibility text not null default 'public' check (visibility in ('public','internal')),
  source     text not null default 'ui' check (source in ('ui','api','integration','email')),
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint fk_comment_ticket foreign key (ticket_id, tenant_id)
    references public.tickets (id, tenant_id) on delete cascade,
  constraint fk_comment_author foreign key (author_id, tenant_id)
    references public.profiles (id, tenant_id) on delete set null,
  constraint uq_comment_id_tenant unique (id, tenant_id)
);

create index idx_comments_ticket on public.ticket_comments (ticket_id, created_at)
  where deleted_at is null;
create unique index uq_comment_external on public.ticket_comments (tenant_id, ticket_id, external_id)
  where external_id is not null;

create table public.ticket_attachments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  ticket_id    uuid not null,
  comment_id   uuid,
  storage_path text not null,
  file_name    text not null,
  mime_type    text,
  size_bytes   bigint check (size_bytes >= 0),
  uploaded_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint fk_attach_ticket foreign key (ticket_id, tenant_id)
    references public.tickets (id, tenant_id) on delete cascade,
  constraint fk_attach_comment foreign key (comment_id, tenant_id)
    references public.ticket_comments (id, tenant_id) on delete cascade
);

create index idx_attachments_ticket on public.ticket_attachments (ticket_id);

-- Primeira resposta pública de um agente marca o TFR (RF-SLA-01).
-- Fica junto do comentário porque é esse o evento que define "houve resposta";
-- inferir por mudança de status daria falso positivo em triagem automática.
create or replace function app.comments_after_insert_first_response()
returns trigger
language plpgsql
as $$
declare
  v_author_role text;
begin
  if new.visibility <> 'public' then
    return null;
  end if;

  select role into v_author_role from public.profiles where id = new.author_id;

  if v_author_role is null or v_author_role in ('solicitante') then
    return null;   -- resposta do próprio solicitante não conta como atendimento
  end if;

  update public.tickets
     set first_response_at = now(),
         change_source = 'system'
   where id = new.ticket_id
     and first_response_at is null;

  return null;
end;
$$;

create trigger trg_comment_first_response
  after insert on public.ticket_comments
  for each row execute function app.comments_after_insert_first_response();

select app.harden_table('public.tickets');
select app.harden_table('public.ticket_comments');
select app.harden_table('public.ticket_attachments');
select app.harden_table('public.ticket_history');
select app.harden_table('public.ticket_status_transitions');
