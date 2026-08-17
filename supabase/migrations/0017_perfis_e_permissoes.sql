-- =============================================================================
-- 0017 — Perfis de acesso e permissões granulares (módulo → tela → ação)
-- =============================================================================
-- Até aqui a autorização tinha um único eixo: `profiles.role`, com seis valores
-- fixos. Isso resolve "quem administra" e não resolve "quem aprova pagamento mas
-- não cadastra fornecedor" — que é exatamente a pergunta que o módulo financeiro
-- faz.
--
-- Esta migração acrescenta um segundo eixo SEM remover o primeiro:
--
--   * `profiles.role` continua governando as policies de RLS. Nenhuma das 118
--     policies existentes é reescrita.
--   * `access_profiles.base_role` é o TETO de RLS do perfil, e
--     `app.effective_base_role()` devolve o MENOR entre o papel do usuário e o
--     teto do perfil. Um perfil, portanto, só sabe restringir — nunca elevar.
--   * `permission_grants` refina dentro desse teto, na granularidade de ação.
--
-- Depois do backfill no fim do arquivo, todo usuário existente fica com um
-- perfil cujo `base_role` é igual ao seu papel atual. O comportamento observável
-- é idêntico ao de antes desta migração; a granularidade só passa a valer quando
-- alguém atribui um perfil mais restrito.

-- -----------------------------------------------------------------------------
-- Ordem de privilégio dos papéis
-- -----------------------------------------------------------------------------
-- Comparar papel por texto exigiria repetir a lista em cada CASE. Um rank
-- numérico deixa "menor privilégio" ser uma comparação, que é o que
-- `effective_base_role` precisa.
create or replace function app.role_rank(p_role text)
returns integer
language sql
immutable
as $$
  select case p_role
    when 'visualizador' then 0
    when 'solicitante'  then 1
    when 'atendente'    then 2
    when 'gestor'       then 3
    when 'admin'        then 4
    when 'super_admin'  then 5
    else -1                          -- papel desconhecido nunca alcança nada
  end;
$$;

comment on function app.role_rank(text) is
  'Ordem de privilégio dos papéis. Só para comparar teto — não autoriza nada.';

-- -----------------------------------------------------------------------------
-- permission_catalog — a superfície da APLICAÇÃO, não do cliente
-- -----------------------------------------------------------------------------
-- Sem `tenant_id` de propósito: as telas e ações que existem são as mesmas para
-- todo assinante. O que varia por tenant é quem recebe cada uma, e isso mora em
-- `permission_grants`.
--
-- Espelha `src/lib/permissions.ts`. A duplicação é intencional e verificada por
-- teste: o banco precisa da lista para validar grant, e a aplicação precisa dela
-- para montar a matriz sem uma ida ao banco por checkbox.
create table public.permission_catalog (
  key           text primary key,
  module        text not null,
  screen        text,
  action        text,
  label         text not null,
  min_base_role text not null
                  check (min_base_role in ('super_admin','admin','gestor','atendente','solicitante','visualizador')),
  sort_order    integer not null default 0,
  -- A chave é derivada da trinca. Gravar as duas coisas e deixá-las divergir
  -- quebraria a montagem da árvore na tela de perfis.
  constraint permission_catalog_key_matches_parts check (
    key = concat_ws('.', module, screen, action)
  ),
  -- Ação sem tela seria uma chave de dois níveis com semântica de três.
  constraint permission_catalog_action_needs_screen check (
    action is null or screen is not null
  )
);

create index idx_permission_catalog_module on public.permission_catalog (module, sort_order);

comment on table public.permission_catalog is
  'Catálogo global de permissões (modulo/tela/acao). Semeado por migração, somente leitura pela API.';

-- -----------------------------------------------------------------------------
-- access_profiles — perfis de acesso, por tenant
-- -----------------------------------------------------------------------------
create table public.access_profiles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  description text,
  -- Teto de RLS. Um perfil de base `atendente` não consegue exercer permissão
  -- de `gestor` nem se o grant existir — o RLS barra antes.
  base_role   text not null
                check (base_role in ('admin','gestor','atendente','solicitante','visualizador')),
  -- Perfis de sistema são atribuíveis mas não editáveis. `system_key` identifica
  -- cada um de forma estável: o nome é exibição e poderia ser traduzido.
  is_system   boolean not null default false,
  system_key  text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint uq_access_profiles_id_tenant unique (id, tenant_id),
  constraint access_profiles_system_key_required check (
    (is_system and system_key is not null) or (not is_system and system_key is null)
  )
);

create unique index uq_access_profiles_name on public.access_profiles (tenant_id, lower(name));
create unique index uq_access_profiles_system_key on public.access_profiles (tenant_id, system_key)
  where system_key is not null;
create index idx_access_profiles_tenant on public.access_profiles (tenant_id) where is_active;

comment on table public.access_profiles is
  'Perfis de acesso por tenant. base_role é o teto de RLS; permission_grants refina dentro dele.';

-- -----------------------------------------------------------------------------
-- permission_grants — presença da linha É a concessão
-- -----------------------------------------------------------------------------
-- Não existe coluna `allowed boolean`. Com "liberação explícita", uma linha
-- `allowed = false` significaria a mesma coisa que a ausência da linha, e as
-- duas representações do mesmo fato acabariam divergindo — sobrando linha falsa
-- que ninguém limpa e que confunde a leitura da matriz.
create table public.permission_grants (
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  profile_id     uuid not null,
  permission_key text not null references public.permission_catalog(key) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (profile_id, permission_key),
  constraint fk_grant_profile foreign key (profile_id, tenant_id)
    references public.access_profiles (id, tenant_id) on delete cascade
);

create index idx_permission_grants_tenant on public.permission_grants (tenant_id, permission_key);

comment on table public.permission_grants is
  'Concessões por perfil. A presença da linha concede; a ausência nega.';

-- -----------------------------------------------------------------------------
-- profiles.access_profile_id
-- -----------------------------------------------------------------------------
-- Nullable porque a coluna nasce vazia e é preenchida no backfill no fim deste
-- arquivo. FK composta (id, tenant_id) para o perfil nunca atravessar tenant —
-- o padrão do ADR-001.
alter table public.profiles
  add column access_profile_id uuid,
  add constraint fk_profiles_access_profile foreign key (access_profile_id, tenant_id)
    references public.access_profiles (id, tenant_id) on delete set null;

create index idx_profiles_access_profile on public.profiles (access_profile_id)
  where access_profile_id is not null;

-- -----------------------------------------------------------------------------
-- Funções de autorização
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER pelo mesmo motivo de `app.current_role()` (0002_core.sql:162):
-- ler `profiles` de dentro de uma policy de `profiles` recursaria.
create or replace function app.current_access_profile_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.access_profile_id from public.profiles p where p.id = app.current_user_id();
$$;

/**
 * Papel efetivo: o MENOR entre o papel do usuário e o teto do perfil.
 *
 * É o que garante que atribuir um perfil só restrinja. Sem o `least`, um perfil
 * de base `admin` dado a um `atendente` promoveria a pessoa sem passar pela
 * trigger de escalonamento.
 */
create or replace function app.effective_base_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when ap.base_role is null then p.role
    when app.role_rank(ap.base_role) < app.role_rank(p.role) then ap.base_role
    else p.role
  end
  from public.profiles p
  left join public.access_profiles ap
    on ap.id = p.access_profile_id and ap.is_active
  where p.id = app.current_user_id();
$$;

comment on function app.effective_base_role() is
  'Menor entre profiles.role e access_profiles.base_role. Perfil só restringe, nunca eleva.';

/**
 * A sessão tem esta permissão?
 *
 * Exige o grant da chave E de cada ancestral dela — é a herança de negação.
 * Um grant de ação que sobreviveu a uma despromoção, sem o grant do módulo, não
 * vale nada; é o caso que a versão "só olha a própria chave" deixaria passar.
 *
 * Usuário sem perfil atribuído devolve false. Depois do backfill isso só
 * acontece com linha nova ainda não configurada, e negar é a falha segura.
 */
create or replace function app.has_permission(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with wanted as (
    select array_to_string((string_to_array(p_key, '.'))[1:i], '.') as key
    from generate_subscripts(string_to_array(p_key, '.'), 1) as i
  )
  select app.current_access_profile_id() is not null
     and not exists (
       select 1 from wanted w
       where not exists (
         select 1 from public.permission_grants g
         where g.profile_id = app.current_access_profile_id()
           and g.permission_key = w.key
       )
     );
$$;

comment on function app.has_permission(text) is
  'Herança de negação: exige grant da chave e de todos os ancestrais dela.';

-- -----------------------------------------------------------------------------
-- Os três predicados de escrita passam a respeitar o teto do perfil
-- -----------------------------------------------------------------------------
-- `create or replace` do corpo: as policies referenciam a função pelo nome, e
-- portanto todas as 118 passam a considerar o perfil de uma só vez. Como o
-- backfill deixa base_role = role para todo mundo, o resultado imediato é
-- idêntico ao de hoje.
create or replace function app.can_manage_config()
returns boolean
language sql
stable
as $$
  select app.effective_base_role() in ('super_admin','admin');
$$;

create or replace function app.can_manage_records()
returns boolean
language sql
stable
as $$
  select app.effective_base_role() in ('super_admin','admin','gestor');
$$;

create or replace function app.can_work_tickets()
returns boolean
language sql
stable
as $$
  select app.effective_base_role() in ('super_admin','admin','gestor','atendente');
$$;

-- -----------------------------------------------------------------------------
-- Guardas de integridade do próprio sistema de permissões
-- -----------------------------------------------------------------------------
/**
 * Impede três formas de furar a autorização por dentro:
 *
 *   1. trocar o PRÓPRIO perfil de acesso (auto-promoção pela porta de trás,
 *      já que a trigger de 0012 só olha `role` e `tenant_id`);
 *   2. editar um perfil de sistema, que é contrato da plataforma;
 *   3. rebaixar `base_role` de perfil de sistema.
 */
create or replace function app.guard_access_profile_assignment()
returns trigger
language plpgsql
as $$
begin
  if app.is_service_role() or app.current_user_id() is null then
    return new;                                    -- provisionamento pelo backend
  end if;

  if new.access_profile_id is distinct from old.access_profile_id
     and new.id = app.current_user_id() then
    raise exception 'Você não pode alterar o seu próprio perfil de acesso'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger trg_profiles_no_self_profile_change
  before update of access_profile_id on public.profiles
  for each row execute function app.guard_access_profile_assignment();

create or replace function app.guard_system_profile()
returns trigger
language plpgsql
as $$
begin
  if app.is_service_role() or app.current_user_id() is null then
    return coalesce(new, old);
  end if;

  if coalesce(old.is_system, false) then
    if tg_op = 'DELETE' then
      raise exception 'Perfil de sistema não pode ser excluído'
        using errcode = 'insufficient_privilege';
    end if;
    -- Ativar/inativar é permitido; o resto do perfil é contrato da plataforma.
    if new.name is distinct from old.name
       or new.base_role is distinct from old.base_role
       or new.system_key is distinct from old.system_key
       or new.is_system is distinct from old.is_system then
      raise exception 'Perfil de sistema só aceita mudança de situação (ativo/inativo)'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

create trigger trg_access_profiles_guard_system
  before update or delete on public.access_profiles
  for each row execute function app.guard_system_profile();

/**
 * Recusa grant que o `base_role` do perfil não alcança.
 *
 * Sem isto a matriz aceitaria conceder `usuarios.perfis.editar` a um perfil de
 * base `gestor`: o checkbox ficaria marcado, o RLS negaria a operação, e o
 * administrador não teria nenhuma pista de por que o botão não funciona.
 */
create or replace function app.guard_grant_within_base_role()
returns trigger
language plpgsql
as $$
declare
  v_base text;
  v_min  text;
begin
  select base_role into v_base from public.access_profiles where id = new.profile_id;
  select min_base_role into v_min from public.permission_catalog where key = new.permission_key;

  if v_base is null or v_min is null then
    return new;                                    -- FK cuida da inexistência
  end if;

  if app.role_rank(v_min) > app.role_rank(v_base) then
    raise exception 'A permissão % exige papel base % — o perfil tem %',
      new.permission_key, v_min, v_base
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger trg_permission_grants_within_base_role
  before insert or update on public.permission_grants
  for each row execute function app.guard_grant_within_base_role();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
select app.harden_table('public.permission_catalog');
select app.harden_table('public.access_profiles');
select app.harden_table('public.permission_grants');

select app.attach_audit('public.access_profiles');
select app.attach_audit('public.permission_grants');

-- Catálogo é público para quem está autenticado: a aplicação precisa dele para
-- montar a matriz, e ele não contém dado de nenhum tenant. Sem policy de
-- escrita — só a migração semeia.
create policy permission_catalog_select on public.permission_catalog
  for select to authenticated
  using (true);

grant select on public.permission_catalog to authenticated;

-- Perfis: legíveis por todo o tenant (o formulário de usuário precisa listar),
-- graváveis só por quem administra configuração.
create policy access_profiles_select on public.access_profiles
  for select to authenticated
  using (tenant_id = app.current_tenant_id());

create policy access_profiles_insert on public.access_profiles
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.can_manage_config());

create policy access_profiles_update on public.access_profiles
  for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_config())
  with check (tenant_id = app.current_tenant_id());

create policy access_profiles_delete on public.access_profiles
  for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_config());

grant select, insert, update, delete on public.access_profiles to authenticated;

create policy permission_grants_select on public.permission_grants
  for select to authenticated
  using (tenant_id = app.current_tenant_id());

create policy permission_grants_insert on public.permission_grants
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.can_manage_config());

create policy permission_grants_delete on public.permission_grants
  for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_manage_config());

grant select, insert, delete on public.permission_grants to authenticated;

-- -----------------------------------------------------------------------------
-- Semente do catálogo
-- -----------------------------------------------------------------------------
-- GERADO a partir de `PERMISSION_CATALOG` em `src/lib/permissions.ts`. Editar
-- aqui à mão faz o banco divergir da aplicação; edite o TypeScript e regenere.
-- `supabase/tests/schema_test.sql` compara a contagem, então a divergência
-- derruba o CI em vez de virar permissão fantasma.
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('helpdesk', 'helpdesk', null, null, 'Helpdesk', 'visualizador', 10),
  ('helpdesk.painel', 'helpdesk', 'painel', null, 'Painel operacional', 'visualizador', 20),
  ('helpdesk.painel.ver', 'helpdesk', 'painel', 'ver', 'Abrir o painel', 'visualizador', 30),
  ('helpdesk.tickets', 'helpdesk', 'tickets', null, 'Tickets', 'visualizador', 40),
  ('helpdesk.tickets.ver', 'helpdesk', 'tickets', 'ver', 'Consultar tickets', 'visualizador', 50),
  ('helpdesk.tickets.criar', 'helpdesk', 'tickets', 'criar', 'Abrir ticket', 'solicitante', 60),
  ('helpdesk.tickets.comentar', 'helpdesk', 'tickets', 'comentar', 'Comentar (público)', 'solicitante', 70),
  ('helpdesk.tickets.comentar_interno', 'helpdesk', 'tickets', 'comentar_interno', 'Comentar (interno)', 'atendente', 80),
  ('helpdesk.tickets.mudar_status', 'helpdesk', 'tickets', 'mudar_status', 'Mover status', 'atendente', 90),
  ('helpdesk.tickets.atribuir', 'helpdesk', 'tickets', 'atribuir', 'Atribuir atendente', 'atendente', 100),
  ('helpdesk.tickets.transferir', 'helpdesk', 'tickets', 'transferir', 'Transferir de fila', 'atendente', 110),
  ('helpdesk.filas', 'helpdesk', 'filas', null, 'Filas', 'visualizador', 120),
  ('helpdesk.filas.ver', 'helpdesk', 'filas', 'ver', 'Consultar filas', 'visualizador', 130),
  ('sla', 'sla', null, null, 'SLA e filas', 'gestor', 140),
  ('sla.compliance', 'sla', 'compliance', null, 'Compliance de SLA', 'gestor', 150),
  ('sla.compliance.ver', 'sla', 'compliance', 'ver', 'Ver compliance', 'gestor', 160),
  ('sla.definicoes', 'sla', 'definicoes', null, 'Definições de SLA', 'gestor', 170),
  ('sla.definicoes.ver', 'sla', 'definicoes', 'ver', 'Consultar definições', 'gestor', 180),
  ('sla.definicoes.criar', 'sla', 'definicoes', 'criar', 'Criar definição', 'gestor', 190),
  ('sla.definicoes.editar', 'sla', 'definicoes', 'editar', 'Editar definição', 'gestor', 200),
  ('sla.definicoes.inativar', 'sla', 'definicoes', 'inativar', 'Ativar/inativar definição', 'gestor', 210),
  ('sla.contratos', 'sla', 'contratos', null, 'Contratos de SLA', 'gestor', 220),
  ('sla.contratos.ver', 'sla', 'contratos', 'ver', 'Consultar contratos de SLA', 'gestor', 230),
  ('sla.contratos.criar', 'sla', 'contratos', 'criar', 'Criar contrato de SLA', 'gestor', 240),
  ('sla.contratos.editar', 'sla', 'contratos', 'editar', 'Editar contrato de SLA', 'gestor', 250),
  ('sla.contratos.inativar', 'sla', 'contratos', 'inativar', 'Ativar/inativar contrato de SLA', 'gestor', 260),
  ('sla.categorias', 'sla', 'categorias', null, 'Categorias de ticket', 'gestor', 270),
  ('sla.categorias.ver', 'sla', 'categorias', 'ver', 'Consultar categorias', 'gestor', 280),
  ('sla.categorias.criar', 'sla', 'categorias', 'criar', 'Criar categoria', 'gestor', 290),
  ('sla.categorias.editar', 'sla', 'categorias', 'editar', 'Editar categoria', 'gestor', 300),
  ('sla.categorias.inativar', 'sla', 'categorias', 'inativar', 'Ativar/inativar categoria', 'gestor', 310),
  ('sla.prioridades', 'sla', 'prioridades', null, 'Prioridades', 'gestor', 320),
  ('sla.prioridades.ver', 'sla', 'prioridades', 'ver', 'Consultar prioridades', 'gestor', 330),
  ('sla.prioridades.criar', 'sla', 'prioridades', 'criar', 'Criar prioridade', 'gestor', 340),
  ('sla.prioridades.editar', 'sla', 'prioridades', 'editar', 'Editar prioridade', 'gestor', 350),
  ('sla.prioridades.inativar', 'sla', 'prioridades', 'inativar', 'Ativar/inativar prioridade', 'gestor', 360),
  ('inventario', 'inventario', null, null, 'Inventário', 'visualizador', 370),
  ('inventario.ativos', 'inventario', 'ativos', null, 'Ativos de TI', 'visualizador', 380),
  ('inventario.ativos.ver', 'inventario', 'ativos', 'ver', 'Consultar ativos', 'visualizador', 390),
  ('inventario.ativos.criar', 'inventario', 'ativos', 'criar', 'Cadastrar ativo', 'gestor', 400),
  ('inventario.ativos.editar', 'inventario', 'ativos', 'editar', 'Editar ativo', 'gestor', 410),
  ('inventario.ativos.mudar_status', 'inventario', 'ativos', 'mudar_status', 'Mover ciclo de vida', 'gestor', 420),
  ('telefonia', 'telefonia', null, null, 'Telefonia', 'visualizador', 430),
  ('telefonia.linhas', 'telefonia', 'linhas', null, 'Linhas telefônicas', 'visualizador', 440),
  ('telefonia.linhas.ver', 'telefonia', 'linhas', 'ver', 'Consultar linhas', 'visualizador', 450),
  ('telefonia.linhas.criar', 'telefonia', 'linhas', 'criar', 'Cadastrar linha', 'gestor', 460),
  ('telefonia.linhas.editar', 'telefonia', 'linhas', 'editar', 'Editar linha', 'gestor', 470),
  ('telefonia.linhas.mudar_status', 'telefonia', 'linhas', 'mudar_status', 'Suspender/reativar linha', 'gestor', 480),
  ('clientes', 'clientes', null, null, 'Clientes e filiais', 'gestor', 490),
  ('clientes.grupos', 'clientes', 'grupos', null, 'Grupos econômicos', 'gestor', 500),
  ('clientes.grupos.ver', 'clientes', 'grupos', 'ver', 'Consultar clientes', 'gestor', 510),
  ('clientes.grupos.criar', 'clientes', 'grupos', 'criar', 'Cadastrar cliente', 'gestor', 520),
  ('clientes.grupos.editar', 'clientes', 'grupos', 'editar', 'Editar cliente', 'gestor', 530),
  ('clientes.grupos.inativar', 'clientes', 'grupos', 'inativar', 'Mudar situação do cliente', 'gestor', 540),
  ('clientes.filiais', 'clientes', 'filiais', null, 'Filiais', 'gestor', 550),
  ('clientes.filiais.ver', 'clientes', 'filiais', 'ver', 'Consultar filiais', 'gestor', 560),
  ('clientes.filiais.criar', 'clientes', 'filiais', 'criar', 'Cadastrar filial', 'gestor', 570),
  ('clientes.filiais.editar', 'clientes', 'filiais', 'editar', 'Editar filial', 'gestor', 580),
  ('clientes.filiais.inativar', 'clientes', 'filiais', 'inativar', 'Ativar/inativar filial', 'gestor', 590),
  ('fornecedores', 'fornecedores', null, null, 'Fornecedores', 'gestor', 600),
  ('fornecedores.cadastro', 'fornecedores', 'cadastro', null, 'Fornecedores', 'gestor', 610),
  ('fornecedores.cadastro.ver', 'fornecedores', 'cadastro', 'ver', 'Consultar fornecedores', 'gestor', 620),
  ('fornecedores.cadastro.criar', 'fornecedores', 'cadastro', 'criar', 'Cadastrar fornecedor', 'gestor', 630),
  ('fornecedores.cadastro.editar', 'fornecedores', 'cadastro', 'editar', 'Editar fornecedor', 'gestor', 640),
  ('fornecedores.cadastro.inativar', 'fornecedores', 'cadastro', 'inativar', 'Ativar/inativar fornecedor', 'gestor', 650),
  ('fornecedores.contratos', 'fornecedores', 'contratos', null, 'Contratos de fornecedor', 'gestor', 660),
  ('fornecedores.contratos.ver', 'fornecedores', 'contratos', 'ver', 'Consultar contratos', 'gestor', 670),
  ('fornecedores.contratos.criar', 'fornecedores', 'contratos', 'criar', 'Cadastrar contrato', 'gestor', 680),
  ('fornecedores.contratos.editar', 'fornecedores', 'contratos', 'editar', 'Editar contrato', 'gestor', 690),
  ('fornecedores.contratos.inativar', 'fornecedores', 'contratos', 'inativar', 'Ativar/inativar contrato', 'gestor', 700),
  ('mapas', 'mapas', null, null, 'Mapas', 'visualizador', 710),
  ('mapas.geolocalizacao', 'mapas', 'geolocalizacao', null, 'Geolocalização de filiais', 'visualizador', 720),
  ('mapas.geolocalizacao.ver', 'mapas', 'geolocalizacao', 'ver', 'Ver mapa', 'visualizador', 730),
  ('mapas.geolocalizacao.editar_endereco', 'mapas', 'geolocalizacao', 'editar_endereco', 'Gravar endereço e coordenada', 'gestor', 740),
  ('mapas.geolocalizacao.geocodificar', 'mapas', 'geolocalizacao', 'geocodificar', 'Rodar geocodificação', 'gestor', 750),
  ('financeiro', 'financeiro', null, null, 'Financeiro', 'gestor', 760),
  ('financeiro.centros_custo', 'financeiro', 'centros_custo', null, 'Centros de custo', 'gestor', 770),
  ('financeiro.centros_custo.ver', 'financeiro', 'centros_custo', 'ver', 'Consultar centros de custo', 'gestor', 780),
  ('financeiro.centros_custo.criar', 'financeiro', 'centros_custo', 'criar', 'Cadastrar centro de custo', 'gestor', 790),
  ('financeiro.centros_custo.editar', 'financeiro', 'centros_custo', 'editar', 'Editar centro de custo', 'gestor', 800),
  ('financeiro.centros_custo.inativar', 'financeiro', 'centros_custo', 'inativar', 'Ativar/inativar centro de custo', 'gestor', 810),
  ('financeiro.contas_bancarias', 'financeiro', 'contas_bancarias', null, 'Contas bancárias', 'gestor', 820),
  ('financeiro.contas_bancarias.ver', 'financeiro', 'contas_bancarias', 'ver', 'Consultar contas e saldos', 'gestor', 830),
  ('financeiro.contas_bancarias.criar', 'financeiro', 'contas_bancarias', 'criar', 'Cadastrar conta bancária', 'gestor', 840),
  ('financeiro.contas_bancarias.editar', 'financeiro', 'contas_bancarias', 'editar', 'Editar conta bancária', 'gestor', 850),
  ('financeiro.contas_bancarias.inativar', 'financeiro', 'contas_bancarias', 'inativar', 'Bloquear/reativar conta', 'gestor', 860),
  ('financeiro.contas_bancarias.movimentar', 'financeiro', 'contas_bancarias', 'movimentar', 'Lançar entrada/saída', 'gestor', 870),
  ('financeiro.contas_bancarias.transferir', 'financeiro', 'contas_bancarias', 'transferir', 'Transferir entre contas', 'gestor', 880),
  ('usuarios', 'usuarios', null, null, 'Usuários e acesso', 'gestor', 890),
  ('usuarios.usuarios', 'usuarios', 'usuarios', null, 'Usuários', 'gestor', 900),
  ('usuarios.usuarios.ver', 'usuarios', 'usuarios', 'ver', 'Consultar usuários', 'gestor', 910),
  ('usuarios.usuarios.criar', 'usuarios', 'usuarios', 'criar', 'Criar usuário', 'admin', 920),
  ('usuarios.usuarios.editar_acesso', 'usuarios', 'usuarios', 'editar_acesso', 'Alterar papel e filiais', 'admin', 930),
  ('usuarios.perfis', 'usuarios', 'perfis', null, 'Perfis de acesso', 'admin', 940),
  ('usuarios.perfis.ver', 'usuarios', 'perfis', 'ver', 'Consultar perfis', 'admin', 950),
  ('usuarios.perfis.criar', 'usuarios', 'perfis', 'criar', 'Criar perfil', 'admin', 960),
  ('usuarios.perfis.editar', 'usuarios', 'perfis', 'editar', 'Editar perfil e permissões', 'admin', 970),
  ('usuarios.perfis.inativar', 'usuarios', 'perfis', 'inativar', 'Ativar/inativar perfil', 'admin', 980),
  ('integracoes', 'integracoes', null, null, 'Integrações', 'admin', 990),
  ('integracoes.hub', 'integracoes', 'hub', null, 'Hub de integrações', 'admin', 1000),
  ('integracoes.hub.ver', 'integracoes', 'hub', 'ver', 'Consultar integrações', 'admin', 1010),
  ('integracoes.hub.editar', 'integracoes', 'hub', 'editar', 'Ligar/desligar e configurar', 'admin', 1020),
  ('integracoes.hub.rotacionar_token', 'integracoes', 'hub', 'rotacionar_token', 'Rotacionar token de entrada', 'admin', 1030),
  ('tv', 'tv', null, null, 'Painéis de TV', 'gestor', 1040),
  ('tv.tokens', 'tv', 'tokens', null, 'Tokens de exibição', 'gestor', 1050),
  ('tv.tokens.ver', 'tv', 'tokens', 'ver', 'Consultar tokens', 'gestor', 1060),
  ('tv.tokens.criar', 'tv', 'tokens', 'criar', 'Gerar token', 'gestor', 1070),
  ('tv.tokens.revogar', 'tv', 'tokens', 'revogar', 'Revogar token', 'gestor', 1080);

-- -----------------------------------------------------------------------------
-- Perfis de sistema, por tenant
-- -----------------------------------------------------------------------------
-- Criados para cada tenant existente e para os futuros (a função abaixo é
-- reaproveitada no provisionamento). São atribuíveis e não editáveis.
--
-- NOTA sobre "Aprovador N1/N2/N3": o nível de alçada NÃO é atributo do perfil.
-- A mesma pessoa pode ser N1 de um centro de custo e N2 de outro, e amarrar o
-- nível ao perfil forçaria um nível único por pessoa em toda a operação. Aqui
-- existe um perfil "Aprovador Financeiro" (a permissão de aprovar); o nível
-- passa a viver na cadeia de aprovação, junto com a faixa de valor — ver
-- docs/07.
create or replace function app.seed_system_access_profiles(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile record;
begin
  -- Perfis. `on conflict` deixa a função idempotente: rodar de novo num tenant
  -- já provisionado não duplica nem falha.
  insert into public.access_profiles (tenant_id, name, description, base_role, is_system, system_key)
  values
    (p_tenant_id, 'Admin do Cliente',
     'Acesso total ao ambiente do cliente.', 'admin', true, 'admin_cliente'),
    (p_tenant_id, 'Diretoria',
     'Leitura de tudo que o papel gestor alcança, sem escrita.', 'gestor', true, 'diretoria'),
    (p_tenant_id, 'Gestor de TI',
     'Operação de TI completa: helpdesk, inventário, telefonia, mapas, SLA e cadastros.',
     'gestor', true, 'gestor_ti'),
    (p_tenant_id, 'Operador de TI',
     'Atende ticket e consulta inventário e telefonia; não cadastra.', 'atendente', true, 'operador_ti'),
    (p_tenant_id, 'Gestor Financeiro',
     'Financeiro completo, mais fornecedores e leitura de clientes.', 'gestor', true, 'gestor_financeiro'),
    (p_tenant_id, 'Operador Financeiro',
     'Lança movimentação bancária e consulta; não cadastra conta nem transfere.',
     'gestor', true, 'operador_financeiro'),
    (p_tenant_id, 'Aprovador Financeiro',
     'Consulta o financeiro e aprova o que a alçada permitir.', 'gestor', true, 'aprovador_financeiro'),
    (p_tenant_id, 'Visualizador',
     'Somente leitura do que o papel visualizador alcança.', 'visualizador', true, 'visualizador'),
    -- Solicitante precisa de perfil próprio: sem nenhum perfil atribuído,
    -- `has_permission()` é falso em tudo e a pessoa perderia até abrir ticket,
    -- que é a razão dela existir no sistema.
    (p_tenant_id, 'Solicitante',
     'Abre e acompanha os próprios tickets; consulta o que o papel alcança.',
     'solicitante', true, 'solicitante')
  on conflict do nothing;

  -- Concessões. Expressas como REGRA sobre o catálogo, não como lista de
  -- chaves: listar ~108 chaves oito vezes garantiria que a próxima permissão
  -- nova entrasse em alguns perfis e fosse esquecida em outros.
  for v_profile in
    select id, base_role, system_key from public.access_profiles
    where tenant_id = p_tenant_id and is_system
  loop
    insert into public.permission_grants (tenant_id, profile_id, permission_key)
    select p_tenant_id, v_profile.id, c.key
    from public.permission_catalog c
    where app.role_rank(c.min_base_role) <= app.role_rank(v_profile.base_role)
      and case v_profile.system_key
        -- Tudo que o teto alcança.
        when 'admin_cliente' then true

        -- Só leitura: entradas de módulo e de tela (action is null) mais as de
        -- consulta. Sem as de módulo/tela a herança negaria as de consulta.
        when 'diretoria'    then c.action is null or c.action = 'ver'
        when 'visualizador' then c.action is null or c.action = 'ver'

        when 'gestor_ti' then c.module in
          ('helpdesk','inventario','telefonia','mapas','sla','clientes','fornecedores','tv')

        when 'operador_ti' then
          c.module = 'helpdesk'
          or (c.module in ('inventario','telefonia','mapas') and (c.action is null or c.action = 'ver'))

        when 'gestor_financeiro' then
          c.module in ('financeiro','fornecedores')
          or (c.module = 'clientes' and (c.action is null or c.action = 'ver'))
          or c.key in ('sla','sla.compliance','sla.compliance.ver')

        when 'operador_financeiro' then
          c.module = 'financeiro'
          and (c.action is null or c.action in ('ver','movimentar'))

        -- As ações de aprovação chegam com o módulo de contas a pagar; hoje o
        -- perfil concede a consulta, que é o que existe para conceder.
        when 'aprovador_financeiro' then
          c.module = 'financeiro' and (c.action is null or c.action = 'ver')

        -- Tudo que o teto `solicitante` alcança — que é helpdesk mais consulta
        -- de inventário, telefonia e mapas. É o que essa pessoa já faz hoje.
        when 'solicitante' then true

        else false
      end
    on conflict do nothing;
  end loop;
end;
$$;

comment on function app.seed_system_access_profiles(uuid) is
  'Cria (idempotente) os perfis de sistema e suas concessões para um tenant.';

-- Tenant que JÁ existe quando a migração roda (o caso de produção).
do $$
declare
  v_tenant uuid;
begin
  for v_tenant in select id from public.tenants loop
    perform app.seed_system_access_profiles(v_tenant);
  end loop;
end;
$$;

-- E todo tenant FUTURO.
--
-- O loop acima sozinho não bastava: em banco novo as migrações rodam antes de
-- `supabase/seed.sql`, então não havia tenant para iterar e nenhum ambiente
-- nascia com perfil. Pior, um usuário sem perfil tem `has_permission()` falso em
-- tudo — o ambiente subiria com todas as telas negadas e sem pista do motivo.
create or replace function app.tenants_seed_access_profiles()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform app.seed_system_access_profiles(new.id);
  return new;
end;
$$;

create trigger trg_tenants_seed_access_profiles
  after insert on public.tenants
  for each row execute function app.tenants_seed_access_profiles();

/**
 * Usuário novo herda o perfil de sistema do seu papel.
 *
 * Sem isto, quem for criado por `createUserAccount` nasce com
 * `access_profile_id` nulo e portanto sem permissão nenhuma — logaria e não
 * veria tela alguma. Atribuir explicitamente um perfil continua possível: a
 * trigger só age quando o campo vem vazio.
 */
create or replace function app.profiles_default_access_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text;
begin
  if new.access_profile_id is not null or new.tenant_id is null
     or new.role = 'super_admin' then
    return new;
  end if;

  v_key := case new.role
    when 'admin'        then 'admin_cliente'
    when 'gestor'       then 'gestor_ti'
    when 'atendente'    then 'operador_ti'
    when 'visualizador' then 'visualizador'
    when 'solicitante'  then 'solicitante'
    else null
  end;

  if v_key is null then
    return new;
  end if;

  select id into new.access_profile_id
  from public.access_profiles
  where tenant_id = new.tenant_id and system_key = v_key and is_active;

  return new;
end;
$$;

create trigger trg_profiles_default_access_profile
  before insert on public.profiles
  for each row execute function app.profiles_default_access_profile();

-- -----------------------------------------------------------------------------
-- Backfill: ninguém muda de comportamento nesta migração
-- -----------------------------------------------------------------------------
-- Cada usuário recebe o perfil de sistema cujo teto é igual ao papel que ele já
-- tem. `super_admin` fica sem perfil de propósito: é papel da operação da
-- plataforma, não do ambiente do cliente, e `effective_base_role()` devolve o
-- papel puro quando não há perfil.
update public.profiles p
set access_profile_id = ap.id
from public.access_profiles ap
where ap.tenant_id = p.tenant_id
  and ap.is_system
  and p.access_profile_id is null
  and p.role <> 'super_admin'
  and ap.system_key = case p.role
    when 'admin'        then 'admin_cliente'
    when 'gestor'       then 'gestor_ti'
    when 'atendente'    then 'operador_ti'
    when 'visualizador' then 'visualizador'
    when 'solicitante'  then 'solicitante'
    else null
  end;
