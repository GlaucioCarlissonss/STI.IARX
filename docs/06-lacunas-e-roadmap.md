# 06 — Lacunas Funcionais: Especificação e Roadmap

> **Contexto operacional:** operação de TI distribuída nacionalmente no segmento de
> **Saúde Home Care**. Isso muda três coisas em relação a um helpdesk genérico e
> aparece nas decisões deste documento:
>
> 1. **Filiais são unidades de atendimento**, não escritórios. Áreas como Enfermagem,
>    Recepção e Farmácia têm criticidade operacional distinta — um notebook parado na
>    Enfermagem não equivale a um parado na Administração.
> 2. **Conectividade é atividade crítica.** Um link fora do ar numa filial interrompe
>    prontuário eletrônico e teleatendimento. Daí o módulo de Links de Internet ser
>    tratado como inventário de serviço crítico, não como cadastro contábil.
> 3. **Dado de saúde é dado sensível (LGPD, art. 11).** Anexos de ticket — print de
>    prontuário, foto de tela, áudio de atendimento — podem conter dado de paciente.
>    Ver [LG-01](#lacunas-globais-e-decisões-pendentes), que é a lacuna de maior risco
>    deste roadmap.

## Como ler este documento

Cada módulo declara o que **já existe** na base (migrações `0001`–`0012`) antes de
propor o que falta. Onde o escopo original pede algo que já está implementado com
outro nome, a divergência está registrada explicitamente em vez de duplicada.

**Três reconciliações importantes com a base atual**, todas detalhadas nos módulos:

| Escopo pediu | Base já tem | Decisão |
|---|---|---|
| `it_assets.assigned_to` | `it_assets.assigned_user_id` | Mantém o nome existente; renomear quebraria FK composta, índices, RLS e as Server Actions |
| Tabela nova `asset_custody_history` | `asset_assignments` com `event_type` e trigger | **Não cria tabela nova** — estende a existente e expõe uma view com o nome pedido (ver [Módulo 4](#módulo-4--histórico-de-responsável-do-equipamento)) |
| Módulo novo "Anexos em Tickets" | `ticket_attachments` já existe | Reclassificado como **melhoria** ([Módulo 5](#módulo-5--anexos-em-tickets-imagens-áudio-vídeo)) |

## O que já está implementado desta especificação

A migração `0013_areas_anexos_links.sql` entrega **a camada de dados** do que é
inequívoco, validada contra PostgreSQL real (127 asserções). O que falta em cada módulo é
a **interface** — e, nos casos marcados, a decisão do operador.

| Módulo | Banco | Interface |
|---|---|---|
| M1 — SLA e Filas | ✅ `name`, `deleted_at`, `tiebreaker`, `fn_sla_impact_preview`, `fn_bulk_transfer_queue` | ⬜ telas de edição |
| M2 — Área da Filial | ✅ `branch_areas`, FKs, trigger de coerência, `fn_seed_branch_areas` | ⬜ aba de áreas, filtro, agrupamento |
| M3 — Anexos de Inventário | ✅ `asset_attachments`, foto principal por índice | ⬜ upload, galeria, Storage |
| M4 — Custódia | ✅ campos `previous_*`, `reason`, trigger reescrita, view `asset_custody_history` | ⬜ timeline, relatório, exportação |
| M5 — Anexos em Tickets | ✅ `kind` derivado do MIME, cota no banco, `scan_status` | ⬜ upload, players, galeria |
| M6 — Dashboard Telefonia | ✅ `vw_telecom_dashboard`, índices de filtro | ⬜ filtros, gráficos, exportação |
| M7 — Contrato da Linha | ✅ `telecom_line_attachments`, vigência | ⬜ aba de documentos, alerta |
| M8 — Links de Internet | ✅ `internet_links`, anexos, `link_availability_events`, dashboards | ⬜ CRUD, Edge Function do Zabbix |
| M9 — Área na Telefonia | ✅ `company_area_id` + trigger | ⬜ campo no formulário, filtro |
| M10 — Edição de Integrações | ✅ `integration_mapping_versions` + trigger, campos de rotação | ⬜ telas de configuração e dry run |
| M11 — Mapas | ✅ `latitude`/`longitude`, precisão do geocode, 5 views com semáforo | ✅ Google Maps em `/mapas`, geocodificação e coordenada colada do Maps |

**Dois achados que só apareceram ao implementar**, ambos corrigidos:

1. **Ordenação da timeline de custódia.** `started_at` usava `now()`, que é o horário da
   *transação* — duas mudanças de custódia no mesmo commit recebiam timestamp idêntico e a
   timeline perdia a ordem. Passou a usar `clock_timestamp()`, que avança dentro da
   transação. O `ended_at` do vínculo anterior teve de acompanhar, senão violava
   `aa_valid_period`.
2. **Classificação inicial de área gerava evento falso.** Atribuir área a um ativo que
   ainda não tinha (`NULL → valor`) disparava um evento `relocation`. Na migração dos
   ativos legados (LG-02) isso criaria um evento espúrio para **cada ativo da base**. O
   trigger passou a exigir que a área anterior fosse não-nula.

**Nota sobre "Endpoints de API".** A aplicação não expõe REST próprio: leitura acontece
em Server Components e escrita em Server Actions ([ADR-011](03-arquitetura.md#adr-011)),
com Edge Functions apenas para webhooks de integração. Onde o template pede endpoint,
está declarada a **Server Action** equivalente — que é o contrato real de escrita — e a
rota HTTP só aparece quando existe de fato.

---

## MÓDULO 1 — Redefinição de SLA e Gestão de Filas

### Status
- [ ] Novo | [x] Melhoria sobre existente

### Descrição
O motor de SLA e de filas está completo no banco: precedência determinística
(`app.fn_resolve_sla`), aritmética de horário útil, pausa por espera, score de
priorização configurável por fila e proteção da fila padrão. **O que falta é a
interface de administração** — hoje SLAs, calendários, categorias e regras de fila são
cadastrados por SQL, e as telas `/sla` e `/filas` são somente leitura.

Sem isso, cada ajuste de contrato exige um desenvolvedor, o que na prática significa
que o SLA para de refletir o contrato assinado.

### Modelagem de Dados

**Já existe e não muda:** `sla_contracts`, `sla_definitions`, `sla_tracking`,
`sla_pauses`, `business_hours`, `business_hours_intervals`,
`business_hours_holidays`, `queues`, `queue_members`, `queue_rules`.

**Alterações em tabelas existentes:**

| Tabela | Campo | Tipo | Observação |
|---|---|---|---|
| `sla_definitions` | `name` | `text` | O escopo pede "nome" na listagem; hoje a definição é identificada pela combinação contrato+categoria+prioridade. Nome livre facilita a leitura gerencial. |
| `sla_definitions` | `deleted_at` | `timestamptz` | Soft delete (o escopo pede desativação sem exclusão). `is_active` já existe para pausa lógica; `deleted_at` separa "desativado" de "removido do catálogo". |
| `queues` | `tiebreaker` | `text` CHECK `('fifo','lifo','custom')` default `'fifo'` | Hoje o desempate é FIFO fixo, embutido no `ORDER BY`. |
| `queues` | `tiebreaker_expression` | `text` | Só usado quando `tiebreaker='custom'`. Ver [LG-05](#lacunas-globais-e-decisões-pendentes) — expressão livre é vetor de injeção. |

**Auditoria: nada a criar.** `sla_definitions`, `sla_contracts`, `business_hours`,
`queues`, `queue_members` e `queue_rules` **já são auditadas** pelo trigger
`app.audit_row()` (migração `0010`), que grava ator, campo, valor antigo e novo em
`audit_log`. O requisito "histórico de alterações de SLA" é, portanto, **exclusivamente
de interface**: uma aba lendo `audit_log` filtrado por `entity_type='sla_definitions'`.

**Nova função — preview de impacto:**

```sql
-- Quantos tickets ativos passariam a ser medidos por outra régua se esta
-- definição mudasse. Conta pelo vínculo gravado em sla_tracking, não
-- re-resolvendo a precedência: é o vínculo real, não uma estimativa.
create function app.fn_sla_impact_preview(p_definition_id uuid)
returns table (
  affected_open   bigint,  -- tickets em aberto medidos por esta definição
  affected_at_risk bigint, -- destes, quantos já estão em warning/critical
  affected_breached bigint
)
```

**Nova função — transferência em massa:**

```sql
-- Move N tickets de fila em uma transação, gravando o motivo em ticket_history
-- para cada um. Transação única evita o estado meio-movido de um laço na aplicação.
create function app.fn_bulk_transfer_queue(
  p_ticket_ids uuid[], p_queue_id uuid, p_reason text
) returns integer
```

**Índices recomendados:**
```sql
create index idx_sla_tracking_definition on public.sla_tracking (sla_definition_id)
  where resolved_at is null;   -- sustenta o preview de impacto
```

**Unicidade (requisito explícito):** já garantida por `uq_slad_combo`, que cobre
`(tenant_id, contract_id, category_id, priority_id)` com `coalesce` para tratar NULL
como valor. A UI deve capturar a violação `23505` e traduzi-la, não revalidar por conta.

### Regras de Negócio
1. Uma definição de SLA é única por `(contrato, categoria, prioridade)`. Contrato e
   categoria nulos são valores válidos (curinga), e a unicidade os considera.
2. `resolution_minutes >= first_response_minutes` — constraint já existente; a UI deve
   validar antes de submeter para dar mensagem em português.
3. Alterar uma definição **não recalcula tickets já abertos**. `sla_tracking` guarda o
   prazo materializado e o `sla_definition_id` que valeu no momento da criação. Mudar a
   régua depois alteraria a história do atendimento e invalidaria relatórios de
   compliance já apresentados ao cliente.
4. O preview de impacto é **informativo**: mostra o que passaria a valer para tickets
   futuros e quantos tickets em aberto usam aquela régua — sem prometer recálculo.
5. Desativar (`is_active = false`) tira a definição da resolução de novos tickets e não
   toca em nada já medido.
6. A fila padrão (`is_system_default`) aceita edição de **membros e pesos**, mas não de
   nome, slug ou status — imposto pelo trigger `app.protect_default_queue`.
7. Alterar pesos de fila muda a **ordenação imediatamente**, porque o score é calculado
   em view, não armazenado. É a diferença esperada em relação ao SLA: ordenação é
   presente, prazo é histórico.
8. Transferência em massa exige motivo com no mínimo 3 caracteres, aplicado por ticket.
9. Remover um atendente de uma fila **não desatribui** seus tickets — só deixa de
   roteá-lo. Desatribuir em massa seria destrutivo e silencioso.
10. Soma dos pesos de fila não precisa dar 100: são pesos relativos, e normalizar
    forçadamente confundiria quem configura.

### Fluxo de Usuário
1. Admin/gestor abre **SLA**; a listagem mostra nome, contrato, categoria, prioridade,
   TFR, TR, calendário, cliente/filial e situação.
2. Clica em uma linha → painel lateral com os campos editáveis.
3. Ao alterar TFR/TR, o painel consulta o preview e exibe: *"12 tickets em aberto usam
   esta régua — 3 já em risco. A mudança vale para tickets criados a partir de agora."*
4. Salva → Server Action valida, grava, `audit_log` registra por trigger, aba
   **Histórico** passa a mostrar a alteração com autor e horário.
5. Para criar: **Nova definição** → escolhe contrato (ou "padrão do tenant"), categoria
   (ou "todas"), prioridade, TFR, TR, calendário. Combinação duplicada é recusada com
   mensagem apontando a definição existente.
6. Em **Filas**: seleciona a fila → edita nome/descrição (exceto a padrão), gerencia
   membros por busca, ajusta os três pesos com feedback ao vivo de como a ordem da fila
   mudaria, escolhe o desempate.
7. Na visão da fila: seleciona vários tickets → **Transferir selecionados** → escolhe
   destino, informa motivo, confirma. Cada ticket recebe seu registro de histórico.

### Endpoints de API
Server Actions em `src/app/(app)/sla/actions.ts` e `src/app/(app)/filas/actions.ts`:

| Action | Efeito |
|---|---|
| `createSlaDefinition` | Cria definição; traduz violação de unicidade |
| `updateSlaDefinition` | Atualiza TFR, TR, calendário, nome |
| `toggleSlaDefinition` | Ativa/desativa (soft) |
| `previewSlaImpact` | Lê `app.fn_sla_impact_preview` |
| `createBusinessHours` / `updateBusinessHours` | Calendário, janelas e feriados |
| `updateQueue` | Nome, descrição, pesos, desempate |
| `setQueueMembers` | Substitui o conjunto de membros |
| `upsertQueueRule` / `deleteQueueRule` | Regras de roteamento |
| `bulkTransferQueue` | Chama `app.fn_bulk_transfer_queue` |

### Dependências
- **Depende de:** nada. É o módulo de entrada do roadmap.
- **Habilita:** operação autônoma de SLA e fila; pré-requisito prático do Módulo 11
  (o dashboard de fila em tempo real é o mesmo componente do mapa de tickets).

### Critérios de Aceite
- [ ] Listar SLAs com todos os campos exigidos, incluindo cliente/filial do contrato.
- [ ] Editar TFR, TR, calendário e pausa de clock, com efeito em tickets novos.
- [ ] Criar SLA escolhendo categoria + prioridade + contrato.
- [ ] Tentativa de duplicar combinação é recusada com mensagem que identifica a existente.
- [ ] Desativar SLA não apaga registro nem altera medição de tickets já abertos.
- [ ] Aba de histórico exibe autor, campo, valor anterior e novo, com data.
- [ ] Preview informa quantidade de tickets em aberto afetados antes de salvar.
- [ ] Fila padrão: nome e slug bloqueados na UI **e** no banco; membros e pesos editáveis.
- [ ] Alterar peso reordena a fila sem recarregar dados manualmente.
- [ ] Transferência em massa move todos ou nenhum, e grava o motivo em cada ticket.
- [ ] Visão de fila com semáforo e tempo restante atualizando sozinha.

### Lacunas e Decisões Pendentes
- **[DECISÃO PENDENTE]** Alterar um SLA deve oferecer **recálculo opcional** dos tickets
  em aberto? A regra 3 diz não por padrão. Um botão explícito "reaplicar aos N tickets em
  aberto" é implementável, mas reescreve prazos já comunicados ao cliente.
- **[DECISÃO PENDENTE]** `tiebreaker='custom'`: aceitar expressão livre é risco de
  injeção e de query impagável. Proposta: catálogo fechado de critérios
  (`menor_prazo_restante`, `maior_tempo_espera`, `cliente_prioritário`). Confirmar se o
  catálogo atende ou se há caso concreto que exija expressão.
- **[LACUNA]** O escopo pede "pausa de clock" como campo editável do SLA. Hoje a pausa é
  **comportamento de status** (`waiting_*` pausa sempre). Falta definir: é para tornar
  configurável por SLA ("neste contrato, aguardar terceiro **não** pausa")? Isso muda o
  modelo — viraria coluna em `sla_definitions`.

---

## MÓDULO 2 — Inventário: Área da Filial

### Status
- [x] Novo | [ ] Melhoria sobre existente

### Descrição
Introduz a **área** como subdivisão da filial. É a peça estrutural de maior alcance do
roadmap: sem ela não existe detalhamento por área nos mapas (Módulo 11), nem área na
telefonia (Módulo 9), nem nos links (Módulo 8).

No contexto Home Care a área carrega significado operacional: um ativo na Enfermagem
tem impacto assistencial que um ativo na Administração não tem.

### Modelagem de Dados

**Tabela nova — `branch_areas`:**

| Campo | Tipo | Constraint |
|---|---|---|
| `id` | `uuid` | PK, `gen_random_uuid()` |
| `tenant_id` | `uuid` | NOT NULL, FK `tenants` ON DELETE CASCADE |
| `branch_id` | `uuid` | NOT NULL, FK composta `(branch_id, tenant_id) → branches(id, tenant_id)` |
| `name` | `text` | NOT NULL |
| `code` | `text` | opcional, curto, para etiquetas |
| `kind` | `text` | CHECK `('assistencial','administrativa','apoio','tecnica')` — permite priorização por natureza da área |
| `is_active` | `boolean` | NOT NULL default `true` |
| `sort_order` | `smallint` | NOT NULL default `100` |
| `created_at` / `updated_at` | `timestamptz` | NOT NULL default `now()` |

Constraints e índices:
```sql
constraint uq_area_id_tenant unique (id, tenant_id)          -- permite FK composta
create unique index uq_area_name on public.branch_areas (branch_id, lower(name));
create index idx_areas_branch on public.branch_areas (tenant_id, branch_id, sort_order)
  where is_active;
```

**Por que tabela e não campo texto.** Texto livre fragmenta o dado em semanas
("Enfermagem", "enfermagem", "Enferm."), e todo agrupamento por área — que é o objetivo
inteiro — passa a mentir. É o mesmo raciocínio de `ticket_priorities`
([antipattern A-10](02-benchmarking.md#3-antipatterns-identificados--e-como-os-evitamos)).

**Por que a área pertence à filial e não ao tenant.** Duas filiais podem ter
"Enfermagem" com realidades distintas, e a área precisa desaparecer junto com a filial.
O custo é repetir o cadastro por filial — mitigado pelo template abaixo.

**Alterações em tabelas existentes:**

| Tabela | Campo | Tipo | Observação |
|---|---|---|---|
| `it_assets` | `branch_area_id` | `uuid` | FK composta `(branch_area_id, tenant_id)`. Ver regra 3 sobre obrigatoriedade. |
| `telecom_lines` | `company_area_id` | `uuid` | Módulo 9 — mesmo cadastro |
| `internet_links` | `branch_area_id` | `uuid` | Módulo 8 |

**Função de conveniência:**
```sql
-- Cria um conjunto inicial de áreas para uma filial nova. Sem isso, cadastrar
-- 40 filiais significa digitar 7 áreas 40 vezes — e a divergência de nomes que
-- a tabela existe para evitar volta pela porta da frente.
create function app.fn_seed_branch_areas(p_branch_id uuid) returns integer
```

**Índices:**
```sql
create index idx_assets_area on public.it_assets (tenant_id, branch_area_id)
  where deleted_at is null;
```

### Regras de Negócio
1. Uma área pertence a exatamente uma filial; o nome é único dentro da filial
   (case-insensitive).
2. Uma área só pode ser vinculada a ativo/linha/link **da mesma filial**. Garantido pela
   FK composta com `tenant_id` mais validação de `branch_id` por trigger — a FK sozinha
   garante o tenant, não a filial.
3. **Obrigatoriedade:** o escopo exige área obrigatória em ativos. Como há ativos
   pré-existentes sem área, a implantação é em dois passos: (a) coluna nullable +
   obrigatoriedade na UI; (b) após a migração de dados, `SET NOT NULL`. Tornar NOT NULL
   de imediato quebraria a base existente. Ver [LG-02](#lacunas-globais-e-decisões-pendentes).
4. Ativos em estoque central podem não ter área física. Sugestão: área do tipo `apoio`
   chamada "Estoque de TI" por filial, em vez de abrir exceção na obrigatoriedade.
5. Desativar área não a apaga nem desvincula o que já aponta para ela; ela apenas sai dos
   seletores.
6. Área com ativos, linhas ou links vinculados **não pode ser excluída** —
   `ON DELETE RESTRICT`. Desativar é o caminho.
7. Mudar a filial de um ativo **limpa a área**, porque a área antiga pertence à filial
   antiga. A UI deve exigir a nova área na mesma operação.

### Fluxo de Usuário
1. Em **Clientes e filiais**, a filial ganha a aba **Áreas**.
2. Ao cadastrar filial nova, o sistema oferece **"Criar áreas padrão"** — o gestor revisa
   e ajusta antes de confirmar.
3. Ao cadastrar/editar ativo, "Área da filial" aparece **dependente da filial
   selecionada**: trocar a filial recarrega as áreas e limpa a escolha anterior.
4. No inventário, novo filtro **Área** (multi-seleção) e alternador
   **Agrupar por: nenhum / filial / área**.
5. Relatório de inventário com quebra por área, exportável.

### Endpoints de API
Server Actions em `src/app/(app)/clientes/areas-actions.ts`:
`createBranchArea`, `updateBranchArea`, `toggleBranchArea`, `seedBranchAreas`.
`createAsset`/`updateAsset` passam a aceitar `branch_area_id`.

### Dependências
- **Depende de:** `branches` (existente).
- **Habilita:** Módulos 8, 9 e 11. **É o gargalo do roadmap** — os mapas com
  detalhamento por área não podem começar antes disto.

### Critérios de Aceite
- [ ] Cadastrar, editar e desativar áreas por filial.
- [ ] Nome duplicado na mesma filial é recusado (ignorando maiúsculas).
- [ ] Seletor de área na ficha do ativo lista **apenas** áreas da filial escolhida.
- [ ] Trocar a filial do ativo obriga a informar área nova.
- [ ] Filtro por área funciona combinado com filial, status e tipo.
- [ ] Agrupamento por área na listagem, com subtotais.
- [ ] Relatório com quebra por área exportável.
- [ ] Área com ativos vinculados não pode ser excluída, e a mensagem explica o porquê.
- [ ] Tentativa de vincular área de outra filial é rejeitada pelo banco.

### Lacunas e Decisões Pendentes
- **[DECISÃO PENDENTE]** Lista de áreas padrão. O escopo cita Recepção, Enfermagem,
  Administração, TI, Financeiro, Logística, Diretoria. Confirmar se serve como template
  nacional ou se cada regional tem nomenclatura própria.
- **[DECISÃO PENDENTE]** Área deve ter responsável (coordenador)? Habilitaria
  escalonamento por área — relevante em Home Care, onde a Enfermagem tem plantonista
  responsável. Não especificado; fora do escopo até confirmação.
- **[LACUNA]** Migração dos ativos existentes: quem atribui a área dos ativos já
  cadastrados? Ver [LG-02](#lacunas-globais-e-decisões-pendentes).

---

## MÓDULO 3 — Inventário: Nota de Compra e Foto do Equipamento

### Status
- [x] Novo | [ ] Melhoria sobre existente

### Descrição
Permite anexar documentos fiscais e fotos ao ativo. Fecha duas lacunas de governança:
comprovação de propriedade/garantia e evidência do estado físico do equipamento — que em
operação distribuída é o que resolve disputa sobre dano em trânsito entre filiais.

### Modelagem de Dados

**Tabela nova — `asset_attachments`:**

| Campo | Tipo | Constraint |
|---|---|---|
| `id` | `uuid` | PK |
| `tenant_id` | `uuid` | NOT NULL, FK `tenants` |
| `asset_id` | `uuid` | NOT NULL, FK composta `(asset_id, tenant_id)` |
| `category` | `text` | NOT NULL CHECK `('document','photo')` — separa as duas abas |
| `kind` | `text` | NOT NULL CHECK `('nfe','cte','receipt','contract','warranty','photo_front','photo_back','photo_tag','photo_serial','photo_other')` |
| `storage_path` | `text` | NOT NULL, único |
| `file_name` | `text` | NOT NULL — nome original, para download |
| `mime_type` | `text` | NOT NULL |
| `size_bytes` | `bigint` | CHECK `> 0` |
| `is_primary` | `boolean` | NOT NULL default `false` — thumbnail da listagem |
| `thumbnail_path` | `text` | gerado no upload de imagem |
| `uploaded_by` | `uuid` | FK `profiles` ON DELETE SET NULL |
| `created_at` | `timestamptz` | NOT NULL default `now()` |

```sql
-- Uma única foto principal por ativo: o índice parcial é o que garante,
-- em vez de a aplicação "lembrar" de desmarcar a anterior.
create unique index uq_asset_primary_photo on public.asset_attachments (asset_id)
  where is_primary and category = 'photo';
create index idx_asset_attachments on public.asset_attachments (asset_id, category, created_at desc);
constraint photo_is_image check (category <> 'photo' or mime_type like 'image/%')
```

**Por que uma tabela por entidade, e não uma tabela `attachments` polimórfica.** Uma
tabela genérica com `(entity_type, entity_id)` **não consegue ter FK** — nada impede
apontar para um ativo excluído, e a limpeza em cascata passa a depender de código. Com
tabela por entidade preservamos FK composta com `tenant_id`, cascade real e RLS de uma
linha. O custo é repetir a estrutura em Módulos 3, 7 e 8; o ganho é integridade
referencial que não depende de disciplina de quem escreve a query.

**Vínculo com NF já cadastrada.** O escopo pede referenciar em vez de duplicar upload
*"se o módulo de notas fiscais existir"*. **Não existe.** Fica previsto o campo
`invoice_ref text` para número/chave da NF-e, sem FK, e a integração real vira item de
backlog quando o módulo fiscal existir.

**Supabase Storage:** bucket privado `asset-files`, caminho
`{tenant_id}/{asset_id}/{uuid}-{slug}`. Prefixo de tenant é o que permite policy de
Storage por tenant.

### Regras de Negócio
1. Múltiplos anexos por ativo, em ambas as categorias.
2. Exatamente **zero ou uma** foto principal por ativo, garantida por índice.
3. Marcar uma foto como principal desmarca a anterior na mesma transação.
4. Categoria `photo` só aceita `image/*`; documento aceita PDF, XML e imagem.
5. Limite por arquivo: foto **2 MB após compressão** (compressão no cliente antes do
   upload), documento 10 MB.
6. Excluir ativo (soft delete) **preserva** os anexos — a comprovação fiscal precisa
   sobreviver à baixa do equipamento, por exigência contábil.
7. Excluir anexo é hard delete no banco **e** no Storage. Órfão no Storage é custo que
   ninguém audita.
8. Somente `admin` e `gestor` anexam ou removem; `atendente` visualiza; `visualizador`
   não acessa a aba de documentos.
9. Nome de arquivo é sanitizado no caminho do Storage, e o original é preservado em
   `file_name` para o download.

### Fluxo de Usuário
1. Ficha do ativo ganha abas **Documentos** e **Fotos**.
2. Em **Fotos**: arrasta arquivos → compressão no cliente → preview em grade → clica na
   estrela para definir a principal.
3. Na listagem do inventário, a foto principal aparece como thumbnail.
4. Em **Documentos**: escolhe o tipo (NF-e, CT-e, recibo, contrato, garantia), anexa,
   informa opcionalmente a chave/número da NF.
5. Clique abre visualização; PDF em nova aba, imagem em lightbox, XML como download.

### Endpoints de API
Server Actions em `src/app/(app)/inventario/attachment-actions.ts`:
`uploadAssetAttachment`, `setPrimaryPhoto`, `deleteAssetAttachment`.
A URL assinada de leitura é gerada no servidor por `createSignedUrl`, com validade curta
— o bucket é privado e nunca recebe leitura anônima.

### Dependências
- **Depende de:** `it_assets`; Supabase Storage provisionado.
- **Habilita:** governança de ativos; base do padrão de anexos reutilizado nos
  Módulos 5, 7 e 8.

### Critérios de Aceite
- [ ] Anexar múltiplos documentos com tipo, e listá-los com autor e data.
- [ ] Anexar múltiplas fotos e definir uma como principal.
- [ ] Thumbnail da foto principal aparece na listagem do inventário.
- [ ] Foto acima do limite é comprimida antes do upload; se ainda exceder, é recusada
      com mensagem clara.
- [ ] Arquivo de tipo não permitido é recusado.
- [ ] Excluir anexo remove do banco e do Storage.
- [ ] Baixar ativo (retired) mantém os anexos acessíveis.
- [ ] Usuário de outro tenant não acessa o arquivo nem pela URL do Storage.
- [ ] `visualizador` não vê a aba de documentos.

### Lacunas e Decisões Pendentes
- **[DECISÃO PENDENTE]** Retenção de anexo após baixa do ativo. Regra fiscal brasileira
  sugere 5 anos para documento fiscal. Confirmar o prazo e se há expurgo automático.
- **[LACUNA]** Módulo de notas fiscais não existe; `invoice_ref` fica como texto livre.
- **[DECISÃO PENDENTE]** Antivírus em upload — ver [LG-03](#lacunas-globais-e-decisões-pendentes).

---

## MÓDULO 4 — Histórico de Responsável do Equipamento

### Status
- [ ] Novo | [x] Melhoria sobre existente

### Descrição
Rastreabilidade de custódia do equipamento. **Já existe em boa parte:**
`asset_assignments` registra `event_type` (`acquisition`, `assignment`, `maintenance`,
`relocation`, `return`, `retirement`, `loss`) e o trigger `trg_assets_history` grava
automaticamente quando `assigned_user_id` ou `branch_id` mudam.

**O escopo pede uma tabela nova `asset_custody_history`. Recomendo não criá-la.**

### Modelagem de Dados

**Por que não criar `asset_custody_history`.** Duas tabelas alimentadas pelo mesmo evento
divergem: uma escrita que passe pelo caminho antigo aparece em uma e falta na outra, e
qualquer relatório passa a depender de saber qual das duas é a verdade. O trigger atual
já cobre o requisito central ("toda vez que o responsável muda, registrar"). O que falta
é **campo de motivo** e **responsável anterior explícito**.

**Alterações em `asset_assignments`:**

| Campo | Tipo | Observação |
|---|---|---|
| `previous_user_id` | `uuid` | FK composta para `profiles`. Hoje o anterior é inferido pela linha anterior da timeline; explicitar torna o relatório uma leitura direta. |
| `previous_branch_id` | `uuid` | Mesma razão |
| `previous_area_id` | `uuid` | Depende do Módulo 2 |
| `reason` | `text` | CHECK `('realocacao','devolucao','substituicao','baixa','manutencao','aquisicao','perda','outro')` |
| `reason_note` | `text` | Texto livre complementar |

**View com o nome pedido pelo escopo**, para que relatórios e integrações usem o
vocabulário do negócio sem duplicar dado:

```sql
create view public.asset_custody_history with (security_invoker = true) as
select aa.id, aa.tenant_id, aa.asset_id,
       a.asset_tag, a.model,
       aa.previous_user_id, pu.full_name as previous_user_name,
       aa.user_id          as current_user_id, cu.full_name as current_user_name,
       aa.previous_branch_id, aa.branch_id, aa.branch_area_id,
       aa.event_type, aa.reason, aa.reason_note,
       aa.performed_by, pb.full_name as performed_by_name,
       aa.started_at as changed_at
from public.asset_assignments aa
join public.it_assets a on a.id = aa.asset_id
left join public.profiles pu on pu.id = aa.previous_user_id
left join public.profiles cu on cu.id = aa.user_id
left join public.profiles pb on pb.id = aa.performed_by
where aa.event_type in ('assignment','relocation','return','retirement','loss');
```

**Trigger atualizado:** `app.assets_after_update_history()` passa a gravar
`previous_user_id`, `previous_branch_id` e `previous_area_id` a partir de `OLD`, e a
derivar `reason` do tipo de mudança quando a aplicação não informar.

**Indicador de governança** — "ativos sem responsável":
```sql
create index idx_assets_no_owner on public.it_assets (tenant_id, branch_id)
  where assigned_user_id is null and deleted_at is null and status = 'active';
```
O índice parcial é o que permite o contador do dashboard sem varrer a tabela.

### Regras de Negócio
1. Todo evento de custódia é gravado por **trigger**, não pela aplicação: mudança por
   importação em massa, integração ou SQL direto também é registrada
   ([antipattern A-06](02-benchmarking.md#3-antipatterns-identificados--e-como-os-evitamos)).
2. A aplicação pode **enriquecer** o motivo, nunca criar o registro. O motivo informado
   na UI é passado ao trigger por variável de sessão ou gravado em `UPDATE` subsequente
   sobre a linha recém-criada.
3. Histórico é **imutável**: sem UPDATE nem DELETE por usuário final. RLS concede apenas
   SELECT.
4. Ativo `active` sem responsável entra no alerta de governança. Em estoque
   (`in_stock`) não entra — sem responsável é o estado correto.
5. A timeline mostra também mudança de filial e de área, não só de pessoa: em operação
   nacional, "onde está" é tão relevante quanto "com quem está".

### Fluxo de Usuário
1. Ficha do ativo → aba **Custódia**: timeline cronológica invertida com ícone por
   motivo, de/para, quem executou e quando.
2. Ao trocar o responsável, a UI **pede o motivo** antes de salvar.
3. Em **Inventário → Relatórios → Custódia**: filtra por ativo, responsável atual,
   período e motivo; exporta PDF ou Excel.
4. No painel, o cartão **"Ativos sem responsável"** leva ao inventário já filtrado.

### Endpoints de API
`changeAssetCustody(assetId, newUserId, branchId, areaId, reason, note)` — Server Action
única para a troca, garantindo que motivo e destino cheguem juntos.
`exportCustodyReport(filters, format)` — gera PDF/XLSX no servidor.

### Dependências
- **Depende de:** `asset_assignments` (existente); Módulo 2 para rastrear área.
- **Habilita:** indicador de governança no Módulo 11 (marcador vermelho = ativos sem
  responsável).

### Critérios de Aceite
- [ ] Trocar responsável gera registro com anterior, novo, autor, data e motivo.
- [ ] Mudança feita por SQL direto também aparece no histórico.
- [ ] Timeline na ficha do ativo em ordem cronológica.
- [ ] Relatório filtrável por ativo, responsável, período e motivo.
- [ ] Exportação em PDF e Excel com os mesmos filtros aplicados.
- [ ] Nenhum papel consegue editar ou apagar registro de custódia.
- [ ] Contador "ativos sem responsável" confere com o filtro do inventário.
- [ ] Mudança de filial registra também a área de origem e destino.

### Lacunas e Decisões Pendentes
- **[DECISÃO PENDENTE]** Confirmar a recomendação de **não criar**
  `asset_custody_history` e usar a view. Se houver exigência externa (auditoria,
  integração legada) pelo nome de tabela física, a view pode virar tabela materializada.
- **[DECISÃO PENDENTE]** Termo de responsabilidade assinado na entrega do equipamento —
  prática comum e ausente do escopo. Encaixaria como anexo do evento de custódia
  (Módulo 3).
- **[LACUNA]** Como o motivo chega ao trigger: variável de sessão
  (`set local app.custody_reason`) ou UPDATE em duas etapas. Definir na implementação.

---

## MÓDULO 5 — Anexos em Tickets (imagens, áudio, vídeo)

### Status
- [ ] Novo | [x] Melhoria sobre existente

### Descrição
`ticket_attachments` **já existe** com `storage_path`, `file_name`, `mime_type`,
`size_bytes`, `uploaded_by` e vínculo opcional a comentário. Falta: classificação por
mídia, thumbnails, players, cota por tenant e as policies de Storage. Em Home Care, o
solicitante frequentemente descreve melhor por áudio ou foto de tela do que por texto.

### Modelagem de Dados

**Alterações em `ticket_attachments`:**

| Campo | Tipo | Observação |
|---|---|---|
| `kind` | `text` | NOT NULL CHECK `('image','audio','video','document')`; derivado do MIME por trigger, não confiado ao cliente |
| `thumbnail_path` | `text` | imagem redimensionada ou primeiro frame do vídeo |
| `duration_seconds` | `integer` | áudio e vídeo |
| `width` / `height` | `integer` | evita salto de layout na galeria |
| `scan_status` | `text` | CHECK `('pending','clean','infected','skipped')` default `'skipped'` — ver LG-03 |

**Alteração em `tenants`:**
`attachment_quota_mb integer NOT NULL DEFAULT 500` — cota por **ticket**, como pede o escopo.

**Função de cota:**
```sql
-- Soma o consumo do ticket. Chamada por trigger BEFORE INSERT: a validação
-- precisa acontecer no banco, senão dois uploads simultâneos furam a cota.
create function app.fn_ticket_attachment_usage(p_ticket_id uuid) returns bigint
```

**Storage:** bucket privado `ticket-files`, caminho
`{tenant_id}/{ticket_id}/{uuid}-{slug}`. Policies em `storage.objects` derivando o tenant
do primeiro segmento do caminho e reaproveitando `app.current_tenant_id()`.

**Índices:**
```sql
create index idx_ticket_attachments_kind on public.ticket_attachments (ticket_id, kind);
```

### Regras de Negócio
1. Limites por arquivo: imagem 10 MB; áudio 25 MB; vídeo 50 MB; documento 10 MB.
2. Cota de 500 MB por ticket (configurável por tenant), validada **no banco**.
3. `kind` é derivado do MIME real por trigger. Extensão informada pelo cliente não é
   fonte de verdade.
4. Permissões, conforme o escopo: solicitante anexa (nos próprios tickets), atendente
   anexa, **visualizador não anexa**. Herdado da RLS de `tickets` mais checagem de papel.
5. Anexo em comentário interno herda a visibilidade do comentário — não pode aparecer
   para o solicitante. **É o ponto de vazamento mais provável do módulo.**
6. Excluir ticket (soft delete) mantém os anexos; expurgo é processo separado.
7. Leitura sempre por URL assinada de vida curta; o bucket nunca é público.
8. Enquanto `scan_status = 'pending'`, o anexo é listado como "em verificação" e não
   gera URL assinada.

### Fluxo de Usuário
1. No formulário de abertura, área de arrastar-e-soltar com progresso por arquivo.
2. Anexos aparecem na galeria do ticket, com filtro por tipo.
3. Imagem abre em lightbox; áudio e vídeo tocam inline; documento baixa.
4. Ao comentar, os anexos ficam vinculados àquele comentário e aparecem no fio.
5. Excedida a cota, o upload é bloqueado com a mensagem do quanto resta.

### Endpoints de API
Server Actions em `src/app/(app)/tickets/attachment-actions.ts`:
`uploadTicketAttachment`, `deleteTicketAttachment`, `getSignedAttachmentUrl`.
Geração de thumbnail e leitura de duração: Edge Function `media-postprocess`, acionada
após o upload (fora do caminho da requisição do usuário).

### Dependências
- **Depende de:** `ticket_attachments`, `ticket_comments` (existentes); Storage.
- **Habilita:** qualidade de diagnóstico; nenhuma dependência a jusante.

### Critérios de Aceite
- [ ] Anexar imagem, áudio, vídeo e documento na abertura e em comentários.
- [ ] Preview inline de imagem; player de áudio e de vídeo.
- [ ] Arquivo acima do limite do seu tipo é recusado com mensagem específica.
- [ ] Cota por ticket é respeitada mesmo com uploads simultâneos.
- [ ] `visualizador` não consegue anexar, nem pela Server Action direta.
- [ ] Solicitante não acessa anexo de comentário interno, nem pela URL do Storage.
- [ ] Galeria filtra por tipo de mídia.
- [ ] Thumbnail gerado para imagem e vídeo.
- [ ] URL assinada expira e não é reutilizável após expirar.

### Lacunas e Decisões Pendentes
- **[DECISÃO PENDENTE — CRÍTICA]** Anexo de ticket em operação Home Care pode conter
  **dado de paciente**. Ver [LG-01](#lacunas-globais-e-decisões-pendentes).
- **[DECISÃO PENDENTE]** Antivírus: ver [LG-03](#lacunas-globais-e-decisões-pendentes).
- **[DECISÃO PENDENTE]** Transcodificação de vídeo. Sem ela, vídeo de celular pode chegar
  em formato que o navegador não toca. Fora do escopo; recomendo restringir a MP4/WebM e
  orientar na UI.

---

## MÓDULO 6 — Telefonia: Filtros e Dashboard de Análise

### Status
- [ ] Novo | [x] Melhoria sobre existente

### Descrição
A tela de telefonia lista linhas e mostra custo por operadora, mas não tem filtros nem
dashboard analítico. Para gestão nacional de conta telefônica, filtrar por filial e
operadora é o que permite negociar contrato e identificar desperdício.

### Modelagem de Dados
**Sem tabela nova.** O módulo é de leitura e depende de:
- `telecom_lines.company_area_id` (Módulo 9);
- views agregadas novas;
- índices que sustentem a filtragem.

```sql
create index idx_lines_filters on public.telecom_lines (tenant_id, branch_id, carrier, status)
  where deleted_at is null;
create index idx_lines_activated on public.telecom_lines (tenant_id, activated_on)
  where deleted_at is null;
create index idx_lines_no_user on public.telecom_lines (tenant_id, branch_id)
  where assigned_user_id is null and status = 'active' and deleted_at is null;
```

**Views novas:**

| View | Conteúdo |
|---|---|
| `vw_telecom_dashboard` | Por tenant/filial/operadora/área/tipo: contagem, custo total, custo médio por linha |
| `vw_telecom_cost_evolution` | Custo mensal agregado por mês de referência — série da linha do tempo |
| `vw_telecom_governance` | Linhas sem usuário, sem contrato (Módulo 7), com fidelidade ativa vs. livres |

`vw_telecom_costs` (existente) é mantida; as novas a complementam sem substituí-la.

**Sobre a evolução de custo.** `monthly_cost` é o valor **atual**, não uma série
histórica. Reconstruir evolução real exigiria snapshot mensal — ver
[LG-04](#lacunas-globais-e-decisões-pendentes). Sem isso, o gráfico só mostra
"custo vigente projetado", e o rótulo na UI deve dizer exatamente isso.

### Regras de Negócio
1. Filtros são combináveis e refletidos na URL, para o gestor compartilhar a visão.
2. Filtros multi-seleção usam OR interno e AND entre dimensões.
3. Indicadores respeitam os filtros ativos: filtrar Vivo mostra custo só da Vivo.
4. "Custo mensal total" considera apenas linhas `active` — incluir cancelada infla o
   número e é o erro mais comum nesse tipo de relatório.
5. "Custo médio por linha" divide pelo total de ativas da mesma seleção.
6. "Livres para cancelamento" = `loyalty_until` nulo ou já vencido, e status `active`.
7. Exportação carrega exatamente os filtros da tela.
8. RLS continua valendo: atendente vê apenas as linhas das suas filiais, e o dashboard
   agrega **somente sobre o que ele pode ver** — os totais são coerentes com o escopo do
   usuário, não com o tenant.

### Fluxo de Usuário
1. Barra de filtros com filial, operadora, área, status, tipo de plano, período e busca.
2. Abaixo dela, cartões de indicadores que se atualizam com os filtros.
3. Gráficos: barras por filial, pizza por operadora, linha de custo vigente.
4. Tabela filtrada; **Exportar** gera PDF ou Excel com os filtros no cabeçalho.
5. Cartão "linhas sem usuário atribuído" leva à tabela já filtrada.

### Endpoints de API
Leitura em Server Components via `searchParams`. Sem Server Action nova; a exportação usa
`exportTelecomReport(filters, format)`.

### Dependências
- **Depende de:** Módulo 9 (área) para o filtro por área; Módulo 7 para "sem contrato".
- **Habilita:** Módulo 11 (mapa de telefonia consome os mesmos filtros).

### Critérios de Aceite
- [ ] Todos os filtros do escopo presentes e combináveis.
- [ ] Filtros na URL; recarregar preserva a seleção.
- [ ] Indicadores e gráficos reagem aos filtros.
- [ ] Custo total considera somente linhas ativas.
- [ ] "Livres para cancelamento" confere com fidelidade nula ou vencida.
- [ ] Exportação PDF e Excel com filtros aplicados e registrados no cabeçalho.
- [ ] Atendente com uma filial vê totais apenas da sua filial.
- [ ] Dashboard responde em menos de 2s com 5.000 linhas.

### Lacunas e Decisões Pendentes
- **[LACUNA]** Série histórica de custo — ver [LG-04](#lacunas-globais-e-decisões-pendentes).
- **[DECISÃO PENDENTE]** Importar fatura da operadora para conciliar cadastro × cobrança?
  É o maior gerador de economia real nesse módulo, e está fora do escopo atual.

---

## MÓDULO 7 — Telefonia: Anexo de Contrato da Linha

### Status
- [x] Novo | [ ] Melhoria sobre existente

### Descrição
Anexo de contrato, adendos e termo de fidelidade à linha, com alerta de vencimento.
Repete o padrão do Módulo 3.

### Modelagem de Dados

**Tabela nova — `telecom_line_attachments`:** estrutura idêntica a `asset_attachments`,
trocando `asset_id` por `line_id` (FK composta com `tenant_id`) e o CHECK de `kind` por
`('contract','amendment','loyalty_term','cancellation','invoice','other')`.

**Alterações em `telecom_lines`:**

| Campo | Tipo | Observação |
|---|---|---|
| `contract_number` | `text` | Número do contrato com a operadora |
| `contract_start` | `date` | Início da vigência |
| `contract_end` | `date` | Fim da vigência — base do alerta |

```sql
constraint line_contract_period check (contract_end is null or contract_start is null
                                       or contract_end >= contract_start)
create index idx_lines_contract_end on public.telecom_lines (tenant_id, contract_end)
  where contract_end is not null and deleted_at is null and status <> 'cancelled';
```

**Storage:** bucket privado `telecom-files`, caminho `{tenant_id}/{line_id}/...`.

### Regras de Negócio
1. Múltiplos anexos por linha, com tipo obrigatório.
2. Linha sem anexo de tipo `contract` entra no alerta de governança contratual.
3. Alerta de vencimento em 90, 60 e 30 dias de `contract_end`. Ver
   [LG-06](#lacunas-globais-e-decisões-pendentes) sobre o canal de notificação.
4. Fidelidade (`loyalty_until`) e vigência (`contract_end`) são coisas diferentes e não
   devem ser misturadas: fidelidade limita o cancelamento sem multa; vigência é o prazo
   contratual.
5. Cancelar a linha não apaga anexos — o contrato precisa sobreviver ao cancelamento para
   comprovar as condições acordadas.
6. Mesmas permissões do Módulo 3.

### Fluxo de Usuário
1. Ficha da linha ganha aba **Documentos**.
2. Anexa informando o tipo; preenche vigência se aplicável.
3. Filtro **"sem contrato anexado"** na listagem.
4. Painel de telefonia exibe "contratos vencendo em 90 dias".

### Endpoints de API
`uploadLineAttachment`, `deleteLineAttachment`, `getSignedLineAttachmentUrl`.

### Dependências
- **Depende de:** `telecom_lines`; Storage; padrão do Módulo 3.
- **Habilita:** indicador "sem contrato" no Módulo 6.

### Critérios de Aceite
- [ ] Anexar contrato, adendo e termo de fidelidade, com tipo e metadados.
- [ ] Filtro de linhas sem contrato anexado.
- [ ] Alerta de vencimento nos marcos definidos.
- [ ] Cancelar linha preserva anexos.
- [ ] Vigência inválida (fim antes do início) é recusada.
- [ ] Isolamento entre tenants verificado também no Storage.

### Lacunas e Decisões Pendentes
- **[DECISÃO PENDENTE]** Canal do alerta de vencimento — ver [LG-06](#lacunas-globais-e-decisões-pendentes).
- **[DECISÃO PENDENTE]** Multa de fidelidade deve ser cadastrada para projetar custo de
  cancelamento antecipado? Útil para decisão de troca de operadora; ausente do escopo.

---

## MÓDULO 8 — Links de Internet

### Status
- [x] Novo | [ ] Melhoria sobre existente

### Descrição
Módulo novo, espelhando telefonia, para acompanhar conectividade contratada por filial.
Em Home Care este é **inventário de serviço crítico**: link fora do ar interrompe
prontuário eletrônico e teleatendimento, então o módulo nasce com monitoração de
disponibilidade, não apenas cadastro contábil.

### Modelagem de Dados

**Tabela nova — `internet_links`:**

| Campo | Tipo | Constraint |
|---|---|---|
| `id` | `uuid` | PK |
| `tenant_id` | `uuid` | NOT NULL, FK `tenants` |
| `branch_id` | `uuid` | NOT NULL, FK composta |
| `branch_area_id` | `uuid` | FK composta (Módulo 2) |
| `contract_number` | `text` | |
| `supplier_id` | `uuid` | FK composta para `suppliers` — reaproveita o cadastro existente em vez de repetir operadora como texto |
| `carrier_name` | `text` | Preenchido quando a operadora não está cadastrada como fornecedor |
| `technology` | `text` | NOT NULL CHECK `('fiber','radio','satellite','mobile_4g','mobile_5g','xdsl','other')` |
| `download_mbps` / `upload_mbps` | `integer` | CHECK `> 0` |
| `guaranteed_mbps` | `integer` | Banda garantida (SLA do provedor) |
| `has_static_ip` | `boolean` | NOT NULL default `false` |
| `static_ip` | `inet` | Tipo nativo do Postgres valida o endereço |
| `cpe_brand` / `cpe_model` / `cpe_serial` | `text` | Equipamento de borda |
| `cpe_asset_id` | `uuid` | FK composta para `it_assets` — quando o CPE é patrimônio próprio |
| `status` | `text` | NOT NULL CHECK `('active','suspended','cancelled')` |
| `monthly_cost` | `numeric(12,2)` | CHECK `>= 0` |
| `activated_on` / `cancelled_on` | `date` | |
| `contract_start` / `contract_end` | `date` | |
| `loyalty_until` | `date` | |
| `monitoring_host` | `text` | IP/hostname monitorado |
| `monitoring_external_id` | `text` | ID no Zabbix |
| `last_state` | `text` | CHECK `('up','down','unknown')` default `'unknown'` |
| `last_state_at` | `timestamptz` | |
| `notes` | `text` | |
| `created_at` / `updated_at` / `deleted_at` | `timestamptz` | |

```sql
constraint uq_link_id_tenant unique (id, tenant_id)
constraint link_static_ip_pair check (not has_static_ip or static_ip is not null)
constraint link_cancel_needs_date check (status <> 'cancelled' or cancelled_on is not null)
create unique index uq_link_contract on public.internet_links (tenant_id, upper(contract_number))
  where contract_number is not null and deleted_at is null;
create index idx_links_branch on public.internet_links (tenant_id, branch_id, status) where deleted_at is null;
create index idx_links_down on public.internet_links (tenant_id, branch_id)
  where last_state = 'down' and status = 'active' and deleted_at is null;
```

**Tabela nova — `internet_link_attachments`:** padrão do Módulo 7, com `kind` em
`('contract','amendment','loyalty_term','cancellation','installation_report','other')`.

**Tabela nova — `link_availability_events`:** histórico de indisponibilidade.

| Campo | Tipo |
|---|---|
| `id` | `bigint` GENERATED ALWAYS AS IDENTITY |
| `tenant_id` / `link_id` | `uuid` NOT NULL, FK |
| `state` | `text` CHECK `('up','down')` |
| `started_at` / `ended_at` | `timestamptz` |
| `duration_seconds` | `integer` GENERATED — evita recalcular em todo relatório |
| `source` | `text` CHECK `('zabbix','manual','api')` |
| `external_event_id` | `text` — idempotência do webhook |

```sql
create unique index uq_link_event_external on public.link_availability_events (link_id, external_event_id)
  where external_event_id is not null;
create index idx_link_events on public.link_availability_events (link_id, started_at desc);
```

**Views:** `vw_internet_dashboard` (por filial/operadora/tecnologia: contagem, custo,
links down), `vw_connectivity_cost` (**telefonia + links consolidados por filial** — o
relatório pedido no escopo).

### Regras de Negócio
1. Operadora vem de `suppliers` quando cadastrada; `carrier_name` é o escape para quando
   não está. Exigir cadastro completo travaria o registro de um link urgente.
2. `has_static_ip = true` obriga `static_ip` preenchido.
3. Status `cancelled` exige `cancelled_on`.
4. Monitoração é **opcional por link**: sem `monitoring_host`, `last_state` fica
   `unknown` e a UI mostra "não monitorado" — não "fora do ar".
5. Evento de indisponibilidade é **imutável** após fechado (`ended_at` preenchido).
6. Idempotência do webhook do Zabbix por `(link_id, external_event_id)`, mesmo padrão do
   Integration Hub ([ADR-010](03-arquitetura.md#adr-010)).
7. Link `down` por mais de X minutos gera alerta; X é configurável por tenant. Deve
   **abrir ticket automaticamente** na fila de infraestrutura — decisão em
   [LG-07](#lacunas-globais-e-decisões-pendentes).
8. CPE pode ser patrimônio próprio (`cpe_asset_id`) ou do provedor (campos textuais).
   Ambos coexistem; não são mutuamente exclusivos por constraint porque a realidade é
   ambígua durante troca de equipamento.
9. Custo de conectividade da filial = links ativos + linhas ativas, na mesma view.

### Fluxo de Usuário
1. Novo item de menu **Links de Internet**.
2. Listagem com filtros: filial, operadora, tecnologia, status, faixa de velocidade,
   estado de monitoração.
3. Cadastro em seções: contrato, banda, IP, CPE, localização (filial + área),
   monitoração.
4. Ficha do link com abas **Dados**, **Documentos** e **Disponibilidade** (timeline de
   quedas com duração e uptime do período).
5. Painel: links ativos por filial, custo por filial e operadora, contratos vencendo,
   links sem contrato, links fora do ar agora.
6. Relatório consolidado de conectividade por filial.

### Endpoints de API
Server Actions: `createInternetLink`, `updateInternetLink`, `uploadLinkAttachment`,
`deleteLinkAttachment`.
Edge Function `POST /functions/v1/link-monitor-webhook?integracao=<slug>` — recebe evento
do Zabbix, valida token por hash, deduplica por `external_event_id`, atualiza
`last_state` e fecha/abre `link_availability_events`.

### Dependências
- **Depende de:** Módulo 2 (área), `suppliers`, `branches`; Storage; padrão de anexos do
  Módulo 3/7.
- **Habilita:** Módulo 11 (mapa de links); relatório consolidado de conectividade.

### Critérios de Aceite
- [ ] Cadastrar link com todos os campos do escopo.
- [ ] IP fixo sem endereço é recusado.
- [ ] Anexar contrato e visualizar na aba Documentos.
- [ ] Filtros por filial, operadora, tecnologia, status e velocidade.
- [ ] Painel com ativos por filial, custo por filial/operadora e contratos vencendo.
- [ ] Link sem `monitoring_host` aparece como "não monitorado", nunca como "fora do ar".
- [ ] Webhook de monitoração é idempotente e registra o evento com duração.
- [ ] Timeline de indisponibilidade com uptime do período.
- [ ] Relatório consolidado soma telefonia e links por filial.
- [ ] Números de contrato duplicados no mesmo tenant são recusados.

### Lacunas e Decisões Pendentes
- **[DECISÃO PENDENTE]** Zabbix existe e está acessível? Qual versão, e o disparo será
  webhook (preferível) ou polling da API? Ver [LG-07](#lacunas-globais-e-decisões-pendentes).
- **[DECISÃO PENDENTE]** Abertura automática de ticket em queda de link, com qual
  prioridade e após quantos minutos.
- **[DECISÃO PENDENTE]** Medir banda entregue vs. contratada (teste de velocidade
  agendado)? Fora do escopo; é o dado que sustenta reclamação formal ao provedor.
- **[LACUNA]** Link redundante/backup: o escopo não trata de par primário+backup na mesma
  filial. Modelável com `parent_link_id`, mas depende de confirmação de que existe.

---

## MÓDULO 9 — Telefonia: Área da Empresa Alocada

### Status
- [ ] Novo | [x] Melhoria sobre existente

### Descrição
Aplica o cadastro de áreas do Módulo 2 às linhas telefônicas. Módulo pequeno em código e
grande em dependência: sem ele, o filtro por área do Módulo 6 e o detalhamento do mapa de
telefonia (Módulo 11) não existem.

### Modelagem de Dados

**Alteração em `telecom_lines`:**

| Campo | Tipo | Observação |
|---|---|---|
| `company_area_id` | `uuid` | FK composta `(company_area_id, tenant_id) → branch_areas(id, tenant_id)`. Nome segue o escopo; aponta para a mesma tabela do Módulo 2. |

```sql
create index idx_lines_area on public.telecom_lines (tenant_id, company_area_id)
  where deleted_at is null;
```

Mesma trigger de coerência do Módulo 2: a área precisa pertencer à filial da linha.

### Regras de Negócio
1. A área da linha deve pertencer à filial da linha.
2. Obrigatória na UI; nullable no banco durante a transição (mesma estratégia da regra 3
   do Módulo 2).
3. Trocar a filial da linha limpa a área.
4. Linha sem filial não pode ter área — a área é sempre subordinada à filial.

### Fluxo de Usuário
1. Formulário de linha ganha "Área da empresa", dependente da filial.
2. Filtro por área na listagem (integrado ao Módulo 6).
3. Relatório de linhas por área dentro de cada filial.
4. Gráfico de distribuição por área.

### Endpoints de API
`createTelecomLine` / `updateTelecomLine` passam a aceitar `company_area_id`.

### Dependências
- **Depende de:** **Módulo 2** (bloqueante).
- **Habilita:** filtro por área no Módulo 6; detalhamento por área no Módulo 11.

### Critérios de Aceite
- [ ] Campo de área no cadastro de linha, listando só áreas da filial escolhida.
- [ ] Área de outra filial é rejeitada pelo banco.
- [ ] Filtro por área combinável com os demais.
- [ ] Relatório e gráfico de distribuição por área.
- [ ] Trocar a filial obriga a informar nova área.

### Lacunas e Decisões Pendentes
- **[DECISÃO PENDENTE]** Linha de uso corporativo móvel (ex.: enfermeiro em visita
  domiciliar) não fica fisicamente em área nenhuma. Criar área "Equipe Externa" por
  filial, ou permitir área nula com justificativa? Recomendo a primeira — mantém a
  obrigatoriedade sem inventar exceção no modelo.

---

## MÓDULO 10 — Integrações: Edição de Endpoint e Mapeamento

### Status
- [ ] Novo | [x] Melhoria sobre existente

### Descrição
`integrations` e `integration_mappings` existem e são auditadas; a UI hoje só ativa,
pausa e liga a sincronização reversa. Falta editar endpoint, autenticação e mapeamento,
com versionamento e teste sem efeito colateral.

### Modelagem de Dados

**Alterações em `integrations`:**

| Campo | Tipo | Observação |
|---|---|---|
| `polling_endpoint` | `text` | Separado de `base_url`: no Bitrix24 a URL de polling e a base REST não coincidem |
| `auth_header_name` | `text` | Para `auth_type='api_key'` em header customizado |
| `secret_ref_pending` | `text` | Segundo secret durante a rotação de credencial |
| `secret_rotated_at` | `timestamptz` | |
| `last_test_at` / `last_test_ok` | `timestamptz` / `boolean` | Resultado do último teste de conectividade |

O segredo continua **fora do banco** ([ADR-009](03-arquitetura.md#adr-009)): a rotação
troca a *referência*, nunca guarda valor.

**Tabela nova — `integration_mapping_versions`:**

| Campo | Tipo |
|---|---|
| `id` | `uuid` PK |
| `tenant_id` / `integration_id` | `uuid` NOT NULL, FK composta |
| `version` | `integer` NOT NULL |
| `snapshot` | `jsonb` NOT NULL — conjunto completo de mapeamentos daquela versão |
| `created_by` | `uuid` FK `profiles` |
| `created_at` | `timestamptz` |
| `note` | `text` |

```sql
constraint uq_mapping_version unique (integration_id, version)
constraint snapshot_is_array check (jsonb_typeof(snapshot) = 'array')
```

**Snapshot em JSONB, não tabela versionada linha a linha.** O que se restaura é o
**conjunto** — um mapeamento isolado de uma versão antiga não faz sentido sem os outros.
Snapshot torna o rollback uma escrita atômica.

**Trigger:** qualquer INSERT/UPDATE/DELETE em `integration_mappings` grava nova versão
antes de aplicar. Assim o rollback existe mesmo quando alguém edita por SQL.

### Regras de Negócio
1. Editar endpoint ou autenticação **não interrompe** a integração: eventos recebidos
   durante a edição continuam sendo processados.
2. Rotação de credencial: grava `secret_ref_pending`, testa conectividade, e só promove a
   principal se o teste passar. Falhando, mantém a anterior e reporta.
3. Alterar mapeamento exige validação: todo campo obrigatório do ticket (`title`,
   `priority_id`) precisa ter origem mapeada ou valor padrão. Sem isso, a próxima carga
   quebra em produção.
4. **Dry run não escreve nada.** Recebe payload de exemplo, roda `applyMapping` e devolve
   o ticket que *seria* criado, com avisos. Reaproveita
   `src/lib/integrations/mapping.ts`, que é puro e já tem 22 testes — o motor testado é o
   mesmo que roda em produção.
5. Cada alteração cria versão nova; rollback restaura o snapshot inteiro em uma transação.
6. Alterações são auditadas por trigger em `audit_log` (já configurado para
   `integrations` e `integration_mappings`).
7. Somente `admin` edita integração. Integração é caminho de escrita em massa no banco.
8. Endpoint precisa ser HTTPS e não pode apontar para rede interna
   (`localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`) — senão o
   campo se torna um SSRF operado pela própria UI.

### Fluxo de Usuário
1. `/integracoes/[id]` ganha aba **Configuração**: endpoint, polling, autenticação,
   janela de eco, intervalo de polling.
2. **Testar conexão** exibe status HTTP e latência.
3. Aba **Mapeamento**: tabela editável com origem, destino, transformação e mapa de
   valores; adicionar, editar e remover linhas.
4. Validação em tempo real avisa se um campo obrigatório ficou sem origem.
5. **Testar mapeamento**: cola um payload (ou usa o último evento recebido) → mostra o
   ticket resultante e os avisos, sem gravar.
6. Aba **Versões**: lista com autor, data e nota; **Restaurar** com confirmação.
7. **Rotacionar credencial**: informa o novo nome do secret, testa, promove.

### Endpoints de API
Server Actions em `src/app/(app)/integracoes/config-actions.ts`:
`updateIntegrationEndpoint`, `rotateIntegrationSecret`, `testIntegrationConnection`,
`upsertFieldMapping`, `deleteFieldMapping`, `dryRunMapping`, `restoreMappingVersion`.

### Dependências
- **Depende de:** `integrations`, `integration_mappings`, `mapping.ts` (existentes).
- **Habilita:** autonomia operacional; pré-requisito para o webhook de monitoração do
  Módulo 8, que usa a mesma tela de configuração.

### Critérios de Aceite
- [ ] Editar endpoint, autenticação e parâmetros sem recriar a integração.
- [ ] Endpoint não-HTTPS ou apontando para rede interna é recusado.
- [ ] Rotação de credencial só promove após teste bem-sucedido.
- [ ] Adicionar, editar e remover mapeamento pela UI.
- [ ] Campo obrigatório sem origem impede salvar, com mensagem que diz qual.
- [ ] Dry run mostra o ticket resultante e **não grava nada**.
- [ ] Cada alteração gera versão; restaurar volta o conjunto inteiro.
- [ ] Log de alterações mostra autor, o que mudou e quando.
- [ ] Integração pausada não processa evento, mas o registra.
- [ ] Somente `admin` acessa a aba de configuração.

### Lacunas e Decisões Pendentes
- **[DECISÃO PENDENTE]** OAuth 2.0 com o Bitrix24 exige app registrado e fluxo de
  refresh. Hoje usamos webhook com token, que não expira. Migrar para OAuth só se houver
  exigência — o token é mais simples e mais robusto para integração interna.
- **[LACUNA]** Dry run "usando o último evento recebido" precisa que o payload esteja em
  `integration_events.payload` — está, mas pode conter dado sensível; a tela deve
  respeitar a mesma regra de [LG-01](#lacunas-globais-e-decisões-pendentes).

---

## MÓDULO 11 — Mapas em Tickets, Telefonia, Links e Inventário

### Status
- [x] Novo | [ ] Melhoria sobre existente

### Descrição
Camada de visualização geográfica das quatro telas, com marcador por filial, contagem,
semáforo e detalhamento por área no popup. É o módulo mais visível e o **mais dependente**
— não funciona sem o Módulo 2, e o mapa de links não existe sem o Módulo 8.

### Modelagem de Dados

**Alterações em `branches`** — hoje há endereço textual, mas **nenhuma coordenada**:

| Campo | Tipo | Observação |
|---|---|---|
| `latitude` | `numeric(9,6)` | CHECK entre -90 e 90 |
| `longitude` | `numeric(9,6)` | CHECK entre -180 e 180 |
| `geocoded_at` | `timestamptz` | Quando as coordenadas foram obtidas |
| `geocode_source` | `text` | CHECK `('manual','nominatim','google','mapbox')` — saber a procedência importa para corrigir |

```sql
create index idx_branches_geo on public.branches (tenant_id)
  where latitude is not null and longitude is not null and deleted_at is null;
```

**Views de agregação — uma por domínio**, todas com `security_invoker = true` para que o
mapa mostre apenas o que o usuário pode ver:

| View | Conteúdo |
|---|---|
| `vw_map_tickets` | Por filial: abertos, em andamento, críticos, com SLA estourado, coordenadas, semáforo |
| `vw_map_telecom` | Por filial: linhas ativas, suspensas, canceladas, custo, semáforo |
| `vw_map_internet` | Por filial: links ativos, quantos `down`, não monitorados, custo, semáforo |
| `vw_map_assets` | Por filial: total, em uso, em manutenção, **sem responsável**, semáforo |
| `vw_map_area_breakdown` | Por filial **e área**, para o popup: ativos, linhas e links |

> **Tickets não entram no detalhamento por área.** `tickets` tem `branch_id`, mas
> **não tem dimensão de área** — e o escopo não pediu para adicionar. O popup do mapa de
> tickets mostra o total da filial; o de inventário, telefonia e links detalha por área.
> Ver [LG-13](#lg-13--tickets-não-têm-dimensão-de-área).

O semáforo é calculado **na view**, não no cliente: a mesma regra vale para mapa, painel e
exportação, e não há chance de a UI discordar do relatório.

### Regras de Negócio
1. Filial sem coordenada **não aparece no mapa** e entra numa lista lateral
   "filiais sem localização" — sumir sem aviso faria o gestor acreditar que o mapa está
   completo.
2. Semáforo por domínio, conforme o escopo:
   - **Tickets:** vermelho se há crítico em aberto ou SLA estourado; amarelo se há SLA em
     risco; verde caso contrário.
   - **Telefonia:** vermelho se há linha suspensa/cancelada recente; verde se todas ativas.
   - **Links:** vermelho se algum link `down`; amarelo se algum `unknown`/não monitorado;
     verde se todos `up`.
   - **Inventário:** vermelho se há ativo ativo sem responsável; amarelo se há em
     manutenção; verde caso contrário.
3. Tamanho do marcador é proporcional à contagem, com **badge numérico** — área de
   círculo sozinha é péssima para comparação quantitativa; o número resolve.
4. Filtros da tela e do mapa são **os mesmos**: filtrar operadora atualiza os dois.
5. Popup detalha por área (Módulo 2) e limita a 10 áreas, com "ver todas" levando à
   listagem filtrada.
6. Escopo por papel: gestor/admin veem todas as filiais do tenant; atendente vê apenas as
   suas — herdado da RLS, sem regra nova no mapa.
7. Auto-refresh de 60s configurável. Para tickets, usa Realtime; para os demais, refresh
   temporizado — linha e link não mudam de estado a cada segundo.
8. Heatmap é camada opcional desligada por padrão: com poucas filiais ele engana mais do
   que informa.

### Fluxo de Usuário
1. Cada uma das quatro telas ganha alternador **Lista / Mapa**, preservando os filtros.
2. No mapa, marcadores agrupados por proximidade em zoom baixo (cluster) e separados ao
   aproximar.
3. Clique no marcador → popup com filial, endereço, total e quebra por área.
4. Clique numa área do popup → volta para a lista já filtrada por filial + área.
5. Filial sem coordenada aparece no aviso lateral, com atalho para o cadastro.
6. No portal do cliente, o mapa mostra somente as filiais daquele cliente.

### Endpoints de API
Leitura pelas views em Server Components. Server Actions:
`setBranchCoordinates(branchId, lat, lng)` e `geocodeBranch(branchId)` — a chamada ao
serviço de geocodificação acontece **no servidor**, para não expor chave de API no
navegador.

### Dependências
- **Depende de:** **Módulo 2** (detalhamento por área) e **Módulo 8** (mapa de links);
  coordenadas em `branches`; escolha do provedor de mapas.
- **Habilita:** camada final de visualização; nada depende dele.

### Critérios de Aceite
- [ ] Mapa nas quatro telas, com alternância Lista/Mapa preservando filtros.
- [ ] Marcador com badge numérico e cor conforme a regra de cada domínio.
- [ ] Popup com filial, endereço, total e quebra por área.
- [ ] Clique na área leva à lista filtrada.
- [ ] Filtros da tela refletem no mapa e vice-versa.
- [ ] Filiais sem coordenada listadas explicitamente, não omitidas.
- [ ] Atendente de uma filial vê apenas o seu marcador.
- [ ] Auto-refresh configurável; tickets via Realtime.
- [ ] Mapa carrega em menos de 3s com 50 filiais.
- [ ] Nenhuma chave de API de mapa exposta no bundle do cliente.

### Lacunas e Decisões Pendentes
- **[DECIDIDO — Google Maps]** O operador escolheu **Google Maps**, por precisão de
  localização. Implementado: Maps JavaScript API em `src/components/google-map.tsx` e
  Geocoding API em `src/app/(app)/clientes/geo-actions.ts`, com duas chaves de escopos
  distintos (navegador por referrer, servidor por IP).
  **Consequência de custo a acompanhar:** a Maps JS API cobra por carregamento de mapa. Num
  painel com auto-refresh de 60s aberto o dia inteiro, isso é custo recorrente — por isso o
  refresh do mapa recarrega **dados**, não o mapa, e o painel de TV não embarca mapa.
  Convém configurar alerta de cota no console do Google.
- **[RESOLVIDO]** Geocodificação: os dois caminhos existem. O gestor cola a URL do Google
  Maps (mais exato — quem cola está olhando o prédio), ou geocodifica pelo endereço
  cadastrado. `geocode_source` registra a origem e `geocode_precision` guarda o
  `location_type` devolvido pelo Google, para que "centro da cidade" não se confunda com
  "porta da filial" (migração `0014`).
- **[LACUNA]** "Portal do fornecedor" e "portal do cliente" aparecem no escopo do mapa,
  mas **portal do cliente não existe** na plataforma — hoje há um único app com papéis.
  Isso é escopo de módulo novo, bem maior que o mapa. Ver
  [LG-08](#lacunas-globais-e-decisões-pendentes).

---

## CRONOGRAMA SUGERIDO DE IMPLEMENTAÇÃO

| Ordem | Módulo | Dependência | Prioridade | Complexidade |
|---|---|---|---|---|
| 1 | **M1** — SLA e Filas editáveis | — | Crítica | Média |
| 2 | **M2** — Área da Filial | — | **Crítica (bloqueante)** | Baixa |
| 3 | **M3** — Anexos de Inventário (NF + Foto) | M2, Storage | Alta | Média |
| 4 | **M4** — Histórico de Responsável | M2 | Alta | Baixa |
| 5 | **M5** — Anexos em Tickets | Storage, **LG-01** | Alta | Média-Alta |
| 6 | **M9** — Área na Telefonia | **M2** | Média | Baixa |
| 7 | **M6** — Filtros e Dashboard de Telefonia | M9, M7 | Média | Média |
| 8 | **M7** — Anexo de Contrato da Linha | M3 (padrão) | Média | Baixa |
| 9 | **M8** — Links de Internet | M2, M3, **LG-07** | Alta | **Alta** |
| 10 | **M10** — Edição de Integrações | — | Média | Média |
| 11 | **M11** — Mapas | **M2, M8**, decisão de provedor | Média | **Alta** |

**Três ajustes em relação à ordem do escopo, com motivo:**

1. **M2 antes de M1.** O escopo põe SLA primeiro. M2 é pré-requisito de M6, M8, M9 e M11
   — quatro módulos — e é de baixa complexidade. Subir M2 para o primeiro lote destrava a
   frente inteira. M1 e M2 são independentes e podem correr em paralelo.
2. **M9 antes de M6.** O escopo os agrupa, mas o filtro por área (M6) não existe sem o
   campo de área (M9). Separar evita retrabalho na tela de filtros.
3. **M8 é o de maior risco**, não o penúltimo item de uma lista. É módulo novo completo,
   com integração externa dependente de decisão pendente (Zabbix). Se a resposta sobre o
   Zabbix demorar, recomendo entregar M8 sem monitoração e adicionar a camada depois —
   o cadastro e o custo já entregam valor sozinhos.

**Sequenciamento em lotes**, respeitando dependências:

- **Lote A** (paralelo): M1 · M2
- **Lote B** (paralelo, depende de A): M3 · M4 · M9 · M10
- **Lote C** (depende de B): M5 · M6 · M7
- **Lote D** (depende de B e C): M8
- **Lote E** (depende de D): M11

---

## INTEGRAÇÃO ENTRE MÓDULOS

### O eixo estrutural: Área da Filial → Inventário/Telefonia/Links → Mapas

```
                    ┌──────────────┐
                    │   branches   │  + latitude/longitude (M11)
                    └──────┬───────┘
                           │ 1:N
                    ┌──────▼───────┐
                    │ branch_areas │  ◀── M2: a peça que destrava tudo
                    └──────┬───────┘
             ┌─────────────┼─────────────┐
             │             │             │
    ┌────────▼──────┐ ┌────▼─────────┐ ┌▼──────────────┐
    │  it_assets    │ │telecom_lines │ │internet_links │
    │ branch_area_id│ │company_area_id│ │branch_area_id│
    │      (M2)     │ │     (M9)      │ │     (M8)     │
    └────────┬──────┘ └────┬─────────┘ └┬──────────────┘
             │             │             │
             └─────────────┼─────────────┘
                           │  agregação por (filial, área)
                    ┌──────▼──────────────────┐
                    │ vw_map_area_breakdown   │  ◀── M11: popup do marcador
                    └─────────────────────────┘
```

Sem `branch_areas`, o popup do mapa consegue mostrar apenas o total da filial — o
detalhamento por área que o escopo pede simplesmente não tem de onde sair. É por isso que
M2 sobe no cronograma.

### O padrão de anexos, reutilizado três vezes

M3 (ativos) define o padrão que M7 (linhas) e M8 (links) repetem: tabela própria por
entidade com FK composta, `category`/`kind`, bucket privado com caminho
`{tenant_id}/{entity_id}/`, URL assinada de vida curta e policies de Storage derivando o
tenant do primeiro segmento do caminho.

Implementar M3 primeiro não é ordem arbitrária: é onde o padrão é definido, testado e
onde as policies de Storage nascem. M7 e M8 passam a ser aplicação do padrão, não
decisão nova.

### O que a auditoria já resolve

`audit_log` cobre por trigger 18 tabelas, incluindo `sla_definitions`, `queues`,
`integrations` e `integration_mappings`. Os requisitos de "histórico de alterações" de M1
e M10 são, portanto, **de interface** — precisam de tela lendo `audit_log`, não de
modelagem nova. Isso reduz o custo real desses dois módulos em relação ao que o escopo
sugere.

### Filtros compartilhados entre lista, dashboard e mapa

M6 (telefonia), M8 (links) e M11 (mapas) leem os **mesmos** `searchParams`. O contrato de
filtro precisa ser definido uma vez, em módulo compartilhado
(`src/lib/filters/`), e consumido pelas três camadas. Se cada tela interpretar o filtro
por conta, mapa e tabela vão divergir — e o gestor vai confiar no número errado.

### Onde o motor existente é reaproveitado

| Necessidade nova | Reaproveita |
|---|---|
| Dry run de mapeamento (M10) | `src/lib/integrations/mapping.ts` — puro, 22 testes |
| Webhook do Zabbix (M8) | Padrão de idempotência do `integration-webhook` |
| Semáforo do mapa (M11) | `app.sla_state()` e o score de fila |
| Histórico de custódia (M4) | `asset_assignments` + trigger existente |
| Alerta de vencimento (M7, M8) | Nenhum — ver LG-06 |

---

## LACUNAS GLOBAIS E DECISÕES PENDENTES

Ordenadas por risco. As três primeiras merecem resposta antes de a implementação avançar
nos módulos correspondentes.

### LG-01 — Dado sensível de saúde em anexos (LGPD art. 11) — **risco alto**
Anexo de ticket em operação Home Care vai conter, na prática, print de prontuário, foto de
tela com nome de paciente e áudio de atendimento. Isso é **dado pessoal sensível**, e o
regime jurídico é mais rigoroso que o de dado comum.

O que falta decidir:
- Anexos podem conter dado de paciente, ou haverá **proibição explícita** com aviso na UI?
- Prazo de retenção e expurgo automático.
- Registro de **quem visualizou** cada anexo (hoje registramos quem anexou, não quem leu).
- Criptografia em repouso além da padrão do Storage.

**Recomendação:** aviso obrigatório no upload, log de acesso a anexo, retenção definida
com expurgo automático. Enquanto não houver decisão, M5 pode ser implementado com os
controles técnicos prontos e a política aplicada por configuração.

### LG-02 — Migração de dados para campos obrigatórios — **risco médio**
M2 e M9 tornam a área obrigatória, mas há ativos e linhas já cadastrados sem ela. Quem
atribui a área do que já existe? Sem plano de migração, a obrigatoriedade não pode ser
imposta no banco (`SET NOT NULL`) e fica só na UI — o que significa que a integração e a
importação em massa continuam criando registro sem área.
**Recomendação:** tela de conciliação em lote (filtrar sem área → atribuir em massa) antes
de aplicar `SET NOT NULL`.

### LG-03 — Antivírus em upload — **risco médio**
O escopo diz "se aplicável". O Supabase Storage **não faz varredura nativa**. Opções:
Edge Function chamando serviço externo, ou aceitar o risco restringindo tipos MIME.
Enquanto não decidido, `scan_status` fica `'skipped'` e a coluna já está prevista, para não
exigir migração depois.

### LG-04 — Série histórica de custo — **risco médio**
`telecom_lines.monthly_cost` e `internet_links.monthly_cost` são valores **atuais**. Não há
como reconstruir "evolução de custo mensal" retroativamente. Exige tabela de snapshot
mensal (`telecom_cost_snapshots`) alimentada por job. Sem ela, o gráfico de evolução
mostra apenas projeção do custo vigente — e precisa ser rotulado assim, para não ser lido
como histórico real.

### LG-05 — Desempate customizado de fila — **risco médio**
`tiebreaker='custom'` com expressão livre é injeção de SQL e risco de query impagável.
**Recomendação:** catálogo fechado de critérios. Confirmar se atende.

### LG-06 — Canal de notificação — **risco médio, afeta 4 módulos**
M1 (breach de SLA), M7 (vencimento de contrato), M8 (link fora do ar) e M4 (ativo sem
responsável) todos pedem alerta. **A plataforma não tem camada de notificação** — nem
e-mail, nem push, nem webhook de saída. Hoje os estados são calculados e exibidos, mas não
notificam fora da tela.
Isso é **módulo transversal não previsto no escopo**. Decidir: e-mail (provedor?),
WhatsApp, Telegram, webhook? Sem essa decisão, os quatro módulos entregam o indicador
visual e não o alerta ativo.

### LG-07 — Integração com Zabbix — **risco médio, bloqueia parte do M8**
Não sabemos se existe Zabbix, qual versão, se é acessível pela rede do SaaS, e se o
disparo será webhook (preferível, event-driven, alinhado ao
[RF-INT-07](01-requisitos.md#27-integrações-rf-int)) ou polling.
**Recomendação:** entregar M8 sem monitoração no primeiro corte. Cadastro, contrato e
custo já entregam valor; a camada de disponibilidade entra depois sem retrabalho, porque
os campos e a tabela de eventos já estão modelados.

### LG-08 — Portal do cliente — **risco alto de escopo**
M11 menciona "portal do fornecedor" e "portal do cliente" com mapas distintos. **O portal
do cliente não existe.** Hoje há um app único com seis papéis; o solicitante enxerga
apenas os próprios tickets, mas não há área segregada com identidade visual do cliente,
domínio próprio ou catálogo de serviços.
Construir isso é **módulo maior que os 11 deste roadmap somados**. Precisa ser tratado
como iniciativa separada, não como característica do mapa.

### LG-09 — Provedor de mapas — **RESOLVIDO: Google Maps**
Decidido pelo operador. Implementado com duas chaves e degradação explícita quando ausentes.
No app, `/mapas` é a Maps JavaScript API com tiles do Google, busca por filial, lista lateral
de localizações e popup com quebra por área. Na ferramenta navegável (`demo/sti-tool.html`) o
mapa é **vetorial embutido** — geometria das 27 UFs (IBGE, simplificada a ~6 km por
Douglas–Peucker, ~30 KB) projetada em **Mercator**, a mesma projeção dos tiles do Google, para
que marcador e fronteira não divirjam entre as duas telas. Ele arrasta, dá zoom e agrupa
marcadores; o que não faz é buscar *tile* de imagem, porque a página publicada é autocontida e
o CSP dela bloqueia host externo.
Resta acompanhar **custo por carregamento** e configurar alerta de cota.

### LG-10 — Pausa de clock configurável por SLA
Ver Módulo 1. Hoje a pausa é comportamento de status, não configuração. Se o requisito é
torná-la configurável por contrato, muda o modelo de `sla_definitions`.

### LG-11 — Exportação PDF/Excel — decisão técnica transversal
M4, M6, M7 e M8 pedem exportação. Não existe hoje. Decidir a abordagem: geração no
servidor (Edge Function com biblioteca) ou no cliente. Recomendo **no servidor**, para que
o arquivo respeite exatamente o escopo de RLS do usuário e não dependa do que o navegador
carregou.

### LG-13 — Tickets não têm dimensão de área
`tickets` referencia `branch_id`, não área. Consequência: o popup do mapa de tickets
mostra apenas o total da filial, enquanto inventário, telefonia e links detalham por área.
Três caminhos:
1. **Não fazer nada** — o mapa de tickets agrega por filial (implementado assim hoje).
2. **Derivar do ativo vinculado** (`ticket_assets`) — funciona só para ticket com ativo,
   e um ticket pode ter vários ativos em áreas diferentes.
3. **Adicionar `branch_area_id` em `tickets`** — dá a informação com precisão, ao custo de
   mais um campo obrigatório na abertura, o que atrita com quem abre chamado pelo celular.

Recomendo (1) até haver demanda concreta; (3) é o caminho se a análise por área do
atendimento passar a ser exigida.

### LG-14 — Motivo da custódia via variável de sessão
O motivo da mudança de responsável chega ao trigger por
`set_config('app.custody_reason', …)`. Funciona e está testado, mas é um contrato
implícito: quem esquecer de definir a variável grava `reason = 'outro'`, e o trigger
apenas infere `devolucao`/`realocacao` pelo que mudou. Está encapsulado numa única Server
Action (`changeAssetCustody`) exatamente para que ninguém precise lembrar — mas escrita
por importação em massa ou SQL direto continua caindo no inferido. Aceitável; registrado
para não surpreender.

### LG-12 — Renomeação `assigned_user_id` → `assigned_to`
O escopo usa `assigned_to`; a base tem `assigned_user_id`. **Recomendo manter o nome
atual** — a renomeação atinge FK composta, três índices, policies de RLS, views e Server
Actions, sem ganho funcional. Confirmar que o nome do escopo era descritivo, não
normativo.

---

## Módulo 12 — Geolocalização a partir do endereço cadastrado

**Status:** implementado (banco, fluxo, interface e testes).

**Descrição.** O mapa deixa de depender de coordenada digitada e passa a derivar
do endereço do cadastro. Os quatro campos exigidos são **logradouro, número,
bairro e CEP**; sem eles o fluxo não avança e não desenha mapa.

**Modelagem de dados.** `branches` ganhou `street`, `street_number`,
`address_complement`, `address_complete` (coluna gerada), `geocode_status`,
`geocode_stale`, `geocode_verified_at`, `geocode_provider`, e um CHECK que só
aceita CEP no formato `99999-999`. `geocode_logs` é o rastro append-only de cada
tentativa (endereço submetido, status, provedor, coordenada, precisão,
candidatos, mensagem e o bloco técnico exibido). `geocode_candidates` guarda as
correspondências múltiplas até alguém confirmar. `fn_format_address` monta o
endereço em uma linha para as views e para a interface.

**Regras de negócio.**

1. Campos obrigatórios ausentes → `[CAMPO AUSENTE]`, sem chamar o provedor.
2. CEP divergente de cidade/UF/logradouro/bairro → `[INCONSISTÊNCIA DE ENDEREÇO]`,
   sem chamar o provedor. A comparação normaliza acento, caixa e abreviação de
   tipo de logradouro — senão todo cadastro com "Av." seria acusado.
3. Nenhum resultado → `[ENDEREÇO NÃO ENCONTRADO]`; o mapa não é desenhado.
4. Empate na maior precisão → `[MÚLTIPLAS CORRESPONDÊNCIAS]`; a escolha é do
   operador. Quando um resultado é mais preciso que os outros, ele vence e a
   escolha fica registrada.
5. Precisão abaixo de *rooftop* → `[BAIXA PRECISÃO]`: renderiza com aviso.
6. Chave ausente, cota estourada ou provedor fora do ar →
   `[SERVIÇO INDISPONÍVEL]`, com os requisitos mínimos listados. Nunca vira
   "endereço não encontrado", que faria o operador corrigir cadastro correto.
7. **Nenhuma coordenada é interpolada.** Falha não apaga a coordenada anterior:
   ela continua no mapa, marcada como desatualizada.
8. Alterar qualquer campo de endereço sem gravar coordenada nova marca
   `geocode_stale` — o pino antigo não passa por atual.

**Fluxo de usuário.** `/mapas` → cartão da filial → preencher endereço → salvar →
*Geolocalizar pelo endereço* → confirmar candidato, se houver → mapa em satélite
com marcador e popup → *Ver saída técnica* para o bloco registrado no log.

**Renderização.** Camada `hybrid` (satélite com rótulos) por padrão, alternância
satélite/mapa no controle do Google, zoom por precisão dentro da faixa 16–18
(rooftop/manual 18, interpolado 17, demais 16).

**Tempo real.** `RealtimeRefresh` observa `public.branches`: alteração de
endereço ou coordenada em qualquer sessão redesenha a tela. As consultas do
provedor usam `cache: 'no-store'`.

**Critérios de aceite.** Cobertos por 35 testes unitários (`src/lib/address.test.ts`)
e pelas asserções da seção 21 de `supabase/tests/schema_test.sql`.

**Lacunas.** A consulta de CEP usa o ViaCEP por padrão (`CEP_LOOKUP_URL`); em
produção convém contratar base com SLA. A confirmação de candidato não registra
quem confirmou além do log da tentativa. Geocodificação em lote para carga
inicial ainda não existe.
