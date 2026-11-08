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

**A barra não é o único caminho — e não deveria ser.** São 45 telas em oito
gavetas: quem usa todo dia decora, quem usa uma vez por mês não. A paleta de
comandos (`⌘K` / `Ctrl+K`, `components/paleta.tsx`) abre de qualquer tela com
**telas, ações e registros na mesma caixa**. Ter os três juntos é o que a
justifica: se fosse só navegação, a barra já bastava.

Ela lê as telas de `visibleNavGroups`, a mesma fonte do menu — a paleta **não
pode oferecer o que o menu esconde**, e a busca de registros confere a mesma
permissão granular que governa cada tela. Sem isso, a conveniência viraria a
porta dos fundos. Há asserção para isso em `demo/tests/local/paleta.spec.mjs`.

A caixa visível no cabeçalho existe porque atalho que ninguém descobre não é
atalho, é segredo — e porque quem não usa teclado precisa chegar lá clicando.

**No celular, a mesma sanfona, em gaveta.** A tira horizontal com trinta e
poucos destinos saiu: o item que interessava quase nunca estava visível, rolar
de lado é o gesto que ninguém procura, e ela não mostrava os GRUPOS — a
organização que existe no desktop simplesmente não existia no celular. A gaveta
reaproveita `SidebarNav`, não uma cópia.

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
| **A paleta**: atalho em qualquer tela, telas/ações/registros, teclado, e a busca que NÃO é porta dos fundos | `demo/tests/local/paleta.spec.mjs` |
| **A lista**: visões e contagens, filtro sem botão, ordenação, densidade lembrada, teclado, ação em massa, e a barra que não oferece o que a permissão não dá | `demo/tests/local/lista.spec.mjs` |
| **Celular**: nenhuma das cinco telas conferidas rola de lado; a tabela vira ficha | `demo/tests/local/lista.spec.mjs` §8 |
| **A gaveta**: endereço que se manda, Esc que não perde o filtro, J/K trocando o chamado aberto, volta honesta na edição recusada, e o que a permissão não dá | `demo/tests/local/gaveta.spec.mjs` |
| Nenhum texto da URL vira nome de coluna na consulta (inclui `__proto__`) | `src/lib/data/ordenacao.test.ts` |
| O endereço preserva filtro, remove o que esvazia e volta para a página 1 | `src/lib/data/endereco.test.ts` |

O teste de navegador não é enfeite: foi ele que achou `ROLE_RANK` invertido no
protótipo e as regras de perfil paradas antes da migração 0020 — dois defeitos cujo
sintoma era um **botão ausente**, não um erro.

## 8. Lacunas

- ~~**`[LACUNA]` Busca global.**~~ **Resolvida** pela paleta de comandos: ela
  busca telas, ações e registros (chamado, ativo, cliente) na mesma caixa, sob
  RLS e sob a mesma permissão granular das telas (`src/app/api/busca/route.ts`).
- **`[LACUNA]` Favoritos ou itens recentes.** Quem usa três telas todo dia não
  deveria percorrer o menu. Depende de gravar preferência por usuário.
- ~~**`[DECISÃO PENDENTE]` Barra compacta de celular.**~~ **Decidida**: gaveta,
  com os mesmos oito grupos do computador, reaproveitando `SidebarNav`. A tira
  horizontal saiu.
- **`[LACUNA]` Visões salvas pela pessoa.** As cinco visões da lista de chamados
  são fixas, escritas no código. Guardar uma visão própria ("críticos da minha
  filial sem atendente") exige tabela com RLS por dono — está descrito na §9 e
  não foi feito nesta fase, de propósito: o padrão da lista precisa ser aprovado
  antes de ganhar persistência.

## 9. A lista de trabalho

A lista de chamados deixou de ser uma tabela com formulário em cima e virou o
padrão que as outras 17 listagens vão seguir. O que mudou, e por quê:

| Antes | Agora | Por quê |
|---|---|---|
| 5 linhas por tela de 900px | 14 linhas (densidade compacta, lembrada) | Trinta chamados abertos eram seis rolagens para ter ideia do dia |
| Botão "Filtrar" entre a pergunta e a resposta | Filtro instantâneo em chips; o filtro É o endereço | Uma lista filtrada é uma pergunta, e pergunta se manda para outra pessoa |
| Ordem fixa por score, invisível | Cabeçalho ordena, com `aria-sort` e direção na URL | "O que vence primeiro" era a pergunta mais feita e não tinha resposta |
| Uma ação por vez, três telas por chamado | Seleção múltipla e barra de ação em massa | Atribuir três chamados eram doze cliques |
| Nada de teclado | `J`/`K` anda, `X` marca, `Enter` abre, `Esc` limpa | É o padrão de Linear, Superhuman e Front; quem trabalha na lista o dia todo não quer o mouse |
| Coluna de SLA repetindo "No prazo" | O prazo é o semáforo: cor + palavra | 160px de coluna para repetir a mesma palavra, que o título não tinha |

Três decisões que não são óbvias:

- **As visões são parâmetros, não um modo.** "Sem atendente" é
  `?atendente=nenhum`, não `?visao=sem`. Por isso a aba combina com qualquer
  filtro, o endereço continua explicando a si mesmo, e não existe um segundo
  caminho de filtragem no servidor para manter em dia com o primeiro.
- **A seleção é o único estado em memória.** Filtro, ordem e página vivem na
  URL; a seleção morre ao trocar de página — de propósito, porque uma ação em
  massa sobre chamados que a pessoa não está vendo é o defeito caro. Quem zera
  é a `key` do componente, derivada da consulta; não há efeito limpando estado.
- **A ação em massa escreve uma linha de cada vez.** A máquina de estados vive
  no banco (ADR-007): num `update … in (…)`, um chamado em transição proibida
  derrubaria os outros quarenta e nove. O retorno diz quantos ficaram de fora.
  E a permissão é conferida POR AÇÃO — não existe "permissão de lote".

## 10. Editar sem sair da lista

A lista ficou boa de ler; faltava poder AGIR nela. Trabalhar um chamado era
sair da lista, abrir a tela dele, mexer, voltar — e voltar significava
recomeçar do topo. Numa triagem de trinta chamados, trinta idas e voltas.

| O que | Onde fica | Por quê |
|---|---|---|
| Ler, responder e mudar estado | **Gaveta** ao lado da lista (`?aberto=<id>`) | A lista continua à vista; `J`/`K` passam de chamado com ela aberta, que é como se tria uma fila inteira |
| Trocar status ou atendente | **Na própria linha** | São as duas mudanças de um campo só que acontecem o dia inteiro |
| Anexos, vínculos, IA, trilha, aprovação | **`/tickets/[id]`**, intacta | Link de e-mail não pode quebrar, e o que pede a tela inteira continua tendo a tela inteira |

Quatro decisões que não são óbvias:

- **A gaveta é renderizada no SERVIDOR.** `?aberto=` é lido pela página, que
  monta o conteúdo com as mesmas consultas, o mesmo RLS e as mesmas permissões
  da tela. Não existe rota de API nova devolvendo chamado em JSON — uma
  segunda porta para os mesmos dados é como se esquece uma conferência que a
  primeira fazia.
- **O título aponta para a página inteira e o clique é interceptado.** Assim
  clicar fica no contexto da lista, e Ctrl+clique, botão do meio e "abrir em
  nova aba" continuam levando à página — que é o que o navegador promete ao
  mostrar o endereço na barra de status.
- **Com a gaveta aberta, três colunas somem** (fila, prioridade, atendente).
  Elas estão todas na gaveta; o que a lista precisa manter nessa largura é o
  que permite escolher o próximo: número, título, estado e prazo.
- **A gaveta é desenhada no `<body>`, por portal.** O `<main>` tem animação de
  entrada em `transform`, e elemento com animação de transform vira bloco de
  contenção de descendentes `fixed`: a folha de celular ficava com 16px de
  sobra de cada lado — o `px-4` do contêiner — parecendo cartão solto em vez
  de folha subindo da borda do aparelho.

**Resposta imediata, com volta honesta.** O valor novo aparece antes de o
servidor responder, porque esperar olhando para o valor velho faz a pessoa
clicar de novo. O que costuma vir junto com interface otimista é o defeito
oposto — dizer "salvo" para o que não salvou —, e aqui ele é impossível: a
máquina de estados vive no banco (ADR-007), e quando a transição é recusada o
valor **volta ao que era** com a mensagem ao lado. Há asserção para isso em
`gaveta.spec.mjs` §4, que força uma transição proibida de propósito.

**Quem não pode editar vê texto, não controle inerte.** Seletor desabilitado
não explica nada, rouba uma parada de tabulação e ainda anuncia
"indisponível" no leitor de tela: três incômodos para informar zero.

**A tabela vira ficha no celular.** Abaixo de `lg`, `<Table>` empilha cada linha
com o rótulo da coluna ao lado do valor (`.tabela` em `globals.css`). O rótulo
vem do próprio `<thead>`, carimbado em cada célula — não há lista de nomes
duplicada, e renomear uma coluna continua sendo um lugar só. Antes disso, duas
telas empurravam a PÁGINA inteira para os lados (892px de documento em 390px de
aparelho) e todas cortavam na terceira coluna.
