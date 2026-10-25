-- =============================================================================
-- 0036 — As lacunas de interface: o que o banco fazia e ninguém via
-- =============================================================================
-- Esta migração quase não cria estrutura. Ela existe porque uma revisão do
-- repositório inteiro encontrou **tabelas com dados, RLS, auditoria e nenhuma
-- tela** — recursos que existem no banco desde 2024 e que, do ponto de vista de
-- quem usa o sistema, nunca existiram.
--
-- COMO ELAS FORAM ENCONTRADAS
-- ---------------------------
-- Cruzando a lista de tabelas de `public` com as tabelas citadas em `src/`. O
-- que não aparece nos dois lados ou é interno (escrito por trigger, lido por
-- view) ou é uma promessa não cumprida. Cinco eram do segundo tipo:
--
--   `queue_members`        — quem é de cada fila. O roadmap já marcava como ⬜.
--   `ticket_assets`        — qual equipamento é este chamado. O README AFIRMA
--                            "vínculo com tickets" no inventário desde a
--                            primeira versão; a tela nunca existiu.
--   `ticket_telecom_lines` — idem, para linha telefônica.
--   `business_hours*`      — o expediente que o SLA usa para contar. Dava para
--                            ESCOLHER um horário no formulário de contrato e não
--                            dava para CRIAR nenhum, nem cadastrar feriado.
--   `audit_log`            — 45 tabelas auditadas, nenhum lugar para ler.
--   `job_runs`             — a docs/13 manda rodar SQL à mão para saber se o
--                            agendador parou. Quem precisa da resposta não tem
--                            psql.
--
-- O QUE FALTAVA ERA PERMISSÃO, NÃO ESTRUTURA
-- ------------------------------------------
-- Todas as seis tabelas já têm policy e GRANT corretos. O que não existia era a
-- chave de permissão que uma tela precisa para se proteger — e é só isso que
-- esta migração acrescenta, mais a conferência de que o catálogo e os perfis de
-- sistema continuam coerentes.
--
-- A EXCEÇÃO: `sla_pauses` NÃO ganhou tela de escrita, e é deliberado
-- -------------------------------------------------------------------
-- A pausa do relógio de SLA é AUTOMÁTICA desde a 0006: a trigger abre a pausa
-- quando o chamado entra em estado de espera e a fecha quando sai, creditando só
-- os minutos que caíram dentro do expediente. Dar um botão de "pausar" criaria
-- um segundo caminho para a mesma coisa, e os dois brigariam pelo índice único
-- de pausa aberta.
--
-- O que faltava ali era LEITURA: o chamado mostrava o distintivo "relógio
-- pausado" e não dizia desde quando nem por quê. Isso é tela, não migração.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Catálogo de permissões
-- -----------------------------------------------------------------------------
insert into public.permission_catalog
  (key, module, screen, action, label, min_base_role, sort_order)
values
  /* Vincular ativo e linha ao chamado é ato de quem ATENDE: é durante o
     atendimento que se descobre de qual máquina o problema é. Chave própria, e
     não `editar`, porque vincular não muda o chamado — acrescenta contexto. */
  ('helpdesk.tickets.vincular', 'helpdesk', 'tickets', 'vincular',
   'Vincular ativo ou linha ao chamado', 'atendente', 128),

  /* O expediente entra em `sla` porque é lá que ele é usado: contrato e
     definição apontam para um horário, e a conta de prazo depende dele. */
  ('sla.horarios', 'sla', 'horarios', null, 'Expediente e feriados', 'gestor', 230),
  ('sla.horarios.ver', 'sla', 'horarios', 'ver',
   'Consultar expedientes', 'gestor', 231),
  ('sla.horarios.criar', 'sla', 'horarios', 'criar',
   'Criar expediente', 'gestor', 232),
  ('sla.horarios.editar', 'sla', 'horarios', 'editar',
   'Editar expediente, faixas e feriados', 'gestor', 233),

  /* Módulo próprio, e não uma tela dentro de `usuarios`: a trilha não é sobre
     pessoas, é sobre o que mudou em qualquer lugar do sistema. */
  ('auditoria', 'auditoria', null, null, 'Auditoria', 'gestor', 460),
  ('auditoria.trilha', 'auditoria', 'trilha', null, 'Trilha de alterações', 'gestor', 461),
  ('auditoria.trilha.ver', 'auditoria', 'trilha', 'ver',
   'Ler a trilha de alterações', 'gestor', 462),
  ('auditoria.trabalhos', 'auditoria', 'trabalhos', null, 'Trabalhos agendados', 'admin', 463),
  ('auditoria.trabalhos.ver', 'auditoria', 'trabalhos', 'ver',
   'Acompanhar os trabalhos agendados', 'admin', 464)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

comment on table public.audit_log is
  'A trilha. Lida em /auditoria desde a 0036 — antes dela, 45 tabelas eram auditadas e ninguém tinha como ler o resultado.';

-- -----------------------------------------------------------------------------
-- 2. A trilha precisa de uma leitura que não varra a tabela inteira
-- -----------------------------------------------------------------------------
/*
 * `audit_log` cresce para sempre e sem teto: toda alteração de 45 tabelas cai
 * nela. A tela filtra por entidade, por autor e por período, e sem índice isso
 * vira varredura completa — num ambiente com um ano de uso, a primeira abertura
 * da tela derruba o banco.
 *
 * O índice é por `(tenant_id, created_at desc)` porque TODA consulta da tela tem
 * os dois: o tenant vem do RLS e a ordem é sempre a mais recente primeiro.
 */
create index if not exists idx_audit_recente
  on public.audit_log (tenant_id, created_at desc);

/* E um por entidade, para a pergunta "o que aconteceu com ESTE registro" — que é
   a consulta que alguém faz quando um dado some e ninguém assume. */
create index if not exists idx_audit_entidade
  on public.audit_log (tenant_id, entity_type, entity_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 3. O resumo dos trabalhos agendados
-- -----------------------------------------------------------------------------
/*
 * A docs/13 mandava rodar isto à mão, em psql, para saber se o agendador parou.
 * Quem precisa da resposta — quem administra o ambiente — não tem psql, e
 * trabalho parado é invisível por natureza: não há erro, não há alerta,
 * simplesmente nada acontece. O primeiro a perceber seria o cliente que não
 * recebeu o aviso.
 *
 * A view NÃO é `security_invoker`... na verdade é, como todas as outras: a
 * policy de `job_runs` restringe a leitura ao operador da plataforma, e é ela
 * que deve continuar valendo. A view só poupa a conta.
 */
create or replace view public.vw_job_health
with (security_invoker = true) as
select
  r.job,
  count(*)                                   as execucoes,
  max(r.started_at)                           as ultima_execucao,
  (array_agg(r.ok order by r.started_at desc))[1]       as ultimo_ok,
  (array_agg(r.detail order by r.started_at desc))[1]   as ultimo_detalhe,
  (array_agg(r.affected order by r.started_at desc))[1] as ultimo_afetados,
  count(*) filter (where r.ok is false)       as falhas,
  /* Minutos desde a última execução. É o número que responde "parou?" — e ele
     precisa ser calculado aqui porque a tela não sabe a cadência esperada de
     cada trabalho. */
  extract(epoch from (now() - max(r.started_at))) / 60 as minutos_desde
from public.job_runs r
group by r.job;

grant select on public.vw_job_health to authenticated;

comment on view public.vw_job_health is
  'Um resumo por trabalho agendado: quando rodou pela última vez, se deu certo e há quantos minutos. Responde "parou?" sem psql.';

-- -----------------------------------------------------------------------------
-- 4. Perfis de sistema
-- -----------------------------------------------------------------------------
/*
 * `auditoria` entra em `gestor_ti` e, por leitura, em `diretoria` e
 * `visualizador` — os dois já recebem toda chave `ver` que o papel alcança, e
 * `auditoria.trilha.ver` tem teto `gestor`, então a diretoria a recebe e o
 * visualizador não. É o resultado certo: quem responde pela operação precisa
 * poder responder "quem mudou isso".
 *
 * `auditoria.trabalhos.ver` tem teto `admin` e fica só com o Admin do Cliente —
 * e, mesmo para ele, a policy de `job_runs` só devolve linha ao operador da
 * plataforma. A tela diz isso em vez de parecer vazia por defeito.
 */
create or replace function app.seed_system_access_profiles(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
     'Operação de TI completa: helpdesk, inventário, telefonia, conectividade, mapas, SLA e cadastros.',
     'gestor', true, 'gestor_ti'),
    (p_tenant_id, 'Operador de TI',
     'Atende ticket e consulta inventário, telefonia e links; não cadastra.',
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
    'Operação de TI completa: helpdesk, inventário, telefonia, conectividade, mapas, SLA e cadastros.'
   where tenant_id = p_tenant_id and system_key = 'gestor_ti';
  update public.access_profiles set description =
    'Atende ticket e consulta inventário, telefonia e links; não cadastra.'
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
        when 'gestor_ti' then c.module in
          ('helpdesk','inventario','telefonia','conectividade','mapas','sla',
           'clientes','fornecedores','tv','autoatendimento','canais','ia','auditoria')

        -- O operador lê e RESPONDE conversa — é o trabalho dele. Mas não liga nem
        -- desliga canal: isso guarda credencial.
        when 'operador_ti' then
          c.module in ('helpdesk','autoatendimento','ia')
          or (c.module = 'canais' and c.screen is distinct from 'canais')
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
$$;

comment on function app.seed_system_access_profiles(uuid) is
  'Cria (idempotente) os perfis de sistema e suas concessões para um tenant.';

do $$
declare
  v_tenant record;
begin
  for v_tenant in select id from public.tenants loop
    perform app.seed_system_access_profiles(v_tenant.id);
  end loop;
end
$$;

commit;
