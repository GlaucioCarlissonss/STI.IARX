-- =============================================================================
-- 0048 — A frota de locação (Fase 2 da unificação com o LTI — docs/23)
-- =============================================================================
-- O equipamento PRÓPRIO destinado a locar. Não se confunde com `it_assets`, e a
-- diferença é a pergunta que cada tabela responde:
--
--   `it_assets`         — "quem está com isto, e até quando a garantia cobre?"
--                         Inclui o bem alugado DE um fornecedor.
--   `rental_equipment`  — "para qual cliente está locado, quanto rodou no mês e
--                         quanto me custou manter?" Só bem próprio, destinado a
--                         locar.
--
-- Um bem não está nos dois lugares. Hoje isso é convenção de uso; quando o
-- contrato existir (Fase 3), a alocação passa a ser a prova material da
-- diferença — `it_assets` não tem contrato de locação, e não vai ter.
--
-- ## O que esta migração NÃO faz
--
-- Não cria contrato, medição nem fatura. O medidor entra como LEITURA do
-- equipamento (um número e a data em que foi lido), porque a frota precisa
-- mostrar horímetro desde o primeiro dia; quem escreve leitura em série, e quem
-- transforma leitura em dinheiro, é a Fase 4.
--
-- Também não cria o "local de operação" (o endereço do cliente onde a máquina
-- fica). Sem contrato não há o que alocar a ele, e uma tabela sem quem a
-- preencha é pior que a ausência dela: ela parece configuração pendente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Depósitos — onde a frota mora quando não está com cliente
-- -----------------------------------------------------------------------------
-- `branches` NÃO serve aqui, e isso não é detalhe: naquela tabela a filial é do
-- CLIENTE (`client_id not null`). O depósito é da casa — a base, a oficina, o
-- galpão. Usar `branches` faria a frota própria aparecer pendurada num cliente,
-- e a primeira consulta de ocupação por cliente contaria o próprio estoque.
--
-- A Fase 6 (peças e estoque) reaproveita esta tabela: o depósito de peça é o
-- mesmo lugar físico, e duas tabelas de depósito divergiriam no primeiro
-- endereço corrigido em uma só.
create table public.rental_depots (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  code       text,
  kind       text not null default 'warehouse'
               check (kind in ('warehouse', 'workshop', 'transit')),
  city       text,
  state      char(2),
  notes      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index rental_depots_name_uk
  on public.rental_depots (tenant_id, lower(name)) where deleted_at is null;
create index rental_depots_tenant_idx on public.rental_depots (tenant_id) where deleted_at is null;

comment on table public.rental_depots is
  'Bases da própria empresa onde a frota fica: galpão, oficina, trânsito. Diferente de `branches`, que é filial de cliente.';

-- -----------------------------------------------------------------------------
-- 2. Fabricante, categoria e modelo
-- -----------------------------------------------------------------------------
create table public.equipment_manufacturers (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,
  support_contact text,
  notes           text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create unique index equipment_manufacturers_name_uk
  on public.equipment_manufacturers (tenant_id, lower(name)) where deleted_at is null;

-- A categoria carrega os PADRÕES do tipo de bem: que medidor ele costuma ter e
-- quantos meses de vida útil. São padrões, não regras — o equipamento pode
-- divergir —, e existem para que cadastrar o quadragésimo concentrador não
-- exija lembrar o que vale para concentrador.
create table public.equipment_categories (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  code          text not null,
  name          text not null,
  /* `none` é a escolha certa para cama hospitalar e mobiliário: eles locam por
     tempo, não por uso. Um medidor obrigatório inventaria horímetro onde não
     existe, e a Fase 4 cobraria leitura de um aparelho que não mede nada. */
  default_meter_kind text not null default 'none'
                  check (default_meter_kind in ('none', 'hours', 'cycles', 'distance')),
  default_useful_life_months integer
                  check (default_useful_life_months is null or default_useful_life_months between 1 and 600),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create unique index equipment_categories_code_uk
  on public.equipment_categories (tenant_id, lower(code)) where deleted_at is null;

-- O MODELO é onde o preço de tabela mora, e é isso que o separa do equipamento:
-- preço é do modelo (todo concentrador 5L custa o mesmo), e patrimônio é da
-- peça física. Guardar preço no equipamento faria uma correção de tabela virar
-- um `update` em duzentas linhas — e a primeira que escapasse passaria a cobrar
-- diferente das outras, sem ninguém perceber.
create table public.equipment_models (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  manufacturer_id uuid not null references public.equipment_manufacturers(id) on delete restrict,
  category_id     uuid not null references public.equipment_categories(id) on delete restrict,
  code            text not null,
  name            text not null,
  /* Ficha técnica livre: cada categoria tem os seus campos (vazão, tensão,
     capacidade), e uma coluna por atributo viraria uma tabela com oitenta
     colunas nulas. O que a aplicação lê daqui é texto para exibir, nunca regra. */
  specs           jsonb not null default '{}'::jsonb,
  monthly_price   numeric(14,2) check (monthly_price is null or monthly_price >= 0),
  daily_price     numeric(14,2) check (daily_price is null or daily_price >= 0),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create unique index equipment_models_code_uk
  on public.equipment_models (tenant_id, lower(code)) where deleted_at is null;
create index equipment_models_category_idx on public.equipment_models (tenant_id, category_id);

-- -----------------------------------------------------------------------------
-- 3. As transições de estado — em tabela, como as do chamado (ADR-007)
-- -----------------------------------------------------------------------------
-- Dez estados, vindos do Anexo B.2 do LTI. Em tabela, e não em `CHECK`, pelo
-- mesmo motivo de `ticket_status_transitions`: a TELA lê daqui para desenhar só
-- os botões que o banco aceita. Uma lista dentro de uma função seria invisível
-- para a aplicação, e aí a tela ofereceria transições que o banco recusa — o
-- erro aparecendo depois do clique, no lugar de não existir.
create table public.rental_equipment_status_transitions (
  from_status text not null,
  to_status   text not null,
  description text,
  primary key (from_status, to_status)
);

insert into public.rental_equipment_status_transitions (from_status, to_status, description) values
  ('available',       'reserved',        'Contrato ativado: a peça saiu da base alocável'),
  ('reserved',        'in_transit_out',  'Expedido para o cliente'),
  ('reserved',        'available',       'Contrato cancelado antes da expedição'),
  ('in_transit_out',  'rented',          'Entregue e em operação'),
  ('in_transit_out',  'available',       'Chegada da transferência entre depósitos'),
  ('rented',          'in_transit_back', 'Recolhido no cliente'),
  ('in_transit_back', 'inspection',      'Chegou na base para conferência'),
  ('inspection',      'available',       'Conferido e devolvido à base alocável'),
  ('inspection',      'maintenance',     'Conferido e reprovado: vai para a oficina'),
  ('available',       'in_transit_out',  'Transferência entre depósitos'),
  ('available',       'maintenance',     'Preventiva ou conserto'),
  ('rented',          'maintenance',     'Atendimento em campo que tirou a peça de operação'),
  ('maintenance',     'available',       'Conserto concluído: volta para a base'),
  ('maintenance',     'rented',          'Conserto concluído: o contrato continua, volta para o cliente'),
  ('blocked',         'available',       'Desbloqueado'),
  ('blocked',         'maintenance',     'Preventiva que destrava: ver o comentário do gatilho');

/*
 * Bloqueio, extravio e baixa NÃO estão na tabela — e a ausência é a regra.
 *
 * Os três são alcançáveis de QUALQUER estado, porque são fatos e não etapas.
 * Restringir a origem pareceria mais seguro e seria pior: uma máquina condenada
 * durante o conserto teria de passar por `available` para ser baixada, e nesse
 * instante ela estaria na base alocável — oferecida ao próximo contrato.
 *
 * O gatilho abaixo é quem sabe disso. Pô-los na tabela como trinta linhas
 * (10 origens × 3 destinos) diria a mesma coisa e esconderia o porquê.
 */

-- -----------------------------------------------------------------------------
-- 4. O equipamento
-- -----------------------------------------------------------------------------
create table public.rental_equipment (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  /* Patrimônio é o número que está COLADO na máquina, e é por ele que quem
     está no campo a identifica. Único por tenant: dois com a mesma etiqueta
     fazem a leitura de medidor ir para a peça errada. */
  asset_tag     text not null,
  serial_number text,

  model_id      uuid not null references public.equipment_models(id) on delete restrict,
  depot_id      uuid references public.rental_depots(id) on delete restrict,

  status        text not null default 'available'
                  check (status in (
                    'available', 'reserved', 'in_transit_out', 'rented',
                    'in_transit_back', 'inspection', 'maintenance',
                    'blocked', 'lost', 'written_off'
                  )),

  /*
   * O BLOQUEIO é atributo, não estado — e os dois coexistem de propósito.
   *
   * "Preventiva vencida" precisa impedir nova alocação sem tirar a máquina de
   * operação: ela continua `rented`, faturando, e ao voltar não entra na base
   * alocável. Se isso fosse um estado, bloquear uma peça locada a arrancaria do
   * cliente no banco de dados e em lugar nenhum mais.
   */
  blocked       boolean not null default false,
  block_reason  text,
  block_until   date,

  meter_kind    text not null default 'none'
                  check (meter_kind in ('none', 'hours', 'cycles', 'distance')),
  meter_reading numeric(14,2) not null default 0 check (meter_reading >= 0),
  meter_read_at timestamptz,

  acquisition_date  date,
  acquisition_value numeric(14,2) check (acquisition_value is null or acquisition_value >= 0),
  invoice_ref       text,
  useful_life_months integer check (useful_life_months is null or useful_life_months between 1 and 600),

  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  /* Motivo do bloqueio junto com o bloqueio: um `blocked = true` sem motivo é
     uma máquina parada que ninguém sabe por quê, e quem a encontra assim tende
     a desbloquear para destravar o contrato. */
  constraint rental_equipment_bloqueio_tem_motivo
    check (not blocked or block_reason is not null),

  /* Medidor sem tipo não registra leitura: um horímetro em "sem medidor" seria
     número que ninguém sabe ler — hora? ciclo? quilômetro? */
  constraint rental_equipment_medidor_coerente
    check (meter_kind <> 'none' or (meter_reading = 0 and meter_read_at is null))
);

create unique index rental_equipment_tag_uk
  on public.rental_equipment (tenant_id, lower(asset_tag)) where deleted_at is null;
create unique index rental_equipment_serial_uk
  on public.rental_equipment (tenant_id, lower(serial_number))
  where deleted_at is null and serial_number is not null;
create index rental_equipment_status_idx on public.rental_equipment (tenant_id, status) where deleted_at is null;
create index rental_equipment_model_idx on public.rental_equipment (tenant_id, model_id) where deleted_at is null;

comment on table public.rental_equipment is
  'Frota própria destinada a locar. Ciclo de vida de dez estados governado por gatilho (Anexo B.2 do LTI).';

-- -----------------------------------------------------------------------------
-- 5. A movimentação — o histórico que o gatilho escreve sozinho
-- -----------------------------------------------------------------------------
-- Escrito pelo BANCO, e não pela aplicação. A trilha de auditoria registra que
-- a coluna mudou; isto registra o que aconteceu com a máquina, em linguagem de
-- quem opera — e continua registrando quando alguém mexe por SQL direto, que é
-- justamente quando o histórico mais importa.
create table public.rental_equipment_movements (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  equipment_id uuid not null references public.rental_equipment(id) on delete cascade,
  kind         text not null check (kind in ('status', 'depot', 'meter', 'block', 'note')),
  from_status  text,
  to_status    text,
  from_depot_id uuid references public.rental_depots(id) on delete set null,
  to_depot_id   uuid references public.rental_depots(id) on delete set null,
  meter_reading numeric(14,2),
  notes        text,
  created_by   uuid,
  created_at   timestamptz not null default now()
);

create index rental_equipment_movements_eq_idx
  on public.rental_equipment_movements (tenant_id, equipment_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 6. O gatilho do ciclo de vida
-- -----------------------------------------------------------------------------
create or replace function app.validar_movimento_de_equipamento()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
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
$$;

create trigger trg_rental_equipment_movimento
  after insert or update on public.rental_equipment
  for each row execute function app.validar_movimento_de_equipamento();

-- -----------------------------------------------------------------------------
-- 7. RLS
-- -----------------------------------------------------------------------------
select app.harden_table('public.rental_depots');
select app.harden_table('public.equipment_manufacturers');
select app.harden_table('public.equipment_categories');
select app.harden_table('public.equipment_models');
select app.harden_table('public.rental_equipment');
select app.harden_table('public.rental_equipment_movements');

select app.attach_audit('public.rental_equipment');
select app.attach_audit('public.equipment_models');

-- A tabela de transições é catálogo da plataforma, como a dos chamados: leitura
-- para qualquer sessão autenticada, escrita por ninguém.
alter table public.rental_equipment_status_transitions enable row level security;
create policy rental_transitions_select on public.rental_equipment_status_transitions
  for select to authenticated using (true);

create policy rental_depots_select on public.rental_depots
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.frota.ver'));
create policy rental_depots_write on public.rental_depots
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.cadastros.gerenciar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.cadastros.gerenciar'));

create policy equipment_manufacturers_select on public.equipment_manufacturers
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.cadastros.ver'));
create policy equipment_manufacturers_write on public.equipment_manufacturers
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.cadastros.gerenciar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.cadastros.gerenciar'));

create policy equipment_categories_select on public.equipment_categories
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.cadastros.ver'));
create policy equipment_categories_write on public.equipment_categories
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.cadastros.gerenciar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.cadastros.gerenciar'));

/* Modelo é lido por quem consulta a FROTA — o nome do modelo é metade da
   identificação da máquina na lista. Por isso o select dele pede
   `locacao.frota.ver`, e não a chave de cadastro. */
create policy equipment_models_select on public.equipment_models
  for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and (app.has_permission('locacao.frota.ver') or app.has_permission('locacao.cadastros.ver')));
create policy equipment_models_write on public.equipment_models
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.cadastros.gerenciar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.cadastros.gerenciar'));

create policy rental_equipment_select on public.rental_equipment
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.frota.ver'));
create policy rental_equipment_insert on public.rental_equipment
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_permission('locacao.frota.criar'));
create policy rental_equipment_update on public.rental_equipment
  for update to authenticated
  using (tenant_id = app.current_tenant_id()
         and (app.has_permission('locacao.frota.editar') or app.has_permission('locacao.frota.mover')))
  with check (tenant_id = app.current_tenant_id()
              and (app.has_permission('locacao.frota.editar') or app.has_permission('locacao.frota.mover')));

/* O histórico é lido por quem lê a frota e escrito por NINGUÉM pela policy: as
   linhas nascem do gatilho, que é `security definer`. Movimento digitado à mão
   seria história inventada. */
create policy rental_movements_select on public.rental_equipment_movements
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('locacao.frota.ver'));

-- -----------------------------------------------------------------------------
-- 7.1 Privilégios de tabela
-- -----------------------------------------------------------------------------
-- RLS decide QUAIS LINHAS; o `grant` decide se a tabela pode ser tocada. Sem
-- ele o PostgreSQL recusa antes de olhar a policy, e o driver devolve erro —
-- que o `?? []` da tela transforma em lista vazia. O sintoma não é "sem
-- permissão": é "a frota está vazia", que parece dado faltando e manda procurar
-- no lugar errado. Foi exatamente o que aconteceu no primeiro teste desta tela.
grant select, insert, update on public.rental_depots to authenticated;
grant select, insert, update on public.equipment_manufacturers to authenticated;
grant select, insert, update on public.equipment_categories to authenticated;
grant select, insert, update on public.equipment_models to authenticated;
grant select, insert, update on public.rental_equipment to authenticated;
grant select on public.rental_equipment_movements to authenticated;
grant select on public.rental_equipment_status_transitions to authenticated;

/* Sem `delete` em nenhuma delas, e de propósito: equipamento sai de cena por
   `written_off`, que preserva histórico, patrimônio e contratos passados.
   Apagar a linha apagaria junto a explicação de uma fatura antiga. */

-- -----------------------------------------------------------------------------
-- 8. Catálogo de permissões
-- -----------------------------------------------------------------------------
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('locacao',                    'locacao', null,        null,        'Locação',                         'visualizador', 500),
  ('locacao.frota',              'locacao', 'frota',     null,        'Frota',                           'visualizador', 501),
  ('locacao.frota.ver',          'locacao', 'frota',     'ver',       'Consultar a frota',               'visualizador', 502),
  ('locacao.frota.criar',        'locacao', 'frota',     'criar',     'Cadastrar equipamento',           'gestor',       503),
  ('locacao.frota.editar',       'locacao', 'frota',     'editar',    'Editar ficha do equipamento',     'gestor',       504),
  ('locacao.frota.mover',        'locacao', 'frota',     'mover',     'Mover o ciclo de vida',           'atendente',    505),
  ('locacao.cadastros',          'locacao', 'cadastros', null,        'Modelos e categorias',            'visualizador', 510),
  ('locacao.cadastros.ver',      'locacao', 'cadastros', 'ver',       'Consultar modelos e categorias',  'visualizador', 511),
  ('locacao.cadastros.gerenciar','locacao', 'cadastros', 'gerenciar', 'Cadastrar fabricante, categoria, modelo e depósito', 'gestor', 512)
on conflict (key) do nothing;

/*
 * `locacao.frota.mover` é `atendente`, e as de cadastro são `gestor`.
 *
 * Quem recolhe, entrega e leva para a oficina é quem está no campo — exigir
 * papel de gestão para mover o ciclo de vida faria o técnico mandar mensagem
 * para alguém mexer no sistema por ele, e o estado da frota passaria a ser o
 * que o escritório teve tempo de digitar. Já cadastrar modelo e preço de
 * tabela é decisão comercial, e essa é de gestão.
 */
