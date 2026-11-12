# 24. Produção numa VPS

Este documento é um **runbook**: ele não explica arquitetura, ele diz o que
digitar. A arquitetura está na [docs/03](03-arquitetura.md) e na
[docs/22](22-modo-local-sem-supabase.md); a decisão de ir para a VPS, na
[docs/23 §4](23-unificacao-lti-gsti.md).

Ele é escrito supondo que quem lê está com pressa, possivelmente de madrugada,
com alguém perguntando quanto falta. Por isso cada seção começa pelo comando e
só depois explica.

---

## 0. O que roda na VPS

Cinco contêineres, descritos em `compose.producao.yml`:

| Serviço | O que faz | Publica porta? |
|---|---|---|
| `caddy` | TLS automático e proxy reverso | **sim** — 80, 443 |
| `app` | a aplicação (Next.js) | não |
| `banco` | PostgreSQL | **não** |
| `migracoes` | aplica o que falta e termina | não |
| `agendador` | chama `/api/jobs/run` a cada 5 min | não |

A linha mais importante dessa tabela é a coluna da direita. **Só o Caddy fala
com a internet.** O banco não publica porta nenhuma: ele existe apenas para os
outros contêineres, e quem precisa de um `psql` de fora passa por um túnel SSH
(§7). Publicar 5432 numa VPS significa oferecer o PostgreSQL ao mundo e deixar
que a senha seja a única defesa.

Não há Supabase. O app usa o driver próprio sobre `pg` (docs/22), que aplica RLS
com `set local role` e `request.jwt.claims` exatamente como o PostgREST faria. O
que liga esse modo é a **ausência** de uma URL de Supabase de verdade — nunca
uma variável `MODO=local`, porque essa, esquecida ligada, faria a aplicação
falar com o banco errado em silêncio.

---

## 1. Subir pela primeira vez

### Antes de começar

O domínio precisa **já estar apontando para o IP da VPS**. A Let's Encrypt
confere o domínio fazendo uma requisição de volta; sem DNS isso falha, e há um
limite de tentativas por semana. Estourá-lo deixa o site sem HTTPS por dias.

```bash
# confira do seu computador, não da VPS
dig +short sti.suaempresa.com.br
```

### Os passos

```bash
git clone <repositório> sti && cd sti

cp .env.producao.example .env.producao
openssl rand -hex 32   # uma vez para cada segredo, valores DIFERENTES
nano .env.producao     # SITE_URL, POSTGRES_PASSWORD, LOCAL_AUTH_SECRET, JOBS_SECRET

docker compose -f compose.producao.yml --env-file .env.producao up -d --build
docker compose -f compose.producao.yml --env-file .env.producao logs -f caddy
```

O log do Caddy é o que vale acompanhar: é onde aparece o certificado sendo
emitido, e é onde o erro de DNS aparece com todas as letras.

### Primeiro acesso

O banco sobe **vazio**. O `seed.sql` é de desenvolvimento e não roda aqui — não
existe usuário de exemplo, e isso é deliberado: um sistema que nasce com
`admin/admin` nasce com uma porta aberta que ninguém lembra de fechar.

```bash
docker compose -f compose.producao.yml --env-file .env.producao run --rm \
  -e EMPRESA="Minha Empresa" \
  -e SLUG=minha-empresa \
  -e EMAIL=admin@minhaempresa.com.br \
  -e SENHA='uma-senha-longa-de-verdade' \
  -e ESFERAS=management,rental \
  migracoes bash /repo/scripts/primeiro-acesso.sh
```

`ESFERAS` decide **quais telas existem** para esta empresa:

- `management` — gestão de TI (chamados, inventário, projetos, orçamento)
- `rental` — locação (contratos, faturamento, medições, frota)
- `management,rental` — as duas

Dá para mudar depois na tela da empresa; é mais simples acertar agora.

O script **se recusa a rodar duas vezes**. Se já existe empresa, ele para sem
fazer nada — um segundo administrador criado por engano num banco em uso é
difícil de notar e fácil de esquecer de remover.

Depois de entrar, **troque a senha**. Ela passou pela linha de comando e está no
histórico do shell.

---

## 2. Atualizar

```bash
cd sti
git pull
docker compose -f compose.producao.yml --env-file .env.producao up -d --build
```

O serviço `migracoes` roda sozinho antes do app subir, e aplica **só o que
falta**. Ele mantém um livro-razão (`app.schema_migrations`) com a soma de
verificação de cada arquivo aplicado.

### Se a atualização parar dizendo que uma migração MUDOU

```
ERRO: a migração '0042_xxx.sql' já foi aplicada, mas o arquivo MUDOU.
```

Isto não é um defeito do script: é ele fazendo o trabalho dele. Alguém editou um
arquivo que já rodou em produção. O banco tem a versão antiga, o repositório tem
a nova, e os dois seguiriam divergentes em silêncio até uma migração futura
pressupor o que o arquivo editado dizia.

**O conserto é uma migração nova** com a mudança. Migração aplicada em produção é
história, e história não se edita.

### Voltar atrás

Não há `down migration`, de propósito: uma migração de volta que ninguém nunca
executou é tão confiável quanto um backup que ninguém nunca restaurou. O caminho
de volta é o backup (§4), e é por isso que ele é ensaiado a cada push (§6).

---

## 3. Backup

```bash
docker compose -f compose.producao.yml --env-file .env.producao exec banco \
  bash -c 'PGPASSWORD=$POSTGRES_PASSWORD pg_dump --format=custom --compress=6 \
    --no-owner --no-privileges -U postgres sti_iarx \
    --file=/backups/sti_iarx-$(date -u +%Y%m%dT%H%M%SZ).dump'
```

Ou, de dentro do repositório, `bash scripts/backup.sh` com as variáveis `PG*`
apontando para o banco.

Os arquivos caem em `BACKUP_DIR` (padrão `./backups`), que é um diretório do
**host** e não um volume do Docker. A diferença importa: um `docker compose down
-v` digitado com pressa apaga volumes, e o momento em que isso acontece é
exatamente o momento em que o backup importa.

### Isto ainda não é um backup

**Backup que mora no mesmo disco do banco é cópia, não backup.** Se a VPS
pegar fogo, as duas coisas vão juntas. Mande para fora — outro host, um bucket,
o que for:

```bash
# exemplo: para outro servidor, todo dia às 3h
0 3 * * * rsync -az /caminho/sti/backups/ backup@outro-host:/backups/sti/
```

O `backups/` está no `.gitignore` — um dump carrega os dados de **todos** os
tenants em claro, e é o último arquivo que pode entrar num repositório.

---

## 4. Restaurar

> **Este procedimento APAGA o banco.** É o ponto dele.

```bash
docker compose -f compose.producao.yml --env-file .env.producao stop app agendador

docker compose -f compose.producao.yml --env-file .env.producao exec banco \
  bash -c 'PGPASSWORD=$POSTGRES_PASSWORD psql -U postgres -d postgres \
    -c "select pg_terminate_backend(pid) from pg_stat_activity
         where datname = '"'"'sti_iarx'"'"' and pid <> pg_backend_pid();"
   PGPASSWORD=$POSTGRES_PASSWORD dropdb -U postgres --if-exists sti_iarx
   PGPASSWORD=$POSTGRES_PASSWORD createdb -U postgres sti_iarx
   PGPASSWORD=$POSTGRES_PASSWORD pg_restore -U postgres -d sti_iarx \
     --no-owner --no-privileges --exit-on-error /backups/ARQUIVO.dump'

docker compose -f compose.producao.yml --env-file .env.producao start app agendador
```

Três detalhes que não são estilo:

1. **Parar o `app` e o `agendador` antes.** Sem isso o `dropdb` falha com "está
   sendo acessado por outros usuários", e a mensagem não diz que o culpado é a
   própria aplicação.
2. **`--exit-on-error`.** O padrão do `pg_restore` é avisar e seguir, terminando
   com código zero sobre um banco pela metade. Num restore, meio certo é errado.
3. **Conferir as contagens depois.** `scripts/restaurar.sh` faz os três passos e
   a conferência; use-o quando puder rodar de dentro do repositório.

Fora da VPS, com o repositório à mão:

```bash
bash scripts/restaurar.sh backups/sti_iarx-20260312T030000Z.dump sti_iarx
```

Ele pede o nome do banco digitado por extenso antes de apagar. A confirmação não
protege contra má intenção — protege contra o dedo rápido de quem está num dia
ruim.

---

## 5. Girar um segredo

| Segredo | Efeito de girar | Como |
|---|---|---|
| `LOCAL_AUTH_SECRET` | **desloga todo mundo** na hora | edite `.env.producao`, `up -d app` |
| `JOBS_SECRET` | o agendador precisa do novo valor | edite, `up -d app agendador` |
| `POSTGRES_PASSWORD` | ver abaixo | `ALTER ROLE` **e** o arquivo |
| `RESEND_API_KEY` | e-mails na fila saem com a nova | edite, `up -d app` |

Deslogar todo mundo de uma vez é justamente o que se quer fazer num incidente —
é o botão de "expulsar todas as sessões", e ele é uma variável de ambiente.

A senha do banco é a única que exige dois passos, nesta ordem:

```bash
docker compose -f compose.producao.yml --env-file .env.producao exec banco \
  psql -U postgres -c "alter role postgres with password 'NOVA';"
nano .env.producao   # POSTGRES_PASSWORD=NOVA
docker compose -f compose.producao.yml --env-file .env.producao up -d
```

Inverter a ordem derruba o app: ele tentaria conectar com a senha nova antes de
ela existir.

---

## 6. Saber que algo parou

### O alerta automático

Configure `ALERTA_OPERACAO_EMAIL` e/ou `ALERTA_OPERACAO_WEBHOOK`. O aviso sai
**uma vez por episódio** — a quebra e, depois, a volta. Um trabalho que falha de
cinco em cinco minutos mandaria 288 e-mails por dia, e no segundo dia ninguém
leria nenhum.

Ele distingue duas coisas diferentes:

- **falhou** — houve execução e ela terminou com erro; a mensagem do banco vai
  no aviso;
- **parou** — não houve execução nenhuma dentro da cadência esperada. É a falha
  mais perigosa, porque é silenciosa: nada acontece, nada reclama.

A cadência de cada trabalho fica em `job_expectations`, no banco. Se mudar
`JOBS_INTERVALO_SEG` para muito mais que 300 s, ajuste as tolerâncias junto —
senão o alerta toca à toa, e alerta que toca à toa deixa de ser lido.

### O limite deste alerta, dito antes de alguém descobrir sozinho

O alerta é disparado **pela própria rota de trabalhos agendados**. Se o agendador
morrer por inteiro, ninguém chama a rota e **nenhum aviso sai** — o vigia dorme
junto com o vigiado.

Por isso aponte um monitor de disponibilidade externo (UptimeRobot, Better
Stack, o que preferir) para:

```
https://sti.suaempresa.com.br/api/health
```

Esse endpoint não depende do agendador. Os dois juntos cobrem os dois casos: o
alerta vê um trabalho parar enquanto os outros rodam; o monitor externo vê tudo
parar de uma vez.

### A tela

`/auditoria/trabalhos` mostra a situação de cada trabalho, a tolerância de cada
um, os episódios abertos e **se o aviso de fato saiu**. Um episódio aberto com
"não enviado" é um problema que ninguém recebeu.

### O que o CI já prova a cada push

- migrações num banco limpo, do zero, com as asserções de RLS;
- as migrações pelo caminho de **produção**, duas vezes — a segunda não pode
  aplicar nada;
- o **ensaio de restauração**: backup, sujar o banco, restaurar por cima e
  conferir que as contagens batem, que o que foi criado depois do backup sumiu e
  que as policies de RLS voltaram;
- que nenhuma variável com cara de segredo está indo para o navegador.

Backup que nunca foi restaurado é esperança, não backup — e o único lugar que
não esquece de ensaiar é o CI.

---

## 7. Abrir um `psql` na VPS

O banco não publica porta — nem para a internet, nem para o host. Então não há
túnel a fazer: o caminho é entrar no contêiner, por SSH.

```bash
ssh usuario@vps
cd sti
docker compose -f compose.producao.yml --env-file .env.producao exec banco \
  psql -U postgres -d sti_iarx
```

Para usar uma ferramenta gráfica do seu computador (DBeaver, pgAdmin), publique
a porta **temporariamente, só no localhost da VPS**, e faça um túnel até ela:

```bash
# na VPS, em primeiro plano, e encerre com Ctrl-C quando terminar
docker compose -f compose.producao.yml --env-file .env.producao \
  run --rm --publish 127.0.0.1:5433:5432 banco

# no seu computador
ssh -L 5433:127.0.0.1:5433 usuario@vps
```

`127.0.0.1:5433:5432` e não `5433:5432`: sem o endereço na frente, o Docker
publica em **todas** as interfaces e abre o PostgreSQL para a internet — que é
precisamente o que o compose evita o tempo todo. Com ele, a porta só existe para
quem já está dentro da VPS, e o túnel SSH é o que leva você até lá.

---

## 8. Quando o site não abre

Na ordem, porque esta ordem resolve do mais comum para o mais raro:

```bash
docker compose -f compose.producao.yml --env-file .env.producao ps
```

| O que você vê | O que é | O que fazer |
|---|---|---|
| `app` unhealthy | não alcança o banco | veja `logs banco`; o `DATABASE_URL` casa com `POSTGRES_PASSWORD`? |
| `migracoes` com código ≠ 0 | migração falhou | `logs migracoes` — o erro do psql está lá |
| `caddy` reiniciando | certificado | `logs caddy`; o DNS aponta para este IP? |
| tudo de pé, 502 | o app caiu depois de subir | `logs app` |
| tudo de pé, site certo | DNS ou cache | `dig` de fora da VPS |

E o caso que não aparece em `ps`: **disco cheio**. Ele derruba o PostgreSQL com
erros que parecem de corrupção.

```bash
df -h
docker system prune -a      # imagens antigas das atualizações
```

Os logs do Caddy já rotacionam (50 MiB, 10 arquivos, 30 dias) — foi configurado
para que o log de acesso não fosse o que enchesse o disco.
