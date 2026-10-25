# 19 — Projetos: o primeiro módulo vindo do GSTI.IARX

**Status:** implementado (migração 0037).
**Depende de você:** nada. Nenhuma variável, nenhuma credencial.

> O GSTI.IARX tem três módulos. Este documento explica por que **um** veio
> inteiro, **um** vai entrar lendo o que já existe e **um não entra** — e
> entrega o primeiro.

---

## 1. Os três módulos, e três respostas diferentes

O GSTI.IARX é um SaaS de gestão para gestores de TI, com Financeiro, Projetos e
Suporte. A pergunta "dá para trazer como módulo?" tem uma resposta por módulo,
porque a relação de cada um com o que já existe aqui é diferente.

| Módulo do GSTI | Decisão | Por quê |
|---|---|---|
| **Projetos** | ✅ **vem inteiro** | Esta base não tinha nada. Lacuna limpa |
| **Financeiro** | ⚠️ **vem a camada de planejamento** | `payables` já guarda título a pagar com parcelamento, centro de custo e filial. Falta o planejamento por competência — e ele entra lendo o que existe |
| **Suporte / SLA** | ❌ **não entra** | Aquele módulo existe porque o GSTI não tem helpdesk. Esta base **é** o helpdesk |

### Por que o módulo de SLA não entra

É a decisão que mais economiza trabalho futuro, então vale ser explícito.

No GSTI, `tickets_sla` guarda, por mês e por fila, o total atendido e quanto
ficou dentro do SLA — digitado ou importado de uma planilha. Faz sentido lá: o
sistema não atende chamado nenhum, então o número tem de vir de fora.

Aqui o número **é derivado**: `sla_tracking` acompanha chamado por chamado, com
expediente, feriado e pausa de relógio ([docs/18](18-revisao-e-lacunas-fechadas.md)),
e `/sla` mostra a conformidade calculada. Trazer o agregado criaria um número
digitado competindo com um número derivado, e no dia em que os dois divergirem —
e eles vão divergir — ninguém saberá qual está certo.

O que o GSTI tem e aqui falta não é a tabela: é a **leitura mensal consolidada**
para o gestor. Isso é relatório sobre o que já existe, e entra como tela, não
como tabela.

---

## 2. O que o módulo de Projetos faz

Projeto com cronograma mensal, tarefas em até três níveis, envolvidos, e dois
números que ninguém digita: **atraso** e **desvio**.

### Atraso é derivado, nunca digitado

É a regra central, e a razão de o número ser confiável:

- **Atraso** existe quando o mês corrente passou do fim planejado e não há fim
  real registrado. Ninguém marca um projeto como atrasado — logo, o número não
  depende de alguém lembrar de atualizá-lo.
- Registrado o fim real, o atraso **vira desvio**: a diferença em meses entre o
  planejado e o entregue, que pode ser **negativa** quando a entrega veio
  adiantada.
- **Cancelado nunca acusa atraso.** Um projeto que a empresa decidiu não fazer
  não é um prazo perdido.

Os dois são calculados em view (`vw_projects`, `vw_project_tasks`), e não
gravados em coluna, porque atraso **muda sozinho com a passagem do mês**: uma
coluna precisaria de um trabalho agendado só para envelhecer o número, e estaria
errada entre uma execução e outra.

### Projeto concluído exige o mês de fim real

Garantido por CHECK no banco. Sem isso, "concluído" vira um rótulo que alguém
marca enquanto o cronograma continua mostrando a barra planejada sem a
realizada: o projeto **parece** entregue e não tem desvio nenhum para medir.

---

## 3. O que mudou em relação ao original

### A competência virou `date`

No GSTI ela é texto `AAAA-MM` com validação por `GLOB`, porque o SQLite não tem
tipo de mês. Aqui é um `date` preso ao dia 1 por CHECK (`app.eh_competencia`).

Com isso, comparação, intervalo e diferença em meses viram aritmética de data em
vez de comparação de string — e o banco recusa `2026-03-15`, que não é uma
competência.

O cronograma é mensal porque projeto de TI se planeja em meses. Um campo com
precisão de dia que ninguém preenche com precisão de dia produz um Gantt que
mente: a barra começa em 03/04 porque foi o dia em que alguém abriu o
formulário, não porque algo acontece no dia 3.

### A hierarquia passou a ser garantida pelo banco

O schema do GSTI diz, em comentário:

> *profundidade e ciclo o SQLite não expressa em CHECK*

— e valida no domínio TypeScript. Funciona para quem passa pela função certa, e
**não funciona** para importação, correção manual ou qualquer outro caminho de
escrita.

O PostgreSQL expressa, e aqui expressa. A trigger `trg_task_hierarquia` recusa:

| regra | o que aconteceria sem ela |
|---|---|
| Tarefa principal do mesmo projeto | um cronograma agrupando por fora de si |
| Sem ciclo | o Gantt entra em laço infinito, e o sintoma em produção é a tela que não carrega |
| Até 3 níveis, **contando a subárvore que vem junto** | mover uma tarefa com duas gerações abaixo para outra raiz estouraria o teto mesmo que ela própria coubesse |

As três têm asserção de schema na seção 41 de `schema_test.sql`.

### Excluir tarefa principal é bloqueado, não cascateado

Em cascata, uma confirmação de "excluir 1 tarefa" apagaria a subárvore inteira
em silêncio — exatamente o que a regra de auditoria desta base não admite. A
chave estrangeira é `on delete restrict`, e a ação lista as subtarefas para a
pessoa saber o que desagrupar primeiro.

### Duas permissões de escrita, não uma

É acréscimo desta base, e vem de como o helpdesk daqui já pensa:

- **`editar`** (teto `gestor`) é de quem **planeja**: criar tarefa, mudar prazo,
  reagrupar hierarquia.
- **`executar`** (teto `atendente`) é de quem **faz**: marcar andamento e
  registrar o mês de entrega.

Exigir papel de gestor para alguém dizer "terminei" faria o cronograma
envelhecer no gargalo de quem o administra — e cronograma desatualizado não
mede nada.

---

## 4. O cronograma

Um Gantt de granularidade mensal, com a barra planejada e, abaixo, a realizada
quando existe, mais o marcador do mês corrente.

**Grade de CSS, não biblioteca.** Um Gantt mensal é uma tabela: linhas de
tarefa, colunas de mês, barras ocupando colunas contíguas. `grid-column` faz
isso em três linhas. Uma biblioteca traria arrastar-e-soltar, zoom por dia e
dependências entre tarefas — recursos que este cronograma não tem e cuja
ausência não se nota — em troca de centenas de kB e de um componente que não
funciona no tema escuro sem remendo.

Três comportamentos valem registro, e os três têm teste:

- **Grupo comprimido cobre o intervalo agregado**, do início mais cedo ao fim
  mais tarde da subárvore. Esconder as subtarefas **não pode encolher** o tempo
  que elas ocupam — senão o cronograma parece mais curto exatamente quando
  alguém o comprimiu para enxergar o todo.
- **O realizado do grupo só aparece com a subárvore inteira entregue.** Uma
  barra realizada parcial diria que o grupo foi entregue.
- **Tarefa sem fim real não tem barra realizada.** Desenhá-la até o mês corrente
  faria uma tarefa esquecida parecer em andamento.

E o que fica guardado no navegador é o conjunto dos **comprimidos**, não o dos
expandidos: assim um grupo criado depois nasce aberto, em vez de herdar o
silêncio de uma lista que não o conhecia.

### A tarefa principal se escolhe, nunca se digita

Defeito relatado no GSTI original, e a correção vale repetir: com um campo de
texto livre, errar um acento devolvia *"não existe uma tarefa X"* para uma
tarefa que existe. E num projeto ainda sem tarefa nenhuma o campo continuava
pedindo um nome que não havia como fornecer.

O seletor traz as tarefas existentes **indentadas pelo nível** — a indentação é
o que diz se a escolha vai criar um segundo ou um terceiro nível, informação que
uma lista plana de nomes não dá. E só oferece quem ainda cabe um nível abaixo:
oferecer as demais seria oferecer um erro.

---

## 5. Onde fica

`/projetos` entra no grupo **Atendimento** do menu, e não num grupo próprio: o
cronograma de TI é trabalho da mesma equipe que atende, e um grupo com um item
só acrescentaria um cabeçalho e nada mais.

| Chave | Teto | Quem usa |
|---|---|---|
| `projetos.projetos.ver` | visualizador | abrir a lista e o cronograma |
| `projetos.projetos.executar` | atendente | marcar andamento e entrega |
| `projetos.projetos.criar` | gestor | criar projeto |
| `projetos.projetos.editar` | gestor | cronograma, tarefas e envolvidos |
| `projetos.projetos.excluir` | gestor | excluir projeto |

---

## 6. O que não foi verificado

- **Nenhum dado do GSTI foi migrado.** Não há importador de `projetos`/`tarefas`
  daquele banco para este, e os modelos são diferentes o bastante (texto
  `AAAA-MM` → `date`, inteiro autoincremento → uuid, `empresa`/`filial` →
  `client`/`branch`) para que um importador seja trabalho próprio, com
  conferência de totais. Hoje o cadastro é pela tela.
- **O Gantt não foi exercitado em navegador com dados reais.** As asserções de
  navegador cobrem que `/projetos` fica atrás do login; a aritmética das barras,
  da ordem de leitura e do grupo comprimido tem 24 testes de unidade, que é onde
  um cronograma errado é detectável — ele não dá erro, desenha a barra no lugar
  errado e quem olha acredita.
- **Não há virtualização acima de 60 linhas**, que o original tem. Com projetos
  de 20 a 40 tarefas o DOM dá conta; a virtualização entra quando aparecer um
  cronograma que a exija, e não antes.

---

## 7. O que vem a seguir

O módulo financeiro de gestão: competência, natureza (fixa / pontual / parcelada),
classificação (despesa / investimento), cenários de projeção, fechamento mensal e
metas — **lendo `payables` como uma das origens**, em vez de criar uma segunda
verdade sobre o mesmo dinheiro. O campo `origem` do GSTI já antecipa exatamente
isso: ele distingue planilha, manual e projeção, e "título a pagar" é a quarta
origem natural.
