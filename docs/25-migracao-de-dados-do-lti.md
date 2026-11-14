# 25. Trazer os dados do LTI

A [docs/23 §5](23-unificacao-lti-gsti.md) diz que a unificação **não migra dado
nenhum**, e que o importador seria projeto próprio, decidido depois que o
destino existisse. O destino existe desde a Fase 8. Este documento é esse
levantamento.

Ele não é um plano aprovado: é o que dá para afirmar hoje, o que falta decidir,
e as travas do banco que foram **medidas** — não supostas.

---

## 1. O que este levantamento NÃO pode afirmar

**Não tenho acesso ao LTI.** O que sei da origem vem da tabela de
correspondência da docs/23, escrita antes desta fase. Tudo abaixo que descreve o
LTI é, portanto, herdado de lá e precisa ser conferido contra o banco real antes
de virar plano.

O que está medido de verdade é o **destino**: 119 tabelas, as chaves
estrangeiras, os gatilhos e as travas de estado deste repositório, consultados
no banco. É também onde moram as surpresas, porque é o lado que recusa.

Três perguntas precisam de resposta de quem conhece o LTI, e nenhuma delas é
técnica:

1. **Até onde vai o histórico?** Trazer o mês corrente, o ano corrente ou tudo
   muda a ordem de grandeza e muda o que vale a pena automatizar.
2. **Chamado fechado entra?** Chamado aberto é operação; chamado fechado é
   arquivo. Os dois custam diferente (ver §4.3).
3. **Financeiro liquidado entra?** Título já pago é histórico contábil, e o
   caminho dele é mais caro que o do título em aberto (§4.2).

---

## 2. O que já existe e serve

A Fase 7 entregou um importador de planilha com conferência linha a linha, em
`/sistema/planilhas`. Ele **já cobre seis recursos**:

| Recurso | Serve para |
|---|---|
| Clientes | `clients` |
| Filiais | `branches` |
| Ativos de TI | `it_assets` |
| Peças | `parts` |
| Equipamentos de frota | `rental_equipment` |
| Leituras de medidor | `meter_readings` |

Isso não é pouco: são os cadastros de maior volume e o recurso com mais linhas
de todos (leitura de medidor — mil por mês não se digitam). E o importador já
resolve o que normalmente consome a maior parte do esforço de uma migração:
de-para de colunas, conferência que não grava, recusa linha a linha com motivo,
e arquivo de correção para a segunda tentativa.

**O que falta não é a máquina, é o resto do catálogo.** Faltam, pelo menos:
fornecedores, modelos/fabricantes/categorias de equipamento, contratos e seus
itens, faturas históricas e suas linhas, títulos a receber e a pagar, chamados,
e usuários com seus perfis.

---

## 3. A ordem, derivada das chaves estrangeiras reais

Não é preferência: é o grafo de dependências consultado no banco. Cada degrau só
pode entrar depois do anterior.

```
1. tenants  (já existe — é a empresa de destino)
2. clients ──────────────┐
   suppliers             │
   equipment_manufacturers, equipment_categories, equipment_depots
3. branches (depende de clients + business_hours)
   equipment_models (depende de manufacturers + categories)
   access_profiles
4. profiles  (depende de users, clients, access_profiles)
   rental_equipment (depende de models + depots)
   parts (depende de manufacturers)
5. rental_contracts (depende de clients)
   it_assets (depende de branches, suppliers, profiles)
6. rental_contract_items (contratos + equipamento + locais de operação)
   tickets (branches, clients, profiles, filas, catálogo, categorias…)
7. meter_readings (itens de contrato + equipamento)
   part_movements (peças, depósitos, perfis, chamados)
8. receivables / payables  (clientes, fornecedores, contas, centros de custo)
9. rental_invoices (clientes, contratos, E o título a receber)
10. rental_invoice_items (faturas + itens de contrato)
```

Dois detalhes desta ordem que não são óbvios:

- **`rental_invoices` depende de `receivables`**, e não o contrário: a fatura
  aponta para o título que ela gerou. Numa migração, o título histórico entra
  antes da fatura histórica.
- **`tickets` depende de `profiles`**, que dependem de `users`. Se os usuários
  do LTI não forem trazidos, todo chamado histórico perde o autor e o
  responsável — e aí a pergunta "quem atendeu isso?" deixa de ter resposta
  justamente no histórico que se quis preservar.

---

## 4. As quatro travas, medidas

### 4.1 Valor derivado não se importa

Este banco mantém por gatilho o que é soma de outra coisa:

| Valor | De onde sai |
|---|---|
| `rental_invoices.total` | soma das linhas (`trg_rental_invoice_items_total`) |
| `part_balances` | soma do razão de movimentos (`trg_part_movements_aplica`) |
| `rental_invoices.number` | contrato + competência, com sufixo na reemissão (0056) |

Consequência prática: **importa-se a linha, não o total.** Uma migração que
escreva `total` direto encontra o valor sobrescrito na primeira linha inserida —
ou, pior, bate por coincidência e esconde uma divergência.

E o saldo de peça: o razão é **imutável** (`trg_part_movements_imutavel` recusa
`update` e `delete`). O saldo inicial de cada peça entra como um **movimento de
abertura** datado, não como um número em `part_balances`. É mais trabalho e é a
única forma que mantém a conta auditável.

### 4.2 Título a receber não nasce pago

Medido em `trg_receivables_guard`:

```
if tg_op = 'INSERT' then
  if new.status not in ('draft', 'open') then
    raise exception 'Título a receber não pode ser criado com situação %'
```

Um título já liquidado no LTI **não pode ser inserido como `received`**. O
caminho é dois passos: inserir `open`, depois `update` para `received`, que a
máquina de estados permite.

Isso não é obstáculo a remover — é a garantia de que ninguém cria uma baixa sem
que ela tenha acontecido. Mas significa que **trazer o financeiro liquidado
custa o dobro de trazer o financeiro em aberto**, e enche o `audit_log` com uma
linha por baixa. Se a resposta à pergunta 3 da §1 for "só o que está em aberto",
a migração encolhe bastante.

### 4.3 A fatura aceita o que o título recusa

Uma assimetria que morderia alguém no meio do trabalho, e por isso está aqui:

| | Insert com estado final |
|---|---|
| `receivables` | **recusado** — gatilho roda no insert |
| `rental_invoices` | **aceito** — `trg_rental_invoices_valida` é `before update` |

A fatura histórica pode entrar direto como `issued`, com o `issued_on` real. O
título que ela gerou, não. As duas metades do mesmo documento precisam de
caminhos diferentes.

### 4.4 Chamado: onze gatilhos, e duas boas notícias

Inserir **um** chamado dispara onze gatilhos — SLA, histórico, auditoria,
conversa, alçada de campo. Era o risco que eu esperava encontrar, e medindo
apareceram duas coisas a favor:

- `app.tickets_after_insert_sla` usa **`new.created_at`**, e não `now()`. O
  chamado histórico começa a contar SLA na data em que de fato nasceu.
- `trg_tickets_before_insert` só atribui `ticket_number` **quando vem nulo**. O
  número original do LTI pode ser preservado.

Ou seja: o schema foi escrito tolerante a importação, sem que isso fosse um
objetivo declarado. O que **não** some é o volume de escrita colateral: cada
chamado histórico gera linha de `sla_tracking`, de histórico e de auditoria. Com
dezenas de milhares de chamados, isso é o que vai definir a janela da migração —
não o `insert` em si.

---

## 5. O caminho que eu proporia

**Não um importador novo.** O da Fase 7 já tem a parte difícil; o que falta é
catálogo. Acrescentar um recurso é descrever campos, chave natural e
referências em `src/lib/planilha/recursos.ts` — o mesmo lugar onde os seis
atuais estão.

Em três etapas, cada uma utilizável sozinha:

**Etapa A — cadastros.** Fornecedores, fabricantes, categorias, depósitos,
modelos. Baixo risco, nenhum dinheiro envolvido, e é o que destrava todo o
resto. Se a migração parar aqui, o sistema já é operável com dados reais.

**Etapa B — o que está vivo.** Contratos ativos, itens alocados, chamados
abertos, títulos em aberto, saldo de peça como movimento de abertura. É o
mínimo para desligar o LTI.

**Etapa C — o histórico.** Faturas e títulos liquidados, chamados fechados.
É a etapa cara (§4.2, §4.4) e a única que pode ser adiada sem travar a
operação — ou substituída por manter o LTI em leitura por um tempo.

Vale dizer em voz alta: **a Etapa C pode não valer a pena.** Manter o sistema
antigo acessível só para consulta costuma custar menos que migrar histórico
morto, e não corre o risco de reescrever número de documento.

---

## 6. Como provar que deu certo

Uma migração que "terminou sem erro" não disse nada. O que prova é reconciliação,
e ela precisa estar escrita antes de começar:

- **contagem por tabela**, origem × destino, com a diferença explicada linha a
  linha — não "aproximadamente igual";
- **soma do dinheiro**: total de títulos a receber em aberto, por cliente, nos
  dois lados. Se divergir em um centavo, divergiu;
- **amostra dirigida**: os dez maiores contratos conferidos à mão, na tela, por
  quem conhece o cliente;
- **o RLS**: uma sessão de outro tenant não pode ver nada do que entrou. O
  projeto já tem a rede para isso em `supabase/tests/schema_test.sql`, e foi ela
  que pegou o vazamento das views nas Fases 3 e 4.

E a regra que vale para toda migração: **ela roda em banco restaurado de backup
primeiro**, nunca direto em produção. O `scripts/ensaio-de-restauracao.sh` já
prova que o backup volta inteiro; o ensaio da migração usa esse mesmo caminho.

---

## 7. O que decidir para isto virar plano

1. Até onde vai o histórico? (§1)
2. Chamado fechado entra, ou o LTI fica em leitura? (§5, Etapa C)
3. Financeiro liquidado entra, ou só o que está em aberto? (§4.2)
4. Os usuários do LTI viram `profiles` aqui — com quais perfis de acesso?
5. Existe janela de parada, ou a virada precisa ser com o LTI de pé?

Respondidas essas cinco, o resto é execução, e o tamanho dela depende quase
inteiramente da primeira.
