-- =============================================================================
-- 03 — FUNÇÕES E GATILHOS  (211 funções, 189 gatilhos)
--
-- GERADO — não edite este arquivo.
--
-- Ele é lido do catálogo do PostgreSQL por
-- `scripts/gerar-artefatos-do-banco.py`, a partir de um banco feito só das
-- migrações. A fonte da verdade continua sendo `supabase/migrations/`; isto
-- aqui é o retrato consolidado do que elas produzem, para quem precisa LER o
-- schema inteiro de uma vez em vez de atravessar 64 arquivos.
--
-- Para mudar o schema: migração nova. Para atualizar este arquivo: rode o
-- gerador. `npm test` fica vermelho quando os dois divergem.
-- =============================================================================

-- A ORDEM ENTRE AS FUNÇÕES É ALFABÉTICA, E ELAS CHAMAM UMAS ÀS OUTRAS.
--
-- Função em linguagem SQL tem o corpo validado na criação, então
-- `app.meses_entre` precisaria existir antes de quem a chama — e ordenar
-- 211 funções por dependência é um grafo que muda a cada entrega. O
-- `check_function_bodies = off` adia essa validação para a primeira
-- chamada, que é o que o próprio `pg_dump` faz pelo mesmo motivo.
--
-- O que se perde: um erro de digitação dentro de uma função SQL passa
-- aqui e só aparece ao ser chamada. Isso é aceitável porque estas
-- funções JÁ foram criadas com validação ligada, pelas migrações — este
-- arquivo é um retrato do que passou, não a porta de entrada.
set check_function_bodies = off;

-- NÃO HÁ `procedure` NEM CURSOR EXPLÍCITO NESTE SCHEMA, e não há `package`:
-- package é construção do Oracle e o PostgreSQL não a tem. O equivalente
-- aqui é o esquema `app`, que agrupa as funções de regra e as esconde de
-- `public`.
--
-- Os laços `for ... in select ... loop` do PL/pgSQL são cursores IMPLÍCITOS:
-- o PostgreSQL abre, percorre e fecha sem que ninguém declare. É assim que
-- o fechamento de contagem de inventário percorre os itens. Declarar um
-- cursor à mão só se justificaria para percorrer resultado grande com
-- controle de posição, e não há caso desses aqui.


-- app.aceitar_convite
CREATE OR REPLACE FUNCTION app.aceitar_convite(p_token text, p_nome text, p_senha text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_convite record;
  v_user    uuid;
begin
  /* O `update` que gasta o convite e o lê, numa instrução: conferir antes e
     gravar depois abriria a janela em que dois cliques simultâneos criam duas
     contas com o mesmo e-mail. */
  update public.invites
     set accepted_at = now()
   where token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and accepted_at is null
     and revoked_at is null
     and expires_at > now()
  returning tenant_id, email, role into v_convite;

  if v_convite.tenant_id is null then
    return null;
  end if;

  /* Entre a emissão e o aceite, o endereço pode ter ganhado conta por outro
     caminho. O convite já foi gasto acima — e isso é o certo: ele serviu, só
     não produziu conta. */
  if exists (select 1 from public.profiles where lower(email) = lower(v_convite.email)) then
    return null;
  end if;

  insert into auth.users (id, email, raw_app_meta_data)
  values (gen_random_uuid(), v_convite.email,
          jsonb_build_object('tenant_id', v_convite.tenant_id))
  returning id into v_user;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'auth' and table_name = 'users'
       and column_name = 'encrypted_password'
  ) then
    execute 'update auth.users set encrypted_password = crypt($1, gen_salt(''bf'')) where id = $2'
      using p_senha, v_user;
  end if;

  insert into public.profiles (id, tenant_id, role, full_name, email, is_active)
  values (v_user, v_convite.tenant_id, v_convite.role, btrim(p_nome), v_convite.email, true);

  return v_user;
end;
$function$
;

-- app.agent_reconcile
CREATE OR REPLACE FUNCTION app.agent_reconcile(p_device_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- app.agent_serial_utilizavel
CREATE OR REPLACE FUNCTION app.agent_serial_utilizavel(p_serial text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
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
$function$
;

-- app.aplicar_movimento_de_peca
CREATE OR REPLACE FUNCTION app.aplicar_movimento_de_peca()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_saldo numeric(14,3);
  v_antes numeric(14,3);
  v_peca  text;
begin
  select quantity into v_antes
    from public.part_balances
   where part_id = new.part_id and depot_id = new.depot_id;

  v_saldo := coalesce(v_antes, 0) + new.quantity;

  if v_saldo < 0 then
    select sku || ' — ' || name into v_peca from public.parts where id = new.part_id;
    /* `app.numero_pt` em vez de `to_char` cru: o formato `FM...999` devolve
       "2." para um valor inteiro, e um ponto solto no meio de uma frase em
       português faz a pessoa desconfiar do número em vez da regra. */
    raise exception
      'saldo de % ficaria negativo (% em estoque, movimento de %)',
      coalesce(v_peca, 'peça'),
      app.numero_pt(coalesce(v_antes, 0)),
      app.numero_pt(new.quantity)
      using errcode = '23514',
            constraint = 'part_balances_nao_negativo',
            hint = 'Dê entrada antes, ou corrija a quantidade. Saldo negativo é movimento faltando, não número.';
  end if;

  insert into public.part_balances
    (tenant_id, part_id, depot_id, quantity, last_movement_at, updated_at)
  values (new.tenant_id, new.part_id, new.depot_id, v_saldo, new.created_at, now())
  on conflict (part_id, depot_id) do update
    set quantity = excluded.quantity,
        last_movement_at = excluded.last_movement_at,
        updated_at = now();

  /*
   * Custo médio MÓVEL, e só na entrada paga.
   *
   * Saída não muda custo médio — se mudasse, consumir barato encareceria o que
   * sobrou. Ajuste de contagem também não: a diferença é de quantidade, e
   * atribuir-lhe um preço inventaria um custo que ninguém pagou.
   */
  if new.kind = 'purchase' and new.unit_cost is not null and new.quantity > 0 then
    update public.parts p
       set average_cost = case
             when coalesce(v_antes, 0) <= 0 then new.unit_cost
             else ((coalesce(v_antes, 0) * p.average_cost) + (new.quantity * new.unit_cost))
                  / (coalesce(v_antes, 0) + new.quantity)
           end
     where p.id = new.part_id;
  end if;

  return new;
end;
$function$
;

-- app.assets_after_update_history
CREATE OR REPLACE FUNCTION app.assets_after_update_history()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$
;

-- app.atraso_em_meses
CREATE OR REPLACE FUNCTION app.atraso_em_meses(p_planejado date, p_real date, p_status text)
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$
  select case
    when p_status in ('cancelado', 'cancelada') then 0
    when p_real is not null then 0
    else greatest(app.meses_entre(p_planejado, date_trunc('month', now())::date), 0)
  end;
$function$
;

-- app.attach_audit
CREATE OR REPLACE FUNCTION app.attach_audit(p_table regclass)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_short text := split_part(p_table::text, '.', 2);
begin
  if v_short = '' then
    v_short := p_table::text;
  end if;
  execute format(
    'create trigger trg_%s_audit after insert or update or delete on %s
       for each row execute function app.audit_row()',
    v_short, p_table::text);
end;
$function$
;

-- app.audit_ignored_columns
CREATE OR REPLACE FUNCTION app.audit_ignored_columns()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select array[
    'updated_at','created_at','search_vector',
    'last_seen_at','last_snapshot_hash','last_snapshot_at',
    'views',
    -- 0035: contadores de consumo de IA.
    'gasto_do_mes_centavos','mes_de_referencia','tokens_entrada','tokens_saida'
  ];
$function$
;

-- app.audit_row
CREATE OR REPLACE FUNCTION app.audit_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_old     jsonb;
  v_new     jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_key     text;
  v_tenant  uuid;
  v_entity  text := tg_table_name;
  v_id      text;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_changes := jsonb_build_object('deleted', v_old);
    v_tenant := nullif(v_old ->> 'tenant_id', '')::uuid;
    v_id := v_old ->> 'id';

  elsif tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    v_changes := jsonb_build_object('created', v_new);
    v_tenant := nullif(v_new ->> 'tenant_id', '')::uuid;
    v_id := v_new ->> 'id';

  else
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_tenant := nullif(v_new ->> 'tenant_id', '')::uuid;
    v_id := v_new ->> 'id';

    for v_key in select jsonb_object_keys(v_new) loop
      if v_key = any (app.audit_ignored_columns()) then
        continue;
      end if;
      if v_new -> v_key is distinct from v_old -> v_key then
        v_changes := v_changes || jsonb_build_object(
          v_key, jsonb_build_object('old', v_old -> v_key, 'new', v_new -> v_key));
      end if;
    end loop;

    -- UPDATE que não alterou nada relevante não vira linha de auditoria.
    if v_changes = '{}'::jsonb then
      return null;
    end if;
  end if;

  insert into public.audit_log (tenant_id, actor_id, action, entity_type, entity_id, changes)
  values (v_tenant, app.current_user_id(), lower(tg_op), v_entity, v_id, v_changes);

  return null;
end;
$function$
;

-- app.avisar_conta_existente
CREATE OR REPLACE FUNCTION app.avisar_conta_existente(p_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_perfil record;
begin
  select p.id, p.tenant_id, p.email, p.full_name, p.is_active
    into v_perfil
    from public.profiles p
   where lower(p.email) = lower(btrim(p_email))
   limit 1;

  if v_perfil.id is null then
    return;
  end if;

  /* Mesmo freio da emissão de token: sem ele, esta função vira o caminho para
     inundar a caixa de alguém que já tem conta — justamente o que o resto desta
     migração tenta evitar. */
  if exists (
    select 1 from public.email_outbox
     where kind = 'signup_existing'
       and lower(to_email) = lower(v_perfil.email)
       and created_at > now() - interval '1 hour'
  ) then
    return;
  end if;

  insert into public.email_outbox (tenant_id, to_email, to_name, subject, body_text, kind)
  values (
    v_perfil.tenant_id, v_perfil.email, v_perfil.full_name,
    'Você já tem conta no STI',
    format(
      E'Olá, %s.\n\n'
      'Alguém tentou criar uma conta no STI com este endereço — e ele já tem\n'
      'uma. Se foi você, não precisa cadastrar de novo: é só entrar.\n\n'
      '/login\n\n'
      'Esqueceu a senha? A própria tela de entrada tem o caminho para\n'
      'redefini-la.\n\n'
      'Se não foi você, ignore este e-mail. Nada foi criado e nada mudou na sua\n'
      'conta — este aviso existe só para você saber.\n',
      coalesce(v_perfil.full_name, 'tudo bem')),
    'signup_existing');
end;
$function$
;

-- app.baixar_peca_do_estoque
CREATE OR REPLACE FUNCTION app.baixar_peca_do_estoque()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_depot uuid;
begin
  if new.part_id is null then
    return new;
  end if;

  /* Sem depósito informado, sai do depósito que TEM a peça — e, entre eles, do
     que tem mais. Escolher o primeiro por ordem alfabética zeraria a oficina
     enquanto o galpão está cheio. */
  v_depot := new.depot_id;
  if v_depot is null then
    select depot_id into v_depot
      from public.part_balances
     where part_id = new.part_id and quantity >= new.quantity
     order by quantity desc
     limit 1;
  end if;

  if v_depot is null then
    raise exception 'nenhum depósito tem % desta peça em estoque', new.quantity
      using errcode = '23514',
            constraint = 'part_balances_nao_negativo',
            hint = 'Dê entrada por compra, ou lance a peça como avulsa (sem catálogo).';
  end if;

  insert into public.part_movements
    (tenant_id, part_id, depot_id, kind, quantity, unit_cost, ticket_id, notes)
  values (new.tenant_id, new.part_id, v_depot, 'consumption', -new.quantity,
          nullif(new.unit_cost, 0), new.ticket_id,
          'Baixa automática pelo apontamento de campo');

  return new;
end;
$function$
;

-- app.branches_geocode_staleness
CREATE OR REPLACE FUNCTION app.branches_geocode_staleness()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_address_changed boolean;
  v_coords_changed  boolean;
begin
  v_address_changed :=
       coalesce(new.street, '')             is distinct from coalesce(old.street, '')
    or coalesce(new.street_number, '')      is distinct from coalesce(old.street_number, '')
    or coalesce(new.district, '')           is distinct from coalesce(old.district, '')
    or coalesce(new.postal_code, '')        is distinct from coalesce(old.postal_code, '')
    or coalesce(new.city, '')               is distinct from coalesce(old.city, '')
    or coalesce(new.state, '')              is distinct from coalesce(old.state, '');

  v_coords_changed :=
       new.latitude  is distinct from old.latitude
    or new.longitude is distinct from old.longitude;

  if v_address_changed and not v_coords_changed then
    new.geocode_stale  := (new.latitude is not null);
    new.geocode_status := 'pending';
  elsif v_coords_changed then
    new.geocode_stale := false;
    if new.latitude is not null then
      new.geocode_verified_at := clock_timestamp();
    end if;
  end if;

  return new;
end;
$function$
;

-- app.can_manage_config
CREATE OR REPLACE FUNCTION app.can_manage_config()
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select app.effective_base_role() in ('super_admin','admin');
$function$
;

-- app.can_manage_records
CREATE OR REPLACE FUNCTION app.can_manage_records()
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select app.effective_base_role() in ('super_admin','admin','gestor');
$function$
;

-- app.can_see_branch
CREATE OR REPLACE FUNCTION app.can_see_branch(p_branch_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select app.has_tenant_wide_access()
      or (p_branch_id is not null and p_branch_id = any (app.current_user_branch_ids()));
$function$
;

-- app.can_touch_attachment
CREATE OR REPLACE FUNCTION app.can_touch_attachment(p_name text, p_verb text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'storage', 'pg_temp'
AS $function$
declare
  v_tenant uuid := app.storage_tenant(p_name);
  v_key    text;
begin
  if v_tenant is null or v_tenant <> app.current_tenant_id() then
    return false;
  end if;

  v_key := app.storage_permission_key(app.storage_entity(p_name), p_verb);
  if v_key is null then
    return false;
  end if;

  -- Um caminho completo tem exatamente 3 pastas antes do arquivo. Aceitar menos
  -- deixaria um objeto solto em `{tenant}/tickets/arquivo.pdf`, sem ticket a que
  -- pertencer — anexo órfão que nenhuma tela mostra e nenhuma cota conta.
  if array_length(storage.foldername(p_name), 1) <> 3 then
    return false;
  end if;

  return app.has_permission(v_key);
end;
$function$
;

-- app.can_work_tickets
CREATE OR REPLACE FUNCTION app.can_work_tickets()
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select app.effective_base_role() in ('super_admin','admin','gestor','atendente');
$function$
;

-- app.carimbar_plano_inicial
CREATE OR REPLACE FUNCTION app.carimbar_plano_inicial()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
begin
  if new.plano_id is null then
    new.plano_id := app.plano_de_avaliacao();
  end if;
  return new;
end;
$function$
;

-- app.channel_enfileirar_resposta
CREATE OR REPLACE FUNCTION app.channel_enfileirar_resposta()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_conversa public.channel_conversations;
begin
  if new.visibility <> 'public' or new.deleted_at is not null then
    return new;
  end if;

  /*
   * A trava do eco.
   *
   * O comentário criado por `channel_ingest` tem `source = 'integration'` e
   * carrega o `external_id` da mensagem que o gerou. Reenviá-lo faria a pessoa
   * receber de volta o que ela acabou de escrever — e a confirmação disso
   * geraria outra mensagem, e assim por diante.
   *
   * Conferir `source` sozinho não bastaria: uma integração de tickets (0009)
   * também escreve com `source = 'integration'`, e aquele comentário DEVE sair
   * para o canal. O que distingue é o `external_id`, que só a entrada de canal
   * preenche.
   */
  if new.source = 'integration' and new.external_id is not null then
    return new;
  end if;

  select * into v_conversa from public.channel_conversations
   where ticket_id = new.ticket_id and status = 'aberta'
   limit 1;
  if not found then
    return new;
  end if;

  insert into public.channel_messages (
    tenant_id, channel_id, conversation_id, direction, body, status, comment_id
  ) values (
    new.tenant_id, v_conversa.channel_id, v_conversa.id, 'saida',
    new.body, 'na_fila', new.id
  );

  return new;
end;
$function$
;

-- app.channel_fechar_conversa
CREATE OR REPLACE FUNCTION app.channel_fechar_conversa()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.status in ('closed', 'resolved') and old.status not in ('closed', 'resolved') then
    update public.channel_conversations
       set status = 'fechada'
     where ticket_id = new.id and status = 'aberta';
  end if;
  return new;
end;
$function$
;

-- app.cliente_cria_cenario_oficial
CREATE OR REPLACE FUNCTION app.cliente_cria_cenario_oficial()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  insert into public.it_budget_scenarios (tenant_id, client_id, key, name, description)
  values (new.tenant_id, new.id, 'oficial', 'Oficial',
          'A projeção vigente. É ela que alimenta os indicadores por padrão.')
  on conflict do nothing;
  return new;
end;
$function$
;

-- app.comments_after_insert_first_response
CREATE OR REPLACE FUNCTION app.comments_after_insert_first_response()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$
;

-- app.competencia_fechada
CREATE OR REPLACE FUNCTION app.competencia_fechada(p_client_id uuid, p_competence date)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (
    select 1 from public.it_budget_closings
     where client_id = p_client_id
       and competence = p_competence
       and reopened_at is null
  );
$function$
;

-- app.convidar_para_empresa
CREATE OR REPLACE FUNCTION app.convidar_para_empresa(p_tenant uuid, p_email text, p_role text, p_por uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_token   text;
  v_dias    integer := app.parametro_numerico('invite_days', 7);
  v_papel   text;
  v_empresa text;
begin
  if p_role not in ('admin', 'gestor', 'atendente', 'solicitante') then
    raise exception 'papel desconhecido: %', p_role;
  end if;

  /*
   * NÃO SE CONVIDA PARA ACIMA DO PRÓPRIO PAPEL.
   *
   * Sem isto, um `gestor` convidaria alguém como `admin` e pediria a senha —
   * auto-promoção com um passo a mais. É a mesma regra que
   * `trg_profiles_no_escalation` já aplica na edição de usuário, e ela precisa
   * valer também na porta por onde entram usuários novos.
   */
  select role into v_papel from public.profiles where id = p_por;
  if v_papel is null or app.role_rank(p_role) > app.role_rank(v_papel) then
    raise exception 'não é possível convidar para um papel acima do seu'
      using errcode = 'insufficient_privilege';
  end if;

  /* Endereço que já tem conta, em qualquer empresa: nada a fazer aqui. Quem
     avisa o dono é a aplicação, por e-mail. */
  if exists (select 1 from public.profiles where lower(email) = lower(btrim(p_email))) then
    return null;
  end if;

  /* Convite vivo já existe: devolver o mesmo token seria impossível (só o hash
     ficou guardado), e emitir outro deixaria dois links válidos. */
  if exists (
    select 1 from public.invites
     where tenant_id = p_tenant
       and lower(email) = lower(btrim(p_email))
       and accepted_at is null and revoked_at is null
       and expires_at > now()
  ) then
    return null;
  end if;

  /* Convite vencido ou revogado não bloqueia um novo — mas sai do caminho do
     índice, que só olha os vivos. */
  update public.invites
     set revoked_at = now()
   where tenant_id = p_tenant
     and lower(email) = lower(btrim(p_email))
     and accepted_at is null and revoked_at is null;

  v_token := encode(gen_random_bytes(32), 'hex');
  select name into v_empresa from public.tenants where id = p_tenant;

  insert into public.invites (tenant_id, email, role, token_hash, invited_by, expires_at)
  values (p_tenant, lower(btrim(p_email)), p_role,
          encode(digest(v_token, 'sha256'), 'hex'), p_por,
          now() + make_interval(days => v_dias));

  insert into public.email_outbox (tenant_id, to_email, subject, body_text, kind)
  values (
    p_tenant, lower(btrim(p_email)),
    format('Convite para usar o STI na %s', v_empresa),
    format(
      E'Você foi convidado a usar o STI na empresa %s.\n\n'
      'Abra o endereço abaixo para criar a sua senha e entrar. O convite vale\n'
      'por %s dias e serve uma vez só.\n\n'
      '/convite/%s\n\n'
      'Se você não esperava este convite, ignore este e-mail. Nada foi criado\n'
      'em seu nome, e o convite deixa de valer sozinho.\n',
      v_empresa, v_dias::text, v_token),
    'invite');

  return v_token;
end;
$function$
;

-- app.criar_empresa_em_avaliacao
CREATE OR REPLACE FUNCTION app.criar_empresa_em_avaliacao(p_email text, p_nome text, p_empresa text, p_senha text, p_esferas text[] DEFAULT ARRAY['management'::text])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_tenant uuid;
  v_user   uuid;
  v_slug   text;
  v_dias   integer := app.parametro_numerico('trial_days', 90);
begin
  if not app.parametro_ligado('signup_aberto', true) then
    raise exception 'cadastro público está fechado'
      using errcode = 'check_violation';
  end if;

  /* E-mail já em uso: a aplicação trata ANTES, mandando o aviso de "você já tem
     conta". Aqui é a última tranca, para o caso de duas tentativas simultâneas
     passarem pela verificação da aplicação ao mesmo tempo. */
  if exists (select 1 from public.profiles where lower(email) = lower(btrim(p_email))) then
    raise exception 'e-mail já cadastrado'
      using errcode = 'unique_violation';
  end if;

  /* Um identificador legível e único, derivado do nome. O sufixo aleatório
     evita que duas empresas com o mesmo nome colidam — e colidir aqui travaria
     o cadastro da segunda sem explicação nenhuma para ela. */
  v_slug := regexp_replace(lower(unaccent_simples(btrim(p_empresa))), '[^a-z0-9]+', '-', 'g');
  v_slug := trim(both '-' from left(coalesce(nullif(v_slug, ''), 'empresa'), 40));
  v_slug := v_slug || '-' || substr(encode(gen_random_bytes(4), 'hex'), 1, 6);

  insert into public.tenants (name, slug, status, trial_ends_on, spheres)
  values (btrim(p_empresa), v_slug, 'trial', current_date + v_dias, p_esferas)
  returning id into v_tenant;

  insert into auth.users (id, email, raw_app_meta_data)
  values (gen_random_uuid(), lower(btrim(p_email)),
          jsonb_build_object('tenant_id', v_tenant))
  returning id into v_user;

  /* A senha, só se a coluna existir — ver o cabeçalho. */
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'auth' and table_name = 'users'
       and column_name = 'encrypted_password'
  ) then
    execute 'update auth.users set encrypted_password = crypt($1, gen_salt(''bf'')) where id = $2'
      using p_senha, v_user;
  end if;

  /*
   * `is_active = false`: a conta existe e NÃO entra até confirmar o e-mail.
   * É o mesmo campo que barra conta desativada, e é por isso que ele precisava
   * funcionar antes desta migração existir.
   */
  insert into public.profiles (id, tenant_id, role, full_name, email, is_active)
  values (v_user, v_tenant, 'admin', btrim(p_nome), lower(btrim(p_email)), false);

  return v_user;
end;
$function$
;

-- app.current_access_profile_id
CREATE OR REPLACE FUNCTION app.current_access_profile_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select p.access_profile_id from public.profiles p where p.id = app.current_user_id();
$function$
;

-- app.current_role
CREATE OR REPLACE FUNCTION app."current_role"()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select p.role from public.profiles p where p.id = app.current_user_id();
$function$
;

-- app.current_tenant_id
CREATE OR REPLACE FUNCTION app.current_tenant_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select nullif(app.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid;
$function$
;

-- app.current_user_branch_ids
CREATE OR REPLACE FUNCTION app.current_user_branch_ids()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(array_agg(ub.branch_id), '{}'::uuid[])
  from public.user_branches ub
  where ub.user_id = app.current_user_id();
$function$
;

-- app.current_user_id
CREATE OR REPLACE FUNCTION app.current_user_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select nullif(app.jwt() ->> 'sub', '')::uuid;
$function$
;

-- app.derive_attachment_kind
CREATE OR REPLACE FUNCTION app.derive_attachment_kind()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.kind := case
    when new.mime_type like 'image/%' then 'image'
    when new.mime_type like 'audio/%' then 'audio'
    when new.mime_type like 'video/%' then 'video'
    else 'document'
  end;
  return new;
end;
$function$
;

-- app.desvio_em_meses
CREATE OR REPLACE FUNCTION app.desvio_em_meses(p_planejado date, p_real date, p_status text)
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$
  select case
    when p_status in ('cancelado', 'cancelada') then 0
    when p_real is not null then app.meses_entre(p_planejado, p_real)
    else greatest(app.meses_entre(p_planejado, date_trunc('month', now())::date), 0)
  end;
$function$
;

-- app.devolver_peca_ao_estoque
CREATE OR REPLACE FUNCTION app.devolver_peca_ao_estoque()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_mov record;
begin
  if old.part_id is null then
    return old;
  end if;

  select * into v_mov
    from public.part_movements
   where ticket_id = old.ticket_id and part_id = old.part_id and kind = 'consumption'
   order by created_at desc
   limit 1;

  if found then
    insert into public.part_movements
      (tenant_id, part_id, depot_id, kind, quantity, ticket_id, notes)
    values (old.tenant_id, old.part_id, v_mov.depot_id, 'return', old.quantity, old.ticket_id,
            'Devolução: apontamento removido');
  end if;

  return old;
end;
$function$
;

-- app.effective_base_role
CREATE OR REPLACE FUNCTION app.effective_base_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select case
    when ap.base_role is null then p.role
    when app.role_rank(ap.base_role) < app.role_rank(p.role) then ap.base_role
    else p.role
  end
  from public.profiles p
  left join public.access_profiles ap
    on ap.id = p.access_profile_id and ap.is_active
  where p.id = app.current_user_id();
$function$
;

-- app.eh_competencia
CREATE OR REPLACE FUNCTION app.eh_competencia(p_dia date)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select p_dia is null or extract(day from p_dia) = 1;
$function$
;

-- app.em_vigencia
CREATE OR REPLACE FUNCTION app.em_vigencia()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
  select coalesce(
    (select app.tenant_em_vigencia(t.status, t.trial_ends_on)
       from public.tenants t where t.id = app.current_tenant_id()),
    /* Sem tenant na sessão não há o que barrar: é o caso do `super_admin` da
       plataforma e o das rotas públicas, que têm as próprias trancas. */
    true);
$function$
;

-- app.emitir_token_de_acesso
CREATE OR REPLACE FUNCTION app.emitir_token_de_acesso(p_email text, p_purpose text, p_minutos integer DEFAULT 60)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_perfil  record;
  v_token   text;
  v_assunto text;
  v_corpo   text;
begin
  if p_purpose not in ('password_reset', 'email_confirm') then
    raise exception 'finalidade de token desconhecida: %', p_purpose;
  end if;

  select p.id, p.tenant_id, p.email, p.full_name, p.is_active
    into v_perfil
    from public.profiles p
   where lower(p.email) = lower(btrim(p_email))
   limit 1;

  if v_perfil.id is null then
    return null;
  end if;

  /* Redefinição exige conta ativa; confirmação exige o contrário — ver o
     comentário acima. */
  if p_purpose = 'password_reset' and v_perfil.is_active is not true then
    return null;
  end if;
  if p_purpose = 'email_confirm' and v_perfil.is_active is true then
    /* Já confirmou: não há o que confirmar, e reenviar o link daria a quem
       pediu a confirmação de que a conta existe e está ativa. */
    return null;
  end if;

  if exists (
    select 1 from public.auth_tokens
     where user_id = v_perfil.id
       and purpose = p_purpose
       and created_at > now() - interval '60 seconds'
  ) then
    return null;
  end if;

  update public.auth_tokens
     set used_at = now()
   where user_id = v_perfil.id
     and purpose = p_purpose
     and used_at is null;

  v_token := encode(gen_random_bytes(32), 'hex');

  insert into public.auth_tokens (purpose, token_hash, user_id, tenant_id, email, expires_at)
  values (
    p_purpose,
    encode(digest(v_token, 'sha256'), 'hex'),
    v_perfil.id,
    v_perfil.tenant_id,
    v_perfil.email,
    now() + make_interval(mins => greatest(p_minutos, 5)));

  if p_purpose = 'password_reset' then
    v_assunto := 'Redefinir a sua senha';
    v_corpo := format(
      E'Olá, %s.\n\n'
      'Alguém pediu para redefinir a senha desta conta. Se foi você, abra o\n'
      'endereço abaixo. Ele vale por %s minutos e só funciona uma vez.\n\n'
      '/nova-senha/%s\n\n'
      'Se não foi você, ignore este e-mail: a senha continua a mesma, e este\n'
      'link deixa de valer sozinho. Nada precisa ser feito.\n',
      coalesce(v_perfil.full_name, 'tudo bem'), greatest(p_minutos, 5)::text, v_token);
  else
    v_assunto := 'Confirme o seu e-mail';
    v_corpo := format(
      E'Olá, %s.\n\n'
      'Confirme este endereço para ativar a sua conta no STI. O link vale por\n'
      '%s minutos e só funciona uma vez.\n\n'
      '/confirmar-email/%s\n\n'
      'Enquanto não confirmar, a conta existe e não entra — é assim que\n'
      'garantimos que ninguém cria conta com o endereço de outra pessoa.\n\n'
      'Se você não se cadastrou, ignore este e-mail: sem a confirmação, a conta\n'
      'não serve para nada e é apagada sozinha.\n',
      coalesce(v_perfil.full_name, 'tudo bem'), greatest(p_minutos, 5)::text, v_token);
  end if;

  insert into public.email_outbox (tenant_id, to_email, to_name, subject, body_text, kind)
  values (v_perfil.tenant_id, v_perfil.email, v_perfil.full_name, v_assunto, v_corpo, p_purpose);

  return v_token;
end;
$function$
;

-- app.encerrar_itens_do_contrato
CREATE OR REPLACE FUNCTION app.encerrar_itens_do_contrato()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
begin
  if new.status in ('ended', 'cancelled') and old.status not in ('ended', 'cancelled') then
    update public.rental_contract_items
       set status = case when status = 'delivered' then 'returned' else 'cancelled' end,
           returned_on = case when status = 'delivered' then current_date else returned_on end
     where contract_id = new.id
       and deleted_at is null
       and status in ('reserved', 'delivered');
  end if;
  return new;
end;
$function$
;

-- app.enforce_category_depth
CREATE OR REPLACE FUNCTION app.enforce_category_depth()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_grandparent uuid;
begin
  if new.parent_id is not null then
    select parent_id into v_grandparent from public.ticket_categories where id = new.parent_id;
    if v_grandparent is not null then
      raise exception 'Categorias suportam no máximo 2 níveis (categoria → subcategoria)'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$function$
;

-- app.enforce_cost_center_depth
CREATE OR REPLACE FUNCTION app.enforce_cost_center_depth()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_nivel int := 1;
  v_atual uuid := new.parent_id;
begin
  while v_atual is not null loop
    v_nivel := v_nivel + 1;
    if v_nivel > 3 then
      raise exception 'Centros de custo suportam no máximo 3 níveis'
        using errcode = 'check_violation';
    end if;
    select parent_id into v_atual from public.cost_centers where id = v_atual;
    -- Ciclo: sem esta saída, um pai apontando para um descendente giraria para
    -- sempre e travaria a transação em vez de recusá-la.
    if v_atual = new.id then
      raise exception 'Hierarquia de centro de custo não pode formar ciclo'
        using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end;
$function$
;

-- app.enforce_ticket_attachment_quota
CREATE OR REPLACE FUNCTION app.enforce_ticket_attachment_quota()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$
;

-- app.fechar_contagem_de_inventario
CREATE OR REPLACE FUNCTION app.fechar_contagem_de_inventario()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_item record;
  v_dif  numeric(14,3);
begin
  if new.status <> 'closed' or old.status = 'closed' then
    return new;
  end if;

  if exists (
    select 1 from public.inventory_count_items
     where count_id = new.id and counted_quantity is null
  ) then
    raise exception 'há item sem contagem informada — uma contagem incompleta não ajusta nada'
      using errcode    = '23514',
            constraint = 'inventory_counts_item_sem_contagem',
            hint = 'Informe a quantidade contada de cada item, ou remova o item da contagem.';
  end if;

  for v_item in
    select * from public.inventory_count_items where count_id = new.id
  loop
    v_dif := v_item.counted_quantity - v_item.expected_quantity;
    if v_dif <> 0 then
      insert into public.part_movements
        (tenant_id, part_id, depot_id, kind, quantity, inventory_count_id, notes, created_by)
      values (new.tenant_id, v_item.part_id, new.depot_id, 'adjustment', v_dif, new.id,
              format('Contagem %s: esperado %s, contado %s',
                     new.code,
                     app.numero_pt(v_item.expected_quantity),
                     app.numero_pt(v_item.counted_quantity)),
              new.closed_by);
    end if;
  end loop;

  new.closed_at := now();
  return new;
end;
$function$
;

-- app.fn_add_business_minutes
CREATE OR REPLACE FUNCTION app.fn_add_business_minutes(p_start timestamp with time zone, p_minutes numeric, p_business_hours_id uuid)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_tz        text;
  v_24x7      boolean;
  v_remaining numeric;
  v_day       date;
  v_guard     integer := 0;
  r           record;
  v_win_start timestamptz;
  v_win_end   timestamptz;
  v_cursor    timestamptz;
  v_available numeric;
begin
  if p_start is null or p_minutes is null then
    return null;
  end if;

  if p_business_hours_id is null then
    return p_start + make_interval(mins => p_minutes::int);
  end if;

  select timezone, is_24x7 into v_tz, v_24x7
  from public.business_hours where id = p_business_hours_id;

  if v_tz is null or v_24x7 then
    return p_start + make_interval(mins => p_minutes::int);
  end if;

  v_remaining := greatest(p_minutes, 0);
  v_day := (p_start at time zone v_tz)::date;

  loop
    v_guard := v_guard + 1;
    if v_guard > 3660 then
      raise exception 'fn_add_business_minutes: prazo não alcançado — calendário sem expediente?';
    end if;

    if not exists (
      select 1 from public.business_hours_holidays h
      where h.business_hours_id = p_business_hours_id and h.holiday_date = v_day
    ) then
      for r in
        select starts_at, ends_at
        from public.business_hours_intervals
        where business_hours_id = p_business_hours_id
          and weekday = extract(dow from v_day)::smallint
        order by starts_at
      loop
        v_win_start := (v_day + r.starts_at) at time zone v_tz;
        v_win_end   := (v_day + r.ends_at)   at time zone v_tz;

        -- Antes do expediente, o relógio só começa a contar na abertura.
        v_cursor := greatest(v_win_start, p_start);

        if v_cursor < v_win_end then
          -- Prazo zero: vence na primeira abertura de expediente.
          if v_remaining <= 0 then
            return v_cursor;
          end if;

          v_available := extract(epoch from (v_win_end - v_cursor)) / 60.0;

          if v_remaining <= v_available then
            return v_cursor + make_interval(secs => (v_remaining * 60)::double precision);
          end if;

          v_remaining := v_remaining - v_available;
        end if;
      end loop;
    end if;

    v_day := v_day + 1;
  end loop;
end;
$function$
;

-- app.fn_bulk_transfer_queue
CREATE OR REPLACE FUNCTION app.fn_bulk_transfer_queue(p_ticket_ids uuid[], p_queue_id uuid, p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
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
$function$
;

-- app.fn_business_minutes_between
CREATE OR REPLACE FUNCTION app.fn_business_minutes_between(p_from timestamp with time zone, p_to timestamp with time zone, p_business_hours_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_tz      text;
  v_24x7    boolean;
  v_total   numeric := 0;
  v_day     date;
  v_last    date;
  v_guard   integer := 0;
  r         record;
  v_win_start timestamptz;
  v_win_end   timestamptz;
  v_ov_start  timestamptz;
  v_ov_end    timestamptz;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    return 0;
  end if;

  -- Sem calendário configurado, o comportamento é 24x7 (corrido).
  if p_business_hours_id is null then
    return extract(epoch from (p_to - p_from)) / 60.0;
  end if;

  select timezone, is_24x7 into v_tz, v_24x7
  from public.business_hours where id = p_business_hours_id;

  if v_tz is null or v_24x7 then
    return extract(epoch from (p_to - p_from)) / 60.0;
  end if;

  v_day  := (p_from at time zone v_tz)::date;
  v_last := (p_to   at time zone v_tz)::date;

  while v_day <= v_last loop
    v_guard := v_guard + 1;
    if v_guard > 3660 then           -- ~10 anos: intervalo absurdo, aborta em vez de travar
      raise exception 'fn_business_minutes_between: intervalo excede o limite suportado';
    end if;

    if not exists (
      select 1 from public.business_hours_holidays h
      where h.business_hours_id = p_business_hours_id and h.holiday_date = v_day
    ) then
      for r in
        select starts_at, ends_at
        from public.business_hours_intervals
        where business_hours_id = p_business_hours_id
          and weekday = extract(dow from v_day)::smallint
        order by starts_at
      loop
        -- Converte a janela local do dia para instantes absolutos no tz do calendário.
        v_win_start := (v_day + r.starts_at) at time zone v_tz;
        v_win_end   := (v_day + r.ends_at)   at time zone v_tz;

        v_ov_start := greatest(v_win_start, p_from);
        v_ov_end   := least(v_win_end, p_to);

        if v_ov_end > v_ov_start then
          v_total := v_total + extract(epoch from (v_ov_end - v_ov_start)) / 60.0;
        end if;
      end loop;
    end if;

    v_day := v_day + 1;
  end loop;

  return v_total;
end;
$function$
;

-- app.fn_resolve_sla
CREATE OR REPLACE FUNCTION app.fn_resolve_sla(p_tenant_id uuid, p_client_id uuid, p_branch_id uuid, p_category_id uuid, p_priority_id uuid)
 RETURNS sla_definitions
 LANGUAGE sql
 STABLE
AS $function$
  select d.*
  from public.sla_definitions d
  left join public.sla_contracts c on c.id = d.contract_id
  where d.tenant_id = p_tenant_id
    and d.priority_id = p_priority_id
    and d.is_active
    and (d.category_id is null or d.category_id = p_category_id)
    and (
      d.contract_id is null
      or (
        c.is_active
        and (c.valid_from is null or c.valid_from <= current_date)
        and (c.valid_to   is null or c.valid_to   >= current_date)
        and (
             (c.branch_id is not null and c.branch_id = p_branch_id)
          or (c.branch_id is null and c.client_id = p_client_id)
        )
      )
    )
  order by
    case
      when c.branch_id is not null and d.category_id is not null then 1  -- filial + categoria
      when c.branch_id is not null                              then 2  -- filial
      when c.id is not null and d.category_id is not null       then 3  -- cliente + categoria
      when c.id is not null                                     then 4  -- cliente
      else                                                            5  -- padrão do tenant
    end,
    d.created_at
  limit 1;
$function$
;

-- app.fn_route_ticket
CREATE OR REPLACE FUNCTION app.fn_route_ticket(p_tenant_id uuid, p_category_id uuid DEFAULT NULL::uuid, p_priority_id uuid DEFAULT NULL::uuid, p_branch_id uuid DEFAULT NULL::uuid, p_source_system text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  r                record;
  v_priority_key   text;
  v_parent_id      uuid;
  v_chaves_validas text[] := array['category_id', 'priority_key', 'branch_id', 'source_system'];
begin
  if p_tenant_id is null then
    return null;
  end if;

  select key       into v_priority_key from public.ticket_priorities  where id = p_priority_id;
  select parent_id into v_parent_id    from public.ticket_categories  where id = p_category_id;

  for r in
    select queue_id, conditions
      from public.queue_rules
     where tenant_id = p_tenant_id and is_active
     -- `id` no desempate: duas regras com o mesmo `sort_order` precisam de ordem
     -- estável, senão a mesma base rotearia diferente entre dois planos de query.
     order by sort_order, id
  loop
    continue when r.conditions = '{}'::jsonb;

    continue when exists (
      select 1 from jsonb_object_keys(r.conditions) k
       where k <> all (v_chaves_validas)
    );

    continue when r.conditions ? 'category_id'
      and (r.conditions ->> 'category_id') is distinct from p_category_id::text
      and (r.conditions ->> 'category_id') is distinct from v_parent_id::text;

    continue when r.conditions ? 'priority_key'
      and (r.conditions ->> 'priority_key') is distinct from v_priority_key;

    continue when r.conditions ? 'branch_id'
      and (r.conditions ->> 'branch_id') is distinct from p_branch_id::text;

    continue when r.conditions ? 'source_system'
      and (r.conditions ->> 'source_system') is distinct from p_source_system;

    return r.queue_id;
  end loop;

  return null;
end;
$function$
;

-- app.fn_seed_branch_areas
CREATE OR REPLACE FUNCTION app.fn_seed_branch_areas(p_branch_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
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
$function$
;

-- app.fn_sla_impact_preview
CREATE OR REPLACE FUNCTION app.fn_sla_impact_preview(p_definition_id uuid)
 RETURNS TABLE(affected_open bigint, affected_at_risk bigint, affected_breached bigint)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

-- app.fn_ticket_attachment_usage
CREATE OR REPLACE FUNCTION app.fn_ticket_attachment_usage(p_ticket_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(sum(size_bytes), 0)::bigint
  from public.ticket_attachments
  where ticket_id = p_ticket_id;
$function$
;

-- app.guard_access_profile_assignment
CREATE OR REPLACE FUNCTION app.guard_access_profile_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$
;

-- app.guard_grant_within_base_role
CREATE OR REPLACE FUNCTION app.guard_grant_within_base_role()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$
;

-- app.guard_system_profile
CREATE OR REPLACE FUNCTION app.guard_system_profile()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$
;

-- app.harden_table
CREATE OR REPLACE FUNCTION app.harden_table(p_table regclass)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_name text := p_table::text;
  v_short text := split_part(v_name, '.', greatest(array_length(string_to_array(v_name, '.'), 1), 1));
begin
  execute format('alter table %s enable row level security', v_name);
  -- FORCE garante que nem o dono da tabela escape das policies.
  execute format('alter table %s force row level security', v_name);

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = v_short and column_name = 'updated_at'
  ) then
    execute format(
      'create trigger trg_%s_touch before update on %s
         for each row execute function app.touch_updated_at()',
      v_short, v_name);
  end if;
end;
$function$
;

-- app.has_permission
CREATE OR REPLACE FUNCTION app.has_permission(p_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- app.has_tenant_wide_access
CREATE OR REPLACE FUNCTION app.has_tenant_wide_access()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(app.current_role() in ('super_admin','admin','gestor'), false);
$function$
;

-- app.integration_logs_after_insert
CREATE OR REPLACE FUNCTION app.integration_logs_after_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  update public.integrations
     set request_count = request_count + 1,
         error_count   = error_count + case when new.outcome = 'error' then 1 else 0 end,
         last_sync_at  = greatest(coalesce(last_sync_at, new.created_at), new.created_at),
         updated_at    = now()
   where id = new.integration_id;
  return null;
end;
$function$
;

-- app.is_service_role
CREATE OR REPLACE FUNCTION app.is_service_role()
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(app.jwt() ->> 'role', '') = 'service_role';
$function$
;

-- app.is_super_admin
CREATE OR REPLACE FUNCTION app.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(app.current_role() = 'super_admin', false);
$function$
;

-- app.job_agent_alerts
CREATE OR REPLACE FUNCTION app.job_agent_alerts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- app.job_aggregate_metrics
CREATE OR REPLACE FUNCTION app.job_aggregate_metrics()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- app.job_auto_close
CREATE OR REPLACE FUNCTION app.job_auto_close()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_run_id bigint;
  v_count  integer := 0;
begin
  insert into public.job_runs (job) values ('auto_close') returning id into v_run_id;

  with fechados as (
    update public.tickets t
       set status = 'closed',
           closed_at = now(),
           change_source = 'system'
      from public.tenants tn
     where tn.id = t.tenant_id
       and t.deleted_at is null
       and tn.deleted_at is null
       and t.status = 'resolved'
       and t.resolved_at is not null
       and tn.auto_close_after_days > 0
       and t.resolved_at < now() - make_interval(days => tn.auto_close_after_days)
    returning 1
  )
  select count(*) into v_count from fechados;

  update public.job_runs
     set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;

  return v_count;
end;
$function$
;

-- app.job_contract_alerts
CREATE OR REPLACE FUNCTION app.job_contract_alerts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_run_id bigint;
  v_count  integer := 0;
begin
  insert into public.job_runs (job) values ('contract_alerts') returning id into v_run_id;

  with fontes as (
    -- Contrato de fornecedor
    select sc.tenant_id,
           'contrato_fornecedor'::text as especie,
           sc.id                       as origem_id,
           sc.ends_on                  as termina_em,
           coalesce(nullif(sc.contract_number, ''), s.name) as rotulo,
           s.name                      as parte
      from public.supplier_contracts sc
      join public.suppliers s on s.id = sc.supplier_id
     where sc.is_active and sc.ends_on is not null

    union all

    -- Contrato do link de internet
    select l.tenant_id, 'contrato_link', l.id, l.contract_end,
           coalesce(nullif(l.contract_number, ''), l.carrier_name, 'link'),
           coalesce(l.carrier_name, 'a operadora')
      from public.internet_links l
     where l.status = 'active' and l.contract_end is not null

    union all

    -- Fim da fidelidade: a única das três em que vencer é uma boa notícia.
    select l.tenant_id, 'fidelidade_link', l.id, l.loyalty_until,
           coalesce(nullif(l.contract_number, ''), l.carrier_name, 'link'),
           coalesce(l.carrier_name, 'a operadora')
      from public.internet_links l
     where l.status = 'active' and l.loyalty_until is not null
  ),
  candidatos as (
    select f.*,
           (f.termina_em - current_date) as dias,
           t.contract_alert_days as aviso,
           /* O degrau mais apertado que já se aplica. Ver o cabeçalho. */
           case when (f.termina_em - current_date) <= least(7, t.contract_alert_days)
                then least(7, t.contract_alert_days)
                else t.contract_alert_days
           end as degrau
      from fontes f
      join public.tenants t on t.id = f.tenant_id and t.deleted_at is null
     where f.termina_em - current_date between 0 and t.contract_alert_days
  ),
  alvos as (
    select c.*, p.id as user_id, p.email, p.full_name
      from candidatos c
      join public.profiles p
        on p.tenant_id = c.tenant_id
       and p.is_active
       and p.role in ('gestor', 'admin')
       and p.email is not null
     where app.quer_notificacao(p.id, 'contract_expiring')
  ),
  gravadas as (
    insert into public.email_outbox
      (tenant_id, to_email, to_name, subject, body_text, kind, dedupe_key)
    select
      a.tenant_id, a.email, a.full_name,
      case a.especie
        when 'fidelidade_link' then
          format('[Contratos] Fidelidade de %s termina em %s dia(s)', a.rotulo, a.dias)
        else
          format('[Contratos] %s vence em %s dia(s)', a.rotulo, a.dias)
      end,
      case a.especie
        when 'fidelidade_link' then
          format(
            E'A fidelidade de %s com %s termina em %s (%s dia(s)).\n\n'
            'A partir dessa data, trocar de operadora não tem multa — e é a janela '
            'em que a renegociação costuma render.',
            a.rotulo, a.parte, to_char(a.termina_em, 'DD/MM/YYYY'), a.dias)
        when 'contrato_link' then
          format(
            E'O contrato de %s com %s termina em %s (%s dia(s)).\n\n'
            'Sem renovação, o link pode ser desligado na data.',
            a.rotulo, a.parte, to_char(a.termina_em, 'DD/MM/YYYY'), a.dias)
        else
          format(
            E'O contrato %s com %s termina em %s (%s dia(s)).\n\n'
            'Renovar, renegociar ou encerrar é decisão de alguém, e ela tem prazo.',
            a.rotulo, a.parte, to_char(a.termina_em, 'DD/MM/YYYY'), a.dias)
      end,
      'contract_expiring',
      /* O DESTINATÁRIO entra na chave: o índice de idempotência é
         `(tenant_id, dedupe_key)`, então uma chave sem a pessoa faria o primeiro
         gestor receber e os outros três serem descartados por conflito — em
         silêncio, e sem nada na tela que explicasse por que só um soube. */
      format('contrato:%s:%s:%s:%s:%s',
             a.especie, a.origem_id, a.termina_em, a.degrau, a.user_id)
    from alvos a
    on conflict do nothing
    returning 1
  )
  select count(*) into v_count from gravadas;

  update public.job_runs
     set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;

  return v_count;
end;
$function$
;

-- app.job_link_alerts
CREATE OR REPLACE FUNCTION app.job_link_alerts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_run_id bigint;
  v_count  integer := 0;
  v_n      integer;
begin
  insert into public.job_runs (job) values ('link_alerts') returning id into v_run_id;

  -- 4.1 Caiu e continua caído
  with abertas as (
    select e.id, e.tenant_id, e.link_id, e.started_at, e.note,
           coalesce(nullif(l.carrier_name, ''), 'o link') as operadora,
           b.name as filial,
           floor(extract(epoch from now() - e.started_at) / 60)::integer as minutos
      from public.link_availability_events e
      join public.internet_links l on l.id = e.link_id
      join public.branches b       on b.id = l.branch_id
      join public.tenants t        on t.id = e.tenant_id and t.deleted_at is null
     where e.state = 'down'
       and e.ended_at is null
       and e.started_at <= now() - make_interval(mins => t.link_alert_minutes)
  ),
  alvos as (
    select a.*, p.id as user_id, p.email, p.full_name
      from abertas a
      join public.profiles p
        on p.tenant_id = a.tenant_id
       and p.is_active
       and p.role in ('gestor', 'admin')
       and p.email is not null
     where app.quer_notificacao(p.id, 'link_down')
  ),
  gravadas as (
    insert into public.email_outbox
      (tenant_id, to_email, to_name, subject, body_text, kind, dedupe_key)
    select
      a.tenant_id, a.email, a.full_name,
      format('[Conectividade] %s sem link há %s minuto(s)', a.filial, a.minutos),
      format(
        E'O link de %s em %s está fora do ar desde %s — %s minuto(s).\n\n%s',
        a.operadora, a.filial,
        to_char(a.started_at, 'DD/MM/YYYY HH24:MI'), a.minutos,
        coalesce(a.note, 'Nenhuma observação foi registrada na abertura da queda.')),
      'link_down',
      format('link_down:%s:%s', a.id, a.user_id)
    from alvos a
    on conflict do nothing
    returning 1
  )
  select count(*) into v_n from gravadas;
  v_count := v_count + v_n;

  -- 4.2 Voltou — e só de queda que alguém soube que houve
  with voltas as (
    select e.id, e.tenant_id, e.started_at, e.ended_at, e.duration_seconds,
           coalesce(nullif(l.carrier_name, ''), 'o link') as operadora,
           b.name as filial
      from public.link_availability_events e
      join public.internet_links l on l.id = e.link_id
      join public.branches b       on b.id = l.branch_id
     where e.state = 'down'
       and e.ended_at is not null
       -- Janela curta: este trabalho roda a cada ciclo, e uma volta de três
       -- semanas atrás não é notícia para ninguém.
       and e.ended_at > now() - interval '2 days'
  ),
  alvos as (
    select v.*, p.id as user_id, p.email, p.full_name
      from voltas v
      join public.profiles p
        on p.tenant_id = v.tenant_id
       and p.is_active
       and p.role in ('gestor', 'admin')
       and p.email is not null
     where app.quer_notificacao(p.id, 'link_restored')
       /* Pessoa a pessoa, e não "alguém foi avisado": quem entrou na equipe
          depois da queda receberia um "voltou" sobre algo que, para ela, nunca
          caiu. O par de avisos pertence a quem recebeu o primeiro. */
       and exists (
         select 1 from public.email_outbox o
          where o.tenant_id = v.tenant_id
            and o.dedupe_key = format('link_down:%s:%s', v.id, p.id)
       )
  ),
  gravadas as (
    insert into public.email_outbox
      (tenant_id, to_email, to_name, subject, body_text, kind, dedupe_key)
    select
      a.tenant_id, a.email, a.full_name,
      format('[Conectividade] %s com link de volta', a.filial),
      format(
        E'O link de %s em %s voltou às %s.\n\nA queda durou %s minuto(s), de %s a %s.',
        a.operadora, a.filial,
        to_char(a.ended_at, 'HH24:MI'),
        greatest(round(a.duration_seconds / 60.0)::integer, 1),
        to_char(a.started_at, 'DD/MM HH24:MI'),
        to_char(a.ended_at, 'DD/MM HH24:MI')),
      'link_restored',
      format('link_up:%s:%s', a.id, a.user_id)
    from alvos a
    on conflict do nothing
    returning 1
  )
  select count(*) into v_n from gravadas;
  v_count := v_count + v_n;

  update public.job_runs
     set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;

  return v_count;
end;
$function$
;

-- app.job_purge_auth_tokens
CREATE OR REPLACE FUNCTION app.job_purge_auth_tokens()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_run_id bigint;
  v_count  integer;
begin
  insert into public.job_runs (job) values ('purge_auth_tokens') returning id into v_run_id;

  delete from public.auth_tokens where expires_at < now() - interval '7 days';
  get diagnostics v_count = row_count;

  update public.job_runs
     set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;

  return v_count;
end;
$function$
;

-- app.job_purge_cadastros_abandonados
CREATE OR REPLACE FUNCTION app.job_purge_cadastros_abandonados()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_run_id bigint;
  v_count  integer;
begin
  insert into public.job_runs (job) values ('purge_cadastros') returning id into v_run_id;

  with mortos as (
    delete from public.tenants t
     where t.status = 'trial'
       and t.created_at < now() - interval '7 days'
       /* Nenhuma conta confirmada: se ao menos uma pessoa entrou, a empresa é
          de alguém e não se apaga por inatividade. */
       and not exists (
         select 1 from public.profiles p where p.tenant_id = t.id and p.is_active)
       /* E nenhum chamado: empresa com trabalho dentro não é abandono. */
       and not exists (select 1 from public.tickets k where k.tenant_id = t.id)
    returning t.id)
  select count(*) into v_count from mortos;

  update public.job_runs
     set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;

  return v_count;
end;
$function$
;

-- app.job_purge_convites
CREATE OR REPLACE FUNCTION app.job_purge_convites()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_run_id bigint;
  v_count  integer;
begin
  insert into public.job_runs (job) values ('purge_convites') returning id into v_run_id;

  delete from public.invites
   where accepted_at is null
     and expires_at < now() - interval '30 days';
  get diagnostics v_count = row_count;

  update public.job_runs
     set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;

  return v_count;
end;
$function$
;

-- app.job_purge_metrics
CREATE OR REPLACE FUNCTION app.job_purge_metrics()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- app.job_purge_throttle
CREATE OR REPLACE FUNCTION app.job_purge_throttle()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_run_id bigint;
  v_count  integer;
begin
  insert into public.job_runs (job) values ('purge_throttle') returning id into v_run_id;

  delete from public.request_throttle where janela_inicio < now() - interval '1 day';
  get diagnostics v_count = row_count;

  update public.job_runs
     set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;

  return v_count;
end;
$function$
;

-- app.job_satisfaction_invites
CREATE OR REPLACE FUNCTION app.job_satisfaction_invites()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_run_id bigint;
  v_count  integer := 0;
  v_t      record;
  v_token  text;
begin
  insert into public.job_runs (job) values ('satisfaction_invites') returning id into v_run_id;

  for v_t in
    select t.id, t.tenant_id, t.ticket_number, t.title, p.id as user_id, p.email, p.full_name
      from public.tickets t
      join public.profiles p on p.id = t.requester_id and p.tenant_id = t.tenant_id
      join public.tenants tn on tn.id = t.tenant_id
     where t.deleted_at is null
       and tn.deleted_at is null
       and t.status = 'closed'
       and t.closed_at is not null
       -- Janela de 7 dias: o trabalho não vai varrer o histórico inteiro toda
       -- noite procurando chamado fechado em 2024.
       and t.closed_at > now() - interval '7 days'
       and p.email is not null
       and p.is_active
       and not exists (select 1 from public.ticket_satisfaction s where s.ticket_id = t.id)
       and app.quer_notificacao(p.id, 'satisfaction_invite')
  loop
    v_token := encode(gen_random_bytes(24), 'hex');

    insert into public.ticket_satisfaction (ticket_id, tenant_id, token_hash, expires_at)
    values (v_t.id, v_t.tenant_id,
            encode(digest(v_token, 'sha256'), 'hex'),
            now() + interval '30 days')
    on conflict (ticket_id) do nothing;

    if found then
      insert into public.email_outbox
        (tenant_id, to_email, to_name, subject, body_text, kind, ticket_id, dedupe_key)
      values (
        v_t.tenant_id, v_t.email, v_t.full_name,
        format('Como foi o atendimento do chamado #%s?', v_t.ticket_number),
        format(
          E'Olá, %s.\n\nO chamado #%s — %s — foi encerrado.\n\n'
          'Responda em menos de um minuto, clicando na nota de 1 a 5:\n'
          '/avaliar/%s\n\nO link vale por 30 dias.',
          coalesce(v_t.full_name, 'tudo bem'), v_t.ticket_number, v_t.title, v_token),
        'satisfaction_invite', v_t.id,
        format('csat:%s', v_t.id))
      on conflict do nothing;

      v_count := v_count + 1;
    end if;
  end loop;

  update public.job_runs
     set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;

  return v_count;
end;
$function$
;

-- app.job_sla_alerts
CREATE OR REPLACE FUNCTION app.job_sla_alerts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_run_id bigint;
  v_count  integer := 0;
begin
  insert into public.job_runs (job) values ('sla_alerts') returning id into v_run_id;

  with candidatos as (
    select
      t.id            as ticket_id,
      t.tenant_id,
      t.ticket_number,
      t.title,
      t.assignee_id,
      t.reopened_count,
      app.sla_state(st.resolution_due_at, st.resolved_at, st.resolution_breached,
                    tn.sla_warning_pct, tn.sla_critical_pct, st.started_at) as estado
    from public.tickets t
    join public.sla_tracking st on st.ticket_id = t.id
    join public.tenants tn      on tn.id = t.tenant_id
    where t.deleted_at is null
      and tn.deleted_at is null
      and t.status not in ('resolved', 'closed')
      and st.coverage = 'covered'
      and not st.is_paused
  ),
  alvos as (
    select c.*, p.id as user_id, p.email, p.full_name
    from candidatos c
    join public.profiles p
      on p.tenant_id = c.tenant_id
     and p.is_active
     and (
       -- com responsável: só ele
       (c.assignee_id is not null and p.id = c.assignee_id)
       -- sem responsável: quem pode agir
       or (c.assignee_id is null and p.role in ('gestor', 'admin'))
     )
    where c.estado in ('warning', 'critical', 'breached')
      and p.email is not null
  ),
  gravadas as (
    insert into public.email_outbox
      (tenant_id, to_email, to_name, subject, body_text, kind, ticket_id, dedupe_key)
    select
      a.tenant_id,
      a.email,
      a.full_name,
      case a.estado
        when 'warning'  then format('[SLA] Prazo se aproximando — chamado #%s', a.ticket_number)
        when 'critical' then format('[SLA] Prazo crítico — chamado #%s', a.ticket_number)
        else                 format('[SLA] Prazo ESTOURADO — chamado #%s', a.ticket_number)
      end,
      format(
        E'Chamado #%s — %s\n\n%s\n\nAbra o chamado em /tickets/%s',
        a.ticket_number, a.title,
        case a.estado
          when 'warning'  then 'O prazo de resolução está se aproximando.'
          when 'critical' then 'O prazo de resolução está perto de estourar.'
          else                 'O prazo de resolução foi ultrapassado.'
        end,
        a.ticket_id),
      case a.estado
        when 'warning'  then 'sla_warning'
        when 'critical' then 'sla_critical'
        else                 'sla_breach'
      end,
      a.ticket_id,
      format('sla:%s:%s:%s:%s', a.ticket_id, a.reopened_count, a.estado, a.user_id)
    from alvos a
    where app.quer_notificacao(
            a.user_id,
            case a.estado
              when 'warning'  then 'sla_warning'
              when 'critical' then 'sla_critical'
              else                 'sla_breach'
            end)
    -- A chave única faz o resto: o que já foi enfileirado não entra de novo.
    on conflict do nothing
    returning 1
  )
  select count(*) into v_count from gravadas;

  update public.job_runs
     set finished_at = now(), ok = true, affected = v_count
   where id = v_run_id;

  return v_count;
end;
$function$
;

-- app.job_vigencia_das_assinaturas
CREATE OR REPLACE FUNCTION app.job_vigencia_das_assinaturas()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_run_id    bigint;
  v_avisados  integer := 0;
  v_suspensos integer := 0;
  v_dias      integer := app.parametro_numerico('trial_aviso_dias', 7);
  v_auto      boolean := app.parametro_ligado('suspensao_automatica', true);
  v_t         record;
begin
  insert into public.job_runs (job) values ('vigencia_assinaturas') returning id into v_run_id;

  -- 1. Avisar quem está perto de vencer.
  for v_t in
    select t.id, t.name, t.trial_ends_on, t.trial_ends_on - current_date as faltam
      from public.tenants t
     where t.status = 'trial'
       and t.trial_ends_on is not null
       and t.trial_ends_on >= current_date
       and t.trial_ends_on - current_date <= v_dias
       and not exists (
         select 1 from public.email_outbox o
          where o.tenant_id = t.id
            and o.kind = 'trial_ending'
            and o.created_at > now() - interval '30 days')
  loop
    /* Para TODOS os administradores da empresa, e não só para quem cadastrou:
       quem abriu a conta pode ter saído, e um aviso endereçado a alguém que não
       trabalha mais ali é um aviso que não chega. */
    insert into public.email_outbox (tenant_id, to_email, subject, body_text, kind)
    select t.id, p.email,
      format('A sua avaliação do STI acaba em %s dia(s)', v_t.faltam),
      format(
        E'A avaliação da %s acaba em %s, daqui a %s dia(s).\n\n'
        'Depois disso a equipe continua ENTRANDO e CONSULTANDO tudo normalmente —\n'
        'nada é apagado e nada fica escondido. O que para é o cadastro de coisas\n'
        'novas: abrir chamado, lançar título, registrar medição.\n\n'
        '/assinatura\n\n'
        'Se já combinou a contratação, ignore este aviso.\n',
        t.name, to_char(v_t.trial_ends_on, 'DD/MM/YYYY'), v_t.faltam),
      'trial_ending'
      from public.tenants t
      join public.profiles p on p.tenant_id = t.id and p.role = 'admin' and p.is_active
     where t.id = v_t.id;

    v_avisados := v_avisados + 1;
  end loop;

  -- 2. Suspender quem venceu, se o parâmetro mandar.
  if v_auto then
    for v_t in
      select t.id, t.name from public.tenants t
       where t.status = 'trial'
         and t.trial_ends_on is not null
         and t.trial_ends_on < current_date
    loop
      /* `trial_ends_on` vai a null porque o CHECK da 0060 exige que ele exista
         se, e somente se, o status for `trial`. Sair de `trial` sem limpá-lo
         derrubaria a própria atualização. */
      update public.tenants
         set status = 'suspended', trial_ends_on = null
       where id = v_t.id;

      /* O gatilho da seção 4 já registrou a mudança; aqui se acrescenta o
         MOTIVO, que o gatilho não tem como saber. */
      update public.tenant_status_events
         set motivo = 'Avaliação vencida'
       where tenant_id = v_t.id and para = 'suspended' and motivo is null
         and created_at > now() - interval '1 minute';

      insert into public.email_outbox (tenant_id, to_email, subject, body_text, kind)
      select v_t.id, p.email,
        'A avaliação do STI terminou',
        format(
          E'A avaliação da %s terminou.\n\n'
          'A equipe continua entrando e consultando tudo — nada foi apagado. O que\n'
          'está suspenso é o cadastro de coisas novas, até a contratação.\n\n'
          '/assinatura\n',
          v_t.name),
        'trial_ended'
        from public.profiles p
       where p.tenant_id = v_t.id and p.role = 'admin' and p.is_active;

      v_suspensos := v_suspensos + 1;
    end loop;
  end if;

  update public.job_runs
     set finished_at = now(), ok = true, affected = v_avisados + v_suspensos
   where id = v_run_id;

  return v_avisados + v_suspensos;
end;
$function$
;

-- app.jwt
CREATE OR REPLACE FUNCTION app.jwt()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$function$
;

-- app.kb_rascunho_do_chamado
CREATE OR REPLACE FUNCTION app.kb_rascunho_do_chamado(p_ticket_id uuid)
 RETURNS TABLE(title text, resumo text, body text, category_id uuid)
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_t       public.tickets;
  v_solucao text;
begin
  select * into v_t from public.tickets
   where id = p_ticket_id and deleted_at is null;
  if not found then
    return;  -- zero linhas: o RLS já nega o que não é desta sessão
  end if;

  /*
   * A solução é o último comentário PÚBLICO. O último comentário de todos
   * costuma ser uma nota interna ("fechei, era o cabo"), e o público é o que foi
   * escrito para alguém de fora entender — que é exatamente o registro de que um
   * artigo precisa.
   */
  select c.body into v_solucao
    from public.ticket_comments c
   where c.ticket_id = p_ticket_id
     and c.deleted_at is null
     and c.visibility = 'public'
   order by c.created_at desc
   limit 1;

  return query select
    v_t.title,
    left(coalesce(v_t.description, v_t.title), 300),
    format(
      E'## O problema\n\n%s\n\n## A solução\n\n%s\n\n---\nEscrito a partir do chamado #%s.',
      coalesce(nullif(trim(coalesce(v_t.description, '')), ''), '(descreva o sintoma como quem o relata o descreveria)'),
      coalesce(nullif(trim(coalesce(v_solucao, '')), ''), '(descreva o passo a passo da solução)'),
      v_t.ticket_number),
    v_t.category_id;
end;
$function$
;

-- app.lote_aplicado_nao_reabre
CREATE OR REPLACE FUNCTION app.lote_aplicado_nao_reabre()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if old.status = 'applied' and new.status <> 'applied' then
    raise exception 'lote já aplicado não volta a ser prévia'
      using errcode    = '23514',
            constraint = 'spreadsheet_batches_aplicado_imutavel',
            hint = 'Para corrigir, envie um lote novo com as linhas corrigidas.';
  end if;
  return new;
end;
$function$
;

-- app.meses_entre
CREATE OR REPLACE FUNCTION app.meses_entre(p_de date, p_ate date)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select ((extract(year from p_ate) - extract(year from p_de)) * 12
        + (extract(month from p_ate) - extract(month from p_de)))::integer;
$function$
;

-- app.movimento_de_peca_e_imutavel
CREATE OR REPLACE FUNCTION app.movimento_de_peca_e_imutavel()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  raise exception 'movimento de estoque não se altera nem se exclui'
    using errcode    = '23514',
            constraint = 'part_movements_imutavel',
          hint = 'Lance o movimento contrário: o razão guarda o erro E a correção.';
end;
$function$
;

-- app.mudar_situacao_da_empresa
CREATE OR REPLACE FUNCTION app.mudar_situacao_da_empresa(p_tenant uuid, p_status text, p_motivo text, p_trial_ate date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_papel text;
begin
  select role into v_papel from public.profiles where id = app.current_user_id();
  if v_papel is distinct from 'super_admin' then
    raise exception 'apenas a operação da plataforma muda a situação de uma empresa'
      using errcode = 'insufficient_privilege';
  end if;

  if p_status not in ('trial', 'active', 'suspended', 'cancelled') then
    raise exception 'situação desconhecida: %', p_status;
  end if;

  /* O CHECK da 0060 amarra os dois campos: `trial` exige prazo, e o resto exige
     que não haja. Resolver isso aqui evita que cada chamada tenha de lembrar. */
  update public.tenants
     set status = p_status,
         trial_ends_on = case when p_status = 'trial'
                              then coalesce(p_trial_ate, current_date + app.parametro_numerico('trial_days', 90))
                              else null end
   where id = p_tenant;

  update public.tenant_status_events
     set motivo = p_motivo
   where tenant_id = p_tenant and motivo is null
     and created_at > now() - interval '1 minute';
end;
$function$
;

-- app.numerar_fatura_de_locacao
CREATE OR REPLACE FUNCTION app.numerar_fatura_de_locacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_codigo    text;
  v_base      text;
  v_candidato text;
  v_sufixo    integer := 1;
begin
  /* Número explícito é respeitado: uma importação de histórico traz o número
     que o documento teve, e inventar outro para ele seria reescrever o
     passado. O cálculo só entra quando não veio nada. */
  if new.number is not null and btrim(new.number) <> '' then
    return new;
  end if;

  select c.code into v_codigo
    from public.rental_contracts c
   where c.id = new.contract_id;

  if v_codigo is null then
    raise exception 'contrato % não encontrado para numerar a fatura', new.contract_id;
  end if;

  v_base := v_codigo || '/' || to_char(new.competence, 'YYYYMM');
  v_candidato := v_base;

  /*
   * Procura o primeiro sufixo livre. O laço parece caro e não é: ele só dá mais
   * de uma volta quando a MESMA competência do MESMO contrato já foi faturada e
   * cancelada antes, que é a exceção e não a regra.
   *
   * Ele considera as canceladas de propósito — são elas que seguram o número
   * antigo. O que não entra são as apagadas (`deleted_at`), porque o índice
   * único também não as considera, e divergir dele traria de volta o erro de
   * chave duplicada que esta migração existe para eliminar.
   */
  while exists (
    select 1 from public.rental_invoices
     where tenant_id = new.tenant_id
       and lower(number) = lower(v_candidato)
       and deleted_at is null
  ) loop
    v_sufixo := v_sufixo + 1;
    v_candidato := v_base || '-' || v_sufixo::text;

    /* Um teto, para que um estado impossível vire erro com nome em vez de laço
       infinito segurando a conexão. */
    if v_sufixo > 100 then
      raise exception 'não foi possível numerar a fatura de % em %: 100 tentativas',
        v_codigo, to_char(new.competence, 'MM/YYYY');
    end if;
  end loop;

  new.number := v_candidato;
  return new;
end;
$function$
;

-- app.numero_pt
CREATE OR REPLACE FUNCTION app.numero_pt(p_valor numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select replace(
    rtrim(rtrim(to_char(p_valor, 'FM999999990.999'), '0'), '.'),
    '.', ',');
$function$
;

-- app.orcamento_respeita_fechamento
CREATE OR REPLACE FUNCTION app.orcamento_respeita_fechamento()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_client uuid;
  v_comp   date;
begin
  if tg_op = 'DELETE' then
    v_client := old.client_id;
    v_comp := old.competence;
  else
    v_client := new.client_id;
    v_comp := new.competence;
  end if;

  if app.competencia_fechada(v_client, v_comp) then
    raise exception
      'A competência % está fechada e não aceita alteração. Reabra-a, com motivo, antes de lançar.',
      to_char(v_comp, 'MM/YYYY')
      using errcode = 'check_violation';
  end if;

  /* Mover um lançamento PARA dentro de um mês fechado é a mesma coisa que
     escrever nele — e seria o jeito óbvio de contornar a trava. */
  if tg_op = 'UPDATE' and old.competence is distinct from new.competence
     and app.competencia_fechada(new.client_id, new.competence) then
    raise exception
      'A competência de destino % está fechada.', to_char(new.competence, 'MM/YYYY')
      using errcode = 'check_violation';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$
;

-- app.parametro_ligado
CREATE OR REPLACE FUNCTION app.parametro_ligado(p_chave text, p_padrao boolean)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(
    (select lower(valor) in ('true','t','1','sim') from public.platform_settings where chave = p_chave),
    p_padrao);
$function$
;

-- app.parametro_numerico
CREATE OR REPLACE FUNCTION app.parametro_numerico(p_chave text, p_padrao integer)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(
    (select nullif(regexp_replace(valor, '\D', '', 'g'), '')::integer
       from public.platform_settings where chave = p_chave),
    p_padrao);
$function$
;

-- app.payables_guard
CREATE OR REPLACE FUNCTION app.payables_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_permitido text[];
begin
  if tg_op = 'INSERT' then
    -- Título nasce em draft ou já aprovado (quando não há alçada). Nascer pago
    -- pularia o rastro de aprovação inteiro.
    if new.status not in ('draft', 'pending_approval', 'approved') then
      raise exception 'Título não pode ser criado com situação %', new.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if old.status = new.status then
    -- Edição de conteúdo. Título pago é imutável: alterar valor depois da baixa
    -- descolaria o título da movimentação bancária que o pagou.
    if old.status = 'paid' and (
      new.amount <> old.amount or new.due_on <> old.due_on
      or coalesce(new.supplier_id::text, '') <> coalesce(old.supplier_id::text, '')
    ) then
      raise exception 'Título pago não pode ter valor, vencimento ou fornecedor alterados'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  v_permitido := case old.status
    when 'draft'            then array['pending_approval', 'approved', 'cancelled']
    when 'pending_approval' then array['approved', 'rejected', 'cancelled']
    when 'approved'         then array['scheduled', 'paid', 'cancelled']
    when 'scheduled'        then array['paid', 'approved', 'cancelled']
    when 'rejected'         then array['draft', 'cancelled']
    -- Estorno existe: pagamento errado acontece e a contabilidade precisa
    -- desfazer. Volta para `approved`, não para `draft`, porque a aprovação que
    -- autorizou o pagamento continua válida.
    when 'paid'             then array['approved']
    when 'cancelled'        then array[]::text[]
    else array[]::text[]
  end;

  if not (new.status = any (v_permitido)) then
    raise exception 'Transição de título inválida: % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if new.status = 'approved' and old.status = 'pending_approval' then
    new.approved_at := coalesce(new.approved_at, now());
    new.approved_by := coalesce(new.approved_by, app.current_user_id());
  end if;

  -- Estorno limpa o rastro de pagamento: manter `paid_on` num título que voltou
  -- a "aprovado" faria o relatório contá-lo como pago.
  if old.status = 'paid' and new.status = 'approved' then
    new.paid_on := null;
    new.bank_movement_id := null;
  end if;

  return new;
end;
$function$
;

-- app.pedido_exige_aprovacao
CREATE OR REPLACE FUNCTION app.pedido_exige_aprovacao()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.service_id is not null
     and exists (select 1 from public.service_catalog s
                  where s.id = new.service_id and s.requer_aprovacao)
  then
    new.status := 'waiting_approval';
  end if;
  return new;
end;
$function$
;

-- app.pedido_pausa_sla_ao_nascer
CREATE OR REPLACE FUNCTION app.pedido_pausa_sla_ao_nascer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- app.pedido_registra_aprovacao
CREATE OR REPLACE FUNCTION app.pedido_registra_aprovacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.status = 'waiting_approval' and new.service_id is not null then
    insert into public.service_approvals
      (tenant_id, ticket_id, service_id, requested_by)
    values (new.tenant_id, new.id, new.service_id, new.requester_id)
    on conflict (ticket_id) do nothing;
  end if;
  return null;
end;
$function$
;

-- app.permitir_requisicao
CREATE OR REPLACE FUNCTION app.permitir_requisicao(p_balde text, p_origem text, p_limite integer, p_janela_seg integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_contagem integer;
begin
  if p_origem is null or btrim(p_origem) = '' then
    /*
     * Sem origem identificável, DEIXA PASSAR — e isso é uma escolha.
     *
     * Bloquear seria mais seguro no papel e, na prática, trancaria todo mundo
     * para fora no dia em que o proxy fosse reconfigurado e parasse de mandar o
     * cabeçalho. O limite por conta da 0057 continua valendo, e a ausência de
     * origem fica visível em `vw_throttle_sem_origem`.
     */
    return true;
  end if;

  insert into public.request_throttle (balde, origem, janela_inicio, contagem)
  values (p_balde, p_origem, now(), 1)
  on conflict (balde, origem) do update
    set
      /* Janela vencida: zera e recomeça. Dentro da janela: soma. */
      janela_inicio = case
        when public.request_throttle.janela_inicio < now() - make_interval(secs => p_janela_seg)
          then now()
        else public.request_throttle.janela_inicio
      end,
      contagem = case
        when public.request_throttle.janela_inicio < now() - make_interval(secs => p_janela_seg)
          then 1
        else public.request_throttle.contagem + 1
      end
  returning contagem into v_contagem;

  return v_contagem <= p_limite;
end;
$function$
;

-- app.plano_de_avaliacao
CREATE OR REPLACE FUNCTION app.plano_de_avaliacao()
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
  select id from public.planos
   where is_active
   order by ordem desc
   limit 1;
$function$
;

-- app.pode_aprovar_servico
CREATE OR REPLACE FUNCTION app.pode_aprovar_servico(p_service_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- app.prevent_self_privilege_escalation
CREATE OR REPLACE FUNCTION app.prevent_self_privilege_escalation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if app.is_service_role() or app.current_user_id() is null then
    return new;                                  -- provisionamento pelo backend
  end if;

  if (new.role is distinct from old.role or new.tenant_id is distinct from old.tenant_id)
     and not app.can_manage_config() then
    raise exception 'Apenas administradores podem alterar papel ou tenant de um usuário'
      using errcode = 'insufficient_privilege';
  end if;

  -- Nem mesmo um admin se auto-promove a super_admin (papel da operação do SaaS).
  if new.role = 'super_admin' and old.role <> 'super_admin' and not app.is_super_admin() then
    raise exception 'Papel super_admin só pode ser concedido pela operação da plataforma'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$function$
;

-- app.profiles_default_access_profile
CREATE OR REPLACE FUNCTION app.profiles_default_access_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- app.profundidade_maxima_de_tarefa
CREATE OR REPLACE FUNCTION app.profundidade_maxima_de_tarefa()
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$ select 3; $function$
;

-- app.protect_default_queue
CREATE OR REPLACE FUNCTION app.protect_default_queue()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if tg_op = 'DELETE' then
    if old.is_system_default then
      raise exception 'A fila padrão do sistema não pode ser removida'
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if old.is_system_default then
    if new.name is distinct from old.name then
      raise exception 'A fila padrão do sistema não pode ser renomeada'
        using errcode = 'restrict_violation';
    end if;
    if new.slug is distinct from old.slug then
      raise exception 'O identificador da fila padrão não pode ser alterado'
        using errcode = 'restrict_violation';
    end if;
    if not new.is_active or new.deleted_at is not null then
      raise exception 'A fila padrão do sistema não pode ser desativada'
        using errcode = 'restrict_violation';
    end if;
    if not new.is_system_default then
      raise exception 'A fila padrão não pode deixar de ser padrão'
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$function$
;

-- app.proximo_numero_de_ticket
CREATE OR REPLACE FUNCTION app.proximo_numero_de_ticket(p_tenant_id uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_next bigint;
begin
  update public.tenants
     set ticket_seq = ticket_seq + 1
   where id = p_tenant_id
  returning ticket_seq into v_next;

  return v_next;
end;
$function$
;

-- app.purge_integration_logs
CREATE OR REPLACE FUNCTION app.purge_integration_logs(p_retention_days integer DEFAULT 90)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_deleted integer;
begin
  delete from public.integration_logs
   where created_at < now() - make_interval(days => p_retention_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$
;

-- app.quer_notificacao
CREATE OR REPLACE FUNCTION app.quer_notificacao(p_user_id uuid, p_kind text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(
    (select enabled from public.notification_preferences
      where user_id = p_user_id and kind = p_kind),
    true);
$function$
;

-- app.queue_score
CREATE OR REPLACE FUNCTION app.queue_score(p_priority_weight smallint, p_started timestamp with time zone, p_due timestamp with time zone, p_breached boolean, p_created timestamp with time zone, p_w_criticality smallint, p_w_deadline smallint, p_w_age smallint)
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$
  select
      (p_w_criticality * (coalesce(p_priority_weight, 0) / 100.0))
    + (p_w_deadline * case
         when p_breached then 1.0
         when p_due is null or p_started is null then 0.0
         else least(greatest(
              extract(epoch from (now() - p_started))
              / nullif(extract(epoch from (p_due - p_started)), 0), 0), 1)
       end)
    -- Idade normalizada em janela de 72h: garante que um ticket antigo de baixa
    -- prioridade suba na fila em vez de morrer de inanição (starvation).
    + (p_w_age * least(extract(epoch from (now() - p_created)) / (72 * 3600.0), 1));
$function$
;

-- app.ratear_valor
CREATE OR REPLACE FUNCTION app.ratear_valor(p_total numeric, p_parcelas integer)
 RETURNS numeric[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  v_base  numeric(14,2);
  v_resto numeric(14,2);
  v_centavos integer;
  v_saida numeric[] := array[]::numeric[];
  i integer;
begin
  if p_parcelas < 1 then
    raise exception 'O número de parcelas precisa ser pelo menos 1.';
  end if;

  v_base := trunc(p_total / p_parcelas, 2);
  v_resto := p_total - (v_base * p_parcelas);
  /* Quantas parcelas levam um centavo a mais. `round` porque `v_resto` é
     múltiplo exato de 0,01 e a divisão por 0,01 pode cair em 1,9999…
     dependendo da escala. */
  v_centavos := round(v_resto / 0.01)::integer;

  for i in 1..p_parcelas loop
    v_saida := v_saida || (v_base + case when i <= v_centavos then 0.01 else 0 end);
  end loop;

  return v_saida;
end;
$function$
;

-- app.recalcular_total_da_fatura
CREATE OR REPLACE FUNCTION app.recalcular_total_da_fatura()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_invoice uuid := coalesce(new.invoice_id, old.invoice_id);
begin
  update public.rental_invoices i
     set total = coalesce((
           select sum(x.amount) from public.rental_invoice_items x
            where x.invoice_id = v_invoice
         ), 0)
   where i.id = v_invoice;
  return null;
end;
$function$
;

-- app.recalcular_total_da_ordem
CREATE OR REPLACE FUNCTION app.recalcular_total_da_ordem()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_order uuid := coalesce(new.order_id, old.order_id);
begin
  update public.purchase_orders o
     set total = coalesce(
           (select sum(i.amount) from public.purchase_order_items i where i.order_id = v_order), 0),
         updated_at = now()
   where o.id = v_order;
  return coalesce(new, old);
end;
$function$
;

-- app.receivables_guard
CREATE OR REPLACE FUNCTION app.receivables_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_permitido text[];
begin
  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'open') then
      raise exception 'Título a receber não pode ser criado com situação %', new.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if old.status = new.status then
    return new;
  end if;

  v_permitido := case old.status
    when 'draft'     then array['open', 'cancelled']
    when 'open'      then array['received', 'cancelled']
    when 'received'  then array['open']   -- estorno de baixa
    when 'cancelled' then array[]::text[]
    else array[]::text[]
  end;

  if not (new.status = any (v_permitido)) then
    raise exception 'Transição de título a receber inválida: % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if old.status = 'received' and new.status = 'open' then
    new.received_on := null;
    new.received_amount := null;
    new.bank_movement_id := null;
  end if;

  return new;
end;
$function$
;

-- app.recontar_lote_de_importacao
CREATE OR REPLACE FUNCTION app.recontar_lote_de_importacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_lote uuid := coalesce(new.batch_id, old.batch_id);
begin
  update public.import_batches b
     set total_rows    = (select count(*) from public.import_rows r where r.batch_id = v_lote),
         created_rows  = (select count(*) from public.import_rows r where r.batch_id = v_lote and r.outcome = 'create'),
         updated_rows  = (select count(*) from public.import_rows r where r.batch_id = v_lote and r.outcome = 'update'),
         skipped_rows  = (select count(*) from public.import_rows r where r.batch_id = v_lote and r.outcome = 'skip'),
         rejected_rows = (select count(*) from public.import_rows r where r.batch_id = v_lote and r.outcome = 'reject'),
         updated_at    = now()
   where b.id = v_lote;
  return coalesce(new, old);
end;
$function$
;

-- app.registrar_mudanca_de_status
CREATE OR REPLACE FUNCTION app.registrar_mudanca_de_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
begin
  if new.status is distinct from old.status then
    insert into public.tenant_status_events (tenant_id, de, para, por)
    values (new.id, old.status, new.status, app.current_user_id());
  end if;
  return new;
end;
$function$
;

-- app.required_approval_levels
CREATE OR REPLACE FUNCTION app.required_approval_levels(p_tenant_id uuid, p_amount numeric, p_cost_center_id uuid DEFAULT NULL::uuid, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS integer[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_required boolean;
  v_levels   integer[];
begin
  select payable_approval_required into v_required
  from public.tenants where id = p_tenant_id;

  if not coalesce(v_required, false) then
    return array[]::integer[];
  end if;

  select array_agg(distinct r.level order by r.level) into v_levels
  from public.approval_rules r
  where r.tenant_id = p_tenant_id
    and r.is_active
    and p_amount >= r.min_amount
    and (r.max_amount is null or p_amount <= r.max_amount)
    and (r.cost_center_id is null or r.cost_center_id = p_cost_center_id)
    and (r.branch_id is null or r.branch_id = p_branch_id);

  if v_levels is null or array_length(v_levels, 1) = 0 then
    raise exception
      'Aprovação de títulos está ligada, mas nenhuma faixa de alçada cobre % . Cadastre a alçada em approval_rules ou desligue tenants.payable_approval_required.',
      to_char(p_amount, 'FM999G999G990D00')
      using errcode = 'check_violation';
  end if;

  return v_levels;
end;
$function$
;

-- app.resolve_dashboard_token
CREATE OR REPLACE FUNCTION app.resolve_dashboard_token(p_token text)
 RETURNS TABLE(tenant_id uuid, layout_id uuid, branch_ids uuid[], refresh_seconds smallint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_hash text := encode(digest(p_token, 'sha256'), 'hex');
  v_row  public.dashboard_tokens;
begin
  select * into v_row
  from public.dashboard_tokens t
  where t.token_hash = v_hash
    and t.revoked_at is null
    and (t.expires_at is null or t.expires_at > now());

  if v_row.id is null then
    return;                       -- token inválido: retorna vazio, sem detalhar o motivo
  end if;

  update public.dashboard_tokens set last_used_at = now() where id = v_row.id;

  return query
    select v_row.tenant_id, v_row.layout_id, v_row.branch_ids,
           coalesce((select l.refresh_seconds from public.dashboard_layouts l
                      where l.id = v_row.layout_id), 45::smallint);
end;
$function$
;

-- app.role_rank
CREATE OR REPLACE FUNCTION app.role_rank(p_role text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case p_role
    when 'visualizador' then 0
    when 'solicitante'  then 1
    when 'atendente'    then 2
    when 'gestor'       then 3
    when 'admin'        then 4
    when 'super_admin'  then 5
    else -1                          -- papel desconhecido nunca alcança nada
  end;
$function$
;

-- app.seed_expense_categories
CREATE OR REPLACE FUNCTION app.seed_expense_categories(p_tenant_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  insert into public.expense_categories (tenant_id, code, name, requires_supplier)
  values
    (p_tenant_id, 'pessoas',        'Pessoas',                   false),
    (p_tenant_id, 'equipamentos',   'Equipamentos de TI',        true),
    (p_tenant_id, 'licencas',       'Licenças de software',      true),
    (p_tenant_id, 'impressao',      'Locação de impressora',     true),
    (p_tenant_id, 'materiais',      'Materiais de TI',           true),
    (p_tenant_id, 'servicos',       'Serviços técnicos',         true),
    (p_tenant_id, 'telecom',        'Telefonia e internet',      true),
    (p_tenant_id, 'desenvolvimento','Serviços de desenvolvimento', true),
    (p_tenant_id, 'sistemas',       'Sistemas gerenciais',       true)
  on conflict do nothing;
end;
$function$
;

-- app.seed_system_access_profiles
CREATE OR REPLACE FUNCTION app.seed_system_access_profiles(p_tenant_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
     'Operação de TI completa: helpdesk, inventário, telefonia, conectividade, mapas, SLA, projetos, orçamento de TI e cadastros.',
     'gestor', true, 'gestor_ti'),
    (p_tenant_id, 'Operador de TI',
     'Atende ticket, executa tarefa de projeto e consulta inventário, telefonia e links; não cadastra.',
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

  update public.access_profiles set description =
    'Operação de TI completa: helpdesk, inventário, telefonia, conectividade, mapas, SLA, projetos, orçamento de TI e cadastros.'
   where tenant_id = p_tenant_id and system_key = 'gestor_ti';
  update public.access_profiles set description =
    'Atende ticket, executa tarefa de projeto e consulta inventário, telefonia e links; não cadastra.'
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

        -- `canais` entra aqui: conversa que vira chamado é operação de TI.
        -- `ia` também: sugestão de resposta e de triagem é ferramenta de quem
        -- atende, e o teto `admin` da configuração já a mantém fora do alcance
        -- do gestor.
        -- `auditoria` entra porque quem responde pela operação precisa poder
        -- responder "quem mudou isso" — e o teto `admin` de `trabalhos` já
        -- mantém o agendador fora.
        -- `projetos` entra porque o cronograma de TI é trabalho do gestor de TI.
        -- `gestao` é a tela dele por definição: custo, prazo e entrega juntos.
        -- Do `financeiro`, só o ORÇAMENTO: quem responde pelo custo da TI é ele,
        -- e título a pagar continua sendo de quem paga.
        when 'gestor_ti' then
          c.module in
            ('helpdesk','inventario','telefonia','conectividade','mapas','sla',
             'clientes','fornecedores','tv','autoatendimento','canais','ia',
             'auditoria','projetos','gestao')
          or c.key in ('financeiro','financeiro.orcamento','financeiro.orcamento.ver',
                       'financeiro.orcamento.lancar','financeiro.orcamento.fechar')

        -- O operador lê e RESPONDE conversa — é o trabalho dele. Mas não liga nem
        -- desliga canal: isso guarda credencial. Em projetos, ele atualiza o
        -- andamento do que executou e não mexe no cronograma.
        when 'operador_ti' then
          c.module in ('helpdesk','autoatendimento','ia')
          or (c.module = 'canais' and c.screen is distinct from 'canais')
          or (c.module = 'projetos' and (c.action is null or c.action in ('ver','executar')))
          or (c.module in ('inventario','telefonia','conectividade','mapas')
              and (c.action is null or c.action = 'ver'))

        when 'gestor_financeiro' then
          c.module in ('financeiro','fornecedores')
          or (c.module = 'clientes' and (c.action is null or c.action = 'ver'))
          or (c.module = 'autoatendimento' and (c.action is null or c.action in ('ver','pedir')))
          or c.key in ('sla','sla.compliance','sla.compliance.ver')

        when 'operador_financeiro' then
          (c.module = 'financeiro'
            and (c.action is null
                 or c.action in ('ver','movimentar')
                 or (c.screen in ('titulos_pagar','titulos_receber')
                     and c.action in ('criar','editar','anexar','remover_anexo'))))
          or (c.module = 'autoatendimento' and (c.action is null or c.action in ('ver','pedir')))

        when 'aprovador_financeiro' then
          (c.module = 'financeiro'
            and (c.action is null
                 or c.action = 'ver'
                 or (c.screen = 'titulos_pagar' and c.action = 'aprovar')))
          or (c.module = 'autoatendimento' and (c.action is null or c.action in ('ver','pedir')))

        when 'solicitante' then true

        else false
      end
    on conflict do nothing;
  end loop;
end;
$function$
;

-- app.sincronizar_episodios_de_alerta
CREATE OR REPLACE FUNCTION app.sincronizar_episodios_de_alerta()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_linha record;
  v_mudancas integer := 0;
begin
  for v_linha in select * from public.vw_job_alerts loop
    if v_linha.situacao in ('falhou', 'parou') then
      /* `on conflict do nothing` sem alvo pega a violação do índice parcial: se
         já há episódio aberto para este trabalho, nada acontece — e é isso que
         garante um aviso por episódio mesmo com duas execuções simultâneas. */
      insert into public.job_alert_episodes (job, tipo, detalhe)
      values (
        v_linha.job,
        v_linha.situacao,
        case
          when v_linha.situacao = 'falhou'
            then coalesce(v_linha.ultimo_detalhe, 'A última execução terminou com erro.')
          else format('Sem execução há %s minutos (a tolerância é de %s).',
                      round(v_linha.minutos_desde)::text, v_linha.tolerancia_min::text)
        end)
      on conflict do nothing;
      if found then v_mudancas := v_mudancas + 1; end if;

    elsif v_linha.situacao = 'ok' then
      update public.job_alert_episodes
         set fechado_em = now()
       where job = v_linha.job and fechado_em is null;
      if found then v_mudancas := v_mudancas + 1; end if;
    end if;
  end loop;

  return v_mudancas;
end;
$function$
;

-- app.sla_state
CREATE OR REPLACE FUNCTION app.sla_state(p_due timestamp with time zone, p_done timestamp with time zone, p_breached boolean, p_warning_pct smallint, p_critical_pct smallint, p_started timestamp with time zone)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select case
    when p_due is null                       then 'no_sla'
    when p_breached                          then 'breached'
    when p_done is not null                  then 'met'
    when now() > p_due                       then 'breached'
    when p_started is null                   then 'ok'
    when extract(epoch from (now() - p_started))
         >= extract(epoch from (p_due - p_started)) * (p_critical_pct / 100.0) then 'critical'
    when extract(epoch from (now() - p_started))
         >= extract(epoch from (p_due - p_started)) * (p_warning_pct / 100.0)  then 'warning'
    else 'ok'
  end;
$function$
;

-- app.snapshot_mapping_version
CREATE OR REPLACE FUNCTION app.snapshot_mapping_version()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$
;

-- app.status_is_open
CREATE OR REPLACE FUNCTION app.status_is_open(p_status text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select p_status not in ('resolved', 'closed');
$function$
;

-- app.status_pauses_sla
CREATE OR REPLACE FUNCTION app.status_pauses_sla(p_status text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select p_status in ('waiting_requester', 'waiting_third_party', 'waiting_approval');
$function$
;

-- app.storage_entity
CREATE OR REPLACE FUNCTION app.storage_entity(p_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select (storage.foldername(p_name))[2];
$function$
;

-- app.storage_permission_key
CREATE OR REPLACE FUNCTION app.storage_permission_key(p_entity text, p_verb text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
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
$function$
;

-- app.storage_tenant
CREATE OR REPLACE FUNCTION app.storage_tenant(p_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  v_first text := (storage.foldername(p_name))[1];
begin
  if v_first is null then
    return null;
  end if;
  return v_first::uuid;
exception when invalid_text_representation then
  return null;
end;
$function$
;

-- app.sync_link_state
CREATE OR REPLACE FUNCTION app.sync_link_state()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$
;

-- app.tarefa_valida_hierarquia
CREATE OR REPLACE FUNCTION app.tarefa_valida_hierarquia()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_pai_projeto uuid;
  v_nivel_do_pai integer;
  v_altura_abaixo integer;
  v_teto integer := app.profundidade_maxima_de_tarefa();
begin
  if new.parent_task_id is null then
    return new;
  end if;

  select project_id into v_pai_projeto
    from public.project_tasks
   where id = new.parent_task_id and deleted_at is null;

  if v_pai_projeto is null then
    raise exception 'A tarefa principal escolhida não existe ou foi excluída.'
      using errcode = 'check_violation';
  end if;

  if v_pai_projeto <> new.project_id then
    raise exception 'A tarefa principal precisa ser do mesmo projeto.'
      using errcode = 'check_violation';
  end if;

  /* Ciclo: a tarefa que está sendo salva aparece na cadeia de ascendentes do
     pai escolhido. O `cycle` do CTE protege contra um ciclo já gravado — que
     não deveria existir, e é exatamente por isso que o laço precisa ter teto. */
  if exists (
    with recursive cadeia as (
      select t.id, t.parent_task_id, 1 as nivel
        from public.project_tasks t
       where t.id = new.parent_task_id
      union all
      select t.id, t.parent_task_id, c.nivel + 1
        from public.project_tasks t
        join cadeia c on t.id = c.parent_task_id
       where c.nivel < 64
    )
    select 1 from cadeia where id = new.id
  ) then
    raise exception 'Essa tarefa já está abaixo desta: escolhê-la como principal criaria um ciclo.'
      using errcode = 'check_violation';
  end if;

  /* Nível do pai (1 = raiz). */
  with recursive acima as (
    select t.id, t.parent_task_id, 1 as nivel
      from public.project_tasks t
     where t.id = new.parent_task_id
    union all
    select t.id, t.parent_task_id, a.nivel + 1
      from public.project_tasks t
      join acima a on t.id = a.parent_task_id
     where a.nivel < 64
  )
  select max(nivel) into v_nivel_do_pai from acima;

  /* Altura da subárvore que vem junto com a tarefa sendo movida. Na criação é
     zero, porque ela ainda não tem filhas. */
  with recursive abaixo as (
    select t.id, 0 as nivel
      from public.project_tasks t
     where t.id = new.id and t.deleted_at is null
    union all
    select t.id, a.nivel + 1
      from public.project_tasks t
      join abaixo a on t.parent_task_id = a.id
     where t.deleted_at is null and a.nivel < 64
  )
  select coalesce(max(nivel), 0) into v_altura_abaixo from abaixo;

  if v_nivel_do_pai + 1 + v_altura_abaixo > v_teto then
    raise exception
      'A hierarquia vai até % níveis (principal → subtarefa → subtarefa), e esta escolha passaria disso.',
      v_teto
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$
;

-- app.tenant_cria_categorias
CREATE OR REPLACE FUNCTION app.tenant_cria_categorias()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  perform app.seed_expense_categories(new.id);
  return new;
end;
$function$
;

-- app.tenant_em_vigencia
CREATE OR REPLACE FUNCTION app.tenant_em_vigencia(p_status text, p_trial_ate date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select case
    when p_status = 'active' then true
    when p_status = 'trial'  then coalesce(p_trial_ate, current_date) >= current_date
    else false   -- suspended, cancelled, e o que vier depois
  end;
$function$
;

-- app.tenants_seed_access_profiles
CREATE OR REPLACE FUNCTION app.tenants_seed_access_profiles()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  perform app.seed_system_access_profiles(new.id);
  return new;
end;
$function$
;

-- app.tickets_after_insert_sla
CREATE OR REPLACE FUNCTION app.tickets_after_insert_sla()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_def public.sla_definitions;
  v_bh  uuid;
begin
  v_def := app.fn_resolve_sla(new.tenant_id, new.client_id, new.branch_id,
                              new.category_id, new.priority_id);

  if v_def.id is null then
    -- Sem cobertura: cria o ticket assim mesmo e sinaliza para o relatório de
    -- cobertura. Bloquear a criação inviabilizaria tickets vindos de integração.
    insert into public.sla_tracking (ticket_id, tenant_id, started_at, coverage)
    values (new.id, new.tenant_id, new.created_at, 'uncovered');
    return null;
  end if;

  -- Precedência do calendário: definição > contrato > filial.
  v_bh := coalesce(
    v_def.business_hours_id,
    (select c.business_hours_id from public.sla_contracts c where c.id = v_def.contract_id),
    (select b.business_hours_id from public.branches b where b.id = new.branch_id)
  );

  insert into public.sla_tracking (
    ticket_id, tenant_id, sla_definition_id, business_hours_id,
    first_response_minutes, resolution_minutes,
    started_at, response_due_at, resolution_due_at, coverage
  )
  values (
    new.id, new.tenant_id, v_def.id, v_bh,
    v_def.first_response_minutes, v_def.resolution_minutes,
    new.created_at,
    app.fn_add_business_minutes(new.created_at, v_def.first_response_minutes, v_bh),
    app.fn_add_business_minutes(new.created_at, v_def.resolution_minutes, v_bh),
    'covered'
  );

  return null;
end;
$function$
;

-- app.tickets_after_update_history
CREATE OR REPLACE FUNCTION app.tickets_after_update_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- app.tickets_after_update_sla
CREATE OR REPLACE FUNCTION app.tickets_after_update_sla()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_track   public.sla_tracking;
  v_pause   public.sla_pauses;
  v_paused  numeric;
begin
  select * into v_track from public.sla_tracking where ticket_id = new.id;
  if v_track.ticket_id is null then
    return null;
  end if;

  -- Entrou em estado de espera → abre pausa.
  if app.status_pauses_sla(new.status) and not app.status_pauses_sla(old.status) then
    insert into public.sla_pauses (tenant_id, ticket_id, reason)
    values (new.tenant_id, new.id, new.status)
    on conflict do nothing;

    update public.sla_tracking
       set is_paused = true, updated_at = now()
     where ticket_id = new.id;
  end if;

  -- Saiu do estado de espera → fecha pausa e empurra os prazos.
  if not app.status_pauses_sla(new.status) and app.status_pauses_sla(old.status) then
    update public.sla_pauses
       set ended_at = now()
     where ticket_id = new.id and ended_at is null
    returning * into v_pause;

    if v_pause.id is not null then
      -- Só conta o tempo de pausa que caiu DENTRO do expediente: pausar numa
      -- sexta 18h e retomar segunda 8h não deve gerar crédito nenhum.
      v_paused := app.fn_business_minutes_between(
        v_pause.started_at, v_pause.ended_at, v_track.business_hours_id);

      update public.sla_tracking t
         set paused_minutes = t.paused_minutes + v_paused,
             is_paused = false,
             response_due_at = case
               when t.responded_at is null and t.first_response_minutes is not null
                 then app.fn_add_business_minutes(
                        t.started_at, t.first_response_minutes + t.paused_minutes + v_paused,
                        t.business_hours_id)
               else t.response_due_at end,
             resolution_due_at = case
               when t.resolution_minutes is not null
                 then app.fn_add_business_minutes(
                        t.started_at, t.resolution_minutes + t.paused_minutes + v_paused,
                        t.business_hours_id)
               else t.resolution_due_at end,
             updated_at = now()
       where t.ticket_id = new.id;
    else
      update public.sla_tracking set is_paused = false, updated_at = now() where ticket_id = new.id;
    end if;
  end if;

  -- Primeira resposta registrada no ticket → fecha a medição de TFR.
  if new.first_response_at is not null and old.first_response_at is null then
    update public.sla_tracking
       set responded_at = new.first_response_at,
           response_breached = (response_due_at is not null and new.first_response_at > response_due_at),
           updated_at = now()
     where ticket_id = new.id;
  end if;

  -- Resolução → fecha a medição de TR.
  if new.resolved_at is not null and old.resolved_at is distinct from new.resolved_at then
    update public.sla_tracking
       set resolved_at = new.resolved_at,
           resolution_breached = (resolution_due_at is not null and new.resolved_at > resolution_due_at),
           updated_at = now()
     where ticket_id = new.id;
  end if;

  -- Reabertura limpa a medição de resolução para nova contagem.
  if new.resolved_at is null and old.resolved_at is not null then
    update public.sla_tracking
       set resolved_at = null, resolution_breached = false, updated_at = now()
     where ticket_id = new.id;
  end if;

  return null;
end;
$function$
;

-- app.tickets_before_insert
CREATE OR REPLACE FUNCTION app.tickets_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_next bigint;
begin
  if new.ticket_number is null or new.ticket_number = 0 then
    v_next := app.proximo_numero_de_ticket(new.tenant_id);

    if v_next is null then
      raise exception 'Tenant % inexistente', new.tenant_id using errcode = 'foreign_key_violation';
    end if;
    new.ticket_number := v_next;
  end if;

  -- Filial não informada: deriva do solicitante quando ele tem filial primária.
  -- Precisa vir ANTES do roteamento.
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

  /*
   * Prioridade não informada: a padrão do tenant — a chave `medium`, e na falta
   * dela a de menor `sort_order`.
   *
   * O segundo defeito achado pela mesma tela. `service_catalog.priority_id` é
   * opcional de propósito (nem todo serviço dita prioridade), mas
   * `tickets.priority_id` é NOT NULL. Um serviço cadastrado sem prioridade
   * fazia TODO pedido falhar com "Faltou preencher um campo obrigatório" — uma
   * mensagem sobre um campo que a tela de pedido nem mostra.
   *
   * A fila já tinha esse cuidado desde a 0005; a prioridade não tinha.
   */
  if new.priority_id is null then
    select id into new.priority_id
    from public.ticket_priorities
    where tenant_id = new.tenant_id and is_active
    order by (key = 'medium') desc, sort_order
    limit 1;

    if new.priority_id is null then
      raise exception 'Tenant % não possui prioridade ativa configurada', new.tenant_id
        using errcode = 'not_null_violation';
    end if;
  end if;

  if new.queue_id is null then
    new.queue_id := app.fn_route_ticket(
      new.tenant_id, new.category_id, new.priority_id, new.branch_id, new.source_system);
  end if;

  -- Nenhuma regra casou: fila padrão do sistema (RF-FIL-01).
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

  return new;
end;
$function$
;

-- app.tickets_before_update
CREATE OR REPLACE FUNCTION app.tickets_before_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$
;

-- app.touch_updated_at
CREATE OR REPLACE FUNCTION app.touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at := now();
  return new;
end;
$function$
;

-- app.validar_alcada_de_campo
CREATE OR REPLACE FUNCTION app.validar_alcada_de_campo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_campo record;
  v_custo numeric(14,2);
begin
  if new.status not in ('resolved', 'closed') or old.status in ('resolved', 'closed') then
    return new;
  end if;

  select * into v_campo from public.ticket_field_service where ticket_id = new.id;
  if not found or v_campo.cost_limit is null or v_campo.approved_at is not null then
    return new;
  end if;

  select total_cost into v_custo from public.vw_field_service_cost where ticket_id = new.id;

  if v_custo > v_campo.cost_limit then
    /* Os números saem formatados em pt-BR aqui, e não na tela: esta frase é
       repassada inteira a quem clicou (ver `mensagemDeErro`), e "610.00" no
       meio de uma aplicação em português é o tipo de detalhe que faz a pessoa
       desconfiar do valor em vez do limite. */
    raise exception
      'custo de R$ % ultrapassa a alçada de R$ % — precisa de aprovação antes de fechar',
      replace(to_char(v_custo, 'FM999999990.00'), '.', ','),
      replace(to_char(v_campo.cost_limit, 'FM999999990.00'), '.', ',')
      using errcode = '23514',
            constraint = 'ticket_field_service_alcada',
            hint = 'Aprove o custo na aba de manutenção, ou reduza o apontamento.';
  end if;

  return new;
end;
$function$
;

-- app.validar_fatura
CREATE OR REPLACE FUNCTION app.validar_fatura()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.status is distinct from old.status then
    if (old.status, new.status) not in (
      ('draft', 'issued'),
      ('draft', 'cancelled'),
      ('issued', 'cancelled')
    ) then
      raise exception 'transição de fatura inválida: % → %', old.status, new.status
        using errcode = '23514', constraint = 'rental_invoices_transicao';
    end if;

    /* Emitir fatura de zero é cobrança sem causa: ou faltou medição, ou o
       contrato não teve item no período. Nos dois casos, emitir esconderia o
       problema atrás de um documento. */
    if new.status = 'issued' and new.total <= 0 then
      raise exception 'fatura sem valor não é emitida: confira as medições e os itens do período'
        using errcode = '23514', constraint = 'rental_invoices_total_positivo';
    end if;

    if new.status = 'issued' and new.issued_on is null then
      new.issued_on := current_date;
    end if;
  end if;

  /* Fatura emitida não muda de valor: o documento foi para o cliente. Corrigir
     exige cancelar e refazer, que é o que deixa rastro. */
  if old.status = 'issued' and new.status = 'issued' and new.total is distinct from old.total then
    raise exception 'fatura emitida não muda de valor — cancele e refaça'
      using errcode = '23514', constraint = 'rental_invoices_emitida_imutavel';
  end if;

  return new;
end;
$function$
;

-- app.validar_item_de_contrato
CREATE OR REPLACE FUNCTION app.validar_item_de_contrato()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_status_contrato text;
  v_status_equip    text;
begin
  select status into v_status_contrato
  from public.rental_contracts where id = new.contract_id;

  /* Contrato encerrado ou cancelado não recebe alocação nova. Deixar passar
     criaria cobrança em contrato morto, que ninguém procura e ninguém confere. */
  if tg_op = 'INSERT' and v_status_contrato in ('ended', 'cancelled') then
    raise exception 'contrato % não aceita novos itens', v_status_contrato
      using errcode = '23514', constraint = 'rental_contract_items_contrato_vivo';
  end if;

  select status into v_status_equip
  from public.rental_equipment where id = new.equipment_id;

  if tg_op = 'INSERT' then
    /* Alocar exige a peça na base alocável. O índice único acima já impede a
       dupla alocação; isto aqui pega o resto: máquina em manutenção, extraviada
       ou baixada não entra em contrato. */
    if v_status_equip <> 'available' then
      raise exception 'equipamento não está disponível (está em %)', v_status_equip
        using errcode = '23514',
              constraint = 'rental_contract_items_equipamento_disponivel',
              hint = 'Mova o equipamento para disponível antes de alocá-lo.';
    end if;
  end if;

  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if (old.status, new.status) not in (
      ('reserved', 'delivered'),
      ('reserved', 'cancelled'),
      ('delivered', 'returned')
    ) then
      raise exception 'transição de item inválida: % → %', old.status, new.status
        using errcode = '23514', constraint = 'rental_contract_items_transicao';
    end if;

    /* Entregar exige data e leitura, porque é delas que sai o pró-rata e o
       consumo do período. Aceitar sem elas empurra o problema para o
       fechamento, quando ninguém mais lembra o dia. */
    if new.status = 'delivered' and new.delivered_on is null then
      raise exception 'entrega precisa da data: é dela que sai a cobrança proporcional'
        using errcode = '23514', constraint = 'rental_contract_items_entrega_tem_data';
    end if;
    if new.status = 'returned' and new.returned_on is null then
      raise exception 'devolução precisa da data'
        using errcode = '23514', constraint = 'rental_contract_items_devolucao_tem_data';
    end if;
  end if;

  return new;
end;
$function$
;

-- app.validar_movimento_de_equipamento
CREATE OR REPLACE FUNCTION app.validar_movimento_de_equipamento()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_ok boolean;
begin
  if tg_op = 'INSERT' then
    /* Nascer em qualquer estado seria a porta dos fundos da máquina: cadastrar
       "locado" criaria uma peça em operação sem nunca ter saído da base. */
    if new.status not in ('available', 'maintenance', 'blocked') then
      raise exception 'equipamento novo nasce disponível, em manutenção ou bloqueado — não em %', new.status
        using errcode = '23514', constraint = 'rental_equipment_estado_inicial';
    end if;

    insert into public.rental_equipment_movements
      (tenant_id, equipment_id, kind, to_status, to_depot_id, notes, created_by)
    values (new.tenant_id, new.id, 'status', new.status, new.depot_id, 'Cadastrado', app.current_user_id());
    return new;
  end if;

  if new.status is distinct from old.status then
    /* Fato, não etapa: ver o comentário da tabela de transições. */
    if new.status in ('blocked', 'lost', 'written_off') then
      v_ok := true;
    else
      select exists (
        select 1 from public.rental_equipment_status_transitions t
        where t.from_status = old.status and t.to_status = new.status
      ) into v_ok;
    end if;

    if not v_ok then
      raise exception 'transição de equipamento inválida: % → %', old.status, new.status
        using errcode = '23514',
              constraint = 'rental_equipment_transicao_valida',
              hint = 'As transições possíveis estão em rental_equipment_status_transitions.';
    end if;

    /*
     * Baixar exige o bem parado.
     *
     * É a RN-007 do LTI, e é o que impede o descarte contábil de um ativo que
     * ainda está em campo. As outras pré-condições dela — sem alocação aberta,
     * sem ordem de serviço, sem saldo pendente — entram junto com as tabelas
     * que as tornam verificáveis, nas Fases 3 e 5. Escrevê-las agora, contra
     * tabelas que não existem, seria promessa em forma de código.
     */
    if new.status = 'written_off' and old.status in ('rented', 'reserved', 'in_transit_out') then
      raise exception 'equipamento em contrato não pode ser baixado: recolha antes'
        using errcode = '23514', constraint = 'rental_equipment_baixa_exige_recolha';
    end if;

    insert into public.rental_equipment_movements
      (tenant_id, equipment_id, kind, from_status, to_status, to_depot_id, created_by)
    values (new.tenant_id, new.id, 'status', old.status, new.status, new.depot_id, app.current_user_id());
  end if;

  if new.depot_id is distinct from old.depot_id then
    insert into public.rental_equipment_movements
      (tenant_id, equipment_id, kind, from_depot_id, to_depot_id, created_by)
    values (new.tenant_id, new.id, 'depot', old.depot_id, new.depot_id, app.current_user_id());
  end if;

  if new.blocked is distinct from old.blocked then
    insert into public.rental_equipment_movements
      (tenant_id, equipment_id, kind, notes, created_by)
    values (
      new.tenant_id, new.id, 'block',
      case when new.blocked then coalesce(new.block_reason, 'Bloqueado') else 'Desbloqueado' end,
      app.current_user_id()
    );
  end if;

  if new.meter_reading is distinct from old.meter_reading then
    /* Horímetro não anda para trás. Quando anda, é troca de aparelho ou erro de
       digitação — e os dois precisam de um registro com motivo, não de um
       `update` silencioso que apaga o passado. */
    if new.meter_reading < old.meter_reading then
      raise exception 'leitura de medidor menor que a anterior (% → %)', old.meter_reading, new.meter_reading
        using errcode = '23514', constraint = 'rental_equipment_medidor_nao_retrocede';
    end if;
    insert into public.rental_equipment_movements
      (tenant_id, equipment_id, kind, meter_reading, created_by)
    values (new.tenant_id, new.id, 'meter', new.meter_reading, app.current_user_id());
  end if;

  return new;
end;
$function$
;

-- app.validate_area_branch
CREATE OR REPLACE FUNCTION app.validate_area_branch()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$
;

-- app.validate_timezone
CREATE OR REPLACE FUNCTION app.validate_timezone()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Timezone inválido: %', new.timezone
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$
;

-- app.validate_transfer_pairs
CREATE OR REPLACE FUNCTION app.validate_transfer_pairs()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_grupo record;
begin
  for v_grupo in
    select transfer_group
    from public.bank_account_movements
    where transfer_group is not null
    group by transfer_group
    having count(*) <> 2
        or count(distinct bank_account_id) <> 2
        or count(distinct amount) <> 1
        or count(distinct direction) <> 2
  loop
    raise exception 'Transferência % precisa de duas metades, em contas distintas, de mesmo valor e sentidos opostos',
      v_grupo.transfer_group
      using errcode = 'check_violation';
  end loop;
  return null;
end;
$function$
;

-- public.agent_enroll
CREATE OR REPLACE FUNCTION public.agent_enroll(p_enrollment_token text, p_device jsonb)
 RETURNS TABLE(device_id uuid, device_token text, tenant_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- public.agent_heartbeat
CREATE OR REPLACE FUNCTION public.agent_heartbeat(p_device_token text, p_agent_version text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- public.agent_ingest_inventory
CREATE OR REPLACE FUNCTION public.agent_ingest_inventory(p_device_token text, p_payload jsonb, p_collected_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(status text, asset_id uuid, snapshot_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- public.agent_ingest_metrics
CREATE OR REPLACE FUNCTION public.agent_ingest_metrics(p_device_token text, p_amostras jsonb)
 RETURNS TABLE(status text, aceitas integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- public.agent_set_remote_id
CREATE OR REPLACE FUNCTION public.agent_set_remote_id(p_device_token text, p_remote_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- public.ai_config_utilizavel
CREATE OR REPLACE FUNCTION public.ai_config_utilizavel()
 RETURNS TABLE(enabled boolean, model text, effort text, secret_ref text, sugerir_resposta boolean, sugerir_triagem boolean, redigir_artigo boolean, enviar_notas_internas boolean, tem_orcamento boolean, limite_mensal_centavos integer, gasto_do_mes_centavos integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    s.enabled,
    s.model,
    s.effort,
    s.secret_ref,
    s.sugerir_resposta,
    s.sugerir_triagem,
    s.redigir_artigo,
    s.enviar_notas_internas,
    /* Mês velho conta como zero gasto: a virada acontece na leitura e na
       escrita, porque as duas podem ser a primeira do mês. */
    case
      when s.mes_de_referencia < date_trunc('month', now())::date then true
      else s.gasto_do_mes_centavos < s.limite_mensal_centavos
    end,
    s.limite_mensal_centavos,
    case
      when s.mes_de_referencia < date_trunc('month', now())::date then 0
      else s.gasto_do_mes_centavos
    end
  from public.ai_settings s
  where s.tenant_id = app.current_tenant_id();
$function$
;

-- public.ai_contexto_do_chamado
CREATE OR REPLACE FUNCTION public.ai_contexto_do_chamado(p_ticket_id uuid)
 RETURNS TABLE(title text, description text, category_name text, priority_name text, status text, cliente text, comentarios jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with cfg as (
    select coalesce(
      (select s.enviar_notas_internas from public.ai_settings s
        where s.tenant_id = app.current_tenant_id()),
      false
    ) as notas
  )
  select
    t.title,
    t.description,
    c.name,
    /* `label`, e não `name`: é como a coluna de `ticket_priorities` se chama
       desde a 0002. */
    p.label,
    t.status,
    cl.trade_name,
    coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'autor', case when cm.visibility = 'public' then 'equipe ou cliente'
                                 else 'nota interna' end,
                   'texto', cm.body
                 )
                 order by cm.created_at
               )
          from public.ticket_comments cm, cfg
         where cm.ticket_id = t.id
           and cm.deleted_at is null
           /* A trava. Nota interna só entra se o tenant tiver pedido. */
           and (cm.visibility = 'public' or cfg.notas)
      ),
      '[]'::jsonb
    )
  from public.tickets t
  left join public.ticket_categories c on c.id = t.category_id
  left join public.ticket_priorities p on p.id = t.priority_id
  left join public.clients cl on cl.id = t.client_id
  where t.id = p_ticket_id and t.deleted_at is null;
$function$
;

-- public.ai_registrar_uso
CREATE OR REPLACE FUNCTION public.ai_registrar_uso(p_tenant_id uuid, p_tokens_entrada integer, p_tokens_saida integer, p_centavos integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_mes date := date_trunc('month', now())::date;
begin
  update public.ai_settings s
     set gasto_do_mes_centavos =
           case when s.mes_de_referencia < v_mes then 0 else s.gasto_do_mes_centavos end
           + greatest(p_centavos, 0),
         mes_de_referencia = v_mes,
         tokens_entrada = s.tokens_entrada + greatest(p_tokens_entrada, 0),
         tokens_saida   = s.tokens_saida   + greatest(p_tokens_saida, 0)
   where s.tenant_id = p_tenant_id;
end;
$function$
;

-- public.armor
CREATE OR REPLACE FUNCTION public.armor(bytea)
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_armor$function$
;

-- public.armor
CREATE OR REPLACE FUNCTION public.armor(bytea, text[], text[])
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_armor$function$
;

-- public.cash_flow_projection
CREATE OR REPLACE FUNCTION public.cash_flow_projection(p_months integer DEFAULT 12, p_delinquency_rate numeric DEFAULT 0, p_branch_id uuid DEFAULT NULL::uuid, p_cost_center_id uuid DEFAULT NULL::uuid, p_client_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(bucket_start date, inflow numeric, outflow numeric, net numeric, running_balance numeric, payables_count integer, receivables_count integer, overdue_inflow numeric, overdue_outflow numeric, peak_day date, peak_day_outflow numeric)
 LANGUAGE sql
 STABLE
AS $function$
with p as (
  -- Teto de 36 meses e piso de 1: o parâmetro vem da barra de endereço, e
  -- `?meses=100000` geraria cem mil linhas sem que ninguém tivesse pedido isso.
  select
    greatest(1, least(coalesce(p_months, 12), 36))                    as months,
    least(greatest(coalesce(p_delinquency_rate, 0), 0), 100) / 100.0  as rate,
    date_trunc('month', current_date)::date                           as first_month
),
baldes as (
  select (p.first_month + make_interval(months => n::int))::date as bucket_start
  from p, generate_series(0, p.months - 1) as n
),
horizonte as (
  select (max(bucket_start) + interval '1 month' - interval '1 day')::date as ate
  from baldes
),
-- Movimentos de conta não excluída. `bank_account_movements` não tem
-- `deleted_at`; a junção é o que impede somar movimento de conta apagada.
movimentos as (
  select m.direction, m.amount, m.moved_on, m.cost_center_id
  from public.bank_account_movements m
  join public.bank_accounts a
    on a.id = m.bank_account_id and a.deleted_at is null
),
saldo_d0 as (
  select
    (select coalesce(sum(opening_balance), 0)
       from public.bank_accounts where deleted_at is null)
  + (select coalesce(sum(case when direction = 'in' then amount else -amount end), 0)
       from movimentos where moved_on <= current_date)
    as valor
),
fluxos as (
  select
    greatest(pa.due_on, current_date) as efetivo,
    0::numeric                        as entrada,
    pa.amount                         as saida,
    (pa.due_on < current_date)        as vencido,
    1                                 as e_pagar,
    0                                 as e_receber
  from public.payables pa
  where pa.deleted_at is null
    and pa.status in ('pending_approval', 'approved', 'scheduled')
    and (p_branch_id is null or pa.branch_id = p_branch_id)
    and (p_client_id is null or pa.branch_id is null or pa.branch_id in (
          select b.id from public.branches b where b.client_id = p_client_id))
    and (p_cost_center_id is null or pa.cost_center_id = p_cost_center_id)

  union all

  select
    greatest(re.due_on, current_date),
    round(re.amount * (1 - (select rate from p)), 2),
    0::numeric,
    (re.due_on < current_date),
    0, 1
  from public.receivables re
  where re.deleted_at is null
    and re.status = 'open'
    and (p_branch_id is null or re.branch_id = p_branch_id)
    and (p_client_id is null or re.client_id is null or re.client_id = p_client_id)
    and (p_cost_center_id is null or re.cost_center_id = p_cost_center_id)

  union all

  -- Movimento bancário datado no futuro: já existe, ainda não aconteceu.
  -- Sai da conta quando há filtro de filial porque movimento bancário não tem
  -- filial — atribuí-lo a uma seria inventar o dado.
  select
    mv.moved_on,
    case when mv.direction = 'in'  then mv.amount else 0 end,
    case when mv.direction = 'out' then mv.amount else 0 end,
    false, 0, 0
  from movimentos mv
  where mv.moved_on > current_date
    and p_branch_id is null
    and p_client_id is null
    and (p_cost_center_id is null or mv.cost_center_id = p_cost_center_id)
),
por_balde as (
  select
    date_trunc('month', f.efetivo)::date              as bucket_start,
    sum(f.entrada)                                    as inflow,
    sum(f.saida)                                      as outflow,
    coalesce(sum(f.entrada) filter (where f.vencido), 0) as overdue_inflow,
    coalesce(sum(f.saida)   filter (where f.vencido), 0) as overdue_outflow,
    sum(f.e_pagar)                                    as payables_count,
    sum(f.e_receber)                                  as receivables_count
  from fluxos f
  where f.efetivo <= (select ate from horizonte)
  group by 1
),
-- Maior dia de saída DENTRO de cada mês: dá a granularidade de dia sem devolver
-- uma linha por dia. É observação, não alarme — quem lê decide o que fazer com
-- "12/nov concentra 40% do mês".
picos as (
  select
    date_trunc('month', f.efetivo)::date as bucket_start,
    f.efetivo                            as dia,
    sum(f.saida)                         as saida_dia,
    row_number() over (
      partition by date_trunc('month', f.efetivo)
      order by sum(f.saida) desc, f.efetivo
    ) as rn
  from fluxos f
  where f.efetivo <= (select ate from horizonte)
    and f.saida > 0
  group by 1, 2
)
select
  b.bucket_start,
  coalesce(q.inflow, 0),
  coalesce(q.outflow, 0),
  coalesce(q.inflow, 0) - coalesce(q.outflow, 0),
  (select valor from saldo_d0)
    + sum(coalesce(q.inflow, 0) - coalesce(q.outflow, 0))
        over (order by b.bucket_start rows between unbounded preceding and current row),
  coalesce(q.payables_count, 0)::integer,
  coalesce(q.receivables_count, 0)::integer,
  q.overdue_inflow,
  q.overdue_outflow,
  pk.dia,
  coalesce(pk.saida_dia, 0)
from baldes b
left join por_balde q on q.bucket_start = b.bucket_start
left join picos    pk on pk.bucket_start = b.bucket_start and pk.rn = 1
order by b.bucket_start;
$function$
;

-- public.change_asset_custody
CREATE OR REPLACE FUNCTION public.change_asset_custody(p_asset_id uuid, p_user_id uuid DEFAULT NULL::uuid, p_branch_id uuid DEFAULT NULL::uuid, p_area_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT 'outro'::text, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
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
$function$
;

-- public.channel_ingest
CREATE OR REPLACE FUNCTION public.channel_ingest(p_token text, p_mensagem jsonb)
 RETURNS TABLE(status text, ticket_id uuid, message_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_hash     text := encode(digest(p_token, 'sha256'), 'hex');
  v_canal    public.channels;
  v_externo  text := nullif(trim(coalesce(p_mensagem ->> 'externo', '')), '');
  v_de       text := nullif(trim(coalesce(p_mensagem ->> 'de', '')), '');
  v_texto    text := nullif(trim(coalesce(p_mensagem ->> 'texto', '')), '');
  v_quando   timestamptz := coalesce((nullif(p_mensagem ->> 'em', ''))::timestamptz, now());
  v_contato  public.channel_contacts;
  v_conversa public.channel_conversations;
  v_ticket   uuid;
  v_msg      uuid;
  v_comment  uuid;
  v_fechado  boolean;
begin
  select * into v_canal from public.channels
   where inbound_token_hash = v_hash
     -- `channels.status`, qualificado: a função tem um parâmetro de saída `status`,
     -- e sem a qualificação o Postgres recusa a referência como ambígua.
     and channels.status = 'ativo'
     and deleted_at is null;
  if not found then
    return query select 'unauthorized'::text, null::uuid, null::uuid;
    return;
  end if;

  if v_de is null then
    -- Sem remetente não há contato, e sem contato não há conversa. É recusa de
    -- forma, não de autorização: quem chamou acertou o token e errou o corpo.
    return query select 'malformed'::text, null::uuid, null::uuid;
    return;
  end if;

  update public.channels set last_inbound_at = now() where id = v_canal.id;

  -- --- Contato ---------------------------------------------------------------
  select * into v_contato from public.channel_contacts
   where channel_id = v_canal.id and external_id = v_de;

  if not found then
    insert into public.channel_contacts (
      tenant_id, channel_id, external_id, display_name, client_id, profile_id
    ) values (
      v_canal.tenant_id, v_canal.id, v_de,
      nullif(trim(coalesce(p_mensagem ->> 'nome', '')), ''),
      v_canal.default_client_id,
      /*
       * Tenta casar com um cadastro. No e-mail o identificador JÁ É o endereço,
       * então o casamento é exato; no WhatsApp compara só os dígitos, porque o
       * telefone no cadastro vem escrito de seis jeitos diferentes
       * ("(44) 99988-7766", "+5544999887766", "44999887766") e nenhum deles é o
       * formato que a Meta entrega.
       */
      (select p.id from public.profiles p
        where p.tenant_id = v_canal.tenant_id
          and p.is_active
          and (
            (v_canal.kind = 'email' and lower(p.email) = lower(v_de))
            or (v_canal.kind <> 'email'
                and p.phone is not null
                and regexp_replace(p.phone, '\D', '', 'g') <> ''
                -- Compara pelos últimos 8 dígitos: é o que sobrevive a DDI e DDD
                -- escritos (ou não) de jeitos diferentes nas duas pontas.
                and right(regexp_replace(p.phone, '\D', '', 'g'), 8)
                  = right(regexp_replace(v_de, '\D', '', 'g'), 8))
          )
        limit 1)
    )
    returning * into v_contato;
  elsif v_contato.display_name is null and nullif(trim(coalesce(p_mensagem ->> 'nome', '')), '') is not null then
    -- O nome do perfil do WhatsApp às vezes só vem na segunda mensagem.
    update public.channel_contacts
       set display_name = trim(p_mensagem ->> 'nome')
     where id = v_contato.id
    returning * into v_contato;
  end if;

  -- --- A mensagem, antes de qualquer efeito ----------------------------------
  -- Gravada primeiro e com `on conflict do nothing`: se o provedor reentregar, a
  -- função sai aqui sem criar chamado nem comentário. Fazer o contrário —
  -- registrar depois dos efeitos — deixaria a reentrega duplicar o comentário.
  insert into public.channel_messages (
    tenant_id, channel_id, direction, external_id, body, media, status, created_at
  ) values (
    v_canal.tenant_id, v_canal.id, 'entrada', v_externo, v_texto,
    coalesce(p_mensagem -> 'midia', '[]'::jsonb), 'recebida', v_quando
  )
  on conflict (channel_id, external_id) where external_id is not null do nothing
  returning id into v_msg;

  if v_msg is null then
    return query select 'duplicate'::text, null::uuid, null::uuid;
    return;
  end if;

  -- Contato bloqueado ou canal em observação: a mensagem FICA REGISTRADA e não
  -- vira chamado. Registrar em vez de descartar é o que permite descobrir um
  -- bloqueio feito por engano — "a mensagem sumiu" não deixa rastro.
  if v_contato.bloqueado or not v_canal.abre_chamado then
    update public.channel_messages set status = 'ignorada' where id = v_msg;
    return query select
      case when v_contato.bloqueado then 'blocked' else 'logged' end,
      null::uuid, v_msg;
    return;
  end if;

  -- --- Conversa --------------------------------------------------------------
  select * into v_conversa from public.channel_conversations
   where channel_id = v_canal.id
     and contact_id = v_contato.id
     and channel_conversations.status = 'aberta';

  if found then
    -- Chamado fechado encerra a conversa: o assunto seguinte é outro chamado.
    -- Sem isto, dois anos de assuntos diferentes se empilhariam no mesmo.
    select (t.status in ('closed', 'resolved')) into v_fechado
      from public.tickets t where t.id = v_conversa.ticket_id;

    if v_conversa.ticket_id is null or coalesce(v_fechado, true) then
      update public.channel_conversations set status = 'fechada' where id = v_conversa.id;
      v_conversa := null;
    end if;
  end if;

  if v_conversa.id is null then
    insert into public.tickets (
      tenant_id, title, description, status, priority_id, queue_id,
      client_id, branch_id, requester_id, source, change_source
    ) values (
      v_canal.tenant_id,
      -- O título é o começo da mensagem. Não é bonito e é o melhor disponível:
      -- quem escreve no WhatsApp não escreve assunto, e um título fixo ("Mensagem
      -- do WhatsApp") deixaria a fila inteira com o mesmo nome.
      left(coalesce(v_texto, 'Mensagem de ' || coalesce(v_contato.display_name, v_de)), 200),
      v_texto,
      'open',
      v_canal.default_priority_id,
      v_canal.default_queue_id,
      coalesce(v_contato.client_id, v_canal.default_client_id),
      v_contato.branch_id,
      v_contato.profile_id,
      -- `integration` e não `ui`: o chamado não nasceu de alguém na tela.
      'integration', 'integration'
    )
    returning id into v_ticket;

    insert into public.channel_conversations (
      tenant_id, channel_id, contact_id, ticket_id,
      external_thread_id, last_message_at
    ) values (
      v_canal.tenant_id, v_canal.id, v_contato.id, v_ticket,
      nullif(p_mensagem ->> 'thread', ''), v_quando
    )
    returning * into v_conversa;
  else
    v_ticket := v_conversa.ticket_id;

    -- Mensagem numa conversa aberta vira comentário PÚBLICO: foi escrita pela
    -- pessoa, e ela precisa poder ler a própria pergunta no chamado.
    insert into public.ticket_comments (
      tenant_id, ticket_id, author_id, body, visibility, source, external_id
    ) values (
      v_canal.tenant_id, v_ticket, v_contato.profile_id,
      coalesce(v_texto, '(mensagem sem texto)'),
      'public', 'integration', v_externo
    )
    returning id into v_comment;

    update public.channel_conversations
       set last_message_at = v_quando
     where id = v_conversa.id;
  end if;

  update public.channel_messages
     set conversation_id = v_conversa.id,
         comment_id      = v_comment
   where id = v_msg;

  return query select 'stored'::text, v_ticket, v_msg;
end;
$function$
;

-- public.channel_por_token
CREATE OR REPLACE FUNCTION public.channel_por_token(p_token text)
 RETURNS TABLE(kind text, status text, config jsonb, secret_ref text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select c.kind, c.status, c.config, c.secret_ref
    from public.channels c
   where c.inbound_token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and c.deleted_at is null;
$function$
;

-- public.confirmar_email_com_token
CREATE OR REPLACE FUNCTION public.confirmar_email_com_token(p_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_user uuid;
begin
  v_user := public.consumir_token_de_acesso(p_token, 'email_confirm');
  if v_user is null then
    return false;
  end if;

  update public.profiles set is_active = true where id = v_user;
  return true;
end;
$function$
;

-- public.consumir_token_de_acesso
CREATE OR REPLACE FUNCTION public.consumir_token_de_acesso(p_token text, p_purpose text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_user uuid;
begin
  update public.auth_tokens
     set used_at = now()
   where token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and purpose = p_purpose
     and used_at is null
     and expires_at > now()
  returning user_id into v_user;

  return v_user;
end;
$function$
;

-- public.conta_aguarda_confirmacao
CREATE OR REPLACE FUNCTION public.conta_aguarda_confirmacao(p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (
    select 1 from public.auth_tokens
     where user_id = p_user
       and purpose = 'email_confirm'
       and used_at is null
       and expires_at > now());
$function$
;

-- public.convite_valido
CREATE OR REPLACE FUNCTION public.convite_valido(p_token text)
 RETURNS TABLE(empresa text, email text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select t.name, i.email
    from public.invites i
    join public.tenants t on t.id = i.tenant_id
   where i.token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and i.accepted_at is null
     and i.revoked_at is null
     and i.expires_at > now();
$function$
;

-- public.crypt
CREATE OR REPLACE FUNCTION public.crypt(text, text)
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_crypt$function$
;

-- public.dearmor
CREATE OR REPLACE FUNCTION public.dearmor(text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_dearmor$function$
;

-- public.decidir_pedido
CREATE OR REPLACE FUNCTION public.decidir_pedido(p_ticket_id uuid, p_aprovado boolean, p_motivo text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- public.decrypt
CREATE OR REPLACE FUNCTION public.decrypt(bytea, bytea, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_decrypt$function$
;

-- public.decrypt_iv
CREATE OR REPLACE FUNCTION public.decrypt_iv(bytea, bytea, bytea, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_decrypt_iv$function$
;

-- public.digest
CREATE OR REPLACE FUNCTION public.digest(text, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_digest$function$
;

-- public.digest
CREATE OR REPLACE FUNCTION public.digest(bytea, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_digest$function$
;

-- public.encrypt
CREATE OR REPLACE FUNCTION public.encrypt(bytea, bytea, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_encrypt$function$
;

-- public.encrypt_iv
CREATE OR REPLACE FUNCTION public.encrypt_iv(bytea, bytea, bytea, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_encrypt_iv$function$
;

-- public.fn_format_address
CREATE OR REPLACE FUNCTION public.fn_format_address(p_street text, p_number text, p_complement text, p_district text, p_city text, p_state text, p_postal text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select nullif(
    concat_ws(', ',
      nullif(concat_ws(' - ',
        nullif(concat_ws(', ', nullif(btrim(p_street), ''), nullif(btrim(p_number), '')), ''),
        nullif(btrim(p_complement), '')
      ), ''),
      nullif(btrim(p_district), ''),
      nullif(concat_ws('/', nullif(btrim(p_city), ''), nullif(upper(btrim(p_state)), '')), ''),
      nullif(btrim(p_postal), '')
    ), '');
$function$
;

-- public.gen_random_bytes
CREATE OR REPLACE FUNCTION public.gen_random_bytes(integer)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_random_bytes$function$
;

-- public.gen_random_uuid
CREATE OR REPLACE FUNCTION public.gen_random_uuid()
 RETURNS uuid
 LANGUAGE c
 PARALLEL SAFE
AS '$libdir/pgcrypto', $function$pg_random_uuid$function$
;

-- public.gen_salt
CREATE OR REPLACE FUNCTION public.gen_salt(text)
 RETURNS text
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_gen_salt$function$
;

-- public.gen_salt
CREATE OR REPLACE FUNCTION public.gen_salt(text, integer)
 RETURNS text
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_gen_salt_rounds$function$
;

-- public.gestao_gasto_por_filial
CREATE OR REPLACE FUNCTION public.gestao_gasto_por_filial(p_client_id uuid, p_competence date)
 RETURNS TABLE(branch_id uuid, branch_name text, total numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    m.branch_id,
    coalesce(m.branch_name, 'Do grupo') as branch_name,
    sum(m.total) as total
  from public.vw_it_budget_monthly m
  where m.client_id = p_client_id and m.competence = p_competence
    and m.scenario_key = 'oficial'   -- o MESMO recorte do indicador, ou a conferência acusa
  group by m.branch_id, m.branch_name
  order by sum(m.total) desc;
$function$
;

-- public.gestao_resultado
CREATE OR REPLACE FUNCTION public.gestao_resultado(p_client_id uuid, p_competence date)
 RETURNS TABLE(gasto_mes numeric, gasto_mes_anterior numeric, gasto_despesa numeric, gasto_investimento numeric, gasto_compartilhado numeric, compromisso_12m numeric, projetos_total integer, projetos_em_andamento integer, projetos_atrasados integer, projetos_entregues_no_prazo integer, projetos_entregues integer, sla_tickets integer, sla_com_acordo integer, sla_fora integer, sla_conformidade numeric, competencia_fechada boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  /*
   * `scenario_key = 'oficial'` nos três recortes de dinheiro. É o contrato da
   * 0038 — o cenário de simulação convive sem contaminar o total —, e aqui ele
   * é especialmente caro: um indicador de resultado que soma simulação com real
   * erra sempre para mais, e ninguém desconfia de um número que subiu.
   */
  with financeiro as (
    select
      coalesce(sum(m.total), 0)               as total,
      coalesce(sum(m.total_despesa), 0)       as despesa,
      coalesce(sum(m.total_investimento), 0)  as investimento,
      coalesce(sum(m.total_compartilhado), 0) as compartilhado
    from public.vw_it_budget_monthly m
    where m.client_id = p_client_id and m.competence = p_competence
      and m.scenario_key = 'oficial'
  ),
  anterior as (
    select coalesce(sum(m.total), 0) as total
    from public.vw_it_budget_monthly m
    where m.client_id = p_client_id
      and m.competence = (p_competence - interval '1 month')::date
      and m.scenario_key = 'oficial'
  ),
  /*
   * Compromisso: o que já está lançado nos doze meses SEGUINTES.
   *
   * Não é projeção nem estimativa — é parcela e recorrência que alguém já
   * registrou. É o número que responde "quanto da verba do ano que vem já está
   * comprometido", e ele costuma surpreender.
   */
  compromisso as (
    select coalesce(sum(e.amount), 0) as total
    from public.it_cost_entries e
    join public.it_budget_scenarios sc on sc.id = e.scenario_id
    where e.client_id = p_client_id
      and e.deleted_at is null
      and sc.key = 'oficial'
      and e.competence > p_competence
      and e.competence <= (p_competence + interval '12 months')::date
  ),
  projetos as (
    select
      count(*)::integer                                           as total,
      count(*) filter (where p.status = 'em_andamento')::integer  as em_andamento,
      count(*) filter (where p.atrasado)::integer                 as atrasados,
      count(*) filter (where p.actual_end_month is not null)::integer as entregues,
      count(*) filter (where p.actual_end_month is not null
                         and p.desvio_meses <= 0)::integer        as no_prazo
    from public.vw_projects p
    where p.client_id = p_client_id
  ),
  /*
   * SLA: lido de `vw_sla_compliance`, que conta chamado a chamado desde a 0011.
   *
   * `resolution_breaches` é o número de estouros; a conformidade é derivada
   * daqui e não da coluna `resolution_compliance_pct` da view — ela é por fila,
   * e a média de percentuais por fila NÃO é o percentual do conjunto. Uma fila
   * com um chamado e 0% puxaria o resultado tanto quanto uma com duzentos.
   */
  sla as (
    select
      coalesce(sum(s.tickets_total), 0)::integer      as tickets,
      coalesce(sum(s.tickets_with_sla), 0)::integer   as com_acordo,
      coalesce(sum(s.resolution_breaches), 0)::integer as fora
    from public.vw_sla_compliance s
    where s.client_id = p_client_id
      and date_trunc('month', s.period)::date = p_competence
  )
  select
    f.total,
    a.total,
    f.despesa,
    f.investimento,
    f.compartilhado,
    c.total,
    pr.total,
    pr.em_andamento,
    pr.atrasados,
    pr.no_prazo,
    pr.entregues,
    sl.tickets,
    sl.com_acordo,
    sl.fora,
    /* Zero chamado com acordo devolve NULO, e não 100%: "nenhum estouro em
       nenhum chamado" não é conformidade perfeita, é ausência de medida. A tela
       escreve um travessão. */
    case when sl.com_acordo > 0
         then round(((sl.com_acordo - sl.fora)::numeric / sl.com_acordo) * 100, 1)
         else null end,
    app.competencia_fechada(p_client_id, p_competence)
  from financeiro f, anterior a, compromisso c, projetos pr, sla sl;
$function$
;

-- public.gestao_serie
CREATE OR REPLACE FUNCTION public.gestao_serie(p_client_id uuid, p_competence date, p_meses integer DEFAULT 12)
 RETURNS TABLE(competencia date, gasto numeric, conformidade numeric, com_acordo integer, projetos_atrasados integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with limites as (
    select
      /* A série nunca passa do mês corrente: ver o cabeçalho. */
      least(p_competence, date_trunc('month', now())::date) as fim,
      /* Teto de 36 meses. Sem ele, `?meses=100000` na URL vira uma varredura
         de oito mil anos de `generate_series` — não é ataque, é alguém
         curioso, e o efeito é o mesmo. */
      least(greatest(coalesce(p_meses, 12), 1), 36) as n
  ),
  meses as (
    select generate_series(
             (l.fim - make_interval(months => l.n - 1))::date,
             l.fim,
             interval '1 month'
           )::date as m
    from limites l
  ),
  /*
   * Cada fonte é varrida UMA vez, agrupada por mês, e depois casada com a lista
   * de meses. A forma óbvia — uma subconsulta correlacionada por mês — custou
   * 1.250 ms com vinte e cinco mil chamados, porque reagrupava a base inteira
   * doze vezes. Era correta e inutilizável, que é como um defeito de
   * desempenho sempre se apresenta: o número certo, tarde demais.
   *
   * O recorte aqui é só o cliente, sem filtro de mês. É de propósito: `period`
   * é uma expressão agrupada (`date_trunc` sobre `created_at`), e um filtro
   * sobre ela não desce até a varredura dos chamados — ficaria pago o mesmo
   * trabalho, com a aparência de estar limitado.
   */
  gasto_por_mes as (
    select b.competence as m, sum(b.total) as total
    from public.vw_it_budget_monthly b
    where b.client_id = p_client_id
      and b.scenario_key = 'oficial'
    group by b.competence
  ),
  sla_por_mes as (
    select
      date_trunc('month', s.period)::date  as m,
      sum(s.tickets_with_sla)              as com_acordo,
      sum(s.resolution_breaches)           as fora
    from public.vw_sla_compliance s
    where s.client_id = p_client_id
    group by 1
  ),
  atraso_por_mes as (
    select m.m, count(*)::integer as atrasados
    from meses m
    join public.vw_projects p on p.client_id = p_client_id
    where case
            /* O mês corrente usa a MESMA coluna do indicador. Ver o cabeçalho. */
            when m.m = date_trunc('month', now())::date then p.atrasado
            /* Nos meses anteriores, "em atraso naquele mês": já tinha passado
               do previsto e ainda não havia sido entregue. Um projeto entregue
               em setembro esteve atrasado em julho e agosto — e é justamente
               essa história que a série mostra e o indicador de hoje não tem
               como contar. */
            else p.status not in ('cancelado', 'cancelada')
                 and p.planned_end_month < m.m
                 and (p.actual_end_month is null or p.actual_end_month > m.m)
          end
    group by m.m
  )
  select
    m.m,
    coalesce(g.total, 0) as gasto,
    /* Nulo, e não 100, quando não houve chamado com acordo no mês: é o mesmo
       contrato da 0039, e no gráfico ele vira buraco na linha. Um buraco ligado
       por uma reta ao ponto seguinte seria lido como "ficou constante", que é o
       contrário de "não houve medida". */
    case when coalesce(s.com_acordo, 0) > 0
         then round(((s.com_acordo - s.fora)::numeric / s.com_acordo) * 100, 1)
         else null end as conformidade,
    coalesce(s.com_acordo, 0)::integer as com_acordo,
    coalesce(a.atrasados, 0)           as projetos_atrasados
  from meses m
  left join gasto_por_mes  g on g.m = m.m
  left join sla_por_mes    s on s.m = m.m
  left join atraso_por_mes a on a.m = m.m
  order by m.m;
$function$
;

-- public.hmac
CREATE OR REPLACE FUNCTION public.hmac(text, text, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_hmac$function$
;

-- public.hmac
CREATE OR REPLACE FUNCTION public.hmac(bytea, bytea, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_hmac$function$
;

-- public.integracao_restaurar_mapeamento
CREATE OR REPLACE FUNCTION public.integracao_restaurar_mapeamento(p_integration_id uuid, p_version integer)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- public.kb_registrar_leitura
CREATE OR REPLACE FUNCTION public.kb_registrar_leitura(p_article_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  update public.kb_articles
     set views = views + 1
   where id = p_article_id
     and tenant_id = app.current_tenant_id()   -- o isolamento continua explícito
     and status = 'publicado'
     and deleted_at is null;
end;
$function$
;

-- public.kb_sugestoes
CREATE OR REPLACE FUNCTION public.kb_sugestoes(p_ticket_id uuid, p_limite integer DEFAULT 3)
 RETURNS TABLE(id uuid, title text, resumo text, relevancia real)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with chamado as (
    select t.title, t.description, t.category_id, t.tenant_id
      from public.tickets t
     where t.id = p_ticket_id and t.deleted_at is null
  )
  select a.id, a.title, a.resumo,
         ts_rank(a.search_vector, c.consulta)
           -- Mesma categoria vale um empurrão, e não uma exclusão: o artigo certo
           -- às vezes está classificado em outro lugar.
           + case when a.category_id = ch.category_id then 0.5 else 0 end as relevancia
    from chamado ch
    cross join lateral (
      select websearch_to_tsquery('public.portugues_sem_acento',
                                  coalesce(ch.title, '') || ' ' || coalesce(ch.description, '')) as consulta
    ) c
    join public.kb_articles a
      on a.tenant_id = ch.tenant_id
     and a.status = 'publicado'
     and a.deleted_at is null
   where a.search_vector @@ c.consulta
      or a.category_id = ch.category_id
   order by relevancia desc, a.published_at desc
   limit greatest(1, least(p_limite, 10));
$function$
;

-- public.link_event_ingest
CREATE OR REPLACE FUNCTION public.link_event_ingest(p_token text, p_host text, p_external_id text, p_state text, p_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- public.monitoring_por_token
CREATE OR REPLACE FUNCTION public.monitoring_por_token(p_token text)
 RETURNS TABLE(webhook_id uuid, tenant_id uuid, name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select w.id, w.tenant_id, w.name
    from public.monitoring_webhooks w
   where w.inbound_token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and w.active
     and w.deleted_at is null;
$function$
;

-- public.orcamento_importar_titulos
CREATE OR REPLACE FUNCTION public.orcamento_importar_titulos(p_client_id uuid, p_competence date, p_scenario_id uuid)
 RETURNS TABLE(importados integer, ja_existiam integer, valor_total numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tenant uuid := app.current_tenant_id();
  v_import integer := 0;
  v_total  numeric(14,2) := 0;
  v_todos  integer := 0;
begin
  if not app.has_permission('financeiro.orcamento.lancar') then
    raise exception 'Sem permissão para lançar no orçamento.'
      using errcode = 'insufficient_privilege';
  end if;

  if app.competencia_fechada(p_client_id, p_competence) then
    raise exception 'A competência % está fechada.', to_char(p_competence, 'MM/YYYY')
      using errcode = 'check_violation';
  end if;

  /* Quantos títulos existem na janela — para a tela dizer "12 títulos, 5 já
     estavam lançados" em vez de só "importei 7". */
  select count(*) into v_todos
    from public.payables p
   where p.tenant_id = v_tenant
     and p.deleted_at is null
     and p.status <> 'rejected'
     and date_trunc('month', p.due_on)::date = p_competence
     and exists (
       select 1 from public.branches b
        where b.id = p.branch_id and b.client_id = p_client_id
     );

  with novos as (
    insert into public.it_cost_entries (
      tenant_id, client_id, branch_id, expense_category_id, cost_center_id,
      supplier_id, competence, amount, description, natureza, classificacao,
      installment_number, installment_total, scenario_id, origem, payable_id
    )
    select
      p.tenant_id,
      p_client_id,
      p.branch_id,
      p.expense_category_id,
      p.cost_center_id,
      p.supplier_id,
      date_trunc('month', p.due_on)::date,
      p.amount,
      p.description,
      /* Título com parcelamento vira lançamento parcelado; os demais, pontual
         única. "Fixa" é decisão de quem planeja, e o título não tem como dizer. */
      case when p.installment_total is not null and p.installment_total > 1
           then 'pontual_parcelada' else 'pontual_unica' end,
      /* Despesa por padrão: classificar como investimento é decisão contábil, e
         supô-la a partir do título erraria em favor do número mais vistoso. */
      'despesa',
      p.installment_number,
      p.installment_total,
      p_scenario_id,
      'titulo_a_pagar',
      p.id
    from public.payables p
    where p.tenant_id = v_tenant
      and p.deleted_at is null
      and p.status <> 'rejected'
      and p.expense_category_id is not null
      and date_trunc('month', p.due_on)::date = p_competence
      and exists (
        select 1 from public.branches b
         where b.id = p.branch_id and b.client_id = p_client_id
      )
      and not exists (
        select 1 from public.it_cost_entries e
         where e.payable_id = p.id and e.deleted_at is null
      )
    returning amount
  )
  select count(*), coalesce(sum(amount), 0) into v_import, v_total from novos;

  return query select v_import, greatest(v_todos - v_import, 0), v_total;
end;
$function$
;

-- public.pgp_armor_headers
CREATE OR REPLACE FUNCTION public.pgp_armor_headers(text, OUT key text, OUT value text)
 RETURNS SETOF record
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_armor_headers$function$
;

-- public.pgp_key_id
CREATE OR REPLACE FUNCTION public.pgp_key_id(bytea)
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_key_id_w$function$
;

-- public.pgp_pub_decrypt
CREATE OR REPLACE FUNCTION public.pgp_pub_decrypt(bytea, bytea)
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_decrypt_text$function$
;

-- public.pgp_pub_decrypt
CREATE OR REPLACE FUNCTION public.pgp_pub_decrypt(bytea, bytea, text)
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_decrypt_text$function$
;

-- public.pgp_pub_decrypt
CREATE OR REPLACE FUNCTION public.pgp_pub_decrypt(bytea, bytea, text, text)
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_decrypt_text$function$
;

-- public.pgp_pub_decrypt_bytea
CREATE OR REPLACE FUNCTION public.pgp_pub_decrypt_bytea(bytea, bytea)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_decrypt_bytea$function$
;

-- public.pgp_pub_decrypt_bytea
CREATE OR REPLACE FUNCTION public.pgp_pub_decrypt_bytea(bytea, bytea, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_decrypt_bytea$function$
;

-- public.pgp_pub_decrypt_bytea
CREATE OR REPLACE FUNCTION public.pgp_pub_decrypt_bytea(bytea, bytea, text, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_decrypt_bytea$function$
;

-- public.pgp_pub_encrypt
CREATE OR REPLACE FUNCTION public.pgp_pub_encrypt(text, bytea)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_encrypt_text$function$
;

-- public.pgp_pub_encrypt
CREATE OR REPLACE FUNCTION public.pgp_pub_encrypt(text, bytea, text)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_encrypt_text$function$
;

-- public.pgp_pub_encrypt_bytea
CREATE OR REPLACE FUNCTION public.pgp_pub_encrypt_bytea(bytea, bytea)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_encrypt_bytea$function$
;

-- public.pgp_pub_encrypt_bytea
CREATE OR REPLACE FUNCTION public.pgp_pub_encrypt_bytea(bytea, bytea, text)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_encrypt_bytea$function$
;

-- public.pgp_sym_decrypt
CREATE OR REPLACE FUNCTION public.pgp_sym_decrypt(bytea, text)
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_sym_decrypt_text$function$
;

-- public.pgp_sym_decrypt
CREATE OR REPLACE FUNCTION public.pgp_sym_decrypt(bytea, text, text)
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_sym_decrypt_text$function$
;

-- public.pgp_sym_decrypt_bytea
CREATE OR REPLACE FUNCTION public.pgp_sym_decrypt_bytea(bytea, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_sym_decrypt_bytea$function$
;

-- public.pgp_sym_decrypt_bytea
CREATE OR REPLACE FUNCTION public.pgp_sym_decrypt_bytea(bytea, text, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_sym_decrypt_bytea$function$
;

-- public.pgp_sym_encrypt
CREATE OR REPLACE FUNCTION public.pgp_sym_encrypt(text, text)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_sym_encrypt_text$function$
;

-- public.pgp_sym_encrypt
CREATE OR REPLACE FUNCTION public.pgp_sym_encrypt(text, text, text)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_sym_encrypt_text$function$
;

-- public.pgp_sym_encrypt_bytea
CREATE OR REPLACE FUNCTION public.pgp_sym_encrypt_bytea(bytea, text)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_sym_encrypt_bytea$function$
;

-- public.pgp_sym_encrypt_bytea
CREATE OR REPLACE FUNCTION public.pgp_sym_encrypt_bytea(bytea, text, text)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_sym_encrypt_bytea$function$
;

-- public.planos_publicos
CREATE OR REPLACE FUNCTION public.planos_publicos()
 RETURNS TABLE(codigo text, nome text, resumo text, preco_mensal numeric, limite_usuarios integer, limite_chamados_mes integer, esferas text[], destaques text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select p.codigo, p.nome, p.resumo, p.preco_mensal,
         p.limite_usuarios, p.limite_chamados_mes, p.esferas, p.destaques
    from public.planos p
   where p.publico and p.is_active
   order by p.ordem, p.preco_mensal nulls last;
$function$
;

-- public.required_approval_levels_for
CREATE OR REPLACE FUNCTION public.required_approval_levels_for(p_amount numeric, p_cost_center_id uuid DEFAULT NULL::uuid, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS integer[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select app.required_approval_levels(
    app.current_tenant_id(), p_amount, p_cost_center_id, p_branch_id);
$function$
;

-- public.resolve_dashboard_token
CREATE OR REPLACE FUNCTION public.resolve_dashboard_token(p_token text)
 RETURNS TABLE(tenant_id uuid, layout_id uuid, branch_ids uuid[], refresh_seconds smallint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select * from app.resolve_dashboard_token(p_token);
$function$
;

-- public.satisfaction_invite
CREATE OR REPLACE FUNCTION public.satisfaction_invite(p_token text)
 RETURNS TABLE(ticket_number bigint, ticket_title text, already_answered boolean, expired boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_hash text := encode(digest(p_token, 'sha256'), 'hex');
begin
  return query
  select t.ticket_number, t.title,
         s.answered_at is not null,
         s.expires_at <= now()
    from public.ticket_satisfaction s
    join public.tickets t on t.id = s.ticket_id
   where s.token_hash = v_hash;
end;
$function$
;

-- public.seed_branch_areas
CREATE OR REPLACE FUNCTION public.seed_branch_areas(p_branch_id uuid)
 RETURNS integer
 LANGUAGE sql
AS $function$
  select app.fn_seed_branch_areas(p_branch_id);
$function$
;

-- public.service_preco_para_cliente
CREATE OR REPLACE FUNCTION public.service_preco_para_cliente(p_service_id uuid, p_client_id uuid)
 RETURNS TABLE(preco numeric, incluso boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    case when cc.incluso_no_contrato then 0::numeric
         else coalesce(cc.preco, s.preco)
    end,
    coalesce(cc.incluso_no_contrato, false)
  from public.service_catalog s
  left join public.service_catalog_clients cc
    on cc.service_id = s.id and cc.client_id = p_client_id
  where s.id = p_service_id and s.deleted_at is null;
$function$
;

-- public.submit_satisfaction
CREATE OR REPLACE FUNCTION public.submit_satisfaction(p_token text, p_score smallint, p_comment text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_hash text := encode(digest(p_token, 'sha256'), 'hex');
  v_id   uuid;
begin
  if p_score is null or p_score < 1 or p_score > 5 then
    return false;
  end if;

  /* Só grava se: o token existe, ainda não foi respondido e não expirou. As três
     condições juntas num único UPDATE — checar antes e gravar depois abriria a
     janela em que duas respostas simultâneas passam as duas. */
  update public.ticket_satisfaction
     set score       = p_score,
         comment     = nullif(btrim(coalesce(p_comment, '')), ''),
         answered_at = now()
   where token_hash = v_hash
     and answered_at is null
     and expires_at > now()
  returning ticket_id into v_id;

  return v_id is not null;
end;
$function$
;

-- public.token_de_acesso_vale
CREATE OR REPLACE FUNCTION public.token_de_acesso_vale(p_token text, p_purpose text)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (
    select 1 from public.auth_tokens
     where token_hash = encode(digest(p_token, 'sha256'), 'hex')
       and purpose = p_purpose
       and used_at is null
       and expires_at > now());
$function$
;

-- public.unaccent
CREATE OR REPLACE FUNCTION public.unaccent(regdictionary, text)
 RETURNS text
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/unaccent', $function$unaccent_dict$function$
;

-- public.unaccent
CREATE OR REPLACE FUNCTION public.unaccent(text)
 RETURNS text
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/unaccent', $function$unaccent_dict$function$
;

-- public.unaccent_init
CREATE OR REPLACE FUNCTION public.unaccent_init(internal)
 RETURNS internal
 LANGUAGE c
 PARALLEL SAFE
AS '$libdir/unaccent', $function$unaccent_init$function$
;

-- public.unaccent_lexize
CREATE OR REPLACE FUNCTION public.unaccent_lexize(internal, internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 PARALLEL SAFE
AS '$libdir/unaccent', $function$unaccent_lexize$function$
;

-- public.unaccent_simples
CREATE OR REPLACE FUNCTION public.unaccent_simples(p_texto text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select translate(p_texto,
    'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC');
$function$
;


-- ==========================================================================
-- OS GATILHOS
-- ==========================================================================
-- A ordem de disparo entre gatilhos do MESMO evento é alfabética pelo nome.
-- Quando um depende do outro, é o nome que ordena — e é por isso que ela
-- aparece aqui, em vez de ser detalhe de implementação.

-- access_profiles
CREATE TRIGGER trg_access_profiles_audit AFTER INSERT OR DELETE OR UPDATE ON public.access_profiles FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_access_profiles_guard_system BEFORE DELETE OR UPDATE ON public.access_profiles FOR EACH ROW EXECUTE FUNCTION app.guard_system_profile();
CREATE TRIGGER trg_access_profiles_touch BEFORE UPDATE ON public.access_profiles FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- agent_alerts
CREATE TRIGGER trg_agent_alerts_audit AFTER INSERT OR DELETE OR UPDATE ON public.agent_alerts FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- agent_devices
CREATE TRIGGER trg_agent_devices_audit AFTER INSERT OR DELETE OR UPDATE ON public.agent_devices FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_agent_devices_touch BEFORE UPDATE ON public.agent_devices FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- agent_enrollments
CREATE TRIGGER trg_agent_enrollments_audit AFTER INSERT OR DELETE OR UPDATE ON public.agent_enrollments FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_agent_enrollments_touch BEFORE UPDATE ON public.agent_enrollments FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ai_settings
CREATE TRIGGER trg_ai_settings_audit AFTER INSERT OR DELETE OR UPDATE ON public.ai_settings FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_ai_settings_touch BEFORE UPDATE ON public.ai_settings FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ai_suggestions
CREATE TRIGGER trg_ai_suggestions_audit AFTER INSERT OR DELETE OR UPDATE ON public.ai_suggestions FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_ai_suggestions_touch BEFORE UPDATE ON public.ai_suggestions FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- approval_rules
CREATE TRIGGER trg_approval_rules_audit AFTER INSERT OR DELETE OR UPDATE ON public.approval_rules FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_approval_rules_touch BEFORE UPDATE ON public.approval_rules FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- asset_attachments
CREATE TRIGGER trg_asset_attachments_audit AFTER INSERT OR DELETE OR UPDATE ON public.asset_attachments FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- bank_account_movements
CREATE TRIGGER trg_bank_account_movements_audit AFTER INSERT OR DELETE OR UPDATE ON public.bank_account_movements FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_bank_account_movements_touch BEFORE UPDATE ON public.bank_account_movements FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE CONSTRAINT TRIGGER trg_movements_transfer_pairs AFTER INSERT OR DELETE OR UPDATE ON public.bank_account_movements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.validate_transfer_pairs();

-- bank_accounts
CREATE TRIGGER trg_bank_accounts_audit AFTER INSERT OR DELETE OR UPDATE ON public.bank_accounts FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_bank_accounts_touch BEFORE UPDATE ON public.bank_accounts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- branch_areas
CREATE TRIGGER trg_branch_areas_audit AFTER INSERT OR DELETE OR UPDATE ON public.branch_areas FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_branch_areas_touch BEFORE UPDATE ON public.branch_areas FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- branches
CREATE TRIGGER trg_branches_audit AFTER INSERT OR DELETE OR UPDATE ON public.branches FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_branches_geocode_staleness BEFORE UPDATE ON public.branches FOR EACH ROW EXECUTE FUNCTION app.branches_geocode_staleness();
CREATE TRIGGER trg_branches_touch BEFORE UPDATE ON public.branches FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_branches_validate_tz BEFORE INSERT OR UPDATE OF timezone ON public.branches FOR EACH ROW EXECUTE FUNCTION app.validate_timezone();

-- business_hours
CREATE TRIGGER trg_business_hours_audit AFTER INSERT OR DELETE OR UPDATE ON public.business_hours FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_business_hours_touch BEFORE UPDATE ON public.business_hours FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_business_hours_validate_tz BEFORE INSERT OR UPDATE OF timezone ON public.business_hours FOR EACH ROW EXECUTE FUNCTION app.validate_timezone();

-- channel_contacts
CREATE TRIGGER trg_channel_contacts_audit AFTER INSERT OR DELETE OR UPDATE ON public.channel_contacts FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_channel_contacts_touch BEFORE UPDATE ON public.channel_contacts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- channel_conversations
CREATE TRIGGER trg_channel_conversations_touch BEFORE UPDATE ON public.channel_conversations FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- channel_messages
CREATE TRIGGER trg_channel_messages_touch BEFORE UPDATE ON public.channel_messages FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- channels
CREATE TRIGGER trg_channels_audit AFTER INSERT OR DELETE OR UPDATE ON public.channels FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_channels_touch BEFORE UPDATE ON public.channels FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- clients
CREATE TRIGGER trg_cliente_cenario_oficial AFTER INSERT ON public.clients FOR EACH ROW EXECUTE FUNCTION app.cliente_cria_cenario_oficial();
CREATE TRIGGER trg_clients_audit AFTER INSERT OR DELETE OR UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_clients_touch BEFORE UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- cost_centers
CREATE TRIGGER trg_cost_center_depth BEFORE INSERT OR UPDATE OF parent_id ON public.cost_centers FOR EACH ROW EXECUTE FUNCTION app.enforce_cost_center_depth();
CREATE TRIGGER trg_cost_centers_audit AFTER INSERT OR DELETE OR UPDATE ON public.cost_centers FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_cost_centers_touch BEFORE UPDATE ON public.cost_centers FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- dashboard_layouts
CREATE TRIGGER trg_dashboard_layouts_touch BEFORE UPDATE ON public.dashboard_layouts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- dashboard_tokens
CREATE TRIGGER trg_dashboard_tokens_touch BEFORE UPDATE ON public.dashboard_tokens FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- email_outbox
CREATE TRIGGER trg_email_outbox_touch BEFORE UPDATE ON public.email_outbox FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- equipment_categories
CREATE TRIGGER trg_equipment_categories_touch BEFORE UPDATE ON public.equipment_categories FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- equipment_manufacturers
CREATE TRIGGER trg_equipment_manufacturers_touch BEFORE UPDATE ON public.equipment_manufacturers FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- equipment_models
CREATE TRIGGER trg_equipment_models_audit AFTER INSERT OR DELETE OR UPDATE ON public.equipment_models FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_equipment_models_touch BEFORE UPDATE ON public.equipment_models FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- expense_categories
CREATE TRIGGER trg_expense_categories_audit AFTER INSERT OR DELETE OR UPDATE ON public.expense_categories FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_expense_categories_touch BEFORE UPDATE ON public.expense_categories FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- import_batches
CREATE TRIGGER trg_import_batches_audit AFTER INSERT OR DELETE OR UPDATE ON public.import_batches FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_import_batches_nao_reabre BEFORE UPDATE ON public.import_batches FOR EACH ROW EXECUTE FUNCTION app.lote_aplicado_nao_reabre();
CREATE TRIGGER trg_import_batches_touch BEFORE UPDATE ON public.import_batches FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- import_rows
CREATE TRIGGER trg_import_rows_reconta AFTER INSERT OR DELETE OR UPDATE ON public.import_rows FOR EACH ROW EXECUTE FUNCTION app.recontar_lote_de_importacao();

-- integration_logs
CREATE TRIGGER trg_integration_logs_counters AFTER INSERT ON public.integration_logs FOR EACH ROW EXECUTE FUNCTION app.integration_logs_after_insert();

-- integration_mappings
CREATE TRIGGER trg_integration_mappings_audit AFTER INSERT OR DELETE OR UPDATE ON public.integration_mappings FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_integration_mappings_touch BEFORE UPDATE ON public.integration_mappings FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_mapping_version_del AFTER DELETE ON public.integration_mappings REFERENCING OLD TABLE AS antigas FOR EACH STATEMENT EXECUTE FUNCTION app.snapshot_mapping_version();
CREATE TRIGGER trg_mapping_version_ins AFTER INSERT ON public.integration_mappings REFERENCING NEW TABLE AS novas FOR EACH STATEMENT EXECUTE FUNCTION app.snapshot_mapping_version();
CREATE TRIGGER trg_mapping_version_upd AFTER UPDATE ON public.integration_mappings REFERENCING NEW TABLE AS novas FOR EACH STATEMENT EXECUTE FUNCTION app.snapshot_mapping_version();

-- integrations
CREATE TRIGGER trg_integrations_audit AFTER INSERT OR DELETE OR UPDATE ON public.integrations FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_integrations_touch BEFORE UPDATE ON public.integrations FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- internet_link_attachments
CREATE TRIGGER trg_internet_link_attachments_audit AFTER INSERT OR DELETE OR UPDATE ON public.internet_link_attachments FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- internet_links
CREATE TRIGGER trg_internet_links_audit AFTER INSERT OR DELETE OR UPDATE ON public.internet_links FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_internet_links_touch BEFORE UPDATE ON public.internet_links FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_links_area_branch BEFORE INSERT OR UPDATE OF branch_area_id, branch_id ON public.internet_links FOR EACH ROW EXECUTE FUNCTION app.validate_area_branch('branch_area_id');

-- inventory_count_items
CREATE TRIGGER trg_inventory_count_items_touch BEFORE UPDATE ON public.inventory_count_items FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- inventory_counts
CREATE TRIGGER trg_inventory_counts_audit AFTER INSERT OR DELETE OR UPDATE ON public.inventory_counts FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_inventory_counts_fecha BEFORE UPDATE ON public.inventory_counts FOR EACH ROW EXECUTE FUNCTION app.fechar_contagem_de_inventario();
CREATE TRIGGER trg_inventory_counts_touch BEFORE UPDATE ON public.inventory_counts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- it_assets
CREATE TRIGGER trg_assets_area_branch BEFORE INSERT OR UPDATE OF branch_area_id, branch_id ON public.it_assets FOR EACH ROW EXECUTE FUNCTION app.validate_area_branch('branch_area_id');
CREATE TRIGGER trg_assets_history AFTER UPDATE ON public.it_assets FOR EACH ROW EXECUTE FUNCTION app.assets_after_update_history();
CREATE TRIGGER trg_it_assets_audit AFTER INSERT OR DELETE OR UPDATE ON public.it_assets FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_it_assets_touch BEFORE UPDATE ON public.it_assets FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- it_budget_closings
CREATE TRIGGER trg_it_budget_closings_audit AFTER INSERT OR DELETE OR UPDATE ON public.it_budget_closings FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- it_budget_targets
CREATE TRIGGER trg_it_budget_targets_audit AFTER INSERT OR DELETE OR UPDATE ON public.it_budget_targets FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_it_budget_targets_touch BEFORE UPDATE ON public.it_budget_targets FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- it_cost_entries
CREATE TRIGGER trg_entry_fechamento BEFORE INSERT OR DELETE OR UPDATE ON public.it_cost_entries FOR EACH ROW EXECUTE FUNCTION app.orcamento_respeita_fechamento();
CREATE TRIGGER trg_it_cost_entries_audit AFTER INSERT OR DELETE OR UPDATE ON public.it_cost_entries FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_it_cost_entries_touch BEFORE UPDATE ON public.it_cost_entries FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- kb_articles
CREATE TRIGGER trg_kb_articles_audit AFTER INSERT OR DELETE OR UPDATE ON public.kb_articles FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_kb_articles_touch BEFORE UPDATE ON public.kb_articles FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- link_availability_events
CREATE TRIGGER trg_link_event_syncs_state AFTER INSERT OR DELETE OR UPDATE ON public.link_availability_events FOR EACH ROW EXECUTE FUNCTION app.sync_link_state();

-- monitoring_webhooks
CREATE TRIGGER trg_monitoring_webhooks_audit AFTER INSERT OR DELETE OR UPDATE ON public.monitoring_webhooks FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- notification_preferences
CREATE TRIGGER trg_notification_preferences_touch BEFORE UPDATE ON public.notification_preferences FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- operation_locations
CREATE TRIGGER trg_operation_locations_touch BEFORE UPDATE ON public.operation_locations FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- part_balances
CREATE TRIGGER trg_part_balances_touch BEFORE UPDATE ON public.part_balances FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- part_movements
CREATE TRIGGER trg_part_movements_aplica AFTER INSERT ON public.part_movements FOR EACH ROW EXECUTE FUNCTION app.aplicar_movimento_de_peca();
CREATE TRIGGER trg_part_movements_imutavel BEFORE DELETE OR UPDATE ON public.part_movements FOR EACH ROW EXECUTE FUNCTION app.movimento_de_peca_e_imutavel();

-- part_stock_policies
CREATE TRIGGER trg_part_stock_policies_touch BEFORE UPDATE ON public.part_stock_policies FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- parts
CREATE TRIGGER trg_parts_audit AFTER INSERT OR DELETE OR UPDATE ON public.parts FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_parts_touch BEFORE UPDATE ON public.parts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- payable_approvals
CREATE TRIGGER trg_payable_approvals_audit AFTER INSERT OR DELETE OR UPDATE ON public.payable_approvals FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- payable_attachments
CREATE TRIGGER trg_payable_attachments_audit AFTER INSERT OR DELETE OR UPDATE ON public.payable_attachments FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- payables
CREATE TRIGGER trg_payables_audit AFTER INSERT OR DELETE OR UPDATE ON public.payables FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_payables_guard BEFORE INSERT OR UPDATE ON public.payables FOR EACH ROW EXECUTE FUNCTION app.payables_guard();
CREATE TRIGGER trg_payables_touch BEFORE UPDATE ON public.payables FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- permission_grants
CREATE TRIGGER trg_permission_grants_audit AFTER INSERT OR DELETE OR UPDATE ON public.permission_grants FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_permission_grants_within_base_role BEFORE INSERT OR UPDATE ON public.permission_grants FOR EACH ROW EXECUTE FUNCTION app.guard_grant_within_base_role();

-- planos
CREATE TRIGGER trg_planos_touch BEFORE UPDATE ON public.planos FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- profiles
CREATE TRIGGER trg_profiles_audit AFTER INSERT OR DELETE OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_profiles_default_access_profile BEFORE INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION app.profiles_default_access_profile();
CREATE TRIGGER trg_profiles_no_escalation BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION app.prevent_self_privilege_escalation();
CREATE TRIGGER trg_profiles_no_self_profile_change BEFORE UPDATE OF access_profile_id ON public.profiles FOR EACH ROW EXECUTE FUNCTION app.guard_access_profile_assignment();
CREATE TRIGGER trg_profiles_touch BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- project_tasks
CREATE TRIGGER trg_project_tasks_audit AFTER INSERT OR DELETE OR UPDATE ON public.project_tasks FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_project_tasks_touch BEFORE UPDATE ON public.project_tasks FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_task_hierarquia BEFORE INSERT OR UPDATE OF parent_task_id, project_id ON public.project_tasks FOR EACH ROW EXECUTE FUNCTION app.tarefa_valida_hierarquia();

-- projects
CREATE TRIGGER trg_projects_audit AFTER INSERT OR DELETE OR UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_projects_touch BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- purchase_order_items
CREATE TRIGGER trg_purchase_order_items_total AFTER INSERT OR DELETE OR UPDATE ON public.purchase_order_items FOR EACH ROW EXECUTE FUNCTION app.recalcular_total_da_ordem();
CREATE TRIGGER trg_purchase_order_items_touch BEFORE UPDATE ON public.purchase_order_items FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- purchase_orders
CREATE TRIGGER trg_purchase_orders_audit AFTER INSERT OR DELETE OR UPDATE ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_purchase_orders_touch BEFORE UPDATE ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- queue_members
CREATE TRIGGER trg_queue_members_audit AFTER INSERT OR DELETE OR UPDATE ON public.queue_members FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- queue_rules
CREATE TRIGGER trg_queue_rules_audit AFTER INSERT OR DELETE OR UPDATE ON public.queue_rules FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_queue_rules_touch BEFORE UPDATE ON public.queue_rules FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- queues
CREATE TRIGGER trg_protect_default_queue BEFORE DELETE OR UPDATE ON public.queues FOR EACH ROW EXECUTE FUNCTION app.protect_default_queue();
CREATE TRIGGER trg_queues_audit AFTER INSERT OR DELETE OR UPDATE ON public.queues FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_queues_touch BEFORE UPDATE ON public.queues FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- receivables
CREATE TRIGGER trg_receivables_audit AFTER INSERT OR DELETE OR UPDATE ON public.receivables FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_receivables_guard BEFORE INSERT OR UPDATE ON public.receivables FOR EACH ROW EXECUTE FUNCTION app.receivables_guard();
CREATE TRIGGER trg_receivables_touch BEFORE UPDATE ON public.receivables FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- rental_contract_items
CREATE TRIGGER trg_rental_contract_items_audit AFTER INSERT OR DELETE OR UPDATE ON public.rental_contract_items FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_rental_contract_items_touch BEFORE UPDATE ON public.rental_contract_items FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_rental_contract_items_valida BEFORE INSERT OR UPDATE ON public.rental_contract_items FOR EACH ROW EXECUTE FUNCTION app.validar_item_de_contrato();

-- rental_contracts
CREATE TRIGGER trg_rental_contracts_audit AFTER INSERT OR DELETE OR UPDATE ON public.rental_contracts FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_rental_contracts_encerra_itens AFTER UPDATE ON public.rental_contracts FOR EACH ROW EXECUTE FUNCTION app.encerrar_itens_do_contrato();
CREATE TRIGGER trg_rental_contracts_touch BEFORE UPDATE ON public.rental_contracts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- rental_depots
CREATE TRIGGER trg_rental_depots_touch BEFORE UPDATE ON public.rental_depots FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- rental_equipment
CREATE TRIGGER trg_rental_equipment_audit AFTER INSERT OR DELETE OR UPDATE ON public.rental_equipment FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_rental_equipment_movimento AFTER INSERT OR UPDATE ON public.rental_equipment FOR EACH ROW EXECUTE FUNCTION app.validar_movimento_de_equipamento();
CREATE TRIGGER trg_rental_equipment_touch BEFORE UPDATE ON public.rental_equipment FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- rental_invoice_items
CREATE TRIGGER trg_rental_invoice_items_total AFTER INSERT OR DELETE OR UPDATE ON public.rental_invoice_items FOR EACH ROW EXECUTE FUNCTION app.recalcular_total_da_fatura();

-- rental_invoices
CREATE TRIGGER trg_numerar_fatura_de_locacao BEFORE INSERT ON public.rental_invoices FOR EACH ROW EXECUTE FUNCTION app.numerar_fatura_de_locacao();
CREATE TRIGGER trg_rental_invoices_audit AFTER INSERT OR DELETE OR UPDATE ON public.rental_invoices FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_rental_invoices_touch BEFORE UPDATE ON public.rental_invoices FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_rental_invoices_valida BEFORE UPDATE ON public.rental_invoices FOR EACH ROW EXECUTE FUNCTION app.validar_fatura();

-- service_approvals
CREATE TRIGGER trg_service_approvals_audit AFTER INSERT OR DELETE OR UPDATE ON public.service_approvals FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- service_catalog
CREATE TRIGGER trg_service_catalog_audit AFTER INSERT OR DELETE OR UPDATE ON public.service_catalog FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_service_catalog_touch BEFORE UPDATE ON public.service_catalog FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- service_catalog_clients
CREATE TRIGGER trg_service_catalog_clients_audit AFTER INSERT OR DELETE OR UPDATE ON public.service_catalog_clients FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_service_catalog_clients_touch BEFORE UPDATE ON public.service_catalog_clients FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- sla_contracts
CREATE TRIGGER trg_sla_contracts_audit AFTER INSERT OR DELETE OR UPDATE ON public.sla_contracts FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_sla_contracts_touch BEFORE UPDATE ON public.sla_contracts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- sla_definitions
CREATE TRIGGER trg_sla_definitions_audit AFTER INSERT OR DELETE OR UPDATE ON public.sla_definitions FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_sla_definitions_touch BEFORE UPDATE ON public.sla_definitions FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- sla_tracking
CREATE TRIGGER trg_sla_tracking_touch BEFORE UPDATE ON public.sla_tracking FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- supplier_contracts
CREATE TRIGGER trg_supplier_contracts_audit AFTER INSERT OR DELETE OR UPDATE ON public.supplier_contracts FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_supplier_contracts_touch BEFORE UPDATE ON public.supplier_contracts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- suppliers
CREATE TRIGGER trg_suppliers_audit AFTER INSERT OR DELETE OR UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_suppliers_touch BEFORE UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- telecom_line_attachments
CREATE TRIGGER trg_telecom_line_attachments_audit AFTER INSERT OR DELETE OR UPDATE ON public.telecom_line_attachments FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- telecom_lines
CREATE TRIGGER trg_lines_area_branch BEFORE INSERT OR UPDATE OF company_area_id, branch_id ON public.telecom_lines FOR EACH ROW EXECUTE FUNCTION app.validate_area_branch('company_area_id');
CREATE TRIGGER trg_telecom_lines_audit AFTER INSERT OR DELETE OR UPDATE ON public.telecom_lines FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_telecom_lines_touch BEFORE UPDATE ON public.telecom_lines FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- tenants
CREATE TRIGGER trg_tenant_categorias AFTER INSERT ON public.tenants FOR EACH ROW EXECUTE FUNCTION app.tenant_cria_categorias();
CREATE TRIGGER trg_tenants_plano_inicial BEFORE INSERT ON public.tenants FOR EACH ROW EXECUTE FUNCTION app.carimbar_plano_inicial();
CREATE TRIGGER trg_tenants_seed_access_profiles AFTER INSERT ON public.tenants FOR EACH ROW EXECUTE FUNCTION app.tenants_seed_access_profiles();
CREATE TRIGGER trg_tenants_status_evento AFTER UPDATE ON public.tenants FOR EACH ROW EXECUTE FUNCTION app.registrar_mudanca_de_status();
CREATE TRIGGER trg_tenants_touch BEFORE UPDATE ON public.tenants FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ticket_attachments
CREATE TRIGGER trg_attachment_kind BEFORE INSERT OR UPDATE OF mime_type ON public.ticket_attachments FOR EACH ROW EXECUTE FUNCTION app.derive_attachment_kind();
CREATE TRIGGER trg_attachment_quota BEFORE INSERT ON public.ticket_attachments FOR EACH ROW EXECUTE FUNCTION app.enforce_ticket_attachment_quota();

-- ticket_categories
CREATE TRIGGER trg_category_depth BEFORE INSERT OR UPDATE OF parent_id ON public.ticket_categories FOR EACH ROW EXECUTE FUNCTION app.enforce_category_depth();
CREATE TRIGGER trg_ticket_categories_audit AFTER INSERT OR DELETE OR UPDATE ON public.ticket_categories FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_ticket_categories_touch BEFORE UPDATE ON public.ticket_categories FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ticket_comments
CREATE TRIGGER trg_comment_first_response AFTER INSERT ON public.ticket_comments FOR EACH ROW EXECUTE FUNCTION app.comments_after_insert_first_response();
CREATE TRIGGER trg_comment_para_canal AFTER INSERT ON public.ticket_comments FOR EACH ROW EXECUTE FUNCTION app.channel_enfileirar_resposta();
CREATE TRIGGER trg_ticket_comments_touch BEFORE UPDATE ON public.ticket_comments FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ticket_field_service
CREATE TRIGGER trg_ticket_field_service_audit AFTER INSERT OR DELETE OR UPDATE ON public.ticket_field_service FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_ticket_field_service_touch BEFORE UPDATE ON public.ticket_field_service FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ticket_parts_used
CREATE TRIGGER trg_ticket_parts_used_baixa AFTER INSERT ON public.ticket_parts_used FOR EACH ROW EXECUTE FUNCTION app.baixar_peca_do_estoque();
CREATE TRIGGER trg_ticket_parts_used_devolve AFTER DELETE ON public.ticket_parts_used FOR EACH ROW EXECUTE FUNCTION app.devolver_peca_ao_estoque();

-- ticket_priorities
CREATE TRIGGER trg_ticket_priorities_audit AFTER INSERT OR DELETE OR UPDATE ON public.ticket_priorities FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_ticket_priorities_touch BEFORE UPDATE ON public.ticket_priorities FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ticket_satisfaction
CREATE TRIGGER trg_ticket_satisfaction_audit AFTER INSERT OR DELETE OR UPDATE ON public.ticket_satisfaction FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER trg_ticket_satisfaction_touch BEFORE UPDATE ON public.ticket_satisfaction FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- tickets
CREATE TRIGGER trg_pedido_exige_aprovacao BEFORE INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION app.pedido_exige_aprovacao();
CREATE TRIGGER trg_pedido_registra_aprovacao AFTER INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION app.pedido_registra_aprovacao();
CREATE TRIGGER trg_ticket_fecha_conversa AFTER UPDATE OF status ON public.tickets FOR EACH ROW EXECUTE FUNCTION app.channel_fechar_conversa();
CREATE TRIGGER trg_tickets_alcada_de_campo BEFORE UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION app.validar_alcada_de_campo();
CREATE TRIGGER trg_tickets_before_insert BEFORE INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION app.tickets_before_insert();
CREATE TRIGGER trg_tickets_before_update BEFORE UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION app.tickets_before_update();
CREATE TRIGGER trg_tickets_history AFTER UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION app.tickets_after_update_history();
CREATE TRIGGER trg_tickets_sla_init AFTER INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION app.tickets_after_insert_sla();
CREATE TRIGGER trg_tickets_sla_pausa_ao_nascer AFTER INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION app.pedido_pausa_sla_ao_nascer();
CREATE TRIGGER trg_tickets_sla_update AFTER UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION app.tickets_after_update_sla();
CREATE TRIGGER trg_tickets_touch BEFORE UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- user_branches
CREATE TRIGGER trg_user_branches_audit AFTER INSERT OR DELETE OR UPDATE ON public.user_branches FOR EACH ROW EXECUTE FUNCTION app.audit_row();
