# 16 — Canais de conversa: WhatsApp, e-mail, Bitrix24 e N8N

**Status:** implementado (Onda 5 de [docs/12](12-paridade-milvus.md)).
**Depende de você:** credenciais de provedor. Sem nenhuma, o sistema funciona e
simplesmente não tem canal ligado — não há estado quebrado.

> **A ideia inteira em uma frase:** WhatsApp, e-mail, chat do Bitrix24 e o que o
> N8N trouxer de Telegram, Slack ou SMS **são o mesmo problema** — uma mensagem
> de alguém que precisa virar chamado, e uma resposta que precisa voltar pelo
> mesmo caminho.

---

## 1. A decisão que define tudo: toda conversa é um chamado

A tentação é construir uma tela estilo aplicativo de mensagens: lista de
conversas à esquerda, balões à direita, atendente respondendo ali. Ela seria
bonita e criaria **dois lugares para atender a mesma coisa**.

A partir daí, "este cliente já foi respondido?" passa a ter duas respostas
possíveis, o SLA conta de um jeito na fila e de outro no chat, e o relatório de
satisfação ignora metade do atendimento.

Então: **não há caixa de resposta nos canais.** A mensagem que chega vira
chamado; o atendente responde no chamado, como sempre fez; e a resposta sai pelo
canal de onde a pergunta veio — sem ele precisar saber qual era.

O que as telas de canais fazem é o que o chamado não faz:

| Pergunta | Onde |
|---|---|
| De onde os chamados estão chegando? | `/conversas` |
| Quem é este número que ninguém identificou? | `/conversas/[id]` |
| O que falhou ao sair? | `/conversas` (indicador) e a própria mensagem |
| Como ligo mais um canal? | `/conversas/canais` |

---

## 2. Por que o N8N é o canal mais importante dos quatro

Porque ele é o único que não precisa ser escrito de novo.

Telegram, Slack, Instagram Direct, SMS, Microsoft Teams, Discord, um chatbot
próprio: cada um tem um formato de webhook, um jeito de autenticar e um jeito de
responder. Escrever um adaptador por canal é trabalho sem fim, e cada adaptador
novo é mais código para manter quando o provedor mudar a API.

O N8N (ou o Make, ou o Zapier, ou um script) já resolve esse problema para toda a
internet. O que falta é ele ter **para onde mandar** e **de onde receber**:

```
Telegram ─┐
Slack ────┤
SMS ──────┼──► N8N ──► POST /api/canais/<token> ──► chamado
Teams ────┤         ◄── POST <url de saída> ◄────── resposta
...    ───┘
```

Por isso o adaptador do N8N aceita o remetente em `de`, `from` ou `remetente`, o
texto em `texto`, `text`, `message` ou `body`, e o corpo como objeto ou como
array. Não é desleixo: é que o fluxo do outro lado é escrito por quem está
ligando o canal, e exigir um formato exato transformaria "ligar o Telegram em
cinco minutos" em "ler a documentação do campo certo".

**Comece por ele.** É o único que funciona sem conta verificada, sem aprovação de
ninguém e sem cobrança por mensagem.

---

## 3. Ligando cada canal

A URL de entrada é gerada ao salvar o canal e **aparece uma única vez** — mesmo
contrato dos tokens de painel de TV (ADR-006) e de inscrição do agente. O sistema
guarda só o SHA-256. Perdeu, cria outro canal.

```
https://sti.seu-dominio.com.br/api/canais/<64 caracteres hexa>
```

Essa URL **é a credencial de entrada** do canal. Nos canais que não assinam a
requisição (N8N e e-mail) ela é a *única* — daí os 32 bytes aleatórios.

### 3.1 WhatsApp pela API oficial da Meta (Cloud API v21)

É a única forma que não termina com o número banido. WhatsApp Web automatizado,
"API não oficial" e bibliotecas que simulam o aplicativo violam os termos, e a
Meta derruba o número — normalmente no dia em que o volume cresce, que é o dia em
que a empresa mais precisa dele.

O custo: conta Business verificada, número dedicado (o número **perde** o
aplicativo comum ao virar número de API) e cobrança por conversa.

| O que | Onde vai | Para quê |
|---|---|---|
| Access token | `secret_ref` | mandar a resposta |
| App Secret | `config.app_secret_ref` | conferir a assinatura do webhook |
| Phone number ID | `config.phone_number_id` | dizer por qual número sai |
| A URL do canal | Painel da Meta → Callback URL | receber |
| O trecho final da URL | Painel da Meta → Verify token | o aperto de mão |

**O verify token é o próprio token da URL.** São o mesmo valor, de propósito:
duas credenciais diferentes para a mesma coisa é uma a mais para perder.

Três coisas que quebram em silêncio, e o que o código faz com elas:

1. **A assinatura é conferida sobre os bytes crus.** Reserializar o corpo
   (`JSON.parse` + `JSON.stringify`) muda o espaçamento e o HMAC deixa de bater.
   O sintoma é "a Meta parou de entregar" — porque toda entrega passa a ser
   recusada. A rota lê os bytes antes de interpretar qualquer coisa.
2. **Sem App Secret configurado, o canal recusa tudo.** Fechado por falta de
   configuração, nunca aberto: um webhook de WhatsApp sem verificação aceita
   mensagem forjada de qualquer remetente, e mensagem forjada vira chamado com o
   nome de outra pessoa.
3. **A janela de 24 horas.** Fora dela, a Meta só aceita *template* aprovado. O
   erro 131047 é traduzido para essa explicação em `channel_messages.last_error`,
   em vez de ficar como um número.

O webhook da Meta também manda `sent`, `delivered` e `read` no mesmo endereço das
mensagens — três ou quatro eventos de status para cada mensagem de verdade. O
adaptador devolve zero mensagens para eles, e **isso é o caminho normal**, não um
erro.

### 3.2 Bitrix24

Já havia integração com o Bitrix24 nesta base ([docs/05](05-integracao-bitrix24.md)),
e ela é outra coisa: ali um **registro** externo (uma tarefa) é mapeado para um
chamado, campo a campo. Aqui é **conversa**.

O caminho escolhido é o de webhooks de entrada e saída, e não o conector de Open
Channels (`imconnector`):

| | Webhook (escolhido) | `imconnector` |
|---|---|---|
| Instalação | criar dois webhooks no painel | publicar um aplicativo |
| Aparece como | mensagem de um usuário | canal nativo no Contact Center |
| Depende de | nada | aprovação e manutenção de app |

O conector nativo é melhor para quem vive dentro do Bitrix24. O webhook funciona
hoje, com o que o cliente já tem. Quando o segundo cliente pedir o conector
nativo, ele entra — e a escolha fica registrada aqui para não ser refeita do
zero.

Dois detalhes do Bitrix24 que o adaptador trata:

- Os eventos chegam em `application/x-www-form-urlencoded`, com as chaves em
  MAIÚSCULAS dentro de `data[PARAMS]`. A rota aceita os dois formatos de corpo.
- Ele responde **HTTP 200 com `error` no corpo**. Tratar 200 como sucesso faria a
  resposta ser marcada como enviada sem nunca ter saído — o pior dos dois erros
  possíveis, porque o atendente acha que respondeu.

A URL de entrada do Bitrix24 contém o código secreto no próprio caminho. Por isso
ela mora numa variável de ambiente (`secret_ref`), e não num campo da tabela.

### 3.3 E-mail

Qualquer provedor de recebimento (Resend, Postmark, Mailgun, SES) apontado para a
URL do canal. O adaptador aceita o remetente em `from`, `From` ou `sender` e o
texto em `text`, `TextBody` ou `body-plain`, porque cada um deles nomeia os
campos do seu jeito.

O assunto entra **no corpo da mensagem**, nunca como título do chamado: o assunto
de um e-mail de resposta vira `Re: Re: Enc: ...` e o chamado nasceria com esse
nome.

**Este canal não confere assinatura, e isso está dito na tela.** Restrinja a
origem ao IP do provedor no proxy. A resposta sai pela caixa de saída que já
existe ([docs/13](13-notificacoes-e-trabalhos.md)) — `RESEND_API_KEY` e
`MAIL_FROM`, as mesmas de sempre.

### 3.4 N8N

Um nó HTTP apontando para a URL do canal, e uma URL de saída (em `secret_ref` ou
em `config.url`) para onde a resposta volta. Nada mais.

`verificar()` devolve `true` com o motivo escrito no código: a URL é a
credencial. É a mesma garantia de um webhook do Slack ou do Stripe sem assinatura
— nem mais, nem menos — e ela está dita em vez de implícita.

---

## 4. O que o banco garante (migração 0034)

Quatro tabelas: `channels`, `channel_contacts`, `channel_conversations`,
`channel_messages`.

**A mensagem é gravada antes de qualquer efeito.** O WhatsApp reentrega o webhook
quando não recebe 200 rápido o bastante — por desenho, não por defeito. Com a
gravação primeiro, a reentrega bate no índice único `(channel_id, external_id)` e
para ali. Com a gravação depois, ela viraria um segundo chamado.

**Uma conversa aberta por contato por canal**, garantido por índice único
parcial. Duas mensagens simultâneas do mesmo número não podem produzir dois
chamados — e "simultâneas" aqui é comum: quem manda "bom dia" e "a impressora
parou" manda duas mensagens em um segundo.

**Três travas contra o eco.** A resposta sai de uma trigger em
`ticket_comments`, e sem elas o sistema conversaria consigo mesmo:

1. Nota interna não sai (`visibility <> 'public'`). É a regra de sempre, e aqui
   ela impede vazar para o cliente o que foi escrito sobre o cliente.
2. Comentário que **veio** de uma integração não volta (`source = 'integration'`
   com `external_id`).
3. Só enfileira se existir conversa **aberta** para o chamado.

**O contato resolve para uma pessoa** pelo endereço exato (e-mail) ou pelos
**últimos 8 dígitos** do telefone (demais canais). Oito dígitos porque é o que
sobrevive a `+55 44 99988-7766`, `044999887766` e `99988-7766` escritos no mesmo
cadastro.

**Contato bloqueado tem a mensagem registrada e não abre chamado.** Registrar em
vez de descartar é deliberado: um bloqueio feito por engano precisa ser
descoberto, e "a mensagem sumiu" não deixa rastro nenhum para descobrir.

---

## 5. A saída, e por que canal pausado não é falha

A resposta vai para `channel_messages` com `status = 'na_fila'` e sai no mesmo
trabalho agendado dos e-mails ([docs/13](13-notificacoes-e-trabalhos.md)), com
cinco tentativas e espera crescendo ao quadrado até o teto de uma hora.

**Canal pausado é pulado, não falhado.** Contar como falha gastaria as cinco
tentativas durante a pausa, e as respostas seriam dadas como perdidas sem ninguém
ter errado — justamente quando alguém pausou o canal de propósito.

**Pausar também não desliga o webhook do provedor:** a rota continua respondendo
200 e descartando. A Meta desinscreve um webhook que devolve erro
repetidamente, e aí religar exigiria refazer a configuração dela. Pausado
significa "não processe", não "estou quebrado".

---

## 6. As credenciais, e o que a tela recusa

Nenhuma variável de ambiente deste módulo tem nome fixo. O canal guarda o **nome
da variável**, nunca o valor (ADR-009) — uma empresa com três números de WhatsApp
tem três variáveis com nomes diferentes, e um canal desligado não deixa
credencial órfã num campo de tabela.

A tela aceita em `secret_ref` (e em qualquer chave de `config` terminada em
`_ref`) apenas um identificador em maiúsculas: `^[A-Z][A-Z0-9_]{2,60}$`. Colar o
token da Meta é recusado com essa explicação em português — porque é exatamente o
que quem acabou de copiá-lo do painel vai tentar fazer.

Os nomes de exemplo estão em `.env.example`.

---

## 7. Permissões

| Chave | Teto | Quem usa |
|---|---|---|
| `canais.conversas.ver` | atendente | ler a caixa de conversas |
| `canais.conversas.responder` | atendente | classificar o contato |
| `canais.canais.ver` | admin | abrir a configuração |
| `canais.canais.gerenciar` | admin | ligar, pausar e religar canal |

Classificar o contato é permissão de **quem atende**, não de quem administra: é
na conversa que se descobre de quem é o número. A pessoa escreve "aqui é o Marcos
da Transportadora" e quem está lendo sabe — o administrador, diante de uma lista
de telefones, não sabe.

Configurar o canal é permissão de **admin** porque ali moram a referência da
credencial e o token de entrada. E `ver` é separado de `gerenciar` porque abrir a
tela revela **qual variável de ambiente cada canal usa** — mapa da
infraestrutura, que vale conceder sem o poder de desligar o WhatsApp da empresa
no meio do expediente.

---

## 8. O que não foi verificado

Honestidade sobre o alcance dos testes, do mesmo jeito que em
[docs/14](14-agente-de-inventario.md):

- **Nenhuma chamada real foi feita a provedor nenhum.** Não há credencial da Meta,
  do Bitrix24 nem de provedor de e-mail neste ambiente, e não há saída de rede
  para eles. Os payloads dos testes são os da documentação oficial, copiados —
  não inventados.
- O que **está** verificado: 771 asserções de schema no banco (incluindo entrada,
  deduplicação, as três travas de eco, isolamento entre tenants e as quatro
  permissões), 50 testes de unidade dos adaptadores e da drenagem, e o
  comportamento da rota de entrada com corpo cru, assinatura errada, canal
  pausado e canal inexistente.
- A primeira ligação real de cada provedor pode exigir ajuste de nome de campo.
  Os adaptadores registram o que não souberam ler em vez de descartar, para que o
  ajuste seja possível a partir do que ficou gravado.
