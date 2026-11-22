#!/usr/bin/env python3
"""
Gera os artefatos SQL do banco e o dicionário de dados — DERIVADOS, nunca escritos.

POR QUE DERIVAR, E NÃO ESCREVER
-------------------------------
As 64 migrações são a fonte da verdade do schema. Um DDL consolidado escrito à
mão seria uma SEGUNDA verdade sobre a mesma coisa, e as duas divergem na
primeira correção que entra só numa delas — tarde, em produção, num relatório
que não bate.

Esta base já tem quatro testes que nasceram exatamente desse defeito: o menu do
protótipo ficou 26 telas atrás, o "Mapa do menu" listava telas sem destino, a
varredura de rotas perdeu a `/assinatura`, e o artefato oferecia cinco arquivos
que não existiam. Em todos, a falta não produziu erro nenhum — produziu uma
cobertura menor que ninguém media.

Então aqui o DDL sai do CATÁLOGO DO PRÓPRIO POSTGRES, com `pg_get_constraintdef`,
`pg_get_indexdef`, `pg_get_functiondef`, `pg_get_triggerdef` e `pg_get_viewdef`
— que é o que o banco responde quando perguntado o que ele é. Não há como
divergir do schema porque não há cópia: há uma leitura.

O MODO `--conferir`
-------------------
Gera para uma pasta temporária e compara com o que está commitado. Vermelho
quando divergem, que é o dia em que alguém mexeu numa migração e não regerou.
É o portão; sem ele estes arquivos envelheceriam em silêncio como qualquer
outra cópia.

Uso:
  python3 scripts/gerar-artefatos-do-banco.py            # gera em docs/banco/
  python3 scripts/gerar-artefatos-do-banco.py --conferir # só confere
  PGDATABASE=outro python3 scripts/gerar-artefatos-do-banco.py --usar-banco
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SAIDA = RAIZ / "docs" / "banco"
DICIONARIO = RAIZ / "demo" / "dicionario.json"

# Separadores improváveis em SQL: corpo de função tem `|`, vírgula, aspas e
# quebra de linha, e qualquer separador comum cortaria a definição no meio.
SEP_CAMPO = "\x01"
SEP_LINHA = "\x02"

BANCO_DE_TRABALHO = "sti_iarx_artefatos"


def psql(sql: str, banco: str, capturar: bool = True) -> str:
    env = dict(os.environ)
    env.setdefault("PGPASSWORD", "postgres")
    r = subprocess.run(
        ["psql", "-h", env.get("PGHOST", "127.0.0.1"), "-p", env.get("PGPORT", "5433"),
         "-U", env.get("PGUSER", "postgres"), "-d", banco,
         "-At", "-F", SEP_CAMPO, "-R", SEP_LINHA, "--no-psqlrc",
         "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=capturar, text=True, env=env, check=True,
    )
    return r.stdout if capturar else ""


def linhas(sql: str, banco: str) -> list[list[str]]:
    bruto = psql(sql, banco)
    # O psql acrescenta UM `\n` no fim de tudo, mesmo com `-R` próprio. Ele cola
    # no último campo da última linha, e um campo que deveria estar vazio passa
    # a conter "\n" — que é verdadeiro em Python. Foi assim que a policy de
    # `select` do bucket de anexos ganhou um `with check ()` vazio e o arquivo
    # morreu com "syntax error at or near )".
    if bruto.endswith("\n"):
        bruto = bruto[:-1]
    bruto = bruto.strip(SEP_LINHA)
    if not bruto:
        return []
    return [l.split(SEP_CAMPO) for l in bruto.split(SEP_LINHA) if l]


# ---------------------------------------------------------------------------
# O banco de trabalho
# ---------------------------------------------------------------------------
def preparar_banco() -> str:
    """
    Um banco LIMPO, feito só das migrações.

    O banco de desenvolvimento não serve: ele tem a semente e as fixtures que
    `schema_test.sql` cria. Gerar os `insert` de dados iniciais a partir dele
    publicaria empresa e chamado de mentira dentro do artefato — e dado de
    demonstração indistinguível de requisito é exatamente o que a doutrina
    proíbe inventar.
    """
    env = dict(os.environ)
    env.setdefault("PGPASSWORD", "postgres")
    base = ["psql", "-h", env.get("PGHOST", "127.0.0.1"), "-p", env.get("PGPORT", "5433"),
            "-U", env.get("PGUSER", "postgres"), "--no-psqlrc", "-q", "-v", "ON_ERROR_STOP=1"]

    subprocess.run(base + ["-d", "postgres", "-c",
                           f"drop database if exists {BANCO_DE_TRABALHO}"],
                   check=True, env=env, capture_output=True)
    subprocess.run(base + ["-d", "postgres", "-c", f"create database {BANCO_DE_TRABALHO}"],
                   check=True, env=env, capture_output=True)
    subprocess.run(base + ["-d", BANCO_DE_TRABALHO, "-f",
                           str(RAIZ / "scripts" / "supabase-shim.sql")],
                   check=True, env=env, capture_output=True)
    for arquivo in sorted((RAIZ / "supabase" / "migrations").glob("*.sql")):
        subprocess.run(base + ["--single-transaction", "-d", BANCO_DE_TRABALHO,
                               "-f", str(arquivo)],
                       check=True, env=env, capture_output=True)
    return BANCO_DE_TRABALHO


# ---------------------------------------------------------------------------
# Os geradores
# ---------------------------------------------------------------------------
CABECALHO = """-- =============================================================================
-- {titulo}
--
-- GERADO — não edite este arquivo.
--
-- Ele é lido do catálogo do PostgreSQL por
-- `scripts/gerar-artefatos-do-banco.py`, a partir de um banco feito só das
-- migrações. A fonte da verdade continua sendo `supabase/migrations/`; isto
-- aqui é o retrato consolidado do que elas produzem, para quem precisa LER o
-- schema inteiro de uma vez em vez de atravessar 64 arquivos.
--
-- Para mudar o schema: migração nova. Para atualizar este arquivo: rode o
-- gerador. `npm test` fica vermelho quando os dois divergem.
-- =============================================================================

"""


def gerar_esquemas(banco: str) -> str:
    """
    O que precisa existir ANTES das tabelas.

    A ordem que o pedido descreve — tabelas, depois funções — não sobrevive ao
    contato com este schema: doze restrições `check` chamam `app.eh_competencia`,
    e uma restrição que chama função inexistente não é adiada, é recusada na
    hora. Então as funções de que as TABELAS dependem vêm aqui, e só elas.

    A lista é DETECTADA, lendo as definições das restrições atrás de
    `esquema.funcao(`. Escrevê-la à mão faria o arquivo quebrar no dia em que
    alguém acrescentasse um `check` chamando outra função — que é o dia em que
    ninguém estaria olhando para este gerador.
    """
    defs = [r[0] for r in linhas("""
        select pg_get_constraintdef(con.oid)
          from pg_constraint con
          join pg_class c on c.oid = con.conrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
    """, banco)]
    precisadas = sorted({m for d in defs
                         for m in re.findall(r'\b(app|public)\.(\w+)\s*\(', d)})

    partes = [CABECALHO.format(titulo="00 — ESQUEMAS, EXTENSÕES E AS FUNÇÕES QUE AS TABELAS EXIGEM")]
    partes.append(
        "-- `app` guarda a regra e a esconde de `public`. É o mais perto que o\n"
        "-- PostgreSQL chega de um package do Oracle — que ele não tem.\n"
        "--\n"
        "-- `pgcrypto` gera uuid e hash; `unaccent` é o que faz a busca achar\n"
        "-- \"manutencao\" quando a pessoa digita \"manutenção\".\n\n")
    partes.append("create schema if not exists app;\n")
    partes.append("create extension if not exists pgcrypto;\n")
    partes.append("create extension if not exists unaccent;\n\n")

    # A CONFIGURAÇÃO DE BUSCA TEXTUAL, que um índice usa pelo nome.
    #
    # `to_tsvector('portugues_sem_acento', texto)` só é imutável porque a
    # configuração está fixada pelo nome — e um índice de expressão exige
    # imutabilidade. Sem ela, o arquivo 01 morre no `create index` com
    # "text search configuration does not exist", que foi onde ele parou.
    cfgs = linhas("""
        select n.nspname, cfg.cfgname
          from pg_ts_config cfg join pg_namespace n on n.oid = cfg.cfgnamespace
         where n.nspname in ('public', 'app')
         order by 1, 2
    """, banco)
    for esquema, nome in cfgs:
        mapas = linhas(f"""
            select t.alias,
                   string_agg(d.dictname, ', ' order by m.mapseqno)
              from pg_ts_config_map m
              join pg_ts_config cfg on cfg.oid = m.mapcfg
              join pg_namespace n on n.oid = cfg.cfgnamespace
              join pg_ts_dict d on d.oid = m.mapdict
              join pg_catalog.ts_token_type(
                     (select cfgparser from pg_ts_config where oid = cfg.oid)) t
                on t.tokid = m.maptokentype
             where n.nspname = '{esquema}' and cfg.cfgname = '{nome}'
             group by t.alias
             order by t.alias
        """, banco)
        partes.append(f"\n-- {'-' * 74}\n-- Busca textual: {esquema}.{nome}\n"
                      f"-- {'-' * 74}\n")
        partes.append(f"create text search configuration {esquema}.{nome} "
                      f"(copy = pg_catalog.portuguese);\n")
        for alias, dicts in mapas:
            partes.append(f"alter text search configuration {esquema}.{nome}\n"
                          f"  alter mapping for {alias} with {dicts};\n")
        partes.append("\n")

    if precisadas:
        partes.append(f"-- {'-' * 74}\n"
                      f"-- As funções que restrições `check` chamam ({len(precisadas)})\n"
                      f"-- {'-' * 74}\n")
        for esquema, nome in precisadas:
            for (definicao,) in [tuple(r) for r in linhas(f"""
                select pg_get_functiondef(p.oid)
                  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = '{esquema}' and p.proname = '{nome}'
                 order by p.oid
            """, banco)]:
                partes.append(f"\n-- {esquema}.{nome}\n{definicao};\n")
    return "".join(partes)


def gerar_tabelas(banco: str) -> str:
    cols = linhas("""
        select c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
               case when a.attnotnull then 'not null' else '' end,
               coalesce(pg_get_expr(d.adbin, d.adrelid), ''),
               -- `attgenerated='s'` é coluna GERADA e armazenada. Ela guarda a
               -- expressão no mesmo lugar que um default, e foi por isso que a
               -- primeira versão a escreveu como `default` — o que o PostgreSQL
               -- recusa com "cannot use column reference in DEFAULT expression",
               -- porque default não enxerga outra coluna da própria linha.
               a.attgenerated
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
          left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
         where n.nspname = 'public' and c.relkind = 'r'
         order by c.relname, a.attnum
    """, banco)

    cons = linhas("""
        select c.relname, con.conname, pg_get_constraintdef(con.oid), con.contype::text
          from pg_constraint con
          join pg_class c on c.oid = con.conrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           -- `contype='t'` é CONSTRAINT TRIGGER, e `pg_get_constraintdef`
           -- devolve dele "TRIGGER DEFERRABLE INITIALLY DEFERRED" — que não é
           -- um `add constraint` válido e matou o arquivo na linha 503. Ele é
           -- gatilho, sai no 03 por `pg_get_triggerdef`, onde tem sintaxe.
           and con.contype <> 't'
         order by c.relname,
                  case con.contype when 'p' then 1 when 'u' then 2
                                   when 'f' then 3 else 4 end,
                  con.conname
    """, banco)

    # IDENTITY e SERIAL não se escrevem com o `default` que o catálogo mostra.
    #
    # A coluna `generated always as identity` aparece com `attidentity='a'` e
    # sem default nenhum; a `serial` aparece com `default nextval('x_id_seq')`
    # e a sequência precisa EXISTIR antes. A primeira versão ignorou as duas e
    # o arquivo morreu na linha 457 com "relation auth_tokens_id_seq does not
    # exist" — descoberto rodando, não lendo.
    ident = {(r[0], r[1]): r[2] for r in linhas("""
        select c.relname, a.attname, a.attidentity
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         where n.nspname = 'public' and c.relkind = 'r' and a.attidentity <> ''
    """, banco)}

    seqs = linhas("""
        select s.sequencename, s.data_type::text,
               coalesce(c.relname, ''), coalesce(a.attname, '')
          from pg_sequences s
          left join pg_depend d
                 on d.objid = ('public.' || quote_ident(s.sequencename))::regclass
                and d.deptype = 'a'
          left join pg_class c on c.oid = d.refobjid
          left join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
         where s.schemaname = 'public'
         order by s.sequencename
    """, banco)

    por_tabela: dict[str, list] = {}
    for t, nome, tipo, nn, padrao, gerada in cols:
        por_tabela.setdefault(t, []).append((nome, tipo, nn, padrao, gerada))

    cons_por_tabela: dict[str, list] = {}
    for t, nome, definicao, tipo in cons:
        cons_por_tabela.setdefault(t, []).append((nome, definicao, tipo))

    partes = [CABECALHO.format(
        titulo="01 — TABELAS E RELACIONAMENTOS  ({} tabelas)".format(len(por_tabela)))]
    partes.append(
        "-- A chave estrangeira aparece como `alter table ... add constraint`, e não\n"
        "-- dentro do `create table`, porque a ordem de criação entre 125 tabelas tem\n"
        "-- ciclo: `tickets` aponta para `profiles` e `profiles` aponta para `tenants`,\n"
        "-- que por sua vez tem coluna apontando para `planos`. Separar as duas coisas\n"
        "-- é o que torna este arquivo executável de cima para baixo.\n\n")

    if seqs:
        partes.append(f"-- {'-' * 74}\n-- As sequências ({len(seqs)}), antes de quem as usa\n"
                      f"-- {'-' * 74}\n")
        for nome, tipo, _t, _c in seqs:
            partes.append(f"create sequence public.{nome} as {tipo};\n")
        partes.append("\n")

    for tabela in sorted(por_tabela):
        partes.append(f"-- {'-' * 74}\n-- {tabela}\n-- {'-' * 74}\n")
        linhas_col = []
        for nome, tipo, nn, padrao, gerada in por_tabela[tabela]:
            pedaco = f"  {nome} {tipo}"
            marca = ident.get((tabela, nome))
            if gerada == "s":
                pedaco += f" generated always as ({padrao}) stored"
            elif marca:
                pedaco += (" generated always as identity" if marca == "a"
                           else " generated by default as identity")
            elif padrao:
                pedaco += f" default {padrao}"
            if nn:
                pedaco += " not null"
            linhas_col.append(pedaco)
        partes.append(f"create table public.{tabela} (\n" + ",\n".join(linhas_col) + "\n);\n")
        for nome, definicao, tipo in cons_por_tabela.get(tabela, []):
            if tipo == "f":
                continue  # as FK vão todas no fim, depois de todas as tabelas
            partes.append(
                f"alter table public.{tabela}\n  add constraint {nome} {definicao};\n")
        partes.append("\n")

    partes.append(f"-- {'=' * 74}\n-- OS RELACIONAMENTOS\n-- {'=' * 74}\n\n")
    n_fk = 0
    for tabela in sorted(cons_por_tabela):
        for nome, definicao, tipo in cons_por_tabela[tabela]:
            if tipo != "f":
                continue
            n_fk += 1
            partes.append(
                f"alter table public.{tabela}\n  add constraint {nome} {definicao};\n")
    partes.insert(2, f"-- {n_fk} chaves estrangeiras, no fim do arquivo.\n\n")

    donas = [s for s in seqs if s[2] and s[3]]
    if donas:
        partes.append(f"\n-- {'=' * 74}\n-- A QUEM CADA SEQUÊNCIA PERTENCE\n-- {'=' * 74}\n")
        partes.append("-- Sem o `owned by`, apagar a tabela deixa a sequência órfã no banco,\n"
                      "-- e recriar a tabela esbarra num nome que já existe.\n")
        for nome, _tipo, tabela, coluna in donas:
            partes.append(f"alter sequence public.{nome} owned by public.{tabela}.{coluna};\n")
    return "".join(partes)


def gerar_indices(banco: str) -> str:
    idx = linhas("""
        select c.relname, i.relname, pg_get_indexdef(i.oid)
          from pg_index x
          join pg_class i on i.oid = x.indexrelid
          join pg_class c on c.oid = x.indrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and not exists (select 1 from pg_constraint con where con.conindid = i.oid)
         order by c.relname, i.relname
    """, banco)
    partes = [CABECALHO.format(titulo=f"02 — ÍNDICES  ({len(idx)})")]
    partes.append(
        "-- Só os índices PRÓPRIOS. Os que o PostgreSQL cria sozinho para sustentar\n"
        "-- chave primária e restrição de unicidade ficam de fora: eles já estão no\n"
        "-- arquivo 01, dentro da constraint que os pede, e repeti-los aqui faria\n"
        "-- este arquivo falhar ao ser executado sobre o outro.\n\n")
    atual = None
    for tabela, nome, definicao in idx:
        if tabela != atual:
            partes.append(f"\n-- {tabela}\n")
            atual = tabela
        partes.append(definicao + ";\n")
    return "".join(partes)


def gerar_funcoes(banco: str) -> str:
    fns = linhas("""
        select n.nspname, p.proname, pg_get_functiondef(p.oid)
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('app', 'public') and p.prokind = 'f'
         order by n.nspname, p.proname, p.oid
    """, banco)
    tgs = linhas("""
        select c.relname, t.tgname, pg_get_triggerdef(t.oid)
          from pg_trigger t
          join pg_class c on c.oid = t.tgrelid
          join pg_namespace n on n.oid = c.relnamespace
         where not t.tgisinternal and n.nspname = 'public'
         order by c.relname, t.tgname
    """, banco)

    partes = [CABECALHO.format(
        titulo=f"03 — FUNÇÕES E GATILHOS  ({len(fns)} funções, {len(tgs)} gatilhos)")]
    partes.append(
        "-- A ORDEM ENTRE AS FUNÇÕES É ALFABÉTICA, E ELAS CHAMAM UMAS ÀS OUTRAS.\n"
        "--\n"
        "-- Função em linguagem SQL tem o corpo validado na criação, então\n"
        "-- `app.meses_entre` precisaria existir antes de quem a chama — e ordenar\n"
        "-- 211 funções por dependência é um grafo que muda a cada entrega. O\n"
        "-- `check_function_bodies = off` adia essa validação para a primeira\n"
        "-- chamada, que é o que o próprio `pg_dump` faz pelo mesmo motivo.\n"
        "--\n"
        "-- O que se perde: um erro de digitação dentro de uma função SQL passa\n"
        "-- aqui e só aparece ao ser chamada. Isso é aceitável porque estas\n"
        "-- funções JÁ foram criadas com validação ligada, pelas migrações — este\n"
        "-- arquivo é um retrato do que passou, não a porta de entrada.\n"
        "set check_function_bodies = off;\n\n")
    partes.append(
        "-- NÃO HÁ `procedure` NEM CURSOR EXPLÍCITO NESTE SCHEMA, e não há `package`:\n"
        "-- package é construção do Oracle e o PostgreSQL não a tem. O equivalente\n"
        "-- aqui é o esquema `app`, que agrupa as funções de regra e as esconde de\n"
        "-- `public`.\n"
        "--\n"
        "-- Os laços `for ... in select ... loop` do PL/pgSQL são cursores IMPLÍCITOS:\n"
        "-- o PostgreSQL abre, percorre e fecha sem que ninguém declare. É assim que\n"
        "-- o fechamento de contagem de inventário percorre os itens. Declarar um\n"
        "-- cursor à mão só se justificaria para percorrer resultado grande com\n"
        "-- controle de posição, e não há caso desses aqui.\n\n")
    for esquema, nome, definicao in fns:
        partes.append(f"\n-- {esquema}.{nome}\n{definicao};\n")
    partes.append(f"\n\n-- {'=' * 74}\n-- OS GATILHOS\n-- {'=' * 74}\n")
    partes.append(
        "-- A ordem de disparo entre gatilhos do MESMO evento é alfabética pelo nome.\n"
        "-- Quando um depende do outro, é o nome que ordena — e é por isso que ela\n"
        "-- aparece aqui, em vez de ser detalhe de implementação.\n")
    atual = None
    for tabela, nome, definicao in tgs:
        if tabela != atual:
            partes.append(f"\n-- {tabela}\n")
            atual = tabela
        partes.append(definicao + ";\n")
    return "".join(partes)


def gerar_rls(banco: str) -> str:
    tabs = linhas("""
        select c.relname, c.relrowsecurity::text, c.relforcerowsecurity::text
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
         order by c.relname
    """, banco)
    pols = linhas("""
        select schemaname, tablename, policyname, permissive, roles::text, cmd,
               coalesce(qual, ''), coalesce(with_check, '')
          from pg_policies
         where schemaname in ('public', 'storage')
         order by schemaname, tablename, policyname
    """, banco)

    partes = [CABECALHO.format(
        titulo=f"04 — RLS E POLICIES  ({len(pols)} policies)")]
    partes.append(
        "-- O ISOLAMENTO ENTRE EMPRESAS MORA AQUI, e em nenhum outro lugar.\n"
        "--\n"
        "-- `enable row level security` sozinho não alcança o DONO da tabela — e o\n"
        "-- dono é quem roda migração e trabalho agendado. O `force` é o que fecha\n"
        "-- isso, e é por ele que a conferência de produção cobra em toda tabela que\n"
        "-- tem `tenant_id`.\n"
        "--\n"
        "-- Tabela com RLS e SEM policy nega tudo, em silêncio: a tela não carrega e\n"
        "-- não há erro. A recusa deliberada se escreve `using (false)`, que é uma\n"
        "-- policy e aparece nesta lista.\n\n")
    # `boolean::text` devolve "true"/"false", e NÃO "t"/"f" — o "t" é como o
    # psql EXIBE um booleano, não o que o cast produz. Comparar com "t" fazia
    # todo `enable row level security` ser pulado em silêncio: os arquivos
    # rodavam sem erro, as 278 policies eram criadas, e o banco resultante
    # ficava com o RLS DESLIGADO em 125 tabelas — isto é, com o isolamento
    # entre empresas inexistente e nada acusando.
    #
    # Quem acusou foi `conferir-producao.sql` rodando contra o banco feito
    # destes arquivos. É a diferença entre "o script executou" e "o script
    # produziu o banco certo".
    for tabela, rls, force in tabs:
        if rls == "true":
            partes.append(f"alter table public.{tabela} enable row level security;\n")
            if force == "true":
                partes.append(f"alter table public.{tabela} force row level security;\n")
    partes.append(f"\n\n-- {'=' * 74}\n-- AS POLICIES\n-- {'=' * 74}\n")
    atual = None
    for esquema, tabela, nome, permissive, papeis, cmd, qual, check in pols:
        chave = f"{esquema}.{tabela}"
        if chave != atual:
            partes.append(f"\n-- {chave}\n")
            atual = chave
        papeis_sql = papeis.strip("{}").replace(",", ", ") or "public"
        txt = f"create policy {nome} on {esquema}.{tabela}\n"
        if permissive != "PERMISSIVE":
            txt += "  as restrictive\n"
        txt += f"  for {cmd.lower()} to {papeis_sql}\n"
        if qual:
            txt += f"  using ({qual})\n"
        if check:
            txt += f"  with check ({check})\n"
        partes.append(txt.rstrip() + ";\n")
    return "".join(partes)


def gerar_views(banco: str) -> str:
    # VIEW QUE LÊ OUTRA VIEW PRECISA VIR DEPOIS DELA.
    #
    # A ordem alfabética não sabe disso: `vw_job_alertas` lê `vw_job_health` e
    # vem antes no alfabeto. O arquivo morria com "relation vw_job_health does
    # not exist" — num banco já pronto nada disso aparece, porque lá as duas já
    # existem. Só executar o arquivo do zero mostra.
    arestas = linhas("""
        select distinct dep.relname, ref.relname
          from pg_depend d
          join pg_rewrite r on r.oid = d.objid
          join pg_class dep on dep.oid = r.ev_class
          join pg_class ref on ref.oid = d.refobjid
          join pg_namespace n1 on n1.oid = dep.relnamespace
          join pg_namespace n2 on n2.oid = ref.relnamespace
         where n1.nspname = 'public' and n2.nspname = 'public'
           and dep.relkind = 'v' and ref.relkind = 'v' and dep.oid <> ref.oid
    """, banco)

    vws = linhas("""
        select c.relname,
               coalesce((select option_value from pg_options_to_table(c.reloptions)
                          where option_name = 'security_invoker'), 'false'),
               pg_get_viewdef(c.oid, true)
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'v'
         order by c.relname
    """, banco)
    partes = [CABECALHO.format(titulo=f"05 — VIEWS  ({len(vws)})")]
    partes.append(
        "-- TODA VIEW LEVA `security_invoker = true`, e isso não é zelo.\n"
        "--\n"
        "-- Sem ele a view roda com o privilégio de QUEM A CRIOU. O dono é\n"
        "-- `postgres`, que tem `bypassrls`: a view devolveria as linhas de todas as\n"
        "-- empresas para qualquer um que a consultasse. É o vazamento mais\n"
        "-- silencioso deste schema, porque a view continua funcionando — só que\n"
        "-- demais. `conferir-producao.sql` cobra isso de cada uma.\n\n")
    # Ordenação topológica estável: entre as que já podem ser criadas, a
    # alfabética decide. Sem o desempate a saída mudaria de uma execução para
    # outra e o portão de divergência acusaria mudança onde não houve nenhuma.
    depende: dict[str, set] = {nome: set() for nome, _i, _d in vws}
    for filha, mae in arestas:
        if filha in depende and mae in depende:
            depende[filha].add(mae)

    por_nome = {nome: (invoker, definicao) for nome, invoker, definicao in vws}
    prontas: list[str] = []
    restantes = set(depende)
    while restantes:
        livres = sorted(n for n in restantes if not (depende[n] - set(prontas)))
        if not livres:
            # Ciclo entre views: o PostgreSQL não permite criar um, então isto
            # só acontece se a consulta de arestas estiver errada. Falhar aqui é
            # melhor que emitir metade em silêncio.
            raise SystemExit("ciclo entre views: " + ", ".join(sorted(restantes)))
        prontas.extend(livres)
        restantes -= set(livres)

    for nome in prontas:
        invoker, definicao = por_nome[nome]
        opcao = " with (security_invoker = true)" if invoker == "true" else ""
        partes.append(f"\n-- {nome}\ncreate view public.{nome}{opcao} as\n{definicao}\n")
    return "".join(partes)


# As tabelas que as MIGRAÇÕES populam. Não é "as tabelas sem tenant_id": a
# lista é explícita porque publicar o conteúdo de uma tabela por engano é
# publicar dado, e a decisão de publicar dado não se toma por heurística.
CATALOGOS = [
    ("permission_catalog", "as chaves de permissão do sistema"),
    ("planos", "o catálogo comercial, lido até sem sessão"),
    ("ticket_status_transitions", "que estado de chamado vai para qual"),
    ("rental_contract_status_transitions", "idem, contratos de locação"),
    ("rental_equipment_status_transitions", "idem, equipamentos"),
    ("job_expectations", "o que cada trabalho agendado promete entregar"),
    # Fora de `public`, e por isso a lista guarda o esquema: o bucket de anexos
    # é criado pela migração 0019 e a conferência de produção o exige. Sem esta
    # linha o banco sobe e o primeiro anexo falha no upload.
    ("storage.buckets", "o bucket de anexos, privado"),
]


def gerar_dados(banco: str) -> str:
    partes = [CABECALHO.format(titulo="06 — DADOS INICIAIS")]
    partes.append(
        "-- SÓ CATÁLOGO, nenhum dado de empresa.\n"
        "--\n"
        "-- Estas linhas vêm das próprias migrações e são iguais para todas as\n"
        "-- empresas: as chaves de permissão, os planos, as transições de estado\n"
        "-- válidas. Um banco sem elas sobe e não funciona — some tela do menu de\n"
        "-- quem deveria vê-la, sem erro nenhum.\n"
        "--\n"
        "-- O que NÃO está aqui: a semente de desenvolvimento\n"
        "-- (`supabase/seed.sql`), com empresa, chamado e contrato inventados. Ela\n"
        "-- é de desenvolvimento e não roda em produção — `conferir-producao.sql`\n"
        "-- reprova o banco em que ela tiver rodado.\n\n")

    for alvo, porque in CATALOGOS:
        qualificado = alvo if "." in alvo else f"public.{alvo}"
        tabela = qualificado.split(".")[-1]
        # As colunas primeiro: a lista vem do catálogo, nunca escrita aqui, para
        # que uma coluna nova entre no `insert` sem ninguém lembrar dela.
        # COLUNA COM VALOR PADRÃO VOLÁTIL FICA DE FORA DO `insert`.
        #
        # `planos.id` é `gen_random_uuid()` e `created_at` é `now()`: os valores
        # mudam a cada execução das migrações. Gravá-los aqui tinha dois
        # defeitos, e o segundo é o grave:
        #
        #  · o arquivo mudava a cada geração, e o portão de divergência acusava
        #    mudança onde não houve nenhuma — ruído que ensina a ignorar o
        #    portão;
        #  · e o id ficaria PINADO. Quem rodasse as migrações e depois este
        #    arquivo teria os três planos duas vezes, com ids diferentes, e a
        #    página de preços mostraria seis.
        #
        # Deixando a coluna de fora, o default faz o mesmo que faz na migração.
        colunas = [c[0] for c in linhas(f"""
            select a.attname from pg_attribute a
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where a.attrelid = '{qualificado}'::regclass
               and a.attnum > 0 and not a.attisdropped
               and coalesce(pg_get_expr(d.adbin, d.adrelid), '')
                   !~* '(gen_random_uuid|uuid_generate|now\\(\\)|current_timestamp|clock_timestamp|nextval)'
             order by a.attnum
        """, banco)]

        # `quote_nullable` devolve o literal `NULL` sem aspas quando o valor é
        # nulo, e escapa a aspa simples quando não é. Montar isto com `||` em
        # Python daria o mesmo trabalho e erraria no primeiro nome com apóstrofo.
        expr = " || ', ' || ".join(
            f"coalesce(quote_nullable({c}::text), 'NULL')" for c in colunas)
        # `order by 1` deixa a saída determinística: sem ele a ordem é a do
        # heap, que muda a cada `vacuum`, e o portão de divergência acusaria
        # mudança onde não houve nenhuma.
        linhas_dados = [r[0] for r in linhas(
            f"select {expr} from {qualificado} order by 1", banco)]

        partes.append(
            f"\n-- {'-' * 74}\n-- {qualificado} — {porque} ({len(linhas_dados)} linhas)"
            f"\n-- {'-' * 74}\n")
        if not linhas_dados:
            partes.append(f"-- (a tabela {qualificado} nasce vazia)\n")
            continue
        partes.append(
            f"insert into {qualificado} ({', '.join(colunas)})\nvalues\n")
        partes.append(",\n".join(f"  ({l})" for l in linhas_dados) + ";\n")
    return "".join(partes)


def gerar_dicionario(banco: str) -> dict:
    cols = linhas("""
        select c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
               (not a.attnotnull)::text,
               coalesce(pg_get_expr(d.adbin, d.adrelid), ''),
               coalesce(col_description(c.oid, a.attnum), ''),
               coalesce((select 'pk' from pg_constraint k
                          where k.conrelid = c.oid and k.contype = 'p'
                            and a.attnum = any(k.conkey) limit 1), ''),
               -- TODAS as chaves estrangeiras de que a coluna participa, e
               -- não a primeira que aparecer.
               --
               -- `asset_attachments.tenant_id` está em duas: a simples para
               -- `tenants` e a COMPOSTA `(tenant_id, asset_id)` para
               -- `it_assets`, que é o que impede anexar o ativo de outra
               -- empresa. Um `limit 1` sem ordem escolhia uma ao acaso — o
               -- dicionário mudava entre duas construções do mesmo banco, e
               -- pior: escondia metade do relacionamento de quem fosse lê-lo.
               --
               -- `array_position` casa a coluna de cá com a de lá na mesma
               -- posição da chave; sem isso, a composta apontaria sempre para
               -- a primeira coluna do outro lado.
               coalesce((select string_agg(distinct tc.relname || '.' || att.attname,
                                           ' · ' order by tc.relname || '.' || att.attname)
                           from pg_constraint k
                           join pg_class tc on tc.oid = k.confrelid
                           join pg_attribute att
                             on att.attrelid = k.confrelid
                            and att.attnum = k.confkey[array_position(k.conkey, a.attnum)]
                          where k.conrelid = c.oid and k.contype = 'f'
                            and a.attnum = any(k.conkey)), '')
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
          left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
         where n.nspname = 'public' and c.relkind = 'r'
         order by c.relname, a.attnum
    """, banco)

    meta = linhas("""
        select c.relname,
               coalesce(obj_description(c.oid), ''),
               c.relrowsecurity::text, c.relforcerowsecurity::text,
               (select count(*) from pg_policy p where p.polrelid = c.oid)::text,
               (select count(*) from pg_index x where x.indrelid = c.oid)::text,
               (select count(*) from pg_trigger t
                 where t.tgrelid = c.oid and not t.tgisinternal)::text,
               (exists (select 1 from pg_attribute a
                         where a.attrelid = c.oid and a.attname = 'tenant_id'
                           and a.attnum > 0 and not a.attisdropped))::text
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
         order by c.relname
    """, banco)

    tabelas: dict[str, dict] = {}
    for (nome, comentario, rls, force, pols, idxs, tgs, tem_tenant) in meta:
        tabelas[nome] = {
            "nome": nome, "comentario": comentario,
            "rls": rls == "true", "force": force == "true",
            "policies": int(pols), "indices": int(idxs), "gatilhos": int(tgs),
            "multiempresa": tem_tenant == "true",
            "colunas": [],
        }
    for (t, nome, tipo, nulo, padrao, comentario, pk, fk) in cols:
        tabelas[t]["colunas"].append({
            "nome": nome, "tipo": tipo, "nulo": nulo == "true",
            "padrao": padrao, "comentario": comentario,
            "pk": pk == "pk", "fk": fk,
        })

    resumo = linhas("""
        select
          (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relkind='r')::text,
          (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relkind='v')::text,
          (select count(*) from information_schema.columns where table_schema='public')::text,
          (select count(*) from pg_constraint con join pg_class c on c.oid=con.conrelid
             join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and con.contype='f')::text,
          (select count(*) from pg_indexes where schemaname='public')::text,
          (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname in ('app','public') and p.prokind='f')::text,
          (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname in ('app','public') and p.prokind='p')::text,
          (select count(*) from pg_trigger where not tgisinternal)::text,
          (select count(*) from pg_policy)::text,
          (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname in ('app','public')
              and p.prosrc ~* 'for\\s+\\w+\\s+in\\s+select')::text
    """, banco)[0]

    return {
        "resumo": {
            "tabelas": int(resumo[0]), "views": int(resumo[1]), "colunas": int(resumo[2]),
            "chaves_estrangeiras": int(resumo[3]), "indices": int(resumo[4]),
            "funcoes": int(resumo[5]), "procedures": int(resumo[6]),
            "gatilhos": int(resumo[7]), "policies": int(resumo[8]),
            "cursores_implicitos": int(resumo[9]),
        },
        "tabelas": [tabelas[k] for k in sorted(tabelas)],
    }


ARQUIVOS = [
    ("00-esquemas-e-extensoes.sql", gerar_esquemas),
    ("01-tabelas-e-relacionamentos.sql", gerar_tabelas),
    ("02-indices.sql", gerar_indices),
    ("03-funcoes-e-gatilhos.sql", gerar_funcoes),
    ("04-rls-e-policies.sql", gerar_rls),
    ("05-views.sql", gerar_views),
    ("06-dados-iniciais.sql", gerar_dados),
]


def main() -> int:
    conferir = "--conferir" in sys.argv
    banco = os.environ["PGDATABASE"] if "--usar-banco" in sys.argv else preparar_banco()

    destino = Path(tempfile.mkdtemp(prefix="artefatos-")) if conferir else SAIDA
    destino.mkdir(parents=True, exist_ok=True)

    for nome, gerador in ARQUIVOS:
        (destino / nome).write_text(gerador(banco), encoding="utf-8")

    dic = gerar_dicionario(banco)
    alvo_dic = (destino / "dicionario.json") if conferir else DICIONARIO
    alvo_dic.write_text(json.dumps(dic, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    if not conferir:
        for nome, _ in ARQUIVOS:
            print(f"  {nome}  ({(SAIDA / nome).stat().st_size // 1024} KB)")
        print(f"  dicionario.json  ({DICIONARIO.stat().st_size // 1024} KB)")
        print(f"\n  {dic['resumo']['tabelas']} tabelas, "
              f"{dic['resumo']['chaves_estrangeiras']} chaves estrangeiras, "
              f"{dic['resumo']['funcoes']} funções, {dic['resumo']['policies']} policies.")
        return 0

    divergentes = []
    for nome, _ in ARQUIVOS:
        atual = SAIDA / nome
        if not atual.exists() or atual.read_text(encoding="utf-8") != (destino / nome).read_text(encoding="utf-8"):
            divergentes.append(nome)
    if not DICIONARIO.exists() or DICIONARIO.read_text(encoding="utf-8") != (destino / "dicionario.json").read_text(encoding="utf-8"):
        divergentes.append("demo/dicionario.json")

    if divergentes:
        print("DIVERGEM do schema: " + ", ".join(divergentes), file=sys.stderr)
        print("  Rode: python3 scripts/gerar-artefatos-do-banco.py", file=sys.stderr)
        return 1
    print(f"  artefatos do banco conferem com o schema ({len(ARQUIVOS) + 1} arquivos)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
