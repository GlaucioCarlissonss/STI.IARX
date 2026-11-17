-- =============================================================================
-- 0058 — A caixa de saída ganha tela
-- =============================================================================
-- ## Por que agora, e não junto com a 0029
--
-- `email_outbox` existe desde a 0029, com situação, tentativas, último erro e
-- uma policy de leitura para administrador. O que nunca existiu foi a tela — e,
-- enquanto o e-mail era só aviso de SLA, dava para viver sem: quem não recebia
-- o aviso descobria o problema pelo próprio chamado.
--
-- A 0057 mudou isso. O e-mail passou a ser o caminho de volta para a conta:
-- quem perde a senha depende de uma mensagem sair. E a pergunta que o suporte
-- vai fazer toda vez que alguém disser "não recebi o link" — *o e-mail saiu?* —
-- só tinha resposta por `psql`.
--
-- A ordem aqui é deliberada: a Fase 2 vai abrir cadastro público, que depende do
-- MESMO mecanismo. Abrir uma porta para a internet estando cego no que ela usa é
-- a ordem errada; observabilidade vem antes de mais superfície.
--
-- ## O que esta tela NÃO faz
--
-- Não reenvia, não cancela, não edita. É leitura.
--
-- A drenagem já tenta de novo sozinha, com espera crescente (1, 4, 9, 16, 25
-- minutos — ver `proximaTentativa`), e um botão de "reenviar agora" ao lado de
-- uma fila que já está tentando produz mensagem duplicada no dia em que alguém
-- clicar duas vezes. Se um dia for preciso, entra depois, com a pergunta certa
-- respondida primeiro: **por que** aquela mensagem não saiu.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A permissão
-- -----------------------------------------------------------------------------
/*
 * Teto `admin`, igual ao da policy que já existia.
 *
 * A policy de `email_outbox` (0029) é `tenant_id = atual AND can_manage_config()`,
 * e `can_manage_config()` é `admin` ou `super_admin`. A chave precisa ter o
 * mesmo teto: mais baixo seria uma tela que o perfil deixa abrir e o RLS devolve
 * vazia — o pior defeito de permissão, porque parece dado que não existe.
 *
 * E o conteúdo justifica o teto: o corpo da mensagem pode conter o link de
 * redefinição de senha de outra pessoa (0057) e o token da pesquisa de
 * satisfação (0029). Quem lê esta tela consegue, por um momento, entrar na
 * conta alheia.
 */
insert into public.permission_catalog (key, module, screen, action, label, min_base_role, sort_order)
values
  ('auditoria.avisos', 'auditoria', 'avisos', null, 'Avisos enviados', 'admin', 465),
  ('auditoria.avisos.ver', 'auditoria', 'avisos', 'ver',
   'Ver a fila de e-mails e por que algum não saiu', 'admin', 466)
on conflict (key) do update
  set label         = excluded.label,
      min_base_role = excluded.min_base_role,
      sort_order    = excluded.sort_order;

-- -----------------------------------------------------------------------------
-- 1.1 A chave nova precisa CHEGAR a quem já tem banco
-- -----------------------------------------------------------------------------
/*
 * ## Um defeito do caminho de atualização, achado ao construir esta tela
 *
 * A 0017 diz, com todas as letras, por que as concessões dos perfis de sistema
 * são uma REGRA sobre o catálogo e não uma lista de chaves:
 *
 *   "listar ~108 chaves oito vezes garantiria que a próxima permissão nova
 *    entrasse em alguns perfis e fosse esquecida em outros"
 *
 * A intenção está certa. O que faltava é que a regra só era aplicada **na
 * criação do tenant**, pelo gatilho `trg_tenants_seed_access_profiles`. Para
 * uma empresa que já existe, uma chave nova entra no catálogo e **não chega a
 * perfil nenhum** — a tela fica escura para todo mundo, inclusive para o
 * administrador, e sem erro: o menu simplesmente não a mostra.
 *
 * Isso vale para TODA chave criada desde a 0041. Num banco de produção
 * atualizado por `scripts/migrar.sh` — que aplica migrações sem rodar o seed —,
 * as telas de locação (0047-0053) e o ciclo de planilha (0054) estariam
 * invisíveis. Em desenvolvimento ninguém notou porque o banco é recriado do
 * zero, e lá o seed roda DEPOIS de todas as migrações.
 *
 * A correção é reaplicar a regra, que já é idempotente (`on conflict do
 * nothing`) e já só toca perfis `is_system`. Perfil montado à mão por um
 * administrador continua intocado — injetar chave nele seria desfazer uma
 * decisão que alguém tomou de propósito.
 *
 * **Toda migração que acrescentar permissão deve terminar com este bloco.**
 */
do $$
declare v_tenant uuid;
begin
  for v_tenant in select id from public.tenants loop
    perform app.seed_system_access_profiles(v_tenant);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- 2. O índice que a tela precisa
-- -----------------------------------------------------------------------------
/*
 * A consulta da tela é "as últimas mensagens desta empresa, das mais novas para
 * as mais velhas, às vezes filtrando por situação".
 *
 * Os índices da 0029 servem à DRENAGEM, que é outra pergunta: "o que está
 * pendente e vencido, da mais velha para a mais nova". Ordenação oposta, filtro
 * diferente. Sem este, a tela varre a tabela inteira — e `email_outbox` é das
 * que mais crescem, porque ganha linha a cada aviso de SLA de cada chamado.
 */
create index if not exists idx_email_outbox_recentes
  on public.email_outbox (tenant_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 3. O resumo, para a tela não somar no navegador
-- -----------------------------------------------------------------------------
/*
 * `security_invoker = true`, como toda view deste projeto: sem isso ela rodaria
 * com os privilégios do dono (`postgres`, que tem `bypassrls`) e devolveria a
 * fila de TODAS as empresas para qualquer um que a lesse. Foi exatamente o
 * defeito que as Fases 3 e 4 da unificação deixaram passar em duas views, e que
 * a migração 0052 corrigiu.
 */
create or replace view public.vw_email_outbox_resumo
with (security_invoker = true) as
select
  o.tenant_id,
  count(*)                                              as total,
  count(*) filter (where o.status = 'pending')          as pendentes,
  count(*) filter (where o.status = 'sent')             as enviadas,
  count(*) filter (where o.status = 'failed')           as falhadas,
  count(*) filter (where o.status = 'skipped')          as puladas,
  /* A que mais importa: pendente há tempo demais é fila represada, e fila
     represada quase sempre quer dizer que não há provedor configurado. */
  count(*) filter (
    where o.status = 'pending' and o.scheduled_for < now() - interval '1 hour'
  )                                                      as paradas,
  max(o.created_at)                                      as ultima_entrada,
  max(o.sent_at)                                         as ultimo_envio
from public.email_outbox o
group by o.tenant_id;

comment on view public.vw_email_outbox_resumo is
  'Contagem por situação da caixa de saída, por empresa. Responde "está saindo?" sem trazer a fila inteira.';

grant select on public.vw_email_outbox_resumo to authenticated;
