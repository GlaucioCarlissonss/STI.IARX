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

### 6.1 Com Docker, em um comando

É o caminho para quem quer **ver o produto funcionando** sem instalar Node nem
PostgreSQL:

```bash
docker compose up
```

Depois, `http://localhost:3177`. O serviço `preparacao` imprime a lista de
e-mails; a senha de todos é `desenvolvimento`.

São três serviços, e a ordem entre eles é o que faz funcionar:

| Serviço | O que faz | Por que depende de quem depende |
|---|---|---|
| `banco` | PostgreSQL 16, publicado na 5433 | `healthcheck` com `pg_isready`: sem ele a preparação começaria antes de o banco aceitar conexão e falharia num erro que parece de configuração, mas é só pressa |
| `preparacao` | Shim, migrações, seed e senhas | Espera o banco **saudável**. Roda uma vez e sai |
| `app` | O Next.js | Espera a preparação **terminar com sucesso** (`service_completed_successfully`), não só começar — senão a primeira tela abriria num erro de tabela inexistente |

**O banco não é recriado a cada `up`.** `preparar-banco-local.sh` derruba e
recria o banco toda vez — certo para quem o chama à mão, desastroso aqui, porque
o compose roda a preparação a cada subida e quem passou a tarde cadastrando
perderia tudo ao reiniciar. O invólucro `scripts/docker/preparar.sh` faz a
preparação ser um ato de uma vez só; recriar passa a ser deliberado:

```bash
docker compose run --rm -e RECRIAR=1 preparacao   # APAGA o que foi cadastrado
```

Os dados moram em dois volumes — `banco` (o PostgreSQL) e `arquivos` (anexos de
ticket e fotos de ativo) —, então `docker compose build` e `down` não os levam
junto. Quem quiser zerar tudo usa `docker compose down -v`.

**O build não fala com ninguém além do registro do npm.** Isto precisou ser
consertado, e vale o registro porque o sintoma enganava: `next/font/google`
baixava as duas fontes em tempo de build, e atrás de um proxy que reescreve TLS
o build morria em `Failed to fetch Space Grotesk from Google Fonts` — que não
parece problema de rede para quem encontra, parece defeito do projeto. Foi assim
que o primeiro `docker compose build` falhou.

As fontes passaram a vir de pacotes (`@fontsource*`), do `node_modules`. Depois
do `npm ci`, o build roda **sem rede**, e isso foi verificado com
`docker run --network none`. Dois efeitos de brinde: o `package-lock.json` fixa
a versão da fonte, e nada sai desta aplicação para o Google quando alguém abre
uma tela — o que não é pouco num produto que atende cliente de terceiro.

Se ainda assim o `npm ci` falhar com `self-signed certificate in chain`, aí é a
CA da sua empresa: aponte `NODE_EXTRA_CA_CERTS` para ela. Nunca desligue a
verificação.

### 6.2 Sem Docker, na própria máquina

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

- **A DECISÃO das fábricas agora tem teste; o cliente do Supabase depois de
  criado, não.** `src/lib/supabase/fabricas.test.ts` exercita os dois ramos das
  três fábricas de servidor, inclusive o do Supabase — ele não precisa de rede,
  porque o cliente do Supabase monta um objeto e só fala com o servidor na
  primeira consulta. Cobre quem é escolhido, com qual configuração, e o erro
  nomeado quando falta a chave de serviço; cobre também que **um Supabase de
  verdade configurado impede o modo local de ligar**, que é a propriedade de
  segurança do desenho.

  A quarta fábrica — o cliente de navegador — não tem `if`, de propósito:
  `modoLocal()` depende de `DATABASE_URL`, que não existe no navegador. Quem
  decide ali é `realtime-refresh.tsx`, pela URL ausente ou de reserva, e essa
  regra está testada ao lado das outras para as duas não divergirem em silêncio.

  O que continua sem prova é o comportamento do cliente do Supabase **depois** de
  criado, contra um servidor real — e esse nunca foi o risco que o `if`
  introduziu.
- **O driver cobre o que o app usa, não o PostgREST inteiro** — e a lista do que
  faltava estava desatualizada. Conferida uma a uma contra o banco:

  | O que se dizia faltar | O que é verdade |
  |---|---|
  | `count` com `head` | **Já funcionava.** Agora com teste: conta antes do limite, e conta **zero** quando nada casa. O zero importa — `count(*) over()` não devolve linha nenhuma sem resultado, e um total lido da primeira linha viraria `null`, que numa paginação não é "zero", é "não sei" |
  | Filtro sobre tabela embutida | **Não existe, e agora recusa dizendo isso.** No PostgREST, `.eq('comentarios.autor', x)` filtra DENTRO do embute: a linha de fora permanece e só a lista encolhe. Aproximar isso devolveria dado errado em silêncio |
  | `csv` e `explain` | **Não existem, e agora existem como erro nomeado.** Sem isso, a mensagem era `consulta.csv is not a function`, que parece defeito de quem chamou |

  O filtro embutido levanta **exceção**, e não `{ error }`: não é condição de
  execução, é erro de programação — a consulta não funcionaria para linha de
  dado nenhuma. Como `{ error }`, desceria pelo caminho de "não encontrei" e a
  tela mostraria lista vazia para um defeito de código. Antes disso, virava a
  coluna `t."comentarios.autor"` e o PostgreSQL respondia `column does not
  exist`, mandando quem lê procurar um erro de digitação que não existe.

  Nenhuma das 333 consultas do app usa qualquer um dos três. A asserção que
  protege o conjunto continua sendo a varredura de telas.
- **`/mapas` continua sem ser visto com ladrilho de verdade.** O ambiente não
  alcança `server.arcgisonline.com`. O que mudou é que isso deixou de ser
  invisível: o mapa **diz** que não alcançou o servidor, e pino, balão e lista
  seguem funcionando. Antes ficava cinza e calado, indistinguível de um mapa
  carregando para sempre — e a varredura reprovava a tela para sempre, de um
  jeito que viraria paisagem e esconderia um defeito de verdade.
  `demo/tests/local/mapa.spec.mjs` prova as duas pontas: com o servidor
  inalcançável o aviso aparece, e com ele respondendo o aviso **não** aparece.
- **Medido.** `scripts/medir-driver.mjs` percorre concorrência de 1 a 80, com
  pools de 5, 10, 20 e 40. Nesta máquina (4 núcleos, PostgreSQL local):

  | concorrência | req/s | mediana | p95 |
  |---|---|---|---|
  | 1 | ~1 700 | 0,5 ms | 1,1 ms |
  | 5 | ~4 000 | 1,0 ms | 3,4 ms |
  | 20 | ~5 200 | 3,7 ms | 5,4 ms |
  | 80 | ~4 000 | 19,9 ms | 21,8 ms |

  **O tamanho do pool não é o gargalo.** A vazão satura entre três e quatro mil
  consultas por segundo com 5, 10, 20 ou 40 conexões. Quem limita é o custo de
  cada consulta: cinco idas ao banco — `begin`, `set local role`, `set_config`,
  a consulta, `commit` —, que é o preço de manter o RLS valendo igual ao do
  PostgREST. Trocar isso por menos idas exigiria montar os claims dentro do SQL
  à mão, e escapar JSON à mão é como se escreve uma injeção.

  Pool grande chegou a **piorar**: com 40 conexões e concorrência 40, o p95
  subiu de 5 ms para 36 ms — mais processos no PostgreSQL disputando o mesmo
  núcleo. É o engano comum de achar que mais conexões é sempre mais rápido.

  Dez continua, agora por medida e não por herança, e `DATABASE_POOL_MAX` existe
  para quem rodar numa máquina maior. Para mexer nela com fundamento:
  `node scripts/medir-driver.mjs --max N`.
