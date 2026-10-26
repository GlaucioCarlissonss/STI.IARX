-- =============================================================================
-- 0045 — Abrir chamado sob RLS: três privilégios que faltavam
-- =============================================================================
-- CORREÇÃO DE DEFEITO, e os três vieram do mesmo lugar: o app passou a rodar
-- contra um PostgreSQL de verdade, com sessão de verdade, e **abrir um chamado
-- não funcionava para ninguém que não fosse administrador**.
--
-- Os três estão em caminhos diferentes e falhavam em sequência — cada correção
-- revelava o próximo. Nenhum deles aparece em teste de schema, porque lá o
-- chamado é criado pelo DONO do banco, que tem BYPASSRLS.
--
-- 1. O CONTADOR DE NÚMERO DO CHAMADO
-- -----------------------------------
-- Desde a migração 0005, a trigger que numera o chamado faz isto:
--
--     update public.tenants
--        set ticket_seq = ticket_seq + 1
--      where id = new.tenant_id
--     returning ticket_seq into v_next;
--
--     if v_next is null then
--       raise exception 'Tenant % inexistente' using errcode = 'foreign_key_violation';
--     end if;
--
-- A trigger NÃO é `security definer`, então o `update` passa pelas policies de
-- quem está abrindo o chamado. E a policy `tenants_update` (0012) exige
-- `app.can_manage_config()` — isto é, `admin` ou `super_admin`.
--
-- O QUE ISSO SIGNIFICAVA NA PRÁTICA
-- ----------------------------------
-- **Ninguém que não fosse administrador conseguia abrir um chamado.** Nem o
-- solicitante pelo portal, nem o atendente pela tela de abertura. Para eles o
-- `update` atingia zero linhas, `v_next` voltava nulo, e a trigger levantava
-- "Tenant inexistente" — que a aplicação, corretamente, traduz como
-- *"Este registro está vinculado a outro cadastro e não pode ser alterado"*.
--
-- Uma mensagem que não tem nada a ver com o que aconteceu, num caminho que é a
-- função principal do produto.
--
-- POR QUE NENHUM TESTE PEGOU
-- ---------------------------
-- As 1.029 asserções de schema criam chamados como DONO do banco, que tem
-- `BYPASSRLS` — ali o `update` sempre funciona. E as asserções de RLS que usam
-- `rls_tester` só LIAM tickets; nenhuma abria um.
--
-- Foi preciso rodar a aplicação de verdade, com sessão de verdade, para o
-- defeito aparecer. Está coberto agora, na seção 48.
--
-- A CORREÇÃO: UM AJUDANTE `security definer` SÓ PARA O CONTADOR
-- --------------------------------------------------------------
-- Marcar a trigger inteira como `security definer` resolveria e seria demais:
-- ela também deriva filial, deriva cliente e roteia fila, e todas essas
-- leituras passariam a ignorar o RLS. O contador é a única parte que precisa de
-- privilégio, e é só ela que o ganha.
-- =============================================================================

begin;

create or replace function app.proximo_numero_de_ticket(p_tenant_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_next bigint;
begin
  update public.tenants
     set ticket_seq = ticket_seq + 1
   where id = p_tenant_id
  returning ticket_seq into v_next;

  return v_next;
end;
$$;

revoke all on function app.proximo_numero_de_ticket(uuid) from public;
grant execute on function app.proximo_numero_de_ticket(uuid) to authenticated, anon, service_role;

comment on function app.proximo_numero_de_ticket(uuid) is
  'Incrementa e devolve o número do próximo chamado. `security definer` porque `tenants_update` exige admin, e quem abre chamado não é admin.';

/*
 * A trigger continua idêntica em tudo o mais. Só a linha do contador mudou —
 * e, com ela, o único privilégio que ela pedia e não tinha.
 *
 * `anon` recebe execução porque os canais de conversa (0034) criam chamado pela
 * função `channel_ingest`, que roda como `anon`. Sem isso, a correção
 * consertaria a tela e quebraria o WhatsApp.
 */
create or replace function app.tickets_before_insert()
returns trigger
language plpgsql
as $$
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
$$;

/*
 * 3. AS TRIGGERS DE ESCRITURAÇÃO DO CHAMADO
 * ------------------------------------------
 * `sla_tracking`, `sla_pauses` e `ticket_history` têm **apenas policy de
 * leitura** — de propósito: elas são derivadas, e ninguém deve escrevê-las à
 * mão. Quem as mantém são as triggers.
 *
 * Só que as triggers não eram `security definer`. Sob `force row level
 * security`, a ausência de policy de escrita nega o `insert` **independentemente
 * do GRANT de tabela** — então isto não é um artefato do ambiente local: no
 * Supabase acontece igual.
 *
 * O efeito: **abrir um chamado falhava para qualquer sessão autenticada**, e
 * mudar o estado de um chamado também. A função principal do produto.
 *
 * O `alter function` é de propósito mais cirúrgico que recriar o corpo: o que
 * estava errado era o privilégio, não a lógica, e reescrever três corpos aqui
 * só criaria oportunidade de divergir da 0005 e da 0006.
 */
alter function app.tickets_after_insert_sla()     security definer;
alter function app.tickets_after_update_sla()     security definer;
alter function app.tickets_after_update_history() security definer;

alter function app.tickets_after_insert_sla()     set search_path = public, pg_temp;
alter function app.tickets_after_update_sla()     set search_path = public, pg_temp;
alter function app.tickets_after_update_history() set search_path = public, pg_temp;

/*
 * 4. A TRIGGER DE APROVAÇÃO GRAVAVA ONDE O USUÁRIO SÓ LÊ
 * -------------------------------------------------------
 * A 0043 concedeu apenas `select` em `service_approvals` — de propósito: a
 * decisão passa pela função `decidir_pedido()`, e um `update` direto poderia
 * marcar "aprovado" sem mexer no chamado.
 *
 * Só que a CRIAÇÃO da linha pendente acontece numa trigger, no momento em que o
 * pedido vira chamado. Sem `security definer`, ela roda como quem pediu — e
 * quem pediu tem só leitura. Resultado: todo pedido de serviço que exigia
 * aprovação falhava com "permission denied for table service_approvals",
 * traduzido na tela como "registro não encontrado ou sem permissão".
 *
 * `security definer` aqui não afrouxa nada: a linha é derivada inteiramente do
 * chamado que está sendo inserido, e não há parâmetro que o usuário controle.
 */
create or replace function app.pedido_registra_aprovacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
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

/*
 * E a pausa do relógio, pelo mesmo motivo: ela grava em `sla_pauses` e atualiza
 * `sla_tracking`, e quem abre o chamado não escreve em nenhuma das duas. A
 * trigger irmã da 0006 já é `security definer` — esta nasceu sem, e o defeito
 * ficaria escondido atrás do anterior.
 */
create or replace function app.pedido_pausa_sla_ao_nascer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
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

commit;
