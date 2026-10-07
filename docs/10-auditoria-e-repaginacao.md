# Auditoria do código-fonte e plano de repaginada — Entrega 1 (diagnóstico)

> **Nada foi alterado nesta entrega.** Este documento é o diagnóstico e o plano de
> ação, para aprovação antes de qualquer mudança.
>
> Tudo aqui foi **medido**, não estimado: os números vêm de varredura do código,
> do build de produção e de consulta ao PostgreSQL com as migrações aplicadas.
> Quando a medição contrariou a suspeita, está registrado assim.

---

## 0. Quatro premissas do briefing que não batem com este sistema

Precisam de decisão sua antes das Entregas 3 e 4 — duas delas mudariam código que
hoje está correto.

### 0.1 "Escopo por `client_id` obrigatório"

Neste sistema o isolamento **não é por `client_id`**. É por `tenant_id`, que vem
do JWT (`app_metadata`) e é aplicado por **162 policies de RLS** em `public` (mais 3 no bucket de anexos)
(ADR-002). `src/lib/supabase/server.ts` diz, literalmente:

> *"Nenhum código de aplicação deve filtrar `tenant_id` manualmente: se a policy
> falhar, o dado não aparece, em vez de aparecer por acidente."*

`client_id` existe (22 arquivos), mas é outra coisa: é o **grupo econômico
atendido** — Grupo Meridiano, Construtora Vertex — dentro de um tenant. Uma
filial pertence a um cliente; o ticket deriva o cliente da filial.

Adicionar filtro por `client_id` na camada de dados seria **acrescentar uma
segunda fronteira de segurança em paralelo à que já existe**, e é assim que se
cria o caso em que uma delas protege e a outra não. Se o que você quer é um
*seletor de cliente* na interface — "ver só o Grupo Meridiano" —, isso é um
**filtro de visualização**, não escopo de segurança, e eu trataria como tal.

**Preciso saber qual dos dois você quer.**

### 0.2 Os módulos citados não são os deste sistema

O briefing fala em "Financeiro, Projetos, SLA, Suporte, Sistema". Os módulos
reais, tirados do catálogo de permissões, são doze:

`helpdesk` · `sla` · `inventario` · `telefonia` · `conectividade` · `clientes` ·
`fornecedores` · `mapas` · `financeiro` · `usuarios` · `integracoes` · `tv`

**Não existe módulo de Projetos** — zero ocorrências no código e no banco.

### 0.3 A identidade visual descrita não existe aqui

O briefing manda manter "as cores por unidade já definidas (RESIDENCIAL roxo,
MILAGRES laranja, ALIANÇA azul, UNION rosa, MOOVE verde)" e "a identidade dos
Faróis/Objetivos".

Busquei os oito termos em `src/`, `supabase/` e `docs/`: **zero ocorrências**.
(As seis ocorrências de "UNION" são `union all` em SQL.) Esses nomes são de outro
produto.

A identidade que este sistema tem é outra: azul `#1d4ed8` como cor de ação, e
cinco tons semânticos de estado (`ok`, `warn`, `crit`, `breach`, `neutral`) que
comunicam situação de SLA. Vou **preservar essa semântica** — ela carrega
significado operacional, não é decoração — e evoluir o resto. Se as cores por
unidade forem para entrar, preciso saber a que entidade elas se ligam.

### 0.4 A arquitetura não tem "hooks" nem "services"

O briefing pede padronizar "components, services, hooks, utils, types". Aqui não
há camada de API nem de serviços: a leitura acontece em **Server Components** e a
escrita em **Server Actions** (ADR-011), com apenas duas rotas HTTP
(`/api/health` e o retorno do e-mail de recuperação). Só **8 arquivos** usam
`'use client'` com estado.

Criar `services/` e `hooks/` aqui significaria introduzir uma camada que o
framework torna desnecessária. Vou padronizar a estrutura **que existe**.

---

## 1. Inventário

| | |
|---|---|
| Páginas (`page.tsx`) | 29 |
| Rotas HTTP (`route.ts`) | 2 |
| Arquivos de Server Actions | 20 |
| Componentes compartilhados | 14 |
| Arquivos com `'use client'` | 8 |
| Módulos em `src/lib` | 18 |
| Arquivos de teste | 11 (210 testes) |
| Migrações SQL | 25 (365 asserções) |
| **Linhas** | `src/app` 15.566 · `src/lib` 6.333 · `src/components` 1.531 · SQL 7.486 |

Rotas construídas: **30**.

---

## 2. Código morto — há muito menos do que o briefing supõe

Esta é a parte do diagnóstico que contraria a expectativa, e é melhor dizer antes
de prometer uma limpeza grande.

### O que de fato está morto (crítico: nenhum; baixo: tudo)

| Item | Onde | Observação |
|---|---|---|
| `requireRole()` | `src/lib/session.ts` | Função exportada, **zero chamadas**. Sobrou da fase anterior ao catálogo de permissões. |
| `ChangeSource` | `src/lib/types.ts:31` | Tipo declarado, nunca referenciado |
| `PayableApproval` | `src/lib/types.ts:455` | idem — a tabela existe, o tipo não é usado |
| `PayableSummaryRow` | `src/lib/types.ts:466` | idem |
| `RequiredAddressField` | `src/lib/address.ts:38` | idem |
| `@eslint/eslintrc` | `package.json` | Dependência não usada: o `eslint.config.mjs` abandonou o `FlatCompat` e o pacote ficou |
| `vw_payables_summary` | migração 0020 | View criada e **nunca consultada** |
| `vw_telecom_costs` | migração 0007 | Ficou órfã quando a tela passou a ler `vw_telecom_dashboard` |
| `vw_internet_dashboard` | migração 0013 | Nunca consultada — os indicadores de link são calculados em memória, por decisão registrada |

**Total: 9 itens.** É o que há.

### O que eu esperava achar e NÃO achei

| Suspeita | Medição |
|---|---|
| Código comentado | **0 linhas.** Os 10% de comentários (2.248 linhas) são prosa explicativa, que é convenção declarada deste repositório |
| `<button>` sem `type` | **0** (uma varredura ingênua acusa 16; todas têm `type` na linha seguinte) |
| `<img>` sem `alt` | **0** |
| Componentes de mapa duplicados | **Não é duplicação.** `BranchMap` escolhe entre Google e Leaflet conforme exista chave de API — é fallback deliberado |
| Dependências não usadas | Só uma (acima). As outras 17 estão todas em uso |

**Consequência para a Entrega 2:** ela será pequena. Prefiro dizer isso agora a
inflar o escopo para parecer produtiva.

### Superfície de exportação larga (baixo)

Cerca de **30 tipos** são exportados e usados só dentro do próprio arquivo. Não é
código morto — é API pública maior que o necessário. Tirar o `export` deixa claro
o que é contrato e o que é detalhe interno.

---

## 3. Duplicação real — aqui há trabalho

| Padrão repetido | Vezes | Proposta |
|---|---|---|
| `const NOT_AFFECTED = 'Não foi possível salvar…'` | **11 arquivos** | Um único `src/lib/actions/erros.ts` |
| Tratamento de `error.code === '23505'` com mensagem própria | **29 pontos** | Um `mensagemDeErroDeBanco(error, contexto)` que já conhece 23505, 23503, 23514 e `restrict_violation` |
| Tripla `requireSession` + `requirePermission` + `canManageRecords` | **15 arquivos de actions** | Um helper `guardaDeEscrita(chave)` que devolve `{ ctx }` ou `{ error }` |
| Agrupamento anti-N+1 (`new Map` + `for…of`) | **10 páginas** | `agruparPor(linhas, 'campo_id')` em `src/lib/data` |
| Mapas locais `statusTone` | 4 arquivos | Mover para `src/lib/i18n.ts`, junto dos rótulos que já estão lá |
| Bloco de filtros `<form method="get">` | 3 páginas, markup próprio em cada | Um `<FiltroBar>` com os campos como dados |
| `EditPanel` + `ActionForm` + `SubmitButton` | 12 páginas | Já é reutilizado — **não mexer** |

Nenhuma dessas mudanças altera comportamento: são extrações mecânicas, e os 210
testes mais as 365 asserções de banco cobrem o entorno.

---

## 4. Inconsistências de organização

| Achado | Gravidade |
|---|---|
| `src/app/(app)/filas/actions.ts` mistura dois assuntos — 3 ações de fila e 3 de regra de roteamento, 11 exports | Médio |
| `src/lib` tem **10 arquivos soltos** e 4 pastas (`data`, `integrations`, `schemas`, `supabase`) — critério de agrupamento não é óbvio | Médio |
| Nomes de arquivo de formulário quase consistentes: `line-forms`, `asset-forms`, `rule-forms`, `queue-forms`, `area-forms`, `attachment-forms` — mas `clientes/forms.tsx` e `financeiro/titulos/forms.tsx` são genéricos | Baixo |
| **11 cores em hexadecimal** cruas em `src/components/map-marker.tsx` | Baixo — a API de popup do Leaflet/Google exige string de HTML, mas `var(--color-ok-ink)` funcionaria ali e hoje são valores copiados |
| `style={{…}}` em **14 pontos** | Baixo — a maioria é legítima (cor vinda do banco, altura do mapa, duração de animação). Três são valores mágicos que viram token |

---

## 5. Visual e usabilidade — o diagnóstico que mais pesa

### 5.1 Não existe dark mode na aplicação (CRÍTICO para a Entrega 4)

`src/app/globals.css` não tem **nenhuma** regra `prefers-color-scheme` nem
`data-theme`. A única parte escura do sistema é o painel de TV, que tem tokens
próprios (`--color-tv-*`) porque é uma TV numa sala.

O **protótipo** (`demo/sti-tool.html`) tem dark mode completo, com os três
estados (claro, escuro, preferência do sistema). A aplicação não. É uma
divergência real entre o que o cliente viu e o que existe.

### 5.2 A tipografia é exatamente a que o briefing manda evitar

```css
--font-sans: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
```

Não há `next/font`, nem fonte display, nem escala tipográfica. O briefing pede
"fontes distintas e únicas (display + body), nunca Arial, Inter, Roboto" — hoje é
literalmente Roboto e Arial na cadeia.

### 5.3 O design system está pela metade

29 tokens `--color-*` e **mais nada**: nenhum token de espaçamento, raio, sombra,
tipografia ou duração de animação. Os valores vivem espalhados em classes Tailwind
(`rounded-xl`, `gap-3`, `p-4`) repetidas à mão.

### 5.4 Zero `loading.tsx` e zero `error.tsx` em 29 páginas (CRÍTICO)

Toda página é um Server Component que faz `await Promise.all([…consultas…])`.
Hoje:

- **não há estado de carregamento**: a navegação fica parada sem resposta até a
  última consulta voltar — e duas páginas fazem **10 consultas**;
- **não há fronteira de erro**: uma consulta que falhe derruba a página na tela de
  erro padrão do Next, em inglês.

É a lacuna de usabilidade com maior efeito percebido, e a mais barata de fechar.

### 5.5 Outros

| Achado | Gravidade |
|---|---|
| `EmptyState` em 19 de 29 páginas — 10 telas sem estado vazio tratado | Médio |
| Nenhuma transição ou animação além do `hover:` do Tailwind | Médio |
| 34 atributos `aria-*` e 14 `role=` — existe, mas sem cobertura sistemática | Médio |
| Foco visível: **resolvido globalmente** em `globals.css` | — (não é achado) |

---

## 6. Performance

| Medição | Valor |
|---|---|
| JavaScript total servido | **1.309 KB** em 50+ chunks |
| Maior chunk | 245 KB |
| `next/dynamic` | **0** |
| `Suspense` | **0** |
| `useMemo` / `useCallback` / `memo` | 2 |
| `.range()` (paginação) | **0** |

### 6.1 Truncamento silencioso (CRÍTICO — e é correção, não performance)

Não há paginação em lugar nenhum. O que há são **cortes fixos**, e o problema não
é a lentidão: é que o registro 201 **simplesmente não aparece, e a tela não diz
nada**.

| Tela | Corte | O que some sem aviso |
|---|---|---|
| `/tickets` | `.limit(200)` | o 201º ticket |
| `/inventario` | `.limit(400)` | o 401º ativo |
| `/conectividade/links` | `.limit(300)` | o 301º evento de queda |
| `/telefonia`, `/clientes`, `/fornecedores`, `/usuarios`, `/perfis` | **nenhum** | nada some, mas a consulta traz a tabela inteira |

### 6.2 O que já está certo

O padrão anti-N+1 (uma consulta para todos os registros, agrupada em memória)
está aplicado em **10 páginas** — está documentado no código e funciona. Não vou
mexer.

### 6.3 Oportunidades

- `leaflet` entra no bundle de quem nunca abre o mapa → `next/dynamic`
- Páginas com 10 consultas em paralelo → `Suspense` por bloco, para a tela
  aparecer em partes
- Listas sem corte → paginação por `.range()`

---

## 7. Plano de ação proposto

A ordem difere um pouco do briefing por uma razão: **a Entrega 2 é pequena** (9
itens de código morto) e a dívida real está na duplicação e nos estados de tela.
Proponho fundir e redistribuir, mantendo os sete pontos de parada.

| Entrega | Conteúdo | Tamanho | Risco |
|---|---|---|---|
| **2** | Remover os 9 itens mortos · consolidar as 7 duplicações da §3 · reduzir a superfície de exportação | Médio | Baixo — extrações mecânicas com testes em volta |
| **3** | Separar `filas/actions.ts` · reorganizar `src/lib` · padronizar nomes de formulário · tokens de espaçamento/raio/sombra/tipografia em `globals.css` · `map-marker` passa a usar `var()` | Médio | Baixo |
| **4** | **Dark mode completo** (os três estados) · tipografia display + body via `next/font` · escala tipográfica · micro-interações e motion · refino de botões, inputs, cards, tabelas e modais | Grande | Médio — é o que mais muda a tela |
| **5** | `loading.tsx` e `error.tsx` em todas as rotas · estados vazios nas 10 telas que faltam · revisão de `aria-*` e ordem de tabulação · responsividade | Grande | Baixo |
| **6** | Paginação real nas listas · `next/dynamic` no mapa · `Suspense` nas páginas de 10 consultas · medição antes × depois | Médio | Médio — mexe em consulta |
| **7** | Revisão de consistência, build, 210 testes, 365 asserções, 44 asserções de navegador, comparativo | Pequeno | — |

### Regra que vou seguir em todas

Nenhuma regra de negócio, cálculo, policy de RLS, migração ou fluxo é alterado.
Ao fim de cada entrega: `tsc`, `eslint`, 210 testes, 365 asserções contra
PostgreSQL real, build e as 44 asserções de navegador — e o relatório do que
mudou.

---

## 8. O que preciso de você antes da Entrega 2

1. **`client_id`**: filtro de visualização na interface, ou algo mais? (§0.1)
2. **Identidade visual**: as cores por unidade e os Faróis/Objetivos entram neste
   sistema? Se sim, ligadas a qual entidade? (§0.3)
3. **Tipografia**: posso escolher o par display + body, ou há fonte de marca?
4. **Ordem**: aceita o plano da §7, ou prefere a sequência literal do briefing?

Com isso respondido, sigo para a Entrega 2.

---
---

# Entrega 2 — Limpeza e consolidação (executada)

Aprovada com "pode seguir". As três perguntas de identidade visual e `client_id`
**continuam abertas** — nenhuma delas afeta esta entrega, e as duas primeiras são
pré-requisito da Entrega 4.

## O que foi removido

| Item | Onde |
|---|---|
| `requireRole()` | `src/lib/session.ts` — função exportada, zero chamadas |
| `ChangeSource`, `PayableApproval`, `PayableSummaryRow` | `src/lib/types.ts` |
| `RequiredAddressField` | `src/lib/address.ts` |
| `@eslint/eslintrc` | `package.json` — sobrou do `FlatCompat` abandonado |
| `vw_telecom_costs` | migração **0026** — ver abaixo |

## O que foi consolidado

| Antes | Depois | Alcance |
|---|---|---|
| Guarda de escrita copiada no topo de cada ação | `permitirEscrita()` em `src/lib/actions/guarda.ts` | **52 ações**, 9 arquivos |
| `const NOT_AFFECTED = …` declarado em cada arquivo | `NAO_AFETADO` em `src/lib/actions/erros.ts` | **11 arquivos, 41 usos** |
| `if (error.code === '23505') …` reimplementado | `mensagemDeErro(error, duplicado?)` | **12 pontos** |
| Laço `new Map` + `for…of` para agrupar filhos | `agruparPor(linhas, 'chave')` em `src/lib/data/agrupar.ts` | **9 páginas** |
| Mapas `statusTone` locais | `assetStatusTone`, `contractStatusTone`, `integrationStatusTone` em `src/lib/i18n.ts` | 4 páginas — dois eram byte a byte idênticos |

`mensagemDeErro` passou a tratar `23503` (registro em uso), `23502` (campo
obrigatório) e `42501` — que antes vazavam para a tela **em inglês, com nome de
constraint**. É a única mudança de comportamento da entrega, e ela atende à regra
final do briefing: *"mensagens de erro claras e acionáveis, sem expor detalhes
técnicos internos"*.

A mensagem específica de duplicidade **não** foi unificada. "Já existe um ativo
com este patrimônio" e "Já existe uma área com este nome nesta filial" dizem onde
está o conflito; trocá-las por um genérico seria perder informação para ter menos
linhas.

## Três coisas que eu decidi NÃO fazer, e por quê

**1. Não unifiquei as outras ~35 guardas.** Existem duas formas de guarda no
código: 52 ações checam permissão **e** papel; cerca de 35 checam só a permissão.
Isso não é descuido de estilo — é diferença real. As que não checam o papel
dependem do RLS para barrar (e ele barra: a policy de escrita exige
`app.can_manage_records()`). Convertê-las acrescentaria uma checagem que hoje não
existe, mudando a mensagem que a pessoa vê de "não encontrado ou sem permissão"
para "sem permissão".

É provavelmente o certo a fazer — mas é **mudança de comportamento**, e esta
entrega não faz isso. Fica como decisão para a Entrega 3.

**2. Não removi `vw_payables_summary` nem `vw_internet_dashboard`.** Também não
têm leitor, mas o critério da remoção foi *duplicação*, não *falta de leitor*:
nenhuma das duas repete outra view, as duas encodam agregação própria, e view não
consultada não custa nada em execução — não entra em bundle nem pesa em consulta
que não a usa. Só `vw_telecom_costs` saiu, por ser **subconjunto estrito** de
`vw_telecom_dashboard`, que a tela passou a ler na 0025.

**3. Não criei um componente genérico de filtro.** O briefing pede "um único
componente de filtro de período". Não há filtro de período repetido: as três telas
com filtro (`/tickets`, `/telefonia`, `/financeiro/fluxo-de-caixa`) filtram coisas
diferentes, e os três invólucros são diferentes — um dentro de `Card`, um em barra
solta, um sem link de limpar. Um componente que aceitasse as três formas teria
mais código do que remove.

## Um defeito encontrado durante a limpeza

`scripts/gerar-instalador.py` calculava as views contando `create view` nas
migrações. Assim que a 0026 derrubou uma, o cabeçalho do instalador passou a
anunciar **18 views onde o banco tem 17**. Número calculado também envelhece
quando se calcula a coisa errada — agora o script percorre `create` e `drop` **na
ordem de execução**. Confere com o banco: 58 tabelas, 17 views.

Na mesma passada, `docs/04` dizia 18 views.

## Verificação — antes × depois

| | Antes | Depois |
|---|---|---|
| `tsc` | limpo | limpo |
| `eslint` | limpo | limpo |
| Testes unitários | 210 | **210** |
| Asserções de banco | 365 | **365** |
| Asserções em navegador | 44, zero erro | **44, zero erro** |
| Build | 32 rotas | **32 rotas** |

Nenhum teste foi alterado para acomodar a refatoração — é essa a prova de que o
comportamento não mudou.

---

# Entrega 3 — Organização e padronização (executada)

As quatro perguntas de §8 foram respondidas: `client_id` é **escopo de dados e
filtro de visualização**, a cor de identificação é **por empresa-cliente**, e a
repaginada pode mudar a paleta. Esta entrega implementa a primeira resposta e
prepara o terreno das outras duas; tipografia e dark mode são da Entrega 4,
porque mudam valores e não estrutura.

## 1. Escopo por cliente — o que foi construído

### A distinção que governa tudo o que vem abaixo

**O foco por cliente não é fronteira de segurança.** O isolamento entre tenants
continua sendo `tenant_id` no JWT, aplicado por 162 policies de RLS (ADR-002).
Se o escopo tiver um defeito, a pessoa vê dados do **próprio** tenant fora do
foco que escolheu — nunca de outro cliente da plataforma.

É por isso que ele **não virou policy de RLS**: o Gestor de TI atende vários
clientes de propósito, e uma policy por cliente transformaria uma preferência de
visualização em perda de acesso ao parque que ele administra.

| Peça | Onde | O que faz |
|---|---|---|
| `profiles.focused_client_id` | migração 0027 | a escolha, por pessoa. FK composta `(focused_client_id, tenant_id)` |
| `clients.color` | migração 0027 | identidade visual da empresa, como **dado** e não mapa de nomes no código |
| `escopoDeCliente()` | `src/lib/data/escopo.ts` | o foco da sessão, com as filiais resolvidas, em `cache()` de requisição |
| `porCliente` · `porClienteOuGeral` · `porFilial` · `porFilialOuGeral` | idem | aplicam o foco a uma consulta |
| `definirFocoDeCliente` | `src/app/(app)/actions.ts` | troca o foco; `revalidatePath('/', 'layout')` |
| `<ClientFocus>` | `src/components/client-focus.tsx` | o seletor no cabeçalho |

### A regra única das colunas nulas

**O foco exclui o que é de outro cliente; nunca exclui o que não é de cliente
nenhum.** Coluna nula significa "do tenant inteiro": uma licença comprada para
todo mundo, um chamado interno, um título que não se aloca a nenhuma unidade.
Escondê-los faria o total da tela ficar errado **para menos** — o erro que
ninguém percebe.

Daí existirem quatro funções e não duas: qual usar não é estilo, é a
nulabilidade da coluna no banco.

| Forma | Função | Entidades |
|---|---|---|
| `client_id` obrigatório | `porCliente` | `branches`, `sla_contracts` |
| `client_id` nulável | `porClienteOuGeral` | `tickets`, `receivables` |
| `branch_id` obrigatório | `porFilial` | `internet_links`, `branch_areas` |
| `branch_id` nulável | `porFilialOuGeral` | `it_assets`, `telecom_lines`, `payables`, `cost_centers` |
| **sem relação com cliente** | — | `bank_accounts`, `suppliers`, `queues`, `profiles`, `integrations` |

A última linha é a que mais importa: aplicar o escopo onde ele não existe
esvaziaria a tela inteira. Conta bancária é do tenant, não do cliente.

### Onde o escopo foi aplicado

Onze telas: `/tickets`, `/filas`, `/filas/[slug]`, `/painel`, `/inventario`,
`/telefonia`, `/conectividade/links`, `/clientes`, `/sla`, `/mapas`,
`/financeiro/titulos-a-pagar`, `/financeiro/titulos-a-receber` e
`/financeiro/fluxo-de-caixa`.

Três decisões que valem registro, porque em cada uma a escolha óbvia estava
errada:

1. **Lookup de formulário NÃO entra no escopo.** Só a lista entra. Um `<select>`
   que perde a opção já gravada no registro faria o campo voltar vazio ao salvar
   — o escopo apagaria dado em vez de filtrar vista.
2. **`/clientes` filtra em memória**, e é a única tela assim. `getClients()` é a
   mesma consulta que alimenta o seletor do cabeçalho; filtrá-la no banco
   deixaria o seletor com uma opção só e trancaria a pessoa dentro do cliente
   escolhido, sem caminho de volta.
3. **A projeção de caixa recebeu um parâmetro, não um filtro.**
   `cash_flow_projection` soma títulos, saldo de abertura e movimentos futuros
   numa consulta só; filtrar o resultado depois não teria como descontar o que já
   entrou no saldo. O foco virou `p_client_id` dentro da função (0027), o que
   exigiu `drop` antes do `create`: em Postgres a lista de argumentos faz parte da
   identidade da função, e um `create or replace` com um parâmetro a mais criaria
   uma **segunda** função, tornando a chamada de quatro argumentos ambígua.

**Centros de custo ficaram de fora, de propósito.** São uma hierarquia de até
três níveis renderizada por `parent_id`; filtrar por filial esconderia um
ancestral e os filhos sumiriam da árvore sem aviso — o escopo quebraria a tela em
vez de estreitá-la.

### `[LACUNA]` O bloco de métricas do painel não respeita o foco

`vw_dashboard_metrics` agrega por tenant e devolve **uma linha**. Respeitar o
foco exigiria agrupá-la também por cliente, o que quebraria o `maybeSingle()` de
quem não tem foco nenhum. Está registrado no código, onde alguém vai ler, em vez
de virar um número que diverge do resto da tela sem explicação.

`vw_agents_online` fica fora para sempre: conta **pessoas**, que são do tenant e
não do cliente.

## 2. Padronização da camada de dados

| O que estava espalhado | Quantas cópias | Onde ficou |
|---|---|---|
| `interface ActionState` dentro de `tickets/actions.ts` | importada por **18 módulos**, incluindo um componente de cliente | `src/lib/actions/estado.ts` |
| `z.string().uuid('Seleção inválida.')` | **11 cópias**, em 5 arquivos | `uuid`, em `src/lib/schemas/campos.ts` |
| coerção `'' → null` + UUID | 3 cópias além da compartilhada | `optionalUuid`, idem |
| `src/lib/form-schemas.ts` | pasta `schemas/` existia ao lado | `src/lib/schemas/campos.ts` |

O `ActionState` é o caso que mais importava: um arquivo `'use server'` é o pior
lugar possível para um tipo compartilhado. O import só sobrevivia por ser `import
type` e sumir na compilação; esquecer o `type` uma única vez arrastaria o módulo
inteiro de ações de ticket para dentro do bundle do navegador.

## 3. Tokens de design

Os tokens de **cor** já existiam (29). Faltavam os de forma, e o que havia de
valor solto não estava em CSS, e sim em TypeScript.

- **Raio de borda** virou token: `--radius-md/lg/xl`, declarados nos **mesmos
  valores** que o Tailwind já aplicava. `rounded-lg` aparece em 51 lugares e
  `rounded-xl` em 22 — eram dois números espalhados por 73 usos, sem nome. Não há
  mudança visual aqui de propósito: mexer na forma junto com a mudança de
  estrutura tornaria impossível saber qual das duas causou uma diferença na tela.
- **`map-marker.tsx` perdeu seis cores literais.** O popup é HTML comum no
  documento da página, então usa `var()`.
- **As três cores do pino continuam em hexadecimal, e isso é obrigatório:** o SVG
  vira uma `data:` URI, e documento de data URI não enxerga as custom properties
  da página — `var()` resolveria para nada e o pino sairia preto. O que tinha
  conserto era a **divergência**: `src/components/map-marker.test.ts` lê
  `globals.css` e exige que os três valores sejam exatamente
  `--color-marker-green/amber/red`. A Entrega 4 troca a paleta; sem esse teste, os
  pinos ficariam com a cor antiga e o sintoma seria um verde levemente diferente
  num mapa, não um erro.

**Elevação e escala tipográfica não entraram.** A aplicação não usa `shadow-*` em
lugar nenhum hoje, e inventar uma escala de sombra agora seria decidir a
repaginada por antecipação, na entrega errada. Vão com a Entrega 4.

Um efeito colateral útil: `vitest.config.ts` ganhou o alias `@/` do
`tsconfig.json`. Sem ele, um teste que importasse de `src/components` falhava com
"Cannot find package '@/lib/maps'" — o caminho resolvia no editor e no build e só
não resolvia no teste, que é o tipo de atrito que faz alguém não escrever o teste.

## Verificação — antes × depois

| | Entrega 2 | Entrega 3 |
|---|---|---|
| `tsc` | limpo | limpo |
| `eslint` | limpo | limpo |
| Testes unitários | 210 | **216** (+6, cor do pino e escape do popup) |
| Asserções de banco | 365 | **377** (+12, seção 32) |
| Asserções em navegador | 44, zero erro | **44, zero erro** |
| Build | 32 rotas | **32 rotas** |
| Catálogo de permissões | 151 chaves | **151 chaves** (o foco não é permissão) |

As doze asserções novas cobrem o que a aplicação sozinha não provaria: a FK
composta recusa o cliente de outro tenant; `on delete set null` não trava a
exclusão do cliente; a cor recusa formato inválido e aceita maiúscula; a projeção
sob foco soma o título da filial do cliente **e** o que não tem filial; e existe
**uma só** `cash_flow_projection` — a prova de que o `drop` funcionou e a chamada
de quatro argumentos não ficou ambígua.

Nenhum teste existente foi alterado.

---

# Entrega 4 — Design system e repaginada visual (executada)

Nenhuma regra de negócio, cálculo, integração ou fluxo foi tocado. O que mudou
foi a camada que decide **como** a aplicação aparece — e ela passou a ser
verificável, que é a parte que costuma faltar numa repaginada.

## 1. Tipografia: duas famílias, dois papéis

Saiu `system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial`.
Essa pilha dava **três aparências diferentes** para a mesma tela em Windows,
macOS e Android, e nenhuma delas era uma decisão de ninguém.

| Papel | Família | Por quê |
|---|---|---|
| Display — títulos, números de destaque, painel de TV | **Space Grotesk** | Desenho próprio e algarismos de largura fixa. Metade desta aplicação é número grande — saldo, contagem de ticket, TV a cinco metros — e algarismo tabular é o que impede a coluna de dançar a cada atualização em tempo real |
| Corpo — texto, tabela, formulário | **IBM Plex Sans** | Desenhada para interface técnica densa: abre bem em 12–14px e distingue `l`/`I`/`1` e `0`/`O`, que numa tela de patrimônio e número de série é a diferença entre ler certo e abrir chamado errado |

Carregadas por `next/font`, o que subsetifica, auto-hospeda e evita a requisição
ao domínio de terceiros. `display: 'swap'` é deliberado: o texto aparece na fonte
de recurso e troca quando a web font chega — `block` esconderia o conteúdo por
até três segundos numa tela de operação.

## 2. Tema claro e escuro

A aplicação não tinha nenhum. Agora tem três estados, não dois: **claro**,
**escuro** e **sistema** — que é o padrão. Um interruptor de duas posições
obriga a escolher, e a escolha que a maioria quer é "o que o meu sistema já
decidiu", que num botão de duas posições simplesmente não existe.

Três detalhes carregam quase toda a dificuldade:

1. **O lampejo branco.** Um script síncrono e inline no `<head>` lê o
   `localStorage` e escreve `data-tema` **antes da primeira pintura**. Qualquer
   outra coisa — efeito, componente, arquivo externo — acontece tarde demais e a
   tela pisca em branco antes de escurecer.
2. **A escolha explícita vence a do sistema.** A media query é condicionada a
   `:root:not([data-tema='claro'])`. Sem isso, alguém com o computador em modo
   escuro clicaria em "claro" e nada aconteceria — e num teste manual feito num
   monitor claro esse defeito **nunca** aparece. Há uma asserção só para ele.
3. **`color-scheme`.** É o que faz barra de rolagem, campo nativo e seletor de
   data do navegador acompanharem o tema. Sem ele a aplicação fica escura com
   uma barra de rolagem branca atravessada no meio.

O estado mora no `<html>`, não no React, e é lido com `useSyncExternalStore` —
copiá-lo para um `useState` dentro de um efeito abriria a janela em que os dois
discordam, e o React 19 recusa a construção justamente por isso.

**O painel de TV não participa do tema**, e isso é verificado. Ele usa apenas
`--color-tv-*`, que não têm variante clara. Um token temável entrando ali faria
a TV da parede ficar **branca** assim que aquele computador estivesse em modo
claro — e ninguém no escritório saberia o que aconteceu nem como desfazer.

## 3. A paleta, e os três tokens que ela obrigou a criar

| Token | O problema que resolve |
|---|---|
| `--color-on-brand` | Era `text-white`, em onze lugares. No tema escuro o preenchimento da marca é que clareia, e branco sobre azul claro não chega a 4.5:1 |
| `--color-danger-solid` · `--color-ok-solid` · `--color-on-solid` | O botão "Excluir" usava `--color-breach-ink`, que no escuro clareia porque ali ele é **texto**. O resultado era um botão destrutivo de vermelho claro, mais chamativo que o primário — hierarquia invertida, com a ação perigosa no topo |
| `--color-border-strong` | O fio de 1px de um campo de formulário é "componente de interface" para a WCAG 1.4.11 e precisa de 3:1; o fio decorativo de cartão não precisa. Com o mesmo cinza nos dois, o campo sumia dentro do cartão branco e só reaparecia ao receber foco |

Também entraram `--shadow-card` / `--shadow-overlay` (duas, e só duas: uma escala
de seis sombras vira seis decisões por tela e nenhuma hierarquia) e os tokens de
movimento `--ease-padrao` / `--duracao-rapida` / `--duracao-padrao`.

### Contraste: medido, não prometido

`src/app/tokens.test.ts` lê `globals.css`, aplica a fórmula da WCAG 2.1 e mede
**as combinações que as telas realmente produzem**, nos dois temas — 61
asserções. Nenhuma cor escrita à mão no teste: se a paleta mudar e o arquivo
não, o teste mede a paleta nova.

AA conferido uma vez, à mão, no dia da entrega, dura até a primeira pessoa
clarear um cinza porque "ficou melhor assim". E o sintoma de uma falha dessas
não é um erro: é alguém com baixa visão, num monitor pior que o nosso, que não
consegue ler a dica do campo — e não reporta, porque acha que o problema é a
vista dele.

O teste também cobre dois defeitos de estrutura que não são de contraste: os
dois blocos do tema escuro (escolha explícita e preferência do sistema)
precisam definir **a mesma** paleta, e nenhum token de superfície, tinta ou
semáforo pode ficar sem valor no escuro — um token esquecido vira mancha branca
no meio da tela escura, ou texto cinza-claro sobre fundo branco, que é pior.

## 4. Movimento

Uma duração e uma curva, em token, e duas aplicações:

- transição de cor e sombra em `a`, `button`, `summary` e nos controles de
  rádio/aba. **Só cor e sombra**: mover geometria no hover faz a tela "respirar"
  e cansa em oito horas de uso;
- `entrar` — quatro pixels e 180ms ao trocar de tela. É direção, não animação.

O bloco `prefers-reduced-motion` que já existia desliga os dois.

## 5. A cor por empresa, aplicada

`clients.color` (migração 0027) saiu do banco para a tela: campo no cadastro de
cliente, bolinha ao lado do nome em `/clientes` e no seletor de foco do
cabeçalho. É `aria-hidden` — a cor é reconhecimento de relance, não informação, e
anunciar "círculo azul" a cada cliente só acrescentaria ruído a quem usa leitor
de tela.

A validação virou `hexColor` em `src/lib/schemas/cadastros.ts`, compartilhada com
a cor da prioridade: duas expressões regulares para a mesma regra divergiriam na
primeira vez que uma delas aceitasse três dígitos.

**A cor é obrigatória no esquema** porque a coluna é NOT NULL. Deixá-la opcional
faria o formulário "salvar" e o banco aplicar o cinza padrão — a pessoa
escolheria uma cor, veria a confirmação e encontraria outra na tela, sem erro
nenhum para explicar.

## 6. O que NÃO foi feito, e por quê

**O protótipo (`demo/sti-tool.html`) não foi repaginado.** Ele é a referência de
**comportamento** — é com ele que `prototipo.spec.mjs` prova regra de permissão
em navegador —, e repintá-lo agora significaria manter duas folhas de estilo em
sincronia manual sem nenhum teste cobrindo a segunda. Se a repaginada precisar
chegar até ele, isso é uma decisão a tomar por si, não um resto desta entrega.

**Nenhuma escala tipográfica nova.** Os tamanhos continuam os do Tailwind. Trocar
família e escala na mesma entrega tornaria impossível saber qual das duas causou
uma diferença de leitura.

## Verificação — antes × depois

| | Entrega 3 | Entrega 4 |
|---|---|---|
| `tsc` | limpo | limpo |
| `eslint` | limpo | limpo |
| Testes unitários | 216 | **278** (+62: 61 de tema e contraste, 1 da cor do cliente) |
| Asserções de banco | 377 | **377** |
| Asserções em navegador | 44, zero erro | **44, zero erro** |
| Build | 32 rotas | **32 rotas** |
| Combinações de tema verificadas em navegador | — | **4/4** |

**Sobre as "30 rotas" das tabelas anteriores:** era número copiado adiante, não
recontado. O build imprime **32** — e imprimia 32 na entrega 3 também. Corrigido
aqui e nas duas tabelas acima, pela mesma razão que fez o contador do instalador
ser reescrito na entrega 2: número escrito à mão envelhece em silêncio.

As quatro combinações de tema foram exercitadas em Chromium contra o build de
produção: sistema claro sem escolha, sistema escuro sem escolha, sistema claro
com "escuro" escolhido e **sistema escuro com "claro" escolhido** — esta última é
a que o `:not()` existe para salvar. As quatro resolveram o fundo correto, sem
erro de console.

---

# Entrega 5 — UX, acessibilidade e responsividade (executada)

## 0. Uma correção ao diagnóstico

O relatório da Entrega 1 dizia "estado vazio falta em 10 telas". Conferindo uma
a uma, **sete delas não têm lista nenhuma**: `/conta`, `/tickets/[id]`,
`/tickets/novo`, `/login`, `/recuperar-senha`, `/nova-senha` e a raiz. Estado
vazio ali seria componente sem caso de uso.

Faltava de verdade em **duas**: `/tv`, que tinha a informação certa numa forma
própria (um `Card` com um parágrafo, que não se parecia com o vazio de nenhuma
outra tela), e `/mapas`, que não tinha nada. O número do diagnóstico estava
inflado, e dizer isso é mais útil que entregar oito componentes para fechar uma
conta errada.

## 1. O que realmente faltava: limite de carregamento e de erro

A aplicação tinha **zero** `loading.tsx` e **zero** `error.tsx`. O efeito do
primeiro era visível todos os dias: ao clicar em "Inventário", a tela anterior
ficava parada até a última das dez consultas voltar. Sem sinal nenhum, o clique
parecia não ter funcionado — e o segundo clique, esse sim, atrapalhava.

| Arquivo | Cobre |
|---|---|
| `src/app/(app)/loading.tsx` | Todas as 25 telas autenticadas |
| `src/app/(app)/error.tsx` | Falha em qualquer uma delas |
| `src/app/global-error.tsx` | Falha no próprio layout raiz |
| `src/app/not-found.tsx` | Endereço inexistente e todo `notFound()` |
| `src/app/icon.svg` | O ícone de aba que não existia |

**Um `loading.tsx` cobre as 25.** No App Router o limite de Suspense vale para
todo segmento abaixo que não tenha o seu. A alternativa seriam 25 esqueletos
para manter em dia com 25 layouts — e esqueleto desatualizado é pior que
genérico, porque promete uma forma que não chega. Como o limite fica DENTRO do
layout, cabeçalho e menu permanecem na tela durante a troca: a pessoa não perde
o contexto nem a posição do menu enquanto espera.

**A tela de erro não mostra `error.message`.** Numa falha de banco essa mensagem
traz nome de tabela, de coluna e às vezes o SQL; para quem queria lançar um
título não ajuda em nada, e para quem não deveria conhecer o esquema é
informação de graça. O que aparece é o que a pessoa pode fazer — e **dois**
caminhos, não um: "tentar de novo" resolve a falha passageira, mas quando não
resolve, insistir no mesmo botão é o único caminho que resta. O link para a
Visão geral está ao lado desde o começo. O `digest` fica à vista porque é a
única coisa ali que serve ao suporte, e serve justamente por não dizer nada
sozinho.

O 404 trata "não existe" e "o RLS não me entregou" **do mesmo jeito**, de
propósito: dizer "este ticket existe, mas não é seu" confirmaria a existência do
registro a quem não pode vê-lo.

## 2. A regra de mensagem de erro, que o código ainda violava

O briefing pede mensagens "sem expor detalhes técnicos internos".
`mensagemDeErro` tinha **dois** caminhos que expunham:

- `default: return error.message` — qualquer erro não previsto ia cru para a
  tela. `could not connect to server: ECONNREFUSED` na cara de quem lança uma
  despesa;
- `case '23514': return error.message` — o comentário dizia que esse código vem
  das nossas triggers, e **vem**, em dezessete lugares. Mas `23514` é também o
  código de uma CHECK constraint comum, e aí quem escreve a frase é o Postgres:
  `new row for relation "clients" violates check constraint "clients_color_hex"`.

Os dois agora passam por um filtro, e o texto cru vai para o log do servidor —
onde serve a quem investiga, em vez de assustar quem trabalha. O SQLSTATE
acompanha a mensagem genérica pela mesma razão que o `digest` acompanha a tela
de erro.

Distinguir "nossa trigger" de "Postgres" pelo texto é heurística, e está
admitida como tal no código: a alternativa seria dar às nossas triggers um
SQLSTATE próprio, que é mudança de banco e não cabe numa entrega de código e
visual.

`src/lib/actions/erros.test.ts` cobre os dois casos, e termina com uma varredura
sobre todos os códigos conhecidos exigindo que **nenhuma** mensagem devolvida
contenha jargão de banco — porque cada caso testa um ramo, e um ramo novo entra
sem teste.

## 3. Acessibilidade: três correções concretas

**Tabela que rola só com o dedo.** Todas as 20 tabelas vivem num `div` com
`overflow-x`, que rola com ponteiro ou toque e **não** com teclado. Quem navega
por teclado chegava ao fim da tabela sem nunca ver as últimas colunas — e as
últimas colunas são sempre situação e ação, que é onde está o trabalho
(WCAG 2.1.1). O invólucro ganhou `tabIndex={0}` e `role="region"`.

**Vinte tabelas com o mesmo nome.** Com `role="region"` elas entram na lista de
regiões do leitor de tela, e vinte "tabela de dados" não ajudam ninguém. Cada
chamada passou a declarar o seu: "Títulos a pagar", "Regras de roteamento",
"Projeção de caixa mês a mês".

**O menu falava antes da página.** Os rótulos de grupo da barra lateral eram
`<h2>`, e o menu vem antes do `<main>` no documento: quem navega por títulos
ouvia "Atendimento, Financeiro, Infraestrutura…" antes do `<h1>` da tela, e a
hierarquia começava no nível 2. Viraram texto comum com `aria-labelledby` na
lista — ao entrar no grupo o leitor anuncia "Atendimento, lista com 4 itens",
que é mais informação do que o `<h2>` dava, e sem nenhuma linha no índice de
títulos.

## 4. O teste de navegador que a aplicação não tinha

`demo/tests/aplicacao.spec.mjs`. O protótipo tinha 44 asserções em navegador; a
aplicação, nenhuma — e três coisas das entregas 4 e 5 **só** existem no
navegador: a resolução do tema, o foco visível e o comportamento em tela
estreita. As três falham em silêncio: ninguém abre chamado dizendo "o contorno
de foco sumiu".

Ele achou um defeito na primeira execução: **não havia ícone de aba**. O
navegador pedia `/favicon.ico` a cada navegação, levava 404 e registrava um erro
no console — ruído permanente, que é o que esconde o erro de verdade quando ele
vem.

São 16 asserções: rotas públicas sem erro **nem recurso faltando**, as quatro
combinações de tema, as duas famílias tipográficas efetivamente aplicadas (e
nenhuma das proibidas), contorno de foco com 3px na primeira tabulação, ausência
de rolagem horizontal em 360px, e o ícone respondendo 200.

**O que ele não cobre, e por quê.** Só as rotas públicas. `src/proxy.ts` guarda
toda rota, então sem um Supabase de verdade (docs/09) não há sessão — e fingir
uma testaria o dublê, não o sistema. Uma primeira versão deste arquivo afirmava
"rota inexistente responde 404" e **oscilava**: com uma URL de Supabase
inventada, a chamada de autenticação às vezes falha rápido e às vezes estoura o
tempo, e os dois caminhos terminam em páginas diferentes. Asserção que oscila é
pior que asserção ausente — ela ensina a ignorar o vermelho. Foi removida, com o
motivo escrito no lugar dela.

## Verificação — antes × depois

| | Entrega 4 | Entrega 5 |
|---|---|---|
| `tsc` | limpo | limpo |
| `eslint` | limpo | limpo |
| Testes unitários | 278 | **288** (+10 de mensagem de erro) |
| Asserções de banco | 377 | **377** |
| Asserções no protótipo | 44, zero erro | **44, zero erro** |
| Asserções na aplicação, em navegador | — | **16, zero erro** |
| Build | 32 rotas | **33 rotas** (a 33ª é o `/icon.svg` que faltava) |

---

# Entrega 6 — Desempenho (executada)

## 0. Duas correções ao diagnóstico, antes de qualquer coisa

O relatório da Entrega 1 errou em dois pontos deste tema, e os dois teriam me
feito gastar a entrega no lugar errado.

**"`next/dynamic` para o Leaflet".** O Leaflet **já** é carregado sob demanda:
`leaflet-branch-map.tsx` faz `import('leaflet')` em tempo de execução desde
antes desta auditoria. Não havia nada a adiar ali.

**"linha de base de 1309 KB de JavaScript".** Esse número era o tamanho de
`.next/static` no disco — todas as rotas, todos os pedaços — e foi apresentado
como se fosse o que uma página baixa. Medindo o que o navegador realmente puxa
na rota mais leve: **515 KB**, e dentro deles não há Leaflet, nem Zod, nem o
cliente do Supabase. É o runtime do React 19 com o do Next 16, que é o piso do
framework.

Conclusão desagradável e verdadeira: **não havia problema de bundle para
resolver.** O problema de desempenho desta aplicação está inteiro no servidor, e
é onde esta entrega atua.

## 1. O defeito real: duas formas de errar o tamanho da consulta

| Tela | Antes | Sintoma |
|---|---|---|
| `/tickets` | `.limit(200)` | **Trunca em silêncio** |
| `/inventario` | `.limit(400)` | idem |
| `/conectividade/links` | `.limit(300)` | idem |
| `/financeiro/titulos-a-pagar` | nenhum limite | **Traz tudo** |
| `/financeiro/titulos-a-receber` | nenhum limite | idem |
| `/telefonia` | nenhum limite | idem |

As duas são ruins, por motivos opostos. **O teto mente:** a consulta corta em
200 e a tela não diz nada — quem tem 240 tickets abertos trabalha a semana
inteira sem saber que 40 existem. Não há erro, não há aviso, não há sintoma: há
200 linhas e uma lista que parece completa. **A ausência de teto trava:**
`/financeiro/titulos-a-pagar` trazia todos os títulos, de todos os meses, com
todas as colunas, e o travamento viria de uma vez, no dia em que o acervo
crescesse.

As seis telas agora paginam de verdade, em páginas de 50, com `?pagina=` na
barra de endereço e um rodapé que diz **"51–100 de 412"** — o total é a parte
que importa, e era exatamente a que não existia.

Cada consulta paginada ganhou **desempate por `id`**. Sem ele, duas linhas com o
mesmo `due_on` (ou dois ativos sem patrimônio) trocam de lugar entre uma página
e outra: uma aparece duas vezes e a outra, nunca. É o defeito de paginação mais
fácil de não notar e o mais difícil de explicar depois.

## 2. O que a paginação ia quebrar, e a migração que existe para impedir

Cinco dessas telas calculavam os indicadores do topo **a partir da lista
inteira** — `lista.filter(...).length`, `lista.reduce(...)`. Paginar a consulta e
parar por aí teria transformado "Ativos cadastrados: 412" em "Ativos
cadastrados: 50".

Isso é pior que a truncagem que a entrega veio corrigir: a truncagem esconde
linhas; o número errado **afirma uma coisa falsa com cara de fato**.

A migração **0028** dá a cada tela paginada a sua fonte de total:

| View | Situação | Serve a |
|---|---|---|
| `vw_payables_summary` | existia desde a 0020, **sem nenhum leitor** — recriada com `branch_id` | `/financeiro/titulos-a-pagar` |
| `vw_internet_dashboard` | existia desde a 0013, **sem nenhum leitor** — ganhou `links_unknown` e `expirados` | `/conectividade/links` |
| `vw_receivables_summary` | nova, com `client_id` | `/financeiro/titulos-a-receber` |
| `vw_assets_summary` | nova, com `branch_id` | `/inventario` |
| `vw_telecom_dashboard` | já era lida | `/telefonia` |

Duas views órfãs finalmente ganharam leitor. Não por elegância: elas já
continham quase exatamente a conta que a aplicação refazia em JavaScript.

**Todas carregam a coluna do escopo** — `branch_id` nas de patrimônio e despesa,
`client_id` na de receita. Sem isso, o foco por empresa estreitaria a lista e
deixaria o indicador em cima dela contando o tenant inteiro: dois números na
mesma tela, discordando, sem nada que explique. É o defeito que
`vw_dashboard_metrics` ainda tem, registrado como lacuna na Entrega 3.

**Nenhuma regra mudou.** Cada view reproduz o filtro que a tela já aplicava,
inclusive onde eu discordo dele — e aí o comentário na migração diz que discordo,
e a regra fica:

- a garantia do inventário mantém o piso em `current_date`, que a tela já tinha e
  cujo motivo está escrito lá: sem ele, garantia vencida há anos contaria como
  "vencendo em 90 dias" para sempre;
- o aviso de contrato de link **não** tem esse piso: contrato terminado há dois
  anos continua contando como "vigência terminando nos próximos 90 dias". Essa é
  a regra da tela hoje; trocá-la muda um número que alguém lê todo dia, e é
  decisão de produto, não de refatoração. **`[DECISÃO PENDENTE]`**

## 3. O ganho maior, que não aparece em nenhum gráfico

As consultas auxiliares passaram a buscar **só os registros da página**.

`/inventario` trazia a timeline de custódia inteira (até 400 eventos) e os anexos
do parque inteiro, para alimentar gavetas que, numa tela de 50 linhas, no máximo
50 pessoas abririam. O mesmo em `/conectividade/links` (anexos de todos os
contratos e os 300 eventos mais recentes), `/telefonia` e os dois de títulos.

| Tela | Linhas buscadas antes | Depois |
|---|---|---|
| `/inventario` | até 400 ativos + até 400 eventos + **todos** os anexos | 50 ativos + eventos e anexos **desses 50** + dezenas de linhas agregadas |
| `/conectividade/links` | até 300 links + **todos** os anexos + 300 eventos | 50 links + anexos e eventos **desses 50** + agregado |
| `/financeiro/titulos-a-pagar` | **todos** os títulos + **todos** os anexos | 50 títulos + anexos **desses 50** + agregado |

O custo é uma viagem a mais ao banco — a segunda rodada só pode começar quando
os ids da página existem. Em troca, o payload deixa de crescer com o acervo e
passa a crescer com a página, que é a única das duas coisas que tem teto.

Lista vazia nem chega a consultar: `.in('asset_id', [])` é uma ida ao banco
garantidamente sem resultado.

## 4. `/telefonia`: o filtro teve de sair da memória

Essa tela filtrava em JavaScript, com um comentário que dizia "são poucas linhas
por tenant". Com paginação isso deixa de funcionar: filtrar **depois** de cortar
em 50 filtraria a página, não o acervo, e a tela mostraria "3 resultados" quando
existem 300. Filtro e corte precisam acontecer no mesmo lugar, e esse lugar é o
banco.

Um efeito colateral que precisou de cuidado: a lista de operadoras do seletor
vinha das linhas carregadas. Tirá-la da página 1 deixaria o filtro com as
operadoras daquela página — escolher uma que só aparece na página 4 seria
impossível. Ela agora vem do painel agregado, que enxerga todas.

## 5. Índices

Cinco índices parciais `(tenant_id, <ordem>, id) where deleted_at is null`, um
por tabela paginada. `.range()` com `order by` sem índice obriga o Postgres a
ordenar a tabela inteira para devolver 50 linhas, e o custo cresce com o acervo,
não com a página. Com poucos milhares de linhas ninguém nota — e é exatamente
por isso que o índice entra agora, e não no dia em que alguém notar.

## 6. Verificação

Um teto de JavaScript entrou em `aplicacao.spec.mjs`, e ele não é meta de
desempenho: é **alarme de contágio**. A tela de login tem um formulário e dois
links; se o número saltar, quase sempre é porque algo pesado vazou para um módulo
compartilhado — um `import` sem `type`, um componente de servidor que virou
cliente. O teto é folgado de propósito: apertá-lo até o valor de hoje
transformaria cada refatoração legítima numa falha, e o teste passaria a ser
ignorado, que é o único jeito garantido de um alarme não servir para nada.

| | Entrega 5 | Entrega 6 |
|---|---|---|
| `tsc` | limpo | limpo |
| `eslint` | limpo | limpo |
| Testes unitários | 288 | **306** (+18 de paginação) |
| Asserções de banco | 377 | **397** (+20, seção 33) |
| Asserções no protótipo | 44, zero erro | **44, zero erro** |
| Asserções na aplicação | 16 | **17** (+1, teto de JavaScript) |
| Views no banco | 17 | **19** |
| JavaScript em `/login` | 515 KB | **515 KB** |

As vinte asserções novas comparam **cada view com a mesma conta feita direto na
tabela**, em vez de com um número escrito à mão que envelheceria no primeiro
`seed.sql` alterado. Uma delas já pagou o custo de existir: `drop view` leva
junto os `GRANT`, e sem o `grant select` restaurado as duas views recriadas
devolveriam *"permission denied for view"* numa tela que funcionava — num
ambiente onde ninguém tocou em permissão nenhuma.

## 7. O que NÃO foi paginado, e por quê

- **`/clientes` e `/fornecedores`** — são cartões com tabelas aninhadas. Paginar
  separaria um cliente das suas filiais, e a contagem desses cadastros é de
  dezenas, não de milhares.
- **`/financeiro/centros-de-custo`** — hierarquia de três níveis renderizada por
  `parent_id`: cortar a lista esconderia um ancestral e os filhos sumiriam da
  árvore sem aviso. É a mesma razão pela qual ele ficou fora do escopo por
  cliente, na Entrega 3.
- **`Suspense` por consulta.** O briefing sugere; com `loading.tsx` já cobrindo
  a troca de tela (Entrega 5) e as consultas agora pequenas, dividir cada página
  em cinco limites de Suspense acrescentaria estados de carregamento parcial
  piscando sem reduzir espera nenhuma.

## Próximo passo

Entrega 7: revisão final de consistência — varrer o que as seis entregas
deixaram divergente entre si, conferir os números que a documentação afirma
contra o que as ferramentas medem, e fechar o comparativo de ponta a ponta.
