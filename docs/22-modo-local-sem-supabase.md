# 22 — Modo local: a aplicação sem Supabase

**Status:** implementado (`src/lib/db/`, migração 0045).
**Depende de você:** um PostgreSQL 16 acessível. Nada de conta, nada de chave.

> Esta é a entrega que destravou todas as outras. Até aqui, toda tela
> autenticada deste repositório tinha o mesmo item em "o que não foi
> verificado": *nunca foi aberta com dado real*. Não era preguiça — era que não
> havia Supabase alcançável no ambiente, e **fingir uma sessão testaria o dublê,
> não o sistema**.

---

## 1. O que foi feito, em uma frase

A aplicação passou a falar com um PostgreSQL direto, e o cliente do Supabase
virou uma das duas implementações possíveis de uma mesma forma.

```
                     ┌─────────────────────────┐
   lib/supabase/* ───┤  NEXT_PUBLIC_SUPABASE…  │──► @supabase/ssr ──► PostgREST
   (4 fábricas)      │  configurado?           │
                     └─────────────────────────┘
                                 │ não, e há DATABASE_URL
                                 ▼
                           lib/db/cliente.ts ──► pg ──► PostgreSQL
```

Nenhuma das 333 chamadas de `.select()` mudou. A troca acontece nas quatro
fábricas (`server`, `admin`, `anon`, `client`) e no `proxy.ts`.

---

## 2. A decisão que sustenta tudo: o RLS continua valendo

Cada consulta roda **numa transação própria**, com:

```sql
set local role <anon | authenticated | service_role>;
select set_config('request.jwt.claims', '<claims>', true);
```

É literalmente o que o PostgREST faz. As policies são as mesmas, `auth.uid()` e
`app.current_tenant_id()` leem o mesmo GUC, e a negação se comporta igual: zero
linhas em leitura e escrita, exceção no `with check` do insert.

**Sem o `set local role`, a conexão seria a do dono do banco — que tem
`BYPASSRLS` — e todo o isolamento entre tenants desapareceria em silêncio.** O
app funcionaria melhor local do que em produção, que é a pior forma de um
ambiente de desenvolvimento mentir.

`set local` (e não `set`) é o que impede vazamento de claims entre requisições
quando a conexão volta para o pool.

---

## 3. As quatro peças que precisaram existir

| Peça | O que resolve |
|---|---|
| `selecao.ts` | Analisa a linguagem de seleção do PostgREST: apelido, aninhamento, dica de constraint, `!inner` |
| `relacoes.ts` | Lê as chaves estrangeiras do banco — é o que decide se um embute vira **objeto** ou **lista** |
| `consulta.ts` | Monta o SQL, sempre com parâmetro, nunca com interpolação de valor |
| `tipos.ts` | Faz o `pg` devolver o que o PostgREST devolveria |

A última foi a mais surpreendente, e está detalhada abaixo.

### Por que `tipos.ts` existe

O PostgREST entrega **JSON**: `numeric` vira número, `timestamptz` vira texto
ISO. O driver `pg` entrega **tipos de JavaScript**: `numeric` vira string (para
não perder precisão) e `timestamptz` vira `Date`.

Três telas quebraram na primeira varredura, com erros que não pareciam ter
relação:

```
TypeError: a.slice is not a function
TypeError: a.split is not a function
TypeError: d.rating.toFixed is not a function
```

É uma causa só. O app foi escrito contra o contrato do PostgREST, e é esse
contrato que o modo local tem de cumprir — espalhar `Number(...)` por 333
consultas faria o driver moldar a aplicação.

`date` fica como texto de propósito: deixar o `pg` convertê-la em `Date` criaria
meia-noite no fuso do servidor, e **uma competência de outubro viraria 30 de
setembro em qualquer fuso a oeste de Greenwich**.

---

## 4. O que o modo local NÃO reproduz

| | Como fica |
|---|---|
| **Tempo real** | Não existe. `RealtimeRefresh` cai para recarga periódica, e diz isso no código. Fingir que entrega faria a tela parecer atualizada quando não está |
| **Policies de `storage.objects`** | O arquivo vai para disco e é servido por uma rota que confere assinatura HMAC. Quem assina é a Server Action, que já conferiu permissão no banco. É a maior diferença da lista |
| **Recuperação de senha por e-mail** | Não há envio. A tela responde igual para e-mail existente e inexistente, como já respondia |
| **JWT** | A sessão é um cookie assinado com HMAC. No Supabase o JWT liga dois processos (GoTrue e PostgREST); aqui só existe um, e quem emite é quem lê |

A senha é conferida no banco, com `crypt()` do pgcrypto: a senha em claro nunca
é comparada em JavaScript, e o hash nunca sai do banco.

---

## 5. Os cinco defeitos que isto encontrou

Nenhum deles era do driver. Todos estavam no produto, e todos exigiam uma
sessão de verdade para aparecer.

### 5.1 Abrir chamado não funcionava para ninguém que não fosse admin

O mais grave, e o mais antigo — está na base desde a migração 0005.

`sla_tracking`, `sla_pauses` e `ticket_history` têm **apenas policy de leitura**,
de propósito: são derivadas, e quem as mantém são triggers. Só que as triggers
não eram `security definer`. Sob `force row level security`, a ausência de
policy de escrita nega o `insert` **independentemente do GRANT de tabela** —
então não é artefato do ambiente local: no Supabase acontece igual.

Somado a isso, a trigger de numeração fazia `update tenants set ticket_seq…`, e
`tenants_update` exige admin. O erro que chegava à tela era *"Este registro está
vinculado a outro cadastro e não pode ser alterado"* — uma frase sobre chave
estrangeira, num caminho que não tem nada a ver com isso.

**Por que 1.029 asserções não pegaram:** todas criavam chamado como dono do
banco, que tem `BYPASSRLS`. A asserção que faltava é a seção 48.

### 5.2 O formulário de cadastro de serviço nunca criou um serviço

`formData.get('id')` devolve `null` quando o campo não existe — e o campo `id`
só existe na edição. O schema exigia string e recusava com *"expected string,
received null"*, numa tela onde a pessoa não deixou nada em branco.

Corrigido na raiz: `emptyToNull` passou a tratar ausente e vazio como a mesma
coisa, que é o que eles significam para um valor opcional.

### 5.3 Serviço sem prioridade derrubava todo pedido

`service_catalog.priority_id` é opcional; `tickets.priority_id` é NOT NULL. A
fila já tinha fallback desde a 0005 — a prioridade não tinha. Agora tem.

### 5.4 A trigger de aprovação gravava onde o usuário só lê

Mesmo padrão de 5.1, introduzido pela 0043.

### 5.5 Embute por coluna não vale para chave composta

A tela do chamado pedia `servico:service_id(...)`, e `(service_id, tenant_id)` é
composta — o padrão desta base (ADR-001). O driver recusou com uma mensagem
clara, e o PostgREST também recusaria. A consulta passou a usar o nome da
constraint.

---

## 6. Como rodar

```bash
# 1. PostgreSQL de pé, na porta 5433
bash scripts/preparar-banco-local.sh

# 2. .env.local
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/sti_iarx_dev
LOCAL_AUTH_SECRET=<qualquer coisa com 16+ caracteres>

# 3. a aplicação
npm run build && npx next start -p 3177

# 4. a verificação
node demo/tests/local/telas.spec.mjs       # 37 telas autenticadas
node demo/tests/local/aprovacao.spec.mjs   # o fluxo de aprovação com 3 pessoas
DATABASE_URL=… npx vitest run src/lib/db   # o driver contra o banco
```

Entre com qualquer e-mail do seed e a senha `desenvolvimento` — o script
imprime a lista.

**O interruptor é a ausência de configuração do Supabase**, nunca uma variável
`MODO=local`. Com `NEXT_PUBLIC_SUPABASE_URL` apontando para um Supabase de
verdade, o modo local não liga de jeito nenhum: uma variável esquecida não pode
fazer a aplicação falar com o banco errado.

---

## 7. O que continua não verificado

- **O caminho do Supabase não foi reexecutado depois desta mudança.** As quatro
  fábricas ganharam um `if`, e o ramo do Supabase não roda aqui. O risco é
  pequeno e real, e some no primeiro ambiente com Supabase de verdade.
- **O driver cobre o que o app usa, não o PostgREST inteiro.** Filtro sobre
  tabela embutida, `count` com `head`, `csv` e `explain` não existem. A asserção
  que protege isso é a suíte de telas: o dia em que alguém escrever uma consulta
  fora do coberto, uma tela quebra na varredura, e a mensagem diz o que falta.
- **`/mapas` não foi visto com ladrilho.** O ambiente não alcança
  `server.arcgisonline.com`; a tela renderiza, o mapa fica cinza.
- **Nada foi medido sob carga.** O pool tem dez conexões e uma transação por
  consulta. Com concorrência de verdade, esse número é a primeira coisa a olhar.
