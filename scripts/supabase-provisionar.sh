#!/usr/bin/env bash
# =============================================================================
# PROVISIONAR O BANCO NO SUPABASE, do zero ao primeiro login.
#
# O que este script faz, em ordem:
#
#   1. pré-voo    — recusa rodar contra um alvo que não serve, e DIZ qual é
#   2. extensões  — `pgcrypto` e `unaccent`, que as migrações exigem
#   3. migrações  — delega ao `migrar.sh`, que já tem o livro-razão
#   4. conferência— `conferir-producao.sql`, somente leitura
#   5. primeiro acesso — a empresa e o administrador (opcional)
#   6. a lista de variáveis que a aplicação vai pedir na VPS
#
# POR QUE ELE NÃO REESCREVE O `migrar.sh`
# ---------------------------------------
# O livro-razão com soma de verificação, a transação por migração e a recusa
# quando um arquivo já aplicado MUDA são trabalho feito e testado. Copiá-los
# para cá criaria duas verdades sobre quais migrações já rodaram, e elas
# divergiriam na primeira correção de uma só. Este script é o pré-voo, a
# conferência e o primeiro acesso — o miolo continua lá.
#
# O QUE MUDA ENTRE SUPABASE E VPS COM POSTGRES PURO
# -------------------------------------------------
# No Supabase já existem o esquema `auth`, o `storage`, os papéis `anon`,
# `authenticated` e `service_role`, e o GoTrue cuidando de senha. Numa VPS com
# PostgreSQL puro nada disso existe, e quem supre é `scripts/supabase-shim.sql`
# — aplicado automaticamente pelo `migrar.sh`. O pré-voo aqui DISTINGUE os dois
# casos e manda para o caminho certo, em vez de deixar a migração falhar no
# meio com uma mensagem sobre papel inexistente.
#
# Uso:
#   # ensaio: confere tudo e não escreve nada
#   DATABASE_URL='postgresql://...:5432/postgres' \
#     bash scripts/supabase-provisionar.sh --ensaio
#
#   # de verdade, já criando a primeira empresa
#   DATABASE_URL='postgresql://...:5432/postgres' \
#   SUPABASE_URL='https://xxxx.supabase.co' \
#   SUPABASE_SERVICE_ROLE_KEY='...' \
#   EMPRESA='Minha Empresa' SLUG=minha-empresa \
#   EMAIL=admin@minhaempresa.com.br SENHA='...' ESFERAS=management \
#     bash scripts/supabase-provisionar.sh
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENSAIO=0
[ "${1:-}" = '--ensaio' ] && ENSAIO=1

vermelho() { printf '\n\033[1mABORTOU\033[0m — %s\n\n' "$1" >&2; }
titulo()   { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()       { printf '  ok  %s\n' "$1"; }

# -----------------------------------------------------------------------------
titulo '1. Pré-voo'
# -----------------------------------------------------------------------------

# A CONEXÃO.
#
# O Supabase entrega uma URI pronta; o `psql` e o `migrar.sh` falam PG*. Em vez
# de pedir as duas coisas, aceita-se a URI e ela é desmontada aqui — uma fonte
# só, e nenhum risco de PGHOST apontar para um servidor e DATABASE_URL para
# outro, que é o erro que faz "a migração rodou mas o sistema não vê".
if [ -n "${DATABASE_URL:-}" ]; then
  eval "$(python3 - "$DATABASE_URL" <<'PY'
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1])
def q(v): return "'" + str(v).replace("'", "'\\''") + "'"
print(f"export PGHOST={q(p.hostname or '')}")
print(f"export PGPORT={q(p.port or 5432)}")
print(f"export PGUSER={q(u.unquote(p.username or ''))}")
print(f"export PGPASSWORD={q(u.unquote(p.password or ''))}")
print(f"export PGDATABASE={q((p.path or '/postgres').lstrip('/') or 'postgres')}")
PY
)"
fi

PGHOST="${PGHOST:-}"; PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"; PGDATABASE="${PGDATABASE:-postgres}"
export PGHOST PGPORT PGUSER PGDATABASE

if [ -z "$PGHOST" ]; then
  vermelho "sem conexão: passe DATABASE_URL (ou PGHOST/PGPORT/PGUSER/PGPASSWORD).
  No painel do Supabase: Project Settings › Database › Connection string › URI.
  Use a conexão DIRETA (porta 5432), não a do pooler."
  exit 2
fi

# A PORTA 6543 É O POOLER EM MODO TRANSAÇÃO, E ELE NÃO SERVE PARA MIGRAR.
#
# Nesse modo cada comando pode cair numa conexão diferente: `--single-transaction`
# deixa de envolver a migração inteira, `set local` não sobrevive ao comando
# seguinte e advisory lock não segura nada. O resultado não é um erro limpo — é
# metade da migração aplicada, que é o pior estado possível.
if [ "$PGPORT" = '6543' ]; then
  vermelho "a porta 6543 é o pooler em modo transação, e migração não roda nele.
  Cada comando pode cair numa conexão diferente: a transação por migração deixa
  de existir e um erro no meio deixa metade aplicada.

  Use a conexão direta, porta 5432 (Project Settings › Database › Connection
  string › URI, opção \"Direct connection\")."
  exit 2
fi

psql_q() { psql -At --no-psqlrc -v ON_ERROR_STOP=1 "$@"; }

if ! psql_q -c 'select 1' > /dev/null 2>&1; then
  vermelho "não consegui conectar em ${PGHOST}:${PGPORT}/${PGDATABASE} como ${PGUSER}.
  Confira a senha (PGPASSWORD) e se o seu IP está liberado em
  Project Settings › Database › Network restrictions."
  exit 2
fi
ok "conectado em ${PGHOST}:${PGPORT}/${PGDATABASE}"

# É SUPABASE MESMO?
#
# Esta pergunta existe porque as duas respostas levam a caminhos diferentes, e
# descobrir isso no meio da migração custa um banco pela metade.
tem_auth="$(psql_q -c "select 1 from information_schema.tables
                        where table_schema='auth' and table_name='users'" || true)"
tem_papeis="$(psql_q -c "select count(*) from pg_roles
                          where rolname in ('anon','authenticated','service_role')")"

if [ "${tem_auth:-}" != '1' ] || [ "${tem_papeis:-0}" != '3' ]; then
  vermelho "este banco não parece ser do Supabase: falta \`auth.users\` ou algum dos
  papéis anon/authenticated/service_role.

  Se é um PostgreSQL puro numa VPS, o caminho é outro e ele existe:

      PGHOST=... PGDATABASE=sti_iarx bash scripts/migrar.sh

  Ele aplica \`scripts/supabase-shim.sql\` antes das migrações, que é o que cria
  esses papéis e esquemas. Este script aqui é só para o Supabase."
  exit 2
fi
ok 'é um banco do Supabase (auth.users e os três papéis existem)'

# O BANCO ESTÁ VAZIO, OU JÁ É NOSSO?
#
# O caso que isto impede: apontar para o banco de OUTRA aplicação e aplicar 64
# migrações dentro dele. Não há desfazer. Se há tabelas em `public` e nenhuma
# linha no livro-razão, este banco é de outra coisa.
tem_razao="$(psql_q -c "select 1 from information_schema.tables
                         where table_schema='app' and table_name='schema_migrations'" || true)"
n_tabelas="$(psql_q -c "select count(*) from pg_class c
                         join pg_namespace n on n.oid=c.relnamespace
                        where n.nspname='public' and c.relkind='r'")"

if [ "${tem_razao:-}" != '1' ] && [ "${n_tabelas:-0}" -gt 0 ]; then
  vermelho "há ${n_tabelas} tabela(s) em \`public\` e nenhum livro-razão de migração.
  Este banco é de outra aplicação, ou de uma instalação feita por fora.

  Aplicar as 64 migrações aqui misturaria dois sistemas no mesmo schema, e não
  há desfazer. Use um projeto Supabase novo, ou um banco vazio."
  exit 2
fi
[ "${n_tabelas:-0}" -gt 0 ] \
  && ok "banco já provisionado (${n_tabelas} tabelas) — só o que falta será aplicado" \
  || ok 'banco vazio, pronto para receber o schema'

NO_DISCO="$(ls "$ROOT"/supabase/migrations/*.sql | wc -l | tr -d ' ')"
APLICADAS=0
[ "${tem_razao:-}" = '1' ] && APLICADAS="$(psql_q -c 'select count(*) from app.schema_migrations')"
ok "${APLICADAS} de ${NO_DISCO} migrações já aplicadas"

if [ "$ENSAIO" = '1' ]; then
  printf '\n\033[1mENSAIO\033[0m — nada foi escrito.\n'
  printf '  Aplicaria %s migração(ões).\n' "$(( NO_DISCO - APLICADAS ))"
  printf '  Rode de novo sem --ensaio para valer.\n\n'
  exit 0
fi

# -----------------------------------------------------------------------------
titulo '2. Extensões'
# -----------------------------------------------------------------------------
# `pgcrypto` gera uuid e hash de senha; `unaccent` é o que faz a busca achar
# "manutencao" quando a pessoa digita "manutenção". As duas vêm disponíveis no
# Supabase e só precisam ser criadas. No Supabase elas moram em `extensions`,
# que já está no `search_path` dos papéis.
psql -q --no-psqlrc -v ON_ERROR_STOP=1 <<'SQL'
create extension if not exists pgcrypto;
create extension if not exists unaccent;
SQL
ok 'pgcrypto e unaccent disponíveis'

# -----------------------------------------------------------------------------
titulo '3. Migrações'
# -----------------------------------------------------------------------------
bash "$ROOT/scripts/migrar.sh"

# -----------------------------------------------------------------------------
titulo '4. Conferência (somente leitura)'
# -----------------------------------------------------------------------------
psql -q --no-psqlrc -v ON_ERROR_STOP=1 \
  -v migracoes="$NO_DISCO" \
  -f "$ROOT/supabase/tests/conferir-producao.sql"

# -----------------------------------------------------------------------------
titulo '5. Primeiro acesso'
# -----------------------------------------------------------------------------
# NO SUPABASE, O USUÁRIO NASCE PELA API DO GOTRUE — NÃO POR `insert`.
#
# `scripts/primeiro-acesso.sh` escreve direto em `auth.users`, e está certo
# para a VPS com o shim, onde não há GoTrue. Aqui há: ele guarda invariantes
# próprios (`aud`, `role`, confirmação de e-mail, o bloco de provedores em
# `app_metadata`) que um `insert` à mão não preenche. O usuário fica no banco,
# parece existir, e o login responde "Invalid login credentials" — sem nada que
# aponte para a causa.
#
# A aplicação cria os usuários seguintes por `auth.admin.createUser`. O
# primeiro nasce pelo mesmo caminho, para que não haja um usuário diferente de
# todos os outros logo no primeiro dia.
if [ -z "${EMPRESA:-}" ] && [ -z "${EMAIL:-}" ]; then
  ok 'pulado (passe EMPRESA, SLUG, EMAIL e SENHA para criar a primeira empresa)'
else
  faltou=0
  for v in EMPRESA SLUG EMAIL SENHA SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
    if [ -z "${!v:-}" ]; then echo "  falta ${v}" >&2; faltou=1; fi
  done
  if [ "$faltou" = '1' ]; then
    vermelho 'faltam variáveis para o primeiro acesso (veja a lista acima).'
    exit 2
  fi
  if [ "${#SENHA}" -lt 12 ]; then
    vermelho "a senha tem ${#SENHA} caracteres. Esta é a conta de administrador de um
  sistema multiempresa exposto à internet: use 12 ou mais."
    exit 2
  fi

  ja="$(psql_q -c 'select count(*) from public.tenants')"
  if [ "${ja:-0}" != '0' ]; then
    vermelho "este banco já tem ${ja} empresa(s). Nada foi criado.
  Para mais usuários, use a tela /usuarios do próprio sistema."
    exit 3
  fi

  TENANT="$(psql_q -c 'select gen_random_uuid()')"

  # A empresa primeiro: o `tenant_id` precisa existir antes de ser carimbado no
  # `app_metadata` do usuário.
  psql -q --no-psqlrc -v ON_ERROR_STOP=1 \
    -v empresa="$EMPRESA" -v slug="$SLUG" -v esferas="${ESFERAS:-management}" -v tid="$TENANT" <<'SQL'
insert into public.tenants (id, name, slug, spheres)
values (:'tid', :'empresa', :'slug', string_to_array(:'esferas', ','));
SQL
  ok "empresa criada: ${EMPRESA}"

  # O usuário, pela API. O corpo vai montado em Python para que senha e e-mail
  # nunca passem por interpolação de shell — e a chave de serviço vai por
  # variável de ambiente, nunca na linha de comando, que é legível por qualquer
  # processo da máquina via /proc.
  USER_ID="$(SUPA_TENANT="$TENANT" python3 - <<'PY'
import json, os, sys, urllib.request, urllib.error

base = os.environ['SUPABASE_URL'].rstrip('/')
corpo = json.dumps({
    'email': os.environ['EMAIL'],
    'password': os.environ['SENHA'],
    # Confirmado na criação: sem isto o GoTrue exige a confirmação por e-mail
    # ANTES do primeiro login, e o primeiro login é justamente o que o
    # administrador precisa fazer para configurar o envio de e-mail.
    'email_confirm': True,
    # O claim vai em app_metadata (ADR-002). Em user_metadata ele seria
    # EDITÁVEL pelo próprio usuário — cada pessoa escolheria de qual empresa é,
    # e o isolamento entre empresas deixaria de existir.
    'app_metadata': {'tenant_id': os.environ['SUPA_TENANT']},
}).encode()

req = urllib.request.Request(
    base + '/auth/v1/admin/users', data=corpo, method='POST',
    headers={
        'apikey': os.environ['SUPABASE_SERVICE_ROLE_KEY'],
        'Authorization': 'Bearer ' + os.environ['SUPABASE_SERVICE_ROLE_KEY'],
        'Content-Type': 'application/json',
    })
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print(json.load(r)['id'])
except urllib.error.HTTPError as e:
    # O corpo do erro do GoTrue diz a causa (senha fraca, e-mail já existe,
    # chave errada). Repassá-lo é a diferença entre "deu 422" e saber o quê.
    sys.stderr.write('GoTrue %s: %s\n' % (e.code, e.read().decode('utf-8', 'replace')[:400]))
    sys.exit(1)
PY
)"

  # O perfil, que é o vínculo entre a conta e a empresa. Sem ele a pessoa entra
  # e a sessão é recusada com "conta sem empresa" — que é uma mensagem certa
  # para um estado que não deveria existir.
  psql -q --no-psqlrc -v ON_ERROR_STOP=1 \
    -v uid="$USER_ID" -v tid="$TENANT" -v email="$EMAIL" <<'SQL'
insert into public.profiles (id, tenant_id, role, full_name, email)
values (:'uid', :'tid', 'admin', :'email', :'email');
SQL
  ok "administrador criado: ${EMAIL}"
fi

# -----------------------------------------------------------------------------
titulo '6. O que a aplicação vai pedir na VPS'
# -----------------------------------------------------------------------------
# Só os NOMES. Nenhum valor é impresso: este terminal costuma estar sendo
# gravado, e a chave de serviço ignora o RLS inteiro — quem a tem lê e escreve
# em todas as empresas.
cat <<'FIM'
  Obrigatórias:
    NEXT_PUBLIC_SUPABASE_URL          https://<ref>.supabase.co
    NEXT_PUBLIC_SUPABASE_ANON_KEY     pública por desenho — vai para o navegador
    SUPABASE_SERVICE_ROLE_KEY         NUNCA com o prefixo NEXT_PUBLIC_
    NEXT_PUBLIC_SITE_URL              https://sti.iarx.com.br

  E-mail (sem isto, convite e recuperação de senha não saem):
    MAIL_FROM          e SMTP_HOST / SMTP_PORT / SMTP_USUARIO / SMTP_SENHA
                       ou RESEND_API_KEY

  Opcionais:
    GOOGLE_MAPS_SERVER_KEY, NEXT_PUBLIC_GOOGLE_MAPS_API_KEY   mapa das filiais
    JOBS_SECRET                                               trabalhos agendados

  O prefixo NEXT_PUBLIC_ publica o valor no pacote que vai para o navegador.
  Em SUPABASE_SERVICE_ROLE_KEY ele apagaria o isolamento entre empresas de uma
  vez só, em silêncio, para sempre — a chave ignora toda policy de RLS.

  Resto do caminho (TLS, firewall, DNS, backup): docs/26-publicar-na-hostinger.md
FIM

printf '\n\033[1mBANCO PRONTO\033[0m\n\n'
