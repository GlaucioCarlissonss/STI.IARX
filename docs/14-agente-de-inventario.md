# 14 — O agente nas máquinas: como ligar

**Status:** implementado (Onda 2 de [docs/12](12-paridade-milvus.md), parte 1 —
inventário).
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

**Coleta:** hardware (fabricante, modelo, série, processador, memória, discos com
saúde SMART, rede, BIOS), sistema operacional e build, domínio, usuário logado,
tempo ligado, e a lista de programas instalados com versão.

**Não coleta:** conteúdo de arquivo, histórico de navegação, tela, teclado,
microfone, câmera, nem o que está aberto. Também **não abre porta nenhuma**: fala
só de dentro para fora, para um endereço só.

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

## 9. O que esta onda deliberadamente NÃO fez

| | Por quê |
|---|---|
| Métricas de desempenho (CPU, memória, disco por volume, temperatura) | Onda 3. Métrica é série temporal e não cabe na linha do ativo: 200 máquinas × 1 amostra por minuto são 288 mil linhas por dia, e todo `update` de métrica dispararia a trigger de auditoria. |
| As tabelas `agent_metrics_raw` e `agent_metrics_hourly` | Não foram criadas vazias "para já deixar pronto". A forma certa de uma série temporal depende de como o gráfico vai lê-la, e isso só se sabe construindo o gráfico. Tabela criada uma onda antes é tabela migrada duas vezes. |
| Alertas (disco acima de X%, serviço fora do ar) | Onda 3, junto das métricas. |
| Acesso remoto | Não será construído aqui: controle remoto de tela é um produto inteiro — NAT traversal, relay, codec, latência, segurança. O caminho é integrar RustDesk auto-hospedado ou MeshCentral, que são open source, e o agente só registrar o id da máquina. |
| Casamento com CVE | Depois. Primeiro o inventário de software, que já responde *"quem ainda tem Windows 10?"*. |

### O que eu não pude verificar

A coleta em **Windows** e em **macOS** compila para as duas plataformas (a
compilação cruzada é parte da verificação) e usa as consultas documentadas pela
Microsoft e pela Apple, mas **não foi executada nelas** — não há Windows nem Mac
onde este código foi escrito. A primeira execução em máquina real pode exigir
ajuste de nome de propriedade.

Em **Linux** ela foi executada de verdade: 693 programas e 6 discos lidos, com o
pacote `.deb` instalado e o diagnóstico rodando.
