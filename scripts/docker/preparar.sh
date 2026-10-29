#!/usr/bin/env bash
# =============================================================================
# Prepara o banco UMA VEZ, e só então.
#
# POR QUE ESTE INVÓLUCRO EXISTE
# -----------------------------
# `preparar-banco-local.sh` derruba e recria o banco a cada execução — é o
# comportamento certo para quem o chama à mão, e seria desastroso aqui: o
# compose roda este serviço a cada `docker compose up`, e quem tivesse passado a
# tarde cadastrando cliente perderia tudo ao reiniciar o ambiente.
#
# Então a regra é: se o banco já existe, não se mexe nele. Recriar passa a ser um
# ato deliberado, com `RECRIAR=1`.
#
# Uso (pelo compose):  bash /repo/scripts/docker/preparar.sh
# =============================================================================
set -euo pipefail

PGDATABASE="${PGDATABASE:-sti_iarx_dev}"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

existe="$(psql -d postgres -At --no-psqlrc \
  -c "select 1 from pg_database where datname = '${PGDATABASE}'" || true)"

if [ "${existe:-}" = "1" ] && [ "${RECRIAR:-0}" != "1" ]; then
  echo "==> O banco '${PGDATABASE}' já existe. Nada a fazer."
  echo "    Para recriá-lo do zero — e APAGAR o que foi cadastrado:"
  echo "      docker compose run --rm -e RECRIAR=1 preparacao"
  exit 0
fi

exec bash "${AQUI}/../preparar-banco-local.sh"
