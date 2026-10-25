-- =============================================================================
-- 0043 — Aprovação de pedido de serviço
-- =============================================================================
-- A docs/18 §5 listava isto como decisão pendente do cliente: "estender
-- `approval_rules` ao catálogo exige decidir quem aprova o quê". A decisão
-- continua sendo do cliente — o que esta migração faz é transformá-la em
-- CADASTRO, para que ela deixe de bloquear o código.
--
-- MAS O MOTIVO REAL DE ELA VIR AGORA É OUTRO
-- -------------------------------------------
-- `service_catalog.requer_aprovacao` existe desde a 0033, a tela de pedido
-- mostra um aviso em destaque —
--
--   "Este serviço PRECISA DE APROVAÇÃO antes de ser executado. O chamado é
--    aberto na hora e fica aguardando."
--
-- — e **nada disso acontecia**. O chamado era criado como qualquer outro, caía
-- na fila e era atendido. A coluna era decoração.
--
-- Isso é pior que uma funcionalidade ausente: é uma promessa falsa na tela. O
-- cliente que marcou "requer aprovação" num serviço caro acredita que há uma
-- trava, e não há. Ninguém descobre por erro — descobre pelo serviço executado.
--
-- POR QUE UM ESTADO NOVO, E NÃO `waiting_third_party`
-- ----------------------------------------------------
-- Reusar um estado de espera existente custaria zero e mentiria no relatório:
-- "aguardando terceiro" é a operadora, o fornecedor, o cliente. Aqui quem
-- segura é alguém de dentro, e a diferença é justamente a que o gestor quer ver
-- quando pergunta por que o chamado não andou.
--
-- E o estado novo pausa o relógio do SLA, pelo mesmo motivo que
-- `waiting_requester` pausa: o acordo é sobre o tempo de ATENDIMENTO, e o
-- atendimento não começou. Cobrar da equipe o tempo que a aprovação levou seria
-- cobrar o prazo de uma decisão que não é dela.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. O estado novo
-- -----------------------------------------------------------------------------
alter table public.tickets drop constraint if exists tickets_status_check;
alter table public.tickets
  add constraint tickets_status_check
  check (status in ('open', 'triage', 'assigned', 'in_progress',
                    'waiting_requester', 'waiting_third_party', 'waiting_approval',
                    'resolved', 'closed'));

create or replace function app.status_pauses_sla(p_status text)
returns boolean
language sql
immutable
as $$
  select p_status in ('waiting_requester', 'waiting_third_party', 'waiting_approval');
$$;

/*
 * As transições. Um pedido aguardando aprovação sai para exatamente dois
 * lugares: volta a andar (aprovado) ou fecha (recusado).
 *
 * Não existe `waiting_approval -> in_progress`: atender um pedido que ainda não
 * foi aprovado é o que a trava existe para impedir, e deixar a transição aberta
 * tornaria a trava uma sugestão.
 */
insert into public.ticket_status_transitions (from_status, to_status)
values
  ('open', 'waiting_approval'),
  ('triage', 'waiting_approval'),
  ('waiting_approval', 'open'),
  ('waiting_approval', 'closed')
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. Quem aprova o quê — a decisão do cliente, como cadastro
-- -----------------------------------------------------------------------------
/*
 * Uma coluna, e não duas. `null` significa "gestores e administradores", que é
 * a resposta certa para a maioria dos ambientes e não exige cadastro nenhum
 * para o recurso funcionar. Preenchida, restringe a um perfil de acesso
 * específico — que é como `approval_rules.required_profile_id` já resolve a
 * mesma pergunta no financeiro.
 *
 * Um enum `aprovacao_por in ('gestor','perfil')` ao lado da coluna diria a
 * mesma coisa duas vezes, e criaria o estado inconsistente ('perfil' sem
 * perfil) que alguém teria de validar.
 */
alter table public.service_catalog
  add column if not exists aprovador_profile_id uuid;

alter table public.service_catalog
  drop constraint if exists fk_sc_aprovador,
  add constraint fk_sc_aprovador foreign key (aprovador_profile_id, tenant_id)
    references public.access_profiles (id, tenant_id) on delete set null;

comment on column public.service_catalog.aprovador_profile_id is
  'Perfil de acesso que aprova este serviço. NULO = gestores e administradores.';

-- -----------------------------------------------------------------------------
-- 3. O registro da aprovação
-- -----------------------------------------------------------------------------
create table if not exists public.service_approvals (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  ticket_id   uuid not null,
  service_id  uuid not null,

  status      text not null default 'pendente'
              check (status in ('pendente', 'aprovado', 'recusado')),

  requested_by uuid references public.profiles(id) on delete set null,
  requested_at timestamptz not null default now(),

  decided_by   uuid references public.profiles(id) on delete set null,
  decided_at   timestamptz,
  /* O motivo da recusa não é opcional: "foi recusado" sem porquê gera o mesmo
     pedido de novo na semana seguinte, e a segunda recusa custa o mesmo tempo
     de todo mundo. */
  motivo       text,

  -- Um pedido, uma decisão. O chamado é a identidade.
  constraint uq_service_approval_ticket unique (ticket_id),
  constraint fk_sa_ticket foreign key (ticket_id, tenant_id)
    references public.tickets (id, tenant_id) on delete cascade,
  constraint fk_sa_service foreign key (service_id, tenant_id)
    references public.service_catalog (id, tenant_id) on delete restrict,

  /* O mesmo par que governa `ai_suggestions` desde a 0035: pendente não tem
     autor, decidida tem autor E data. Um estado decidido sem quem decidiu é
     exatamente o que ninguém consegue reconstruir depois. */
  constraint sa_decidida_tem_autor
    check ((status = 'pendente' and decided_by is null and decided_at is null)
        or (status <> 'pendente' and decided_by is not null and decided_at is not null)),
  constraint sa_recusa_tem_motivo
    check (status <> 'recusado' or (motivo is not null and length(trim(motivo)) >= 3))
);

create index if not exists idx_service_approvals_pendentes
  on public.service_approvals (tenant_id, requested_at)
  where status = 'pendente';

comment on table public.service_approvals is
  'A trava que `service_catalog.requer_aprovacao` prometia desde a 0033 e não aplicava.';

-- -----------------------------------------------------------------------------
-- 4. A trava: nasce aguardando, e o registro nasce junto
-- -----------------------------------------------------------------------------
/*
 * `before insert`, e não `after`: mudar o estado depois exigiria um `update`
 * que a máquina de estados teria de autorizar, e o chamado existiria por um
 * instante em `open` — tempo suficiente para a distribuição automática pegá-lo.
 */
create or replace function app.pedido_exige_aprovacao()
returns trigger
language plpgsql
as $$
begin
  if new.service_id is not null
     and exists (select 1 from public.service_catalog s
                  where s.id = new.service_id and s.requer_aprovacao)
  then
    new.status := 'waiting_approval';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pedido_exige_aprovacao on public.tickets;
create trigger trg_pedido_exige_aprovacao
  before insert on public.tickets
  for each row execute function app.pedido_exige_aprovacao();

create or replace function app.pedido_registra_aprovacao()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'waiting_approval' and new.service_id is not null then
    insert into public.service_approvals
      (tenant_id, ticket_id, service_id, requested_by)
    values (new.tenant_id, new.id, new.service_id, new.requester_id)
    on conflict (ticket_id) do nothing;

  end if;
  return null;
end;
$$;

drop trigger if exists trg_pedido_registra_aprovacao on public.tickets;
create trigger trg_pedido_registra_aprovacao
  after insert on public.tickets
  for each row execute function app.pedido_registra_aprovacao();

/*
 * A pausa do relógio, e por que ela é uma trigger separada com ESTE nome.
 *
 * A trigger de pausa da 0006 roda em `update`: ela compara o estado novo com o
 * antigo. Um chamado que JÁ NASCE aguardando nunca passa por essa comparação —
 * não existe estado antigo. Sem isto, o relógio corria durante a aprovação
 * enquanto o painel do chamado afirmava, em destaque, que estava parado. Seria
 * a segunda promessa falsa da mesma funcionalidade.
 *
 * E o nome importa: triggers do mesmo evento disparam em ORDEM ALFABÉTICA, e o
 * registro de `sla_tracking` é criado por `trg_tickets_sla_init`. Um nome que
 * ordene antes dele — `trg_pedido_*`, por exemplo — atualiza uma linha que
 * ainda não existe, sem erro nenhum. `trg_tickets_sla_pausa_*` vem depois de
 * `trg_tickets_sla_init` porque "p" > "i", e é só por isso que funciona.
 */
create or replace function app.pedido_pausa_sla_ao_nascer()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'waiting_approval' then
    insert into public.sla_pauses (tenant_id, ticket_id, reason)
    values (new.tenant_id, new.id, new.status)
    on conflict do nothing;

    update public.sla_tracking
       set is_paused = true, updated_at = now()
     where ticket_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_tickets_sla_pausa_ao_nascer on public.tickets;
create trigger trg_tickets_sla_pausa_ao_nascer
  after insert on public.tickets
  for each row execute function app.pedido_pausa_sla_ao_nascer();

-- -----------------------------------------------------------------------------
-- 5. Quem pode decidir
-- -----------------------------------------------------------------------------
create or replace function app.pode_aprovar_servico(p_service_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    app.has_permission('autoatendimento.catalogo.aprovar')
    and coalesce(
      (
        /* Perfil exigido: só quem está nele. Sem perfil exigido, vale o papel —
           e `can_manage_records()` é o mesmo teto que governa o resto do
           catálogo, em vez de um terceiro critério só para aprovação. */
        select case
                 when s.aprovador_profile_id is null then app.can_manage_records()
                 else exists (
                   select 1 from public.profiles p
                    where p.id = app.current_user_id()
                      and p.access_profile_id = s.aprovador_profile_id
                 )
               end
          from public.service_catalog s
         where s.id = p_service_id
      ),
      false);
$$;

comment on function app.pode_aprovar_servico(uuid) is
  'A permissão de aprovar E o perfil exigido pelo serviço. As duas, sempre.';

-- -----------------------------------------------------------------------------
-- 6. Decidir
-- -----------------------------------------------------------------------------
/*
 * `security definer`, e esta é a única da migração.
 *
 * O motivo é concreto: a decisão muda DUAS tabelas (`service_approvals` e
 * `tickets`), e o estado inconsistente — aprovação registrada com o chamado
 * ainda parado, ou o contrário — é indistinguível de um defeito quando alguém
 * for olhar. Em duas chamadas da aplicação, uma falha de rede entre elas
 * produz exatamente isso.
 *
 * E ela não afrouxa nada: a primeira linha do corpo é `pode_aprovar_servico()`,
 * que exige a permissão E o perfil cadastrado no serviço. Quem não pode recebe
 * exceção, não silêncio.
 */
create or replace function public.decidir_pedido(
  p_ticket_id uuid,
  p_aprovado boolean,
  p_motivo text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ap     public.service_approvals;
  v_tenant uuid := app.current_tenant_id();
  v_novo   text;
begin
  select * into v_ap from public.service_approvals
   where ticket_id = p_ticket_id and tenant_id = v_tenant;

  if v_ap.id is null then
    raise exception 'este chamado não tem pedido aguardando aprovação'
      using errcode = 'no_data_found';
  end if;

  if v_ap.status <> 'pendente' then
    /* Decidir duas vezes não é erro de quem clicou: é a tela aberta em duas
       abas. A mensagem precisa dizer o que já aconteceu, não "erro". */
    raise exception 'este pedido já foi % em %',
      v_ap.status, to_char(v_ap.decided_at, 'DD/MM/YYYY HH24:MI')
      using errcode = 'invalid_parameter_value';
  end if;

  if not app.pode_aprovar_servico(v_ap.service_id) then
    raise exception 'sem permissão para aprovar este serviço'
      using errcode = 'insufficient_privilege';
  end if;

  if not p_aprovado and coalesce(length(trim(p_motivo)), 0) < 3 then
    raise exception 'a recusa precisa de motivo'
      using errcode = 'check_violation';
  end if;

  v_novo := case when p_aprovado then 'open' else 'closed' end;

  update public.service_approvals
     set status     = case when p_aprovado then 'aprovado' else 'recusado' end,
         decided_by = app.current_user_id(),
         decided_at = now(),
         motivo     = nullif(trim(coalesce(p_motivo, '')), '')
   where id = v_ap.id;

  update public.tickets
     set status = v_novo,
         change_source = 'ui'
   where id = p_ticket_id and tenant_id = v_tenant;

  /* O porquê fica no chamado, e não só na tabela de aprovação: quem abre o
     chamado seis meses depois lê a história ali, não numa tabela que a tela de
     chamado não mostra. */
  insert into public.ticket_comments
    (tenant_id, ticket_id, author_id, body, visibility)
  values (
    v_tenant, p_ticket_id, app.current_user_id(),
    case when p_aprovado
         then 'Pedido aprovado.'
         else format('Pedido recusado. Motivo: %s', trim(p_motivo)) end,
    /* Público: quem pediu precisa saber que foi recusado, e por quê. Uma nota
       interna aqui esconderia a decisão justamente de quem ela afeta. */
    'public');

  return v_novo;
end;
$$;

revoke all on function public.decidir_pedido(uuid, boolean, text) from public;
grant execute on function public.decidir_pedido(uuid, boolean, text) to authenticated;

comment on function public.decidir_pedido(uuid, boolean, text) is
  'Aprova ou recusa um pedido: decisão, estado do chamado e comentário numa transação só.';

-- -----------------------------------------------------------------------------
-- 7. RLS
-- -----------------------------------------------------------------------------
alter table public.service_approvals enable row level security;
alter table public.service_approvals force row level security;

/*
 * Leitura para o tenant inteiro, escrita por ninguém — a decisão passa pela
 * função. Um `update` direto poderia marcar "aprovado" sem mexer no chamado, e
 * o pedido ficaria aprovado e parado.
 *
 * A GRANT é tão necessária quanto a policy: sem ela, a negação vira
 * "permission denied for table", que é ERRO, e não as zero linhas que o resto
 * desta base devolve.
 */
drop policy if exists service_approvals_select on public.service_approvals;
create policy service_approvals_select on public.service_approvals
  for select to authenticated
  using (tenant_id = app.current_tenant_id());

grant select on public.service_approvals to authenticated;

select app.harden_table('public.service_approvals');
select app.attach_audit('public.service_approvals');

-- -----------------------------------------------------------------------------
-- 8. A permissão
-- -----------------------------------------------------------------------------
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('autoatendimento.catalogo.aprovar', 'autoatendimento', 'catalogo', 'aprovar',
   'Aprovar ou recusar pedido de serviço', 'gestor', 238)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

commit;
