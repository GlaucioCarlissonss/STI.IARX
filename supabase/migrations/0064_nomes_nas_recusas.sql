-- =============================================================================
-- 0064 — TODA RECUSA DE DOMÍNIO TEM NOME
--
-- O que acontecia antes, do ponto de vista de quem usa
-- ----------------------------------------------------
-- Três regras do domínio recusavam a escrita com `errcode = '23514'` e sem
-- `constraint =`. Quem recebia a recusa via "violação de check" e uma frase em
-- português; quem depurava via "violação de check" e nada mais.
--
-- O nome da constraint é a costura entre o gatilho e a mensagem: é por ele que
-- a camada de cima sabe QUAL regra recusou, sem ler a prosa. Interface que
-- ramifica por texto quebra na primeira melhoria de redação — e, pior, um
-- teste que afirma só "houve erro" passa quando o código falha pelo motivo
-- errado.
--
-- As três, e o que cada uma protege:
--
--   app.movimento_de_peca_e_imutavel   → part_movements_imutavel
--        movimento de estoque não se altera nem se exclui: o razão guarda o
--        erro E a correção.
--   app.fechar_contagem_de_inventario  → inventory_counts_item_sem_contagem
--        contagem incompleta não ajusta saldo nenhum.
--   app.lote_aplicado_nao_reabre       → spreadsheet_batches_aplicado_imutavel
--        lote já aplicado não volta a ser prévia.
--
-- Por que migração nova e não edição das 0053/0054
-- ------------------------------------------------
-- Migração aplicada não se edita: há banco com elas já rodadas, e reescrever o
-- arquivo faria o histórico divergir do que está no servidor. `create or
-- replace function` com o mesmo nome é o caminho somente-avante.
--
-- O corpo abaixo NÃO foi redigitado: ele foi extraído do arquivo original e
-- reemitido com uma linha a mais. Redigitar a de `fechar_contagem_de_inventario`
-- — que além da recusa faz o ajuste de saldo inteiro — era a chance de perder
-- uma linha no caminho, e um gatilho recriado pela metade não acusa nada: ele
-- fica lá, instalado, fazendo menos.
--
-- Nada mais muda: mesma condição, mesma mensagem, mesma dica. Se alguma delas
-- mudasse junto, a revisão desta migração teria de decidir duas coisas ao mesmo
-- tempo, e uma das duas passaria sem ser lida.
--
-- Quem impede o próximo esquecimento é a §63 de `schema_test.sql`, que varre
-- `pg_proc` — a definição VIVA, não o histórico de migrações — e exige
-- `constraint =` em toda função que levanta `23514`.
-- =============================================================================


-- app.movimento_de_peca_e_imutavel → constraint 'part_movements_imutavel'
create or replace function app.movimento_de_peca_e_imutavel()
returns trigger
language plpgsql
as $$
begin
  raise exception 'movimento de estoque não se altera nem se exclui'
    using errcode    = '23514',
            constraint = 'part_movements_imutavel',
          hint = 'Lance o movimento contrário: o razão guarda o erro E a correção.';
end;
$$;

-- app.fechar_contagem_de_inventario → constraint 'inventory_counts_item_sem_contagem'
create or replace function app.fechar_contagem_de_inventario()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_item record;
  v_dif  numeric(14,3);
begin
  if new.status <> 'closed' or old.status = 'closed' then
    return new;
  end if;

  if exists (
    select 1 from public.inventory_count_items
     where count_id = new.id and counted_quantity is null
  ) then
    raise exception 'há item sem contagem informada — uma contagem incompleta não ajusta nada'
      using errcode    = '23514',
            constraint = 'inventory_counts_item_sem_contagem',
            hint = 'Informe a quantidade contada de cada item, ou remova o item da contagem.';
  end if;

  for v_item in
    select * from public.inventory_count_items where count_id = new.id
  loop
    v_dif := v_item.counted_quantity - v_item.expected_quantity;
    if v_dif <> 0 then
      insert into public.part_movements
        (tenant_id, part_id, depot_id, kind, quantity, inventory_count_id, notes, created_by)
      values (new.tenant_id, v_item.part_id, new.depot_id, 'adjustment', v_dif, new.id,
              format('Contagem %s: esperado %s, contado %s',
                     new.code,
                     app.numero_pt(v_item.expected_quantity),
                     app.numero_pt(v_item.counted_quantity)),
              new.closed_by);
    end if;
  end loop;

  new.closed_at := now();
  return new;
end;
$$;

-- app.lote_aplicado_nao_reabre → constraint 'spreadsheet_batches_aplicado_imutavel'
create or replace function app.lote_aplicado_nao_reabre()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'applied' and new.status <> 'applied' then
    raise exception 'lote já aplicado não volta a ser prévia'
      using errcode    = '23514',
            constraint = 'spreadsheet_batches_aplicado_imutavel',
            hint = 'Para corrigir, envie um lote novo com as linhas corrigidas.';
  end if;
  return new;
end;
$$;
