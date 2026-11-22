# 27 — Manual do usuário

As imagens deste manual são da **aplicação rodando**, capturadas por
`scripts/capturar-manual.mjs` contra o banco com as migrações e as policies em
vigor. Nenhuma foi desenhada, e nenhuma está desatualizada sem que a suíte
acuse: `src/lib/manual.test.ts` exige que toda imagem citada aqui exista, e que
toda imagem capturada seja citada.

Os dados que aparecem nelas são a **semente de exemplo** versionada no
repositório — empresas, chamados e contratos inventados. Dado de cliente não
entra aqui, e é por isso que a semente pode ser versionada.

> **Este manual está organizado pelo que você faz, não pelo menu.** O menu é a
> resposta para "onde fica"; este documento é a resposta para "como eu faço".
> Se você procura a lista de telas, ela está na
> [arquitetura de informação](08-arquitetura-de-informacao.md).

---

## Índice

1. [Entrar no sistema](#1-entrar-no-sistema)
2. [Quem pede ajuda](#2-quem-pede-ajuda)
3. [Quem atende](#3-quem-atende)
4. [Quem responde pelo resultado](#4-quem-responde-pelo-resultado)
5. [Inventário e monitoramento](#5-inventário-e-monitoramento)
6. [Locação de equipamento](#6-locação-de-equipamento)
7. [Administrar](#7-administrar)
8. [Dois atalhos que mudam o dia](#8-dois-atalhos-que-mudam-o-dia)
9. [Quando algo dá errado](#9-quando-algo-dá-errado)

---

## 1. Entrar no sistema

![A tela de entrada](manual/entrar.webp)

O endereço é o do seu sistema — no nosso caso, `sti.iarx.com.br`. Entre com o
e-mail e a senha que você recebeu no convite.

**Se a recusa aparecer, ela é sempre a mesma frase**, exista a conta ou não.
Isso é deliberado: uma mensagem diferente para "e-mail não existe" contaria a
quem tenta quais e-mails existem na sua empresa.

### Esqueci a senha

![Recuperar a senha](manual/recuperar-senha.webp)

Peça o link, e ele chega no e-mail. O link **vale uma vez e expira** — se você
pedir dois, o primeiro deixa de valer. Esse é o comportamento certo: um link de
troca de senha que continua valendo é uma porta aberta no e-mail de quem o
recebeu.

### Ainda não tem conta

![Criar a conta da empresa](manual/criar-conta.webp)

Quem cria a conta cria a **empresa** junto, e vira o administrador dela. Os
demais entram por convite, feito por quem já está dentro.

![Os planos](manual/planos.webp)

O preço fica a um clique da entrada, sem precisar de cadastro. O sistema **não
emite boleto, não integra adquirente e não guarda cartão**: ele sabe quanto
custa e quando a vigência acaba; quem cobra é quem vende, por fora.

---

## 2. Quem pede ajuda

> O papel **solicitante** é o de quem tem um problema e precisa de ajuda. Ele
> abre e acompanha os próprios chamados, e consulta o que o perfil permite.

### Comece pelo Portal

![O portal](manual/portal.webp)

O portal não dá acesso a nada que você já não tivesse. O que ele acrescenta é a
**ordem**: procurar a resposta antes de pedir um serviço, e pedir um serviço
antes de abrir chamado livre. Três quartos dos chamados de senha e acesso têm
resposta pronta na base.

### Procure antes de abrir

![A base de conhecimento](manual/base-de-conhecimento.webp)

A busca ignora acento: digitando `manutencao` você acha "manutenção". Quem
resolveu pelo artigo marca se ele ajudou, e é isso que ordena a base.

### Abrir o chamado

![Abrir chamado](manual/abrir-chamado.webp)

Preencha o título e descreva o que aconteceu. Dois campos mudam o atendimento:

- **Categoria** decide a fila e o prazo de SLA;
- **Prioridade** você sugere, e quem atende confirma — ela não é sua decisão
  final porque a fila é compartilhada.

Anexe o print. Vale até 25 MB por arquivo, e o anexo é **privado**: só quem tem
acesso ao chamado o baixa.

### Acompanhar

![Meus chamados](manual/meus-chamados.webp)

Você vê **os seus**, e só. A coluna de prazo diz quanto falta, e `atrasado`
aparece em vermelho com o quanto passou.

---

## 3. Quem atende

> O papel **atendente** trabalha a fila: assume, responde, resolve.

### A lista é o posto de trabalho

![A lista de chamados](manual/lista-de-chamados.webp)

A ordem **não é por data**: é por score de priorização, que combina
criticidade, prazo de SLA e tempo de espera. O chamado que mais arde fica no
topo, e isso muda sozinho ao longo do dia.

As abas são recortes prontos: **Em aberto**, **Meus**, **Sem atendente**,
**SLA em risco**, **Todos** — com a contagem ao lado, para você saber se vale
clicar antes de clicar.

**Pelo teclado**, sem tirar a mão: `J` e `K` andam, `X` marca, `Enter` abre,
`Esc` limpa. A dica fica escrita na própria tela, à direita.

### A gaveta é onde o trabalho acontece

![A gaveta do chamado](manual/gaveta-do-chamado.webp)

Clique no título e o chamado abre **sobre a lista**, sem perder o seu lugar nem
o seu filtro. Dentro dela:

- **status, atendente, prioridade e fila** mudam ali mesmo, sem abrir outra
  tela;
- a **conversa** mostra tudo em ordem;
- o comentário novo escolhe entre **Público** (o solicitante recebe por e-mail)
  e **Interno** (só a equipe vê). O padrão é público, porque o silêncio é a
  reclamação mais comum de quem abriu o chamado.

`J` e `K` passam para o chamado seguinte **sem fechar a gaveta**. `Esc` fecha.

### As filas

![As filas](manual/filas.webp)

A fila é quem recebe o chamado quando a categoria casa com a regra. Cada uma
tem os seus membros e o seu horário de atendimento — e é o horário da fila, não
o relógio de parede, que conta o prazo de SLA.

---

## 4. Quem responde pelo resultado

> O papel **gestor** não trabalha a fila: ele responde por ela.

### A visão geral

![A visão geral](manual/visao-geral.webp)

Cada bloco exige a permissão do próprio módulo — quem não tem acesso ao
financeiro não vê o bloco do financeiro, em vez de ver um bloco vazio.

**Todo número que tem registro por trás abre ao clique**, e abre com o **mesmo
recorte** que o produziu. Mediana, percentual isolado e contagem de cadastro
não abrem, porque não há uma lista por trás deles. **Número zero também não
abre**: um detalhamento vazio faz duvidar do número.

### SLA e prazos

![SLA e prazos](manual/sla-e-prazos.webp)

O prazo corre no **horário de atendimento** da fila, não no relógio. Um chamado
aberto sexta às 18h com prazo de 4 horas úteis vence segunda às 11h, não sábado
às 22h.

Um indicador que ainda está acumulando diz **"mês em curso"**, e não "sem
dados" — são coisas diferentes, e tratá-las igual faz a meta parecer falhada
quando ela só não terminou.

### Satisfação

![Satisfação](manual/satisfacao.webp)

A pesquisa vai por link com token, **sem exigir login** — pedir senha para
responder uma nota de 1 a 5 é o jeito mais eficiente de não receber resposta.

### Visão de resultado

![Visão de resultado](manual/visao-de-resultado.webp)

A pergunta que esta tela responde é: **o contrato com este cliente paga o custo
de atendê-lo?** Ela cruza horas apontadas, custo de peça e despesa alocada
contra o que o contrato prevê.

### Orçamento de TI

![Orçamento de TI](manual/orcamento-de-ti.webp)

Previsto contra realizado, por centro de custo e por competência. A competência
é guardada em formato ordenável (`AAAA-MM`) e exibida no formato humano.

---

## 5. Inventário e monitoramento

![O inventário](manual/inventario.webp)

Cada ativo tem custódia: **quem está com ele, desde quando, e o que houve
antes**. Transferir patrimônio é ato de gestor — quem não é não vê o botão.

### O agente nas máquinas

![Os agentes](manual/agentes.webp)

O agente instalado reporta inventário, software e métricas. A tela diz **quando
cada máquina falou pela última vez** — e é a ausência, não a presença, que
interessa aqui: máquina que parou de reportar é máquina que alguém levou para
casa, formatou ou perdeu.

### Links de internet

![Links de internet](manual/links-de-internet.webp)

Disponibilidade por link, com os eventos de queda. Serve para a conversa com a
operadora ter número em vez de impressão.

---

## 6. Locação de equipamento

> Este grupo só aparece para a empresa que declarou a esfera **Locação**. Não é
> permissão: é a pergunta "esta tela existe neste negócio?".

### A frota

![A frota](manual/frota.webp)

Cada equipamento tem ciclo de vida com transições válidas — o sistema **recusa**
passar de um estado para outro que não faz sentido, e a recusa diz qual regra
barrou.

### Os contratos

![Os contratos](manual/contratos.webp)

O contrato tem vigência, franquia e preço. **Reajuste não cria contrato novo**:
a identidade do contrato não inclui o valor.

### Medições

![Medições](manual/medicoes.webp)

A leitura do medidor **não retrocede** — o sistema recusa uma leitura menor que
a anterior, porque o excedente seria cobrado errado e ninguém confere para
baixo.

### Faturamento

![Faturamento](manual/faturamento.webp)

A fatura soma os itens, e o total é mantido pelo banco — não por alguém que
lembrou de recalcular. **Fatura emitida é imutável**: para corrigir, reemite-se,
e as duas ficam no histórico.

### Peças e estoque

![Peças e estoque](manual/pecas-e-estoque.webp)

O saldo vem do extrato de movimentos, e **movimento não se altera nem se
exclui**. Errou? Lança-se o movimento contrário: o razão guarda o erro *e* a
correção.

---

## 7. Administrar

### Usuários

![Usuários](manual/usuarios.webp)

Cada pessoa tem um **papel** (o teto do que ela pode) e um **perfil de acesso**
(o recorte dentro desse teto). Você não altera o próprio papel nem desativa a
própria conta — isso trancaria você do lado de fora.

### Perfis de acesso

![Perfis de acesso](manual/perfis-de-acesso.webp)

O perfil marca, chave por chave, o que aquele conjunto de pessoas alcança.

**O perfil só restringe; nunca eleva.** O papel efetivo é o *menor* entre o
papel da pessoa e o teto do perfil. É por isso que duas pessoas com o mesmo
papel `gestor` podem ver menus diferentes.

### Convites

![Convites](manual/convites.webp)

O convite vai por e-mail com um link que **vale uma vez**. Ninguém convida para
um papel acima do próprio.

### Assinatura

![Assinatura](manual/assinatura.webp)

Mostra a situação, o plano e o histórico de mudanças. **Fora da vigência o
sistema continua lendo e para de escrever** — ninguém perde o acesso ao que já
registrou.

### Trilha de alterações

![Trilha de alterações](manual/trilha-de-alteracoes.webp)

Quem mexeu, quando, e o que havia antes. **Nada é excluído em silêncio**:
exclusão é lógica, com autor e estado anterior.

### Avisos enviados

![Avisos enviados](manual/avisos-enviados.webp)

A caixa de saída do sistema. Enquanto o e-mail não estiver configurado, os
avisos **acumulam aqui e nada se perde** — quando a chave entrar, o acumulado
sai.

### Planilhas

![Planilhas](manual/planilhas.webp)

Importação com **prévia antes de gravar**: você vê o efeito de cada linha antes
de confirmar. Linha inválida não derruba o lote, e o modelo da planilha é
baixado da própria tela — a aba de instruções é derivada da definição das
colunas, então ela não diverge.

---

## 8. Dois atalhos que mudam o dia

### A paleta de comandos

![A paleta de comandos](manual/paleta-de-comandos.webp)

`Ctrl+K` (ou `⌘K`) abre a busca de tudo: tela, chamado, ativo, cliente. É o
caminho mais curto entre onde você está e onde precisa ir, e ela **respeita as
suas permissões** — não oferece o que você não pode abrir.

### Minha conta

![Minha conta](manual/minha-conta.webp)

Trocar a própria senha não é permissão de módulo: é direito de quem tem conta.
Aqui também se escolhe o **tema** — sistema, claro ou escuro —, e a escolha
explícita ganha da do aparelho.

---

## 9. Quando algo dá errado

**Erro tem código, além da frase.** Se precisar abrir chamado com o suporte,
mande o código: ele não muda quando alguém melhora a redação da mensagem.

| O que você vê | O que é | O que fazer |
| --- | --- | --- |
| "Esta conta está desativada" | alguém desativou a sua conta | procure quem administra a sua empresa |
| "Esta conta não está vinculada a nenhuma empresa" | a conta existe e não tem vínculo | peça um convite — reativar não resolve |
| "Sistema temporariamente indisponível" | o banco de dados não respondeu | **não é a sua conta**; avise quem cuida do servidor |
| "Fora de vigência" ao salvar | a assinatura venceu | a leitura continua; para voltar a escrever, renove |
| Um estado vazio que explica a causa | falta classificar, não é ausência de problema | o próprio aviso traz o caminho |

> **Estado vazio diz a causa, não mostra zero.** Zero se lê como "não há
> problema"; "falta classificar" é outra coisa — e por isso o sistema escreve
> a segunda em vez de exibir a primeira.

---

## Como estas imagens são refeitas

```bash
bash scripts/preparar-banco-local.sh
npm run build && npx next start -p 3177 &
node scripts/capturar-manual.mjs /tmp/manual
for f in /tmp/manual/*.png; do
  convert "$f" -resize 60% -quality 84 "docs/manual/$(basename "$f" .png).webp"
done
```

O roteiro entra como quatro pessoas diferentes — anônimo, solicitante,
atendente, gestor e administrador — porque metade do que este manual mostra
**depende de quem está olhando**. E cada passo que depende de interação declara
o que precisa estar visível depois: sem isso, um clique que não abre a gaveta
publica a tela errada com toda a confiança do mundo. Foi o que aconteceu na
primeira geração.
