# 08 — Arquitetura de informação: menu, nomenclatura e agrupamento

**Status:** implementado.
**Fonte única:** `src/lib/navigation.ts`. O protótipo (`demo/sti-tool.html`) carrega
uma cópia da estrutura, e `src/lib/permissions.demo.test.ts` cobra que as duas não
divirjam.

## 1. O problema

O menu era uma **lista plana de 16 itens**, e o roteiro previa 25. Lista plana
funciona até uns sete itens; passando disso, quem usa relê o menu inteiro toda vez
para achar um item, porque não existe ponto onde a vista descanse. Agrupar deixou
de ser questão de estética.

Havia também um defeito estrutural: a lista morava dentro de
`src/app/(app)/layout.tsx`, então `requireScreen()` não tinha como saber para onde
mandar quem fosse negado — mandava sempre para `/painel`. Como os perfis
financeiros não recebem o módulo de helpdesk, `/painel` negava e redirecionava
para `/painel`. **Um Aprovador Financeiro nunca conseguiria entrar no sistema.**

## 2. Princípios adotados

**Agrupar por trabalho, não por tabela.** Os grupos respondem "o que eu vim fazer
aqui": atender, cobrar e pagar, cuidar do parque, cadastrar, conectar,
administrar. Menu que espelha o modelo de dados obriga quem usa a conhecer o
modelo de dados.

**Sete grupos, no máximo.** É o teto prático de uma barra lateral que se lê de
relance. O que se usa todo dia fica no topo; configuração, no fim.

**Grupos em sanfona, com uma setinha.** Esta decisão foi revertida, e vale
registrar o que ela substituiu.

O texto anterior dizia *"sempre expandido, sem acordeão"*, e o argumento era
bom: o menu já chega filtrado por permissão, então o acordeão custaria um clique
para resolver um problema de altura que a filtragem já resolvia.

O que o argumento não pesava: **para quem enxerga tudo, a lista passou de vinte
e cinco para trinta e três itens em oito grupos.** Nesse tamanho o cabeçalho
deixa de servir para a vista pular — vira mais uma linha de ruído — e a barra
passa a rolar, que é quando um menu começa a esconder sem avisar e sem oferecer
nada em troca.

**E é sanfona: um grupo aberto de cada vez.** A primeira versão deixava vários
abertos ao mesmo tempo, e isso resolvia a altura só enquanto ninguém abrisse
tudo — com oito grupos a barra voltava a rolar, que era o problema de origem.
Com um aberto de cada vez a altura passa a ter teto: **o maior grupo, e não a
soma deles.**

O custo é real e não vale esconder: ir e voltar entre dois grupos fecha o
anterior toda vez. As três regras abaixo existem para que esse custo não vire
perda de contexto, e valem nesta ordem de precedência.

| # | Regra | Por quê |
|---|---|---|
| 1 | A escolha de quem está na tela manda, enquanto a tela for a mesma | Clicou, abriu; clicou de novo, fechou tudo. Quem fecha manda |
| 2 | Ao trocar de tela, o grupo da tela nova abre sozinho | Estar numa tela e não ver onde ela fica é pior que repetir a última escolha — e numa sanfona é pior que num acordeão livre, porque não sobra nenhum outro grupo aberto para dar contexto. A escolha guarda **onde** foi feita: não é esquecida, é suspensa |
| 3 | Numa tela que não pertence a grupo nenhum, a escolha anterior volta a valer | `Visão geral`, `Portal` e `Minha conta` estão soltos. Se a regra 2 fosse cega, ir à Visão geral fecharia a barra inteira e obrigaria a abrir uma gaveta para ir a qualquer lugar |

Na primeiríssima visita não há escolha nem grupo ativo: abre **Atendimento**, o
primeiro. Uma sanfona não tem como chegar toda aberta, e chegar toda fechada
obrigaria a caçar antes de conhecer.

A objeção original — *"cria estado: qual grupo estava aberto?"* — fica
respondida de um jeito mais barato que antes: o estado deixou de ser um booleano
por grupo e virou **um nome só**, em `localStorage`. Oito booleanos descreveriam
estados que não existem mais, e dois deles dizendo "aberto" seria um estado
impossível, guardado.

É `<details>`/`<summary>`, não um acordeão escrito à mão: vem com teclado,
`aria-expanded` e busca-na-página do navegador de graça.

**Grupo vazio desaparece inteiro, cabeçalho incluído.** Cabeçalho sozinho anuncia
a existência de um módulo sem dar acesso a ele, e isso só gera pergunta para o
suporte.

**Destino fora de grupo.** `Visão geral`, `Portal` e `Minha conta` não têm
cabeçalho: são destino, não categoria. E, agora que os grupos fecham, há um
motivo a mais — **o que é destino de todo mundo não pode depender de alguém ter
aberto a gaveta certa.**

A `Visão de resultado` saiu do topo e foi para **Gestão**, junto de Projetos. O
argumento antigo (ela não pertence a Financeiro nem a Atendimento) continua de
pé; o que mudou é que agora existe um grupo que é exatamente dela — a pergunta
"como a TI está indo", em vez de "o que está acontecendo agora".

## 3. A estrutura

| Grupo | Itens |
|---|---|
| — | Visão geral |
| — | Portal |
| **Atendimento** | Tickets · Abrir ticket · Filas · SLA e prazos · Expediente e feriados · Satisfação · Conversas |
| **Autoatendimento** | Base de conhecimento · Catálogo de serviços |
| **Gestão** | Visão de resultado · Projetos |
| **Inventário e monitoramento** | Inventário de TI · Agentes nas máquinas · Software instalado · Telefonia · Links de internet · Mapa das filiais |
| **Financeiro** | Títulos a pagar · Títulos a receber · Contas bancárias · Centros de custo · Fluxo de caixa · Orçamento de TI |
| **Clientes e contratos** | Clientes e filiais · Fornecedores e contratos |
| **Integrações** | Sistemas de tickets · Sugestões de IA · *Bancos de dados* · *Pagamento bancário* · *Recebimento bancário* |
| **Administração** | Usuários · Preferências do ambiente · Perfis de acesso · Painéis de TV · Trilha de alterações · Trabalhos agendados |
| — | Minha conta |

### Por que estes grupos, e não outros

O agrupamento segue as **áreas que as fontes atribuem ao Milvus** — o
concorrente que [docs/12](12-paridade-milvus.md) inventariou com referência:
help desk, omnichannel, base de conhecimento, catálogo de serviços, portal/ESM,
gestão de contratos, inventário com agente e monitoramento, dashboards e
integrações.

Daí três renomeações e duas separações:

| Antes | Agora | Por quê |
|---|---|---|
| `Infraestrutura` | `Inventário e monitoramento` | É o nome da área no Milvus, e é mais exato: "infraestrutura" descreve o que as coisas **são**; este grupo responde o que se **faz** com elas |
| `Cadastros` | `Clientes e contratos` | "Cadastro" é o que a tela faz, não o que ela guarda. Obrigava a abrir para descobrir o conteúdo |
| Base e catálogo dentro de `Atendimento` | Grupo `Autoatendimento` | As duas não servem a quem atende, servem a quem pergunta. Enquanto a barra era sempre expandida, um grupo de dois itens era um cabeçalho a mais; com grupos recolhíveis, é uma linha |
| `Projetos` dentro de `Atendimento` | Grupo `Gestão`, com a Visão de resultado | Cronograma e resultado respondem à mesma pergunta, e não é a de quem atende |
| `Sugestões de IA` em `Administração` | `Integrações` | A [página do Milvus sobre ChatGPT](https://milvus.com.br/chat-gpt) manda colar o token "na área de integrações" — e é isso que a tela é: credencial e teto de gasto. O que decide o grupo é **com quem a tela fala**, não quem a abre |

**O que eu não consegui confirmar, e registro para não virar requisito
inventado:** a **barra lateral literal do Milvus** não aparece em nenhuma fonte
pública alcançável — nem documentação, nem resenha. O que está acima segue as
**áreas** que as fontes atribuem ao produto, não uma captura de tela do menu
deles. Meia hora de demonstração resolveria a diferença, e é o mesmo aviso que a
docs/12 já fazia sobre o resto do inventário.

**Duas divergências deliberadas:** `Financeiro` e `Gestão` não têm
correspondente no Milvus. São o que a docs/12 §2.1 chama de *"o que seria
burrice perder"* — apagá-los para parecer com o concorrente seria copiar o mapa
e jogar fora o território.

*Itálico* = previsto, sem tela ainda.

**`Automação (N8N)`, `WhatsApp` e `Telegram` saíram de Integrações**, e não por
mudança de ideia sobre o menu: os três foram entregues (migração 0034) como
**canais de conversa**, em `Atendimento → Conversas`. Mantê-los ali anunciaria
como futuro o que já existe. E o grupo Integrações trata de mapear um *registro*
externo para um chamado, enquanto aqueles três são *conversa* — públicos
diferentes, no mesmo menu. O Telegram não tem item próprio em lugar nenhum: ele
entra pelo canal genérico do N8N, que é exatamente o motivo de aquele canal
existir.

## 4. Nomenclatura: as decisões e o porquê

| Escolhido | Descartado | Motivo |
|---|---|---|
| **Títulos a pagar / a receber** | Contas a pagar / a receber | No mesmo grupo existe **Contas bancárias**. A palavra "contas" com dois sentidos a dois itens de distância é fonte de erro de leitura. "Título" é o termo que o financeiro brasileiro já usa. |
| **SLA e prazos** | SLA | Metade de quem abre a tela não sabe o que é a sigla. "Prazos" diz o que se vai encontrar. |
| **Mapa das filiais** | Mapas | "Mapas" não dizia o mapa de quê. |
| **Inventário de TI** | Inventário | Distingue de inventário de estoque, que não existe aqui e seria a suposição natural. |
| **Fornecedores e contratos** | Fornecedores | A tela tem as duas coisas, e o contrato era o que as pessoas não encontravam. |
| **Visão geral** | Painel, Dashboard | "Painel" já é usado em "Painéis de TV", e "Dashboard" é palavra de fora. |
| **Sistemas de tickets** | Integrações, Bitrix24 | O grupo já se chama Integrações; o item precisa dizer que TIPO de integração. Nomear pelo fornecedor amarraria o rótulo a um produto. |

**Ordem dentro do grupo não é ordem de construção.** No Financeiro, os títulos vêm
antes dos centros de custo: título se lança todo dia, centro de custo se cadastra
uma vez. É a única divergência da ordem em que o escopo listou os itens, e é
deliberada.

## 5. Itens previstos ("em breve")

Sete subgrupos de integração foram pedidos e **um existe**. Os outros seis entram
no menu marcados como previstos, por decisão tomada com o cliente: o menu passa a
comunicar o roteiro.

Os **seis previstos são hoje todos de Integrações**. *Fluxo de caixa* e *Links de
internet* saíram da lista: ganharam tela e chave própria nas migrações 0021 e 0022,
que é como um previsto deve terminar — a permissão entra junto com a tela, nunca
antes.

Três regras impedem que isso vire promessa vazia:

1. **Não recebem chave no catálogo de permissões.** Permissão que não governa tela
   é configuração morta — o administrador desmarca e nada acontece. Esse defeito
   já foi corrigido em seis chaves nesta base, e a regra existe para não repeti-lo.
2. **Não fazem o grupo aparecer sozinhos.** Sem pelo menos um item real
   alcançável, o grupo todo desaparece; senão um menu inteiro de promessas surgiria
   para quem não tem acesso a nada daquele módulo.
3. **Carregam a explicação.** Cada um tem um `hint` dizendo o que vai fazer e do
   que depende, exibido no `title`. "Em breve" sem prazo nem escopo é ruído.

São `<span>`, não `<button disabled>`: botão desabilitado sai da ordem de tabulação
sem explicar por quê, e leitor de tela anuncia "botão indisponível", que não
informa nada. Aqui o selo "em breve" está no texto lido.

## 6. A Visão geral

`/painel` deixou de ser "painel do helpdesk" e passou a ser a tela inicial de todo
mundo, com **blocos por módulo**: Financeiro, Atendimento, Infraestrutura. Cada
bloco exige a permissão do seu módulo, e nenhuma consulta é feita para bloco
invisível — além de não desperdiçar viagem ao banco, evita a leitura errada de "a
query voltou vazia" quando o certo é "esta pessoa não olha para isso".

O item de menu **não exige permissão**. Exigir `helpdesk.painel.ver` no destino
padrão era a causa raiz do laço de redirect; agora essa chave governa apenas o
bloco de atendimento dentro da página.

Quem não alcança bloco nenhum recebe um aviso explícito, em vez de uma tela vazia.

## 7. Como isso é verificado

| O que | Onde |
|---|---|
| Teto de 8 grupos, nenhum grupo com um item só, rótulo e href únicos, permissão existente no catálogo | `src/lib/navigation.test.ts` |
| Grupo desaparece inteiro; previsto não faz grupo aparecer; ordem preservada | `src/lib/navigation.test.ts` |
| Destino pós-negação nunca é tela negada, e nunca é `/conta` como 1ª opção | `src/lib/navigation.test.ts` |
| Estrutura do protótipo idêntica à da aplicação | `src/lib/permissions.demo.test.ts` |
| Comportamento em navegador: grupos, "em breve", separação de função | `demo/tests/prototipo.spec.mjs` |
| A projeção de caixa reage ao percentual, e só nas entradas | `demo/tests/prototipo.spec.mjs` §11 |
| Links some do menu de quem não tem `conectividade`; Operador de TI não cadastra | `demo/tests/prototipo.spec.mjs` §12 |
| Área com nome repetido é recusada sem diferenciar maiúsculas | `demo/tests/prototipo.spec.mjs` §13 |
| Operador de TI consulta o parque e não transfere custódia | `demo/tests/prototipo.spec.mjs` §14 |
| **O menu abre e fecha**: clique, setinha girando, preferência que persiste, grupo da tela atual abrindo sozinho, Enter no teclado | `demo/tests/local/menu.spec.mjs` |

O teste de navegador não é enfeite: foi ele que achou `ROLE_RANK` invertido no
protótipo e as regras de perfil paradas antes da migração 0020 — dois defeitos cujo
sintoma era um **botão ausente**, não um erro.

## 8. Lacunas

- **`[LACUNA]` Busca global.** Com 25 itens, procurar pelo nome vale mais que
  navegar. Não implementada: exige indexar ticket, ativo, título e cliente, e a
  decisão de o que entra na busca é de produto.
- **`[LACUNA]` Favoritos ou itens recentes.** Quem usa três telas todo dia não
  deveria percorrer o menu. Depende de gravar preferência por usuário.
- **`[DECISÃO PENDENTE]` Barra compacta de celular.** Hoje é a lista plana sem
  grupos, porque cabeçalho de grupo numa tira horizontal ocuparia o espaço dos
  próprios itens. Com 25 itens ela fica longa; a alternativa é um menu em gaveta.
