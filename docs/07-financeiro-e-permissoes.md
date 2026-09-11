# 07 — Financeiro, Controle de Despesas e Permissões

> Documento vivo. Especifica os três módulos pedidos — **Gestão de Usuários e
> Permissões**, **Financeiro** e **Controle de Despesas** — na ordem de
> prioridade em que devem ser construídos, e registra o que já está pronto.

## Como ler este documento

Cada módulo segue o mesmo template de [06](06-lacunas-e-roadmap.md), acrescido
de **Fluxos de Aprovação** e **Automações** onde há workflow. A seção
"Endpoints de API" lista **Server Actions**, não rotas REST — ver a adaptação
arquitetural abaixo — e cada uma vem com a permissão que exige.

`[LACUNA]` = falta informação de negócio. `[DECISÃO PENDENTE]` = a decisão é do
operador; há uma recomendação, e o padrão adotado está declarado.

---

## Adaptação arquitetural — por que não há "middleware de autorização"

A especificação de origem pressupõe API REST com middleware. Este projeto não
tem isso, e traduzir literalmente produziria código que não protege nada:

| Especificação de origem | Aqui | Motivo |
|---|---|---|
| "Middleware intercepta toda requisição, extrai o perfil do JWT, consulta permissões, retorna 403" | `requirePermission()` no topo de cada Server Action | `src/app/api/health/route.ts` é a **única** rota de API. `src/proxy.ts` é middleware de borda e só distingue autenticado de anônimo — ele não sabe qual ação será chamada, porque a Server Action é resolvida depois. |
| "Validar permissão em todos os endpoints" | as **63 Server Actions** em 14 arquivos | É a superfície de escrita real. Inventário completo na seção do Módulo 1. |
| "Aplicar filtro de filial em todas as queries" | **já existe**, não se mexe | `app.can_see_branch()` (`0002_core.sql:211`) + 162 policies de RLS. Estendido, nunca reescrito. |
| "Tabela `permissions` com coluna `permitido` booleana" | catálogo global + `permission_grants` sem booleano | Com "liberação explícita", `permitido = false` e a ausência da linha significam o mesmo fato. Duas representações do mesmo fato divergem: sobra linha falsa que ninguém limpa. |
| "Cache de permissões no estado global do frontend" | `getSessionContext()`, memoizado por requisição | Já existe `cache()` do React. Mandar a matriz para o cliente exporia a estrutura de permissões de todos no bundle, em troca de nada — a decisão é do servidor. |
| "Perfis Aprovador N1 / N2 / N3" | um perfil **Aprovador Financeiro** + nível na cadeia de aprovação | O nível de alçada não é atributo da pessoa: a mesma pessoa pode ser N1 de um centro de custo e N2 de outro. Amarrar o nível ao perfil forçaria um nível único por pessoa em toda a operação. |

**A barreira real continua sendo o RLS.** `requirePermission()` e `<Can>` evitam
mostrar e executar caminho que termina em erro; quem garante que o dado não sai é
o banco.

---

## MÓDULO 1 — Gestão de Usuários e Permissões

### Status
- [x] **Implementado** (migração `0017`, commits `5d1ced2`, `79010d4`, `6661b0c`)

### Descrição
Dois eixos de autorização que coexistem. `profiles.role` (seis papéis fixos)
continua governando o RLS; `access_profiles` acrescenta granularidade
módulo → tela → ação por cima, sem reescrever nenhuma policy.

A decisão de coexistir, e não substituir, foi tomada com o operador: substituir
exigiria reescrever 162 policies, 7 funções `app.*` e 62 pontos de código de uma
vez, com risco real de abrir brecha de isolamento entre tenants no meio do
caminho.

### Modelagem de Dados

**`permission_catalog`** (global, sem `tenant_id` — a superfície é da aplicação,
não do cliente):

| Campo | Tipo | Observação |
|---|---|---|
| `key` | text PK | `modulo`, `modulo.tela` ou `modulo.tela.acao` |
| `module` / `screen` / `action` | text | `screen` e `action` nulos nos níveis superiores |
| `label` | text | rótulo exibido na matriz |
| `min_base_role` | text | papel mínimo que consegue exercer de fato |
| `sort_order` | integer | ordem na matriz |

Constraints: `key = concat_ws('.', module, screen, action)` — a chave é derivada
da trinca, e gravar as duas coisas deixando-as divergir quebraria a árvore da
UI; `action is null or screen is not null`.

**147 entradas, GERADAS de `src/lib/permissions.ts`.** O teste de schema compara
a contagem: mexer no TypeScript sem regenerar derruba o CI em vez de virar
permissão fantasma.

**`access_profiles`** (por tenant): `id`, `tenant_id`, `name`, `description`,
`base_role` (teto), `is_system`, `system_key`, `is_active`.
Unique `(tenant_id, lower(name))` e `(id, tenant_id)` para FK composta.

**`permission_grants`**: `(profile_id, permission_key)` PK, `tenant_id`.
**Presença da linha É a concessão** — não existe coluna `allowed`.

**Alteração em tabela existente:** `profiles.access_profile_id` (nullable, FK
composta `(access_profile_id, tenant_id)`).

**Funções** (`SECURITY DEFINER`, `search_path` fixo, no padrão de
`app.current_role()`):

| Função | O que faz |
|---|---|
| `app.role_rank(text)` | ordem de privilégio, para comparar teto |
| `app.current_access_profile_id()` | perfil da sessão |
| `app.effective_base_role()` | **menor** entre `profiles.role` e o teto do perfil |
| `app.has_permission(key)` | exige o grant da chave **e** de todos os ancestrais |

Os três predicados (`can_manage_config`, `can_manage_records`,
`can_work_tickets`) foram redefinidos para ler `effective_base_role()`. Como
o backfill deixa `base_role = role`, o comportamento imediato é idêntico.

**RLS:** catálogo legível por todo `authenticated` (não tem dado de tenant);
perfis e grants legíveis pelo tenant e graváveis por `can_manage_config()`.

### Regras de Negócio
1. **Negação herda para baixo; liberação é explícita.** Sem o grant do módulo,
   nada dentro dele. Com o módulo, cada tela e cada ação ainda precisa do seu
   grant. Esquecer de marcar nega — nunca libera.
2. **O perfil só restringe.** `effective_base_role()` é o mínimo entre papel e
   teto: dar perfil de teto `admin` a um `atendente` não promove ninguém.
3. Grant acima do teto do perfil é **recusado na escrita** pela trigger
   `trg_permission_grants_within_base_role`.
4. Perfil de sistema aceita apenas mudança de situação (ativo/inativo).
5. Ninguém altera o próprio perfil de acesso (`trg_profiles_no_self_profile_change`).
   A trigger de `0012` só olhava `role` e `tenant_id` — esta era porta aberta
   para auto-promoção.
6. Usuário sem perfil cai no papel puro (`permissionsFromRole`), o que preserva
   o comportamento anterior e evita que `super_admin` fique sem tela alguma.
7. Todo tenant nasce com 9 perfis de sistema; todo usuário com papel conhecido
   recebe um, por trigger.

### Fluxo de Usuário
1. Admin abre **Perfis de acesso**, cria um perfil e escolhe o papel base.
2. Abre **Permissões** do perfil e marca a árvore. Ação acima do teto aparece
   com cadeado e explicação — escondê-la faria o admin concluir que a permissão
   não existe.
3. Salva: o servidor fecha a hierarquia (`withAncestors`) e recusa o conjunto
   inteiro se algo passar do teto, com a lista do que está fora.
4. Em **Usuários**, atribui o perfil. A própria conta é recusada.

### Endpoints de API
Server Actions em `src/app/(app)/perfis/actions.ts`:

| Action | Efeito | Permissão |
|---|---|---|
| `createAccessProfile` | Cria perfil customizado | `usuarios.perfis.criar` |
| `updateAccessProfile` | Nome, descrição, teto | `usuarios.perfis.editar` |
| `setAccessProfileActive` | Ativa/inativa | `usuarios.perfis.inativar` |
| `saveProfileGrants` | Substitui a matriz do perfil | `usuarios.perfis.editar` |
| `setUserAccessProfile` | Atribui perfil ao usuário | `usuarios.usuarios.editar_acesso` |

### Dependências
- **Depende de:** nada. É a base de todo o resto.
- **Habilita:** todos os módulos financeiros. A regra do próprio escopo é não
  avançar para o financeiro antes deste módulo estar fechado.

### Critérios de Aceite
- [x] Matriz módulo → tela → ação configurável pelo admin do cliente.
- [x] Negação herda; liberação explícita (27 testes de unidade).
- [x] Perfil não eleva privilégio (teste nas duas direções).
- [x] Grant fora do teto recusado no banco.
- [x] Auto-alteração de perfil recusada.
- [x] Isolamento de perfis e grants entre tenants.
- [x] 60 das 63 Server Actions com gate de permissão. As 3 restantes são
      `signIn` e `signOut` (antecedem a sessão) e `changePassword` (auto-serviço:
      trocar a própria senha não é permissão de módulo). Um teste em
      `src/lib/permissions.usage.test.ts` cobra que toda chave de ação do catálogo
      seja consultada em algum guard.
- [x] 16 páginas com gate de tela; menu derivado da permissão.
- [ ] Fluxo "logar como Operador Financeiro e não ver o botão Aprovar" — exige
      Supabase real (ver Verificação).

### Lacunas e Decisões Pendentes
- **`[DECISÃO PENDENTE]` Expiração periódica de senha.** O Supabase Auth não
  oferece de fábrica. Exige `password_changed_at` em `profiles` + checagem no
  login + tela de troca forçada. É escopo, não configuração.
- **`[DECISÃO PENDENTE]` Bloqueio após N tentativas inválidas.** Idem: precisa
  de contador próprio (`failed_login_count`, `locked_until`) e de decisão sobre
  desbloqueio automático por tempo ou manual pelo admin. Recomendação:
  automático após 15 minutos, com desbloqueio manual disponível.
- **`[DECISÃO PENDENTE]` Log de acessos** (data, IP, dispositivo). `audit_log`
  cobre mudança de dado, não sessão. Exige tabela própria alimentada no
  `signIn` — e decisão de retenção, porque IP é dado pessoal (LGPD).
- **`[LACUNA]` Visibilidade por filial na matriz.** Hoje filial é RLS e
  permissão é ação; as duas se somam. Unir numa matriz só produziria uma tabela
  de centenas de células. Mantido separado até haver pedido concreto.

---

## MÓDULO 2 — Centros de Custo

### Status
- [x] **Implementado** (migração `0018`, commit `c14a9ff`)

### Descrição
Dimensão de rateio de todo lançamento financeiro, hierárquica em até 3 níveis.

### Modelagem de Dados
`cost_centers`: `id`, `tenant_id`, `parent_id`, `code`, `name`, `description`,
`branch_id` (nulo = global), `is_active`.
Unique `(tenant_id, lower(code))` e `(id, tenant_id)`. FK composta para `parent`
e `branch`, ambas `on delete restrict`.

Trigger `trg_cost_center_depth` recusa o 4º nível **e o ciclo** — sem a saída por
ciclo, apontar o avô para o neto giraria para sempre e travaria a transação em
vez de recusá-la.

### Regras de Negócio
1. Máximo 3 níveis (centro → subcentro → sub-subcentro), como
   `app.enforce_category_depth()` e pelo mesmo motivo: relatório de DRE precisa
   de profundidade conhecida.
2. Código único por tenant, ignorando maiúsculas.
3. Hierarquia não forma ciclo; centro não é pai de si mesmo.
4. `branch_id` nulo = centro global do tenant.
5. Inativar não apaga: o que já foi rateado continua no histórico.

### Endpoints de API
`src/app/(app)/financeiro/actions.ts`:

| Action | Permissão |
|---|---|
| `createCostCenter` | `financeiro.centros_custo.criar` |
| `updateCostCenter` | `financeiro.centros_custo.editar` |
| `setCostCenterActive` | `financeiro.centros_custo.inativar` |

### Dependências
- **Depende de:** Módulo 1 (permissões), `branches`.
- **Habilita:** Contas a Pagar, Contas a Receber, Controle de Despesas,
  Orçamento. **É gargalo:** nenhum relatório de despesa por área existe sem ele.

### Critérios de Aceite
- [x] Cadastrar, editar e inativar em 3 níveis.
- [x] 4º nível e ciclo recusados pelo banco.
- [x] Código duplicado recusado (case-insensitive).
- [ ] **Rateio de um lançamento entre múltiplos centros** — chega com Contas a
      Pagar (ver `[DECISÃO PENDENTE]` abaixo).

### Lacunas e Decisões Pendentes
- **`[DECISÃO PENDENTE]` Rateio: percentual ou valor fixo?** Recomendação:
  **percentual**, com validação de soma = 100%. Valor fixo obriga a reajustar
  todas as linhas quando o título muda de valor, e permite rateio que não fecha
  com o total. Tabela prevista: `payable_cost_center_allocations
  (payable_id, cost_center_id, percentage)`.

---

## MÓDULO 3 — Contas Bancárias

### Status
- [x] **Implementado** (migração `0018`, commit `c14a9ff`)

### Descrição
Contas do tenant, extrato, conciliação e transferência interna por dupla entrada.

### Modelagem de Dados
`bank_accounts`: identificação bancária, `account_type`
(corrente/poupança/pagamento/investimento), `opening_balance`, `credit_limit`,
`status` (ativa/inativa/bloqueada), `deleted_at`.

`bank_account_movements`: `direction` (`in`/`out`), `amount` **sempre positivo**,
`moved_on`, `description`, `cost_center_id`, `transfer_group`, `reconciled_at`,
`created_by`.

`vw_bank_account_balances`: saldo inicial + entradas − saídas, com contagem de
não conciliados. **Saldo é derivado, nunca gravado** — saldo materializado e
movimentação divergem no primeiro arredondamento.

### Regras de Negócio
1. Valor sempre positivo; o sinal é responsabilidade de `direction`. Guardar
   negativo duplicaria a informação e permitiria "saída de valor negativo".
2. Transferência interna = duas linhas com o mesmo `transfer_group`, em contas
   distintas, mesmo valor, sentidos opostos. Validado por trigger `deferrable`
   e **por statement**: `FOR EACH ROW` recusaria a transferência antes de a
   segunda metade existir.
3. Origem e destino diferentes (validado também no schema Zod).
4. Saldo abaixo de `-credit_limit` é sinalizado como "acima do limite".
5. Conciliação é reversível.

### Automações
- Nenhuma nesta entrega. **Importação de extrato** e matching automático são o
  próximo passo — ver `[DECISÃO PENDENTE]`.

### Endpoints de API

| Action | Permissão |
|---|---|
| `createBankAccount` / `updateBankAccount` | `financeiro.contas_bancarias.criar` / `.editar` |
| `setBankAccountStatus` | `financeiro.contas_bancarias.inativar` |
| `createBankMovement` | `financeiro.contas_bancarias.movimentar` |
| `transferBetweenAccounts` | `financeiro.contas_bancarias.transferir` |
| `toggleMovementReconciled` | `financeiro.contas_bancarias.movimentar` |

### Critérios de Aceite
- [x] Múltiplas contas por tenant, com saldo em tempo real.
- [x] Transferência interna com dupla entrada; meia transferência recusada.
- [x] Extrato cronológico consolidado.
- [x] Alerta de saldo acima do limite.
- [x] Conciliação manual reversível.
- [ ] Importação de extrato (CSV/OFX) com matching.

### Lacunas e Decisões Pendentes
- **`[DECISÃO PENDENTE]` Formato de importação de extrato.** Recomendação:
  **CSV e OFX primeiro** (cobrem a maioria dos bancos e são parseáveis sem
  biblioteca proprietária); **CNAB 240/400 depois**, porque cada banco tem
  layout próprio e exige um parser por banco — é um projeto, não um formato.
- **`[DECISÃO PENDENTE]` Moeda.** As 4 colunas monetárias existentes no schema
  não têm `currency`; BRL é implícito. Adotado: **segue implícito**. Introduzir
  multimoeda sem requisito produziria conversão e data de câmbio que ninguém
  pediu.

---

## MÓDULO 4 — Contas a Pagar (com aprovação)

### Status
- [ ] **Especificado, não implementado**

### Descrição
Título a pagar com parcelamento, recorrência, classificação despesa/investimento
e workflow de aprovação por faixa de valor.

### Modelagem de Dados

**`approval_thresholds`** (por tenant — **configurável, conforme decisão do
operador**): `id`, `tenant_id`, `applies_to` (`payable`/`receivable`),
`amount_from`, `amount_to` (nulo = sem teto), `levels_required` (0–3),
`is_active`. Faixa `levels_required = 0` é aprovação automática.

> Nenhum valor em reais é semeado. O sistema começa sem faixa e **cobra a
> configuração** antes de aceitar o primeiro título — inventar R$ X/Y/Z seria
> inventar a alçada do cliente.

**`payables`**: `id`, `tenant_id`, `description`, `expense_kind`
(`fixed`/`variable`/`investment`), `supplier_id`, `supplier_contract_id` (FK
composta — **habilitada pela unique adicionada em `0018`**), `cost_center_id`,
`branch_id`, `amount_original`, `amount_adjusted`, `issued_on`, `due_on`,
`status` (`pending`/`approved`/`scheduled`/`paid`/`cancelled`/`disputed`),
`parent_id` (título pai de parcelamento), `installment_number`,
`installment_total`, `recurrence_id`.

**`payable_approvals`**: `payable_id`, `level` (1–3), `approver_id`,
`decision` (`approved`/`rejected`), `reason`, `decided_at`. Auditoria completa.

**`approval_delegations`**: `from_user_id`, `to_user_id`, `starts_on`, `ends_on`.

**`payable_payments`**: pagamento total ou parcial, `bank_account_id`,
`method` (transferência/boleto/PIX/cheque), `paid_on`, `amount`, `reversed_at`.

**`payable_cost_center_allocations`**: rateio percentual.

**`recurrences`**: template (`monthly`/`quarterly`/`semiannual`/`annual`) que
gera títulos futuros.

### Fluxos de Aprovação
1. Título criado → `pending`.
2. Sistema resolve a faixa em `approval_thresholds` pelo `amount_adjusted`.
3. `levels_required = 0` → `approved` direto, com registro em
   `payable_approvals` marcado como automático (auditoria não pode ter buraco).
4. Caso contrário: aprovação N1 → N2 → N3, na ordem, cada uma registrada.
5. Rejeição em qualquer nível exige justificativa e devolve ao solicitante.
6. Aprovado → liberado para pagamento.
7. Aprovador ausente: `approval_delegations` redireciona no período.

### Automações
- Recorrência gera títulos futuros conforme o template.
- Parcelamento cria N filhos com vencimento e valor próprios.
- **`[DECISÃO PENDENTE]`** Notificação a cada mudança de status depende de
  LG-06 (canal de notificação), ainda aberta em [06](06-lacunas-e-roadmap.md):
  não há e-mail nem push na plataforma hoje.

### Endpoints de API (previstos)
`createPayable` (`financeiro.contas_pagar.criar`), `updatePayable` (`.editar`),
`submitForApproval` (`.enviar_aprovacao`), `approvePayable` (`.aprovar`),
`rejectPayable` (`.rejeitar`), `registerPayment` (`.pagar`),
`reversePayment` (`.estornar`), `allocateCostCenters` (`.ratear`).

> As chaves acima **ainda não estão no catálogo**, de propósito: cadastrar
> permissão de tela que não existe daria ao admin um checkbox que não governa
> nada. Entram com a migração desta tela.

### Dependências
- **Depende de:** Módulos 1, 2 e 3.
- **Habilita:** Controle de Despesas, Orçamento, Fluxo de Caixa.

### Critérios de Aceite
- [ ] Faixas de aprovação configuráveis por tenant; sistema cobra configuração.
- [ ] Aprovação automática registrada em auditoria como automática.
- [ ] Rejeição exige justificativa.
- [ ] Delegação temporária funciona no período e expira sozinha.
- [ ] Pagamento parcial recalcula saldo.
- [ ] Estorno com justificativa.
- [ ] Rateio soma 100%.

### Lacunas e Decisões Pendentes
- **`[LACUNA]` Quem é N1/N2/N3?** A alçada precisa de uma tabela de designação
  (`approval_assignments`: usuário × nível × centro de custo ou filial). Sem
  definir o critério — por centro de custo? por filial? global? — não é possível
  modelar. Recomendação: por centro de custo, com fallback global.
- **`[DECISÃO PENDENTE]` Anexos** (NF, boleto, comprovante) dependem do
  Supabase Storage, que **não é usado em nenhum ponto da plataforma** hoje. É a
  mesma lacuna dos módulos 3, 5, 7 e 8 de [06](06-lacunas-e-roadmap.md).

---

## MÓDULO 5 — Contas a Receber (geração por contrato)

### Status
- [ ] **Especificado, não implementado**

### Descrição
Título a receber, com geração automática a partir de contrato de cliente.

### Modelagem de Dados
**`receivables`**: espelha `payables`, com `client_id` em vez de `supplier_id` e
status `pending`/`approved`/`received`/`cancelled`/`disputed`/`written_off`.

**`client_contracts`**: `client_id`, `branch_id`, `base_amount`,
`adjustment_index` (`igpm`/`ipca`/`fixed_pct`/`none`), `adjustment_pct`,
`billing_periodicity`, `due_day`, `early_payment_discount_pct`, `starts_on`,
`ends_on`, `is_active`.

> `clients.contract_ref` hoje é **texto livre sem FK**. Este módulo o substitui
> por entidade de verdade.

**`adjustment_indexes`**: `index_key`, `reference_month`, `value_pct` —
histórico do índice, alimentado manualmente.

### Regras de Negócio
1. Ativar contrato gera os títulos conforme periodicidade e prazo.
2. Títulos gerados nascem `pending` para validação financeira antes de efetivar.
3. Reajuste aplica o índice do mês de referência.
4. Contrato encerrado não gera título novo — validado na conversão.

### Automações
- Geração de recebíveis a partir do contrato.

### Dependências
- **Depende de:** Módulos 1, 2, 3 e `clients`.
- **Habilita:** Fluxo de Caixa completo.

### Lacunas e Decisões Pendentes
- **`[DECISÃO PENDENTE]` IGPM/IPCA: API externa ou cadastro manual?**
  Recomendação: **cadastro manual** em `adjustment_indexes`. API externa
  acrescenta dependência de terceiro no caminho de faturamento — se ela cai no
  dia do fechamento, o faturamento para. Manual é uma linha por mês, auditável,
  e permite o valor que o contrato de fato usou.
- **`[DECISÃO PENDENTE]` Geração na ativação ou em ciclo mensal?**
  Recomendação: **ciclo**, gerando X dias antes do vencimento (X configurável).
  Gerar 36 títulos na ativação de um contrato de 3 anos enche o fluxo de caixa
  de linhas que ainda vão mudar de valor por reajuste.

---

## MÓDULO 6 — Lançamentos Futuros

### Status
- [ ] **Especificado, não implementado**

### Descrição
Compromisso programado que se converte em título na data prevista.

### Modelagem de Dados
`future_entries`: `kind` (despesa/receita recorrente ou parcelada, provisão),
`amount`, `scheduled_for`, `cost_center_id`, `contract_id`, `converted_at`,
`converted_to_id`.

### Regras de Negócio
1. Conversão na data gera o título com status apropriado.
2. Editável e cancelável **antes** da conversão; depois, é o título que muda.
3. Vinculado a contrato: valida vigência antes de converter.

### Automações
- Job diário de conversão. **`[LACUNA]`** A plataforma **não tem job agendado
  nenhum** hoje (o fechamento automático de resolvidos também espera por isso).
  Exige decidir o mecanismo: `pg_cron` no Supabase, Edge Function agendada, ou
  gatilho externo.

### Dependências
- **Depende de:** Módulos 4 e 5.
- **Habilita:** Fluxo de Caixa projetado.

---

## MÓDULO 7 — Fluxo de Caixa

### Status
- [x] **Implementado** — migração `0021_fluxo_de_caixa.sql`, tela
  `/financeiro/fluxo-de-caixa`, chaves `financeiro.fluxo_caixa.*`.

### O que ficou de fora, e por quê
- **`future_entries`** (Módulo 6 daqui) não existe: depende de job agendado, que a
  plataforma não tem. A função foi escrita para receber os lançamentos futuros como
  **mais um braço de UNION**, sem reescrever nada.
- **Tendência histórica.** `payables.paid_on` está vazio — não há histórico de
  pagamento nesta base. Média de atraso, sazonalidade e previsão de faturamento
  seriam número inventado com casa decimal, e número inventado parece mais
  confiável que número nenhum. A tela projeta o **comprometido** e diz que é isso.
- **Os três cenários com nome** (otimista/realista/pessimista). A inadimplência
  virou **um campo numérico**, padrão 0. Nenhum percentual está escrito em documento
  de negócio algum, e batizar um deles de "realista" faria o sistema afirmar o que
  não sabe. Mesma decisão da alçada, que nasce vazia.
- **Filtro por conta bancária**, embora citado abaixo. Título em aberto quase nunca
  tem `bank_account_id` — a conta só é gravada na baixa —, então o filtro
  esvaziaria a projeção e pareceria "não há nada a pagar". Filtro que mente é pior
  que filtro ausente. Sobraram filial, centro de custo, horizonte e inadimplência.

### Uma armadilha encontrada na implementação
`vw_bank_account_balances.current_balance` **não tem corte de data**, e
`bank_account_movements.moved_on` é uma `date` livre: lançamento datado no futuro já
está dentro daquele saldo hoje. Usá-lo como ponto de partida e depois projetar o
mesmo mês contaria o valor **duas vezes**. A função calcula o saldo de D0 como
`opening_balance` mais os movimentos até hoje, e trata os futuros como fluxo. Há
asserção para as duas metades — e uma terceira provando que a view e o D0
**divergem** quando existe movimento futuro, que é a razão de não usar a view.

### Descrição
Saldo atual + recebimentos previstos − pagamentos previstos, com cenários.

### Modelagem de Dados
Sem tabela nova: views sobre `vw_bank_account_balances`, `payables`,
`receivables` e `future_entries`.

### Regras de Negócio
1. Cenários realista/otimista/pessimista por percentual de inadimplência
   aplicado sobre recebíveis.
2. Alertas: saldo projetado negativo, concentração de pagamentos num só dia.
3. Filtros por conta, filial, centro de custo e período.

### Lacunas e Decisões Pendentes
- **`[DECISÃO PENDENTE]` Integração externa (ERP, banco via API)?**
  Recomendação: **apenas títulos internos** nesta fase. Open Finance exige
  certificado, consentimento e homologação por instituição — é um módulo, não
  uma fonte de dados.

---

## MÓDULO 8 — Controle de Despesas

### Status
- [ ] **Especificado, não implementado**

### Descrição
Alimentado automaticamente por `payables`. Categorização, subcategorias
customizáveis, análise por centro de custo e filial.

### Modelagem de Dados
`expense_categories` (por tenant, hierárquica), e views de agregação sobre
`payables` + `payable_cost_center_allocations`.

### Dependências
- **Depende de:** Módulo 4. Sem contas a pagar não há despesa para controlar.

### Lacunas e Decisões Pendentes
- **`[LACUNA]` "Custo de TI por paciente".** O indicador foi pedido, mas **não
  existe entidade paciente na plataforma**: zero ocorrências em `src/` e
  `supabase/` (as 4 menções em [06](06-lacunas-e-roadmap.md) são contexto de
  negócio, não modelo). Recomendação: `monthly_operational_metrics
  (tenant_id, branch_id, reference_month, active_patients)`, alimentada
  manualmente. Integrar com sistema clínico traria dado de saúde para dentro da
  plataforma e reabre LG-01 (LGPD art. 11).
- **`[DECISÃO PENDENTE]` Exportação PDF/Excel** — LG-11, já aberta em
  [06](06-lacunas-e-roadmap.md), pedida em 4 módulos e ainda inexistente.

---

## MÓDULO 9 — Orçamento e Indicadores

### Status
- [ ] **Especificado, não implementado**

### Descrição
Orçado vs. realizado por categoria, centro de custo e filial.

### Modelagem de Dados
`budgets`: `reference_year`, `reference_month` (nulo = anual),
`expense_category_id`, `cost_center_id`, `branch_id`, `planned_amount`.
`budget_transfers`: remanejamento com motivo e aprovação.

### Regras de Negócio
1. Alertas em 75% (amarelo), 90% (vermelho) e 100% (crítico) de execução.
   Mesmos limiares do semáforo de SLA, por coerência de leitura.
2. Remanejamento entre categorias exige motivo e aprovação.
3. Projeção de fechamento pelo ritmo de gasto.

### Dependências
- **Depende de:** Módulos 2, 4 e 8.

---

## CRONOGRAMA SUGERIDO DE IMPLEMENTAÇÃO

| Ordem | Módulo | Depende de | Prioridade | Complexidade | Situação |
|---|---|---|---|---|---|
| 1 | Usuários e Permissões | — | Crítica | Alta | **Pronto** |
| 2 | Revisão de código (permissões) | 1 | Crítica | Alta | **Pronto** |
| 3 | Centros de Custo | 1 | Alta | Baixa | **Pronto** |
| 4 | Contas Bancárias | 1 | Alta | Média | **Pronto** |
| 5 | Contas a Pagar + aprovação | 1–4 | Alta | **Muito alta** | **Pronto** (0020) |
| 6 | Contas a Receber + contrato | 1–4 | Alta | Alta | **Pronto** (0020) |
| 7 | Lançamentos Futuros | 5, 6 | Média | Média | Especificado |
| 8 | Fluxo de Caixa | 5, 6 | Média | Média | **Pronto** (0021) |
| 9 | Controle de Despesas | 5 | Média | Média | Especificado |
| 10 | Orçamento e Indicadores | 3, 5, 9 | Baixa | Média | Especificado |

Pré-requisitos transversais que bloqueiam vários itens: **Supabase Storage**
(anexos), **canal de notificação** (LG-06), **job agendado** (conversão de
lançamentos futuros), **exportação** (LG-11).

---

## MATRIZ DE PERMISSÕES

Perfis de sistema semeados por tenant. ● = completo · ◐ = somente leitura ·
— = sem acesso. Colunas de módulo ainda não implementado ficam de fora até a
tela existir.

| Perfil | Teto | Helpdesk | SLA | Invent. | Telef. | Mapas | Clientes | Fornec. | Financeiro | Usuários | Perfis | Integr. | TV |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Admin do Cliente | admin | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| Diretoria | gestor | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | — | — | ◐ |
| Gestor de TI | gestor | ● | ● | ● | ● | ● | ● | ● | — | — | — | — | ● |
| Operador de TI | atendente | ● | — | ◐ | ◐ | ◐ | — | — | — | — | — | — | — |
| Gestor Financeiro | gestor | — | ◐ | — | — | — | ◐ | ● | ● | — | — | — | — |
| Operador Financeiro | gestor | — | — | — | — | — | — | — | ◐ + movimentar | — | — | — | — |
| Aprovador Financeiro | gestor | — | — | — | — | — | — | — | ◐ | — | — | — | — |
| Visualizador | visualizador | ◐ | — | ◐ | ◐ | ◐ | — | — | — | — | — | — | — |
| Solicitante | solicitante | ● (próprio) | — | ◐ | ◐ | ◐ | — | — | — | — | — | — | — |

O catálogo completo (147 entradas com o papel mínimo de cada uma) está em
`src/lib/permissions.ts` e semeado em `permission_catalog`.

---

## INTEGRAÇÃO ENTRE MÓDULOS

```
Contrato do cliente ──► Contas a Receber ──┐
                                            ├──► Fluxo de Caixa ──► Indicadores
Contrato do fornecedor ─► Contas a Pagar ──┤         ▲
                              │             │         │
                              ▼             │    Contas Bancárias
                    Controle de Despesas ───┘    (saldo derivado)
                              │
                              ▼
                    Orçamento (orçado vs. realizado)

Centros de Custo ──► dimensão de rateio de TODOS os lançamentos
Permissões ────────► governa acesso a TODAS as telas e ações acima
```

Pontos de acoplamento já preparados nesta entrega:
- `supplier_contracts` ganhou `unique (id, tenant_id)` — sem isso o vínculo
  título → contrato do fornecedor não teria FK composta.
- `bank_account_movements.cost_center_id` já existe: quando o título a pagar
  gerar movimentação, o rateio tem onde pousar.

---

## REVISÃO DE CÓDIGO — CHECKLIST

- [x] Mapear a superfície de escrita (63 Server Actions em 14 arquivos).
- [x] Criar o gate de autorização (`requirePermission`, não middleware — ver
      adaptação arquitetural).
- [x] Validar permissão em cada ação (46/49; 3 públicas por design).
- [x] Componente de renderização condicional (`<Can>`, Server Component).
- [x] Filtro de filial nas queries — **já existia** via RLS; preservado.
- [x] Gate de tela nas 16 páginas; menu derivado da permissão.
- [x] Testar perfis com permissões diferentes (21 asserções de schema).
- [x] Documentar a permissão de cada ação (tabelas de "Endpoints de API").
- [x] Fechar `branch-geo-panel.tsx` (4 ações de escrita sem checagem de papel).
- [x] Fechar `addComment` (comentário interno aceito de qualquer papel).

---

## LACUNAS GLOBAIS E DECISÕES PENDENTES

| # | Tipo | Assunto | Recomendação |
|---|---|---|---|
| 1 | `[LACUNA]` | Custo de TI por paciente — não existe entidade paciente | Métrica mensal manual por filial |
| 2 | `[LACUNA]` | Quem é aprovador N1/N2/N3 e por qual critério | Designação por centro de custo, com fallback global |
| 3 | `[DECISÃO]` | Expiração de senha | Não existe no Supabase Auth; exige contador próprio |
| 4 | `[DECISÃO]` | Bloqueio após N tentativas | Automático, 15 min, com desbloqueio manual |
| 5 | `[DECISÃO]` | Log de acessos com IP | Tabela própria + política de retenção (LGPD) |
| 6 | `[DECISÃO]` | IGPM/IPCA | Cadastro manual, não API externa |
| 7 | `[DECISÃO]` | Formato de conciliação | CSV e OFX primeiro; CNAB depois |
| 8 | `[DECISÃO]` | Geração de recebíveis | Ciclo mensal, X dias antes do vencimento |
| 9 | `[DECISÃO]` | Rateio | Percentual com soma 100% |
| 10 | `[DECISÃO]` | Moeda | BRL implícito, como as 4 colunas existentes |
| 11 | `[DECISÃO]` | Fluxo de caixa com fonte externa | Só títulos internos nesta fase |
| 12 | `[BLOQUEIO]` | Supabase Storage — anexos | Nenhuma linha da plataforma usa Storage hoje |
| 13 | `[BLOQUEIO]` | Canal de notificação (LG-06) | Sem e-mail nem push; bloqueia aprovação |
| 14 | `[BLOQUEIO]` | Job agendado | Nenhum existe; bloqueia lançamentos futuros |
| 15 | `[BLOQUEIO]` | Exportação PDF/Excel (LG-11) | Pedida em 4 módulos, inexistente |

---

## Verificação desta entrega

| Check | Resultado |
|---|---|
| `npm run typecheck` | limpo |
| `npm run lint` | limpo |
| `npx vitest run` | 192 testes |
| `npm run db:validate` | 279 asserções contra PostgreSQL 16 real |
| `npm run build` | 21 rotas compiladas |

**Limite honesto.** As telas autenticadas não podem ser exercitadas em navegador
neste ambiente — não há projeto Supabase acessível, só um PostgreSQL local para
o `db:validate`. O que está provado é a camada SQL (herança de permissão, teto
de perfil, profundidade, dupla entrada, isolamento entre tenants), a matriz
aplicada aos usuários do seed, e a lógica pura em vitest. O fluxo de ponta a
ponta — "logar como Operador Financeiro, não ver o botão Aprovar, e receber 'sem
permissão' se forçar a ação" — depende de rodar contra um Supabase real.

### Storage de anexos (migração 0019) — pré-requisito de dois módulos daqui

Antes desta migração existiam **quatro** tabelas de anexo — `ticket_attachments`
(0005), `asset_attachments`, `telecom_line_attachments` e
`internet_link_attachments` (0013) — todas com `storage_path text not null`, com
FK composta e com a cota já validada no banco. E **nenhuma linha de código que
subisse arquivo**: anexar um documento a um ticket era impossível.

Isto travava dois módulos especificados acima: título a pagar sem NF/boleto não
serve operacionalmente, e controle de despesa depende de comprovante.

A autorização não repete mecanismo: a policy do bucket lê o `tenant_id` do
primeiro segmento do caminho (convenção que o `seed.sql` já usava) e chama
`app.has_permission()` da chave que corresponde ao segundo segmento. São 6 chaves
novas — `anexar` e `remover_anexo` em ticket, ativo e linha. `anexar` em ticket é
`solicitante`: quem abre o chamado precisa mandar o print do erro.

`conectividade.links.*` **não** foi criada. A tabela de anexo do link existe, mas
a tela de Links de Internet não existe na aplicação — só no protótipo. Cadastrar a
chave antes da tela produziria permissão que não governa nada, o defeito que esta
rodada corrigiu em seis outras chaves. Entra junto com a tela.

**Limite honesto:** o upload HTTP em si fala com a API de Storage e não pode ser
exercitado neste ambiente. O que está provado por `db:validate` são as 37
asserções da seção 25 — a decisão de autorização, que é onde mora o risco: tenant
não lê caminho de outro tenant, prefixo fora do mapa é negado, caminho com pasta
faltando ou sobrando é negado, e não existe policy de UPDATE.

### E o que o protótipo achou depois

Portar a camada para `demo/sti-tool.html` achou um defeito que nenhum teste da
aplicação pegaria, porque estava só no protótipo: a tabela `ROLE_RANK` tinha
`solicitante:1, visualizador:2`, invertida e deslocada em relação a
`app.role_rank` e a `src/lib/permissions.ts`, onde `visualizador` é **0**.

O efeito não era cosmético, e ia nas duas direções. O solicitante perdia
`helpdesk.tickets.ver` e abria a ferramenta com três itens de menu; o
visualizador, que é somente leitura, ganhava `helpdesk.tickets.criar`. O
protótipo demonstrava um modelo de permissão que a aplicação não tem — e a
comparação de catálogo não pegava, porque o catálogo estava certo: errada era a
régua que decide o que cada perfil alcança. `permissions.demo.test.ts` passou a
cobrar a tabela também.

### O que a asserção contra o seed já achou

Vale registrar porque mede o valor de semear a matriz em vez de só testar a
função. A asserção "todo usuário com perfil alcança alguma tela" nasceu falhando
em `Aprovador Financeiro`, e o defeito era de aplicação, não de dado:
`requireScreen()` mandava todo negado para `/painel`, e os perfis financeiros do
sistema não recebem o módulo de helpdesk. `/painel` negava e redirecionava para
`/painel`. **Um Aprovador Financeiro nunca conseguiria entrar no sistema** — e
nenhum teste anterior podia pegar isso, porque nenhum usuário-semente tinha
perfil financeiro.

A correção foi tirar a navegação de dentro do layout para
`src/lib/navigation.ts`, hoje a única fonte do menu e do destino pós-negação.
`landingHref()` devolve a primeira tela que a sessão alcança de fato, e `/conta`
quando não alcança nenhuma. Menu e redirect em lugares separados foi a causa
raiz: o menu já escondia `/painel` de quem não podia abri-lo, e o redirect
mandava para lá do mesmo jeito.
