-- =============================================================================
-- 0041 — Os dois alertas que faltavam: contrato vencendo e link fora do ar
-- =============================================================================
-- São os itens M7 e M8, e a docs/18 §5 os descreve como "a pendência mais
-- barata da lista e a mais fácil de fechar": o canal de e-mail existe desde a
-- Onda 1, a caixa de saída drena a cada ciclo, e os dois trabalhos simplesmente
-- nunca foram escritos.
--
-- O QUE OS DOIS TÊM EM COMUM COM OS OUTROS SEIS
-- ----------------------------------------------
-- A regra de QUEM avisar e QUANDO mora aqui, no SQL, pelo motivo da 0029: é
-- onde os dados estão, e é onde a asserção de schema consegue provar a regra. A
-- aplicação só esvazia a caixa.
--
-- `security definer` com execução só para `service_role` e `search_path` fixo —
-- um trabalho agendado não tem sessão de usuário por definição. Isso NÃO é uma
-- quarta exceção ao ADR-011: os trabalhos agendados são a terceira, e já estão
-- lá desde a 0030.
--
-- POR QUE GESTOR E ADMIN RECEBEM TUDO, INCLUSIVE DE OUTRAS FILIAIS
-- -----------------------------------------------------------------
-- Um link fora do ar é de uma filial, e a pergunta óbvia é se um gestor de
-- escopo restrito deveria receber o aviso de uma filial que ele não enxerga.
-- Não existe esse gestor: `app.has_tenant_wide_access()` devolve verdadeiro
-- para `gestor`, `admin` e `super_admin`. O recorte por filial governa quem é
-- OPERADOR, não quem responde pelo ambiente — e é por isso que o alvo aqui é o
-- mesmo dos alertas do agente (0032), sem invenção de regra nova.
--
-- O QUE ESTES DOIS TRABALHOS NÃO FAZEM
-- -------------------------------------
-- Não detectam nada. O contrato vence pela data que alguém cadastrou, e a queda
-- do link é registrada por quem a registrou — hoje à mão, amanhã pelo webhook do
-- Zabbix (M8/LG-07), que grava no MESMO evento. Quando ele chegar, estes
-- trabalhos não mudam: era essa a aposta registrada na docs/18, e ela se paga
-- aqui.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. As duas configurações, por tenant
-- -----------------------------------------------------------------------------
/*
 * Prazo de aviso em DIAS para contrato, e em MINUTOS para link. A diferença de
 * unidade não é descuido: um contrato se renegocia em semanas e um link fora do
 * ar se cobra da operadora em minutos. Uma unidade só obrigaria um dos dois a
 * ser escrito num número absurdo.
 */
alter table public.tenants
  add column if not exists contract_alert_days integer not null default 30,
  add column if not exists link_alert_minutes  integer not null default 10;

alter table public.tenants
  drop constraint if exists tenants_contract_alert_days_check,
  add  constraint tenants_contract_alert_days_check
       check (contract_alert_days between 1 and 365);

alter table public.tenants
  drop constraint if exists tenants_link_alert_minutes_check,
  add  constraint tenants_link_alert_minutes_check
       check (link_alert_minutes between 1 and 1440);

comment on column public.tenants.contract_alert_days is
  'Quantos dias antes do fim do contrato o primeiro aviso sai. O segundo sai a 7 dias, quando cabe.';
comment on column public.tenants.link_alert_minutes is
  'Quantos minutos de queda ABERTA antes de avisar. Abaixo disso é oscilação, e avisar oscilação ensina a ignorar o aviso.';

-- -----------------------------------------------------------------------------
-- 2. Os três novos tipos de aviso
-- -----------------------------------------------------------------------------
alter table public.email_outbox drop constraint if exists email_outbox_kind_check;
alter table public.email_outbox
  add constraint email_outbox_kind_check
  check (kind in ('sla_warning', 'sla_critical', 'sla_breach', 'satisfaction_invite',
                  'ticket_assigned', 'test', 'agent_alert',
                  'contract_expiring', 'link_down', 'link_restored'));

-- -----------------------------------------------------------------------------
-- 3. M7 — contrato vencendo
-- -----------------------------------------------------------------------------
/*
 * Três fontes, uma regra. Contrato de fornecedor e contrato de link respondem a
 * mesma pergunta ("isto acaba, e alguém precisa decidir antes"); a fidelidade do
 * link responde a inversa, e é a mais esquecida das três: **quando a fidelidade
 * cai, dá para trocar de operadora sem multa.** Um aviso que só chega depois de
 * a fidelidade renovar sozinha chega tarde por doze meses.
 *
 * DOIS DEGRAUS, E NUNCA OS DOIS NO MESMO DIA
 * -------------------------------------------
 * O primeiro no prazo configurado, o segundo a 7 dias. O degrau escolhido é o
 * MAIS APERTADO que já se aplica — e não "todos os que se aplicam". A diferença
 * aparece quando o trabalho começa a rodar com um contrato já a 5 dias do fim:
 * com a regra ingênua, os dois degraus disparam no mesmo ciclo e a pessoa
 * recebe dois e-mails sobre o mesmo contrato, no mesmo minuto. Isso não é
 * redundância útil: é o começo do hábito de ignorar o aviso.
 *
 * A DATA ENTRA NA CHAVE DE IDEMPOTÊNCIA
 * --------------------------------------
 * `contrato:<id>:<data_fim>:<degrau>`. Sem a data, um contrato renovado por mais
 * um ano ficaria **mudo para sempre**: a chave do degrau já teria sido usada no
 * ciclo anterior. Com ela, renovar é uma data nova, e a série de avisos
 * recomeça — que é exatamente o que se espera de um contrato novo.
 */
create or replace function app.job_contract_alerts()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;

revoke all on function app.job_contract_alerts() from public;
grant execute on function app.job_contract_alerts() to service_role;

comment on function app.job_contract_alerts() is
  'M7: avisa gestores sobre contrato de fornecedor, contrato de link e fidelidade prestes a terminar.';

-- -----------------------------------------------------------------------------
-- 4. M8 — link fora do ar
-- -----------------------------------------------------------------------------
/*
 * A queda já é registrada em `link_availability_events` desde a 0021, com índice
 * único de evento ABERTO por link. Este trabalho não detecta nada: ele lê o que
 * está aberto há tempo demais.
 *
 * POR QUE O LIMIAR EXISTE
 * ------------------------
 * Link oscila. Uma queda de quarenta segundos é ruído de operadora, e avisar
 * sobre ela ensina a pessoa a filtrar a pasta — e a perder a queda de três
 * horas junto. O limiar é a diferença entre um alerta e um incômodo.
 *
 * E POR QUE A VOLTA TAMBÉM É AVISADA
 * -----------------------------------
 * Quem recebeu "o link caiu" fica esperando o fim. Sem o aviso de volta, a
 * única forma de saber é abrir o sistema — e, numa queda noturna, a pessoa
 * descobre de manhã que o problema já tinha acabado às duas.
 *
 * O aviso de volta só sai para queda que FOI avisada: anunciar o retorno de uma
 * oscilação de trinta segundos que ninguém soube que houve é ruído puro, e
 * derrubaria o limiar pela janela dos fundos.
 */
create or replace function app.job_link_alerts()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;

revoke all on function app.job_link_alerts() from public;
grant execute on function app.job_link_alerts() to service_role;

comment on function app.job_link_alerts() is
  'M8: avisa quando um link está caído além do limiar do tenant, e avisa de volta quando ele retorna.';

-- -----------------------------------------------------------------------------
-- 5. A tela que faltava para TODA a configuração do ambiente
-- -----------------------------------------------------------------------------
/*
 * As duas colunas acima nasceriam mortas, e não seriam as primeiras.
 *
 * `tenants` carrega NOVE parâmetros de operação — percentuais de SLA,
 * fechamento automático, cota de anexo, aprovação de título, os quatro do
 * agente — e **nenhum deles jamais teve tela**. Mudar qualquer um exigia um
 * `update` à mão no banco, o que na prática significa que ninguém mudou: os
 * valores em produção são os padrões da migração que os criou.
 *
 * É o mesmo defeito que a 0036 corrigiu em seis tabelas, e a regra desta base é
 * explícita: configuração sem tela é configuração morta. Acrescentar duas
 * colunas sem fechar o buraco seria repetir o erro com conhecimento de causa.
 *
 * A escrita já era possível: a policy `tenants_update` existe desde a 0012 e
 * exige `app.can_manage_config()` (admin e super_admin). O que faltava era onde.
 */
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  ('ambiente', 'ambiente', null, null, 'Ambiente', 'admin', 490),
  ('ambiente.preferencias', 'ambiente', 'preferencias', null,
   'Preferências do ambiente', 'admin', 491),
  ('ambiente.preferencias.ver', 'ambiente', 'preferencias', 'ver',
   'Consultar as preferências do ambiente', 'admin', 492),
  ('ambiente.preferencias.editar', 'ambiente', 'preferencias', 'editar',
   'Alterar as preferências do ambiente', 'admin', 493)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

commit;
