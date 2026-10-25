# 15 — Autoatendimento: base de conhecimento, catálogo e portal

**Status:** implementado (Onda 4 de [docs/12](12-paridade-milvus.md)).
**Depende de você:** nada de configuração. Depende de **escrever o primeiro
artigo** e **cadastrar o primeiro serviço** — e as duas coisas têm um caminho
curto.

> As três partes servem ao mesmo fim: **o chamado que não precisa ser aberto.**

---

## 1. Por que quase toda base de conhecimento morre

Não é falta de recurso. É que ninguém escreve.

A tela de "novo artigo" fica em branco porque escrever um artigo é um trabalho
que não tem dono, não tem hora e não resolve o chamado que está na fila agora.
Comprar uma ferramenta melhor não muda isso.

O que muda é **de onde o artigo nasce**. Em qualquer chamado resolvido há o botão
**Virar artigo**: o título, o problema e a solução já vêm preenchidos a partir do
próprio chamado. Quem acabou de resolver tem o texto na cabeça e a solução na
tela — é o único instante em que escrever custa pouco.

O que o sistema monta:

| Parte do artigo | De onde vem |
|---|---|
| Título | O título do chamado |
| O problema | A descrição do chamado |
| A solução | O **último comentário público** |
| Categoria | A categoria do chamado |

O último comentário **público**, e não o último de todos: o último costuma ser
uma nota interna (*"fechei, era o cabo"*), e o público é o que foi escrito para
alguém de fora entender — que é exatamente o registro de que um artigo precisa.

O sistema **não cria o artigo sozinho**. Ele monta o texto e abre o formulário.
Criar automaticamente encheria a base de rascunhos que ninguém revisou, e um
artigo errado é pior que artigo nenhum: quem o lê para de procurar.

### E o ciclo fecha

O artigo escrito a partir de um chamado **volta a aparecer no chamado seguinte
parecido**, na faixa *Base de conhecimento* no topo da tela do chamado. As
sugestões vêm da categoria e da busca no texto.

---

## 2. A base de conhecimento

### Quem lê o quê

| | Rascunho | Publicado interno | Publicado para solicitante |
|---|---|---|---|
| Quem escreve na base | ✅ | ✅ | ✅ |
| Quem atende chamados | — | ✅ | ✅ |
| Solicitante | — | — | ✅ |

**O artigo nasce interno.** Liberar para o solicitante é uma escolha explícita, e
o formulário diz o que ela significa com todas as letras — é o que impede a senha
do roteador de ir parar na tela de um cliente. Não dá para "despublicar" o que
alguém já leu.

### A busca ignora acento

Procurar por *manutencao* acha *manutenção*, e *impressoras* acha *impressora*.
Metade de quem digita numa caixa de busca não põe acento, e quem não acha abre um
chamado — que é exatamente o que a base existe para evitar.

A palavra no **título** pesa mais que no corpo: um artigo que menciona
"impressora" de passagem não ganha do que é sobre impressora.

### Texto simples, sem formatação

O corpo do artigo não tem negrito, lista nem link clicável. É deliberado:
formatação exigiria um renderizador e um sanitizador, e o artigo é lido por gente
de fora da equipe. Interpretar marcação escrita por terceiro num texto público é
um risco de segurança que não paga o que ganharia em negrito.

Quebras de linha e parágrafos funcionam, e respondem *"como trocar minha senha"*
tão bem quanto markdown.

### "Isto resolveu o seu problema?"

É a única pergunta no fim de cada artigo, e a única medida que diz se a base
funciona. O número de leituras diz o que as pessoas clicaram; o voto diz o que as
ajudou — e a razão entre os dois diz mais que qualquer um sozinho: 18 votos em 20
leituras e 18 em 2.000 são histórias diferentes.

O comentário só é pedido no **não**. Quem clicou em "sim" já respondeu tudo que
interessa; o "não" é a lista de tarefas de quem mantém a base, e sem o comentário
é só um número.

### Arquivar, não apagar

Artigo que deixou de valer sai da busca e continua existindo para quem escreve.
Uma resposta antiga ainda diz o que já se soube, e *"por que isto mudou?"* precisa
da versão anterior para ser respondida.

---

## 3. O catálogo de serviços

### O que ele resolve

Os pedidos que hoje chegam por e-mail — *"preciso formatar a máquina do fiscal"* —
chegam sem patrimônio, sem filial, sem prazo combinado e sem preço. O catálogo
transforma isso num formulário: o pedido chega **já classificado**, na fila
certa, com o que a equipe precisa saber.

**O pedido vira um chamado.** Não existe "pedido" como entidade separada — ele
teria o próprio estado, a própria fila e o próprio SLA, e a operação passaria a
olhar duas listas, uma delas sem histórico, comentários, anexos nem pesquisa de
satisfação.

### Preço: três coisas diferentes que não podem se confundir

| Na tela | O que significa |
|---|---|
| **Incluído no contrato** | Este cliente já paga por isto no pacote |
| **Sem custo** | É de graça para todo mundo |
| **Sob consulta** | Não há preço publicado; combina-se caso a caso |

No cadastro, deixar o preço **vazio** é "sob consulta"; **zero** é "sem custo".
Tratar vazio como zero faria um serviço sem preço aparecer como cortesia, e a
primeira cobrança seria uma discussão.

O preço por cliente vive em `service_catalog_clients`. Sem ele, o preço seria o
mesmo para todos — e a primeira negociação faria alguém manter uma planilha
paralela, que é onde o preço de verdade passaria a morar.

**Quem decide o preço é o banco**, não a tela: incluído no contrato paga zero,
negociado paga o dele, o resto paga a tabela. Repetir essa escolha na aplicação
faria o preço mostrado e o cobrado divergirem.

> A vitrine mostra **"a partir de"**, porque ela não sabe de qual cliente se
> trata. O preço real aparece depois de a filial ser escolhida, e fica gravado no
> chamado — a tabela pode subir depois, e o que foi combinado continua combinado.

### O formulário de cada serviço

Cadastrado como JSON, ao lado de um exemplo:

```json
[
  { "chave": "patrimonio", "rotulo": "Patrimônio do equipamento", "tipo": "texto", "obrigatorio": true },
  { "chave": "sistema", "rotulo": "Sistema desejado", "tipo": "escolha", "opcoes": ["Windows 11", "Ubuntu 24.04"] },
  { "chave": "urgente", "rotulo": "É urgente?", "tipo": "simnao" }
]
```

Quatro tipos: `texto`, `numero`, `escolha` e `simnao`. Data e arquivo ficaram de
fora — data exigiria fuso e validação de passado, arquivo exigiria o Storage e a
cota, e os dois apareceriam como campo quebrado antes de virarem recurso.

> **Por que JSON e não um construtor visual.** Um construtor — arrastar,
> reordenar, pré-visualizar — é um projeto em si, e construí-lo agora adiaria o
> catálogo inteiro. O JSON é feio e honesto: quem cadastra serviço num helpdesk é
> alguém de TI, o exemplo está na tela, e o erro é validado na submissão com
> mensagem em português.

---

## 4. O portal

`/portal` é a tela inicial de quem só pede. A ordem das seções é a ordem do que
resolve mais barato:

1. **Procure a resposta** — custa zero para a equipe.
2. **Peça um serviço** — chega classificado, sem ida e volta.
3. **Seus chamados** — o acompanhamento.
4. **Não achou? Abra um chamado** — o caminho mais caro para os dois lados.

Pôr o botão de abrir chamado no topo inverteria essa economia inteira. É
exatamente o que a maioria dos helpdesks faz.

### Por que não é um segundo aplicativo

O escopo pedia "portal do solicitante — enxuto, e é o que vira o PWA". A tentação
é um layout próprio, com menu e rotas próprias — e ela custa duas camadas de
navegação para manter, dois lugares onde uma permissão nova precisa ser
refletida, e dois lugares onde um defeito de sessão pode morar.

O que torna um portal enxuto não é o layout: é a **página** responder "o que você
precisa?" em vez de apresentar um sistema. O menu lateral já se filtra sozinho
pelas permissões desde a migração 0017 — um solicitante vê cinco itens, não vinte
e cinco.

**O PWA continua pendente**, e agora tem o que embrulhar.

---

## 5. Quem pode o quê

As chaves novas entram nos perfis de sistema automaticamente:

| Perfil | Lê artigos | Escreve | Pede serviço | Cadastra serviço e preço |
|---|---|---|---|---|
| Admin do Cliente | ✅ | ✅ | ✅ | ✅ |
| Gestor de TI | ✅ | ✅ | ✅ | ✅ |
| Operador de TI | ✅ | ✅ | ✅ | — |
| Gestor/Operador/Aprovador Financeiro | ✅ | — | ✅ | — |
| Solicitante | ✅ (só os publicados para solicitante) | — | ✅ | — |

**Escrever é de quem atende**, e é deliberado: o artigo nasce do chamado
resolvido. Uma base que só um redator pode escrever é uma base que não é escrita.

**Cadastrar preço é de gestor**: é decisão comercial, não operação.

---

## 6. Como começar, em três passos

1. **Abra um chamado já resolvido** e clique em *Virar artigo*. Revise, corte o
   que é específico daquele caso, marque *Publicar* e escolha quem pode ler.
   Repita com os cinco chamados que mais se repetem.

2. **Cadastre o serviço que mais chega por e-mail** em *Catálogo de serviços*.
   Dê fila, prazo e preço, e peça no formulário o que você sempre tem de
   perguntar de volta.

3. **Mande o pessoal usar `/portal`.** Quem só abre chamado já cai nele ao
   entrar.

O indicador para acompanhar está no topo da base: **artigos escritos a partir de
um chamado**. Se ele parar de subir, a base vai parar de crescer — independente
de quantos artigos já tenha.

---

## 7. O que esta onda deliberadamente NÃO fez

| | Por quê |
|---|---|
| PWA / aplicativo instalável | A tela existe e é o que ele embrulha. O PWA é trabalho de empacotamento (manifesto, service worker, modo offline), e sem o portal pronto não havia o que empacotar. |
| Construtor visual de formulário | Projeto em si. Adiaria o catálogo inteiro para melhorar a vida de quem cadastra um serviço por mês. |
| Semelhança semântica nas sugestões | Exige embeddings e um modelo — é a Onda 6. Um artigo relevante achado por categoria vale mais hoje que um artigo perfeito daqui a três meses. |
| ~~Aprovação do pedido de serviço~~ | **Construída na migração 0043.** O que estava escrito aqui era pior do que "não foi construído": a tela de pedido afirmava que o chamado ficaria aguardando, e ele não ficava — nascia como qualquer outro e era atendido. Ver abaixo. |

### A aprovação, desde a 0043

Um serviço marcado como "precisa de aprovação" faz o chamado **nascer** em
`waiting_approval` — não em aberto com uma etiqueta. A diferença é que não
existe caminho para atendê-lo: a transição `waiting_approval → in_progress` não
existe, e de lá só se sai aprovando (volta a `open`) ou recusando (vai para
`closed`, com o motivo obrigatório registrado como comentário público no
próprio chamado).

**O relógio do SLA fica parado enquanto espera.** O acordo é sobre o tempo de
atendimento, e o atendimento não começou; cobrar da equipe o tempo da decisão
seria cobrar o prazo de uma decisão que não é dela.

**Quem aprova é cadastro, não código.** Em branco, aprovam gestores e
administradores. Preenchido com um perfil de acesso, só quem tem aquele perfil
— e ter a permissão `autoatendimento.catalogo.aprovar` não basta. É o que
permite a um ambiente dizer "isto só o diretor aprova" sem uma linha de código
nova, e era exatamente o ponto que mantinha este item parado como "decisão do
cliente".
| Formatação no corpo do artigo | Exigiria renderizador e sanitizador num texto lido por gente de fora da equipe. |
| Versionamento de artigo | `audit_log` já registra cada edição com o valor anterior. Uma tela de "comparar versões" é outra coisa, e ninguém pediu ainda. |
