-- =============================================================================
-- 0059 — Limite de requisições por origem
-- =============================================================================
-- ## O que a 0057 deixou em aberto
--
-- A emissão de token tem espera de 60 segundos **por conta**: pedir "esqueci a
-- senha" três vezes seguidas para o mesmo e-mail só emite um link. Isso protege
-- a caixa de UMA pessoa.
--
-- Não protege de quem varre uma lista. Com dez mil e-mails vazados e um laço de
-- shell, cada endereço que tiver conta aqui recebe um e-mail legítimo, assinado
-- pelo nosso domínio, sem ter pedido nada. Nenhuma conta passou do limite dela;
-- o estrago é o domínio denunciado como remetente de spam — e aí para TODO o
-- e-mail do sistema, inclusive o aviso de SLA.
--
-- O freio que falta é por ORIGEM, e ele precisa existir antes da Fase 2, que
-- abre cadastro público. Mas não é só preparação: `/recuperar-senha` já está no
-- ar e já é público.
--
-- ## O IP não é guardado
--
-- A chave é um hash com segredo, calculado na aplicação — o banco nunca vê o
-- endereço. IP é dado pessoal, e guardá-lo para contar requisição seria manter
-- um registro de quem visitou o sistema e quando, em troca de nada: para contar,
-- basta saber que duas requisições vieram da mesma origem, e igualdade de hash
-- responde isso.
--
-- O segredo é o que torna o hash irreversível de verdade. Sem ele, um SHA-256 de
-- IPv4 se quebra por força bruta em minutos — são só quatro bilhões de
-- possibilidades.
--
-- ## Janela fixa, e não deslizante
--
-- Janela deslizante é mais justa e exige guardar cada requisição. A fixa guarda
-- um contador por origem e erra só na fronteira: quem souber o segundo exato da
-- virada consegue o dobro do limite num instante. Para o que isto defende —
-- disparo em massa, que precisa de milhares — o dobro de cinco não muda nada, e
-- a diferença de custo entre uma linha por origem e uma linha por requisição,
-- sim.
-- =============================================================================

create table public.request_throttle (
  /* O que está sendo limitado: 'password_reset', 'signup', 'login'... */
  balde         text not null,
  /* Hash com segredo da origem. NUNCA o IP. */
  origem        text not null,

  janela_inicio timestamptz not null default now(),
  contagem      integer not null default 0,

  primary key (balde, origem)
);

comment on table public.request_throttle is
  'Contador por origem e por balde, para limitar requisição em tela pública. A origem é hash com segredo — o IP não é guardado.';

create index request_throttle_janela on public.request_throttle (janela_inicio);

/*
 * Conta e decide, em UMA instrução.
 *
 * `insert ... on conflict do update` com a decisão no próprio `returning`: ler
 * o contador, decidir e gravar em passos separados abriria a janela em que
 * várias requisições simultâneas leem o mesmo valor e passam todas — que é
 * exatamente o cenário que um disparo em massa produz.
 *
 * Devolve `true` quando a requisição PODE seguir.
 */
create or replace function app.permitir_requisicao(
  p_balde     text,
  p_origem    text,
  p_limite    integer,
  p_janela_seg integer
)
returns boolean
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
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
$$;

comment on function app.permitir_requisicao(text, text, integer, integer) is
  'Conta a requisição e diz se ela pode seguir. Uma instrução só, para que simultâneas não passem todas.';

/*
 * A limpeza. Contador de janela vencida não serve para nada, e é a única coisa
 * que esta tabela acumula.
 */
create or replace function app.job_purge_throttle()
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
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
$$;

insert into public.job_expectations (job, rotulo, tolerancia_min, observacao)
values ('purge_throttle', 'Purga de contadores de limite', 2880,
        'Diária; o contador vencido não serve para nada.')
on conflict (job) do nothing;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
/*
 * Ninguém lê pela aplicação — a recusa é escrita, pelo mesmo motivo da 0057:
 * "decidi que ninguém lê" e "esqueci a policy" ficam idênticos no catálogo.
 *
 * E aqui a tabela não tem `tenant_id` de propósito: a origem de uma requisição
 * a uma tela PÚBLICA é anterior a qualquer empresa. Quem pede o link de senha
 * ainda não disse de quem é.
 */
alter table public.request_throttle enable row level security;
alter table public.request_throttle force row level security;

create policy request_throttle_ninguem_le on public.request_throttle
  for select to authenticated
  using (false);

grant execute on function app.permitir_requisicao(text, text, integer, integer) to service_role;
grant execute on function app.job_purge_throttle() to service_role;
grant select, insert, update, delete on public.request_throttle to service_role;
