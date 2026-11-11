-- =============================================================================
-- 0054 — O ciclo de planilha (Fase 7 da unificação — docs/23)
-- =============================================================================
-- É a última peça do GSTI: lá ela é o grupo *Sistema*, e aqui ela fecha o
-- caminho de ida e volta do dado. A exportação já existia; o que não existia
-- era a **volta**.
--
-- ## As cinco regras que este schema sustenta
--
--  1. **Nada é gravado antes da conferência.** O lote nasce em `preview` e só
--     escreve no negócio quando alguém manda aplicar. Um importador que grava
--     primeiro e relata depois é como se duplicam 400 clientes.
--  2. **A planilha não escolhe tenant nem permissão.** Toda escrita passa pela
--     mesma guarda e pelo mesmo RLS das telas. O importador não é porta dos
--     fundos: ele é um jeito mais rápido de fazer o que a pessoa já podia.
--  3. **Erro é por LINHA.** `import_rows` guarda a linha crua e o motivo da
--     recusa. "Falhou" num arquivo de 300 linhas não diz nada a ninguém.
--  4. **Chave natural decide** criar, atualizar ou pular — reenviar o mesmo
--     arquivo não duplica.
--  5. **A planilha enviada NÃO é guardada.** Ela é lida em memória e
--     descartada; o que fica é o resultado. Guardá-la criaria um arquivo com
--     dado de cliente dentro do bucket, sem dono e sem prazo de validade.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. O lote
-- -----------------------------------------------------------------------------
create table public.import_batches (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  /* O recurso é uma chave de catálogo do código (`src/lib/planilha/recursos.ts`),
     nunca um nome de tabela vindo da tela — a mesma disciplina da rota de
     exportação, pelo mesmo motivo: o nome da tabela não atravessa a fronteira. */
  resource    text not null,
  file_name   text not null,
  file_bytes  integer not null check (file_bytes >= 0),

  status      text not null default 'preview'
                check (status in ('preview', 'applied', 'discarded')),

  /* Como tratar a linha cuja chave já existe. A escolha é de quem importa, e
     fica gravada: seis meses depois, "por que estes 29 clientes mudaram de
     nome?" se responde aqui. */
  on_conflict text not null default 'update'
                check (on_conflict in ('update', 'skip')),

  /* O de-para das colunas, como a pessoa confirmou. Guardado para ser sugerido
     na próxima importação do mesmo recurso — refazer o casamento a cada mês é
     o que faz alguém desistir do importador e voltar a digitar. */
  column_map  jsonb not null default '{}'::jsonb,

  total_rows    integer not null default 0 check (total_rows >= 0),
  created_rows  integer not null default 0 check (created_rows >= 0),
  updated_rows  integer not null default 0 check (updated_rows >= 0),
  skipped_rows  integer not null default 0 check (skipped_rows >= 0),
  rejected_rows integer not null default 0 check (rejected_rows >= 0),

  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  applied_at  timestamptz,
  updated_at  timestamptz not null default now()
);

create index import_batches_tenant_idx
  on public.import_batches (tenant_id, created_at desc);

comment on table public.import_batches is
  'Um envio de planilha. Nasce como prévia e só escreve no negócio quando aplicado.';

-- -----------------------------------------------------------------------------
-- 2. A linha
-- -----------------------------------------------------------------------------
create table public.import_rows (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  batch_id    uuid not null references public.import_batches(id) on delete cascade,

  /* O número da linha NO ARQUIVO, contando o cabeçalho — é o que a pessoa vê
     quando abre a planilha para corrigir. Renumerar a partir de 1 ignorando o
     cabeçalho faria ela procurar a linha errada. */
  line_number integer not null check (line_number >= 1),

  /* A linha crua, como veio. É isto que permite baixar só as recusadas com o
     conteúdo original e o motivo ao lado — e o que responde, uma semana
     depois, por que aqueles quatro ativos não entraram. */
  raw         jsonb not null,

  outcome     text not null
                check (outcome in ('create', 'update', 'skip', 'reject')),
  /* Preenchido só na recusa, e em português: esta frase vai inteira para a
     tela e para o arquivo de correção. */
  reason      text,
  /* O registro que a linha criou ou atualizou, quando o lote foi aplicado. */
  record_id   uuid,

  created_at  timestamptz not null default now(),

  constraint import_rows_recusa_tem_motivo check (
    (outcome = 'reject' and reason is not null) or
    (outcome <> 'reject' and reason is null)
  )
);

create index import_rows_batch_idx on public.import_rows (batch_id, line_number);
create index import_rows_recusadas_idx
  on public.import_rows (batch_id) where outcome = 'reject';

comment on table public.import_rows is
  'Uma linha da planilha e o que aconteceu com ela. A recusa guarda a linha crua E o motivo.';

/*
 * Os contadores do lote saem das LINHAS, e não de quem escreveu.
 *
 * Mantê-los à mão em dois lugares é como o relatório passa a dizer "305
 * entraram" enquanto a lista mostra 304 — e aí nenhum dos dois números serve
 * para nada.
 */
create or replace function app.recontar_lote_de_importacao()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
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
$$;

create trigger trg_import_rows_reconta
  after insert or update or delete on public.import_rows
  for each row execute function app.recontar_lote_de_importacao();

/*
 * Lote aplicado não volta a ser prévia.
 *
 * Reabrir um lote já aplicado permitiria aplicá-lo de novo, e a segunda
 * aplicação criaria tudo outra vez para quem tivesse escolhido `skip`. Aplicar
 * é um ato só; corrigir é um lote novo.
 */
create or replace function app.lote_aplicado_nao_reabre()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'applied' and new.status <> 'applied' then
    raise exception 'lote já aplicado não volta a ser prévia'
      using errcode = '23514',
            hint = 'Para corrigir, envie um lote novo com as linhas corrigidas.';
  end if;
  return new;
end;
$$;

create trigger trg_import_batches_nao_reabre
  before update on public.import_batches
  for each row execute function app.lote_aplicado_nao_reabre();

-- -----------------------------------------------------------------------------
-- 3. RLS e privilégios
-- -----------------------------------------------------------------------------
select app.harden_table('public.import_batches');
select app.harden_table('public.import_rows');
select app.attach_audit('public.import_batches');

create policy import_batches_select on public.import_batches
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('sistema.planilhas.ver'));
create policy import_batches_write on public.import_batches
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('sistema.planilhas.importar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('sistema.planilhas.importar'));

create policy import_rows_select on public.import_rows
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('sistema.planilhas.ver'));
create policy import_rows_write on public.import_rows
  for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('sistema.planilhas.importar'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('sistema.planilhas.importar'));

grant select, insert, update, delete on public.import_batches to authenticated;
grant select, insert, update, delete on public.import_rows to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Catálogo de permissões
-- -----------------------------------------------------------------------------
/*
 * `importar` é `admin`, e não `gestor`.
 *
 * Uma importação escreve centenas de registros de uma vez em qualquer cadastro
 * que o catálogo ofereça. Mesmo passando pelas mesmas regras linha a linha, a
 * ESCALA é outra: um engano digitado atinge um registro, e um engano importado
 * atinge a planilha inteira. Quem pode isso é quem já administra o ambiente.
 *
 * `exportar` fica em `visualizador` porque o arquivo sai com exatamente as
 * linhas que a pessoa já enxerga na tela — nem uma a mais. Exigir papel maior
 * para baixar o que ela acabou de ler seria teatro.
 */
/*
 * `locacao.medicoes.lancar` nasce aqui, e não na 0050, por um motivo honesto:
 * até agora a leitura só entrava pelo gatilho da entrega, e não havia escrita
 * de medição para governar. A importação é a primeira — e usar
 * `medicoes.ver` para autorizá-la seria deixar uma chave de LEITURA abrir uma
 * escrita, que é como uma permissão deixa de querer dizer o que diz.
 */
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('locacao.medicoes.lancar',      'locacao', 'medicoes',  'lancar',   'Lançar leitura de medidor',      'atendente',    532),
  ('sistema',                      'sistema', null,        null,       'Sistema',                        'visualizador', 600),
  ('sistema.planilhas',            'sistema', 'planilhas', null,       'Planilhas',                      'visualizador', 601),
  ('sistema.planilhas.ver',        'sistema', 'planilhas', 'ver',      'Consultar importações',          'visualizador', 602),
  ('sistema.planilhas.exportar',   'sistema', 'planilhas', 'exportar', 'Exportar dados em planilha',     'visualizador', 603),
  ('sistema.planilhas.importar',   'sistema', 'planilhas', 'importar', 'Importar planilha',              'admin',        604)
on conflict (key) do nothing;
