# 20 — Orçamento de TI: quanto custa, e quanto vai custar

**Status:** implementado (migração 0038).
**Depende de você:** nada de configuração. Depende de **escolher o cliente** e,
se quiser começar pelo que já existe, de **importar os títulos a pagar**.

> Segundo módulo trazido do GSTI.IARX. O primeiro (projetos,
> [docs/19](19-modulo-de-projetos.md)) veio inteiro porque esta base não tinha
> nada. Este vem diferente, e a diferença é o ponto.

---

## 1. Duas perguntas sobre o mesmo dinheiro

`payables` já responde **quando eu pago**: vencimento, fornecedor, aprovação,
conta bancária, baixa. É contas a pagar, e funciona.

Este módulo responde outra coisa: **quanto a TI deste cliente custa por mês, por
filial e por categoria — e quanto vai custar.**

A diferença concreta é a **competência**: o mês a que a despesa pertence, e não
o mês em que ela é paga. Uma licença anual paga em janeiro pertence aos doze
meses, e quem pergunta "quanto a TI custou em agosto" quer o duodécimo, não
zero.

### Por que os dois não somam

Porque um título vira lançamento **uma vez só**, garantido por índice único em
`payable_id`.

```
payables ──► orcamento_importar_titulos() ──► it_cost_entries
                                              origem = 'titulo_a_pagar'
                                              payable_id = <o título>
```

A importação é **idempotente de propósito**: quem importa não tem como saber se
já importou, e vai tentar de novo. A segunda execução não duplica nada e diz
quantos já estavam lá.

Trazer o módulo financeiro inteiro do GSTI criaria uma segunda verdade sobre o
mesmo dinheiro — o mesmo contrato de licença viraria um título e um lançamento,
e os dois somariam. O campo `origem` do GSTI já antecipava a saída: ele distingue
planilha, manual e projeção, e "título a pagar" é a quarta origem natural.

---

## 2. A conferência de origem

É o que torna o total **verificável** em vez de explicado.

O número que o sistema mostra não é o total do que alguém digitou: parte veio de
título a pagar, parte de planilha, parte é projeção. A tela decompõe mês a mês
por procedência, e a soma das colunas tem de fechar no total — se não fechar, há
onde procurar.

| origem | o que significa |
|---|---|
| `titulo_a_pagar` | veio de `payables`, com o vínculo gravado |
| `planilha` | importado de fora, com o valor intocado |
| `projecao` | ainda não realizado — o contrato que está para entrar |
| `manual` | lançado na tela |

**Editar um lançamento não muda a origem.** Uma linha de título corrigida
continua vindo de um título, e a alteração fica na trilha de auditoria
([docs/18](18-revisao-e-lacunas-fechadas.md)).

---

## 3. O fechamento mensal

Uma competência fechada **recusa qualquer escrita** — inclusive por importação,
inclusive com justificativa. É a regra que dá sentido a um número divulgado: se
março pode mudar depois de o relatório de março ter saído, o relatório não vale
nada.

A trava está na trigger `trg_entry_fechamento`, e ela cobre quatro caminhos:

| tentativa | resultado |
|---|---|
| inserir na competência fechada | recusado |
| alterar lançamento dela | recusado |
| excluir lançamento dela | recusado |
| **mover** um lançamento para dentro dela | recusado |

O quarto é o que alguém tentaria para contornar os três primeiros.

**A recusa vem como erro, não como silêncio**, e isso é deliberado. Todo o resto
desta base trata negação de RLS como zero linhas — aqui zero linhas seria lido
como "não encontrei a linha". O fechamento não é questão de permissão: é uma
afirmação sobre o mês, e quem tentar escrever precisa saber disso.

**Reabrir exige motivo**, e a linha do fechamento **não é apagada**: ela ganha a
data da reabertura e a causa. Apagar faria "este mês já esteve fechado?" perder
resposta — e essa é exatamente a pergunta de quem audita um número que mudou.

Fechar é **permissão própria** (`financeiro.orcamento.fechar`): quem lança não
decide quando o mês para de aceitar lançamento.

---

## 4. Natureza, classificação e parcelamento

| natureza | o que faz |
|---|---|
| `pontual_unica` | uma ocorrência |
| `fixa` | uma por mês até a vigência — ou 24 meses à frente, se em aberto |
| `pontual_parcelada` | uma por mês, com a soma fechando no total |

**Vigência em aberto projeta para frente.** Encerrar um contrato é cadastrar a
vigência dele; supor uma data que ninguém informou inventaria o fim de contratos
em vigor.

**A série é gravada, não calculada na leitura**, porque cada ocorrência é
editável por si: um contrato que reajusta em julho tem onze meses de um valor e
um de outro. Uma série calculada não teria onde guardar a exceção — e a exceção
é o caso normal.

### O rateio que fecha na conta

100,00 em 3 **não** é 33,33 três vezes: é 33,34 + 33,33 + 33,33. O resto vai nas
primeiras parcelas, que é a convenção comercial brasileira — e, mais importante,
é o que faz a soma do parcelamento bater com o valor do contrato. Um centavo de
diferença por contrato, em cem contratos, é o tipo de erro que ninguém encontra
depois: aparece quando o cliente confere a planilha contra a nota.

A propriedade tem teste dos dois lados — `app.ratear_valor()` no banco e
`ratear()` no navegador, para a prévia — sobre vários totais e divisores. O caso
que quebra nunca é 100 em 2; é 1.000,01 em 7.

### O valor informado é o total ou a parcela?

As duas leituras existem na vida real: "R$ 12.000 em 12x" e "12x de R$ 1.000".
Supor uma delas erraria o total por doze, então o formulário pergunta — e mostra
a prévia das parcelas antes de gravar.

### Dinheiro é `numeric(14,2)`, e não centavos inteiros

O GSTI guarda centavos inteiros, e o motivo está escrito lá: *"elimina erro de
ponto flutuante em somatórios"*. O motivo é do **SQLite**, que não tem decimal
exato.

O PostgreSQL tem: `numeric` é exato, e é o que `payables.amount` já usa. Manter
o mesmo tipo é o que permite somar um lançamento contra um título sem conversão
— e conversão de unidade entre duas tabelas da mesma base é exatamente onde um
centavo se perde.

(No TypeScript a conta é feita em centavos inteiros, porque lá `0.1 + 0.2` é
`0.30000000000000004` de verdade.)

---

## 5. Consumo compartilhado

A melhor ideia do financeiro do GSTI, e a que esta base não tinha de forma
nenhuma.

Uma matriz que centraliza as licenças de seis filiais aparece como **a unidade
cara**, e as filiais que consomem aparecem baratas. O número está certo e a
leitura, errada — e é com essa leitura que alguém decide cortar custo na unidade
errada.

`consumo = 'compartilhado'` marca o lançamento, e `it_cost_beneficiaries` guarda
quais filiais consomem. A lista é **congelada na gravação**: uma filial
cadastrada em março não passa a se beneficiar de um lançamento de janeiro, e o
mês fechado não muda de número sozinho.

---

## 6. O que se reusou, e o que ficou de fora

### Reusado em vez de recriado

| GSTI | Aqui |
|---|---|
| `tipos_despesa` | `expense_categories` (0018) |
| `empresas` / `filiais` | `clients` / `branches` |
| `fornecedor` (texto livre) | `suppliers` (entidade) |
| `origem_custo` (texto livre) | `cost_centers` |
| `usuarios` | `profiles` |

### Um defeito encontrado ao reusar

`expense_categories` está no banco desde a 0018, `payables` aponta para ela, e a
tela de títulos a pagar lê a lista para um `select` — **e nenhuma linha nunca foi
criada**. Não há seed e não há tela de cadastro: o campo "Categoria" do título a
pagar sempre teve uma opção só, a vazia.

É a mesma classe de defeito que a revisão da 0036 encontrou
([docs/18](18-revisao-e-lacunas-fechadas.md)), e aqui era bloqueante:
`it_cost_entries.expense_category_id` é `NOT NULL` de propósito — custo sem
categoria não responde "quanto a TI gasta com o quê".

A 0038 traz os **nove tipos padrão do GSTI** (Pessoas, Equipamentos de TI,
Licenças de software, Locação de impressora, Materiais de TI, Serviços técnicos,
Telefonia e internet, Serviços de desenvolvimento, Sistemas gerenciais), e um
tenant novo nasce com eles.

### Deixado de fora, com motivo

| O que | Por quê |
|---|---|
| `reconhecedores_origem` e o fluxo de "reconhecido" | Existe para a carga do ERP de um cliente específico, lendo a coluna `CREATIONUSER`. Sem essa importação, não tem entrada |
| `planos_reducao` | É um segundo artefato de planejamento ao lado das metas, e o teto por competência já responde "quanto podemos gastar". Entra quando houver quem o use |
| `planejamento` (JSON com `proj_diarias`, `proj_pacientes`) | É da operação de saúde daquele cliente, não de gestão de TI |
| Relatório com *drill-down* de três níveis | A tela entrega o consolidado por competência e a lista do mês. A tabela dinâmica com meses nas colunas e hierarquia nas linhas é trabalho próprio, e grande |

---

## 7. Permissões

| Chave | Teto | Quem usa |
|---|---|---|
| `financeiro.orcamento.ver` | gestor | abrir o orçamento |
| `financeiro.orcamento.lancar` | gestor | lançar custo, importar títulos, definir meta |
| `financeiro.orcamento.fechar` | gestor | fechar e reabrir competência |

**O gestor de TI recebe o orçamento sem receber o resto do financeiro.** Quem
responde pelo custo da TI é ele; título a pagar continua sendo de quem paga. É a
única exceção por chave na função de perfis de sistema, e ela está comentada lá.

---

## 8. O que não foi verificado

- **Nenhum dado do GSTI foi migrado**, pelo mesmo motivo do módulo de projetos:
  os modelos divergem (centavos inteiros → `numeric`, texto `AAAA-MM` → `date`,
  inteiro → uuid) e um importador é trabalho próprio, com conferência de totais
  — que é justamente o que não dá para pular num módulo financeiro.
- **A importação de títulos nunca rodou com volume.** A função é idempotente por
  índice único, e isso tem asserção de schema; o comportamento com milhares de
  títulos numa competência não foi medido.
- **Os cenários alternativos existem no banco e não na tela.** `it_budget_scenarios`
  aceita quantos cenários o cliente quiser, e a tela usa sempre o `oficial`.
  Comparar dois cenários lado a lado é a próxima tela, não a primeira.

  > **Corrigido na 0039.** O contrato — "o `oficial` alimenta os indicadores; os
  > outros convivem sem contaminar os totais" — estava só no comentário da
  > tabela: nem a tela nem a view filtravam por cenário, porque até então só
  > existia o oficial. No dia em que o primeiro cenário de simulação fosse
  > criado, todo total de gasto passaria a somar a simulação junto com o real —
  > sempre **para mais**, e ninguém desconfia de um número que subiu. A 0039
  > acrescenta `scenario_key` a `vw_it_budget_monthly` e o filtro passou a ser
  > explícito nas duas telas, com asserção de schema.
- **As metas gravam e não são cobradas.** `it_budget_targets` guarda o teto, e
  nenhuma tela ainda compara o gasto contra ele. Sem a comparação, a meta é um
  cadastro inerte — e é o próximo passo mais barato deste módulo.
