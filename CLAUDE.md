# CLAUDE.md — padrões de engenharia do STI.IARX

A referência longa, com o defeito que originou cada regra, está em
[`docs/padroes-de-engenharia.md`](docs/padroes-de-engenharia.md). As divergências
deste projeto estão no **fim deste arquivo**, cada uma com a razão e a medição.

---

Você trabalha sob os padrões abaixo. Eles vieram de um sistema multi-tenant em
produção e cada um existe por causa de um defeito real. Siga-os sem precisar ser
lembrado; quando um deles não couber neste projeto, diga por quê em vez de
descumprir em silêncio.

## Como trabalhar

- **Meça antes de afirmar.** Nenhuma afirmação de desempenho, cobertura ou
  correção entra sem número medido, na mesma base, antes e depois. Quando a
  medição contrariar sua leitura, a medição ganha e você diz isso em voz alta.
- **Comentário diz POR QUE, nunca O QUE.** O código já diz o que faz. O
  comentário carrega a decisão: a alternativa descartada, o defeito que a linha
  evita, o preço que se escolheu pagar. Quando a decisão tem custo, escreva o
  custo.
- **Mensagem de commit conta a história, não o diff:** o que acontecia antes do
  ponto de vista de quem usa, a decisão com a alternativa descartada, e o que foi
  medido depois. Nunca escreva um número que você não contou.
- **Entregue o pedido inteiro.** Nada de estreitar escopo em silêncio. Se parte
  estiver bloqueada, entregue o resto e diga explicitamente o que ficou de fora e
  por quê. Discordou da premissa? Diga em duas frases e continue construindo, com
  a suposição declarada.
- **Achado fora do escopo se relata**, e só se corrige se for pequeno, seguro e
  vizinho — dizendo que corrigiu.

## Arquitetura e dados

- **O domínio não conhece o transporte.** `domain/` tem a regra sem HTTP e sem
  framework; `routes/` é tradução fina. Regra que aparece em duas superfícies
  existe **uma vez** e as duas a chamam.
- **Multi-tenant é invariante, em três camadas:** middleware resolve o tenant e
  recusa quem não tem vínculo; toda consulta filtra por ele e valida referência
  cruzada antes de gravar; **gatilho do banco** carimba o dono — assim
  importador, webhook e código novo não conseguem criar registro órfão.
- **A recusa de recurso alheio é idêntica à de recurso inexistente**, ou ela
  conta a quem tenta quais ids existem.
- **Toda lista oferecida ao usuário passa pelo mesmo recorte das consultas** —
  `select`, autocomplete, seletor múltiplo. O formulário é que grava: uma opção
  alheia ali cria o registro de um tenant dentro de outro.
- **Dinheiro em centavos inteiros** (o resto do rateio vai nas primeiras
  parcelas, e "a soma fecha" é teste). **Data em formato ordenável** (`AAAA-MM`),
  exibida no formato humano.
- **Derivado nunca é armazenado.** Guarde a fonte; derive na leitura. Derivado
  gravado diverge no primeiro recálculo que ninguém rodou.
- **Nada é excluído em silêncio:** exclusão lógica com autor, momento e estado
  anterior. Excluir pai com filhos é **bloqueado**, não cascateado.
- **Importação idempotente:** identidade é o conteúdo, ou `(tenant, origem,
  id_externo)` quando a origem tem id. Linha inválida não derruba o lote; prévia
  antes de gravar, com o efeito de cada linha; "validar sem gravar" em transação
  desfeita; id repetido **dentro do arquivo** é erro, não upsert.
- **Template versionado**, com aba de instruções **derivada** da definição das
  colunas — escrita à mão ela diverge na primeira mudança. As duas pontas
  declaram a mesma versão com as mesmas colunas.
- **Toda tentativa deixa rastro, inclusive a que falha.** É o caso sem registro
  que alguém investiga ao perguntar "por que os dados não entraram?".
- **Migração roda contra cópia da base real antes da real**, com relatório
  conferível: quantos carimbados, quantos órfãos (zero), quantos duplicados
  evitados.

## Interface

- **Duas réguas de contraste, e elas não são a mesma:** preenchimento precisa de
  3:1, texto precisa de 4,5:1. A paleta de séries é desenhada para a primeira e o
  sistema a usa nas duas. Mantenha **duas rampas de tokens** (`--s1` /
  `--s1t`, `--bom` / `--bomtxt`) e um ajudante com **mapa explícito** entre elas.
  Confira nas quatro superfícies de cada tema, não só na principal.
- **Um estado que ninguém alcançou nunca foi medido.** Semeie o estado de erro, o
  vazio e o vencido, ou eles ficam sem conferência.
- **A cor nunca é o único canal:** símbolo e palavra junto, sempre.
- **Tema em três estados** (sistema, claro, escuro), escolha explícita vencendo a
  do aparelho, guardada no navegador e **carimbada antes do primeiro pixel**.
- **Tooltip e drill-down em todo gráfico e indicador.** O balão espera uns
  décimos antes de abrir (atravessar vinte barras não pode piscar vinte balões),
  mas o **foco do teclado não espera**; a posição é contida nas quatro bordas e a
  largura é medida, não presumida.
- **Clicar abre os registros com o MESMO recorte que produziu o número**, e o
  detalhamento mostra contagem, soma, o recorte aplicado e a marca "confere com o
  indicador" (ou "diverge", com o esperado). Lista paginada confere pela contagem
  do servidor, nunca pela soma do que está à vista.
- **Nem todo número vira botão:** mediana, percentual isolado e contagem de
  cadastro não têm registros por trás. **Número zero não abre** — detalhamento
  vazio faz duvidar do número.
- **Gatilho acessível de verdade:** `role="button"`, `tabindex="0"`, `aria-label`
  dizendo o que abre, foco visível, Enter e Espaço. `div` com `onclick` não é
  nada disso.
- **Tela flutuante é uma peça só:** cabeçalho e rodapé presos, só os dados
  rolando; redimensionável pela direita, baixo e canto (nunca pela esquerda ou
  topo); tamanho persistido **por espécie de tela**; `Esc` fecha só a de cima.
- **Blocos em acordeão, fechados por padrão**, e o que se guarda é o conjunto dos
  **fechados** — assim um bloco novo nasce aberto.
- **Toda lista ordenada por valor decrescente**, em cada nível.
- **O filtro não decide se dá para registrar.** O botão de criar nunca fica
  desabilitado pelo recorte; a unidade se escolhe dentro do formulário.
- **Recorte por tela, só de sessão.** Filtro global recorta o que não tem a ver.
  E **todo filtro diz o que faz**, com o texto num lugar só.
- **Estado vazio diz a CAUSA, não mostra zero.** Zero se lê como "não há
  problema"; "falta classificar" é outra coisa, e vem com o caminho para
  resolver. Sem dado, a meta não é atingida nem falhada.
- **Erro é acionável**, e tem **código** além da prosa — interface que ramifica
  por texto quebra na primeira melhoria de redação.

## Segurança e privacidade

- **Sem segredo padrão:** a aplicação recusa subir sem ele. Segredo guardado como
  hash, exibido em claro **uma vez**, comparado em tempo constante, girável.
- **Recusas distintas para causas distintas:** 401 segredo errado, 403 desligado
  de propósito, 503 sem segredo configurado.
- **Loopback por padrão**; expor é opção explícita, com proxy e TLS.
- **Sessão revalidada a cada requisição** contra o estado da conta.
- **Endereço público é configuração, não cabeçalho `Host`** — senão um pedido
  forjado entrega um link válido apontando para o site de quem pediu.
- **Recusa de login sempre com a mesma frase**, exista a conta ou não.
- **Exportação neutraliza fórmula** (`=`, `+`, `-`, `@` prefixados); a leitura
  desfaz.
- **Erro do banco não vaza schema** para a resposta.
- **Dado de cliente nunca entra no repositório.** Fixture é inventada — é por
  isso que pode ser versionada. Quando a suíte precisa do arquivo real, ela o lê
  de variável de ambiente e **se pula** quando ele não está presente.

## Verificação

- **Uma suíte que morre não é uma suíte limpa.** Decida "morreu" pelo rodapé que
  o interpretador imprime ao estourar, nunca procurando "Error" na saída. Cinco
  conferências deste sistema passaram meses verdes sem executar uma linha útil.
- **Cada suíte recebe a base que declara** — banco, servidor e porta próprios.
  Base compartilhada mutável mede a ordem em que as suítes rodaram.
- **Construa antes de medir, uma vez, e aborte se a construção falhar.** Medir o
  pacote da construção anterior dá verde em correção que não está lá. Nunca
  remonte no meio de uma varredura.
- **As três armadilhas da asserção**, que parecem defeito do produto:
  1. **número absoluto da base** → meça a **diferença** que a própria suíte
     causa (acrescente, nunca substitua, e exija o delta);
  2. **estado vazio suposto** → **crie** o vazio e **confira o preparo** antes de
     medir;
  3. **calendário escrito na asserção** → tire a data da própria tela e compare
     com hoje; exija a regra, não o número.
- **Nunca guarde o elemento para clicar depois.** Use `locator(...).first()`:
  "Element is not attached to the DOM" **mata** a suíte em vez de falhá-la.
- **A navegação do teste tem de repintar de verdade** — pedir a tela em que já se
  está pode ser um nada, e aí você lê a tela de antes da sua escrita.
- **Espere o que o produto espera:** leia o atraso da página, não copie o número.
- **Suíte de correção fica vermelha antes de ficar verde.**
- **Compare com a linha de base antes de dizer "sem regressão".**

## Padrões de domínio (quando couber)

- **Recorrência: guarde o fato, não as linhas.** "Até quando vale" é campo; a
  projeção é derivada. A identidade do contrato **não inclui o valor** (reajuste
  é o mesmo contrato); **linha real vence a projeção** (senão conta em dobro
  justo em quem lançou adiantado); ausência de vigência é "em aberto" — e a tela
  lista, do mais esquecido primeiro, quem está nessa situação.
- **Indicador que acumula não é julgado no meio do período** ("mês em curso", não
  "sem dados"); indicador cujo fato tem **data** é medido assim que a data chega,
  e o corte é **hoje**, não o fim do mês.
- **Duas medidas que discordam recebem dois nomes**, lado a lado, com a pergunta
  que cada uma responde.
- **Hierarquia valida quatro coisas:** não é pai de si, não é ascendente de si,
  mesmo conjunto, e a profundidade conta a subárvore que vem junto. O pai se
  escolhe numa lista, nunca se digita.
- **Entrada externa se normaliza para o estado conservador**, campo ausente ganha
  rótulo próprio, valor desconhecido entra **como veio com aviso**, e o vazio é
  **contado** no diagnóstico. Nada é inventado.
- **O payload entra no log ANTES de ser interpretado**; reprocessar vale só para
  evento com erro; o payload de teste percorre exatamente o mesmo caminho do de
  produção.
- **Permissão em três camadas** (módulo, ação, campo), conferidas no servidor; o
  front **pergunta** o que o perfil permite e, enquanto a resposta não chega,
  **não esconde nada**. O perfil fica no vínculo com o tenant, não no usuário, e
  sem perfil atribuído o papel anterior responde.

## Desempenho (quando chegar a hora)

Meça com amostragem de CPU, não com cronômetro aninhado — o cronômetro de quem
chama soma o de quem é chamado, e acusa o inocente. O padrão mais comum é função
barata chamada um milhão de vezes: guarde a última resposta com **chave de versão
dos dados**, nunca com o tamanho da coleção. *Cache que serve dado velho é pior
que o código lento que substituiu, porque lentidão se percebe e dado velho não.*
Dividir o pacote **sozinho** piora o caso comum: divida e adiante o módulo da
tela pedida, e meça com a rede estrangulada.

---

# Onde o STI.IARX diverge, e por quê

Esta seção existe porque o próprio padrão manda: *"quando um deles não couber
neste projeto, diga por quê em vez de descumprir em silêncio."* Cada item abaixo
foi **medido** contra o banco, não lido.

## 1. Derivado É armazenado — mantido por gatilho

O padrão diz "derivado nunca é armazenado; guarde a fonte, derive na leitura".
Este projeto tem **três derivados como coluna**, mantidos por gatilho no banco:

| coluna | derivada de | gatilho |
| --- | --- | --- |
| `rental_invoices.total` | soma de `rental_invoice_items.amount` | `trg_rental_invoice_items_total` |
| `part_balances.quantity` | soma de `part_movements.quantity` | gatilho da 0053 |
| `rental_invoices.number` | `código/AAAAMM` + sufixo de reemissão | `trg_numerar_fatura` |

**Por que a divergência se sustenta aqui, e onde ela deixaria de sustentar.**

O perigo que o padrão descreve é o derivado que **diverge da fonte no primeiro
recálculo que ninguém rodou**. Esse perigo pressupõe que o recálculo seja um
passo separado — um job, um botão, uma rotina de fechamento. Aqui ele não é: o
gatilho roda dentro da mesma transação que altera a fonte, e não há caminho de
escrita que escape dele, porque a RLS obriga toda escrita a passar pela tabela.

O que se compra com isso é consulta: `part_balances` é lido em tela de estoque a
cada abertura, e derivar a soma de `part_movements` na leitura é varrer o
extrato inteiro para mostrar um número.

**A divergência deixa de se sustentar no dia em que alguém escrever na fonte por
fora do gatilho** — um `COPY` de carga, uma migração que mexe em
`part_movements` com o gatilho desabilitado, um `service_role` escrevendo
direto.

O que protege isso é a **§60 de `schema_test.sql`**, escrita junto com esta
seção. Ela não confere o derivado contra um número esperado — isso a §51 já
fazia, e prova apenas que o gatilho somou certo *naquele cenário*. A §60 confere
o derivado contra a **própria fonte, em toda linha do banco**:

- todo `part_balances.quantity` é exatamente `sum(part_movements.quantity)`;
- todo `rental_invoices.total` é exatamente `sum(rental_invoice_items.amount)`;
- nenhum `rental_invoices.number` se repete dentro da mesma empresa;
- e o invariante continua valendo **depois de mexer na fonte** — a seção cria a
  própria fatura, acrescenta dois itens (dois, para que a conta seja uma soma e
  não uma cópia do último valor), remove e confere a volta.

É a diferença entre *"a conta que eu fiz bateu"* e *"não existe linha em que a
conta não bata"*.

> A primeira versão dessa asserção **procurava** uma fatura `draft` com itens e
> envolvia tudo num `if ... is not null`. Não havia fatura assim na semente: o
> bloco inteiro passou sem executar uma asserção e o relatório saiu verde. É a
> armadilha do *estado vazio suposto*, da Parte 5 — e ela pegou quem a estava
> escrevendo. A versão commitada **cria** o estado.

## 2. Dinheiro em `numeric`, não em centavos inteiros

O padrão pede centavos inteiros. Este projeto usa `numeric(14,2)` (25 colunas),
`numeric(14,4)` (9, para preço unitário) e `numeric(12,2)` (2).

**Diverge na letra, não no motivo.** A razão escrita no padrão é que *"ponto
flutuante perde centavo no rateio"* — e `numeric` do PostgreSQL **não é ponto
flutuante**: é decimal exato, de precisão arbitrária. O defeito que a regra
evita não existe aqui.

O que **continua valendo** é a propriedade que o padrão cobra junto: *"a soma
fecha"*. Ela é verificada contra o banco em `schema_test.sql`, e foi ela que
pegou a fatura cujos itens somavam diferente do total.

`numeric(14,4)` em preço unitário é deliberado: o excedente de horímetro é
cobrado por hora a `R$ 38,50`, mas há contrato com preço de quatro casas, e
arredondar na origem faria a fatura fechar errado por centavos que o cliente
confere.

## 3. Estrutura de pastas

O padrão descreve `src/domain/`, `src/routes/`, `src/db/`. Este projeto é
Next.js App Router, e a separação equivalente está nos ADRs
([docs/03](docs/03-arquitetura.md)): a regra mora no **banco** (funções
`security definer`, gatilhos, RLS), as Server Actions são a camada fina de
tradução (ADR-011), e `src/lib/` guarda o que precisa existir uma vez só nas
duas superfícies — o motor de mapeamento roda no app, na Edge Function e nos
testes.

A razão do padrão — *"a regra fica testável sem servidor"* — é atendida por
`supabase/tests/schema_test.sql`, que exercita a regra contra PostgreSQL de
verdade sem subir a aplicação.

## 4. Os dois erros que este padrão teria evitado, e que eu cometi

Registrados aqui porque o padrão diz que a razão de uma regra é o que impede que
ela seja desfeita por quem não viu o estrago. Os dois aconteceram na mesma
varredura:

**Uma suíte que morre não é uma suíte limpa — e o inverso também engana.** O
laço que eu usava decidia "passou" procurando a frase `TODAS AS ASSERÇÕES
PASSARAM` na saída. `telas.spec.mjs` não imprime essa frase: ela termina com
`0 rota(s) com problema de 49`. A suíte estava verde e foi relatada como
vermelha. Pior: uma suíte que **morresse** antes da primeira asserção seria
relatada do mesmo jeito, sem distinção.

**Nunca remonte no meio de uma varredura.** Rodei `npm run build` com o servidor
de pé servindo a varredura, reescrevendo `.next` debaixo dele. As últimas telas
tomaram 500 por minha causa, não por defeito do produto.

As duas coisas agora têm remédio commitado: `scripts/verificar.sh` constrói uma
vez antes da primeira suíte, aborta se a construção falhar, recusa rodar se a
porta já estiver ocupada, e decide "morreu" pelo rodapé do Node — nunca
procurando uma frase de sucesso.
