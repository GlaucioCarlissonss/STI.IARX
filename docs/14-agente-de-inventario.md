# 14 — O agente nas máquinas: como ligar

**Status:** implementado (Ondas 2 e 3 de [docs/12](12-paridade-milvus.md) —
inventário, desempenho e alertas).
**Depende de você:** emitir um token na tela e instalar o agente. Nada de
variável de ambiente nova, a não ser que você queira autoatualização.

> Esta é a maior lacuna do produto sendo fechada. O inventário de TI existe desde
> a migração 0007 e **era digitado à mão**. Depois desta onda, ele não é.

---

## 1. O caminho mais curto, do zero à primeira máquina

1. Abra **Inventário → Agentes nas máquinas**.
2. Em *Instalar o agente em novas máquinas*, dê um nome ao lote (ex.: "Notebooks
   da filial de Londrina"), escolha a **filial** e clique em **Emitir token**.
3. Copie o comando que aparece.
4. Rode na máquina.

A máquina aparece na tela em até dez minutos. Não há passo 5.

A **filial escolhida no token é herdada por toda máquina inscrita com ele**. É o
que evita classificar 30 computadores um a um depois — o token carrega o lugar.

---

## 2. Instalar em escala

O detalhe de cada plataforma está em [`agente/README.md`](../agente/README.md).
O resumo:

| Onde | Como |
|---|---|
| **Windows, em escala** | GPO → *Configuração do Computador → Scripts → Inicialização*, apontando para `instalar.ps1` no `netlogon`. É o caminho pronto. |
| **Windows, uma máquina** | `.\instalar.ps1 -Servidor "https://..." -Token "inv_..."` |
| **Debian/Ubuntu** | `dpkg -i sti-agente_*.deb` e depois `sti-agente-configurar https://... inv_...` |
| **macOS** | Binário em `/usr/local/bin` e o LaunchDaemon em `/Library/LaunchDaemons`. |

### Sobre o MSI

A fonte do instalador MSI está em `agente/empacotamento/windows/sti-agente.wxs`,
e ela **precisa do WiX de verdade numa máquina Windows** — que é onde o pacote
também precisa ser assinado, sem o que o SmartScreen barra a instalação.

Tentei construí-la com o `wixl` do msitools, que roda em Linux: ele produz um
`.msi` e **descarta as ações personalizadas em silêncio**, gerando um instalador
que copia o executável e não cria tarefa nenhuma. Um instalador que parece certo
e não faz o trabalho é pior que nenhum.

Por isso o caminho verificado hoje é o `instalar.ps1`, que faz o mesmo e roda em
GPO sem depender de nada. O MSI é o degrau seguinte.

---

## 3. O que a tela mostra, e por quê

### Os quatro indicadores

| | O que diz |
|---|---|
| **Máquinas com agente** | O tamanho da frota reportando. |
| **Máquinas mudas** | Sem contato há mais de 24 h. **É o número que justifica a tela.** |
| **Divergências** | O cadastro e a máquina discordam em algum campo. |
| **Casadas pelo nome** | Conciliadas por hostname — vale conferir o equipamento. |

**Máquinas mudas** merece explicação. Agente que parou de falar é invisível por
natureza: não dá erro, não gera chamado, não aparece em lugar nenhum —
simplesmente deixa de haver dado novo, e o inventário envelhece sem avisar. Quem
percebe primeiro é quem for procurar um equipamento e não achar.

### Por que esta tela é separada de "Inventário de TI"

São duas perguntas. **Inventário** é o patrimônio: o que a empresa comprou,
quanto custou, quando vence a garantia — e inclui monitor, impressora e licença,
que nunca vão ter agente. **Agentes** é o parque em operação: o que está ligado e
falando agora.

---

## 4. A conciliação — a parte que não pode errar

> Duplicata em inventário não é um incômodo: é o fim da confiança no módulo. Quem
> abre a tela e vê a própria máquina duas vezes não volta.

A ordem é **número de série → identidade da máquina → nome da máquina → cria**, e
cada passo tem uma razão:

1. **Número de série.** É o único identificador que o fabricante gravou e que
   atravessa reinstalação de sistema. Quando é utilizável, é definitivo.

2. **Identidade da máquina** (um UUID que o agente gera na primeira execução e
   grava em disco). Cobre o caso de alguém editar o número de série no cadastro
   depois da primeira conciliação: a máquina é a mesma, o vínculo já foi
   estabelecido, e desfazê-lo criaria a duplicata.

3. **Nome da máquina** — e **só contra ativo que não tem número de série nenhum**.
   Esta restrição é o ponto delicado: se o ativo tem serial e o serial não casou
   no passo 1, então não são a mesma máquina, por mais que o nome bata. Nome de
   máquina se repete entre equipamentos trocados ("NOTE-FISCAL" é o notebook do
   setor, não *aquele* notebook), e sem a restrição o inventário casaria o
   substituto com o substituído e perderia os dois.

4. **Cria.** Que é o ponto do agente.

### O número de série é um campo que mente

Placa-mãe de montagem branca, máquina virtual e lote de OEM vêm com texto de
preenchimento no lugar do serial: *"To Be Filled By O.E.M."*, *"Default string"*,
*"System Serial Number"*.

Casar por esse valor seria o pior defeito possível aqui: as 80 máquinas montadas
do mesmo lote casariam **todas no mesmo ativo**, e o inventário mostraria 1
computador onde há 80. Por isso o serial passa por um filtro antes de virar
chave — e há asserção de schema provando, de ponta a ponta, que duas máquinas
com o mesmo texto de fábrica viram dois ativos.

### O agente preenche o que está em branco; ele não discute com gente

Se alguém digitou o número de série e o agente leu outro, **o agente não
sobrescreve**. A divergência aparece na linha da máquina e na tela de detalhe, e
quem decide é você.

As três opções eram sobrescrever, ignorar ou mostrar. Sobrescrever apaga a
correção que uma pessoa fez de propósito; ignorar deixa o erro para sempre.
Mostrar é a única das três que não perde informação.

---

## 5. Credencial e revogação

O agente **nunca** carrega a chave de serviço do sistema.

| | |
|---|---|
| **Token de inscrição** | Do lote. Tem prazo (padrão 30 dias), teto de máquinas e revogação. Vai no instalador e na GPO. |
| **Token da máquina** | Recebido na primeira execução, guardado com permissão restrita. É com ele que a máquina fala. |

**Revogar um notebook roubado** é uma linha de banco: o token dela para de valer
no mesmo instante, e **reinstalar o agente não a traz de volta** (há asserção de
schema para isso — sem a recusa, revogar não serviria de nada).

**Revogar o token do lote** impede novas inscrições e não afeta as máquinas já
instaladas: cada uma tem o token dela.

Revogar a máquina na tela e desinstalar o agente são duas coisas, e as duas
precisam ser feitas para tirar a máquina do parque. Sem a revogação ela fica
"silenciosa" para sempre — e "silenciosa" também significa "parou de funcionar",
então a tela deixaria de distinguir as duas coisas.

---

## 6. Autoatualização *(opcional, e fechada por padrão)*

Duzentas máquinas não se atualizam à mão. E um agente que se atualiza errado é um
incidente em duzentos lugares ao mesmo tempo, dentro da rede do cliente, com
privilégio de serviço.

Por isso o recurso **vem desligado** e, quando ligado, exige assinatura. Para
ligá-lo:

**1. Gere o par de chaves** (a privada fica com você, fora do servidor):

```bash
openssl genpkey -algorithm ed25519 -out agente-release.key
openssl pkey -in agente-release.key -pubout -outform DER | tail -c 32 | base64
```

**2. Compile o agente com a chave pública:**

```bash
cd agente
VERSAO=1.1.0 CHAVE_PUBLICA="<a saída acima>" ./empacotamento/construir.sh
```

**3. Assine o binário publicado:**

```bash
openssl pkeyutl -sign -rawin -inkey agente-release.key \
  -in dist/sti-agente-1.1.0-windows-amd64.exe | base64 -w0
```

**4. Publique** — quatro variáveis no ambiente do servidor:

| Variável | O que é |
|---|---|
| `AGENT_RELEASE_VERSION` | `1.1.0` |
| `AGENT_RELEASE_URL` | O endereço **https** do binário |
| `AGENT_RELEASE_SHA256` | `sha256sum` do arquivo |
| `AGENT_RELEASE_SIGNATURE` | A saída do passo 3 |

Faltando qualquer uma, a rota `/api/agent/version` responde **204 (nada a
fazer)** e os agentes continuam na versão instalada — que é o estado seguro. O
estado inseguro seria o contrário: um endpoint que, por falta de configuração,
respondesse "baixe este arquivo" apontando para lugar nenhum.

### Por que a assinatura, e não só o hash

Se só o hash fosse conferido, **quem controlasse o servidor controlaria o binário
que roda como serviço em todas as máquinas do cliente** — e "quem controla o
servidor" inclui quem tiver acesso às variáveis de ambiente, quem fizer um ataque
de DNS e qualquer intermediário que termine o TLS. A assinatura move a confiança
do servidor para a chave privada, que fica fora dele.

O agente ainda executa o binário novo com `--versao` e exige que ele se apresente
antes de assumir. Isso pega arquitetura errada, biblioteca faltando, antivírus que
pôs o arquivo em quarentena — e publicação com o número de versão errado, que é o
mais comum dos quatro. O binário anterior é guardado ao lado.

---

## 7. Privacidade — a pergunta de quem autoriza

**Coleta, uma vez por dia:** hardware (fabricante, modelo, série, processador,
memória, discos com saúde SMART, rede, BIOS), sistema operacional e build,
domínio, usuário logado, tempo ligado, e a lista de programas instalados com
versão.

**Mede, a cada cinco minutos:** uso de processador, uso de memória, espaço livre
por volume, e quais dos serviços configurados como críticos estão fora do ar.

**Não coleta:** conteúdo de arquivo, histórico de navegação, tela, teclado,
microfone, câmera, nem o que está aberto. Também **não abre porta nenhuma**: fala
só de dentro para fora, para um endereço só.

**Nada por processo.** "Qual programa está consumindo a CPU" é a pergunta
seguinte e é tentadora — e a resposta carrega o nome e a linha de comando de tudo
que a pessoa está rodando, o que é vigilância e não inventário. O recurso não
existe, e não é esquecimento.

Está escrito em `agente/cmd/sti-agente/main.go` e é sustentado pelo código — não
há no programa nada que leia qualquer dessas coisas. Limitar o escopo é mais
fácil de prometer agora do que de desfazer depois.

---

## 8. Quando alguma coisa não aparece

```bash
sti-agente --diagnostico
```

Imprime o que o agente vê e tenta um contato com o servidor, **sem mandar
inventário**. A tabela de sintomas está em
[`agente/README.md`](../agente/README.md#3-quando-alguma-coisa-não-aparece).

Para forçar uma coleta agora (depois de trocar um pente de memória, por exemplo):

```bash
sti-agente --uma-vez
```

---

## 9. Desempenho e alertas

### O que a tela da máquina mostra

Processador e memória das últimas 24 horas, com **média e pico** — a média
sozinha esconde o pico, e o pico é o que faz a máquina travar: 40% de média com
picos de 100% é uma máquina travando, e a média diria que está folgada.

Hora sem amostra aparece como **buraco**, não como linha reta. Reta num gráfico
de CPU é lida como "ficou constante", que é o contrário de "a máquina estava
desligada" — e máquina desligada à noite é o caso comum.

Por volume: tamanho, livre, uso e **em quantos dias enche** no ritmo observado. É
a informação mais acionável do módulo: "enche em quatro dias" move alguém hoje,
"está com 88%" não move ninguém. A projeção é uma reta sobre sete dias, de
propósito — serve para decidir se vale olhar a máquina esta semana, não para
marcar data.

### Os quatro alertas

| Alerta | Quando abre | Quando fecha |
|---|---|---|
| **Disco cheio** | uso ≥ o limiar do tenant (padrão 90%) | uso < limiar **menos 5 pontos** |
| **Máquina sem contato** | silêncio além do limiar (padrão 24 h) | quando ela volta a falar |
| **Serviço fora do ar** | serviço crítico configurado não está rodando | quando ele volta |
| **Disco com defeito** | SMART reporta falha ou atenção | na coleta em que o disco é trocado |

**A folga de cinco pontos é a parte importante.** Um disco parado em 90,1% com
limiar de 90 abriria e fecharia a cada ciclo, mandando um e-mail por vez — e um
alerta que chega oito vezes por dia é um alerta que as pessoas filtram para a
lixeira, levando junto os que importam.

O alerta é um **estado**: abre, fica aberto enquanto vale, fecha sozinho. O aviso
por e-mail sai **uma vez por alerta**, para gestores e administradores que não
tenham desligado em *Minha conta*. Fechar à mão é possível e não silencia nada —
se a condição continuar valendo, ele volta a abrir no ciclo seguinte.

### Configuração, por tenant

Vivem na tabela `tenants`, junto de `auto_close_after_days` e dos percentuais de
SLA:

| Coluna | Padrão | O que faz |
|---|---|---|
| `agent_disk_alert_pct` | 90 | Onde o alerta de disco abre |
| `agent_mute_hours` | 24 | Quanto silêncio é "máquina muda" |
| `agent_metrics_retention_days` | 7 | Quanto tempo o **detalhe** fica |
| `agent_remote_url` | vazio | Modelo de link de acesso remoto, com `{id}` |

`agent_mute_hours` governa a tela, o indicador e o alerta **ao mesmo tempo**:
antes o limiar estava escrito em três lugares que concordavam por coincidência.

O agregado por hora vive **um ano**, e não o prazo do detalhe. São a mesma
informação com outra granularidade: o detalhe responde "o que houve às 14h32 de
ontem" e envelhece rápido; o agregado responde "esta máquina está pequena para o
trabalho há seis meses", que é a pergunta que justifica uma compra.

### Serviços críticos

Entram no `agente.json` da máquina, pelo **nome curto**:

```json
{ "servicos_criticos": ["Spooler", "WinDefend"] }
```

O nome curto (`Spooler`) e não o de exibição (`Spooler de Impressão`): o de
exibição muda com o idioma do sistema, e uma configuração que funciona no Windows
em português falharia calada no mesmo parque com uma máquina em inglês.

Serviço configurado que **não existe** na máquina conta como fora do ar. Ou
alguém o desinstalou (que é o alerta que se quer), ou a configuração tem um nome
errado (que também precisa aparecer) — silêncio seria pior que os dois.

A lista vem vazia por padrão, e é deliberado: não existe lista que sirva para
todo mundo, e uma inventada por nós produziria alerta em máquina onde o serviço
nunca deveria estar rodando.

---

## 10. Acesso remoto *(opcional)*

A plataforma **não implementa controle remoto de tela** — isso é um produto
inteiro (NAT traversal, relay, codec, latência, segurança), e construí-lo aqui
custaria meses para entregar pior que o RustDesk auto-hospedado, que é open
source.

O que ela faz é o pedaço que só ela pode fazer: **saber qual id do RustDesk
pertence a qual máquina do inventário**. É o elo que falta entre as duas
ferramentas. O resto é um link.

1. Instale o RustDesk nas máquinas, do jeito que você já faria.
2. Em `tenants.agent_remote_url`, ponha o modelo com `{id}` — por exemplo
   `rustdesk://{id}`.
3. O agente lê o id do arquivo de configuração do RustDesk e o registra. O botão
   **Acessar remotamente** aparece na ficha da máquina.

Sem o modelo configurado, ou sem RustDesk na máquina, o botão simplesmente não
aparece. O banco recusa um modelo sem `{id}`: sem ele o link seria igual para as
200 máquinas e abriria sempre a mesma.

> O MeshCentral **não** é lido automaticamente: ele identifica a máquina por um id
> gerado no servidor e guardado no banco dele, e ler isso exigiria falar com a API
> do MeshCentral, com credencial. É outro recurso. O campo aceita qualquer modelo
> de URL, então quem usa MeshCentral pode preencher o id à mão.

---

## 11. O que estas ondas deliberadamente NÃO fizeram

| | Por quê |
|---|---|
| Temperatura | O sensor existe em `/sys` no Linux e em WMI no Windows, e **mente**: placas diferentes expõem sensores diferentes com nomes diferentes, e metade reporta a temperatura do chipset como se fosse a do processador. Um número errado num alerta é pior que nenhum número. |
| Métrica por processo | "Qual programa está consumindo a CPU" é tentador e a resposta carrega o nome e a linha de comando de tudo que a pessoa está rodando. Isso é vigilância, não inventário. |
| Controle remoto de tela | Integrado, não implementado — ver a seção 10. É um produto inteiro, e o RustDesk auto-hospedado já o entrega. |
| Casamento com CVE | Depois. Primeiro o inventário de software, que já responde *"quem ainda tem Windows 10?"* — e está na tela, em **Inventário → Software instalado**. |

### O que eu não pude verificar

A coleta em **Windows** e em **macOS** compila para as duas plataformas (a
compilação cruzada é parte da verificação) e usa as consultas documentadas pela
Microsoft e pela Apple, mas **não foi executada nelas** — não há Windows nem Mac
onde este código foi escrito. A primeira execução em máquina real pode exigir
ajuste de nome de propriedade.

Em **Linux** tudo foi executado de verdade: 693 programas e 6 discos lidos no
inventário; a amostragem de desempenho lendo CPU, memória e volumes reais; o
pacote `.deb` instalado e o diagnóstico rodando.
