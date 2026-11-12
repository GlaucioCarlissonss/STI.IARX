#!/usr/bin/env bash
# =============================================================================
# O primeiro tenant e o primeiro administrador, num banco de produção vazio.
#
# POR QUE ISTO É UM SCRIPT E NÃO UM TRECHO DE SQL NO RUNBOOK
# -----------------------------------------------------------
# Porque são quatro inserções em três tabelas, com um uuid que precisa ser o
# mesmo em duas delas e um claim que precisa ir em `app_metadata` e não em
# `user_metadata`. Copiado à mão de um documento, às pressas, no primeiro dia,
# esse conjunto erra — e o erro mais provável (o claim no lugar errado) produz
# um usuário que entra e não enxerga nada, com mensagem de "sem permissão" que
# manda procurar em perfis de acesso.
#
# ELE SE RECUSA A RODAR DUAS VEZES
# --------------------------------
# Se já existe tenant, ele para. Um segundo administrador criado por engano num
# banco em uso é difícil de notar e fácil de não remover.
#
# Uso:
#   EMPRESA="Minha Empresa" SLUG=minha-empresa \
#   EMAIL=admin@minhaempresa.com.br SENHA='...' \
#     bash scripts/primeiro-acesso.sh
# =============================================================================
set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-sti_iarx}"
export PGHOST PGPORT PGUSER PGDATABASE

EMPRESA="${EMPRESA:-}"
SLUG="${SLUG:-}"
EMAIL="${EMAIL:-}"
SENHA="${SENHA:-}"
# `management` é a gestão de TI; `rental` é a locação. Quem faz as duas coisas
# passa ESFERAS="management,rental" — é isso que decide quais telas existem.
ESFERAS="${ESFERAS:-management}"

faltou=0
for v in EMPRESA SLUG EMAIL SENHA; do
  if [ -z "${!v}" ]; then echo "ERRO: falta ${v}" >&2; faltou=1; fi
done
[ "$faltou" = "0" ] || { echo "" >&2; sed -n '20,23p' "$0" >&2; exit 2; }

if [ "${#SENHA}" -lt 12 ]; then
  # Esta é a senha do administrador de um sistema multiempresa exposto à
  # internet. Doze caracteres é pouco; menos que isso não deveria nem começar.
  echo "ERRO: a senha tem ${#SENHA} caracteres. Use 12 ou mais." >&2
  exit 2
fi

psql_run() { psql -v ON_ERROR_STOP=1 --quiet --no-psqlrc "$@"; }

existe="$(psql -At --no-psqlrc -c "select count(*) from public.tenants")"
if [ "${existe:-0}" != "0" ]; then
  echo "ERRO: este banco já tem ${existe} empresa(s). Nada foi feito." >&2
  echo "      Para criar mais usuários, use a tela /usuarios do sistema." >&2
  exit 3
fi

echo "==> Criando '${EMPRESA}' e o administrador ${EMAIL}"

# `encrypted_password` não existe no shim: lá quem guarda senha é o GoTrue do
# Supabase, que não roda numa VPS sem Supabase. A coluna é acrescentada aqui
# (e por `preparar-banco-local.sh` no ambiente de desenvolvimento).
psql_run <<SQL > /dev/null
create extension if not exists pgcrypto;
alter table auth.users add column if not exists encrypted_password text;

do \$\$
declare
  v_tenant uuid := gen_random_uuid();
  v_user   uuid := gen_random_uuid();
begin
  insert into public.tenants (id, name, slug, spheres)
  values (v_tenant, '${EMPRESA//\'/\'\'}', '${SLUG//\'/\'\'}',
          string_to_array('${ESFERAS}', ','));

  -- O claim vai em app_metadata (ADR-002). Em user_metadata ele seria
  -- EDITÁVEL pelo próprio usuário — isto é, cada pessoa escolheria de qual
  -- empresa é, e o isolamento entre tenants deixaria de existir.
  insert into auth.users (id, email, raw_app_meta_data, encrypted_password)
  values (v_user, '${EMAIL//\'/\'\'}',
          jsonb_build_object('tenant_id', v_tenant),
          crypt('${SENHA//\'/\'\'}', gen_salt('bf')));

  insert into public.profiles (id, tenant_id, role, full_name, email)
  values (v_user, v_tenant, 'admin', '${EMAIL//\'/\'\'}', '${EMAIL//\'/\'\'}');
end
\$\$;
SQL

echo ""
echo "    Empresa:        ${EMPRESA}  (esferas: ${ESFERAS})"
echo "    Administrador:  ${EMAIL}"
echo ""
echo "    Entre e troque a senha. Ela passou pela linha de comando e está no"
echo "    histórico do seu shell — apague a linha, ou melhor, troque a senha."
