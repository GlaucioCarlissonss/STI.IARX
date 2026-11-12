#!/usr/bin/env bash
# =============================================================================
# Aplicar migrações em PRODUÇÃO — só as que faltam, uma vez cada.
#
# POR QUE ISTO NÃO É O `preparar-banco-local.sh`
# ----------------------------------------------
# Aquele DERRUBA o banco e reaplica tudo do zero. É o comportamento certo em
# desenvolvimento e catastrófico aqui.
#
# E não basta "aplicar todas de novo": as migrações não são idempotentes — elas
# dizem `create table public.tickets`, não `create table if not exists`. Rodar a
# 0001 num banco em produção falha na primeira linha, e é bom que falhe. O que
# falta, então, é saber QUAIS já foram aplicadas.
#
# O LIVRO-RAZÃO
# -------------
# `app.schema_migrations`, uma linha por arquivo aplicado, com a soma de
# verificação do conteúdo. A soma não é zelo excessivo: o erro real que ela pega
# é alguém EDITAR uma migração que já rodou em produção — o arquivo muda, o
# banco não, e os dois seguem divergentes em silêncio até o dia em que uma
# migração nova pressupõe o que o arquivo editado dizia. Aqui isso para o
# script, com o nome do arquivo.
#
# CADA MIGRAÇÃO EM UMA TRANSAÇÃO
# ------------------------------
# `ON_ERROR_STOP` com `--single-transaction`: uma migração que falha no meio
# volta inteira, e o livro-razão não ganha a linha. Sem isso, metade da migração
# ficaria aplicada e a próxima execução tentaria aplicá-la de novo desde o
# começo — e falharia no primeiro `create table` que já existe, sem dizer por quê.
#
# Uso:  bash scripts/migrar.sh
# Env:  PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
# =============================================================================
set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-sti_iarx}"
export PGHOST PGPORT PGUSER PGDATABASE

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
psql_run() { psql -v ON_ERROR_STOP=1 --quiet --no-psqlrc "$@"; }

# ---------------------------------------------------------------------------
# O banco
# ---------------------------------------------------------------------------
existe="$(psql -d postgres -At --no-psqlrc \
  -c "select 1 from pg_database where datname = '${PGDATABASE}'")"

if [ "${existe:-}" != "1" ]; then
  echo "==> Criando o banco '${PGDATABASE}'"
  psql_run -d postgres -c "create database ${PGDATABASE};" > /dev/null
fi

# ---------------------------------------------------------------------------
# O shim, só na primeira vez
# ---------------------------------------------------------------------------
# Ele cria os papéis `anon`, `authenticated` e `service_role` e os esquemas que
# o Supabase traria prontos. Numa VPS sem Supabase, é o que faz o RLS das
# migrações ter em quem se aplicar.
tem_auth="$(psql -d "$PGDATABASE" -At --no-psqlrc \
  -c "select 1 from information_schema.schemata where schema_name = 'auth'")"

if [ "${tem_auth:-}" != "1" ]; then
  echo "==> Primeira vez: aplicando o shim (papéis e esquemas)"
  psql_run -d "$PGDATABASE" -f "$ROOT/scripts/supabase-shim.sql" > /dev/null

  # As concessões que o Supabase daria de presente ao projeto. Sem elas,
  # `service_role` tem BYPASSRLS e mesmo assim esbarra em "permission denied for
  # table" — que não parece permissão de papel nenhuma e manda procurar errado.
  #
  # As `default privileges` precisam vir ANTES das migrações: elas valem para o
  # que for criado DEPOIS delas, e é justamente das tabelas das migrações que se
  # trata. O `grant usage on schema app` fica para depois, porque quem cria o
  # esquema `app` é a migração 0001 — tentá-lo aqui para o script com
  # "schema app does not exist", que foi o que aconteceu na primeira vez que
  # rodei isto.
  psql_run -d "$PGDATABASE" > /dev/null <<SQL
grant anon, authenticated, service_role to ${PGUSER};
grant usage on schema public, storage to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;
SQL
fi

# ---------------------------------------------------------------------------
# O livro-razão
# ---------------------------------------------------------------------------
psql_run -d "$PGDATABASE" > /dev/null <<'SQL'
create schema if not exists app;
create table if not exists app.schema_migrations (
  nome        text primary key,
  soma        text not null,
  aplicada_em timestamptz not null default now()
);
SQL

# ---------------------------------------------------------------------------
# Aplicar o que falta
# ---------------------------------------------------------------------------
aplicadas=0
puladas=0

for arquivo in "$ROOT"/supabase/migrations/*.sql; do
  nome="$(basename "$arquivo")"
  soma="$(sha256sum "$arquivo" | cut -d' ' -f1)"

  registrada="$(psql -d "$PGDATABASE" -At --no-psqlrc \
    -c "select soma from app.schema_migrations where nome = '${nome}'")"

  if [ -n "$registrada" ]; then
    if [ "$registrada" != "$soma" ]; then
      echo "" >&2
      echo "ERRO: a migração '${nome}' já foi aplicada, mas o arquivo MUDOU." >&2
      echo "" >&2
      echo "      O banco tem a versão antiga; o repositório, a nova. Aplicar o" >&2
      echo "      arquivo de novo não é possível (migração não é idempotente), e" >&2
      echo "      ignorar a diferença deixaria os dois divergentes em silêncio." >&2
      echo "" >&2
      echo "      O conserto é uma migração NOVA com a mudança. Migração aplicada" >&2
      echo "      em produção é história, e história não se edita." >&2
      exit 1
    fi
    puladas=$((puladas + 1))
    continue
  fi

  printf '    aplicando %s\n' "$nome"
  # `--single-transaction`: falhou no meio, volta inteira.
  psql_run --single-transaction -d "$PGDATABASE" -f "$arquivo" > /dev/null
  psql_run -d "$PGDATABASE" \
    -c "insert into app.schema_migrations (nome, soma) values ('${nome}', '${soma}');" > /dev/null
  aplicadas=$((aplicadas + 1))
done

# Agora que o esquema `app` existe (migração 0001), o `service_role` pode
# enxergá-lo. É aqui e não antes porque não dá para conceder uso de um esquema
# que ainda não foi criado.
psql_run -d "$PGDATABASE" -c "grant usage on schema app to service_role;" > /dev/null

echo "==> ${aplicadas} aplicada(s), ${puladas} já estavam."

# A primeira execução registra TODAS as migrações de uma vez, e o banco fica sem
# tenant nenhum. Dizer isso aqui evita o chamado "subi e não consigo entrar":
# não há usuário porque o seed é de desenvolvimento e não roda em produção.
if [ "$puladas" = "0" ] && [ "$aplicadas" -gt 0 ]; then
  echo ""
  echo "    Banco novo, sem dado nenhum — o seed é de desenvolvimento e NÃO roda"
  echo "    aqui. Para criar o primeiro tenant e o primeiro administrador, veja"
  echo "    a seção 'Primeiro acesso' em docs/24."
fi
