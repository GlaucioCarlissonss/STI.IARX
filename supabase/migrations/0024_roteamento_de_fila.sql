-- =============================================================================
-- 0024 — Roteamento automático de ticket: a regra passa a ser avaliada
-- =============================================================================
-- `public.queue_rules` existe desde a 0004, tem RLS, auditoria, índice de
-- avaliação e DUAS regras semeadas. O comentário da 0004 diz, textualmente:
--
--   "A avaliação é feita por fn_route_ticket, com semântica AND entre as chaves."
--
-- `fn_route_ticket` NUNCA FOI ESCRITA. Hoje um ticket sem fila cai direto na fila
-- padrão (a trigger da 0005) e as regras não são lidas por ninguém — tabela
-- semeada, auditada e inerte. O README dizia que faltava "a edição pela UI", o
-- que subestima o problema: não faltava o editor, faltava o motor.
--
-- Esta migração escreve o motor. A tela vem junto, porque regra que não se pode
-- configurar sem SQL continua sendo regra de ninguém.
-- =============================================================================

begin;

/**
 * Fila de destino de um ticket, pela primeira regra que casar.
 *
 * SEMÂNTICA, e cada escolha tem um porquê:
 *
 * 1. **AND entre as chaves presentes.** Chave ausente não restringe. É o que a
 *    0004 prometeu, e o que torna `{"category_id": X}` legível como "tudo desta
 *    categoria".
 *
 * 2. **Categoria casa com a própria OU com a filha.** As duas regras semeadas
 *    apontam para categorias PAI (Infraestrutura, Telefonia) e os tickets usam
 *    categorias FILHAS (Rede / Internet, Linha móvel). Com casamento exato,
 *    nenhuma das duas dispararia — o seed demonstraria um recurso que não
 *    funciona. É também como `app.fn_resolve_sla` já trata categoria, e como o
 *    protótipo roteia.
 *
 * 3. **Chave desconhecida faz a regra NÃO casar.** Ignorar o que não se entende
 *    seria pior do que parece: uma regra com `{"categoy_id": "..."}` (com erro de
 *    digitação) viraria, na prática, `{}` — e mandaria TODO ticket para aquela
 *    fila. Falhar fechado transforma o erro de digitação numa regra que não faz
 *    nada, que é visível, em vez de numa que faz tudo, que não é.
 *
 * 4. **Condição vazia não casa.** Regra sem condição nenhuma é regra inacabada,
 *    não é curinga. Quem quer curinga usa a fila padrão, que já existe.
 *
 * 5. **Comparação por texto, não por cast.** `conditions` é jsonb livre; um
 *    `::uuid` sobre lixo levantaria exceção dentro de uma trigger de INSERT e
 *    derrubaria a criação do ticket. Aqui valor estranho simplesmente não casa.
 *
 * Devolve NULL quando nenhuma regra casa — quem chama decide o que fazer, e na
 * trigger isso significa cair na fila padrão.
 */
create or replace function app.fn_route_ticket(
  p_tenant_id     uuid,
  p_category_id   uuid    default null,
  p_priority_id   uuid    default null,
  p_branch_id     uuid    default null,
  p_source_system text    default null
)
returns uuid
language plpgsql
stable
as $$
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
$$;

comment on function app.fn_route_ticket(uuid, uuid, uuid, uuid, text) is
  'Fila de destino pela primeira regra ativa que casar, em ordem de sort_order. NULL quando nenhuma casa.';

/**
 * Trigger de criação, com a ordem corrigida.
 *
 * A versão da 0005 resolvia a fila ANTES de derivar a filial. Como a filial pode
 * vir do solicitante, uma regra que roteia por filial nunca enxergaria o valor
 * derivado — rotearia pelo NULL e não casaria. Agora a ordem é: numerar, derivar
 * filial, derivar cliente, rotear, e só então cair na fila padrão.
 *
 * Fila informada explicitamente continua mandando: a pessoa que escolheu a fila
 * na tela sabe mais que a regra genérica.
 */
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

  -- Filial não informada: deriva do solicitante quando ele tem filial primária.
  -- Precisa vir ANTES do roteamento — ver o docblock acima.
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
$$;

-- -----------------------------------------------------------------------------
-- Chave nova no catálogo
-- -----------------------------------------------------------------------------
-- Em sincronia com PERMISSION_CATALOG em src/lib/permissions.ts.
--
-- UMA chave para criar, editar e inativar regra: as três são a mesma decisão
-- ("configurar o roteamento"), e separá-las produziria três caixas que ninguém
-- marcaria de forma diferente. Mesmo critério de
-- `financeiro.titulos_pagar.configurar`.
--
-- LER a lista de regras continua sob `helpdesk.filas.ver`: saber por que o seu
-- ticket caiu naquela fila é informação de trabalho, não configuração.
--
-- `sort_order` 135: livre entre `helpdesk.filas.ver` (130) e o módulo `sla` (140).
-- Teto `gestor` — e é ele que mantém o Operador de TI fora, apesar de a regra do
-- perfil conceder o módulo `helpdesk` inteiro: `role_rank('gestor')` é maior que
-- o teto `atendente` do perfil.
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('helpdesk.filas.configurar_regras', 'helpdesk', 'filas', 'configurar_regras',
   'Configurar regras de roteamento', 'gestor', 135)
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
end;
$$;

commit;
