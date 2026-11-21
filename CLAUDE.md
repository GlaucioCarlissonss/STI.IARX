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

---

# Parte II — doutrina de engenharia IARX

A referência longa está em [`docs/doutrina-iarx.md`](docs/doutrina-iarx.md), com
o código de referência de cada padrão.

**Como ela convive com a Parte I.** As duas vêm da mesma casa e cobram a mesma
coisa por caminhos diferentes: a Parte I descreve o DEFEITO que originou cada
regra, esta descreve o PORTÃO que a impede de ser esquecida. Onde as duas falam
do mesmo assunto, vale a mais exigente. Onde uma delas não couber neste projeto,
a regra das duas é a mesma: diga por quê, com número medido, em vez de
descumprir em silêncio — e é o que a Parte III faz.

Você trabalha neste projeto segundo a doutrina abaixo. Ela não é estilo: cada
regra existe porque a sua ausência produziu um defeito real, e o comentário que
a acompanha diz qual.

## 1. Onde a regra mora

**Invariante de domínio mora no banco.** Gatilho, `EXCLUDE USING gist`, coluna
gerada, índice único parcial, `CHECK`. Não na aplicação, não na tela, não "nos
dois lugares".

Duas cópias da mesma regra divergem na primeira vez que uma das duas for
corrigida — e a divergência aparece tarde, em produção, num relatório que não
bate. Quando a cópia for inevitável (uma base de demonstração sem banco atrás,
por exemplo), as duas usam o **mesmo nome de regra**, e é por esse nome que se
percebe que uma mudou sozinha.

**Derivado nunca é armazenado.** Saldo, total, estado — tudo o que é projeção
de outra coisa é calculado. Sem caminho de escrita não há caminho de
divergência. Se o custo de calcular doer, a resposta é índice ou view
materializada com regra de atualização, nunca uma coluna que alguém atualiza à
mão.

**Migração é somente-avante.** Uma migração aplicada não se edita. A exceção —
projeto sem nenhum ambiente vivo, onde todo banco é recriado do zero — precisa
ser dita em voz alta e justificada no próprio commit.

**Toda recusa do banco tem nome.** `raise exception ... using errcode='23514',
constraint='nome_da_regra'`, e uma tabela na API que traduz `constraint` em erro
legível com saída sugerida. Recusa sem saída deixa o operador travado; recusa
sem nome deixa quem depura sem rastro.

## 2. Autorização

**Negada por omissão.** Toda rota HTTP declara a permissão que exige. Rota sem
declaração é recusada pelo guarda antes de olhar o token — e isso é portão de
CI, não convenção.

**Duas camadas, duas perguntas.** A permissão responde *"pode fazer isto?"* e é
conferida na rota. O limite — alçada, teto, faixa — responde *"até onde?"* e é
conferido no banco, porque depende do corpo da requisição. Uma permissão que
tentasse medir valor viraria dez permissões.

**Permissão vem do perfil, não do token, quando a decisão é do banco.** Um token
vale até expirar; uma permissão revogada há cinco minutos ainda está dentro
dele. Se a aplicação também precisa decidir, ela lê a mesma fonte — duas
verdades sobre a mesma permissão divergem no dia em que alguém revoga algo.

**Isolamento multi-locatário é RLS com `FORCE`**, e o contexto entra por
`set_config(..., true)` ou `SET LOCAL` — **nunca** `SET` de sessão, que vaza
para a próxima requisição do mesmo pool. Chave administrativa que ignora RLS
nunca aparece em código de cliente nem é o papel de execução da API.

**Não distinga "não existe" de "existe e não é seu".** As duas devolvem 404.
Distinguir confirma a existência de registro alheio — oráculo suficiente para
enumerar a base de outro locatário um id por vez.

## 3. Portões

Um portão não é teste: é a regra escrita de uma forma que reprova quando alguém
a esquece. Os que valem em qualquer projeto:

| Portão | Impede |
| --- | --- |
| Tipos | divergência entre contrato e implementação |
| Contraste de paleta | cor que não se lê, e cores que se confundem sob daltonismo |
| Tokens de CSS declarados | `var(--inexistente)`, que o navegador **descarta em silêncio** |
| Superfície de módulo | `export` sem consumidor — API pública que ninguém pediu |
| Cobertura de rotas | permissão no catálogo sem rota e sem razão escrita |
| Matriz de permissões | perfil-semente divergindo da matriz documentada |
| Estados de tela | tela que consulta e não sabe dizer que a consulta falhou |
| axe + teclado + refluxo 320px | acessibilidade medida no DOM renderizado |
| Invariantes de banco | cada regra do domínio, com o nome da constraint |
| Integração da API | a rota, a permissão e a recusa, de ponta a ponta |

Todo portão precisa de uma **guarda contra vacuidade**: um teste que afirma que
o portão leu o que deveria ler. Sem ela, um arquivo renomeado faz o portão
passar por não encontrar nada.

## 4. Como verificar

**Meça o fato, nunca um proxy conveniente.** Esta é a lição que mais se repetiu
neste projeto, em formas diferentes:

- um gatilho `BEFORE` que lia coluna gerada — sempre nula ali, então a regra
  passava em todo lugar *parecendo* instalada;
- uma sonda que declarava um tipo de parâmetro diferente do da consulta real —
  media outra coisa;
- um marcador de "coluna obrigatória" que só olhava `is_nullable`, escondendo
  as `NOT NULL` com valor padrão;
- um valor fixo num teste que, sem dizer, afirmava "nenhum outro arquivo tocou
  neste estoque";
- o `axe` medindo contraste **no meio da animação de entrada**, numa cor que
  não existe em nenhum frame parado.

Antes de confiar numa verificação, pergunte: *ela mede o fato, ou algo que
costuma andar junto com ele?*

**Teste afirma o nome da regra, não só que houve erro.** `assert erro` passa
quando o código falha pelo motivo errado.

**Olhe a tela.** Revisar usabilidade lendo código revisa a intenção, não o
resultado. Vários defeitos deste projeto só apareceram ao capturar a tela
renderizada — inclusive um em que a navegação do celular era inutilizável, e
outro em que faltava uma saída inteira numa barra de ações.

## 5. Interface

**Uma ação visível por linha, o resto em `⋯`.** Três botões por linha em listas
de centenas empurram o dado para fora da tela. A ação visível é a que vale para
**toda** linha — uma primária que desaparece em algumas deixa a coluna
irregular. Em filas, a primária é o passo que aquele registro espera.

**O mesmo verbo nunca aparece na linha e no menu.** Repetir ensina que o menu
não vale a pena abrir.

**Barra de ação em lote substitui a de filtros; não se soma a ela.** Somar
cresce a barra para duas linhas e empurra a tabela para baixo a cada seleção.

**Seleção pertence à página exibida** e é esvaziada ao paginar. "Selecionar
todos os 438" age sobre registros que ninguém viu.

**Lote relata resultado parcial.** Concluído, recusado por regra, não tentado —
três desfechos distintos, cada recusa com o nome da regra. Transação
tudo-ou-nada desfaz o trabalho correto e ainda esconde qual registro falhou.

**Irreversível confirma nomeando os alvos e contando no botão** — "Baixar 3
ativos", nunca "Confirmar".

**O filtro vive na URL.** Sem endereço, o recorte não sobrevive à navegação, não
se compartilha por link e não há o que salvar como visão.

**Nenhum glifo sem rótulo, em nenhuma largura.** Ícone sem rótulo não reflui;
texto, sim. Colapsar um menu para uma coluna de ícones reproduz, em notebook, o
defeito que a barra inferior rotulada veio corrigir no celular.

**Estado nunca depende só de cor**: cor + forma + texto.

**Marcar uma caixa não move o foco** — contagem de seleção vive em região
`aria-live="polite"`.

**Contar na interface custa consulta.** Contagem por item numa faixa pede uma
consulta por item; mostre só a do item ativo.

## 6. Escrita

**Comentário explica o porquê, nunca o quê.** O código já diz o que faz. O
comentário diz qual alternativa foi recusada e o que ela teria custado — é isso
que impede alguém de "simplificar" a regra de volta ao defeito.

**Ausência deliberada é documentada como decisão.** Uma permissão sem rota, um
`DELETE` que não existe, um campo que não é preenchido: se não houver registro
escrito do porquê, alguém o acrescenta por conveniência em seis meses.

**Nunca invente dado de negócio.** Preço, taxa, cliente, condição comercial,
recorte de trabalho: se não foi especificado, a resposta é perguntar ou entregar
vazio — nunca semear um exemplo plausível, que é indistinguível de um requisito.

**Desfaça duplicação em vez de contorná-la.** Duas rotas para o mesmo recurso,
dois contratos para a mesma entidade, dois nomes para o mesmo conceito: a saída
é unificar, não conviver.

## 7. Processo

1. **Modelagem antes do módulo.** Tabela, invariante e teste de banco primeiro;
   rota depois; tela por último.
2. **Protótipo em imagem antes de codificar**, quando a mudança é de interface.
   Aprovação prévia economiza o trabalho inteiro, não metade dele.
3. **Casos de teste antes do código** da fase: cada caso descreve uma obrigação
   que o plano assumiu.
4. **Nada é "pronto" sem os portões verdes**, e o relato diz os números.
5. **Levante o que falta e diga.** Lacuna omitida é lacuna que ninguém resolve.

## 8. O que não fazer

- ❌ Implementar módulo sem antes estruturar modelagem e requisitos.
- ❌ Criar endpoint sem documentar a permissão exigida.
- ❌ Validar permissão só no front-end.
- ❌ Quebrar a consistência do isolamento multi-locatário.
- ❌ Inventar regra, valor, taxa ou condição não especificada.
- ❌ Omitir lacunas ou decisões pendentes.
- ❌ Dar por verificado o que foi medido por proxy.

---

# Parte III — os portões deste projeto, medidos

Esta parte existe porque a Parte II manda um portão ser "a regra escrita de uma
forma que reprova quando alguém a esquece" — e afirmar que um portão existe sem
rodá-lo é exatamente o proxy que as duas doutrinas proíbem. Cada linha abaixo
foi **medida contra este repositório**, e cada portão novo ficou **vermelho
antes de ficar verde**.

| Portão | Onde | Estado |
| --- | --- | --- |
| Tipos | `npm run typecheck` | existia |
| Tokens de CSS declarados | `src/lib/tokens-css.test.ts` | **novo** |
| Contraste da paleta, duas réguas | `src/lib/contraste.test.ts` | **novo** |
| Contexto de transação só por `SET LOCAL` | `src/lib/db/contexto.test.ts` | **novo** |
| Refluxo em 320px | `demo/tests/local/refluxo.spec.mjs` | **novo** |
| Recusa do banco com NOME de constraint | `schema_test.sql` §63 | **novo** |
| Cobertura de permissões × código | `src/lib/permissions.usage.test.ts` | existia |
| Matriz de perfis × migração | `src/lib/permissions.demo.test.ts` | existia |
| Cobertura de rotas × menu | `src/lib/navigation.varredura.test.ts` | existia |
| Arquivo oferecido pelo artefato existe | `src/lib/navigation.artefato.test.ts` | existia |
| `service_role` fora do navegador | `src/lib/segredos.test.ts` | existia |
| Invariantes de banco | `schema_test.sql`, 1250+ asserções | existia |
| Integração de ponta a ponta | 26 suítes de navegador | existia |

**O que os portões novos acharam ao nascer** — nenhum deles nasceu verde por
sorte:

1. **Três `var(--inexistente)`**, todos em `sistema/planilhas/gaveta.tsx`:
   `--color-info-soft` e `--color-info-ink` (a rampa `info` nunca existiu nesta
   paleta) e `--color-breach` sem sufixo. O navegador descarta a declaração
   inteira em silêncio — a caixa de dica ficava sem fundo e a linha recusada
   ficava com a borda das aceitas. Nada quebrava, e é por isso que duraram.

2. **Três recusas de domínio sem nome**, nas migrações 0053 e 0054. Quem
   depurava via "violação de check" e nada mais. A **0064** as nomeia por
   `create or replace`, com o corpo EXTRAÍDO do arquivo original em vez de
   redigitado: a maior das três faz o ajuste de saldo inteiro, e um gatilho
   recriado pela metade não acusa nada — fica instalado, fazendo menos.

**O que foi medido e já estava certo**, dito para que ninguém "conserte" de
volta: `set_config('request.jwt.claims', $1, true)` já era local à transação
(o portão prova isso trocando o `true` por `false` e vendo a suíte ficar
vermelha); as 50 rotas já cabiam em 320px sem rolagem lateral; e a paleta já
passava nas duas réguas, com margens apertadas e reais — `ink-3/surface-2` em
**4,60:1** contra os 4,5 exigidos, e `border-strong/surface-2` em **3,06:1**
contra os 3.

## Onde este projeto diverge da Parte II, e por quê

**"Derivado nunca é armazenado"** — a divergência já está medida e justificada
na Parte I: três colunas derivadas mantidas por gatilho, protegidas pela §60 de
`schema_test.sql`, que confere o derivado contra a própria fonte em toda linha
do banco. A Parte II acrescenta a saída correta para o caso de o custo doer
("índice ou view materializada com regra de atualização, nunca uma coluna que
alguém atualiza à mão") — e é exatamente esse "à mão" que aqui não existe: não
há caminho de escrita que escape do gatilho, porque a RLS obriga toda escrita a
passar pela tabela.

**"Negada por omissão" como portão de CI** — aqui não há decorador de rota:
são Server Actions do Next.js, e quem recusa é `requirePermission` dentro de
cada uma. O que cobre o esquecimento é `permissions.usage.test.ts`, que exige
que toda chave de ação do catálogo seja consultada em algum guard, gate ou
`<Can>`. É a mesma obrigação pelo outro lado: em vez de "toda rota declara uma
permissão", "toda permissão é exigida em algum lugar".

**"Permissão em três camadas, conferidas no servidor"** — está assim, e a
prova é a Parte III da galeria de telas: o perfil "Gestor de TI" concede **153
das 264** chaves do catálogo, e é o perfil — não o papel — que tira cinco das
seis telas do Financeiro que o teto do papel permitiria.

**Forma do repositório** — a Parte II descreve `apps/api` + `apps/web` +
`packages/`. Este projeto é Next.js App Router com a regra no banco (funções
`security definer`, gatilhos, RLS) e Server Actions como camada fina de
tradução (ADR-011). A razão da forma — "o catálogo de permissões vive num
pacote sem dependências, então front e API leem o mesmo array" — é atendida por
`src/lib/permissions.ts`, que roda no servidor, no navegador e nos testes, com
`permissions.demo.test.ts` cobrando que as duas listas sejam idênticas **e na
mesma ordem**.
