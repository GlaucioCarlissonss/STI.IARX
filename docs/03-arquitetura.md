# 03 — Arquitetura e Decisões (ADRs)

## 1. Visão geral

```
┌───────────────┐   ┌────────────────┐   ┌──────────────────┐
│ Painel de TV  │   │  App Admin     │   │ Sistemas         │
│ (kiosk, token)│   │  (atendentes)  │   │ terceiros        │
└───────┬───────┘   └────────┬───────┘   │ (Bitrix24, …)    │
        │                    │           └────────┬─────────┘
        │  SSR + Realtime    │ SSR + RSC          │ webhook
        v                    v                    v
┌─────────────────────────────────┐   ┌──────────────────────────┐
│  Next.js (App Router)           │   │ Supabase Edge Functions  │
│  · Server Components            │   │ · /bitrix24-webhook      │
│  · Server Actions (mutações)    │   │ · /integration-webhook   │
│  · Middleware de sessão         │   │ · /sla-sweeper (cron)    │
└──────────────┬──────────────────┘   └────────────┬─────────────┘
               │  supabase-js (JWT do usuário)     │ service_role
               v                                   v
        ┌──────────────────────────────────────────────────┐
        │  Supabase / PostgreSQL                           │
        │  · RLS multi-tenant  · Realtime  · Storage       │
        │  · Triggers de auditoria e SLA                   │
        └──────────────────────────────────────────────────┘
```

**Princípio central:** o banco é a fronteira de segurança e de consistência. A aplicação é
uma camada de apresentação e orquestração — nunca a única guarda de isolamento ou de regra
de negócio crítica.

## 2. Stack

| Camada | Escolha | Justificativa resumida |
|---|---|---|
| Frontend | Next.js 16 (App Router) + React 19 + TypeScript | RSC reduz JS no cliente — importa para o painel de TV, que roda meses sem reload |
| Estilo | Tailwind CSS v4 | Tokens via CSS vars; `clamp()` para escalar de tablet a 4K |
| Backend | Supabase (Postgres, Auth, Realtime, Storage, Edge Functions) | Requisito do escopo; RLS nativo resolve multi-tenancy na raiz |
| Webhooks | Edge Functions (Deno) | Isolado do app; escala independente; não derruba a UI sob rajada |
| Validação | Zod | Schema único compartilhado entre form, Server Action e mapeamento de integração |
| Testes | Vitest | Rápido; cobre lógica pura (mapeadores, SLA, scoring) |

---

## ADRs

### ADR-001 — Vocabulário: `tenant` ≠ `client`
**Status:** aceito

**Contexto.** O escopo usa "cliente" com dois sentidos: assinante do SaaS e empresa atendida.
Manter a ambiguidade produziria colunas como `client_id` significando coisas diferentes em
tabelas diferentes — fonte garantida de bug de vazamento de dados.

**Decisão.** `tenant` = assinante da plataforma (fronteira de isolamento). `client` = grupo
econômico atendido, sempre pertencente a exatamente um tenant. `branch` = filial de um client.

**Consequências.** Toda tabela de negócio carrega `tenant_id`. `clients.tenant_id` e
`branches.tenant_id` são redundantes em relação ao caminho via FK — redundância **intencional**,
para que a policy de RLS seja um predicado local simples e indexável, sem JOIN recursivo.
A integridade dessa redundância é garantida por FK composta `(id, tenant_id)`.

---

### ADR-002 — Multi-tenancy por RLS com claim no JWT
**Status:** aceito

**Contexto.** Três estratégias possíveis: (a) banco por tenant, (b) schema por tenant,
(c) tabela compartilhada com discriminador + RLS.

**Decisão.** (c) — tabela compartilhada, coluna `tenant_id`, RLS obrigatório.

**Alternativas rejeitadas.**
- *Banco por tenant*: isolamento perfeito, mas migrações e Realtime por tenant tornam a
  operação inviável no volume alvo, e o Supabase não oferece esse modelo de forma gerenciada.
- *Schema por tenant*: mesmo problema de migração, com o agravante de estourar o catálogo
  do Postgres com dezenas de milhares de tabelas.

**Como o tenant chega ao banco.** O `tenant_id` é gravado como *custom claim* no JWT do
Supabase Auth (via hook de `access_token`), lido nas policies por
`app.current_tenant_id()`, que encapsula `auth.jwt() -> 'app_metadata' ->> 'tenant_id'`.

> **Ponto crítico de segurança:** o claim vai em `app_metadata`, **nunca** em `user_metadata`.
> `user_metadata` é editável pelo próprio usuário autenticado via `updateUser()` — colocar
> `tenant_id` ali permitiria que qualquer usuário se movesse para outro tenant. Este é o erro
> mais comum em implementações de multi-tenancy no Supabase.

**Consequências.** Encapsular a leitura do claim em função `STABLE` permite ao planner
avaliá-la uma vez por query em vez de por linha — diferença grande em varreduras de fila.
Todo índice de tabela de negócio começa por `tenant_id`.

---

### ADR-003 — Visibilidade por filial via tabela de vínculo
**Status:** aceito

**Contexto.** RF-USR-02/03: atendente enxerga 1..N filiais; gestor enxerga o tenant inteiro.

**Decisão.** Segunda camada de RLS, além do tenant. `user_branches` (N:N) define o escopo do
atendente; papéis `gestor`/`admin` recebem bypass explícito na policy.

```sql
-- forma da policy em tickets
USING (
  tenant_id = app.current_tenant_id()
  AND ( app.has_tenant_wide_access()          -- admin, gestor
     OR branch_id = ANY (app.current_user_branch_ids()) )
)
```

**Consequências.** `app.current_user_branch_ids()` é `STABLE` e retorna `uuid[]`, permitindo
que o planner use índice em `branch_id` com `= ANY(...)`. A alternativa (`EXISTS (SELECT …)`
por linha) degradava a varredura de fila.

---

### ADR-004 — Medição de SLA em horário útil, calculada no banco
**Status:** aceito

**Contexto.** "4 horas de resolução" em horário comercial não é aritmética de timestamps.
É preciso: pular fora do expediente, pular feriados regionais, respeitar timezone da filial
e descontar pausas.

**Decisão.** A aritmética vive em funções PL/pgSQL (`fn_add_business_minutes`,
`fn_business_minutes_between`), consumidas por triggers e views.

**Alternativas rejeitadas.**
- *Calcular na aplicação*: o dashboard, o sweeper de alertas, as integrações e os relatórios
  precisariam replicar a mesma lógica — três implementações, três resultados divergentes.
- *Materializar só o prazo final na criação*: quebra quando o calendário ou o SLA muda, e não
  suporta pausas.

**Consequências.** O prazo é materializado em `sla_tracking` (para poder indexar e ordenar a
fila rapidamente) e **recalculado** por trigger quando há pausa/retomada. O saldo restante,
que muda a cada segundo, é derivado em view — nunca armazenado.

---

### ADR-005 — Dashboard: view agregada + Realtime por evento
**Status:** aceito

**Contexto.** RNF-02 exige < 3s com 10k tickets ativos, com refresh de 30–60s, em N painéis
simultâneos. Consultar tabelas transacionais a cada refresh é o antipattern A-02.

**Decisão.** Três camadas:
1. `vw_dashboard_metrics` — agregação por tenant, com índices parciais que suportam cada contador.
2. Carga inicial via Server Component (HTML já chega pronto — o painel exibe dados no primeiro paint).
3. Atualização incremental via Supabase Realtime na tabela `tickets`, com *debounce* — o
   evento dispara uma re-consulta leve, em vez de o painel varrer o banco em loop.

**Por que não view materializada.** `REFRESH MATERIALIZED VIEW` introduz atraso e carga
periódica mesmo sem mudanças; e o requisito é tempo real. Índices parciais entregam o
mesmo ganho sem defasagem. Se o volume crescer além do previsto, o caminho de evolução é
tabela de contadores mantida por trigger — registrado, não implementado agora (YAGNI).

---

### ADR-006 — Autenticação do painel de TV por token de exibição
**Status:** aceito

**Contexto.** Um painel de parede não tem operador para logar nem para renovar sessão
expirada (antipattern A-08).

**Decisão.** `dashboard_tokens`: segredo de alta entropia, **armazenado como hash SHA-256**,
com escopo (`tenant_id`, `layout_id`, `branch_ids[]`), `expires_at` opcional e `revoked_at`.
A rota `/tv/[token]` roda no servidor, resolve o token com `service_role` e injeta **somente**
os dados agregados do escopo.

**Consequências.**
- O token **nunca** vira credencial de banco; o cliente não recebe chave do Supabase com
  poder de leitura ampla. O acesso é estritamente somente-leitura e pré-filtrado no servidor.
- Guardar o hash e não o segredo significa que o valor só é exibido uma vez, na criação.
- Vazamento de token expõe apenas métricas agregadas do escopo, e é revogável em um clique.

---

### ADR-007 — Máquina de estados do ticket validada no banco
**Status:** aceito

**Contexto.** Tickets chegam por UI, por API e por integração. Validar só na UI garante que
a integração vai gravar estados inválidos (antipattern A-01).

**Decisão.** Tabela `ticket_status_transitions` declara as transições legais; trigger
`BEFORE UPDATE` rejeita o que não estiver declarado. A mesma trigger carimba
`first_response_at`, `resolved_at`, `closed_at` e abre/fecha pausas de SLA.

**Consequências.** Regra em um lugar só, aplicada a todos os caminhos de escrita. Alterar o
fluxo é inserir linha em tabela, não deploy de código.

---

### ADR-008 — Sincronização reversa com supressão de eco
**Status:** aceito

**Contexto.** RF-INT-09. Sincronização bidirecional ingênua gera loop infinito (antipattern A-05):
o SaaS atualiza o Bitrix24, o Bitrix24 dispara `ONTASKUPDATE`, o SaaS reaplica, e assim por diante.

**Decisão.** Defesa em duas camadas:
1. **Origem da mudança.** Toda escrita registra `change_source` (`ui`, `api`, `integration`).
   A sincronização reversa só dispara para mudanças cuja origem **não** é a própria integração.
2. **Janela de supressão + comparação de conteúdo.** Ao enviar para o Bitrix24, gravamos o
   hash do payload em `integration_sync_state`. Um webhook que chegue com hash idêntico dentro
   da janela é reconhecido como eco e descartado — cobre o caso em que o Bitrix24 notifica
   uma mudança que nós mesmos causamos.

**Consequências.** Desligada por padrão (lacuna L-06). O descarte de eco é registrado em
`integration_logs` com resultado `skipped_echo`, para ser auditável em vez de silencioso.

---

### ADR-009 — Segredos de integração fora do banco
**Status:** aceito

**Contexto.** Tokens de webhook do Bitrix24 são credenciais permanentes que não expiram — um
dump da tabela de configuração entregaria acesso total ao Bitrix24 do cliente (antipattern A-07).

**Decisão.** `integrations` guarda apenas a **referência** ao segredo (`secret_ref`, um nome).
O valor vive nas variáveis de ambiente / secret store da Edge Function e é resolvido em runtime.
Tokens de verificação inbound (`application_token`) são guardados como **hash**, nunca em claro —
a verificação é comparação de hashes.

**Consequências.** Rotação de segredo não exige migração de dados. Nenhum caminho da aplicação
consegue ler um segredo de integração, porque ele não está no banco.

---

### ADR-010 — Idempotência e retry no Integration Hub
**Status:** aceito

**Contexto.** RF-INT-05/06. Webhooks são reentregues por definição; a origem pode duplicar.

**Decisão.**
- **Idempotência:** `integration_events` com `UNIQUE (integration_id, event_key)`. O receptor
  insere primeiro; violação de unicidade ⇒ evento já visto ⇒ resposta `200` sem reprocessar.
  Responder `200` (e não erro) é deliberado: a origem não deve tentar de novo algo já processado.
- **Recebimento desacoplado do processamento:** o handler persiste e responde rápido
  (Bitrix24 desiste de handlers lentos). O processamento roda em seguida, e uma falha nele
  não provoca reentrega descontrolada.
- **Retry:** até 3 tentativas com backoff exponencial (1s, 2s, 4s) para chamadas **de saída**.
  Falha final marca o evento como `failed` com o erro registrado — visível na UI, reprocessável.

**Consequências.** Um evento tem estado explícito (`pending`/`processed`/`failed`/`skipped_echo`)
e trilha completa em `integration_logs`.

---

### ADR-011 — Mutação via Server Actions, leitura via RSC
**Status:** aceito

**Contexto.** Definir um caminho único de escrita, para não espalhar validação e auditoria.

**Decisão.** Leituras em Server Components com o cliente Supabase da sessão (RLS aplica-se
naturalmente). Escritas em Server Actions que validam com Zod, executam com o JWT do usuário
(nunca `service_role`) e revalidam o cache.

**Consequências.** `service_role` fica restrito às Edge Functions e à rota de TV — dois pontos
auditáveis, em vez de espalhado pela aplicação. Cada Server Action é um ponto natural para
registrar `change_source = 'ui'` (ADR-008).

---

### ADR-012 — Padrão de nomenclatura e convenções de schema
**Status:** aceito

**Decisão.** Tabelas no plural em inglês; colunas `snake_case`; PK `uuid` com
`gen_random_uuid()`; `created_at`/`updated_at` em `timestamptz` (UTC); enums de domínio como
tabela quando o cliente pode customizar (`ticket_priorities`) e como `CHECK` quando é regra do
produto (`ticket_status`). Rótulos em pt-BR ficam na camada de i18n, não no banco.

**Justificativa.** Valores de status em inglês no banco com rótulo traduzido na UI evita que
uma tradução quebre queries e relatórios. Prioridade é tabela porque o cliente customiza pesos
(antipattern A-10).
