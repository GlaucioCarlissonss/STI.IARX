#!/usr/bin/env bash
# =============================================================================
# Backup do banco — e a prova de que ele volta.
#
# POR QUE ESTE ARQUIVO EXISTE SEPARADO DO `restaurar.sh`
# ------------------------------------------------------
# Porque são dois atos com públicos diferentes: este roda sozinho, de madrugada,
# sem ninguém olhando; o outro roda com alguém angustiado do lado. Misturá-los
# num script com um `--modo` faria o caminho perigoso compartilhar código com o
# caminho rotineiro, e a flag errada apagaria um banco.
#
# O FORMATO
# ---------
# `--format=custom` (-Fc), e não SQL em texto. Três motivos, nesta ordem:
#
#  1. `pg_restore` consegue restaurar TABELA A TABELA a partir dele. Num SQL de
#     texto, recuperar uma tabela só é editar um arquivo de 400 MB à mão — e é
#     exatamente isso que alguém precisa fazer no pior dia.
#  2. Ele já vem comprimido.
#  3. `pg_restore --list` mostra o conteúdo sem restaurar nada, o que permite
#     conferir um arquivo antes de confiar nele.
#
# O QUE ELE NÃO FAZ
# -----------------
# Não envia para lugar nenhum. Backup que mora no mesmo disco do banco não é
# backup — é cópia. Mandar para fora é decisão de infraestrutura (bucket, outro
# host, fita), e o runbook em `docs/24` diz como; este script produz o arquivo e
# imprime o caminho, que é o que qualquer um desses caminhos consome.
#
# Uso:  bash scripts/backup.sh [destino]
# Env:  PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE  (padrões abaixo)
# =============================================================================
set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-sti_iarx_dev}"
export PGHOST PGPORT PGUSER PGDATABASE

DESTINO="${1:-${BACKUP_DIR:-./backups}}"
mkdir -p "$DESTINO"

CARIMBO="$(date -u +%Y%m%dT%H%M%SZ)"
ARQUIVO="$DESTINO/${PGDATABASE}-${CARIMBO}.dump"

echo "==> Copiando ${PGDATABASE} de ${PGHOST}:${PGPORT}"

# `--no-owner` e `--no-privileges`: o dono e os GRANTs são recriados pelas
# migrações, e carregá-los no dump faria a restauração exigir que os mesmos
# papéis existissem com os mesmos nomes na máquina de destino. Num dia ruim,
# isso é a diferença entre restaurar e não restaurar.
pg_dump \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-privileges \
  --file="$ARQUIVO" \
  "$PGDATABASE"

TAMANHO="$(du -h "$ARQUIVO" | cut -f1)"

# A conferência mínima: um arquivo que o `pg_restore` não consegue nem LISTAR
# está corrompido, e descobrir isso agora custa um segundo. Descobrir depois
# custa o banco.
if ! pg_restore --list "$ARQUIVO" > /dev/null 2>&1; then
  echo "ERRO: o arquivo gerado não é um dump legível. Não confie nele." >&2
  exit 1
fi

OBJETOS="$(pg_restore --list "$ARQUIVO" | grep -c '^[0-9]' || true)"

echo "==> Pronto: $ARQUIVO  ($TAMANHO, $OBJETOS objetos)"
echo "$ARQUIVO"
