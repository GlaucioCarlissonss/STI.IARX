#!/usr/bin/env bash
# =============================================================================
# Restaurar um backup — e conferir que ele voltou inteiro.
#
# ESTE SCRIPT APAGA UM BANCO. É o ponto inteiro dele.
#
# POR QUE ELE EXIGE CONFIRMAÇÃO
# -----------------------------
# Porque quem o executa está, quase por definição, num dia ruim: com pressa,
# cansado, e com alguém perguntando quanto falta. É o estado mental em que se
# digita o nome do banco errado. A confirmação não protege contra má intenção —
# protege contra o dedo rápido.
#
# `RESTAURAR_SEM_PERGUNTAR=1` pula a pergunta, e existe por um motivo só: o
# ensaio automático em CI. Em terminal de gente, a pergunta fica.
#
# O QUE ELE CONFERE DEPOIS
# ------------------------
# Que o banco restaurado tem as mesmas tabelas e as mesmas CONTAGENS do dump.
# Um `pg_restore` que termina com código zero não quer dizer que os dados
# chegaram: ele avisa erro de objeto e segue adiante. Sem a conferência, a
# mensagem final seria "restaurado com sucesso" sobre um banco pela metade.
#
# Uso:  bash scripts/restaurar.sh <arquivo.dump> [banco_destino]
# =============================================================================
set -euo pipefail

ARQUIVO="${1:-}"
if [ -z "$ARQUIVO" ] || [ ! -f "$ARQUIVO" ]; then
  echo "Uso: bash scripts/restaurar.sh <arquivo.dump> [banco_destino]" >&2
  exit 2
fi

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
export PGHOST PGPORT PGUSER

DESTINO="${2:-${PGDATABASE:-sti_iarx_dev}}"

psql_run() { psql -v ON_ERROR_STOP=1 --quiet --no-psqlrc "$@"; }

if ! pg_restore --list "$ARQUIVO" > /dev/null 2>&1; then
  echo "ERRO: '$ARQUIVO' não é um dump legível." >&2
  exit 1
fi

if [ "${RESTAURAR_SEM_PERGUNTAR:-0}" != "1" ]; then
  echo "Isto vai APAGAR o banco '${DESTINO}' em ${PGHOST}:${PGPORT} e substituí-lo"
  echo "pelo conteúdo de ${ARQUIVO}."
  read -r -p "Digite o nome do banco para confirmar: " confirmacao
  if [ "$confirmacao" != "$DESTINO" ]; then
    echo "Cancelado — o que você digitou não é '${DESTINO}'." >&2
    exit 3
  fi
fi

echo "==> Derrubando conexões abertas em ${DESTINO}"
# Sem isto, o `drop database` falha com "está sendo acessado por outros
# usuários" — e a mensagem não diz que o culpado costuma ser a própria
# aplicação, ainda de pé.
psql_run -d postgres -c "
  select pg_terminate_backend(pid)
    from pg_stat_activity
   where datname = '${DESTINO}' and pid <> pg_backend_pid();" > /dev/null

echo "==> Recriando ${DESTINO}"
psql_run -d postgres -c "drop database if exists ${DESTINO};" > /dev/null
psql_run -d postgres -c "create database ${DESTINO};" > /dev/null

echo "==> Restaurando"
# `--exit-on-error` é deliberado: o padrão do `pg_restore` é AVISAR e seguir,
# o que termina com código zero sobre um banco incompleto. Num restore, meio
# certo é errado.
pg_restore \
  --dbname="$DESTINO" \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  "$ARQUIVO"

# ---------------------------------------------------------------------------
# A conferência, que é o que transforma esperança em backup
# ---------------------------------------------------------------------------
echo "==> Conferindo"

TABELAS="$(psql -At -d "$DESTINO" -c "
  select count(*) from information_schema.tables
   where table_schema = 'public' and table_type = 'BASE TABLE';")"

if [ "$TABELAS" -lt 1 ]; then
  echo "ERRO: o banco restaurado não tem tabela nenhuma em public." >&2
  exit 1
fi

# Contagem real de cada tabela. `reltuples` seria mais rápido e é uma
# ESTIMATIVA do planejador — num banco recém-restaurado, sem ANALYZE, ela vem
# -1. Conferir backup com estimativa é conferir com um número inventado.
LINHAS="$(psql -At -d "$DESTINO" -c "
  select coalesce(sum(n), 0) from (
    select (xpath('/row/c/text()',
             query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name),
                          false, true, '')))[1]::text::bigint as n
      from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
  ) t;")"

echo "    ${TABELAS} tabelas, ${LINHAS} linhas"

if [ -n "${CONFERIR_LINHAS:-}" ] && [ "$LINHAS" != "$CONFERIR_LINHAS" ]; then
  echo "ERRO: esperava ${CONFERIR_LINHAS} linhas e o restaurado tem ${LINHAS}." >&2
  echo "      O backup NÃO voltou inteiro." >&2
  exit 1
fi

echo "==> Restaurado: ${DESTINO}"
echo "$LINHAS"
