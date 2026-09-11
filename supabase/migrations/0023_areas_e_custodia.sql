-- =============================================================================
-- 0023 — Áreas da filial e custódia de equipamento ganham tela
-- =============================================================================
-- Sem tabela nova. `branch_areas` existe desde a 0013, `asset_assignments` desde
-- a 0007, as colunas de estado anterior e a view `asset_custody_history` desde a
-- 0013. O que faltava era a interface — e, nesta base, permissão entra junto com
-- a tela que ela governa.
--
-- ALÉM DAS CHAVES, esta migração conserta um acoplamento que tornaria a tela de
-- custódia decorativa. Ver o bloco 2.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Chaves novas no catálogo
-- -----------------------------------------------------------------------------
-- Em sincronia com PERMISSION_CATALOG em src/lib/permissions.ts.
--
-- `clientes.areas` em 591-595: o vão entre `clientes.filiais.inativar` (590) e
-- `fornecedores` (600). A área é subdivisão da filial e a tela mora dentro de
-- `/clientes`, então ela pertence ao módulo `clientes` — e é isso que faz o
-- Gestor de TI recebê-la sem tocar em `app.seed_system_access_profiles()`, cuja
-- regra concede o módulo inteiro. (Há asserção cobrando exatamente isso: supor
-- foi o que deixou `conectividade` fora de todos os perfis na 0022.)
--
-- `custodiar` em 421: livre entre `mudar_status` (420) e `anexar` (422, da 0019).
-- Teto `gestor` — trocar o responsável por um equipamento é ato patrimonial, e
-- quem só atende ticket não deve poder transferir patrimônio.
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('inventario.ativos.custodiar', 'inventario', 'ativos', 'custodiar',
   'Transferir custódia', 'gestor', 421),
  ('clientes.areas', 'clientes', 'areas', null,
   'Áreas da filial', 'gestor', 591),
  ('clientes.areas.ver', 'clientes', 'areas', 'ver',
   'Consultar áreas', 'gestor', 592),
  ('clientes.areas.criar', 'clientes', 'areas', 'criar',
   'Cadastrar área', 'gestor', 593),
  ('clientes.areas.editar', 'clientes', 'areas', 'editar',
   'Editar área', 'gestor', 594),
  ('clientes.areas.inativar', 'clientes', 'areas', 'inativar',
   'Ativar/inativar área', 'gestor', 595)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

-- -----------------------------------------------------------------------------
-- 2. O motivo da custódia: por que a trigger sozinha não bastava
-- -----------------------------------------------------------------------------
-- `app.assets_after_update_history()` (0013:253) lê o motivo de uma VARIÁVEL DE
-- SESSÃO — `current_setting('app.custody_reason', true)` — e o comentário de lá
-- explica a intenção: manter a gravação no banco, para que importação, integração
-- ou SQL direto continuem auditados (antipattern A-06). A intenção continua certa.
--
-- O problema é do outro lado: o cliente Supabase fala com o banco por um POOL de
-- conexões, e não tem como definir um GUC que chegue na mesma transação do
-- `update`. Um `supabase.from('it_assets').update(...)` vindo da tela gravaria
-- TODO evento com motivo `outro`. O campo existiria no formulário e não
-- governaria nada — que é o defeito que esta base já corrigiu três vezes.
--
-- A saída é uma função que faz as duas coisas na MESMA transação. E, já que a
-- trigger passa a receber o motivo de verdade, ela também passa a gravar a
-- observação: `reason_note` existe desde a 0013 e nenhum caminho a preenchia.
create or replace function app.assets_after_update_history()
returns trigger
language plpgsql
as $$
declare
  v_reason text := coalesce(nullif(current_setting('app.custody_reason', true), ''), 'outro');
  v_note   text := nullif(current_setting('app.custody_note', true), '');
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
      reason, reason_note, performed_by
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
      v_note,
      app.current_user_id()
    );
  end if;

  if new.status is distinct from old.status and new.status in ('maintenance','retired','lost') then
    insert into public.asset_assignments (
      tenant_id, asset_id, event_type, user_id, branch_id, branch_area_id,
      previous_user_id, previous_branch_id, previous_area_id,
      reason, reason_note, performed_by
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
      v_note,
      app.current_user_id()
    );
  end if;

  return null;
end;
$$;

/**
 * Transfere a custódia de um ativo.
 *
 * O `is_local => true` de `set_config` é a linha que importa: o valor vale só até
 * o fim desta transação. Sem ele, o motivo informado por uma pessoa ficaria
 * grudado na conexão do pool e seria aplicado à requisição seguinte de outra —
 * um vazamento silencioso que nenhum erro denunciaria.
 *
 * `security invoker` (o padrão): o RLS de `it_assets` continua valendo, e não há
 * nada aqui que a sessão já não possa fazer. A função existe para AGRUPAR a
 * configuração e a escrita numa transação, não para contornar autorização.
 *
 * Devolve o id do ativo, ou NULL quando o RLS negou. Negação do PostgREST volta
 * como zero linhas e nenhum erro; quem chama precisa distinguir isso de sucesso.
 */
create or replace function public.change_asset_custody(
  p_asset_id  uuid,
  p_user_id   uuid    default null,
  p_branch_id uuid    default null,
  p_area_id   uuid    default null,
  p_reason    text    default 'outro',
  p_note      text    default null
)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  perform set_config('app.custody_reason', coalesce(p_reason, 'outro'), true);
  perform set_config('app.custody_note', coalesce(p_note, ''), true);

  update public.it_assets
     set assigned_user_id = p_user_id,
         branch_id        = p_branch_id,
         branch_area_id   = p_area_id
   where id = p_asset_id
     and deleted_at is null
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.change_asset_custody(uuid, uuid, uuid, uuid, text, text) from public;
grant execute on function public.change_asset_custody(uuid, uuid, uuid, uuid, text, text) to authenticated;

comment on function public.change_asset_custody(uuid, uuid, uuid, uuid, text, text) is
  'Troca responsável/filial/área de um ativo com o motivo chegando à trigger de histórico na mesma transação.';

-- -----------------------------------------------------------------------------
-- 3. Fachada RPC das áreas padrão
-- -----------------------------------------------------------------------------
-- `app.fn_seed_branch_areas()` existe desde a 0013 e nunca pôde ser chamada pela
-- aplicação: o PostgREST só expõe `public`. Sem esta fachada, cadastrar 40
-- filiais significaria digitar as mesmas oito áreas 40 vezes — e a divergência de
-- nomes que a tabela existe para evitar entraria pela porta da frente.
--
-- Repetir a lista de áreas no TypeScript seria a segunda cópia da mesma verdade.
create or replace function public.seed_branch_areas(p_branch_id uuid)
returns integer
language sql
as $$
  select app.fn_seed_branch_areas(p_branch_id);
$$;

revoke all on function public.seed_branch_areas(uuid) from public;
grant execute on function public.seed_branch_areas(uuid) to authenticated;

comment on function public.seed_branch_areas(uuid) is
  'Fachada RPC de app.fn_seed_branch_areas. Idempotente: o índice uq_area_name impede duplicar.';

-- -----------------------------------------------------------------------------
-- 4. Perfis de sistema
-- -----------------------------------------------------------------------------
-- A função não muda: as chaves novas caem em `clientes` e `inventario`, módulos
-- que as regras já citam. Mas rodá-la de novo é obrigatório — perfil já
-- provisionado não conhece chave que nasceu depois dele, e o sintoma seria menu
-- e botão ausentes, não erro.
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
