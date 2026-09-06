-- =============================================================================
-- 0022 — Conectividade: a tela de Links de Internet ganha permissões
-- =============================================================================
-- Sem DDL de tabela: `internet_links`, `internet_link_attachments`,
-- `link_availability_events` e as views `vw_internet_dashboard` e
-- `vw_connectivity_cost` existem desde a 0013. Faltava a TELA — e é a tela que
-- autoriza as chaves.
--
-- A 0019 deixou isto escrito, dentro do docblock de `app.storage_permission_key`:
--
--   "`links` está deliberadamente FORA. A tabela `internet_link_attachments`
--    existe (0013:496), mas a tela de Links de Internet não existe na aplicação —
--    só no protótipo. Cadastrar `conectividade.links.anexar` agora criaria
--    permissão que não governa tela nenhuma... Entra junto com a tela."
--
-- É esta migração.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Chaves novas no catálogo
-- -----------------------------------------------------------------------------
-- Em sincronia com PERMISSION_CATALOG em src/lib/permissions.ts.
--
-- `sort_order` 481-489 é exatamente o vão livre entre a última chave de telefonia
-- (480) e a primeira de clientes (490) — nove posições para nove chaves. Cabe
-- porque nada em `src/` lê `permission_catalog.sort_order` (a coluna só ordena a
-- listagem no banco) e porque `on conflict do update` permite renumerar depois.
-- Manter a ordem do banco igual à ordem do array em TypeScript evita que a matriz
-- de perfis e o catálogo contem histórias diferentes.
--
-- `registrar_evento` é `gestor`, não `atendente`. A policy de escrita de
-- `link_availability_events` (0013) exige `app.can_manage_records()`, que é gestor
-- para cima; uma chave em `atendente` liberaria o botão e o banco negaria
-- devolvendo zero linhas. Permissão que não governa nada é o defeito que esta base
-- já corrigiu duas vezes — afrouxar a policy é decisão do cliente, não desta
-- migração.
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('conectividade', 'conectividade', null, null,
   'Conectividade', 'visualizador', 481),
  ('conectividade.links', 'conectividade', 'links', null,
   'Links de internet', 'visualizador', 482),
  ('conectividade.links.ver', 'conectividade', 'links', 'ver',
   'Consultar links', 'visualizador', 483),
  ('conectividade.links.criar', 'conectividade', 'links', 'criar',
   'Cadastrar link', 'gestor', 484),
  ('conectividade.links.editar', 'conectividade', 'links', 'editar',
   'Editar link', 'gestor', 485),
  ('conectividade.links.mudar_status', 'conectividade', 'links', 'mudar_status',
   'Suspender/cancelar link', 'gestor', 486),
  ('conectividade.links.registrar_evento', 'conectividade', 'links', 'registrar_evento',
   'Registrar queda ou retorno', 'gestor', 487),
  ('conectividade.links.anexar', 'conectividade', 'links', 'anexar',
   'Anexar contrato ou laudo', 'gestor', 488),
  ('conectividade.links.remover_anexo', 'conectividade', 'links', 'remover_anexo',
   'Remover anexo do link', 'gestor', 489)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

-- -----------------------------------------------------------------------------
-- 2. O bucket passa a aceitar anexo de link
-- -----------------------------------------------------------------------------
-- Só o mapa muda; o predicado `app.can_touch_attachment()` da 0019 continua o
-- mesmo, inclusive negando por omissão para entidade desconhecida.
create or replace function app.storage_permission_key(p_entity text, p_verb text)
returns text
language sql
immutable
as $$
  select case p_entity
    when 'tickets' then case p_verb
      when 'ver'     then 'helpdesk.tickets.ver'
      when 'anexar'  then 'helpdesk.tickets.anexar'
      when 'remover' then 'helpdesk.tickets.remover_anexo'
      else null end
    when 'ativos' then case p_verb
      when 'ver'     then 'inventario.ativos.ver'
      when 'anexar'  then 'inventario.ativos.anexar'
      when 'remover' then 'inventario.ativos.remover_anexo'
      else null end
    when 'linhas' then case p_verb
      when 'ver'     then 'telefonia.linhas.ver'
      when 'anexar'  then 'telefonia.linhas.anexar'
      when 'remover' then 'telefonia.linhas.remover_anexo'
      else null end
    when 'titulos' then case p_verb
      when 'ver'     then 'financeiro.titulos_pagar.ver'
      when 'anexar'  then 'financeiro.titulos_pagar.anexar'
      when 'remover' then 'financeiro.titulos_pagar.remover_anexo'
      else null end
    when 'links' then case p_verb
      when 'ver'     then 'conectividade.links.ver'
      when 'anexar'  then 'conectividade.links.anexar'
      when 'remover' then 'conectividade.links.remover_anexo'
      else null end
    else null
  end;
$$;

-- -----------------------------------------------------------------------------
-- 3. O estado do link passa a ser derivado dos eventos
-- -----------------------------------------------------------------------------
-- `link_availability_events` grava a queda, mas `internet_links.last_state` e
-- `last_state_at` são colunas separadas e NADA as sincronizava — o protótipo fazia
-- isso no cliente. Dois caminhos de escrita (a tela e, no futuro, a Edge Function
-- do Zabbix) divergiriam no primeiro evento vindo de fora da tela.
--
-- A regra é recalculada, não incrementada: "há queda aberta?" responde certo
-- mesmo que os eventos cheguem fora de ordem, que é justamente o que um webhook
-- faz.
--
-- Sem `security definer` de propósito: quem consegue gravar o evento
-- (`can_manage_records`, pela policy da 0013) já consegue atualizar o link pela
-- mesma regra, então não há nada a contornar aqui.
create or replace function app.sync_link_state()
returns trigger
language plpgsql
as $$
declare
  v_link uuid := coalesce(new.link_id, old.link_id);
begin
  update public.internet_links k
     set last_state = case
           when exists (
             select 1 from public.link_availability_events e
             where e.link_id = k.id and e.state = 'down' and e.ended_at is null
           ) then 'down'
           -- Link sem host monitorado nunca é "no ar": é "não monitorado".
           -- Dizer "up" porque ninguém reportou queda seria afirmar o que não se
           -- sabe, e é a distinção que o protótipo já fazia.
           when k.monitoring_host is null or btrim(k.monitoring_host) = '' then 'unknown'
           else 'up'
         end,
         last_state_at = now()
   where k.id = v_link;
  return null;
end;
$$;

comment on function app.sync_link_state() is
  'Mantém internet_links.last_state coerente com os eventos de disponibilidade.';

drop trigger if exists trg_link_event_syncs_state on public.link_availability_events;
create trigger trg_link_event_syncs_state
  after insert or update or delete on public.link_availability_events
  for each row execute function app.sync_link_state();

-- -----------------------------------------------------------------------------
-- 4. Os perfis de sistema precisam conhecer o módulo novo
-- -----------------------------------------------------------------------------
-- ISTO NÃO É FORMALIDADE. As regras de `app.seed_system_access_profiles()` são
-- POR MÓDULO, e `conectividade` não está em nenhuma delas. Sem esta alteração as
-- nove chaves iriam só para Admin do Cliente, Diretoria e Visualizador — e o
-- Gestor de TI, que é exatamente quem cuida de link de internet, não veria a tela.
-- Sintoma: menu faltando, não erro.
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

  -- A descrição de dois perfis mudou junto com o módulo novo; `on conflict do
  -- nothing` acima não atualiza quem já existe, e um texto velho na tela de
  -- perfis é exatamente o tipo de mentira silenciosa que esta base persegue.
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

        -- `conectividade` entra aqui: link de internet é parque de TI.
        when 'gestor_ti' then c.module in
          ('helpdesk','inventario','telefonia','conectividade','mapas','sla',
           'clientes','fornecedores','tv')

        when 'operador_ti' then
          c.module = 'helpdesk'
          or (c.module in ('inventario','telefonia','conectividade','mapas')
              and (c.action is null or c.action = 'ver'))

        when 'gestor_financeiro' then
          c.module in ('financeiro','fornecedores')
          or (c.module = 'clientes' and (c.action is null or c.action = 'ver'))
          or c.key in ('sla','sla.compliance','sla.compliance.ver')

        -- Lançar despesa e anexar comprovante É o trabalho do operador. Aprovar,
        -- pagar e configurar alçada não são — e continuam de fora.
        when 'operador_financeiro' then
          c.module = 'financeiro'
          and (c.action is null
               or c.action in ('ver','movimentar')
               or (c.screen in ('titulos_pagar','titulos_receber')
                   and c.action in ('criar','editar','anexar','remover_anexo')))

        when 'aprovador_financeiro' then
          c.module = 'financeiro'
          and (c.action is null
               or c.action = 'ver'
               or (c.screen = 'titulos_pagar' and c.action = 'aprovar'))

        when 'solicitante' then true

        else false
      end
    on conflict do nothing;
  end loop;
end;
$$;

comment on function app.seed_system_access_profiles(uuid) is
  'Cria os 9 perfis de sistema do tenant e concede as chaves por REGRA sobre o catálogo. Idempotente.';

do $$
declare
  v_tenant uuid;
begin
  for v_tenant in select id from public.tenants loop
    perform app.seed_system_access_profiles(v_tenant);
  end loop;
end;
$$;

commit;
