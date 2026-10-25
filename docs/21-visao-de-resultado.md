# 21 — Visão de resultado: custo, prazo e entrega numa tela só

**Status:** implementado (migração 0039).
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

## 6. Permissões: uma chave para a tela, as do módulo para cada bloco

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

## 7. O defeito que esta migração corrigiu no orçamento

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

## 8. O que não foi verificado

- **A tela nunca foi aberta com dado real num navegador.** Ela está atrás do
  login (asserção de navegador) e o schema prova a aritmética dos indicadores,
  mas a leitura da tela cheia — ordem, densidade, o que salta primeiro — não foi
  avaliada por ninguém.
- **A conferência nunca acusou uma divergência de verdade.** Ela é exercitada em
  teste unitário, inclusive no caso que importa (o detalhe vazio contra o
  indicador diferente de zero). Em produção, com permissão de filial recortando
  uma consulta e não a outra, o comportamento é o esperado — mas não foi visto.
- **Nenhum gráfico.** O painel do GSTI tem série temporal e barras; esta tela
  entrega números e tabelas. A série mensal de custo já existe na tela de
  orçamento, e duplicá-la aqui antes de alguém pedir seria enfeite.
- **Não há *drill-down* por clique.** O contrato de leitura do GSTI pede que o
  indicador abra os registros que o produziram. Aqui o detalhe vem junto, na
  mesma tela, com link para o módulo de origem — que atende o propósito e não o
  gesto.
- **O desempenho com volume não foi medido.** `gestao_resultado()` monta cinco
  CTEs sobre três views. Com um cliente de centenas de projetos e dezenas de
  milhares de chamados no mês, o custo não foi observado.
