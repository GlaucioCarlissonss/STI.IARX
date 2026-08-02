# 05 — Integração com Bitrix24

Guia completo: o que a API do Bitrix24 oferece, as armadilhas que descobrimos ao
estudá-la, o mapeamento de campos e o passo a passo de configuração.

## 1. O que foi verificado na API

| Assunto | Conclusão |
|---|---|
| **Incoming webhook** | URL no formato `https://SEU.bitrix24.com.br/rest/<user-id>/<segredo>/<metodo>.json`. O segredo faz parte da URL — ela **é** a credencial. Não expira. |
| **Outgoing webhook** | Configurado em *Recursos do desenvolvedor → Webhook de saída*. Dispara `POST` para uma URL sua quando o evento ocorre. O Bitrix24 gera um `application_token` para você verificar a origem. |
| **Eventos de tarefa** | `ONTASKADD`, `ONTASKUPDATE`, `ONTASKDELETE`. |
| **Formato do POST** | `application/x-www-form-urlencoded` com notação PHP de colchetes (`data[FIELDS_AFTER][ID]=42`) — **não é JSON**. |
| **`STATUS`** | `2` pendente · `3` em execução · `4` aguardando controle · `5` concluída · `6` adiada · `7` recusada |
| **`PRIORITY`** | `0` baixa · `1` média · `2` alta |
| **Datas** | ISO 8601 com offset do portal. Endpoints legados podem devolver `dd.mm.yyyy hh:mm:ss`. |
| **Maiúsculas vs camelCase** | `tasks.task.add` recebe `TITLE`, `RESPONSIBLE_ID`; `tasks.task.get` devolve `title`, `responsibleId`. **A mesma entidade, dois nomes.** |

### 1.1 A armadilha principal

> **O webhook `ONTASKUPDATE` não envia os campos alterados.**

O payload traz apenas o ID:

```json
{
  "event": "ONTASKUPDATE",
  "data": {
    "FIELDS_BEFORE": { "ID": 123 },
    "FIELDS_AFTER":  { "ID": 123 }
  },
  "ts": "1466439714",
  "auth": { "application_token": "51856fefc120afa4b628cc82d3935cce", "domain": "…" }
}
```

Ou seja: o webhook é uma **notificação**, não uma entrega de dados. Uma
integração escrita presumindo que `FIELDS_AFTER` contém a tarefa vai gravar
tickets vazios — e só se descobre isso em produção.

**Consequência de arquitetura.** O handler é obrigatoriamente de duas etapas:

```
Bitrix24 --(ONTASKUPDATE, só o ID)--> Edge Function
Edge Function --(tasks.task.get)--> Bitrix24
Edge Function <--(tarefa completa)-- Bitrix24
Edge Function --> upsert do ticket
```

Isso torna o **incoming webhook obrigatório mesmo para a direção
Bitrix24 → SaaS**, o que não é óbvio ao ler o escopo. Está implementado em
`supabase/functions/bitrix24-webhook/index.ts` (etapa 4).

Efeito colateral positivo: como sempre lemos o estado atual da tarefa, eventos
fora de ordem não corrompem o ticket — o último a processar escreve o estado
mais recente, não um delta antigo.

### 1.2 Outras diferenças que exigiram tratamento

- **Identificação de pessoas.** O Bitrix24 usa IDs internos (`RESPONSIBLE_ID: 7`),
  que não significam nada no nosso banco. Resolvemos via `user.get` → e-mail →
  `profiles.email`. É o único identificador comum aos dois sistemas.
- **Descrição com marcação.** Vem com BBCode (`[B]…[/B]`) ou HTML conforme a
  origem da tarefa. O transform `html_to_text` limpa antes de gravar.
- **`DEADLINE` não é SLA.** O prazo do ticket vem da nossa política de SLA
  (ADR-004), não do campo do Bitrix24 — senão o SLA contratado com o cliente
  passaria a ser definido por quem criou a tarefa.

## 2. Mapeamento de campos

Cadastrado em `integration_mappings`, editável pela UI em `/integracoes/[id]`
sem deploy.

| Bitrix24 | Ticket | Transform | Observação |
|---|---|---|---|
| `TITLE` | `title` | `direct` | obrigatório |
| `DESCRIPTION` | `description` | `html_to_text` | remove HTML/BBCode |
| `CREATED_DATE` | `created_at` | `datetime` | normalizado para UTC |
| `CHANGED_DATE` | — | — | usado só para ordenação de eventos |
| `STATUS` | `status` | `value_map` | `2→open, 3→in_progress, 4→waiting_third_party, 5→resolved, 6→waiting_requester, 7→closed` |
| `PRIORITY` | `priority_key` | `value_map` | `2→high, 1→medium, 0→low` |
| `RESPONSIBLE_ID` | `assignee_id` | `user_by_external_id` | casado por e-mail |
| `CREATED_BY` | `requester_id` | `user_by_external_id` | casado por e-mail |
| `GROUP_ID` | `queue_id` | `queue_by_external_id` | via `config.group_to_queue_slug` |
| `TAGS` | `tags` | `direct` | array preservado |
| `DEADLINE` | — | `datetime` | registrado, mas o prazo real vem do SLA |
| `ID` | `external_id` | — | com `source_system = 'bitrix24'` |

**Sobre o mapeamento de status.** `4` ("aguardando controle") vira
`waiting_third_party` e `6` ("adiada") vira `waiting_requester` — ambos **pausam
o relógio de SLA**. É uma decisão de negócio, não uma equivalência literal:
tarefa parada aguardando terceiro não deve consumir o SLA da nossa equipe.
Se o cliente discordar, é uma linha em `integration_mappings.value_map`.

**Valor desconhecido não derruba a integração.** Se o Bitrix24 passar a enviar
um status novo, o ticket é criado sem aquele campo e o aviso fica registrado em
`integration_events.last_error` — visível na UI. Derrubar o processamento inteiro
por um valor a mais seria pior.

## 3. Configuração passo a passo

### Passo 1 — Incoming webhook (Bitrix24 → permite que chamemos a API)

1. No Bitrix24: **Aplicativos → Recursos do desenvolvedor → Outros → Webhook de entrada**.
2. Permissões necessárias: `task` (Tarefas) e `user` (Usuários).
   > `user` é indispensável: sem ela não conseguimos resolver `RESPONSIBLE_ID`
   > em e-mail, e todo ticket chega sem atendente.
3. Salve e copie a URL gerada:
   `https://SEU.bitrix24.com.br/rest/1/abc123secreto/`
4. Registre-a como **secret da Edge Function** — nunca no banco (ADR-009):

```bash
supabase secrets set BITRIX24_INBOUND_WEBHOOK_URL="https://SEU.bitrix24.com.br/rest/1/abc123secreto/"
```

5. No banco, `integrations.secret_ref` guarda apenas o **nome** da variável:

```sql
update public.integrations
   set secret_ref = 'BITRIX24_INBOUND_WEBHOOK_URL'
 where slug = 'bitrix24-tarefas';
```

### Passo 2 — Outgoing webhook (Bitrix24 → nos notifica)

1. **Aplicativos → Recursos do desenvolvedor → Outros → Webhook de saída**.
2. Eventos: marque `ONTASKADD` e `ONTASKUPDATE`.
3. URL do handler:

```
https://SEU-PROJETO.supabase.co/functions/v1/bitrix24-webhook?integracao=bitrix24-tarefas
```

4. Copie o **Token do aplicativo** gerado.
5. Registre-o em `/integracoes/[id]` → *Token de verificação*. Apenas o SHA-256
   é gravado; o valor em claro não é persistido em lugar nenhum do banco.

### Passo 3 — Deploy da Edge Function

```bash
supabase functions deploy bitrix24-webhook --no-verify-jwt
```

> `--no-verify-jwt` é necessário e **seguro aqui**: o Bitrix24 não envia um JWT
> do Supabase. A autenticação da rota é o `application_token`, verificado por
> comparação de hash em tempo constante. Sem essa flag, o Supabase rejeitaria
> todas as chamadas antes de o nosso código rodar.

### Passo 4 — Ativar e testar

```sql
update public.integrations set status = 'active' where slug = 'bitrix24-tarefas';
```

Teste sem depender do Bitrix24 — este payload reproduz o formato real:

```bash
curl -X POST \
  "https://SEU-PROJETO.supabase.co/functions/v1/bitrix24-webhook?integracao=bitrix24-tarefas" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "event=ONTASKADD" \
  --data-urlencode "data[FIELDS_AFTER][ID]=1042" \
  --data-urlencode "ts=1770000000" \
  --data-urlencode "auth[application_token]=SEU_TOKEN"
```

Respostas esperadas:

| Situação | HTTP | Corpo |
|---|---|---|
| Processado | 200 | `{"status":"processed","ticket_id":"…"}` |
| Reentrega do mesmo evento | 200 | `{"status":"duplicate"}` |
| Eco da nossa própria escrita | 200 | `{"status":"skipped_echo"}` |
| Token errado | 401 | `{"error":"Não autorizado"}` |
| Integração pausada | 202 | `{"status":"paused"}` |
| Bitrix24 fora do ar | 502 | `{"error":"Não foi possível obter a tarefa …"}` |

> **Duplicata responde 200, não erro.** Um 4xx/5xx faria o Bitrix24 reenviar
> indefinidamente algo que já foi processado (ADR-010).

Acompanhe tudo em `/integracoes/[id]`: eventos, tentativas, erros e log de
requisições com duração.

## 4. Sincronização reversa (opcional)

Desligada por padrão (lacuna L-06). Quando ativada, uma alteração no SaaS chama
`tasks.task.update` no Bitrix24.

**O risco:** o Bitrix24 dispara `ONTASKUPDATE` por causa da nossa própria
escrita, nós reaplicamos, ele notifica de novo — laço infinito (antipattern A-05).

**As duas defesas (ADR-008):**

1. **Origem da mudança.** Toda escrita grava `tickets.change_source`. Só
   `ui` e `api` disparam sincronização reversa; `integration` nunca.
2. **Hash + janela de tempo.** Ao enviar, gravamos o hash do payload em
   `integration_sync_state.last_outbound_hash`. Um webhook que chegue com hash
   idêntico dentro de `echo_window_seconds` (padrão 120s) é descartado como eco
   e registrado com `outcome = 'skipped_echo'` — descartado, mas auditável.

Para ativar: `/integracoes` → *Ligar sync reversa*.

## 5. Limitações conhecidas

| Limitação | Efeito | Mitigação |
|---|---|---|
| Rate limit do Bitrix24 (~2 req/s por portal) | Rajada de tarefas pode receber 503 | Retry com backoff 1s/2s/4s; falha final fica em `integration_events` para reprocessar |
| `tasks.task.get` por evento | 1 chamada extra por webhook | Inevitável — o webhook não traz os campos (§1.1) |
| Comentários da tarefa | Não sincronizados na v1 | Exigiria `task.commentitem.*` e um modelo de autoria entre sistemas |
| Anexos | Não sincronizados | Exigiria baixar do Bitrix24 Drive e reenviar ao Supabase Storage |
| Usuário sem e-mail no Bitrix24 | Ticket chega sem atendente/solicitante | Aviso registrado no evento; o ticket é criado mesmo assim |
| `ONTASKDELETE` | Não tratado | Exclusão no Bitrix24 não deveria apagar histórico de atendimento (antipattern A-09) |

## 6. Adicionando outra integração

O Bitrix24 tem handler próprio só por causa da chamada de volta. Para uma origem
que já envie os dados no payload, **não é preciso escrever código**:

1. Insira a linha em `integrations` com `source_system` próprio.
2. Cadastre os `integration_mappings`.
3. Aponte o webhook da origem para:
   `/functions/v1/integration-webhook?integracao=<slug>`
4. Registre o token em `/integracoes/[id]`.

Caminhos configuráveis em `integrations.config`: `external_id_path`,
`event_path`, `timestamp_path`, `default_queue_slug`, `default_priority_key`.

## Fontes

- [Bitrix24 REST API — Tasks](https://apidocs.bitrix24.com/api-reference/tasks/index.html)
- [tasks.task.add](https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-add.html)
- [Evento OnTaskAdd](https://apidocs.bitrix24.com/api-reference/tasks/events-tasks/on-task-add.html)
- [Evento OnTaskUpdate](https://apidocs.bitrix24.com/api-reference/tasks/events-tasks/on-task-update.html)
- [Webhooks de entrada e saída](https://apidocs.bitrix24.com/local-integrations/local-webhooks.html)
- [Manipuladores de evento](https://apidocs.bitrix24.com/api-reference/events/index.html)
