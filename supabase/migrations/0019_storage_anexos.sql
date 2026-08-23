-- =============================================================================
-- 0019 — Storage de anexos: bucket privado e autorização por caminho
-- =============================================================================
-- Fecha uma lacuna de infraestrutura, não de modelagem. Existem QUATRO tabelas
-- de anexo desde a 0005 e a 0013 — `ticket_attachments`, `asset_attachments`,
-- `telecom_line_attachments`, `internet_link_attachments` — todas com
-- `storage_path text not null`, e nenhuma linha de código que suba arquivo. Ou
-- seja: hoje é impossível anexar um documento a um ticket. A coluna existe, a FK
-- composta existe e a cota já é validada no banco (`trg_attachment_quota`,
-- 0013); faltava o bucket e a autorização.
--
-- Isto também é pré-requisito de dois módulos financeiros especificados em
-- docs/07: título a pagar sem NF/boleto não serve operacionalmente, e controle
-- de despesa depende de comprovante.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Bucket
-- -----------------------------------------------------------------------------
-- PRIVADO. Bucket público transformaria `storage_path` em URL adivinhável, e
-- anexo de ticket de Home Care pode conter dado de saúde do paciente — o tipo de
-- dado em que "ninguém vai adivinhar o caminho" não é controle de acesso.
--
-- O limite de 25 MB por arquivo é teto de UM arquivo e não substitui a cota por
-- ticket, que é do tenant (`tenants.attachment_quota_mb`) e continua na trigger
-- da 0013. São controles diferentes: um impede o upload gigante, o outro impede
-- a soma dos pequenos.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'anexos', 'anexos', false, 26214400,
  array[
    'application/pdf',
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'application/xml', 'text/xml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/plain', 'text/csv'
  ]
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

comment on table storage.buckets is
  'Buckets do Storage. `anexos` é privado: o acesso passa por URL assinada.';

-- -----------------------------------------------------------------------------
-- A convenção de caminho
-- -----------------------------------------------------------------------------
-- {tenant_id}/{entidade}/{entity_id}/{arquivo}
--
-- Isto NÃO é invenção desta migração: `supabase/seed.sql` já grava
-- `format('%s/%s/contrato-nl-link-001.pdf', k.tenant_id, k.id)`. O primeiro
-- segmento sendo o tenant é o que permite ao Storage ter a mesma fronteira de
-- isolamento das 138 policies de `public` (ADR-002), em vez de uma paralela.

/**
 * Tenant do caminho, ou NULL se o caminho não seguir a convenção.
 *
 * O cast direto `(...)[1]::uuid` levantaria exceção em caminho malformado, e
 * exceção dentro de policy vira erro 500 opaco em vez de negação limpa. Aqui
 * caminho estranho devolve NULL, e NULL reprova a comparação — nega.
 */
create or replace function app.storage_tenant(p_name text)
returns uuid
language plpgsql
immutable
as $$
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
$$;

comment on function app.storage_tenant(text) is
  'Primeiro segmento do caminho como uuid; NULL se o caminho fugir da convenção.';

/**
 * Entidade do caminho — segundo segmento.
 */
create or replace function app.storage_entity(p_name text)
returns text
language sql
immutable
as $$
  select (storage.foldername(p_name))[2];
$$;

/**
 * Chave de permissão exigida para um verbo sobre a entidade.
 *
 * Mapa EXPLÍCITO, e o `else null` é a decisão de segurança: entidade que não
 * está aqui não tem chave, e sem chave `app.can_touch_attachment()` nega. Prefixo
 * novo no bucket não nasce liberado por esquecimento.
 *
 * `links` está deliberadamente FORA. A tabela `internet_link_attachments` existe
 * (0013:496), mas a tela de Links de Internet não existe na aplicação — só no
 * protótipo. Cadastrar `conectividade.links.anexar` agora criaria permissão que
 * não governa tela nenhuma, que é exatamente o defeito corrigido nesta mesma
 * rodada em seis outras chaves. Entra junto com a tela.
 */
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
    else null
  end;
$$;

/**
 * O predicado único das policies do bucket.
 *
 * Segue o padrão de `app.can_see_branch()` (0002): a condição mora numa função
 * reutilizada, não copiada em cada policy — três cópias divergiriam na primeira
 * manutenção.
 *
 * Nega por omissão em toda saída: caminho fora da convenção, tenant diferente,
 * entidade desconhecida, verbo desconhecido, chave inexistente. A checagem
 * explícita de `key is not null` não é redundância defensiva: `has_permission`
 * recebendo NULL percorreria uma lista vazia de ancestrais e devolveria TRUE,
 * liberando justamente o caso que ninguém previu.
 */
create or replace function app.can_touch_attachment(p_name text, p_verb text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, storage, pg_temp
as $$
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
$$;

comment on function app.can_touch_attachment(text, text) is
  'Predicado das policies do bucket `anexos`: tenant do caminho + permissão da entidade. Nega por omissão.';

-- -----------------------------------------------------------------------------
-- Policies do bucket
-- -----------------------------------------------------------------------------
-- Só `create policy`: RLS em `storage.objects` já vem habilitado do Supabase, e
-- a tabela pertence a `supabase_storage_admin`. Mexer no enforcement dela
-- quebraria o serviço de Storage.
--
-- Verbos separados porque são decisões distintas: quem consulta anexo não é
-- necessariamente quem anexa, e apagar documento fiscal é ação própria.
drop policy if exists anexos_select on storage.objects;
create policy anexos_select on storage.objects
  for select to authenticated
  using (bucket_id = 'anexos' and app.can_touch_attachment(name, 'ver'));

drop policy if exists anexos_insert on storage.objects;
create policy anexos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'anexos' and app.can_touch_attachment(name, 'anexar'));

drop policy if exists anexos_delete on storage.objects;
create policy anexos_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'anexos' and app.can_touch_attachment(name, 'remover'));

-- Sem policy de UPDATE de propósito: trocar o conteúdo de um anexo por outro,
-- mantendo o mesmo caminho e o mesmo registro de metadados, é substituição
-- silenciosa de prova documental. Corrigir é remover e anexar de novo, que deixa
-- rastro nas duas tabelas.

-- -----------------------------------------------------------------------------
-- Chaves novas no catálogo
-- -----------------------------------------------------------------------------
-- Mantidas em sincronia com `PERMISSION_CATALOG` em `src/lib/permissions.ts`.
-- `sort_order` usa os intervalos livres entre as chaves existentes, para a matriz
-- da tela de perfis mostrar cada ação junto da sua tela.
--
-- `anexar` em ticket é `solicitante`: quem abre o chamado precisa poder mandar o
-- print do erro, e é o caso mais comum de anexo no helpdesk. Remover é
-- `atendente` — deixar o solicitante apagar anexo do próprio ticket depois de
-- escalado apagaria evidência.
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('helpdesk.tickets.anexar', 'helpdesk', 'tickets', 'anexar',
   'Anexar arquivo', 'solicitante', 112),
  ('helpdesk.tickets.remover_anexo', 'helpdesk', 'tickets', 'remover_anexo',
   'Remover anexo', 'atendente', 114),
  ('inventario.ativos.anexar', 'inventario', 'ativos', 'anexar',
   'Anexar nota ou foto', 'gestor', 422),
  ('inventario.ativos.remover_anexo', 'inventario', 'ativos', 'remover_anexo',
   'Remover anexo do ativo', 'gestor', 424),
  ('telefonia.linhas.anexar', 'telefonia', 'linhas', 'anexar',
   'Anexar contrato ou termo', 'gestor', 472),
  ('telefonia.linhas.remover_anexo', 'telefonia', 'linhas', 'remover_anexo',
   'Remover anexo da linha', 'gestor', 474)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

-- Perfis de sistema já existentes não conhecem as chaves novas. A função é
-- idempotente e expressa as concessões como REGRA sobre o catálogo, então
-- rodá-la de novo distribui as chaves novas pelos perfis certos sem duplicar as
-- antigas. Sem isto, um Admin do Cliente já provisionado ficaria sem poder
-- anexar até alguém marcar à mão — e ninguém saberia que precisava.
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
