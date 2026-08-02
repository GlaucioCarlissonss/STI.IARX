# 02 — Benchmarking de Mercado

Análise de cinco plataformas de referência para extrair boas práticas comprovadas e,
igualmente importante, **antipatterns a evitar**. As conclusões alimentam diretamente
as decisões de arquitetura no documento [03](03-arquitetura.md).

## 1. Plataformas analisadas

| Plataforma | Posicionamento | O que faz muito bem | Onde costuma decepcionar |
|---|---|---|---|
| **Freshservice** | ITSM mid-market, forte em UX | Onboarding rápido; SLA policies com condições compostas; catálogo de serviços; automações "supervisor/observer" claras | Relatórios rígidos fora dos planos altos; customização de campos limitada por plano |
| **Jira Service Management** | ITSM para times já em Atlassian | Workflows arbitrariamente configuráveis; automação madura; integração nativa com engenharia | Complexidade alta; conceitos vazam do Jira (issue types, schemes); curva de aprendizado íngreme |
| **Zendesk** | Suporte ao cliente (CX) antes de ITSM | Melhor caixa de entrada omnichannel; macros; triggers/automations; API muito consistente | ITAM/inventário praticamente ausente; multi-marca custa caro |
| **GLPI** | Open source, forte em ITAM | Inventário profundo (com agente de descoberta); gestão de contratos e fornecedores; custo zero de licença | UI datada; SLA e dashboards fracos; multi-tenancy via "entidades" é confuso |
| **ManageEngine ServiceDesk Plus** | ITSM+ITAM on-premise/cloud | Cobertura funcional ampla (ativos, contratos, compras, projetos) | Interface pesada; performance sofre em bases grandes; configuração trabalhosa |

## 2. Padrões que vamos adotar

### 2.1 SLA como política com condições, não campo no ticket
Freshservice e Jira SM modelam SLA como **política avaliada** (condições → alvos), não como
um prazo copiado no ticket. Vantagem: alterar a política corrige tickets futuros sem
migração, e a auditoria mostra qual política se aplicou.

→ Adotado: tabelas `sla_definitions` (condições + alvos) e `sla_tracking` (medição por ticket),
com `sla_definition_id` gravado no tracking para rastreabilidade histórica.

### 2.2 Calendário de atendimento separado do SLA
Todas as plataformas maduras separam *business hours* de *SLA targets*. Um mesmo calendário
serve várias políticas; feriados são regionais.

→ Adotado: `business_hours` + `business_hours_intervals` + `business_hours_holidays`,
referenciados por `sla_definitions`. Filial tem timezone próprio (RF-CLI-02).

### 2.3 Pausa de relógio com estados explícitos
Zendesk ("pending") e Freshservice ("waiting on customer") pausam o relógio em estados
específicos. Sem isso, o SLA pune a equipe por demora do solicitante.

→ Adotado: `sla_pauses` como intervalos, e não um contador decrementado. Intervalos permitem
recalcular o histórico e auditar; um contador mutável perde a informação de *quando* pausou.

### 2.4 Priorização por score, não por ordenação manual
Filas ordenadas só por prioridade fazem tickets de baixa prioridade "morrerem de fome"
(starvation). Plataformas maduras combinam prioridade com urgência de prazo.

→ Adotado: score composto criticidade + prazo + idade (ver RF-FIL-03).

### 2.5 Idempotência em toda entrada de integração
Zendesk e Jira documentam explicitamente que webhooks podem ser reentregues. Integrações
que não deduplicam criam tickets duplicados em produção — falha clássica.

→ Adotado: `integration_events` com chave única `(integration_id, event_key)`.

### 2.6 `external_id` + `source_system` desde o dia 1
Retro-encaixar rastreabilidade de origem é doloroso. Todas as plataformas expõem esse par.

→ Adotado como colunas de primeira classe em `tickets`, com índice único parcial.

## 3. Antipatterns identificados — e como os evitamos

| # | Antipattern observado | Consequência | Mitigação no nosso desenho |
|---|---|---|---|
| A-01 | **Status livre / configurável sem máquina de estados** (Jira permite quase tudo) | Tickets em estados incoerentes; relatórios sem sentido; SLA impossível de medir | Máquina de estados fixa e validada **no banco** ([ADR-007](03-arquitetura.md#adr-007)) |
| A-02 | **Dashboard que consulta tabelas transacionais a cada refresh** | Com 10k tickets e refresh de 30s, o dashboard vira o maior consumidor do banco | View agregada + índices dedicados + Realtime por evento em vez de polling pesado ([ADR-005](03-arquitetura.md#adr-005)) |
| A-03 | **Multi-tenancy só na camada de aplicação** (filtro `WHERE tenant_id`) | Um `WHERE` esquecido vaza dados entre tenants — falha catastrófica e silenciosa | RLS no Postgres como fronteira real; a aplicação nunca é a única guarda ([ADR-002](03-arquitetura.md#adr-002)) |
| A-04 | **Inventário desacoplado do helpdesk** (Zendesk) | "Qual notebook deu problema?" vira campo de texto livre; impossível correlacionar | `ticket_assets` como relação real, com FK |
| A-05 | **Sincronização bidirecional ingênua** | Loop de eco: A atualiza B, B notifica A, A atualiza B… infinito | Supressão de eco por *origem da mudança* + comparação de conteúdo ([ADR-008](03-arquitetura.md#adr-008)) |
| A-06 | **Audit trail gravado pela aplicação** | Alterações via SQL direto, job ou integração escapam da auditoria | Trigger no banco: toda escrita é auditada, venha de onde vier |
| A-07 | **Segredos de integração em texto plano na tabela de config** | Um dump de banco entrega todas as credenciais dos clientes | Segredos referenciados por nome, resolvidos no runtime da Edge Function ([ADR-009](03-arquitetura.md#adr-009)) |
| A-08 | **Login exigido no painel de TV** | Painel de parede cai na primeira expiração de sessão e ninguém percebe por dias | Token de exibição revogável, somente leitura ([ADR-006](03-arquitetura.md#adr-006)) |
| A-09 | **Deleção física de tickets/ativos** | Perda de histórico e de rastreabilidade contábil de patrimônio | Soft delete (`deleted_at`) nas entidades de negócio |
| A-10 | **Enum de prioridade hardcoded** | Cliente pede "Emergencial" e vira migração de código | `ticket_priorities` como tabela com `weight`, semeada por tenant |

## 4. Decisões de escopo influenciadas pelo benchmarking

- **Não** replicar o catálogo de serviços completo do Freshservice na v1 — alto custo,
  baixo retorno antes de haver volume de tickets. Registrado como fora de escopo.
- **Não** adotar workflows configuráveis estilo Jira na v1 — é a principal fonte de
  complexidade acidental na ferramenta de referência (A-01).
- **Sim** para profundidade de inventário estilo GLPI, porque é diferencial explícito
  do escopo (ativos + linhas telefônicas no mesmo produto).
- **Sim** para qualidade de dashboard acima de todas as referências analisadas — é o
  requisito onde o mercado é mais fraco e o escopo do cliente é mais exigente.

## Fontes

- [Bitrix24 REST API — Tasks](https://apidocs.bitrix24.com/api-reference/tasks/index.html)
- [Bitrix24 — Incoming and Outgoing Webhooks](https://apidocs.bitrix24.com/local-integrations/local-webhooks.html)
- [Bitrix24 — OnTaskAdd](https://apidocs.bitrix24.com/api-reference/tasks/events-tasks/on-task-add.html)
- [Bitrix24 — OnTaskUpdate](https://apidocs.bitrix24.com/api-reference/tasks/events-tasks/on-task-update.html)
- [Bitrix24 — tasks.task.add](https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-add.html)
