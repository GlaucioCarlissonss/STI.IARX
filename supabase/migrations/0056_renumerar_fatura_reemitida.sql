-- =============================================================================
-- 0056 — Refaturar uma competência cancelada
-- =============================================================================
-- ## A contradição que estava escrita na 0050
--
-- Dois índices únicos sobre `rental_invoices`, e eles discordavam:
--
--   rental_invoices_competencia_uk  ... where deleted_at is null
--                                       and status <> 'cancelled'
--   rental_invoices_number_uk       ... where deleted_at is null
--
-- O primeiro diz, de propósito, que **cancelar libera a competência**: é para
-- isso que existe o `status <> 'cancelled'`. O segundo não abre essa exceção —
-- e, como o número é derivado de contrato e competência
-- (`CTR-2026-018/202610`), a fatura cancelada continuava segurando exatamente
-- o número que a refeita precisaria ter.
--
-- Resultado na tela: a pessoa cancela uma fatura errada, tenta refazer o mês e
-- recebe `duplicate key value violates unique constraint
-- "rental_invoices_number_uk"`. Uma operação que o modelo de dados autoriza,
-- recusada com o nome de um índice.
--
-- Quem encontrou foi a suíte `demo/tests/local/faturamento.spec.mjs`, que
-- cancela a fatura no fim e por isso não rodava duas vezes no mesmo banco. A
-- falta de idempotência era o sintoma; isto aqui era a doença.
--
-- ## Por que o número NÃO é reaproveitado
--
-- Reusar `CTR-2026-018/202610` na refeita bastaria para destravar, e cria coisa
-- pior: dois documentos com o mesmo número, um cancelado e um válido. Se a
-- cancelada já foi enviada, "a fatura 202610" passa a ser ambígua justamente na
-- conversa em que alguém está contestando cobrança.
--
-- Número de documento cancelado não se recicla. A refeita ganha sufixo:
--
--   CTR-2026-018/202610     cancelada
--   CTR-2026-018/202610-2   a que vale
--
-- ## Por que no banco, e não na aplicação
--
-- O número é valor DERIVADO, como o total da fatura (0050) e o saldo de peça
-- (0053) — e, neste projeto, valor derivado é mantido por gatilho. Calculá-lo
-- na aplicação deixava a regra a um `insert` de distância de ser contornada, e
-- obrigava quem escrevesse qualquer outro caminho de entrada a redescobri-la.
-- Aqui ela vive encostada no índice que a obriga.
-- =============================================================================

create or replace function app.numerar_fatura_de_locacao()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_codigo    text;
  v_base      text;
  v_candidato text;
  v_sufixo    integer := 1;
begin
  /* Número explícito é respeitado: uma importação de histórico traz o número
     que o documento teve, e inventar outro para ele seria reescrever o
     passado. O cálculo só entra quando não veio nada. */
  if new.number is not null and btrim(new.number) <> '' then
    return new;
  end if;

  select c.code into v_codigo
    from public.rental_contracts c
   where c.id = new.contract_id;

  if v_codigo is null then
    raise exception 'contrato % não encontrado para numerar a fatura', new.contract_id;
  end if;

  v_base := v_codigo || '/' || to_char(new.competence, 'YYYYMM');
  v_candidato := v_base;

  /*
   * Procura o primeiro sufixo livre. O laço parece caro e não é: ele só dá mais
   * de uma volta quando a MESMA competência do MESMO contrato já foi faturada e
   * cancelada antes, que é a exceção e não a regra.
   *
   * Ele considera as canceladas de propósito — são elas que seguram o número
   * antigo. O que não entra são as apagadas (`deleted_at`), porque o índice
   * único também não as considera, e divergir dele traria de volta o erro de
   * chave duplicada que esta migração existe para eliminar.
   */
  while exists (
    select 1 from public.rental_invoices
     where tenant_id = new.tenant_id
       and lower(number) = lower(v_candidato)
       and deleted_at is null
  ) loop
    v_sufixo := v_sufixo + 1;
    v_candidato := v_base || '-' || v_sufixo::text;

    /* Um teto, para que um estado impossível vire erro com nome em vez de laço
       infinito segurando a conexão. */
    if v_sufixo > 100 then
      raise exception 'não foi possível numerar a fatura de % em %: 100 tentativas',
        v_codigo, to_char(new.competence, 'MM/YYYY');
    end if;
  end loop;

  new.number := v_candidato;
  return new;
end;
$$;

comment on function app.numerar_fatura_de_locacao() is
  'Numera a fatura de locação. Reemissão de competência cancelada ganha sufixo: número cancelado não se recicla.';

/*
 * `before insert`: o valor precisa estar na linha ANTES de o índice único e o
 * `not null` serem conferidos.
 *
 * Só no insert. Renumerar na atualização mudaria o número de um documento que
 * já pode ter sido enviado — e um documento que troca de número depois de
 * emitido é pior que um bloqueio.
 */
drop trigger if exists trg_numerar_fatura_de_locacao on public.rental_invoices;
create trigger trg_numerar_fatura_de_locacao
  before insert on public.rental_invoices
  for each row execute function app.numerar_fatura_de_locacao();
