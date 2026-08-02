# 01 — Levantamento de Requisitos

> Documento vivo. Consolida o escopo aprovado, as decisões tomadas por padrão
> (com justificativa) e as lacunas que dependem de validação do negócio.

## 1. Visão do produto

Plataforma SaaS **multi-tenant** de helpdesk e gestão de TI voltada a operações que
atendem **grupos econômicos com múltiplas filiais**, com forte ênfase em:

1. **Gestão à vista** — dashboard de TV/war room em tempo real.
2. **SLA como cidadão de primeira classe** — medição contínua, pausas, alertas de risco.
3. **Inventário unificado** — ativos de TI + linhas telefônicas no mesmo domínio dos tickets.
4. **Integração aberta** — Integration Hub genérico, com Bitrix24 como primeira fonte.

### 1.1 Glossário

| Termo | Significado neste sistema |
|---|---|
| **Tenant** | Assinante da plataforma (a empresa que opera o helpdesk). Fronteira de isolamento de dados. |
| **Cliente** | Grupo econômico atendido por um tenant. Um tenant tem N clientes. |
| **Filial** | Unidade de um cliente. Fronteira de visibilidade dos atendentes. |
| **Fila** | Agrupamento de trabalho com regras de roteamento e priorização. |
| **TFR** | Tempo de Primeira Resposta. |
| **TR** | Tempo de Resolução. |
| **Breach** | Violação do prazo de SLA. |

> ⚠️ **Ambiguidade resolvida por decisão:** o termo "cliente" aparece no escopo original
> tanto como *assinante do SaaS* quanto como *empresa atendida*. Adotamos `tenant` para o
> primeiro e `client` para o segundo, em todo o código e banco. Ver [ADR-001](03-arquitetura.md#adr-001).

## 2. Requisitos funcionais

Rastreabilidade: cada RF tem ID estável usado em commits, testes e no schema.

### 2.1 Tickets (RF-TCK)

| ID | Requisito | Prioridade |
|---|---|---|
| RF-TCK-01 | Ticket contém título, descrição, categoria, subcategoria, prioridade, status, fila, solicitante, atendente, filial, timestamps | Must |
| RF-TCK-02 | Abertura manual (UI) e via integração (API/webhook) | Must |
| RF-TCK-03 | Herança de SLA por categoria + prioridade + contrato do cliente | Must |
| RF-TCK-04 | Escalonamento entre filas e entre atendentes, com motivo registrado | Must |
| RF-TCK-05 | Audit trail completo de mudanças campo a campo | Must |
| RF-TCK-06 | Comentários públicos e internos | Must |
| RF-TCK-07 | Anexos | Must |
| RF-TCK-08 | Vínculo opcional a ativos de inventário | Should |
| RF-TCK-09 | Vínculo opcional a fornecedor quando envolve terceiro | Should |
| RF-TCK-10 | Numeração sequencial legível por tenant (ex.: `#1042`) | Must |

**Máquina de estados adotada** (RF-TCK-01):

```
                ┌───────────────── reabertura ──────────────────┐
                v                                               │
aberto → em_triagem → atribuido → em_andamento → resolvido → fechado
                          │            │  ^
                          │            v  │
                          └──> aguardando_solicitante / aguardando_terceiro
                                        (relógio de SLA pausado)
```

- `aberto` → estado de entrada (criação manual ou integração).
- `resolvido` → aguarda confirmação; fecha automaticamente após N dias (configurável, padrão 3).
- `fechado` → terminal. Reabertura cria transição auditada de volta para `em_andamento`.
- Estados `aguardando_*` **pausam** o relógio de SLA (RF-SLA-05).

> A máquina de estados é aplicada no banco (função `fn_validar_transicao_ticket`), não apenas
> na UI, para que integrações não consigam gravar transições inválidas. Ver [ADR-007](03-arquitetura.md#adr-007).

### 2.2 SLA (RF-SLA)

| ID | Requisito | Prioridade |
|---|---|---|
| RF-SLA-01 | SLA define TFR e TR | Must |
| RF-SLA-02 | Configurável por categoria, prioridade, contrato e calendário de atendimento | Must |
| RF-SLA-03 | Calendário 24x7 ou horário comercial com feriados por região | Must |
| RF-SLA-04 | Alertas de proximidade de breach em 75% e 90% (configurável) | Must |
| RF-SLA-05 | Pausa de relógio (clock stop) em `aguardando_solicitante` / `aguardando_terceiro` | Must |
| RF-SLA-06 | Relatório de compliance por período, fila, atendente e cliente | Must |
| RF-SLA-07 | Herança cliente → filial com sobrescrita na filial | Must |

**Resolução de qual SLA se aplica** — precedência determinística, do mais específico ao mais genérico:

```
1. contrato da filial + categoria + prioridade
2. contrato da filial + prioridade            (categoria = NULL, curinga)
3. contrato do cliente + categoria + prioridade
4. contrato do cliente + prioridade
5. SLA padrão do tenant por prioridade
```

A primeira regra encontrada vence. Implementado em `fn_resolver_sla()` com essa ordenação
explícita — sem isso, múltiplas definições aplicáveis produziriam resultado não determinístico.

> ⚠️ **Decisão por padrão:** o escopo não definiu o que ocorre quando *nenhuma* definição
> casa. Adotamos: o ticket é criado **sem SLA** (`sla_tracking.sla_definition_id IS NULL`),
> marcado como `sem_sla`, e aparece em relatório de cobertura para o gestor corrigir a
> configuração. Alternativa rejeitada: bloquear a criação do ticket — inaceitável para
> tickets vindos de integração.

### 2.3 Filas (RF-FIL)

| ID | Requisito | Prioridade |
|---|---|---|
| RF-FIL-01 | Fila padrão do sistema: não removível, não renomeável | Must |
| RF-FIL-02 | Filas customizáveis com nome, descrição, regras, membros | Must |
| RF-FIL-03 | Priorização automática por criticidade (peso) + prazo/SLA (peso) + FIFO (desempate) | Must |
| RF-FIL-04 | View de fila ordenada com semáforo de SLA e tempo restante | Must |
| RF-FIL-05 | Transferência entre filas com motivo obrigatório | Must |

**Fórmula de priorização adotada** (RF-FIL-03) — score numérico recalculado sob demanda:

```
score = (peso_criticidade × prioridade.peso)
      + (peso_prazo      × urgencia_sla)
      + (peso_espera     × idade_normalizada)

urgencia_sla = clamp(0..1) do percentual consumido do prazo de resolução
             = 1.0 quando já houve breach
```

Pesos default: criticidade 60, prazo 30, espera 10 — configuráveis por fila em `queue_rules`.
FIFO entra como desempate via `created_at ASC`. A normalização mantém os três termos na
mesma escala 0..1, evitando que a idade em segundos domine o score (antipattern comum).

### 2.4 Dashboard de TV (RF-DSH)

| ID | Requisito | Prioridade |
|---|---|---|
| RF-DSH-01 | Layout landscape, fontes grandes, alto contraste | Must |
| RF-DSH-02 | Métricas: abertos, em andamento, críticos, SLA em risco, SLA breached, atendentes online, TMR | Must |
| RF-DSH-03 | Fila principal com auto-scroll quando exceder a tela | Must |
| RF-DSH-04 | Auto-refresh 30–60s configurável, via Realtime | Must |
| RF-DSH-05 | Múltiplos layouts por tenant | Should |
| RF-DSH-06 | Semáforo de SLA, tendências, contadores animados | Should |
| RF-DSH-07 | Modo kiosk (tela cheia, sem navegação) | Must |
| RF-DSH-08 | Carregar em < 3s com 10.000 tickets ativos | Must |

> ⚠️ **Lacuna crítica identificada:** uma TV em painel de parede **não tem quem faça login**.
> Exigir sessão interativa inviabiliza o caso de uso. Decisão: tokens de exibição
> (`dashboard_tokens`) — segredo de longa duração, escopo somente-leitura, vinculado a um
> layout e a um conjunto de filiais, revogável. Ver [ADR-006](03-arquitetura.md#adr-006).

### 2.5 Inventário de TI (RF-INV) e Telecom (RF-TEL)

| ID | Requisito | Prioridade |
|---|---|---|
| RF-INV-01 | Tipo, marca, modelo, nº série, patrimônio, status, filial, usuário, aquisição, garantia, notas | Must |
| RF-INV-02 | Lifecycle: aquisição → atribuição → manutenção → realocação → baixa | Must |
| RF-INV-03 | Vínculo de ativos a tickets | Must |
| RF-INV-04 | Importação em massa CSV | Should |
| RF-TEL-01 | Número, operadora, plano, tipo, status, filial, usuário, aparelho, custo mensal, datas, fidelidade | Must |
| RF-TEL-02 | Relatório de custos por filial, operadora e período | Must |

> ⚠️ **Decisão por padrão:** nº de série e patrimônio são únicos **por tenant**, não globais
> (dois tenants podem legitimamente ter a mesma tag de patrimônio). Nº de série permite NULL
> — periféricos e licenças frequentemente não têm.

### 2.6 Fornecedores, Clientes e Usuários (RF-FOR / RF-CLI / RF-USR)

| ID | Requisito | Prioridade |
|---|---|---|
| RF-FOR-01 | Nome, CNPJ, contatos, serviços, contratos, SLAs contratados, avaliação | Must |
| RF-FOR-02 | Vínculo de fornecedor a ticket | Should |
| RF-CLI-01 | Cliente: razão social, CNPJ, contrato, SLAs, N filiais | Must |
| RF-CLI-02 | Filial: nome, CNPJ, endereço, cidade, UF, timezone, horário de atendimento, contato | Must |
| RF-USR-01 | Papéis: super-admin, admin, gestor, atendente, solicitante, visualizador | Must |
| RF-USR-02 | Atendente 1 filial → vê só a sua; N filiais → vê todas as vinculadas | Must |
| RF-USR-03 | Gestor vê todas as filiais do tenant | Must |
| RF-USR-04 | Visualizador acessa apenas dashboard | Must |
| RF-USR-05 | Autenticação via Supabase Auth | Must |

**Matriz de permissões** (efetiva; a coluna "escopo" define *quais linhas*, o resto define *quais ações*):

| Papel | Escopo de dados | Tickets | Cadastros | Config. tenant | Admin SaaS |
|---|---|---|---|---|---|
| `super_admin` | todos os tenants | CRUD | CRUD | CRUD | ✔ |
| `admin` | todo o tenant | CRUD | CRUD | CRUD | — |
| `gestor` | todo o tenant | CRUD | CRUD | leitura | — |
| `atendente` | filiais vinculadas | CRUD nos seus | leitura | — | — |
| `solicitante` | apenas os que abriu | criar / comentar | — | — | — |
| `visualizador` | filiais vinculadas | leitura | — | — | — |

### 2.7 Integrações (RF-INT)

| ID | Requisito | Prioridade |
|---|---|---|
| RF-INT-01 | Hub genérico: qualquer API externa → ticket | Must |
| RF-INT-02 | Webhook inbound + polling opcional + mapping + upsert de ticket | Must |
| RF-INT-03 | Cadastro por integração: nome, origem, endpoint, auth, mapping, status, último sync, contadores | Must |
| RF-INT-04 | Log de toda requisição: timestamp, payload, status HTTP, tempo de processamento | Must |
| RF-INT-05 | Retry até 3 tentativas com backoff exponencial | Must |
| RF-INT-06 | Idempotência por ID de evento + sistema de origem | Must |
| RF-INT-07 | Event-driven; polling apenas quando a origem não suportar webhook | Must |
| RF-INT-08 | Bitrix24: ONTASKADD / ONTASKUPDATE → ticket | Must |
| RF-INT-09 | Sincronização reversa SaaS → Bitrix24 (opcional, por integração) | Should |
| RF-INT-10 | `external_id` + `source_system` em todo ticket integrado | Must |

## 3. Requisitos não funcionais

| ID | Requisito | Meta | Como será verificado |
|---|---|---|---|
| RNF-01 | Isolamento multi-tenant | RLS em 100% das tabelas de negócio | Teste que enumera `pg_tables` e falha se faltar policy |
| RNF-02 | Performance do dashboard | < 3s com 10k tickets ativos | Métricas pré-agregadas em view + índices; medição com dataset sintético |
| RNF-03 | Disponibilidade | 99,5% | Depende do plano Supabase; endpoint de healthcheck |
| RNF-04 | Escalabilidade | N tenants × até 50 filiais | Índices compostos com `tenant_id` à esquerda |
| RNF-05 | Segurança | RLS, TLS, criptografia em repouso, segredos fora do banco em claro | Revisão + testes de policy |
| RNF-06 | Acessibilidade | WCAG 2.1 AA | Contraste ≥ 4.5:1, foco visível, navegação por teclado, landmarks |
| RNF-07 | Responsividade | Admin desktop+tablet; TV landscape 1080p/4K | Layout fluido com `clamp()` |
| RNF-08 | Real-time | Dashboard sem refresh manual | Supabase Realtime |
| RNF-09 | i18n | pt-BR padrão, estrutura para outros idiomas | Dicionário central, sem strings hardcoded na UI |

## 4. Fora de escopo (v1)

Registrado explicitamente para evitar expectativa implícita:

- Portal público de autoatendimento para solicitantes finais (base de conhecimento, FAQ).
- Gestão de mudanças / problemas / releases (ITIL além de incident & request).
- Faturamento e cobrança do SaaS (billing).
- Aplicativo móvel nativo.
- Chat ao vivo e telefonia embarcada (CTI).
- Descoberta automática de ativos (agente de inventário).

## 5. Lacunas em aberto (dependem do negócio)

Estas **não bloqueiam** a implementação — cada uma tem um padrão adotado e documentado —
mas devem ser confirmadas antes de produção:

| # | Questão | Padrão adotado |
|---|---|---|
| L-01 | Fechamento automático de tickets `resolvido` após quantos dias? | 3 dias corridos, configurável por tenant |
| L-02 | Solicitante pode ver tickets de colegas da mesma filial? | Não — vê apenas os próprios |
| L-03 | Feriados: carga manual ou serviço externo? | Tabela `business_hours_holidays` com carga manual/CSV |
| L-04 | Anexos: limite de tamanho e tipos permitidos? | 25 MB, bloqueio de executáveis |
| L-05 | Retenção de `integration_logs`? | 90 dias, com job de purga |
| L-06 | Sincronização reversa ao Bitrix24 é padrão ligada? | Desligada por integração; evita loop de eco até validação |
| L-07 | Múltiplos tenants podem compartilhar um mesmo cliente? | Não — cliente pertence a exatamente um tenant |
