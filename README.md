# STI · Helpdesk e Gestão de TI

Plataforma SaaS multi-tenant de helpdesk e gestão de TI, com gestão à vista em
TV, SLA medido em horário útil, inventário de equipamentos e linhas telefônicas
e um Integration Hub aberto — cuja primeira integração é o Bitrix24.

```
Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4
Supabase — PostgreSQL, Auth, Realtime, Storage, Edge Functions
```

## Sumário

- [O que já funciona](#o-que-já-funciona)
- [Instalação](#instalação)
- [Verificação](#verificação)
- [Estrutura](#estrutura)
- [Decisões que valem conhecer](#decisões-que-valem-conhecer)
- [Estado atual e próximos passos](#estado-atual-e-próximos-passos)
- [Documentação](#documentação)

## O que já funciona

| Módulo | Situação |
|---|---|
| **Tickets** | Abertura, máquina de estados validada no banco, atribuição, transferência entre filas com motivo, comentários público/interno, histórico campo a campo, anexos (schema) |
| **SLA** | Contratos por cliente e filial, precedência determinística, medição em horário útil com feriados e fuso por filial, pausa por espera, semáforo e relatório de compliance |
| **Filas** | Fila padrão protegida, filas customizáveis, score de priorização (criticidade + prazo + espera), regras de roteamento |
| **Dashboard de TV** | Modo kiosk, tipografia fluida 1080p→4K, semáforo, auto-scroll condicional, token de exibição revogável |
| **Painel administrativo** | KPIs, tickets em risco, "meus tickets", atualização via Realtime |
| **Inventário de TI** | Cadastro, lifecycle com histórico automático, vínculo com tickets, alerta de garantia |
| **Telefonia** | Cadastro de linhas, vínculo com aparelho, relatório de custos por filial e operadora |
| **Fornecedores** | Cadastro, serviços, avaliação, contratos com SLA contratado |
| **Clientes e filiais** | Grupos econômicos com N filiais, fuso e calendário próprios |
| **Edição dos cadastros** | Cliente, filial, ativo, linha, fornecedor e seus contratos são editáveis e inativáveis pela interface, com a mesma regra de validação do cadastro |
| **Configuração de SLA** | Categorias (2 níveis), prioridades, contratos de SLA por cliente e definições — tudo cadastrável em `/sla`, além do relatório de compliance |
| **Geolocalização** | Endereço estruturado obrigatório, geocodificação com nível de precisão, tratamento das 6 exceções, mapa em satélite e log append-only de cada tentativa |
| **Usuários** | 6 papéis, visibilidade por filial (1 ou N), proteção contra auto-escalonamento, criação de conta com senha temporária e troca de senha em `/conta` |
| **Integration Hub** | Handler Bitrix24 e handler genérico, idempotência, retry com backoff, supressão de eco, logs e mapeamento editável |
| **Auditoria** | Trigger em 18 tabelas + histórico dedicado de tickets |

## Instalação

### Pré-requisitos
Node.js 20+, conta Supabase e [Supabase CLI](https://supabase.com/docs/guides/cli).

### 1. Dependências e ambiente

```bash
npm install
cp .env.example .env.local
```

Preencha `.env.local` com a URL e as chaves do seu projeto Supabase.

> `SUPABASE_SERVICE_ROLE_KEY` **nunca** deve receber o prefixo `NEXT_PUBLIC_` —
> isso a publicaria no bundle do navegador e daria a qualquer visitante acesso
> total ao banco, contornando todo o RLS.

### 2. Banco de dados

```bash
supabase link --project-ref SEU_PROJECT_REF
supabase db push          # aplica supabase/migrations/*.sql
psql "$DATABASE_URL" -f supabase/seed.sql   # opcional: dados de demonstração
```

### 3. Claim de tenant no JWT

O isolamento entre tenants depende de `tenant_id` estar no JWT, dentro de
`app_metadata`. Configure um *Auth Hook* de access token no painel do Supabase,
ou grave no momento do convite:

```ts
await supabase.auth.admin.updateUserById(userId, {
  app_metadata: { tenant_id: '<uuid-do-tenant>' },
})
```

> **Em `app_metadata`, jamais em `user_metadata`.** `user_metadata` é gravável
> pelo próprio usuário via `updateUser()` — colocar o tenant ali permitiria que
> qualquer pessoa autenticada migrasse para outro tenant e lesse dados alheios.
> Ver [ADR-002](docs/03-arquitetura.md#adr-002).

### 4. Mapas — funciona sem configurar nada

`/mapas` já sai do zero com mapa real: ruas via **OpenStreetMap** e satélite via **Esri World
Imagery**, os dois gratuitos e sem chave — nenhuma conta para criar, nenhum cartão de
cobrança. É o motor padrão (`src/components/leaflet-branch-map.tsx`, biblioteca Leaflet).
Alternância satélite/mapa, busca por filial, lista lateral de localizações, popup com a
quebra por área, zoom 16–18 ao focar uma filial — tudo isso já funciona sem `.env.local`.

Na mesma tela fica o **endereço estruturado** de cada filial (logradouro, número, bairro e
CEP são obrigatórios), o botão de geolocalizar pelo cadastro, a confirmação de candidatos
quando o CEP tem mais de um endereço, e a saída técnica do último fluxo. A geocodificação
também não exige chave por padrão: usa o **Nominatim** (OpenStreetMap) para transformar o
endereço em coordenada.

> Uso responsável: os tiles do OSM e do Esri são gratuitos sob política de *fair use* —
> exigem atribuição (já exibida no canto do mapa) e não servem para tráfego pesado em
> produção com muitos usuários simultâneos. Para esse cenário, considere um provedor pago
> (o próprio Google, MapTiler, Stadia…) ou hospedar os tiles.

**Opcional — motor oficial do Google.** Se preferir o Google Maps (SLA e suporte oficiais),
crie as duas chaves na sua conta Google Cloud e o app troca de motor automaticamente:

```bash
# .env.local — opcional; sem isso o app já usa OpenStreetMap/Esri
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=   # navegador — Maps JavaScript API
GOOGLE_MAPS_SERVER_KEY=            # servidor  — Geocoding API
```

No console do Google, habilite **Maps JavaScript API** e **Geocoding API**, e restrinja
cada chave: a do navegador por *referrer HTTP* (seu domínio), a de servidor por *IP*.

> A chave do navegador é pública por natureza — a Maps JS API valida por referrer, não por
> segredo. Sem a restrição de domínio, qualquer site consome sua cota. Já a chave de
> Geocoding **nunca** vai para o cliente: uma chave de servidor irrestrita no bundle é o
> erro clássico dessa integração.

> A ferramenta navegável em [`demo/`](demo/) não pode carregar tile nenhum — nem do Google,
> nem do OpenStreetMap — porque o CSP da página publicada bloqueia host externo. Lá o mapa é
> **vetorial embutido** — as 27 UFs do IBGE simplificadas, em Mercator, com pan, zoom e
> agrupamento de marcadores.

### 5. Edge Functions (integrações)

```bash
supabase secrets set BITRIX24_INBOUND_WEBHOOK_URL="https://SEU.bitrix24.com.br/rest/1/SEGREDO/"
supabase functions deploy bitrix24-webhook   --no-verify-jwt
supabase functions deploy integration-webhook --no-verify-jwt
```

Passo a passo completo do Bitrix24: [docs/05-integracao-bitrix24.md](docs/05-integracao-bitrix24.md).

### 6. Executar

```bash
npm run dev     # http://localhost:3000
```

Com o seed aplicado, o painel de TV de demonstração fica em
`/tv/demo-tv-token-iaroffice`.

## Verificação

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm test              # 122 testes: mapeamento, coordenadas, geolocalização, provedores sem chave e cadastros
npm run db:validate   # migrações + seed + 127 asserções em PostgreSQL real
```

`db:validate` sobe o schema inteiro em um banco limpo e roda os testes de RLS
**com um papel sem `BYPASSRLS`**. Testar isolamento como superusuário passaria
sempre e não provaria nada.

Requer um PostgreSQL 16 acessível:

```bash
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres npm run db:validate
```

## Estrutura

```
src/
  app/
    (app)/            # área autenticada — painel, tickets, filas, cadastros
    tv/[token]/       # painel de TV em kiosk (sem sessão, token de exibição)
    login/
  components/         # UI compartilhada
  lib/
    supabase/         # clientes server / browser / admin
    integrations/     # motor de mapeamento (sem dependências) + testes
    address.ts        # endereço estruturado, validações e relatório técnico
    geocode.server.ts # geocodificação (Google ou Nominatim) e consulta de CEP (somente servidor)
    session.ts        # contexto e papéis
    i18n.ts           # dicionário pt-BR
  proxy.ts            # renovação de sessão e guarda de rotas

supabase/
  migrations/         # 15 migrações
  functions/          # Edge Functions (Deno)
  tests/              # asserções de schema e RLS
  seed.sql

docs/                 # requisitos, benchmarking, ADRs, modelo de dados, Bitrix24
```

## Decisões que valem conhecer

Cada uma tem justificativa e alternativas rejeitadas em
[docs/03-arquitetura.md](docs/03-arquitetura.md).

- **O banco é a fronteira de segurança.** RLS em 100% das tabelas, com teste que
  falha se alguém criar uma tabela sem policy. A aplicação nunca é a única guarda.
- **Regras críticas ficam no banco.** Máquina de estados, auditoria e cálculo de
  SLA vivem em triggers e funções — porque tickets chegam por UI, por API e por
  integração, e validar só na UI garante que a integração grave lixo.
- **SLA é política, não campo.** Alterar a política corrige tickets futuros sem
  migração, e o tracking guarda qual política se aplicou.
- **Pausas são intervalos, não contador.** Preserva *quando* pausou e permite
  auditar a medição.
- **A TV não faz login.** Token de exibição revogável, armazenado como hash,
  somente leitura. Exigir sessão faria o painel de parede cair na primeira
  expiração e ninguém perceberia por dias.
- **Um único motor de mapeamento.** O mesmo arquivo roda no app, na Edge Function
  (Deno) e nos testes. Duas implementações divergiriam em semanas.

## Estado atual e próximos passos

Verificado nesta entrega: build de produção limpo, `tsc` e `eslint` sem
apontamentos, 86 testes unitários e 127 asserções de banco passando — incluindo
a aritmética de horário útil conferida contra 8 cenários (almoço, fim de semana,
feriado, fora de expediente).

**Ainda não implementado** (schema pronto, interface pendente):

- Upload de anexos pela UI — as tabelas e o vínculo existem, falta ligar ao
  Supabase Storage.
- Cadastro de áreas da filial, anexos, links de internet e dashboard de
  telefonia — banco pronto (migrações `0013`–`0016`), interface pendente; a
  especificação de cada um está em
  [docs/06-lacunas-e-roadmap.md](docs/06-lacunas-e-roadmap.md).
- Recuperação de senha ("esqueci minha senha"): existe troca de senha logado
  (`/conta`) e criação de usuário com senha temporária (`/usuarios`), mas não
  um fluxo de redefinição para quem está deslogado.
- Importação em massa de ativos por CSV (RF-INV-04, prioridade *Should*).
- Edição de regras de fila (`queue_rules`) pela UI — hoje cadastradas por SQL.
- Fechamento automático de tickets resolvidos: a preferência
  (`tenants.auto_close_after_days`) existe, falta o job agendado.
- Envio de e-mail em alertas de proximidade de breach — os estados são
  calculados e exibidos, mas não notificam fora da interface.
- Sincronização reversa para o Bitrix24: as defesas contra eco estão prontas e
  testadas, o disparo a partir das Server Actions ainda não foi ligado.

**Fora de escopo da v1**, registrado em [docs/01-requisitos.md](docs/01-requisitos.md#4-fora-de-escopo-v1):
portal de autoatendimento, gestão de mudanças/problemas, billing, app móvel,
chat/telefonia embarcada e descoberta automática de ativos.

**Sete decisões tomadas por padrão** aguardam confirmação do negócio antes de
produção — estão listadas com a alternativa adotada em
[docs/01-requisitos.md §5](docs/01-requisitos.md#5-lacunas-em-aberto-dependem-do-negócio).

### Nota sobre `npm audit`

São reportadas 3 vulnerabilidades de severidade alta em `postcss` e `sharp`,
ambas dependências transitivas do próprio Next.js 16.2.12. A única correção
oferecida pelo `npm audit fix --force` é regredir para `next@9`, o que não é
aceitável. A resolução depende de uma atualização do Next.

## Documentação

| Documento | Conteúdo |
|---|---|
| [01 — Requisitos](docs/01-requisitos.md) | Requisitos rastreáveis, matriz de permissões, lacunas e decisões por padrão |
| [02 — Benchmarking](docs/02-benchmarking.md) | Freshservice, Jira SM, Zendesk, GLPI, ManageEngine — padrões adotados e 10 antipatterns evitados |
| [03 — Arquitetura](docs/03-arquitetura.md) | Visão geral e 12 ADRs com alternativas rejeitadas |
| [04 — Modelo de dados](docs/04-modelo-dados.md) | 46 tabelas, funções, triggers, views e estratégia de índices |
| [05 — Bitrix24](docs/05-integracao-bitrix24.md) | Estudo da API, mapeamento, configuração passo a passo e limitações |
| [06 — Lacunas e Roadmap](docs/06-lacunas-e-roadmap.md) | Especificação dos 11 módulos pendentes, cronograma em lotes e 14 lacunas globais |
