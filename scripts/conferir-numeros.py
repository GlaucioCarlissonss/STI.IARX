#!/usr/bin/env python3
"""
Confere os números que a documentação afirma contra o banco de verdade.

POR QUE ISTO EXISTE
-------------------
Esta auditoria corrigiu o mesmo tipo de defeito quatro vezes:

  · entrega 2 — o instalador anunciava 18 views onde o banco tinha 17, porque
    contava `create view` sem descontar os `drop`;
  · entrega 4 — três tabelas de verificação diziam "30 rotas"; o build imprimia
    32, e imprimia 32 desde antes;
  · entrega 6 — `docs/06` dizia 377 asserções depois que viraram 397;
  · entrega 7 — "trigger de auditoria em 18 tabelas", quando já são 34.

Nenhum deles quebrou nada. Número escrito à mão envelhece em silêncio, e a
documentação passa a descrever um sistema que não existe mais — que é pior que
documentação ausente, porque ninguém desconfia dela.

O conserto não é corrigir mais uma vez: é tornar a conferência barata.

COMO RODAR
----------
    PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres npm run db:validate
    python3 scripts/conferir-numeros.py

Sai com código 1 quando algo diverge, para poder entrar no CI.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
BANCO = os.environ.get("PGDATABASE", "sti_iarx_validate")


def consultar(sql: str) -> str:
    """Uma consulta, um valor. `psql -At` para não ter de limpar cabeçalho."""
    env = {**os.environ}
    env.setdefault("PGHOST", "127.0.0.1")
    env.setdefault("PGPORT", "5433")
    env.setdefault("PGUSER", "postgres")
    saida = subprocess.run(
        ["psql", "-d", BANCO, "-At", "-c", sql],
        capture_output=True, text=True, env=env, check=True,
    )
    return saida.stdout.strip()


def medido() -> dict[str, int]:
    return {
        "tabelas": int(consultar("select count(*) from pg_tables where schemaname='public'")),
        "views": int(consultar("select count(*) from pg_views where schemaname='public'")),
        "policies": int(consultar("select count(*) from pg_policies where schemaname='public'")),
        "policies_storage": int(consultar("select count(*) from pg_policies where schemaname='storage'")),
        # O gatilho que `app.attach_audit()` instala chama sempre `app.audit_row`.
        # Contar por aí, e não pelo nome do gatilho, é o que sobrevive a um
        # `trg_*_audit` batizado diferente um dia.
        "auditadas": int(consultar(
            "select count(distinct c.relname) from pg_trigger t "
            "join pg_class c on c.oid = t.tgrelid "
            "join pg_proc p on p.oid = t.tgfoid "
            "where p.proname = 'audit_row' and not t.tgisinternal"
        )),
        "catalogo": int(consultar("select count(*) from public.permission_catalog")),
        "migracoes": len(list((RAIZ / "supabase" / "migrations").glob("*.sql"))),
    }


# (arquivo, regex com UM grupo numérico, chave medida, o que é)
#
# Cada entrada aponta para uma frase em PRESENTE sobre o estado atual. As
# tabelas "Verificação desta entrega" ficam de fora de propósito: são registro
# datado de uma execução passada, e reescrevê-las seria reescrever história.
AFIRMACOES = [
    ("docs/04-modelo-dados.md", r"(\d+) tabelas e \d+ views em `public`", "tabelas", "tabelas no schema"),
    ("docs/04-modelo-dados.md", r"\d+ tabelas e (\d+) views em `public`", "views", "views no schema"),
    ("docs/04-modelo-dados.md", r"com (\d+) policies de RLS", "policies", "policies em public"),
    ("docs/04-modelo-dados.md", r"mais (\d+) policies em\s+`?storage", "policies_storage", "policies em storage"),
    ("docs/04-modelo-dados.md", r"\| `trg_\*_audit` \| (\d+) tabelas", "auditadas", "tabelas auditadas"),
    ("docs/06-lacunas-e-roadmap.md", r"`audit_log` cobre por trigger (\d+) tabelas", "auditadas", "tabelas auditadas"),
    ("README.md", r"Trigger em (\d+) tabelas", "auditadas", "tabelas auditadas"),
    ("README.md", r"migrations/\s+# (\d+) migrações", "migracoes", "migrações"),
    ("README.md", r"\| \[04 — Modelo de dados\]\(docs/04-modelo-dados\.md\) \| (\d+) tabelas", "tabelas", "tabelas no schema"),
]


def main() -> int:
    try:
        valores = medido()
    except subprocess.CalledProcessError as e:
        print("não consegui ler o banco de validação.", file=sys.stderr)
        print("rode antes:  npm run db:validate", file=sys.stderr)
        print(e.stderr.strip(), file=sys.stderr)
        return 2

    print("medido no banco:")
    for chave, valor in valores.items():
        print(f"  {valor:>5}  {chave}")
    print()

    divergencias = 0
    nao_encontradas = 0
    for arquivo, padrao, chave, rotulo in AFIRMACOES:
        texto = (RAIZ / arquivo).read_text(encoding="utf-8")
        achado = re.search(padrao, texto)
        if not achado:
            print(f"  ?      {arquivo}: não achei a frase de {rotulo}")
            nao_encontradas += 1
            continue
        afirmado = int(achado.group(1))
        esperado = valores[chave]
        if afirmado == esperado:
            print(f"  ok     {arquivo}: {rotulo} = {afirmado}")
        else:
            print(f"  ERRADO {arquivo}: {rotulo} diz {afirmado}, o banco tem {esperado}")
            divergencias += 1

    print()
    if divergencias:
        print(f"{divergencias} número(s) divergente(s).")
        return 1
    if nao_encontradas:
        # Frase não encontrada também é divergência: significa que alguém
        # reescreveu o texto e a conferência deixou de cobri-lo sem avisar.
        print(f"{nao_encontradas} frase(s) não localizada(s) — atualize AFIRMACOES.")
        return 1
    print("documentação e banco contam a mesma história.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
