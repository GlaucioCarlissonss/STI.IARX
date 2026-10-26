#!/usr/bin/env bash
# =============================================================================
# Prepara um banco de DESENVOLVIMENTO local: shim + migrações + seed + senhas.
#
# POR QUE ELE É SEPARADO DE `validate-migrations.sh`
# ---------------------------------------------------
# Aquele existe para PROVAR o schema: recria o banco do zero a cada execução e
# roda as asserções. Este existe para USAR o schema: ele é o banco em que a
# aplicação roda, e recriá-lo a cada vez apagaria o que a pessoa acabou de
# cadastrar testando a tela.
#
# São bancos diferentes no mesmo servidor, e isso é deliberado: rodar a suíte de
# schema não pode derrubar o ambiente em que alguém está mexendo.
#
# AS SENHAS
# ---------
# O seed cria usuários em `auth.users` sem senha nenhuma — porque no Supabase
# quem guarda senha é o GoTrue, que não existe aqui. Este script acrescenta a
# coluna e define uma senha de desenvolvimento para todo mundo.
#
# Ela é IGUAL para todos e está escrita aqui em claro, de propósito: é um banco
# de desenvolvimento com dado de exemplo, e fingir segredo num lugar desses só
# faz as pessoas inventarem o próprio jeito de contornar.
#
# Uso:  bash scripts/preparar-banco-local.sh
# =============================================================================
set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-sti_iarx_dev}"
SENHA_DEV="${SENHA_DEV:-desenvolvimento}"
export PGHOST PGPORT PGUSER

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
psql_run() { psql -v ON_ERROR_STOP=1 --quiet --no-psqlrc "$@"; }

echo "==> Recriando o banco de desenvolvimento '${PGDATABASE}'"
psql_run -d postgres -c "drop database if exists ${PGDATABASE};" >/dev/null
psql_run -d postgres -c "create database ${PGDATABASE};" >/dev/null

echo "==> Shim do Supabase (auth, storage, papéis)"
psql_run -d "$PGDATABASE" -f "$ROOT/scripts/supabase-shim.sql" >/dev/null

echo "==> Migrações"
for f in "$ROOT"/supabase/migrations/*.sql; do
  printf '    %s\n' "$(basename "$f")"
  psql_run -d "$PGDATABASE" -f "$f" >/dev/null
done

echo "==> Seed"
psql_run -d "$PGDATABASE" -f "$ROOT/supabase/seed.sql" >/dev/null

echo "==> Senhas de desenvolvimento"
psql_run -d "$PGDATABASE" <<SQL >/dev/null
create extension if not exists pgcrypto;

-- A coluna de senha não existe no shim porque o shim serve à suíte de schema,
-- que nunca faz login. Aqui ela é necessária, e só aqui.
alter table auth.users add column if not exists encrypted_password text;

update auth.users set encrypted_password = crypt('${SENHA_DEV}', gen_salt('bf'));

-- O app conecta como \`postgres\` e troca de papel por transação. Para o
-- \`set local role\` funcionar, o papel precisa ser concedido a quem conecta.
grant anon, authenticated, service_role to ${PGUSER};

-- O que o Supabase concede e o shim não concedia.
--
-- \`service_role\` tem BYPASSRLS, e no Supabase também tem GRANT em tudo. Sem o
-- GRANT, o papel ignora as policies e esbarra na permissão de TABELA — o erro é
-- "permission denied for table tickets", que não parece permissão de papel
-- nenhuma e manda a pessoa procurar no lugar errado.
--
-- \`anon\` e \`authenticated\` NÃO entram aqui de propósito: quem concede a eles
-- são as migrações, tabela por tabela, e é assim que o ambiente local continua
-- provando a mesma coisa que a produção.
grant usage on schema public, app, storage to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
grant all on all tables in schema storage to service_role;
SQL

echo
echo "==> Pronto. Entre com qualquer e-mail do seed e a senha: ${SENHA_DEV}"
psql_run -d "$PGDATABASE" -At -c \
  "select '    ' || p.email || '  (' || p.role || ')'
     from public.profiles p
     join auth.users u on u.id = p.id
    where p.is_active
    order by case p.role when 'admin' then 1 when 'gestor' then 2 else 3 end, p.email
    limit 8"
