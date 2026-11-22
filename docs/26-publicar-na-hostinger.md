# 26. Publicar numa VPS da Hostinger

A [docs/24](24-producao-na-vps.md) é o runbook **genérico** de produção: o que
roda, como atualizar, como restaurar, como girar segredo. Ela supõe uma máquina
com Docker instalado e a rede já resolvida.

Este documento cobre o que ela supõe. É específico da Hostinger, e vale para
qualquer VPS Linux com pouca adaptação.

Ele é escrito para ser seguido **de cima para baixo, na primeira vez**, e cada
seção diz o que conferir antes de passar para a próxima — porque o erro caro
aqui não é o comando que falha, é o que parece ter dado certo.

---

## 0. Qual VPS, e por quê — isto é medido

O build do Next é o passo mais pesado, e ele roda **na VPS** a cada
atualização (`up -d --build`).

Medido nesta base, numa máquina de 4 núcleos:

| o que | quanto |
| --- | --- |
| pico de memória durante `npm run build` | **~2,1 GB** acima da linha de base |
| tempo de compilação | ~12 s (sem contar `npm ci`) |
| tamanho do `.next` | 172 MB |
| imagem de produção pronta | ~455 MB |

Disso sai a recomendação, e ela não é "quanto mais melhor":

- **1 GB de RAM não serve.** O build morre com o processo do Node sendo
  encerrado pelo sistema (`Killed`), e a mensagem não diz "faltou memória" — diz
  que o build falhou. Horas se perdem procurando o erro no lugar errado.
- **2 GB serve com swap** (§3). O build fica lento, e funciona.
- **4 GB é o confortável**, e é o tamanho em que o PostgreSQL, o app e o build
  convivem sem disputa.

Disco: **20 GB é o mínimo prático**. O banco é pequeno no começo; quem come
espaço são as imagens antigas do Docker a cada atualização (§8).

> **Alternativa, se a VPS for pequena:** construir a imagem noutro lugar e
> publicá-la num registry. Fica fora deste runbook de propósito — é mais uma
> peça para manter, e a recomendação aqui é subir a VPS para 4 GB, que custa
> menos que o tempo de montar um pipeline.

Sistema: **Ubuntu 24.04 LTS**. É o que a Hostinger oferece pronto e o que os
comandos abaixo supõem.

---

## 1. Primeiro acesso à máquina

No painel da Hostinger (VPS → Gerenciar), anote o **IP** e a **senha de root**.

```bash
ssh root@SEU_IP
```

### Um usuário que não é o root

Trabalhar como root o tempo todo é como usar o `service_role` para tudo: dá
certo até o dia em que um comando errado não tem nada o impedindo.

```bash
adduser sti                      # vai pedir uma senha
usermod -aG sudo sti
rsync --archive --chown=sti:sti ~/.ssh /home/sti    # leva a sua chave junto
```

Saia, entre como `sti` e **confirme que funciona antes de fechar a porta do
root**:

```bash
ssh sti@SEU_IP
sudo echo funciona
```

### Fechar a senha e o root no SSH

Só depois de confirmar que a chave do `sti` entra:

```bash
sudo nano /etc/ssh/sshd_config
# PermitRootLogin no
# PasswordAuthentication no
sudo systemctl restart ssh
```

> **Confira numa segunda janela antes de encerrar a primeira.** Se errar o
> arquivo e fechar a única sessão aberta, a máquina deixa de aceitar você — e a
> saída é o console de recuperação do painel, que é lento e nervoso.

---

## 2. Firewall — e a armadilha que o Docker prepara

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

### O que o UFW NÃO protege

**O Docker escreve as próprias regras de iptables, numa cadeia que o UFW não
governa.** Uma porta publicada com `ports: ["5432:5432"]` fica acessível da
internet **mesmo com o UFW negando tudo** — e `ufw status` continua dizendo que
está tudo fechado.

Isto não é bug: é a ordem em que as cadeias são avaliadas. E é a razão de o
`compose.producao.yml` desta base publicar porta **só no Caddy**, e de o banco
não publicar nenhuma.

Quando precisar de um `psql` de fora (docs/24 §7), publique **com o endereço na
frente**:

```bash
--publish 127.0.0.1:5433:5432      # certo: só quem já está dentro alcança
--publish 5433:5432                # ERRADO: abre o PostgreSQL para a internet
```

Confira de **fora** da VPS, que é o único teste que vale:

```bash
# do seu computador
nmap -Pn -p 22,80,443,5432,5433 SEU_IP
```

Só 22, 80 e 443 devem responder.

---

## 3. Swap — o seguro do build

Se a VPS tiver 2 GB, isto não é opcional. Com 4 GB, continua sendo barato.

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# o kernel só recorre ao swap quando precisa de verdade
sudo sysctl vm.swappiness=10
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.d/99-swap.conf

free -h    # a linha "Swap" tem de aparecer com 4,0Gi
```

Swap não deixa o build rápido: deixa o build **terminar**. A diferença entre
lento e morto é toda.

---

## 4. Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker sti
newgrp docker          # ou saia e entre de novo

docker --version && docker compose version
```

O script oficial instala o Engine e o plugin `compose`. **Não use
`apt install docker.io`**: ele traz uma versão antiga, sem `docker compose`, e
o `docker-compose` separado (com hífen) está descontinuado.

### Limitar o log, antes que ele encha o disco

Por padrão o Docker guarda o log de cada contêiner **sem limite**. Numa VPS de
20 GB, isso é um incidente marcado para daqui a alguns meses.

```bash
sudo tee /etc/docker/daemon.json > /dev/null <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
sudo systemctl restart docker
```

---

## 5. DNS no painel da Hostinger

O sistema mora em **`sti.iarx.com.br`**, não no apex — a razão está na
[docs/24 §1](24-producao-na-vps.md).

No painel: **Domínios → iarx.com.br → DNS / Nameservers → Gerenciar registros**.

| Tipo | Nome | Aponta para | TTL |
| --- | --- | --- | --- |
| `A` | `sti` | *(o IP da VPS)* | 300 |

Nome `sti`, e não `sti.iarx.com.br`: o painel completa o domínio sozinho, e
quem digita o nome inteiro acaba com `sti.iarx.com.br.iarx.com.br`.

TTL 300 **no começo**, de propósito: IP errado se conserta em cinco minutos em
vez de um dia. Suba para 3600 depois que estiver de pé.

**Confira do seu computador, não da VPS** — ela pode ter cache próprio:

```bash
dig +short sti.iarx.com.br
```

Tem de responder o IP da VPS, e mais nada.

> **Espere a propagação ANTES de subir.** A Let's Encrypt confere o domínio
> fazendo uma requisição de volta; sem DNS, ela falha — e o limite é de
> **5 falhas por hora** por domínio. Estourado, o site fica sem HTTPS até a
> janela liberar.

---

## 6. E-mail pela própria Hostinger

Se você tem hospedagem de e-mail lá (Titan ou o plano de e-mail da Hostinger),
**não precisa de serviço nenhum a mais**. Sem e-mail, confirmação de cadastro,
convite e redefinição de senha não saem — e a entrada pública não funciona.

Crie uma caixa que só manda, por exemplo `nao-responda@iarx.com.br`, e anote:

| variável | valor na Hostinger |
| --- | --- |
| `SMTP_HOST` | `smtp.hostinger.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USUARIO` | o endereço **completo** (`nao-responda@iarx.com.br`) |
| `SMTP_SENHA` | a senha da caixa |
| `MAIL_FROM` | `STI <nao-responda@iarx.com.br>` |

**A porta decide o modo**, e trocá-la é o tropeço mais comum: 465 é TLS desde o
primeiro byte; 587 começa em claro e sobe com STARTTLS. Errar dá
`wrong version number` ou uma espera sem mensagem nenhuma.

`MAIL_FROM` tem de ser **a mesma caixa autenticada**. Servidor SMTP recusa
remetente que não é dele, e a recusa aparece só no primeiro envio.

### SPF e DKIM, para a mensagem não cair em spam

A Hostinger já cria os dois quando o e-mail é hospedado lá. Confira que existem:

```bash
dig +short TXT iarx.com.br | grep spf
dig +short TXT hostingermail._domainkey.iarx.com.br
```

Sem SPF, o Gmail e o Outlook marcam como spam — e um link de redefinição de
senha na caixa de spam é um link que não existe.

---

## 7. Subir

A partir daqui, a [docs/24 §1](24-producao-na-vps.md) vale integralmente. O
resumo, com o que é da Hostinger:

```bash
ssh sti@SEU_IP
git clone <repositório> sti && cd sti

cp .env.producao.example .env.producao
openssl rand -hex 32    # uma vez para CADA segredo, valores diferentes
nano .env.producao
```

Preencha: `SITE_URL`, `POSTGRES_PASSWORD`, `LOCAL_AUTH_SECRET`, `JOBS_SECRET`,
e o bloco de SMTP da §6.

```bash
docker compose -f compose.producao.yml --env-file .env.producao up -d --build
docker compose -f compose.producao.yml --env-file .env.producao logs -f caddy
```

O log do Caddy é o que vale acompanhar: é onde o certificado aparece sendo
emitido, e onde o erro de DNS aparece com todas as letras.

### O primeiro administrador

O banco sobe **vazio**, de propósito: um sistema que nasce com `admin/admin`
nasce com uma porta que ninguém lembra de fechar.

```bash
docker compose -f compose.producao.yml --env-file .env.producao run --rm \
  -e EMPRESA="IAR Office" \
  -e SLUG=iarx \
  -e EMAIL=admin@iarx.com.br \
  -e SENHA='uma-senha-longa-de-verdade' \
  -e ESFERAS=management,rental \
  migracoes bash /repo/scripts/primeiro-acesso.sh
```

**Troque a senha depois de entrar.** Ela passou pela linha de comando e está no
histórico do shell.

---

## 7b. A outra arquitetura: banco no Supabase, aplicação na VPS

A §7 sobe **tudo** na VPS: a aplicação e um PostgreSQL próprio, no mesmo
`compose`. Funciona, é mais barato e o backup é problema seu.

A alternativa é deixar o banco no **Supabase** e só a aplicação na VPS. O que
muda de verdade:

| | PostgreSQL na VPS (§7) | Supabase |
| --- | --- | --- |
| senha de usuário | `LOCAL_AUTH_SECRET`, no próprio banco | GoTrue, do Supabase |
| backup | `scripts/backup.sh` + envio para fora | do provedor, com restauração por data |
| anexos | pasta no disco (`LOCAL_STORAGE_DIR`) | Storage do Supabase |
| o que a VPS precisa | 4 GB e disco para o banco | só a aplicação |
| custo | uma VPS | uma VPS + o plano do Supabase |

**Não dá para misturar.** Com `DATABASE_URL` apontando para um PostgreSQL e
`NEXT_PUBLIC_SUPABASE_URL` preenchido ao mesmo tempo, a aplicação escolhe o
Supabase e o outro banco fica parado, com dado dentro — que é o pior desfecho,
porque ninguém repara até alguém procurar um registro antigo.

### Provisionar

Um script só, do banco vazio ao primeiro login:

```bash
# ensaio primeiro: confere tudo e não escreve nada
DATABASE_URL='postgresql://postgres.<ref>:<senha>@<host>:5432/postgres' \
  bash scripts/supabase-provisionar.sh --ensaio

# de verdade, já criando a primeira empresa
DATABASE_URL='postgresql://postgres.<ref>:<senha>@<host>:5432/postgres' \
SUPABASE_URL='https://<ref>.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY='...' \
EMPRESA='IAR Office' SLUG=iarx EMAIL=admin@iarx.com.br \
SENHA='uma-senha-longa-de-verdade' ESFERAS=management,rental \
  bash scripts/supabase-provisionar.sh
```

A URI está em **Project Settings › Database › Connection string › URI**.

**Use a conexão DIRETA, porta 5432 — nunca a 6543.** A 6543 é o pooler em modo
transação: cada comando pode cair numa conexão diferente, a transação por
migração deixa de envolver a migração inteira, e um erro no meio deixa metade
aplicada. O script recusa essa porta antes de tocar em qualquer coisa, e diz
por quê.

### O que ele recusa, e isso é o ponto

- **porta 6543** — pelo motivo acima;
- **banco que não é Supabase** (sem `auth.users` ou sem os três papéis) — e
  manda para o `migrar.sh`, que aplica o shim;
- **banco de outra aplicação** — tabelas em `public` e nenhum livro-razão.
  Aplicar 64 migrações ali misturaria dois sistemas no mesmo schema, e não há
  desfazer;
- **senha de administrador com menos de 12 caracteres**;
- **segunda execução do primeiro acesso** — se já existe empresa, ele para.

### A conferência, que você pode repetir quando quiser

O último passo roda `supabase/tests/conferir-producao.sql`, que é **somente
leitura** e por isso pode rodar na segunda-feira de manhã, com gente usando.
Ele não é o `schema_test.sql`: aquele cria empresa, fatura e movimento de
estoque para provar que as regras recusam o que devem, e isso não se faz num
banco com dado de cliente.

O que ele prova — tudo invariante de **isolamento**, e nenhum deles se
manifesta como erro:

1. toda tabela de `public` com RLS ligada, e **forçada** onde há `tenant_id`;
2. toda tabela sem `tenant_id` está na lista de catálogos globais declarados —
   assim uma tabela nova que **esqueça** a coluna não passa por catálogo;
3. toda tabela com RLS tem ao menos uma policy (RLS sem policy nega tudo, em
   silêncio);
4. toda view com `security_invoker` — sem ele a view roda como `postgres`, que
   ignora RLS, e devolve as linhas de **todas** as empresas;
5. o catálogo de permissões chegou inteiro;
6. o bucket `anexos` existe e **não** é público;
7. nenhum dado de demonstração;
8. o livro-razão bate com o número de migrações do repositório.

Para repetir depois, sozinho:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v migracoes=$(ls supabase/migrations/*.sql | wc -l) \
  -f supabase/tests/conferir-producao.sql
```

### Uma ressalva honesta sobre o primeiro usuário

No Supabase o administrador nasce pela **API do GoTrue**
(`/auth/v1/admin/users`), e não por `insert` em `auth.users`. O `insert` é o
que `scripts/primeiro-acesso.sh` faz, e está certo para a VPS com o shim, onde
não há GoTrue. Aqui há — e ele guarda invariantes próprios (`aud`, `role`,
confirmação de e-mail, o bloco de provedores) que um `insert` à mão não
preenche. O usuário ficaria no banco, parecendo existir, e o login responderia
`Invalid login credentials` sem nada que apontasse a causa.

**Este trecho não foi executado contra um Supabase real** — não havia um
disponível no ambiente em que o script foi escrito. O resto do script foi, do
banco vazio às 64 migrações e às 8 conferências. Se a criação do usuário
falhar, o erro do GoTrue é repassado inteiro (código e corpo), e o caminho
manual é criar o usuário pelo painel, em **Authentication › Users**, com
`app_metadata` contendo `tenant_id`, e depois inserir a linha em
`public.profiles`.

---

## 8. Backup para FORA da VPS

> **Backup que mora no mesmo disco do banco é cópia, não backup.** Se a VPS
> pegar fogo, as duas coisas vão juntas.

A docs/24 §3 mostra como gerar o dump. O que falta — e é o que de fato protege —
é mandá-lo para longe, **agendado**.

### Opção A: outro servidor, por SSH

Na VPS, uma chave só para o backup:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/backup -N ''
ssh-copy-id -i ~/.ssh/backup.pub backup@outro-host
```

E o agendamento:

```bash
crontab -e
```

```cron
# dump diário às 2h
0 2 * * * cd /home/sti/sti && bash scripts/backup.sh >> /home/sti/backup.log 2>&1
# e para fora, às 3h
0 3 * * * rsync -az -e 'ssh -i /home/sti/.ssh/backup' /home/sti/sti/backups/ backup@outro-host:/backups/sti/
# limpeza do que tem mais de 30 dias, na VPS
30 3 * * * find /home/sti/sti/backups -name '*.dump' -mtime +30 -delete
```

### Opção B: bucket compatível com S3

```bash
sudo apt install -y rclone
rclone config          # siga o assistente; tipo "s3"
```

```cron
0 3 * * * rclone copy /home/sti/sti/backups remoto:meu-bucket/sti --max-age 48h
```

### E o teste que ninguém faz

**Restaure um backup, uma vez, antes de precisar.** Num banco descartável, não
no de produção:

```bash
bash scripts/restaurar.sh backups/ARQUIVO.dump sti_iarx_ensaio
```

Backup que nunca foi restaurado é esperança, não backup. O CI desta base ensaia
isso a cada push; a sua cópia para fora da VPS, não — e é ela que vai ser usada
no dia ruim.

---

## 9. Monitor externo

O alerta de trabalho parado (docs/24 §6) é disparado **pela própria rota de
trabalhos**. Se o agendador morrer por inteiro, ninguém chama a rota e nenhum
aviso sai — o vigia dorme junto com o vigiado.

Aponte um monitor de fora (UptimeRobot, Better Stack, o que preferir) para:

```
https://sti.iarx.com.br/api/health
```

A cada 5 minutos, alerta por e-mail **e** por outro canal que não seja o e-mail
do mesmo domínio: se o problema for o servidor de e-mail, o aviso sobre ele não
chega por e-mail.

---

## 10. Depois de publicar, confira isto

Na ordem, e do seu computador — não da VPS:

```bash
# 1. o certificado é válido e não é o de teste
curl -sI https://sti.iarx.com.br | head -3

# 2. só as portas certas respondem
nmap -Pn -p 22,80,443,5432,5433 SEU_IP

# 3. a saúde responde sem sessão
curl -s https://sti.iarx.com.br/api/health

# 4. os planos abrem para quem não tem conta
curl -s -o /dev/null -w '%{http_code}\n' https://sti.iarx.com.br/planos
```

E, pela tela:

- [ ] entrar com o administrador criado na §7;
- [ ] abrir `/assinatura` e ver a situação da empresa;
- [ ] **mandar um convite para um endereço seu** e conferir que o e-mail chega —
      é o teste de ponta a ponta do SMTP, e o único que prova que ele funciona;
- [ ] abrir `/auditoria/avisos` e ver a mensagem com situação `enviado`;
- [ ] abrir `/auditoria/trabalhos` e conferir que nenhum está como `PAROU`.

O terceiro item é o que mais falha, e falha em silêncio: a caixa de saída
acumula e ninguém percebe até alguém dizer que não recebeu o convite.

---

## 11. Quando der errado

A [docs/24 §8](24-producao-na-vps.md) tem a tabela de diagnóstico. Dois casos
que são específicos de VPS pequena:

| sintoma | o que é |
| --- | --- |
| o build morre com `Killed`, sem mensagem de erro | faltou memória. Ver §0 e §3 |
| `no space left on device` | imagens antigas do Docker. `docker system prune -a` |

E um que não aparece em `docker ps`: **disco cheio derruba o PostgreSQL com
erros que parecem de corrupção**. Antes de suspeitar do banco, rode `df -h`.
