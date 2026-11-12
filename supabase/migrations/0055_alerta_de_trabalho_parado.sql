-- =============================================================================
-- 0055 — Alerta de trabalho parado (Fase 8 — docs/23 §4.6)
-- =============================================================================
-- `job_runs` grava desde a 0029 e `vw_job_health` mostra desde a 0036. As duas
-- respondem "parou?" para quem ABRE A TELA — e ninguém abre uma tela às três da
-- manhã. Um trabalho parado só era percebido quando alguém reclamava do que ele
-- deixou de fazer: o SLA que não mediu, o e-mail que não saiu.
--
-- ## "Parou" e "falhou" são defeitos diferentes
--
-- **Falhou** é uma execução que terminou mal. **Parou** é a AUSÊNCIA de
-- execução: não há linha nenhuma, nada muda, nada dispara. É a falha mais
-- perigosa justamente por ser silenciosa, e a única forma de detectá-la é
-- comparar a última execução com a cadência ESPERADA de cada trabalho. Esperada
-- por quem? Por nós: é a tabela da seção 1.
--
-- ## Por que a cadência é dado, e não constante no código
--
-- Porque ela muda com a instalação. Uma operação que roda o agendador de cinco
-- em cinco minutos e outra que roda de hora em hora não têm o mesmo limite de
-- paciência, e codificar um número faria a segunda receber alarme falso todo
-- dia — até alguém desligar o alerta inteiro.
--
-- ## O QUE ESTE ALERTA NÃO COBRE, dito aqui para não ser descoberto tarde
--
-- Ele roda DENTRO de `POST /api/jobs/run`. Se o agendador morrer por inteiro,
-- esta rota não é chamada e nenhum alerta sai — o problema clássico do vigia que
-- dorme junto com o vigiado. Ele cobre "um trabalho parou enquanto os outros
-- rodam", que é o caso comum e o mais difícil de notar.
--
-- "O agendador inteiro morreu" exige um vigia de FORA, e por isso o runbook
-- (docs/24) manda apontar o monitor de disponibilidade para `/api/health`: um
-- segundo par de olhos que não depende do primeiro estar vivo.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. O que se espera de cada trabalho
-- -----------------------------------------------------------------------------
create table public.job_expectations (
  job            text primary key,
  rotulo         text not null,
  /* Quantos minutos de silêncio ainda são normais. Passou disso, parou. */
  tolerancia_min integer not null check (tolerancia_min > 0),
  ativo          boolean not null default true,
  observacao     text,
  updated_at     timestamptz not null default now()
);

comment on table public.job_expectations is
  'A cadência esperada de cada trabalho agendado. É o que permite detectar AUSÊNCIA de execução.';

comment on column public.job_expectations.job is
  'O nome como aparece em job_runs.job — SEM o prefixo job_, que é só do nome da função RPC.';

/*
 * ATENÇÃO AO NOME: as funções chamam-se `app.job_sla_alerts`, mas gravam em
 * `job_runs` como `sla_alerts`. O prefixo `job_` pertence ao nome da função, não
 * ao registro. Semear com o prefixo faria TODA linha aqui cair no `left join`
 * vazio e ser lida como "nunca rodou" — para sempre, em silêncio, pelo próprio
 * mecanismo que existe para acabar com silêncio.
 *
 * E quanto às tolerâncias: são generosas de propósito. O custo de um alarme
 * falso não é o incômodo — é o alerta virar ruído e ser ignorado quando for
 * verdade. Com o agendador a cada 5 minutos, 30 minutos de silêncio são seis
 * ciclos perdidos: já é problema, e ainda não é susto.
 */
insert into public.job_expectations (job, rotulo, tolerancia_min, observacao) values
  ('auto_close',           'Fechamento automático',    30,   'Fecha chamado resolvido há tempo demais.'),
  ('sla_alerts',           'Alertas de SLA',           30,   'O mais sensível: atraso aqui vira SLA estourado sem aviso.'),
  ('satisfaction_invites', 'Convites de avaliação',    180,  'Atraso aqui adia a pesquisa, não quebra nada.'),
  ('aggregate_metrics',    'Agregação de métricas',    120,  'Parado, o gráfico do agente para de ganhar pontos.'),
  ('agent_alerts',         'Alertas do agente',        60,   'Disco cheio avisa por aqui.'),
  ('contract_alerts',      'Alertas de contrato',      1440, 'Roda uma vez por dia.'),
  ('link_alerts',          'Alertas de link',          60,   null)
on conflict (job) do nothing;

/*
 * A drenagem da caixa de saída NÃO está nesta lista, e vale dizer por quê: ela
 * roda na rota, não como função de banco, e não grava em `job_runs`. Cheguei a
 * fazê-la gravar — e então percebi que o registro não detectaria nada: se a rota
 * roda, os oito acima também registram; se a rota não roda, os oito ficam
 * velhos. Uma nona linha custaria 288 inserções por dia para responder uma
 * pergunta já respondida. Fila represada se vê em `email_outbox.attempts` e
 * `last_error`, que é onde ela de fato aparece.
 */

-- -----------------------------------------------------------------------------
-- 2. O episódio
-- -----------------------------------------------------------------------------
/*
 * UM AVISO POR EPISÓDIO, não por execução.
 *
 * Um trabalho que falha de cinco em cinco minutos mandaria 288 e-mails por dia.
 * No segundo dia ninguém lê nenhum — e aí o alerta deixou de existir, com a
 * agravante de todo mundo achar que ele existe.
 *
 * O episódio abre quando o trabalho começa a falhar (ou a sumir) e fecha quando
 * ele volta. São dois avisos, no máximo: a quebra e a volta.
 */
create table public.job_alert_episodes (
  id            bigserial primary key,
  job           text not null references public.job_expectations(job) on delete cascade,
  tipo          text not null check (tipo in ('falhou', 'parou')),

  aberto_em     timestamptz not null default now(),
  fechado_em    timestamptz,

  detalhe       text,

  /* Nulo = ainda não avisado. É o que a rotina de envio procura. */
  avisado_em    timestamptz,
  canais        text[] not null default '{}',
  erro_do_aviso text,

  /*
   * A volta só é anunciada para quem recebeu a quebra. Avisar "voltou ao normal"
   * de um problema que nunca foi anunciado é confundir quem lê, e o `avisado_em`
   * nulo é exatamente o caso em que isso aconteceria (episódio que abriu e
   * fechou entre duas execuções, sem ninguém nunca saber).
   */
  volta_avisada_em timestamptz,

  constraint job_alert_episodes_volta_depois_da_quebra
    check (volta_avisada_em is null or (avisado_em is not null and fechado_em is not null))
);

/* Um episódio ABERTO por trabalho, no máximo. Sem este índice, duas execuções
   simultâneas abririam dois episódios do mesmo problema e avisariam duas
   vezes — que é exatamente o que o episódio existe para impedir. */
create unique index job_alert_episodes_um_aberto
  on public.job_alert_episodes (job) where fechado_em is null;

create index job_alert_episodes_a_avisar
  on public.job_alert_episodes (aberto_em) where avisado_em is null and fechado_em is null;

create index job_alert_episodes_volta_a_avisar
  on public.job_alert_episodes (fechado_em)
  where volta_avisada_em is null and fechado_em is not null and avisado_em is not null;

comment on table public.job_alert_episodes is
  'Um episódio de trabalho parado ou falho. Existe para avisar UMA vez, e não a cada execução.';

-- -----------------------------------------------------------------------------
-- 3. Um desempate que faltava em `vw_job_health`
-- -----------------------------------------------------------------------------
/*
 * A 0036 escreveu `(array_agg(r.ok order by r.started_at desc))[1]` para dizer
 * "o `ok` da última execução". Quando duas linhas do mesmo trabalho empatam no
 * `started_at`, a ordenação não tem desempate e o Postgres escolhe uma — e, no
 * teste que fiz ao escrever esta migração, escolheu a MAIS ANTIGA: `ultimo_ok`
 * veio `true` com a linha mais nova dizendo `false`.
 *
 * Era inofensivo enquanto a view só pintava uma tela para alguém interpretar.
 * Deixa de ser agora: `vw_job_alerts` decide abrir ou não um episódio a partir
 * exatamente desse valor, e um empate mal desempatado é um alerta que não toca.
 *
 * `id` é `bigserial`, então ele sempre reflete a ordem real de inserção. A lista
 * de colunas não muda — por isso o `create or replace` passa mesmo com a
 * `vw_job_alerts` abaixo dependendo dela.
 */
create or replace view public.vw_job_health
with (security_invoker = true) as
select
  r.job,
  count(*)                                                     as execucoes,
  max(r.started_at)                                            as ultima_execucao,
  (array_agg(r.ok       order by r.started_at desc, r.id desc))[1] as ultimo_ok,
  (array_agg(r.detail   order by r.started_at desc, r.id desc))[1] as ultimo_detalhe,
  (array_agg(r.affected order by r.started_at desc, r.id desc))[1] as ultimo_afetados,
  count(*) filter (where r.ok is false)                        as falhas,
  extract(epoch from (now() - max(r.started_at))) / 60          as minutos_desde
from public.job_runs r
group by r.job;

comment on view public.vw_job_health is
  'Um resumo por trabalho agendado: quando rodou pela última vez, se deu certo e há quantos minutos. Responde "parou?" sem psql.';

-- -----------------------------------------------------------------------------
-- 4. A visão que decide
-- -----------------------------------------------------------------------------
create or replace view public.vw_job_alerts
with (security_invoker = true) as
select
  e.job,
  e.rotulo,
  e.tolerancia_min,
  h.ultima_execucao,
  h.ultimo_ok,
  h.ultimo_detalhe,
  h.minutos_desde,
  case
    /* Nunca rodou NÃO é "parou": numa instalação nova o agendador ainda não foi
       ligado, e gritar no primeiro minuto ensina a ignorar o alerta. Fica com
       nome próprio, e a rotina de aviso não o trata como incidente. */
    when h.ultima_execucao is null then 'nunca_rodou'
    when h.ultimo_ok is false then 'falhou'
    when h.minutos_desde > e.tolerancia_min then 'parou'
    else 'ok'
  end as situacao
from public.job_expectations e
left join public.vw_job_health h on h.job = e.job
where e.ativo;

comment on view public.vw_job_alerts is
  'Cada trabalho e sua situação: ok, falhou, parou ou nunca rodou. É o que a rotina de alerta lê.';

/*
 * Abre e fecha episódios conforme a situação de agora.
 *
 * `security definer` porque quem a chama é a rota de trabalhos agendados, que
 * não tem sessão de usuário — mesma razão de todas as outras funções de job.
 */
create or replace function app.sincronizar_episodios_de_alerta()
returns integer
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
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
$$;

comment on function app.sincronizar_episodios_de_alerta() is
  'Abre episódio para trabalho falho ou parado e fecha o que voltou. Devolve quantos mudaram.';

-- -----------------------------------------------------------------------------
-- 5. RLS e privilégios
-- -----------------------------------------------------------------------------
/*
 * Estas duas tabelas NÃO têm `tenant_id`, e isso é deliberado.
 *
 * Trabalho agendado é da instalação, não de um cliente: o SLA que parou de ser
 * medido parou para todo mundo. Pendurar um tenant nelas obrigaria a escolher um
 * arbitrariamente — e esse tenant passaria a "possuir" um problema de
 * infraestrutura que não é dele. É a mesma decisão já tomada em `job_runs`
 * (0029), e é por isso que o aviso deste alerta NÃO sai pela `email_outbox`, que
 * exige tenant: ele sai direto, pelo provedor, com destinatário de ambiente.
 *
 * Sem tenant não há isolamento por tenant a aplicar: a leitura é liberada a quem
 * tem a chave de trabalhos agendados (teto `admin`, ver 0036), e a escrita é só
 * da rotina `security definer` acima e da rota de trabalhos agendados.
 */
alter table public.job_expectations enable row level security;
alter table public.job_expectations force row level security;
alter table public.job_alert_episodes enable row level security;
alter table public.job_alert_episodes force row level security;

create policy job_expectations_select on public.job_expectations
  for select to authenticated
  using (app.has_permission('auditoria.trabalhos.ver'));

create policy job_alert_episodes_select on public.job_alert_episodes
  for select to authenticated
  using (app.has_permission('auditoria.trabalhos.ver'));

grant select on public.job_expectations to authenticated;
grant select on public.job_alert_episodes to authenticated;
grant select on public.vw_job_alerts to authenticated;

/*
 * E o `service_role`, explicitamente — que é quem escreve.
 *
 * Isto não estava aqui na primeira versão desta migração, e o alerta não funcionou:
 * a rota de trabalhos agendados roda como `service_role` e levou
 * "permission denied for table job_expectations" nas três consultas.
 *
 * O engano é fácil de cometer porque `service_role` tem BYPASSRLS — o que faz
 * pensar que ele passa por cima de tudo. BYPASSRLS ignora POLICY; não ignora
 * GRANT de tabela. São duas permissões diferentes com nomes parecidos.
 *
 * As outras tabelas do projeto funcionam sem esta linha por acidente de ordem:
 * o `grant all on all tables` do `scripts/preparar-banco-local.sh` rodou DEPOIS
 * de elas existirem e ANTES de esta existir. Conceder aqui é o que torna a
 * migração correta sozinha, em qualquer ambiente e em qualquer ordem — e é por
 * isso que ela não deve depender daquele script.
 */
grant select, insert, update on public.job_expectations to service_role;
grant select, insert, update on public.job_alert_episodes to service_role;
grant usage on sequence public.job_alert_episodes_id_seq to service_role;
grant select on public.vw_job_alerts to service_role;
grant execute on function app.sincronizar_episodios_de_alerta() to service_role;
