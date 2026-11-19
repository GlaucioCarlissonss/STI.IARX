# Padrões de engenharia — referência para outros projetos

Este documento reúne o que o GSTI.IARX decidiu e por quê, num formato que outro
projeto possa incorporar. Ele é **genérico de propósito**: nenhum nome de
cliente, nenhum valor, nenhum CNPJ, nenhum dado de pessoa. O que vai aqui é o
padrão, não a base.

Cada regra vem com a **razão**. Uma regra sem razão vira ritual: na primeira
pressa alguém a descumpre, e não há como saber se o descumprimento custou algo.
Onde a razão veio de um defeito real, o defeito está escrito — é o que impede
que a regra seja desfeita por quem não viu o estrago.

Leia em camadas:

| parte | aplica-se |
| --- | --- |
| 1. Como trabalhar | sempre |
| 2. Arquitetura e dados | qualquer sistema com banco e regra de negócio |
| 3. Interface | qualquer sistema com tela |
| 4. Segurança e privacidade | sempre |
| 5. Verificação | sempre, e é a parte mais cara de aprender depois |
| 6. Padrões de domínio | quando o domínio for parecido (financeiro, projetos, suporte) |

---

## Parte 1 — Como trabalhar

### Medir antes de afirmar

Nenhuma afirmação de desempenho, de cobertura ou de correção entra sem número
medido. "Ficou mais rápido" não é resultado; "6.198 ms → 105 ms na mesma base de
8.279 registros" é.

Isso vale contra você mesmo. Num perfilamento deste projeto, um cronômetro em
volta de cada função acusou a mais lenta como culpada por 98% do tempo — e ela
não era culpada: **o cronômetro de quem chama soma o de quem é chamado**. A
amostragem de CPU apontou outra função, três níveis abaixo, chamada uma vez por
segmento de gráfico. A primeira explicação estava errada e teria sido
implementada se não houvesse segunda medição.

Quando a medição contrariar sua leitura, a medição ganha, e você diz isso em voz
alta no relato. Três vezes nesta série a conta do teste estava errada e o motor
certo.

### Comentário diz POR QUE, nunca O QUE

O código já diz o que faz. O comentário existe para a decisão que o código não
consegue carregar: a alternativa descartada, o defeito que a linha evita, o
preço que se escolheu pagar.

```js
// RUIM — repete o código
// soma os centavos de cada item
const total = itens.reduce((s, i) => s + i.centavos, 0);

// BOM — carrega a decisão
// Em centavos inteiros, e não em reais com ponto flutuante: o rateio de 12
// parcelas sobre um total ímpar perde centavo a cada divisão, e a soma das
// parcelas deixa de fechar com o contrato. O resto vai nas primeiras parcelas.
const total = itens.reduce((s, i) => s + i.centavos, 0);
```

Quando uma decisão tem custo, escreva o custo. "Um contrato que acabou e ninguém
encerrou é projetado para sempre — é deliberado, e só se defende porque a tela
lista por nome quem está nessa situação."

### Mensagem de commit conta a história, não o diff

O diff já lista os arquivos. A mensagem diz o que estava errado, o que o usuário
sentia, o que mudou e **o que foi medido depois**.

Estrutura que funciona:

1. Título: o defeito ou a entrega, em uma linha, sem jargão de implementação.
2. O que acontecia antes, do ponto de vista de quem usa.
3. A decisão, com a alternativa descartada.
4. Medição depois: números, não adjetivos.

Nunca escreva um número que você não mediu. Se o texto disser "525 testes",
rode e conte — uma contagem errada numa mensagem de commit envenena toda
auditoria que a tomar por base depois.

### Escopo: entregar o pedido inteiro, e dizer o que ficou de fora

Não estreite o pedido em silêncio. Se parte dele estiver bloqueada, entregue
todo o resto e diga explicitamente o que não foi feito e por quê — reduzir o
escopo é decisão de quem pediu.

Se você discordar da premissa, diga em uma ou duas frases e **continue
construindo**, declarando a suposição. Parar sem entregar nada só se prosseguir
for inseguro ou inútil.

### Achado fora do escopo não vira correção silenciosa

Encontrou um defeito que não é do pedido? Relate. Corrija apenas se for pequeno,
seguro e na mesma vizinhança — e diga que corrigiu. Um commit que entrega duas
coisas e menciona uma esconde a segunda de quem for revisar.

---

## Parte 2 — Arquitetura e dados

### O domínio não conhece o transporte

```
src/domain/     regras de negócio, sem HTTP, sem framework
src/routes/     camada fina que traduz HTTP para chamadas de domínio
src/db/         schema, conexão, migrações
test/           testes das regras, sem subir servidor
```

A regra fica testável sem servidor, e a rota vira o que ela deve ser: tradução.
Quando uma regra precisa aparecer em duas superfícies (API e página autônoma,
por exemplo), ela existe **uma vez** no domínio e as duas a chamam — duas cópias
divergem na primeira correção, e aí o sistema passa a dar duas respostas para a
mesma pergunta.

### Multi-tenant é invariante, não convenção

Toda entidade carrega o dono. Três camadas, e as três são necessárias:

1. **Middleware** resolve o tenant do cabeçalho e recusa quem não tem vínculo.
2. **Toda consulta** filtra pelo tenant, e referências cruzadas são validadas
   contra ele antes de gravar.
3. **Gatilho do banco** carimba o dono a partir da entidade-pai. Essa é a que
   não se esquece: importador, webhook e código novo não têm como criar registro
   sem dono, mesmo que quem escreveu não soubesse da regra.

**A recusa de um recurso alheio é idêntica à de um recurso inexistente.**
Distinguir as duas conta a quem tenta quais ids existem.

**O seletor que oferece é tão importante quanto a consulta que filtra.** Neste
projeto o filtro da tela recortava certo e o **formulário** oferecia o catálogo
inteiro, de todos os contratantes. Escolher ali gravaria o registro de um dentro
de outro. Toda lista oferecida ao usuário passa pelo mesmo recorte das
consultas — e isso vale para `<select>`, autocomplete e seletor múltiplo.

### Dinheiro em inteiro, data em formato ordenável

- **Valores em centavos inteiros.** Ponto flutuante perde centavo no rateio, e a
  soma das parcelas deixa de fechar com o total contratado. O resto da divisão
  vai nas primeiras parcelas, e a propriedade "a soma fecha" é verificada por
  teste.
- **Competência como `AAAA-MM`**, que ordena e compara com operadores simples, e
  é exibida como `MM/AAAA`. Guardar no formato de exibição obriga a converter
  para comparar, e alguém esquece.
- **Derivado nunca é armazenado.** Atraso, percentual, farol, "fora do SLA":
  tudo calculado na leitura. Um derivado gravado diverge da fonte no primeiro
  recálculo que ninguém rodou, e aí há dois números certos e contraditórios.
  Grave a fonte; derive na hora.

### Nada é excluído em silêncio

Exclusão é lógica e registra autor, momento e estado anterior. Onde a exclusão
física é pedida de propósito, ela é a exceção documentada e deixa linha de
auditoria com a contagem e o valor do que saiu.

**Excluir um pai com filhos é bloqueado, não cascateado.** Uma confirmação de
"excluir 1 item" que apaga a subárvore inteira apaga em silêncio.

### Importação idempotente, e identidade explícita

- A identidade do registro é **o conteúdo**, salvo onde a origem já tem
  identificador — aí a chave é `(tenant, sistema_origem, id_externo)`. O tenant
  entra na chave porque dois contratantes podem usar instâncias separadas do
  mesmo sistema, com ids que colidem sem relação entre si.
- **Reimportar uma exportação não duplica nem perde.** É isso que torna
  exportar/importar um caminho de backup e migração.
- **Linha inválida não derruba o lote.** Ela entra num relatório com o motivo, e
  o relatório final oferece um arquivo só com as recusadas.
- **Prévia antes de gravar**, linha a linha, com o efeito de cada uma (*criar* ou
  *atualizar*). É a diferença entre um aviso do que vai acontecer e um relatório
  do que já aconteceu.
- **Validar sem gravar** roda a importação inteira em transação desfeita.
- `id_externo` repetido **dentro do mesmo arquivo** é erro, e não upsert: das
  duas linhas, o sistema não tem como saber qual é a boa.

### Template versionado, com aba de instruções gerada

O mesmo arquivo serve para importar e exportar. O layout é versionado dentro da
planilha, e o leitor aceita apelidos de cabeçalho para que arquivos antigos
continuem válidos.

A aba de instruções é **derivada da definição das colunas**, nunca escrita à
mão: escrita à mão, ela diverge do que a importação aceita na primeira mudança.

**As duas pontas declaram a mesma versão com as mesmas colunas.** Neste projeto
uma coluna existia só numa das superfícies e as duas anunciavam a mesma versão —
exportar de uma e importar na outra **perdia o campo em silêncio**.

### Toda tentativa deixa rastro, inclusive a que falha

Arquivo ilegível e carga recusada entram no histórico com o motivo. Era
justamente o caso sem registro — e é o que alguém investiga ao perguntar "por
que os dados não entraram?". Simulação não entra: prévia não é carga.

### Migração roda contra cópia da base real antes da base real

E o relatório da migração é um número conferível: quantos registros carimbados,
quantos órfãos (tem de ser zero), quantos duplicados evitados.

Cuidado com a ordem: índice e gatilho que dependem de coluna nova não podem
morar no schema inicial, que roda **antes** da migração.

---

## Parte 3 — Interface

### Duas réguas de contraste, e elas não são a mesma

Esta é a regra que mais se descumpre sem perceber:

- **Preenchimento** (fatia de rosca, barra, pastilha, borda) precisa de **3:1**
  contra a superfície.
- **Texto** precisa de **4,5:1**.

A paleta de séries é desenhada para a primeira régua, e o sistema a usa nas
duas — o mesmo verde que pinta a fatia escreve o valor do cartão ao lado dela.
Resultado: cores que passam no gráfico e reprovam na frase.

A solução é **duas rampas de tokens**, mesma matiz e mesma ordem:

```css
--s1: #2a78d6;   /* preenchimento */
--s1t: #2158a3;  /* o mesmo azul, no tom que o texto exige */
--bom: #0ca30c;  --bomtxt: #056605;
```

E um ajudante único que troca uma pela outra, com mapa **explícito**:

```js
const COR_TEXTO_DE = { s1:'s1t', s2:'s2t', s3:'s3t', bom:'bomtxt', /* ... */ };
const corDeTexto = (cor) => {
  const casa = /^var\(--([a-z0-9]+)\)$/.exec(String(cor));
  const alvo = casa && COR_TEXTO_DE[casa[1]];
  return alvo ? `var(--${alvo})` : cor;
};
```

Uma regra textual ("troque o último parêntese por `t)`") vale só para a família
que existia quando ela foi escrita. As séries ganharam segundo tom depois, e
continuaram escrevendo no tom de preenchimento.

**Confira nas quatro superfícies de cada tema**, não só na principal. Um vermelho
que passa sobre o cartão e o fundo pode reprovar sobre a superfície elevada — e é
lá que mora a etiqueta de 11,5px.

**Um estado que ninguém alcançou nunca foi medido.** Três reprovações só
apareceram quando um prazo venceu e os cartões entraram no estado vermelho pela
primeira vez. Semeie o estado, ou ele fica sem medição.

### A cor nunca é o único canal

Todo farol, etiqueta e semáforo traz **símbolo e palavra** junto da cor. O disco
do semáforo é tingido com o símbolo na cor de texto da escala, e não um disco
chapado com glifo branco — branco sobre o verde da paleta não chega a 3:1, e o
símbolo é justamente o canal de quem não distingue a cor.

### Tema: três estados, aplicado antes do primeiro pixel

**Tema do sistema**, **claro** e **escuro**. A escolha explícita vence a
preferência do aparelho nos dois sentidos, fica no navegador de quem usa (é
preferência, não dado do sistema) e é carimbada por um script no topo do
documento — senão a tela abre no tema do aparelho e troca depois, com piscada
visível.

```html
<script>
(function () {
  try {
    var t = localStorage.getItem('tema');
    if (t === 'claro' || t === 'escuro') {
      document.documentElement.setAttribute('data-theme', t === 'claro' ? 'light' : 'dark');
    }
  } catch (e) { /* armazenamento bloqueado: fica no tema do sistema */ }
})();
</script>
```

Escreva o CSS escuro nos dois lugares: `@media (prefers-color-scheme: dark)`
protegido por `:root:not([data-theme="light"])`, e `:root[data-theme="dark"]`.

### Tooltip e drill-down em todo gráfico e indicador

**O balão espera.** Sem atraso, atravessar uma tabela de vinte barras pisca vinte
balões pelo caminho; com ele, o balão aparece onde o cursor **parou** — que é
onde havia intenção de ler. O **foco do teclado não espera**: quem chegou por
Tab já escolheu.

**O balão não corta na borda.** A posição é contida nas quatro, e a largura é
**medida**, não presumida.

**Clicar abre os registros que compõem o número, com o MESMO recorte que o
produziu.** É essa garantia que faz o detalhamento valer: vindo de outra
consulta, ele poderia divergir da tela, e ninguém saberia qual dos dois está
certo. O detalhamento mostra junto:

- a contagem de registros;
- a soma sobre os registros exibidos;
- a marca **"confere com o indicador"**, ou **"diverge"** com o valor esperado;
- o recorte aplicado.

**Nem todo número vira botão.** Mediana, percentual isolado e contagem de
cadastro não têm registros por trás; oferecer drill-down neles promete o que não
existe. O indicador sem detalhamento continua com tooltip.

**Indicador com valor zero não abre.** Um detalhamento vazio faz duvidar do
número em vez de esclarecê-lo.

**Lista paginada não acusa divergência.** Somar o que está à vista mede a página,
não o número clicado. Use a contagem que o servidor informa para o recorte
inteiro, e diga no rodapé quantos de quantos estão à mostra.

**Acessibilidade do gatilho:** `role="button"`, `tabindex="0"`, `aria-label`
dizendo o que vai abrir, foco visível, Enter e Espaço. Um `div` com `onclick`
não é nada disso.

### Telas flutuantes são uma peça só

- Cabeçalho preso em cima, rodapé preso embaixo, **só os dados rolando**. O
  título carrega o recorte; as ações levam a fechar ou salvar. Nenhum dos dois
  pode sair de vista enquanto se percorre trezentos registros.
- Ações dentro de um `<form>` não saem dele — o `submit` depende disso —, então
  grudam no fundo da área de dados.
- Redimensionável pela borda direita, pela de baixo e pelo canto. Esquerda e topo
  ficam de fora: a tela é centralizada, e arrastar por lá a faria andar em vez de
  crescer. Mínimo 320×240.
- **O tamanho persiste por espécie de tela**, não por tela: detalhamento quer
  largura, formulário de cadastro não.
- `Esc` fecha, e com telas empilhadas só a de cima. O botão de tela cheia é um
  `aria-pressed`. Cada alça é um `separator` com `aria-label`.
- Barra de rolagem no tom do tema: a do navegador entra branca no escuro.

Duas armadilhas de tabela com coluna ajustável, que só aparecem ao fazer:

- A alça fica **dentro** da célula, não sobre a divisa: a caixa de rolagem
  recorta o que passa da borda, e a alça existe no HTML sem dar para pegar.
- A tabela vale **a soma das suas colunas**, não 100% da caixa. Com `width:100%`
  e `table-layout:fixed`, alargar uma coluna faz o navegador devolver o ganho
  encolhendo as outras. Quem absorve o excesso é a rolagem horizontal.

### Blocos em acordeão, fechados por padrão

Uma tela longa que abre tudo aberto obriga a rolar para achar o que interessa. O
que fica guardado é o conjunto dos **fechados**, e não o dos abertos — assim um
bloco criado depois nasce aberto, em vez de nascer escondido de quem já usava o
sistema.

Consequência para quem testa: **o que está dentro de um bloco fechado não existe
no DOM**. Esperar por `table` numa tela recém-aberta espera para sempre.

### Toda lista ordenada por valor decrescente

Do maior para o menor, em cada nível da árvore. É a ordem em que se procura o
que decidir.

### O filtro não decide se dá para registrar

O botão de criar **nunca** fica desabilitado por causa do recorte em tela. O
filtro diz o que a pessoa está **olhando**; se ela pode ou não registrar é outra
pergunta, e trancar o botão por causa da primeira é responder a errada. A unidade
se escolhe dentro do formulário.

### O recorte é por tela, e só de sessão

Um filtro global no topo recorta telas que nada têm a ver com a conferência que
se está fazendo. Cada tela tem o seu filtro, com estado só de sessão — recorte de
leitura não é configuração, e guardá-lo faz a pessoa voltar dias depois a uma
tela filtrada sem lembrar por quê.

**Todo filtro diz o que faz:** uma linha de apoio com o que filtra, sobre quais
dados atua e o efeito esperado. Os textos que se repetem moram num lugar só —
a mesma pergunta em sete telas com sete respostas ligeiramente diferentes ensina
sete regras diferentes.

### Estado vazio diz a CAUSA, não mostra zero

Um zero solto se lê como "não há problema". Quando não há dado porque ninguém
classificou ainda, a tela diz **"falta classificar"** e oferece o caminho para
resolver, na própria tela. Zero e "não medido" são coisas diferentes, e
confundi-las afirma um resultado que ninguém apurou.

O mesmo vale para meta: sem dado, a meta não é atingida **nem** falhada.

### Erro é acionável

Mensagem de erro traz o que aconteceu, por que, e o que fazer. Quando a recusa
tem remédio na tela, a tela oferece o remédio — uma recusa que vira beco sem
saída é um defeito, mesmo que a recusa esteja certa.

Dê **código** aos erros que a interface precisa distinguir, e não só prosa: a
interface que ramifica por texto quebra na primeira melhoria de redação.

```ts
throw erroValidacao(mensagem, { codigo: 'carga_inicial_sobre_base_povoada', existentes });
```

---

## Parte 4 — Segurança e privacidade

- **Sem segredo padrão.** A aplicação recusa subir sem o segredo de sessão. Um
  fallback no código permitiria forjar sessão de administrador em qualquer
  instalação que esqueceu a variável.
- **Segredo guardado como hash**, e o valor em claro exibido **uma única vez**.
  Guardar em texto para poder reexibir troca uma conveniência por um vazamento.
  Girar invalida o anterior na hora.
- **Comparação de segredo em tempo constante.**
- **Recusas distintas para causas distintas:** `401` para segredo ausente ou
  errado; `403` para conexão desligada de propósito (401 mandaria o operador
  caçar um segredo que está certo); `503` quando não há segredo configurado em
  lugar nenhum — um deploy que esqueceu a variável não vira porta sem tranca.
- **Escuta em loopback por padrão.** Expor à rede é opção explícita, e pede proxy
  reverso com HTTPS.
- **Sessão revalidada a cada requisição** contra o estado da conta: desativar um
  usuário encerra o acesso, mesmo com token ainda válido.
- **O endereço público é configuração, não cabeçalho.** Montar link de
  redefinição de senha a partir do `Host` da requisição faz um pedido forjado
  entregar à pessoa certa um link válido apontando para o site de quem pediu.
- **Carimbo de troca de senha em milissegundos.** Com resolução de um segundo,
  trocar a senha no mesmo segundo do login deixa a sessão antiga de pé.
- **A recusa de login é sempre a mesma frase**, exista a conta ou não.
- **Exportação neutraliza fórmula.** Valores iniciados por `=`, `+`, `-` ou `@`
  saem prefixados por apóstrofo, para que um texto salvo no sistema não vire
  código ao abrir a planilha. A leitura desfaz o prefixo.
- **Erro de restrição do banco não vaza schema**: a mensagem do driver vai para o
  log do servidor, não para a resposta.
- **O corpo do e-mail não entra no log**: ele carrega o link de redefinição.
- **Sem SMTP configurado, o sistema não diz que enviou.** A mensagem fica
  registrada com o motivo e a tela avisa. Dizer que enviou sem ter enviado é pior
  do que não enviar.

### Dado de cliente nunca entra no repositório

Planilhas de origem, banco gerado e qualquer extração com nome de pessoa,
matrícula, salário, CPF, CNPJ ou valor contratual ficam fora do controle de
versão. O repositório contém **apenas código**.

Fixture de teste é **inventada**, e é por isso que ela pode ser versionada.
Quando a suíte precisa do arquivo real, ela o lê de uma variável de ambiente e
**se pula** quando ele não está presente — nunca o embute.

---

## Parte 5 — Verificação

Esta parte custou mais caro do que todas as outras. Uma suíte que mente é pior do
que suíte nenhuma: ela gasta o orçamento de confiança que você usaria para olhar.

### Uma suíte que morre não é uma suíte limpa

Contar linhas de falha dá verde a quem morreu antes da primeira asserção. Neste
projeto, cinco conferências passaram **meses** sendo relatadas como limpas sem
executar uma linha útil.

Decida "morreu" pelo rodapé que o interpretador imprime ao estourar sem captura,
e não procurando a palavra "Error" na saída:

```js
const morreu = /^Node\.js v\d/m.test(saida);
if (morreu && !falhas.length) falhas.push('(morreu antes de medir qualquer coisa)');
```

### Cada suíte recebe a base que ela declara

Suítes que compartilham uma base mutável medem a ordem em que rodaram, não o
produto. Dê a cada uma banco próprio, servidor próprio e porta própria, com os
preparadores que ela declara. É mais lento, e a lentidão é o preço de um
resultado que quer dizer alguma coisa.

### Construir antes de medir

Se o servidor serve um pacote compilado, a varredura mede a **última
construção** — dá verde em correção que não está lá e vermelho em defeito já
corrigido. O runner constrói uma vez antes da primeira suíte e **aborta se a
construção falhar**: medir o pacote velho é pior do que não medir.

O mesmo vale para qualquer artefato montado: monte antes da primeira suíte, e
nunca remonte no meio de uma varredura — as primeiras medem o build antigo e as
últimas o novo, e o resultado não descreve nenhum dos dois.

### As três armadilhas da asserção

Metade das falhas de uma varredura deste projeto não era defeito do produto: era
conferência medindo a base de ontem. Elas se parecem com defeito até alguém
olhar.

**1. Número absoluto da base.** "Dois lançamentos gravados", "cinco empresas",
"1.658 registros reconhecidos". O cliente cadastra, classifica e reconhece; o
número muda e a conferência passa a acusar o produto do que ele leu certo.

> A suíte mede a **diferença** que ela mesma causa: guarda a linha de base,
> acrescenta o que veio acrescentar (nunca substitui o mês), e exige o delta.

**2. Estado vazio suposto.** "A base não tem nada classificado." Era verdade no
retrato de meses atrás. A regra em jogo é de **tela** — sem nada classificado, o
indicador diz que falta classificar em vez de mostrar zero.

> A suíte **cria** o vazio, em memória, prova a regra, e segue. E confere o
> preparo antes de medir: um vazio que não ficou vazio faz as asserções
> seguintes medirem outra coisa achando que medem a tela vazia.

**3. Calendário escrito na asserção.** "A segunda onda ainda não vence",
"o indicador vale 100%". Quando o prazo chegou, a tela mudou de leitura
corretamente e cinco conferências acusaram o produto de errar por dizer a
verdade.

> O vencimento sai da data que a própria tela mostra, comparada com hoje. Exija
> a **regra**, não o número: o que não venceu nunca aparece como 0%; o que venceu
> traz número; o cartão que mede um fato datado não se escusa pelo mês aberto.

### Nunca guarde o elemento para clicar depois

```js
// RUIM — o repinte solta o elemento do DOM e o clique mata a suíte
const b = await pag.$('.acordeao-fechado');
if (b) await b.click();

// BOM — o locator reencontra o alvo na hora do clique
const b = pag.locator('.acordeao-fechado').first();
if (await b.count()) await b.click();
```

"Element is not attached to the DOM" **mata** a conferência em vez de falhá-la —
e uma morte não diz o que estava errado.

### A navegação do teste tem de repintar de verdade

Pedir a tela em que a página já está pode ser um nada: o botão do módulo só
repinta se o módulo mudou, e um módulo de aba única não tem botão de aba para
clicar. Quem escreveu algo e pediu a tela lia a tela **de antes da escrita**.
Garanta o repinte, ou passe por outra tela e volte.

### Espere o que o produto espera

Se o balão só abre depois de um atraso deliberado, leia o atraso **da página** e
espere por ele. Um número copiado para dentro da suíte fica velho na primeira
mudança do produto.

### Suíte nova prova o defeito antes de prová-lo corrigido

Para correção de defeito: reproduza a falha primeiro, veja a suíte vermelha, e
só então corrija. Uma suíte que nunca ficou vermelha não prova que pega nada.

### Comparar contra a linha de base antes de dizer "sem regressão"

Rodar a varredura depois da mudança não basta: é preciso o número de antes, na
mesma base. "18 falhas" pode ser exatamente o que já havia.

---

## Parte 6 — Padrões de domínio

Aplique só onde o domínio for parecido. O que vale em qualquer caso é a forma:
guardar o fato, derivar a leitura, e nomear as duas medidas quando elas
discordam.

### Recorrência: guarde o fato, não as linhas

"Repetir mensalmente até" escreve linhas e se perde. Guarde **até quando o
contrato vale** como campo próprio, e derive a projeção:

1. **A identidade do contrato não inclui o valor.** Um reajuste é o mesmo
   contrato mais caro; com o valor na chave, ele projetaria duas vezes.
2. **Linha real vence a projeção.** Sem isso a despesa é contada em dobro
   exatamente nos meses em que alguém lançou adiantado — punindo o cuidado.
3. **A vigência manda; a ausência dela é "em aberto".** Supor um fim que ninguém
   informou promete uma economia que não aconteceu.
4. **O mês corrente é completado, não ignorado.**

O preço da decisão 3: um contrato encerrado e não informado é projetado para
sempre. Só se defende porque a tela lista, **pelo mais esquecido primeiro**, quem
está nessa situação.

### Prazo com data não se escusa pelo período aberto

Indicadores que **acumulam** (custo, conformidade) não devem ser julgados contra
a meta cheia no meio do período: a tela diz "mês em curso", e não "sem dados" —
há dados, o mês é que não fechou.

Indicadores cujo fato tem **data** (uma entrega, uma virada) são medidos assim
que a data chega, inclusive em mês aberto. E o corte é **hoje**, não o fim do
mês: no dia 1º, um prazo do dia 3 ainda não venceu.

### Duas medidas que discordam recebem dois nomes

Avanço ponderado e conclusão simples; realizado e projetado; meta cadastrada e
alvo do plano. Mostrar uma chamando-a da outra faz quem lê procurar um erro que
não existe. Nomeie as duas, lado a lado, e diga qual responde a qual pergunta.

### Hierarquia com limite, validada no domínio

Para item que pode ter pai do mesmo conjunto, quatro validações:

1. não é pai de si mesmo;
2. não é ascendente de si mesmo (ciclo);
3. mesmo conjunto (projeto, cliente);
4. a profundidade considera **a subárvore que vem junto**.

E o pai se escolhe numa **lista**, nunca se digita: campo de texto resolvido por
nome devolve "não existe" para quem errou um acento, e num conjunto vazio pede um
nome que não há como fornecer.

### Normalização de entrada externa

- Status que não casa com nada vira o estado mais conservador (ex.: "aberto"):
  um registro incompreensível está em aberto até prova em contrário.
- Campo ausente ganha rótulo próprio ("Não classificado"): recusar na porta perde
  o registro que a integração veio entregar.
- Valor desconhecido entra **como veio**, com aviso. Traduzir inventa o que
  ninguém escreveu; descartar perde o que a origem disse.
- **Nada é inventado; o vazio é contado.** O diagnóstico da carga diz quantos
  campos vieram em branco — é trabalho a fazer, não erro.

### O payload entra no log ANTES de ser interpretado

É de lá que sai o diagnóstico de uma falha e o reprocessamento, sem depender de a
origem reenviar.

| passo | o que faz |
| --- | --- |
| 1 | grava o payload bruto, status `recebido` |
| 2 | valida os obrigatórios; recusa vira `erro` com motivo legível |
| 3 | normaliza para o modelo único |
| 4 | upsert pela chave de identidade |
| 5 | fecha o evento e atualiza a conexão (último evento, último erro) |

**Reprocessar só vale para evento com erro.** Refazer o que deu certo faz a
auditoria mostrar duas operações onde houve uma.

**O payload de teste percorre exatamente o mesmo caminho do de produção.** Um
teste com caminho próprio deixa de provar o que a produção faz.

### Permissão em três camadas, conferidas no servidor

1. o **módulo** é visível ou não;
2. dentro dele, a **ação** é permitida ou não;
3. para quem edita, o **campo** é alterável ou não.

O que o front esconde é conveniência; a regra é a verificação na rota, e a recusa
vira 403 na auditoria. **O front pergunta ao servidor o que o perfil permite** —
e, enquanto a resposta não chega, **nada é escondido**: esconder antes de saber
deixa o menu vazio por um instante para todo mundo.

**O perfil fica no vínculo com o tenant**, não no usuário: a mesma pessoa pode
administrar um contratante e só ler outro.

**Sem perfil atribuído, o papel anterior responde.** É o que impede a migração de
tirar acesso de quem já tinha — um sistema que tranca o próprio dono na
atualização não é mais seguro, é só inútil.

---

## Apêndice — Desempenho, quando chegar a hora

Não otimize antes de medir, e meça com a ferramenta certa (amostragem de CPU, não
cronômetro aninhado). Dois achados deste projeto que se repetem em qualquer
sistema:

**Função barata chamada um milhão de vezes.** Uma cópia da base inteira, chamada
uma vez por segmento de gráfico, custou 6 segundos para pintar uma tela. A
correção é guardar a última resposta com **chave de versão dos dados**, e não com
o tamanho da coleção — gravar um mês por cima deixa o tamanho igual e o conteúdo
diferente. *Um cache que serve dado velho é pior que o código lento que
substituiu, porque lentidão se percebe e dado velho não.*

**Dividir o pacote sozinho piora o caso comum.** Dividir cria uma fila: o
navegador só descobre de que arquivo a tela precisa depois de baixar e executar o
principal. Divida **e** adiante o módulo da tela pedida, para as duas viagens
acontecerem lado a lado. Meça com a rede estrangulada, nos dois perfis.

E deixe as ferramentas de medição versionadas no repositório, com as armadilhas
escritas dentro delas: base sintética mínima não mede nada, e função de render
assíncrona medida como síncrona mede o tempo de agendar.
