# 21 — Visão de resultado: custo, prazo e entrega numa tela só

**Status:** implementado (migrações 0039 e 0040).
**Depende de você:** nada de configuração. Depende de **ter dado nos três
módulos** — orçamento lançado, projetos cadastrados, chamados atendidos.

> Terceira e última peça trazida do GSTI.IARX, e a que explica as outras duas.
> Projetos ([docs/19](19-modulo-de-projetos.md)) e orçamento
> ([docs/20](20-orcamento-de-ti.md)) vieram porque faltavam. Esta vem porque é a
> razão de os três existirem juntos: **o gestor de TI não acompanha custo,
> prazo e entrega em três lugares — ele responde por um resultado.**

---

## 1. A dívida que ela fecha

Quando o módulo de SLA do GSTI foi recusado, a justificativa dizia:

> "O que falta aqui não é a tabela: é a **leitura mensal consolidada** para o
> gestor. Isso é relatório sobre o que já existe."

Esta é a leitura. E ela é relatório mesmo: **nenhuma tabela nova, nenhum número
digitado.** A 0039 tem duas funções e uma coluna acrescentada a uma view
existente — nada mais.

| Indicador | Vem de | Desde |
|---|---|---|
| Gasto de TI no mês, com despesa/investimento e variação | `vw_it_budget_monthly` | 0038 |
| Compromisso — 12 meses | `it_cost_entries` | 0038 |
| Projetos atrasados, em andamento, entregues no prazo | `vw_projects` | 0037 |
| Conformidade de SLA | `vw_sla_compliance` | **0011** |

A última linha é a que importa: a conformidade de SLA é contada chamado a
chamado desde a 0011. Nunca faltou o dado — faltava a tela que o põe ao lado do
custo.

---

## 2. Por que uma função, e não três consultas na tela

Porque o recorte precisa ser o **mesmo** nos três.

Com três consultas montadas na tela, um filtro que diverge entre elas produz uma
tela em que os números não conversam — e ninguém percebe, porque cada um parece
certo sozinho. Em `gestao_resultado(cliente, competência)` o recorte entra uma
vez e vale para os três, e o resultado é **testável por asserção de schema**,
que é a única forma de provar que um indicador consolidado soma o que diz somar.

A seção 43 do `schema_test.sql` prova, com números exatos:

- o gasto do mês soma os lançamentos da competência, e **o cenário de simulação
  não entra**;
- o compromisso são os doze meses **seguintes** já lançados, nem mais nem menos;
- a soma do detalhe por filial fecha **exatamente** no indicador;
- a conformidade é a do conjunto, e não a média das filas;
- sem chamado com acordo, a conformidade é **nula**, e não 100%;
- outro cliente devolve o que é dele, e outro tenant devolve zero.

---

## 3. A tela confere a si mesma

É a melhor ideia do painel do GSTI, e o README daquele projeto a enuncia como
contrato de leitura:

> "Todo gráfico e todo indicador respondem ao ponteiro com o contexto do ponto
> e, quando há registros por trás do número, abrem esses registros ao clique —
> com o mesmo recorte que produziu o número, e **com a soma do detalhe conferida
> contra o indicador na própria tela**."

A razão é concreta: **um indicador que não bate com o próprio detalhamento é o
defeito mais caro de um painel de gestão.** Os dois números parecem certos
sozinhos; a divergência só aparece quando alguém compara — e quem compara
geralmente é o cliente, numa reunião.

A causa é quase sempre a mesma: indicador e detalhe montados por consultas
diferentes, e um filtro divergiu. Conferir na tela não impede o erro; faz ele
aparecer **para quem está olhando**, no instante em que acontece.

Quando bate, a tela escreve uma linha discreta — é ela que dá crédito ao número
quando alguém perguntar. Quando não bate, escreve a diferença, que é por onde se
começa a procurar.

A tolerância é de **meio centavo**, e é pequena de propósito: `numeric(14,2)` no
banco é decimal exato, então o único arredondamento real do caminho é a conversão
para `number` ao atravessar o JSON. Mais que isso seria tolerar um erro de
verdade. (`src/lib/gestao/conferencia.ts`, 13 testes.)

---

## 4. Três decisões que a tela toma, e que são discutíveis

### A conformidade é do conjunto, não a média das filas

`vw_sla_compliance` já traz `resolution_compliance_pct` pronto, por fila. Usar
aquela coluna seria o caminho curto — e estaria errado: **a média de percentuais
por fila não é o percentual do conjunto.** Uma fila com um chamado pesaria tanto
quanto uma com duzentos.

O teste mostra o tamanho do erro: vinte chamados com dois estouros numa fila,
mais um chamado estourado em outra. A média das filas dá 45%. O conjunto dá
85,7%. Quarenta pontos.

### Sem chamado com acordo, o número é um travessão

"Nenhum estouro em nenhum chamado coberto" é **ausência de medida**, não
conformidade perfeita. Escrever 100% faria do mês sem acordo o melhor mês do ano
— justamente o mês em que alguém deveria perguntar o que houve.

Pelo mesmo motivo, a variação sobre base zero não é "+100%": é "sem base de
comparação". A comparação não existe.

### Em custo, subir é ruim

O tom da variação é invertido em relação ao que um painel de receita usaria. É
uma decisão que precisa estar escrita, porque **a cor é o que a pessoa lê antes
do número**.

---

## 5. Cada indicador se abre pela dimensão que a fonte tem

| Indicador | Detalhe por |
|---|---|
| Gasto do mês | **filial** |
| Projetos atrasados | **filial** (na lista de projetos) |
| Conformidade de SLA | **fila** |

Não é descuido. `vw_sla_compliance` agrupa por fila, responsável e cliente — não
por filial. Forçar as três no mesmo eixo exigiria uma view nova de SLA por
filial, e a tela estaria afirmando uma comparação que o dado não sustenta.

**A tela diz qual é o eixo de cada um**, em vez de deixar supor.

---

## 6. A série: "estamos melhorando?"

O indicador responde *como estamos neste mês*. É a série que responde a pergunta
que o gestor leva para a reunião — e um número isolado não diz se o mês foi bom,
diz só que ele foi.

A tela de orçamento já traça o custo mês a mês, e repetir aquela linha aqui seria
enfeite. O que não existe em lugar nenhum é **o custo ao lado da conformidade e
do atraso, no mesmo eixo de tempo**: o mês em que o custo subiu é o mesmo em que
a conformidade caiu? O corte de junho aparece como atraso em agosto?

A série não *responde* isso — correlação não é causa. Ela faz a pergunta ser
possível, que é o que um painel de gestão deve fazer.

### Dois quadros, e não duas linhas num quadro

Reais e porcento não compartilham escala. Sobrepor os dois exige dois eixos
verticais, e **dois eixos fabricam a correlação**: basta esticar um deles para as
linhas se cruzarem onde se quiser. Quem olha lê "o custo subiu e a conformidade
caiu junto" — uma conclusão que o desenhista escolheu.

Dois quadros empilhados sobre o mesmo eixo de meses mostram a mesma coincidência
sem afirmá-la.

### Três regras que a série herda, e uma que é só dela

| Regra | De onde vem |
|---|---|
| Mês sem chamado coberto é **buraco** na linha, não queda a zero | 0039 |
| A série **termina no mês corrente**, mesmo pedindo competência futura | só dela |
| O pedido de meses é aparado em 36 | só dela |
| **O último ponto é igual ao indicador** acima dele | 0039 + asserção 44.1 |

A última é a que mais importa: um gráfico que discorda do indicador na mesma tela
é o defeito da conferência **desenhado** — e desenhado é pior, porque ninguém
confere um pixel. É por isso que o atraso do mês corrente vem da mesma coluna que
o indicador usa, e o schema prova a igualdade.

E uma coisa que só a série conta: **um projeto entregue hoje esteve atrasado em
julho e agosto.** O indicador é sempre relativo a hoje e não tem como saber disso.

---

## 7. Abrir o número

O contrato do GSTI pede que o indicador abra os registros que o produziram, "com
o mesmo recorte que produziu o número". Clicar em "ver os lançamentos" de uma
filial, ou em "ver os chamados" de uma fila, abre a lista embaixo da própria
linha — e **a lista confere a si mesma contra a linha que a abriu**.

Uma lista que não fecha com o número que a abriu é pior que nenhuma lista: ela
parece confirmar.

**O detalhe aberto mora na URL** (`?abrir=filial:<id>`), e não num estado de
componente. Assim ele volta com o botão "voltar", sobrevive ao recarregamento e
pode ser **mandado por mensagem** — a outra pessoa abre a tela no mesmo lugar,
com o mesmo recorte. Numa reunião, é a terceira que importa.

Trocar de cliente ou de mês **fecha** o detalhe: ele é de um recorte, e
carregá-lo para outro mostraria registros de um recorte sob o título de outro.

---

## 8. O custo com volume, medido

`scripts/medir-resultado.py` monta um cliente grande de verdade no banco de
validação — 1.440 lançamentos em 36 meses, 400 projetos e **25 mil chamados no
mês medido** — e mede a mediana de cinco execuções contra um orçamento de 400 ms.

Ele achou um defeito na primeira execução:

| Função | Antes | Depois |
|---|---|---|
| `gestao_resultado` | 93 ms | 94 ms |
| `gestao_gasto_por_filial` | 3 ms | 3 ms |
| `gestao_serie` (12 meses) | **1.253 ms** | **42 ms** |
| `gestao_serie` (36 meses) | **1.560 ms** | **42 ms** |

A primeira versão usava uma subconsulta correlacionada por mês, e reagrupava a
base inteira doze vezes. **Era correta e inutilizável** — que é como um defeito
de desempenho sempre se apresenta: o número certo, tarde demais. A versão atual
varre cada fonte uma vez, agrupa por mês e casa com a lista de meses; o custo
parou de crescer com o número de meses pedidos.

Detalhe que vale registrar: o recorte das CTEs é só o cliente, **sem filtro de
mês**. É de propósito — `period` é uma expressão agrupada (`date_trunc` sobre
`created_at`), e um filtro sobre ela não desce até a varredura dos chamados.
Ficaria pago o mesmo trabalho, com a aparência de estar limitado.

---

## 9. Permissões: uma chave para a tela, as do módulo para cada bloco

| Chave | Teto | O que governa |
|---|---|---|
| `gestao.resultado.ver` | gestor | **abrir a tela** |
| `financeiro.orcamento.ver` | gestor | o bloco de gasto |
| `projetos.projetos.ver` | visualizador | o bloco de projetos |
| `sla.compliance.ver` | gestor | o bloco de atendimento |

Módulo próprio com uma tela só, e isso é deliberado: a visão de resultado
atravessa três módulos, e pendurá-la em qualquer um deles
(`financeiro.resultado`? `projetos.resultado`?) diria que ela pertence àquele —
e quem concedesse a chave estaria concedendo mais do que imagina.

Sem a permissão de origem, **o bloco não aparece e a tela diz que está oculto por
permissão**. Mostrar zero seria lido como "não há gasto", que é outra coisa.

---

## 10. O defeito que esta migração corrigiu no orçamento

A 0038 definia o contrato dos cenários no comentário da tabela — "o `oficial`
alimenta os indicadores; os outros convivem sem contaminar os totais" — e
**nenhuma consulta o cumpria**. Não dava problema porque só existia o oficial.

No dia em que o primeiro cenário de simulação fosse criado, todo total de gasto
passaria a somar a simulação junto com o real. Sempre **para mais** — e ninguém
desconfia de um número que subiu: ele é lido como "o custo cresceu".

A 0039 acrescenta `scenario_key` a `vw_it_budget_monthly` e o filtro passou a ser
explícito na visão de resultado **e** na tela de orçamento, com asserção de
schema (43.1).

---

## 11. O que não foi verificado

- **A tela nunca foi aberta com dado real num navegador.** Ela está atrás do
  login (asserção de navegador) e o schema prova a aritmética dos indicadores,
  mas a leitura da tela cheia — ordem, densidade, o que salta primeiro — não foi
  avaliada por ninguém.
- **A conferência nunca acusou uma divergência de verdade.** Ela é exercitada em
  teste unitário, inclusive no caso que importa (o detalhe vazio contra o
  indicador diferente de zero). Em produção, com permissão de filial recortando
  uma consulta e não a outra, o comportamento é o esperado — mas não foi visto.
- **A série nunca foi vista desenhada.** A aritmética do gráfico tem 12 testes
  (escala, barra que não estoura o quadro, buraco que não vira reta, o único mês
  medido que não some) e o SVG não tem teste nenhum — ele é conferido por
  leitura. Um erro de atributo desenha errado em silêncio.
- **O gráfico não tem foco de teclado.** Os meses abaixo dele são links
  navegáveis, e o `<title>` de cada barra responde ao ponteiro; percorrer as
  barras pelo teclado, não. Quem não usa ponteiro tem a leitura completa no
  `aria-label` e os meses como destinos — o que atende, mas não é o mesmo.

> **Três itens saíram desta lista.** O gráfico e a abertura dos registros ao
> clique foram implementados (seções 6 e 7); o custo com volume foi medido, e a
> medição achou um defeito de 1,2 s na primeira execução (seção 8).
