-- =============================================================================
-- 0042 — Mapeamento de integração: versão legível, restauração e simulação
-- =============================================================================
-- É o item M10 da docs/18 §5: "`integration_mapping_versions` guarda o
-- histórico de mapeamento e ninguém o lê".
--
-- O diagnóstico estava certo pela metade. O histórico existe e é gravado por
-- trigger desde a 0013 — o que falta não é só leitura:
--
--   · não havia como EDITAR o mapeamento pela tela (só por SQL);
--   · não havia como VOLTAR para uma versão anterior;
--   · não havia como SABER o que um payload produziria antes de ele chegar.
--
-- E, ao abrir o histórico para ser lido, apareceu um defeito que nunca
-- incomodou ninguém porque ninguém olhava.
--
-- O DEFEITO: UM HISTÓRICO DE ESTADOS QUE NUNCA EXISTIRAM
-- -------------------------------------------------------
-- A trigger da 0013 é `for each row`. Trocar cinco regras de lugar — que é uma
-- edição só, do ponto de vista de quem edita — gravava DEZ versões: cada
-- exclusão e cada inserção intermediária virava uma linha do histórico.
--
-- Nove dessas dez são estados que o mapeamento nunca teve como conjunto
-- coerente. Para uma tabela que ninguém lia, é desperdício; para uma tela de
-- restauração, é uma armadilha — a pessoa escolhe "a versão de ontem" e recebe
-- um mapeamento pela metade, porque pegou o instante entre o `delete` e o
-- `insert`.
--
-- A correção é trocar `for each row` por `for each statement`, com tabelas de
-- transição. Uma instrução, uma versão. Como uma trigger de múltiplos eventos
-- não pode declarar tabela de transição no PostgreSQL, viram três triggers
-- sobre a mesma função.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Uma instrução, uma versão
-- -----------------------------------------------------------------------------
drop trigger if exists trg_mapping_version on public.integration_mappings;

create or replace function app.snapshot_mapping_version()
returns trigger
language plpgsql
as $$
declare
  v_ids uuid[];
  v_int uuid;
begin
  /*
   * A restauração desliga esta trigger de propósito: ela faz `delete` e
   * `insert` para chegar num estado só, e gravaria duas versões para uma
   * decisão. Ela grava a sua própria, com a nota dizendo de onde veio.
   */
  if coalesce(current_setting('app.pular_versao_de_mapeamento', true), 'off') = 'on' then
    return null;
  end if;

  /* A tabela de transição não pode ser referenciada por nome fixo numa função
     que serve aos três eventos — daí o SQL dinâmico. */
  if tg_op = 'DELETE' then
    execute 'select array_agg(distinct integration_id) from antigas' into v_ids;
  else
    execute 'select array_agg(distinct integration_id) from novas' into v_ids;
  end if;

  foreach v_int in array coalesce(v_ids, array[]::uuid[]) loop
    insert into public.integration_mapping_versions
      (tenant_id, integration_id, version, snapshot, note, created_by)
    select
      i.tenant_id,
      v_int,
      coalesce((select max(version) from public.integration_mapping_versions mv
                 where mv.integration_id = v_int), 0) + 1,
      coalesce((select jsonb_agg(to_jsonb(m) - 'id' - 'created_at' - 'updated_at'
                         order by m.target_field)
                  from public.integration_mappings m
                 where m.integration_id = v_int), '[]'::jsonb),
      lower(tg_op),
      app.current_user_id()
    from public.integrations i
    where i.id = v_int;
  end loop;

  return null;
end;
$$;

create trigger trg_mapping_version_ins
  after insert on public.integration_mappings
  referencing new table as novas
  for each statement execute function app.snapshot_mapping_version();

create trigger trg_mapping_version_upd
  after update on public.integration_mappings
  referencing new table as novas
  for each statement execute function app.snapshot_mapping_version();

create trigger trg_mapping_version_del
  after delete on public.integration_mappings
  referencing old table as antigas
  for each statement execute function app.snapshot_mapping_version();

comment on function app.snapshot_mapping_version() is
  'Uma INSTRUÇÃO, uma versão. Por linha, uma edição de cinco regras gravava dez estados que o mapeamento nunca teve.';

-- -----------------------------------------------------------------------------
-- 2. Voltar para uma versão anterior
-- -----------------------------------------------------------------------------
/*
 * `security invoker`: a restauração apaga e reinsere `integration_mappings`, e
 * quem não tem policy de escrita nessa tabela recebe zero linhas apagadas e
 * zero inseridas — como em qualquer outro caminho desta base. Não há aqui uma
 * porta que o resto do sistema não tenha.
 *
 * Por que em SQL e não na Server Action: `delete` + `insert` em duas chamadas
 * separadas deixam uma janela em que o mapeamento está VAZIO. Uma integração
 * recebendo evento nesse instante criaria chamado sem campo nenhum. Dentro de
 * uma função, é uma transação.
 */
create or replace function public.integracao_restaurar_mapeamento(
  p_integration_id uuid,
  p_version integer
)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_snapshot jsonb;
  v_tenant   uuid;
  v_n        integer;
begin
  select v.snapshot, v.tenant_id into v_snapshot, v_tenant
    from public.integration_mapping_versions v
   where v.integration_id = p_integration_id and v.version = p_version;

  if v_snapshot is null then
    raise exception 'versão % não existe para esta integração', p_version
      using errcode = 'no_data_found';
  end if;

  perform set_config('app.pular_versao_de_mapeamento', 'on', true);

  delete from public.integration_mappings where integration_id = p_integration_id;

  insert into public.integration_mappings
    (tenant_id, integration_id, source_path, target_field, transform,
     value_map, default_value, is_required)
  select
    v_tenant, p_integration_id,
    r ->> 'source_path', r ->> 'target_field', r ->> 'transform',
    coalesce(r -> 'value_map', '{}'::jsonb),
    r ->> 'default_value',
    coalesce((r ->> 'is_required')::boolean, false)
  from jsonb_array_elements(v_snapshot) r;

  get diagnostics v_n = row_count;

  perform set_config('app.pular_versao_de_mapeamento', 'off', true);

  /* UMA versão para a restauração inteira, e a nota diz de onde veio — é a
     única linha do histórico que explica a si mesma. */
  insert into public.integration_mapping_versions
    (tenant_id, integration_id, version, snapshot, note, created_by)
  select v_tenant, p_integration_id,
         coalesce(max(version), 0) + 1,
         v_snapshot,
         format('restauração da versão %s', p_version),
         app.current_user_id()
    from public.integration_mapping_versions
   where integration_id = p_integration_id;

  return v_n;
end;
$$;

grant execute on function public.integracao_restaurar_mapeamento(uuid, integer) to authenticated;

comment on function public.integracao_restaurar_mapeamento(uuid, integer) is
  'Troca o mapeamento inteiro pelo de uma versão anterior, numa transação — sem janela com o mapeamento vazio.';

-- -----------------------------------------------------------------------------
-- 3. A permissão de editar o mapeamento
-- -----------------------------------------------------------------------------
/*
 * Chave própria, separada de `editar`. Ligar e desligar uma integração é
 * reversível com um clique; trocar o mapeamento muda silenciosamente o que vira
 * chamado — um `target_field` errado não dá erro, produz chamados com o campo
 * em branco a partir do próximo evento, e o estrago só aparece quando alguém
 * procura um chamado pelo campo que não foi preenchido.
 *
 * A simulação NÃO ganha chave: ela não escreve nada, e `integracoes.hub.ver` já
 * é teto de admin. Uma chave a mais ali seria configuração morta.
 */
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('integracoes.hub.mapear', 'integracoes', 'hub', 'mapear',
   'Editar e restaurar o mapeamento de campos', 'admin', 476)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

commit;
