# 28 — Manual do Maestro

> **Para quem é este documento.** Para o agente que opera este sistema sozinho:
> provisiona, publica, confere, corrige e relata. Não é um texto para ser lido
> e interpretado — é um procedimento para ser **executado**, com pré-condição,
> comando exato, critério de sucesso **medido** e o que fazer quando falha.
>
> Se você é uma pessoa, leia a [docs/26](26-publicar-na-hostinger.md) (publicar)
> e a [docs/27](27-manual-do-usuario.md) (usar). Este aqui vai parecer seco de
> propósito.

---

## Regra zero: nada é verdade porque o comando saiu sem erro

Todo passo deste manual tem um **critério medido**, separado do comando. Isso
não é formalismo: este projeto já teve

- uma varredura de quarenta minutos que rodou **sem banco** e reprovou o
  produto por isso;
- um conjunto de sete arquivos SQL que executava limpo e deixava o **RLS
  desligado em 125 tabelas**, porque `boolean::text` devolve `"true"` e não
  `"t"`;
- um laço de verificação que decidia "passou" procurando uma frase de sucesso
  na saída — e relatava como vermelha uma suíte verde que não imprimia aquela
  frase.

Em todos, o comando terminou com código 0. **Saída limpa não é prova.** Rode o
critério.

---

## 1. Reconhecer o terreno

Antes de agir, descubra em qual das duas implantações você está. Elas não se
misturam, e tratar uma como a outra estraga o banco.

```bash
test -n "$NEXT_PUBLIC_SUPABASE_URL" && echo "supabase" || echo "postgres-proprio"
```

| | Supabase | PostgreSQL próprio |
| --- | --- | --- |
| provisionar | `scripts/supabase-provisionar.sh` | `scripts/migrar.sh` |
| senha de usuário | GoTrue | `LOCAL_AUTH_SECRET`, no banco |
| primeiro admin | API do GoTrue | `scripts/primeiro-acesso.sh` |
| anexos | Storage do Supabase | pasta em `LOCAL_STORAGE_DIR` |
| backup | do provedor | `scripts/backup.sh` + envio para fora |

**Se as duas variáveis estiverem preenchidas, pare.** A aplicação escolhe o
Supabase e o outro banco fica parado com dado dentro — o pior desfecho, porque
ninguém repara até procurar um registro antigo.

---

## 2. Provisionar o banco

### 2.1 Ensaio primeiro, sempre

```bash
DATABASE_URL='postgresql://...:5432/postgres' \
  bash scripts/supabase-provisionar.sh --ensaio
```

**Critério:** sai `ENSAIO — nada foi escrito` e informa quantas migrações
aplicaria. Código de saída `0`.

**Se abortar**, a mensagem diz qual das cinco recusas foi, e cada uma tem um
conserto diferente:

| recusa | conserto |
| --- | --- |
| porta 6543 | use a conexão direta, 5432 — a 6543 é o pooler em modo transação e parte a transação por migração ao meio |
| não é Supabase | é PostgreSQL puro: use `scripts/migrar.sh`, que aplica o shim |
| banco de outra aplicação | use um projeto novo; não há desfazer |
| senha curta | 12 caracteres ou mais |
| já existe empresa | o primeiro acesso já foi feito; não repita |

### 2.2 Para valer

```bash
DATABASE_URL='...' SUPABASE_URL='...' SUPABASE_SERVICE_ROLE_KEY='...' \
EMPRESA='...' SLUG='...' EMAIL='...' SENHA='...' ESFERAS=management \
  bash scripts/supabase-provisionar.sh
```

**Critério:** as **8 asserções** de `conferir-producao.sql` passam e sai
`BANCO PRONTO`.

### 2.3 Conferir depois, quando quiser

Esta conferência é **somente leitura** — roda com gente usando.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v migracoes=$(ls supabase/migrations/*.sql | wc -l) \
  -f supabase/tests/conferir-producao.sql
```

**Critério:** oito `ok` e `BANCO CONFERIDO`.

O que cada uma impede está escrito no arquivo. As duas que mais importam:
**view sem `security_invoker`** roda como `postgres`, que ignora RLS, e devolve
as linhas de *todas* as empresas; **tabela sem `tenant_id` fora da lista de
catálogos globais** é tabela em que alguém esqueceu a coluna, e aí toda empresa
vê o dado de todas.

---

## 3. Publicar a aplicação

Siga a [docs/26](26-publicar-na-hostinger.md). O que o Maestro precisa saber
além do que está lá:

**O build precisa de memória.** O pico fica ~2,1 GB acima da linha de base, e
1 GB morre com `Killed` — sem mensagem útil, sem stack. Se o build morrer sem
explicação, é isto. Swap resolve; 4 GB de VPS evita.

**Nunca remonte com o servidor de pé.** `npm run build` reescreve `.next`
debaixo do processo que está servindo, e as telas passam a devolver 500 por sua
causa, não por defeito do produto. Derrube, construa, suba.

**Critério de publicado:**

```bash
curl -fsS https://SEU-DOMINIO/api/health
```

---

## 4. Verificar

### 4.1 A varredura inteira

```bash
bash scripts/verificar.sh
```

**Pré-condição:** o banco de pé. O script **recusa rodar sem ele** e diz como
levantar — essa recusa existe porque a varredura já rodou quinze minutos
medindo o nada.

**Critério:** última linha `VARREDURA LIMPA`, código `0`.

**Leia o rodapé, não a palavra "Error".** O script distingue três desfechos, e
a distinção é a parte útil:

| | significa |
| --- | --- |
| `FALHOU` | a suíte rodou e uma asserção reprovou — há defeito, e o log diz qual |
| `MORREU` | a suíte estourou antes de medir — **não é falha, é ausência de medição** |
| `ABORTOU` | a varredura parou: porta ocupada, build falhou, banco fora |

`MORREU` e `FALHOU` pedem ações diferentes. Tratar morte como falha faz
procurar defeito no produto onde o defeito está no ambiente.

A saída de quem reprovou fica em `.verificacao/`. **Leia de lá antes de rodar
de novo** — repetir quarenta minutos para reler a mesma linha é o desperdício
mais comum.

### 4.2 Os portões, separados

| portão | comando | o que impede |
| --- | --- | --- |
| tipos | `npm run typecheck` | contrato divergindo da implementação |
| unidade + estrutura | `npm test` | 829 asserções, incluindo todos os portões de lista |
| banco | `npm run db:validate` | 1255 asserções de RLS e invariante |
| artefatos do banco | `python3 scripts/gerar-artefatos-do-banco.py --conferir` | `docs/banco/` divergindo do schema |
| números da documentação | `python3 scripts/conferir-numeros.py` | número escrito à mão envelhecendo |
| navegador | 27 suítes em `demo/tests/` | a tela de ponta a ponta |

---

## 5. Mudar o sistema

### 5.1 A ordem é fixa

1. **Migração** — a regra mora no banco. Gatilho, `check`, índice único
   parcial, RLS.
2. **Asserção em `schema_test.sql`** — a recusa afirmada pelo **nome da
   constraint**, nunca por "houve erro". `assert erro` passa quando o código
   falha pelo motivo errado.
3. **Server Action** — tradução fina, com `requirePermission`.
4. **Tela**.
5. **Permissão no catálogo** — e a migração **termina** re-rodando
   `app.seed_system_access_profiles` para todos os tenants, senão quem já tem
   banco não recebe a chave nova.

### 5.2 Migração é somente-avante

Migração aplicada **não se edita**. O livro-razão guarda a soma de verificação
de cada arquivo, e `migrar.sh` **para** quando um arquivo já aplicado muda. O
conserto é migração nova. Isso não é burocracia: há banco com a versão antiga
rodando, e o arquivo editado faria o histórico divergir do servidor em
silêncio.

### 5.3 Tela nova

Tela nova toca **cinco** lugares, e quatro portões cobram isso:

```
src/lib/navigation.ts          o item de menu e a permissão
src/app/(app)/<rota>/page.tsx  a tela
demo/tests/local/rotas.mjs     a varredura abre a rota
demo/sti-tool.html             o protótipo acompanha
src/lib/permissions.ts         a chave, na ordem certa
```

**A ordem em `PERMISSION_CATALOG` importa**: `catalogTree()` percorre a lista
uma vez, e uma tela declarada antes do módulo dela é descartada da matriz em
silêncio.

### 5.4 Regenerar o que é derivado

```bash
python3 scripts/gerar-artefatos-do-banco.py   # docs/banco/ e o dicionário
node scripts/capturar-manual.mjs /tmp/manual  # as imagens do manual
```

Nenhum dos dois é opcional: os portões reprovam quando divergem.

---

## 6. Quando a coisa quebra

| sintoma | causa provável | o que medir |
| --- | --- | --- |
| build morre sem mensagem | memória | `free -m` durante o build; pico ~2,1 GB |
| telas 500 depois de um deploy | remontou com o servidor de pé | `.next` reescrito; derrube e reconstrua |
| suítes de navegador MORREM no login | banco fora | `pg_isready`; a varredura hoje recusa antes |
| "conta desativada" para todo mundo | **não é a conta** | se for o banco, a mensagem certa é "indisponível"; veja `src/lib/infraestrutura.ts` |
| tela some do menu de quem deveria vê-la | catálogo de permissões incompleto | `select count(*) from permission_catalog` ≥ 264 |
| dado de uma empresa aparecendo em outra | view sem `security_invoker`, ou RLS sem `force` | `conferir-producao.sql`, seções 1 a 4 |
| suíte verde que não prova nada | asserção vazia | a guarda contra vacuidade de cada portão |

---

## 7. O que o Maestro NÃO faz sozinho

Escrito aqui porque ausência deliberada é decisão, e decisão sem registro vira
"conveniência" em seis meses.

- **Tornar repositório público, girar segredo, apagar backup.** São
  irreversíveis e pertencem a quem responde pelo negócio.
- **Rodar `seed.sql` em produção.** É a semente de desenvolvimento;
  `conferir-producao.sql` reprova o banco em que ela tiver rodado.
- **Inventar regra de negócio.** Preço, alçada, franquia, condição comercial:
  se não foi especificado, pergunte ou entregue vazio. Um exemplo plausível é
  indistinguível de um requisito.
- **Dizer "sem regressão" sem a linha de base.** Compare com o número de antes,
  na mesma base.
- **Relatar número que não contou.**

---

## 8. O relato de uma execução

Ao terminar, relate nesta forma — ela é o que permite a próxima execução
começar sabendo de onde parte:

```
o que mudou      uma frase, do ponto de vista de quem usa
medido           os números, antes e depois, na mesma base
ficou de fora    o que não foi feito, e por quê
lacuna aberta    o que alguém precisa decidir
```

**Lacuna omitida é lacuna que ninguém resolve.**

---

## Apêndice: o mapa do repositório

| onde | o que |
| --- | --- |
| `supabase/migrations/` | **a fonte da verdade do schema** — 64 migrações, somente-avante |
| `supabase/tests/schema_test.sql` | 1255 asserções; cria e apaga dados, **não roda em produção** |
| `supabase/tests/conferir-producao.sql` | somente leitura; roda em produção |
| `docs/banco/00..06` | o schema consolidado, **gerado** do catálogo |
| `demo/dicionario.json` | o dicionário de dados, gerado |
| `src/lib/` | o que precisa existir uma vez só nas duas superfícies |
| `src/app/(app)/` | as telas |
| `demo/tests/` | 27 suítes de navegador |
| `scripts/verificar.sh` | a varredura inteira, com as três distinções |
| `CLAUDE.md` | a doutrina, os 13 portões e as divergências medidas |
