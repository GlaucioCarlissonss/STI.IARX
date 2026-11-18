# STI · Helpdesk e Gestão de TI

Plataforma SaaS multi-tenant para quem **presta serviço de TI**: helpdesk com SLA
medido em horário útil, gestão à vista em TV, inventário de equipamentos e linhas
telefônicas, e — para quem também **aluga equipamento** — frota, contratos,
medição, faturamento, manutenção em campo e estoque de peças. Mais um Integration
Hub aberto, cuja primeira integração é o Bitrix24.

Os dois negócios convivem numa base só porque cada empresa declara as **esferas**
em que atua (`management`, `rental` ou as duas), e é isso que decide quais telas
existem para ela. Permissão responde "esta pessoa pode abrir esta tela?"; esfera
responde "esta tela existe neste negócio?" — são perguntas diferentes, e
confundi-las enche o menu de coisas que não se aplicam.

```
Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4
PostgreSQL com RLS — sobre Supabase, ou direto numa VPS (docs/22, docs/24)
Space Grotesk (display) · IBM Plex Sans (corpo) — auto-hospedadas, via @fontsource
```

Duas implantações, com o **mesmo** schema, as mesmas policies e os mesmos papéis:
sobre **Supabase** (Auth, Realtime, Storage, Edge Functions) ou sobre um
**PostgreSQL próprio** numa VPS, com Caddy e TLS automático. O que troca é o
transporte, não a regra — e o interruptor é a *ausência* de uma URL de Supabase,
nunca uma variável de modo, porque essa, esquecida ligada, faria a aplicação
falar com o banco errado em silêncio.

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
| **Inventário de TI** | Cadastro, lifecycle com histórico automático, vínculo com tickets (0036), alerta de garantia |
| **Telefonia** | Cadastro de linhas, vínculo com aparelho, relatório de custos por filial e operadora |
| **Fornecedores** | Cadastro, serviços, avaliação, contratos com SLA contratado |
| **Clientes e filiais** | Grupos econômicos com N filiais, fuso e calendário próprios |
| **Permissões granulares** | Perfis de acesso com matriz módulo → tela → ação. O papel base é o teto de RLS do perfil, então atribuir perfil só restringe — nunca promove |
| **Financeiro (base)** | Centros de custo hierárquicos (3 níveis) e contas bancárias com saldo derivado, extrato, conciliação e transferência por dupla entrada |
| **Edição dos cadastros** | Cliente, filial, ativo, linha, fornecedor e seus contratos são editáveis e inativáveis pela interface, com a mesma regra de validação do cadastro |
| **Configuração de SLA** | Categorias (2 níveis), prioridades, contratos de SLA por cliente e definições — tudo cadastrável em `/sla`, além do relatório de compliance |
| **Geolocalização** | Endereço estruturado obrigatório, geocodificação com nível de precisão, tratamento das 6 exceções, mapa em satélite e log append-only de cada tentativa |
| **Usuários** | 6 papéis, visibilidade por filial (1 ou N), proteção contra auto-escalonamento, criação de conta com senha temporária e troca de senha em `/conta` |
| **Integration Hub** | Handler Bitrix24 e handler genérico, idempotência, retry com backoff, supressão de eco, logs e mapeamento editável |
| **Auditoria** | Trigger em 62 tabelas + histórico dedicado de tickets |
| **Foco por empresa** | Seletor no cabeçalho que estreita treze telas de uma vez. É visualização, não autorização — o isolamento entre tenants continua sendo o RLS |
| **Tema claro e escuro** | Segue o sistema por padrão, com escolha explícita que vence a preferência do sistema. Os dois temas passam em AA, verificado por teste |
| **Avisos de SLA** | Atenção, crítico e estourado por e-mail, com caixa de saída, nova tentativa e opt-out por pessoa. Uma mensagem por estado e por ciclo do chamado — nunca duas |
| **Fechamento automático** | `auto_close_after_days` existia desde a migração 0002 e nunca tinha sido executado. Agora é |
| **Satisfação (CSAT)** | Convite de 1 a 5 ao encerrar o chamado, respondido por link sem login, com tela de resultados |
| **Base de conhecimento** | Busca em português que ignora acento, e o caminho que a faz existir: do chamado resolvido para o artigo, com o texto já montado. Visibilidade separada para equipe e para quem abre chamado |
| **Catálogo de serviços** | Serviços com prazo e preço, com formulário próprio. O pedido vira chamado já classificado. Preço por cliente, incluindo "já está no contrato" |
| **Portal de quem pede** | Tela inicial do solicitante, na ordem do que resolve mais barato: procure a resposta, peça um serviço, acompanhe, e só então abra um chamado |
| **Agente nas máquinas** | Serviço em Go (Windows, Linux e macOS) que coleta inventário de hardware e software, concilia com o cadastro **sem duplicar ativo** e nunca sobrescreve o que uma pessoa digitou. Token por máquina, revogável uma a uma |
| **Canais de conversa** | WhatsApp pela API oficial da Meta, e-mail, Bitrix24 e um canal genérico para o N8N — que liga Telegram, Slack ou SMS sem esta base precisar conhecê-los. Toda conversa vira chamado, e a resposta volta pelo canal de onde a pergunta veio |
| **Sugestões de IA** | Resposta, classificação e artigo — **sugeridos, nunca aplicados**. Toda sugestão nasce pendente e aceitar é ato humano, com autor e data. Credencial por referência, teto de gasto mensal por empresa, e tudo continua funcionando sem chave nenhuma |
| **Trilha de auditoria** | Quem mudou o quê, em 62 tabelas, com filtro por registro e por ação e exportação em CSV. A trigger grava desde a primeira migração; a tela de leitura chegou na 0036 |
| **Expediente e feriados** | As horas em que o prazo de SLA corre, com faixas por dia (o almoço são duas faixas) e feriados com data. Sem feriado cadastrado, um chamado aberto na véspera de Natal vence no dia 25 |
| **Trabalhos agendados** | Quando cada trabalho rodou pela última vez e se deu certo — porque trabalho parado é invisível: não há erro, simplesmente nada acontece |
| **Exportação em CSV** | Trilha, telefonia e custódia. Gerada **no servidor**, com o escopo de RLS de quem pediu — e não as 50 linhas da página visível |
| **Projetos** | Cronograma mensal com Gantt, tarefas em até três níveis e envolvidos. **Atraso e desvio são calculados, nunca digitados** — e a hierarquia é garantida por trigger, não por convenção da tela. Vindo do GSTI.IARX |
| **Orçamento de TI** | Quanto a TI custa por mês, por filial e por categoria — e quanto vai custar. Competência, natureza, classificação, cenários e fechamento mensal. **Importa os títulos a pagar sem duplicar**: um título vira lançamento uma vez só. Vindo do GSTI.IARX |
| **Visão de resultado** | Custo, prazo e entrega do cliente numa tela só, sob o mesmo recorte — porque o gestor de TI não responde por três módulos, responde por um resultado. **A soma de cada detalhamento é conferida contra o indicador na própria tela**, e a divergência aparece ali, não numa reunião. Vindo do GSTI.IARX |
| **Preferências do ambiente** | Os onze parâmetros que governam quando o sistema age sozinho — prazos de SLA, fechamento automático, cota de anexo, alertas do agente, aviso de contrato e de link. Estavam todos só como coluna no banco: mudá-los exigia um `update` à mão, e por isso ninguém mudou |

### Entrada pública, em `sti.iarx.com.br`

O sistema mora no subdomínio; o apex é o site institucional, com um botão
**Sistema** apontando para cá. Ver [docs/24](docs/24-producao-na-vps.md).

| Módulo | Situação |
|---|---|
| **Criar conta** | Cadastro público cria a empresa **em avaliação** (90 dias, parâmetro da plataforma) e o primeiro administrador. A conta nasce inativa: existir não é poder entrar |
| **Confirmar e-mail** | Link de uso único, válido por 48 h. Confirmar é ativar — não há um estado a mais dizendo a mesma coisa que `is_active` |
| **Redefinir senha** | Token guardado como hash, e-mail pela caixa de saída. **No modo local isso não existia**: a tela confirmava o envio e nada saía |
| **O que a tela não conta** | E-mail novo e e-mail que já tem conta recebem a **mesma** resposta. Quem é dono do endereço descobre pelo e-mail — único canal onde a diferença pode aparecer sem informar estranho nenhum. E esse aviso não leva token: link de senha para quem não pediu seria a arma que ele deveria impedir |
| **Freio por origem** | Cinco redefinições e três cadastros por hora, por origem. O IP não é guardado — o banco só vê um hash com segredo |

### Locação de equipamentos

Absorvida do IARX/LTI em seis fases ([docs/23](docs/23-unificacao-lti-gsti.md)).
Só aparece para quem declarou a esfera `rental`.

| Módulo | Situação |
|---|---|
| **Esferas de negócio** | Cada empresa declara se faz gestão, locação ou as duas. O menu, a matriz de permissões e o seletor do cabeçalho seguem a declaração — uma tela de locação não existe para quem não aluga nada |
| **Frota** | Equipamento próprio com modelo, fabricante, categoria e depósito. **O ciclo de vida é máquina de estados em gatilho**, e cada movimentação fica registrada: onde o equipamento esteve é pergunta com resposta |
| **Contratos** | Contrato por cliente, itens alocados, local de operação, franquia e excedente. Os estados são validados no banco; encerrar o contrato encerra os itens junto |
| **Medição e faturamento** | Medidor, leitura por competência, consumo acumulado e quem está **sem leitura no mês** — porque cobrar excedente sem medição é a forma mais rápida de perder um contrato. A fatura emitida gera o título a receber, com vínculo nos dois sentidos, e **o total é a soma das linhas por gatilho**, nunca um número à parte |
| **Manutenção em campo** | Chamado de campo ligado ao equipamento e ao contrato, apontamento de horas e de peças, e **alçada de custo que bloqueia o fechamento**, não o registro: quem gasta não é quem autoriza o gasto |
| **Peças, estoque e compras** | Saldo derivado de um razão **imutável** — correção é lançamento contrário, não edição —, política de mínimo e máximo por peça e depósito, contagem de inventário que gera o ajuste, e ordem de compra cuja nota vira título a pagar |
| **Importação de planilha** | CSV com conferência linha a linha que **não grava nada**, modelo por recurso e arquivo só com as recusadas, para corrigir e tentar de novo. Seis recursos, incluindo leituras de medidor — mil por mês não se digitam. Vindo do GSTI.IARX |
| **Alerta de trabalho parado** | Distingue **parou** (ausência de execução, comparada à cadência esperada de cada trabalho) de **falhou** (execução com erro). Avisa por e-mail e webhook **uma vez por episódio**, e uma na volta: um trabalho que falha de 5 em 5 minutos mandaria 288 e-mails por dia, e no segundo dia ninguém leria nenhum |

## Ver funcionando em um comando

Para só **ver o produto rodando**, sem instalar Node nem PostgreSQL e sem conta
nenhuma:

```bash
docker compose up
```

Depois, `http://localhost:3177`. O serviço `preparacao` imprime os e-mails de
exemplo; a senha de todos é `desenvolvimento`. É um ambiente de
desenvolvimento, com dado de exemplo — os detalhes, e como recriar o banco do
zero, estão em [docs/22](docs/22-modo-local-sem-supabase.md) §6.1.

A instalação abaixo é a de quem vai **desenvolver** ou publicar em produção.

## Instalação

### Pré-requisitos
Node.js 20+, conta Supabase e [Supabase CLI](https://supabase.com/docs/guides/cli).
Para o modo local, nada disso: um PostgreSQL 16 basta — ou só o Docker.

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
npm test              # 796 testes: cadastros, permissões, coordenadas, contraste dos temas, mensagens de erro, paginação, canais, sugestões de IA, trilha de auditoria, exportação, cronograma de projetos, rateio do orçamento, estoque, leitura de planilha e segredos que não podem ir ao navegador
npm run db:validate   # migrações + seed + 1173 asserções em PostgreSQL real
```

Mais as suítes em navegador de verdade, que rodam à parte porque precisam de
Chromium e, fora a primeira, de um build:

```bash
node demo/tests/prototipo.spec.mjs   # 51 asserções de permissão no protótipo
node demo/tests/aplicacao.spec.mjs   # 61 asserções na aplicação: tema, fontes, foco, 360px, peso do JS, rotas do agente, dos canais e da exportação

# E, com o modo local de pé (docs/22), as telas AUTENTICADAS — que até esta
# entrega nunca tinham sido abertas com dado real:
bash scripts/preparar-banco-local.sh

# ATENÇÃO: as suítes de `demo/tests/local/` falam com a porta 3177, e esperam um
# servidor de PRODUÇÃO ali. Não use `npm run dev`.
npm run build && npx next start -p 3177 &

node demo/tests/local/telas.spec.mjs      # 47 telas autenticadas, uma a uma
node demo/tests/local/aprovacao.spec.mjs  # o fluxo de aprovação com três pessoas
node demo/tests/local/menu.spec.mjs       # o menu que abre e fecha, e lembra
# … e as outras dezessete em demo/tests/local/
```

> **`playwright` não está no `package.json`.** As suítes o importam, e ele vem do
> ambiente — num `npm install` que pode o `node_modules`, elas param com
> `Cannot find package 'playwright'`, que parece erro de código e não é.
> Instale-o globalmente, ou com `npm i -D playwright`. Declará-lo como
> dependência de desenvolvimento resolveria de vez, e é decisão pendente: ele
> baixa navegador, e este repositório hoje usa o Chromium que o ambiente já tem.

**Por que produção e não `npm run dev`**, dito aqui porque custa caro descobrir
sozinho: num ambiente onde o WebSocket de recarga a quente do Next não conecta,
o React **não hidrata** — e o sintoma não é um erro, é um conjunto de asserções
falhando de um jeito convincente. O que é nativo do HTML continua funcionando
(`<details>` abre ao clique), o que depende de JavaScript não (o irmão não
fecha, a escolha não sobrevive ao recarregar). Parece defeito do produto, e não
é. Rodando contra `next start`, as vinte suítes passam.

`aplicacao.spec.mjs` cobre só as rotas públicas: `src/proxy.ts` guarda toda
rota, e sem sessão não há como exercitar as telas internas — é para isso que
existem as suítes de `demo/tests/local/`, que entram com um usuário do seed.
Ela sobe o próprio servidor na 3177 e **recusa** rodar se a porta estiver
ocupada, então encerre o `next start` das locais antes (`fuser -k 3177/tcp`).

E uma conferência que não roda código da aplicação: os números de schema que
esta documentação afirma, medidos contra o banco.

```bash
python3 scripts/conferir-numeros.py   # depois de npm run db:validate
python3 scripts/conferir-colunas.py   # idem
```

O segundo confere cada `.from('tabela').select('coluna')` contra o schema real.
O `tsc` não vê nada ali — o nome da coluna é uma string, e o `.returns<T>()` é
uma asserção de quem escreveu. Quando o nome está errado, o Supabase devolve
erro, o `?? []` vira lista vazia, e o resultado é um campo de formulário sem
opções, em silêncio. Ele achou dois casos reais na primeira execução.

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
  migrations/         # 60 migrações
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
- **Conta desativada não entra, e perde a sessão que já tinha.** `is_active`
  existia desde o começo, era lido e **nunca aplicado**: quem fosse desativado
  continuava entrando e trabalhando. A tela de usuários oferecia inativar e isso
  não impedia nada — a diferença entre "tirei o acesso" e "mudei um campo". São
  duas trancas: o login recusa com mensagem útil, e a sessão recusa para quem já
  estava dentro, por `/auth/encerrar`, que apaga o cookie antes de devolver à
  entrada. Sem apagar, o cookie válido fazia o proxy insistir que havia sessão —
  e o resultado era um laço de redirecionamento.
- **Tela pública tem freio por origem, e ele lê o ÚLTIMO `X-Forwarded-For`.**
  O cabeçalho é uma lista que cada proxy *acrescenta*: se o visitante mandá-lo
  preenchido, o primeiro item é o que **ele** escreveu. Pegar o primeiro — o
  padrão de quase toda biblioteca, e o que parece certo — entregaria a chave do
  limite a quem está sendo limitado, e bastaria um valor novo por requisição.
  Com um proxy confiável, o real é o último. O IP nunca chega ao banco: o que
  se grava é hash com segredo. Ver `src/lib/limite.ts` e a migração `0059`.
- **Migração que acrescenta permissão precisa reaplicar a regra dos perfis.** As
  concessões dos perfis de sistema são uma regra sobre o catálogo, não uma
  lista — mas ela só rodava na criação do tenant. Numa empresa que já existe, a
  chave nova entrava no catálogo e não chegava a perfil nenhum: a tela ficava
  escura para todos, inclusive para o administrador, e **sem erro**. Valia para
  toda chave desde a `0041`. Agora toda migração que acrescenta permissão termina
  chamando `app.seed_system_access_profiles` para cada tenant, e há asserção que
  cobra isso — ver a `0058`.
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

Verificado na última entrega: build de produção limpo, `tsc` sem apontamentos,
`eslint` com 4 avisos de variável não usada em teste, **796 testes unitários** e
**1173 asserções de banco** passando, mais 51 asserções no protótipo e 61 na
aplicação, em navegador — incluindo a aritmética de horário útil conferida
contra 8 cenários (almoço, fim de semana, feriado, fora de expediente).

As **20 suítes de navegador autenticadas** passam duas vezes seguidas no mesmo
banco. A segunda passada não é zelo: é a que pega suíte que consome estado e só
funciona uma vez — foi assim que apareceu o defeito de refaturamento corrigido
na migração 0056, em que cancelar uma fatura e refazer a competência era
recusado com o nome de um índice.

A imagem de produção foi construída e executada: sobe como usuário não-root,
responde `healthy`, e **não contém** código-fonte, migrações, `npm`, `typescript`
nem o executor de testes.

Os números de schema desta documentação são conferidos contra o banco por
`scripts/conferir-numeros.py`, e não escritos à mão: quatro vezes nesta auditoria
um número envelheceu em silêncio, e documentação que descreve um sistema que não
existe mais é pior que documentação ausente, porque ninguém desconfia dela.

**Ainda não implementado.** Esta lista foi conferida item a item contra o código
nesta revisão — quatro coisas que ela afirmava faltar já existiam havia várias
entregas, e documentação que subdescreve o produto engana tanto quanto a que o
superestima.

- **Edge Function do Zabbix** para os links de internet. A tela existe
  (`/conectividade/links`, migração `0022`) e a queda é registrada à mão, pelo
  mesmo evento que o webhook vai gravar — falta só o webhook.
- **Filtro por área na telefonia.** A coluna `company_area_id` existe e aparece
  na tabela; filtrar por ela, ainda não.
- **Alerta de vigência vencendo** do contrato da linha telefônica.
- **Portal do cliente de locação**: as abas de contrato, parque e consumo em
  `/portal`, previstas na [docs/23](docs/23-unificacao-lti-gsti.md).
- **Migração dos dados** do LTI e do GSTI. Nenhum registro foi migrado, e isso
  é decisão registrada: o levantamento do que seria preciso está em
  [docs/25](docs/25-migracao-de-dados-do-lti.md).
- **Sincronização reversa para o Bitrix24**: as defesas contra eco estão prontas
  e testadas, o disparo a partir das Server Actions ainda não foi ligado.

Dois itens dependem de um Supabase de verdade e **não se aplicam à implantação
em VPS** da [docs/24](docs/24-producao-na-vps.md), que roda sobre PostgreSQL
próprio com armazenamento em disco:

- Validação do **upload de anexo** contra o Supabase Storage. O bucket privado,
  as policies por caminho e a tela existem desde a `0019` e são conferidos contra
  PostgreSQL local — mas Storage é serviço separado, e serviço separado só se
  prova usando.
- Validação da **recuperação de senha pelo caminho do Supabase Auth**, pelo mesmo
  motivo: lá quem envia o e-mail é ele. Ver [docs/09](docs/09-conectar-no-supabase.md).
  *Na VPS isso não é pendência:* desde a migração `0057` a redefinição é nossa —
  token guardado como hash, e-mail pela caixa de saída —, e o percurso inteiro é
  exercitado em `demo/tests/local/senha.spec.mjs`, do pedido até entrar com a
  senha nova.

*(A caixa de saída não tinha tela, e isso apareceu ao construir a `0057`.
Fechado na `0058`: `/auditoria/avisos` mostra o que saiu, o que está esperando e
o que falhou — com o motivo, e sem o corpo da mensagem, que carrega o link de
redefinição de senha de outra pessoa.)*

**Fora de escopo**, registrado em [docs/01-requisitos.md](docs/01-requisitos.md#4-fora-de-escopo-v1):
gestão de mudanças e problemas, billing, app móvel, chat e telefonia embarcada,
e descoberta automática de ativos. *(O portal de autoatendimento constava desta
lista e saiu dela: `/portal` existe, com busca na base, catálogo de serviços e
acompanhamento.)*

**Sete decisões tomadas por padrão** aguardam confirmação do negócio antes de
produção — estão listadas com a alternativa adotada em
[docs/01-requisitos.md §5](docs/01-requisitos.md#5-lacunas-em-aberto-dependem-do-negócio).

### Nota sobre `npm audit`

Esta nota afirmava "3 vulnerabilidades altas em `postcss` e `sharp`" e que a
única correção seria regredir para `next@9`. **As duas coisas estavam erradas**,
e numa afirmação de segurança isso é o pior tipo de erro de documentação: ela
tranquiliza.

A medição real apontou **20 vulnerabilidades, 3 pacotes com severidade crítica**.
Entre elas, cinco críticas no próprio **Next.js 16.2.12** — execução remota de
código **não autenticada** na API de otimização de imagem (por AVIF e por SVG),
RCE em `next/og`, RCE em funções `use cache`, e *cache poisoning* de páginas
SSG/ISR **especificamente em aplicações auto-hospedadas**, que é exatamente o
cenário da [docs/24](docs/24-producao-na-vps.md).

A correção era `next@16.4.6` — **não era uma versão maior**. Foi aplicada, junto
com `zod` e as transitivas. Restam:

| | Onde | Vai para a imagem publicada? |
|---|---|---|
| 2 críticas | `vitest` / `tinypool` | **não** |
| 9 moderadas | `eslint`, `typescript-eslint` | **não** |

Todas são de ferramenta de desenvolvimento, e corrigi-las exige mudança de
versão maior do executor de testes — mexer na ferramenta que precisa provar que
o resto continua funcionando, no mesmo passo. Fica para uma entrega própria.

Isto não é argumento de autoridade: a imagem de produção foi inspecionada, e
`vitest`, `tinypool`, `typescript` e `eslint` **não estão nela** — como não estão
o código-fonte, as migrações e o `npm`. O que vai para a internet é o servidor
compilado e as dependências que ele carrega em tempo de execução.

## Documentação

| Documento | Conteúdo |
|---|---|
| [01 — Requisitos](docs/01-requisitos.md) | Requisitos rastreáveis, matriz de permissões, lacunas e decisões por padrão |
| [02 — Benchmarking](docs/02-benchmarking.md) | Freshservice, Jira SM, Zendesk, GLPI, ManageEngine — padrões adotados e 10 antipatterns evitados |
| [03 — Arquitetura](docs/03-arquitetura.md) | Visão geral e 12 ADRs com alternativas rejeitadas |
| [04 — Modelo de dados](docs/04-modelo-dados.md) | 122 tabelas, funções, triggers, views e estratégia de índices |
| [05 — Bitrix24](docs/05-integracao-bitrix24.md) | Estudo da API, mapeamento, configuração passo a passo e limitações |
| [06 — Lacunas e Roadmap](docs/06-lacunas-e-roadmap.md) | Especificação dos 11 módulos pendentes, cronograma em lotes e 14 lacunas globais |
| [07 — Financeiro e Permissões](docs/07-financeiro-e-permissoes.md) | Permissões granulares, financeiro (contas a pagar/receber, fluxo de caixa) e controle de despesas: 9 módulos no template, matriz de permissões e 15 lacunas |
| [08 — Arquitetura de informação](docs/08-arquitetura-de-informacao.md) | Agrupamento do menu, nomenclatura e as decisões de usabilidade |
| [09 — Conectar no Supabase](docs/09-conectar-no-supabase.md) | Passo a passo para ligar a plataforma no Supabase auto-hospedado do cliente, e as duas regras de chave que não podem ser quebradas |
| [10 — Auditoria e repaginação](docs/10-auditoria-e-repaginacao.md) | As sete entregas de revisão do código e da identidade visual, com o que mudou, o que não mudou e por quê |
| [11 — Plano de comercialização](docs/11-plano-de-comercializacao.md) | O que falta para virar MicroSaaS vendável: diagnóstico com evidência, plano em fases e a recomendação sobre web, desktop e mobile |
| [12 — Paridade com o Milvus](docs/12-paridade-milvus.md) | Inventário do concorrente com fonte, mapa de lacunas, especificação do agente de inventário e plano em seis ondas |
| [13 — Avisos e trabalhos agendados](docs/13-notificacoes-e-trabalhos.md) | Como ligar o e-mail e o agendador: três variáveis, três jeitos de agendar e como saber se parou |
| [14 — O agente nas máquinas](docs/14-agente-de-inventario.md) | Como instalar o agente (inclusive por GPO), como funciona a conciliação, e o que ele coleta e o que não coleta |
| [15 — Autoatendimento](docs/15-autoatendimento.md) | Base de conhecimento, catálogo de serviços e portal: por que bases de conhecimento morrem, e o caminho que impede esta de morrer |
| [16 — Canais de conversa](docs/16-canais-de-conversa.md) | WhatsApp, e-mail, Bitrix24 e N8N: como ligar cada um, por que o N8N é o mais importante dos quatro, e por que não existe caixa de resposta nos canais |
| [17 — Sugestões de IA](docs/17-sugestoes-de-ia.md) | Resposta, triagem e artigo: por que nada é aplicado sozinho, o que sai para o provedor, o teto de gasto e por que a injeção de prompt é inofensiva aqui |
| [18 — A revisão](docs/18-revisao-e-lacunas-fechadas.md) | Seis tabelas que tinham dados, RLS e nenhuma tela; como foram encontradas; o que ficou aberto e por quê |
| [19 — Projetos](docs/19-modulo-de-projetos.md) | O primeiro módulo vindo do GSTI.IARX: por que um dos três veio inteiro, um entra lendo o que existe e um não entra |
| [20 — Orçamento de TI](docs/20-orcamento-de-ti.md) | A camada de planejamento sobre os títulos a pagar: competência, fechamento mensal, parcelamento que fecha na conta e consumo compartilhado |
| [21 — Visão de resultado](docs/21-visao-de-resultado.md) | Financeiro, SLA e projetos numa tela só: por que o recorte é montado no banco, por que a conformidade é do conjunto e não a média das filas, e por que a tela confere a si mesma |
| [22 — Modo local, sem Supabase](docs/22-modo-local-sem-supabase.md) | Como a aplicação roda contra um PostgreSQL direto, por que o RLS continua valendo, e os cinco defeitos que só apareceram quando ela foi aberta num navegador |
| [23 — Unificação LTI + GSTI](docs/23-unificacao-lti-gsti.md) | Como os dois sistemas foram absorvidos em oito fases, o que se dissolveu no que já existia, e o que o plano deliberadamente não faz |
| [24 — Produção na VPS](docs/24-producao-na-vps.md) | O runbook: subir, atualizar, restaurar, girar segredo e descobrir que algo parou. Escrito para ser lido às três da manhã |
| [25 — Migração de dados do LTI](docs/25-migracao-de-dados-do-lti.md) | O levantamento: a ordem derivada das chaves estrangeiras, as quatro travas do banco medidas, e as cinco decisões de negócio que faltam |
