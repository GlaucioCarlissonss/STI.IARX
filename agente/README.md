# O agente de inventário do STI

Um serviço sem janela que coleta o inventário da máquina e manda para o STI.
Depois dele, o inventário de TI deixa de ser digitado.

---

## 1. O que ele coleta — e o que ele não coleta

É a primeira pergunta de quem autoriza a instalação, então ela vem primeiro.

**Coleta, uma vez por dia:** fabricante, modelo, número de série, processador,
memória (total e por pente), discos (modelo, tamanho, tipo, saúde SMART), placas
de rede e MAC, BIOS e modo de inicialização, sistema operacional e build,
domínio, usuário logado, e a lista de programas instalados com versão.

**Mede, a cada cinco minutos:** uso de processador, uso de memória, espaço livre
por volume, tempo ligado, e quais dos serviços configurados como críticos estão
fora do ar. O tempo ligado é medida e não inventário porque muda a cada segundo —
no inventário, ele desestabilizava o hash de conteúdo e fazia toda coleta virar um
snapshot novo.

**Não coleta:** conteúdo de arquivo, histórico de navegação, tela, teclado,
microfone, câmera, nem o que está aberto. Ele também **não abre porta nenhuma**:
fala só de dentro para fora, para um endereço só.

**Nada por processo.** "Qual programa está consumindo a CPU" é a pergunta
seguinte e é tentadora — e a resposta carrega o nome e a linha de comando de tudo
que a pessoa está rodando, o que é vigilância e não inventário. O recurso não
existe, e não é esquecimento.

Isso está escrito em `cmd/sti-agente/main.go` e é sustentado pelo código — não há
nada no programa que leia qualquer dessas coisas. Limitar o escopo é mais fácil
de prometer agora do que de desfazer depois.

---

## 2. Instalar

Primeiro emita um **token de inscrição** em *Inventário → Agentes nas máquinas →
Instalar o agente em novas máquinas*. Ele vale para um lote, tem prazo e teto de
uso, e a tela já devolve o comando pronto.

### Windows, numa máquina

```powershell
.\instalar.ps1 -Servidor "https://sti.iartech.cloud" -Token "inv_..."
```

### Windows, em escala (GPO)

*Configuração do Computador → Políticas → Configurações do Windows → Scripts →
Inicialização*, com:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File \\dominio\netlogon\sti\instalar.ps1 -Servidor "https://sti.iartech.cloud" -Token "inv_..."
```

Deixe `instalar.ps1` e `sti-agente.exe` lado a lado no `netlogon`. Rodar de novo
sobre uma instalação existente é seguro — é, inclusive, como se atualiza o
executável à mão.

> **Sobre o MSI.** `empacotamento/windows/sti-agente.wxs` é a fonte do instalador
> MSI, e ela precisa do WiX de verdade (`candle` + `light`) numa máquina Windows,
> que é onde o pacote também precisa ser assinado. Tentei construí-la com o `wixl`
> do msitools, que roda em Linux: ele produz um `.msi` e **descarta as ações
> personalizadas em silêncio**, gerando um instalador que copia o executável e não
> cria tarefa nenhuma. Por isso o caminho verificado hoje é o `instalar.ps1`, que
> faz o mesmo trabalho e não depende de nada.

### Debian e Ubuntu

```bash
sudo dpkg -i sti-agente_1.0.0_amd64.deb
sudo sti-agente-configurar https://sti.iartech.cloud inv_...
```

### macOS

```bash
sudo install -m 0755 sti-agente /usr/local/bin/sti-agente
sudo mkdir -p "/Library/Application Support/STI/agente"
sudo tee "/Library/Application Support/STI/agente/agente.json" >/dev/null <<'JSON'
{"servidor":"https://sti.iartech.cloud","token_inscricao":"inv_...","intervalo_coleta_min":1440,"intervalo_envio_min":10}
JSON
sudo chmod 600 "/Library/Application Support/STI/agente/agente.json"
sudo cp br.com.iartech.sti-agente.plist /Library/LaunchDaemons/
sudo launchctl bootstrap system /Library/LaunchDaemons/br.com.iartech.sti-agente.plist
```

A máquina aparece na tela em até dez minutos.

---

## 3. Quando alguma coisa não aparece

```bash
sti-agente --diagnostico
```

Ele imprime o que o agente vê e tenta um contato com o servidor, sem mandar
inventário nenhum. Responde às três perguntas de sempre: a máquina se inscreveu?
A coleta leu alguma coisa? O servidor responde?

| O que aparece | O que significa |
|---|---|
| `"inscrita": false` | O token de inscrição não foi aceito: vencido, esgotado, revogado — ou a máquina foi revogada na tela. Os quatro respondem igual, de propósito. |
| `"contato_com_o_servidor"` com erro | Rede, proxy ou certificado. O agente exige HTTPS com certificado válido. |
| `"programas_lidos": 0` | Em Linux, nenhum gerenciador de pacotes conhecido respondeu. Em Windows, o PowerShell falhou. |
| `"itens_na_fila"` crescendo | Está coletando e não conseguindo entregar. Olhe o contato com o servidor. |
| `"amostras_na_fila"` crescendo | Idem, para as métricas. Ela se poda sozinha em 4.000 amostras (quase duas semanas). |
| `"servicos_vigiados": []` | Nenhum serviço crítico configurado — o padrão. Ver a seção 4. |
| `"numero_serie": ""` | Normal em máquina virtual e em placa de montagem branca. A conciliação cai para a identidade da máquina, que não depende disso. |

### Forçar uma coleta agora

```bash
sti-agente --uma-vez
```

É o que responde "troquei o pente de memória, por que a tela ainda mostra 8 GB?".

---

## 4. Como ele é por dentro

### A credencial

O agente **nunca** carrega a chave de serviço do sistema. Ele se inscreve uma vez
com o token do lote e recebe um token **daquela máquina**, guardado em
`identidade.json` com permissão 0600. Notebook roubado se revoga sozinho, sem
tocar nos outros 199.

Reinstalar o agente na mesma máquina **não cria uma máquina duplicada**: o UUID
fica em `identidade.json` e sobrevive à reinstalação. Para desinstalar
preservando isso, use `desinstalar.ps1 -PreservarIdentidade`.

### A conciliação com o inventário existente

Ordem: **número de série → identidade da máquina → nome da máquina → cria**.

Nunca duplica um ativo cadastrado à mão, e **não sobrescreve o que uma pessoa
digitou**: se o cadastro e a máquina discordarem, a divergência aparece na tela e
quem decide é você. Sobrescrever apagaria uma correção feita de propósito;
ignorar deixaria o erro para sempre.

O número de série passa por um filtro antes de virar chave: placa de montagem
branca e máquina virtual vêm com texto de fábrica no lugar dele (*"To Be Filled
By O.E.M."*, *"Default string"*), e casar por esse valor juntaria as 80 máquinas
do mesmo lote num ativo só.

### Inventário igual não vira linha nova

O agente coleta todo dia; o conteúdo muda poucas vezes por ano. O servidor compara
o resumo criptográfico do conteúdo e, se não mudou, só registra o contato. Sem
isso, o histórico — que existe para responder *"o que mudou nesta máquina?"* —
viraria 365 linhas por ano por máquina dizendo a mesma coisa.

### A fila local

Notebook em viagem acumula e manda depois. O que é guardado é toda coleta que
**mudou**, em ordem; coleta idêntica não entra. Teto de 200 itens, e o descarte
é pelo lado antigo — o inventário mais recente é o estado real da máquina e nunca
é descartado.

### Serviço no Linux e no macOS, tarefa agendada no Windows

Não é inconsistência. Um serviço do Windows precisa falar o protocolo do Service
Control Manager, e falar esse protocolo em Go exige um módulo de terceiro — num
programa que roda como SYSTEM na máquina do cliente. Duas tarefas agendadas
fazem o mesmo trabalho, sem dependência, e com uma vantagem real: **uma execução
que falha é repetida pela próxima**, enquanto um serviço que morre precisa de uma
política de reinício que alguém tem de configurar.

O batimento (a cada 10 min) custa algumas centenas de bytes; a coleta (diária) é
cara, porque varre o registro inteiro. Separar os dois é o que evita 14 GB por
dia de tráfego numa frota de 200 máquinas para dizer "estou viva".

### Desempenho, e por que medir é mais barato que coletar

O agente **amostra** de cinco em cinco minutos e **coleta o inventário** uma vez
por dia. São ciclos diferentes porque os custos são diferentes: medir CPU e disco
leva milissegundos; varrer o registro do Windows atrás de programas instalados
leva segundos e o usuário sente.

As amostras ficam numa fila local própria — um arquivo, uma linha por amostra —
e saem em lote a cada dez minutos. É o que permite ao notebook em viagem
continuar medindo sem rede e entregar o que passou quando ela volta, em vez de só
o instante.

A fila se poda sozinha em 4.000 amostras (quase duas semanas), descartando **as
mais antigas**. É o oposto da fila de inventário, e pelo motivo invertido: ali o
que importa é o estado atual; aqui a amostra velha já não ajuda ninguém a decidir
nada.

### Serviços críticos

No `agente.json`, pelo **nome curto**:

```json
{ "servicos_criticos": ["Spooler", "WinDefend"] }
```

O nome curto e não o de exibição: o de exibição muda com o idioma do sistema, e
uma configuração que funciona no Windows em português falharia calada no mesmo
parque com uma máquina em inglês. No Linux são unidades do systemd
(`sshd.service` ou `sshd`); no macOS, rótulos do launchd.

Serviço que não existe na máquina conta como fora do ar: ou alguém o
desinstalou, ou a configuração tem um nome errado — e os dois precisam aparecer.

### Acesso remoto

O agente **lê** o id do RustDesk do arquivo de configuração dele e o informa ao
servidor. Ele não instala, não configura e não abre conexão nenhuma: controle
remoto de tela é um produto inteiro, e o pedaço que só esta plataforma pode fazer
é saber qual id pertence a qual máquina do inventário.

Sem RustDesk instalado, a função devolve vazio e o recurso não aparece. Nenhum
erro, nenhum aviso — a maioria das instalações não usa acesso remoto.

### Autoatualização

**Fechada por padrão, e assinada.** Sem chave pública compilada no binário, o
agente recusa se atualizar — ele não tem o recurso, em vez de ter o recurso com a
verificação desligada.

Quando ligada, ele confere o SHA-256 **e** uma assinatura Ed25519 dos bytes do
binário, roda o candidato com `--versao` para ele se apresentar, e só então troca
o executável, guardando o anterior. Se só o hash fosse conferido, quem
controlasse o servidor controlaria o binário que roda como SYSTEM em todas as
máquinas do cliente.

---

## 5. Compilar e empacotar

```bash
cd agente
go test ./...
VERSAO=1.0.0 ./empacotamento/construir.sh
```

Sai em `dist/`: os binários das cinco plataformas, os tarballs, o `.deb` e o
`SHA256SUMS`. O MSI não sai daqui — ver a nota na seção 2.

Para habilitar a autoatualização, gere o par de chaves e compile com a pública:

```bash
openssl genpkey -algorithm ed25519 -out agente-release.key
CHAVE_PUBLICA="$(openssl pkey -in agente-release.key -pubout -outform DER | tail -c 32 | base64)"
VERSAO=1.0.0 CHAVE_PUBLICA="$CHAVE_PUBLICA" ./empacotamento/construir.sh
```

A chave **privada** não entra no repositório nem no servidor. É por ela ficar fora
do servidor que a assinatura protege contra um servidor comprometido.

---

## 6. O que ainda não existe

| | |
|---|---|
| Métricas de desempenho (CPU, memória, disco por volume, temperatura) | Onda 3. Métrica é série temporal e não cabe na linha do ativo — 200 máquinas × 1 amostra por minuto são 288 mil linhas por dia. |
| Alertas (disco acima de X%, serviço fora do ar) | Onda 3, junto das métricas. |
| Acesso remoto | Não vai ser construído aqui: controle remoto de tela é um produto inteiro. O caminho é integrar RustDesk auto-hospedado ou MeshCentral, e o agente só registrar o id da máquina. |
| Casamento com CVE | Depois. Primeiro o inventário de software, que já responde *"quem ainda tem Windows 10?"*. |

### O que eu não pude verificar

A coleta em **Windows** e em **macOS** compila (a compilação cruzada é parte da
verificação) e usa as consultas documentadas pela Microsoft e pela Apple, mas
**não foi executada nessas plataformas** — não há Windows nem Mac onde este código
foi escrito. A primeira execução em máquina real pode exigir ajuste de nome de
propriedade.

Em **Linux** tudo foi executado de verdade: 693 programas e 6 discos lidos no
inventário, e a amostragem de desempenho lendo CPU, memória e volumes reais.

Está escrito aqui porque descobrir isso em implantação é diferente de descobrir
lendo.
