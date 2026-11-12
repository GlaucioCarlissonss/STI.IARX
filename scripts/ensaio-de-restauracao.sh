#!/usr/bin/env bash
# =============================================================================
# O ENSAIO: fazer o backup, APAGAR o banco, restaurar e conferir.
#
# Backup que nunca foi restaurado é esperança, não backup. Este script é o que
# transforma uma coisa na outra — e ele roda no CI a cada push, não uma vez por
# ano num sábado.
#
# O PONTO DELICADO: ele apaga de verdade
# --------------------------------------
# Um ensaio que restaura "ao lado", num banco novo, prova menos do que parece:
# ele não exercita o `drop database` com conexões abertas, não exercita a
# recriação, e passaria mesmo que o banco original estivesse intacto o tempo
# todo. O ensaio honesto destrói e reconstrói.
#
# Por isso ele trabalha num banco PRÓPRIO (`sti_iarx_ensaio`), criado e
# destruído aqui. Apontá-lo para o banco de desenvolvimento de alguém seria
# transformar uma verificação em acidente.
#
# Uso:  bash scripts/ensaio-de-restauracao.sh
# =============================================================================
set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
export PGHOST PGPORT PGUSER

ENSAIO="${ENSAIO_DB:-sti_iarx_ensaio}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRABALHO="$(mktemp -d)"
trap 'rm -rf "$TRABALHO"' EXIT

psql_run() { psql -v ON_ERROR_STOP=1 --quiet --no-psqlrc "$@"; }

contar() {
  psql -At -d "$1" -c "
    select coalesce(sum(n), 0) from (
      select (xpath('/row/c/text()',
               query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name),
                            false, true, '')))[1]::text::bigint as n
        from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
    ) t;"
}

echo "==> 1/5  Montando o banco do ensaio ($ENSAIO)"
psql_run -d postgres -c "drop database if exists ${ENSAIO};" > /dev/null
psql_run -d postgres -c "create database ${ENSAIO};" > /dev/null
psql_run -d "$ENSAIO" -f "$ROOT/scripts/supabase-shim.sql" > /dev/null
for f in "$ROOT"/supabase/migrations/*.sql; do
  psql_run -d "$ENSAIO" -f "$f" > /dev/null
done
psql_run -d "$ENSAIO" -f "$ROOT/supabase/seed.sql" > /dev/null

ANTES="$(contar "$ENSAIO")"
TABELAS_ANTES="$(psql -At -d "$ENSAIO" -c "
  select count(*) from information_schema.tables
   where table_schema='public' and table_type='BASE TABLE';")"
echo "    ${TABELAS_ANTES} tabelas, ${ANTES} linhas"

if [ "$ANTES" -lt 100 ]; then
  echo "ERRO: o banco do ensaio tem só ${ANTES} linhas — o seed não rodou." >&2
  echo "      Um ensaio sobre banco vazio passa sempre e não prova nada." >&2
  exit 1
fi

echo "==> 2/5  Backup"
PGDATABASE="$ENSAIO" bash "$ROOT/scripts/backup.sh" "$TRABALHO" > /dev/null
DUMP="$(ls -t "$TRABALHO"/*.dump | head -1)"
echo "    $(du -h "$DUMP" | cut -f1)"

# Uma marca que SÓ existe antes do backup. Se a restauração silenciosamente não
# fizer nada e o banco "antigo" continuar de pé, esta linha continuaria lá — e o
# ensaio passaria sobre um banco que nunca foi tocado. Ela é apagada depois do
# dump, então o restaurado TEM de trazê-la de volta.
echo "==> 3/5  Sujando o banco (para que restaurar tenha o que desfazer)"
psql_run -d "$ENSAIO" -c "
  insert into public.job_runs (job, ok, affected, detail)
  values ('ensaio-de-restauracao', true, 1, 'linha criada DEPOIS do backup');" > \
  /dev/null
DEPOIS_DE_SUJAR="$(contar "$ENSAIO")"
echo "    ${DEPOIS_DE_SUJAR} linhas (uma a mais que o backup)"

echo "==> 4/5  Restaurando por cima"
RESTAURAR_SEM_PERGUNTAR=1 CONFERIR_LINHAS="$ANTES" \
  bash "$ROOT/scripts/restaurar.sh" "$DUMP" "$ENSAIO" > /dev/null

echo "==> 5/5  Conferindo"
DEPOIS="$(contar "$ENSAIO")"
SUJEIRA="$(psql -At -d "$ENSAIO" -c "
  select count(*) from public.job_runs where job = 'ensaio-de-restauracao';")"

falhou=0
if [ "$DEPOIS" != "$ANTES" ]; then
  echo "  FALHOU  o restaurado tem ${DEPOIS} linhas e o original tinha ${ANTES}" >&2
  falhou=1
else
  echo "  ok      as ${ANTES} linhas voltaram, nas ${TABELAS_ANTES} tabelas"
fi

if [ "$SUJEIRA" != "0" ]; then
  # Este é o caso traiçoeiro: as contagens batem, mas porque o banco nunca foi
  # substituído. Sem esta checagem, um `pg_restore` que não fez nada passaria.
  echo "  FALHOU  a linha criada depois do backup sobreviveu — o banco não foi substituído" >&2
  falhou=1
else
  echo "  ok      o que foi criado depois do backup sumiu, como tem de sumir"
fi

# Uma consulta que exercita RLS de verdade: restaurar o schema sem as policies
# devolveria contagem igual e um banco sem isolamento nenhum.
POLICIES="$(psql -At -d "$ENSAIO" -c "select count(*) from pg_policy;")"
if [ "$POLICIES" -lt 50 ]; then
  echo "  FALHOU  o restaurado tem só ${POLICIES} policies de RLS" >&2
  falhou=1
else
  echo "  ok      as ${POLICIES} policies de RLS vieram junto"
fi

psql_run -d postgres -c "drop database if exists ${ENSAIO};" > /dev/null

if [ "$falhou" != "0" ]; then
  echo ""
  echo "O BACKUP NÃO VOLTA INTEIRO. Não confie nele." >&2
  exit 1
fi

echo ""
echo "################  O BACKUP VOLTA INTEIRO  ################"
