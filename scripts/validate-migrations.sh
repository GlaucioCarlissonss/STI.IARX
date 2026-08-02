#!/usr/bin/env bash
# =============================================================================
# Aplica shim + todas as migrações + seed em um banco limpo e roda os testes SQL.
#
# Objetivo: provar que o schema executa de verdade em PostgreSQL, em vez de
# confiar em inspeção visual. Usado localmente e no CI.
#
# Uso:  bash scripts/validate-migrations.sh
# Env:  PGHOST PGPORT PGUSER PGDATABASE  (padrões abaixo)
# =============================================================================
set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-sti_iarx_validate}"
export PGHOST PGPORT PGUSER

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

psql_run() { psql -v ON_ERROR_STOP=1 --quiet --no-psqlrc "$@"; }

echo "==> Recriando banco de validação '${PGDATABASE}'"
psql_run -d postgres -c "drop database if exists ${PGDATABASE};" >/dev/null
psql_run -d postgres -c "create database ${PGDATABASE};" >/dev/null

echo "==> Aplicando shim do Supabase"
psql_run -d "$PGDATABASE" -f "$ROOT/scripts/supabase-shim.sql" >/dev/null

echo "==> Aplicando migrações"
for f in "$ROOT"/supabase/migrations/*.sql; do
  printf '    %s\n' "$(basename "$f")"
  psql_run -d "$PGDATABASE" -f "$f" >/dev/null
done

if [ -f "$ROOT/supabase/seed.sql" ]; then
  echo "==> Aplicando seed"
  psql_run -d "$PGDATABASE" -f "$ROOT/supabase/seed.sql" >/dev/null
fi

if [ -f "$ROOT/supabase/tests/schema_test.sql" ]; then
  echo "==> Executando testes de schema e RLS"
  psql_run -d "$PGDATABASE" -f "$ROOT/supabase/tests/schema_test.sql"
fi

echo "==> OK: schema aplicado e verificado."
