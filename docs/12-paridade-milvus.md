# 12 — Paridade com o Milvus: inventário, mapa de lacunas e plano

**Status:** plano. Nada implementado nesta rodada.
**Base da pesquisa:** páginas públicas do fornecedor e diretórios de software,
consultadas em 24/10/2026. **A maior parte das fontes é material de marketing do
próprio Milvus** — está marcado abaixo o que é afirmação deles e o que eu não
consegui confirmar.

---

## 0. Duas coisas antes do plano

### 0.1 O que dá para copiar, e o que não dá

**Funcionalidade se copia.** Ter chamado, SLA, inventário, agente e base de
conhecimento não pertence a ninguém — é o padrão do mercado de ITSM, e metade
disso é ITIL, que é público. Construir um concorrente com as mesmas capacidades é
competição normal.

**Código, telas, textos e marca não.** Eu não vou copiar o código deles (não
tenho acesso e não teria como), nem reproduzir as telas, os textos de interface ou
a identidade visual. Além de ser ilegal, seria burrice comercial: a cópia visual é
o que faz um cliente dizer "isso é um Milvus pirata" em vez de "isso é melhor".

Na prática isso muda **uma coisa** no plano: cada funcionalidade abaixo descreve o
**problema que ela resolve**, não a tela que o Milvus usa para resolvê-lo.

### 0.2 "Remodelar toda a solução" é o movimento errado

Você pediu para remodelar tudo. Eu discordo, e vou dizer por quê antes de
executar — se depois de ler você mantiver, eu faço.

O que o STI.IARX tem de mais caro é exatamente o que **não** se vê na tela:
multi-tenancy com RLS forçado (166 policies validadas com papel sem `BYPASSRLS`),
permissões granulares módulo → tela → ação, auditoria em 34 tabelas, isolamento
provado em CI. Isso leva meses para refazer e é a parte que quebra silenciosamente
quando malfeita.

E, comparando os dois produtos item a item (seção 2), **o STI já cobre a maior
parte do núcleo de help desk do Milvus, e em SLA cobre mais.** O que falta é um
conjunto bem definido de módulos novos — não uma arquitetura nova.

**Recomendação:** não remodelar; **estender**. O plano da seção 5 acrescenta sem
tocar na fundação.

---

## 1. Inventário do Milvus (o que as fontes dizem)

| Área | O que é afirmado | Fonte |
|---|---|---|
| **Help desk / chamados** | Centraliza solicitações de qualquer área, do TI ao RH | [portalsoftware](https://portalsoftware.com.br/software/milvus-ti) |
| **Omnichannel** | WhatsApp, telefone, chat, e-mail e formulário num painel só, com SLA | [milvus.com.br/plataforma-omnichannel](https://milvus.com.br/plataforma-omnichannel) |
| **WhatsApp** | Via API oficial da Meta | [blog Milvus](https://milvus.com.br/blog/categoria/atendimento-ao-cliente) |
| **IA generativa** | Chatbot e resposta automática a chamados repetitivos a partir da base de conhecimento; geração de artigo a partir de um ticket | [release notes 73](https://milvus.com.br/blog/release-notes-milvus-versao-73) |
| **Base de conhecimento** | Alimentada pelos chamados resolvidos, consultável no portal do cliente | [portalsoftware](https://portalsoftware.com.br/software/milvus-ti) |
| **Catálogo de serviços** | Serviços com preço pré-definido, incluídos automaticamente em contratos | [sistema-de-chamados](https://milvus.com.br/sistema-de-chamados-help-desk) |
| **ESM / portal** | Portal para áreas fora da TI (RH, administrativo) abrirem chamado | [portalsoftware](https://portalsoftware.com.br/software/milvus-ti) |
| **Gestão de contratos** | Prazos, condições e histórico de interações | [blog Milvus](https://milvus.com.br/blog/milvus-e-bom) |
| **Workflow** | Automação de fluxos e atribuição inteligente | [portalsoftware](https://portalsoftware.com.br/software/milvus-ti) |
| **Inventário automático** | Varredura de rede lista as especificações sem digitação | [b2bstack](https://www.b2bstack.com.br/produto/milvus-ti/avaliacao/avaliacao-da-plataforma-milvus-pros-e-contras) |
| **Agente nas máquinas** | Instalado em computadores e smartphones; painel com alerta de disco, RAM, temperatura e processamento | [milvus.com.br/inventario-de-ti](https://milvus.com.br/inventario-de-ti) |
| **Monitoramento** | Serviços, topologia de rede, gestão de vulnerabilidades com alerta | [inventario-inteligente](https://milvus.ueek.dev/inventario-inteligente) |
| **Acesso remoto** | Citado nas listas de recursos dos planos | [o-que-e-agente-helpdesk](https://milvus.com.br/blog/o-que-e-agente-helpdesk) |
| **Antivírus e licenças** | Citados como recursos do agente, distribuídos entre os planos | idem |
| **Dashboards** | Painéis e relatórios em tempo real | [milvus.com.br](https://milvus.com.br/) |
| **Integrações** | WhatsApp, Telegram, Office 365, GLPI | [portalsoftware](https://portalsoftware.com.br/software/milvus-ti) |
| **Preço** | A partir de R$ 95/mês; planos Básico, Popular e Elite; teste de 7 dias | [portalsoftware](https://portalsoftware.com.br/software/milvus-ti) |
| **Conformidade** | Afirmam ISO 27001 | blog do fornecedor |

### 1.1 As integrações, pela própria página de preços deles

Esta seção é mais nova que o resto do inventário, e a fonte é melhor: é página
do fornecedor, não resenha de terceiro. A
[página de preços](https://milvus.com.br/precos) lista as integrações
disponíveis, e a [página do ChatGPT](https://milvus.com.br/chat-gpt) diz onde a
credencial é colada.

| O que o Milvus integra | O que existe aqui | Situação |
|---|---|---|
| **Zabbix** | `link_availability_events.source = 'zabbix'` desde a 0021 — a tabela espera o evento, o webhook não existe | ⚠️ A queda é registrada à mão. A Edge Function está adiada em [docs/18](18-revisao-e-lacunas-fechadas.md) §5 por falta de um Zabbix para testar contra |
| **Google / Office 365 / Active Directory** | Nada. O login é e-mail e senha | ❌ **Lacuna nova**, e não estava neste mapa antes. Sem entrada única e sem provisionamento de usuário a partir do diretório |
| **Telefonia IP** | `/telefonia` é **outra coisa**: inventário de linha, operadora e custo | ❌ **Lacuna nova.** Os nomes colidem e as funções não se parecem — eles integram a CENTRAL (chamada vira chamado, clique para ligar); aqui se cadastra a linha |
| **ERP** | O previsto `Integrações → Bancos de dados` | ⚠️ Mesmo assunto, ainda como previsto |
| **BI** | Exportação em CSV, gerada no servidor com o escopo de RLS de quem pediu (docs/18 §2.6) | ✅ Por outro caminho: em vez de conector de BI, o arquivo sai pronto e com o recorte certo |
| **API** | `/api/agent`, `/api/canais`, `/api/jobs`, `/api/exportar` | ✅ Existem, cada uma com o próprio modo de autorizar |
| **ChatGPT**, com o token colado "na área de integrações" | `/ia` — credencial por referência (ADR-009), teto de gasto mensal, sugestão que nunca é aplicada sozinha | ✅ **Mais forte**, e foi o que moveu a tela de menu: ver abaixo |

**O que esta seção mudou no produto, e não só no documento:** `Sugestões de IA`
saiu de `Administração` e foi para `Integrações`. O argumento antigo ("é
configuração de ambiente, como os canais") continuava verdadeiro e levava ao
lugar errado — os canais também são integração. O que decide o grupo é **com
quem a tela fala**, e ela fala com um provedor de fora.

**O que esta seção NÃO mudou, de propósito:** os seis previstos do grupo
Integrações continuam sendo os que o cliente pediu em [docs/01](01-requisitos.md),
e nenhuma área do Milvus virou item de menu novo. Acrescentar seis "em breve"
porque o concorrente os tem encheria o grupo de promessa que ninguém combinou —
e a regra de item previsto desta base (docs/08 §5) existe justamente para isso
não acontecer. As três lacunas acima são roteiro, e o lugar do roteiro é aqui.

### Duas divergências entre as fontes

A tabela da seção 1 cita, via portalsoftware, "WhatsApp, Telegram, Office 365,
GLPI". A busca que levantou a seção 1.1 **não confirmou Telegram, GLPI nem
Bitrix24** em fonte nenhuma — nem do fornecedor, nem de terceiro.

Isso não prova que não existam: ausência numa busca não é ausência no produto, e
a página de preços pode não listar tudo. Fica registrado como divergência entre
fontes, e não como fato, porque é exatamente o tipo de linha que vira requisito
inventado quando alguém a lê com pressa.

### O que eu NÃO consegui confirmar

Registro para não virar requisito inventado:

- **aplicativo móvel** — nenhuma fonte encontrada;
- **pesquisa de satisfação (CSAT)** — nenhuma fonte encontrada;
- **etapas de aprovação em workflow** — a automação é citada, as etapas não;
- **como o acesso remoto funciona** — só aparece em lista de recursos;
- **detalhes de antivírus, licenças e patch** — citados, sem descrição;
- **sistemas operacionais suportados pelo agente e requisitos** — nada.

Uma das avaliações usadas tem cerca de 2.400 dias. **Antes de transformar
qualquer linha desta tabela em requisito, vale pedir uma demonstração** — meia
hora de tela vale mais que seis páginas de marketing.

---

## 2. Mapa de paridade

✅ tem · ⚠️ parcial · ❌ não tem

| Funcionalidade | STI.IARX hoje | Observação |
|---|---|---|
| Chamados, estados, atribuição, transferência, comentário público/interno, histórico | ✅ | Máquina de estados validada no banco |
| **SLA** | ✅ **mais forte** | Horário útil com feriado e fuso **por filial**, pausa por espera, precedência determinística. É mais do que a maioria dos concorrentes entrega |
| Filas, roteamento automático, score de priorização | ✅ | `fn_route_ticket` + pesos configuráveis |
| Dashboards em tempo real | ✅ | Painel + painel de TV por token revogável |
| Gestão de contratos e fornecedores | ✅ | Com SLA contratado e avaliação do fornecedor |
| Multi-empresa com foco por cliente | ✅ | Entrega 3 |
| Permissões granulares | ✅ | 151 chaves, módulo → tela → ação |
| Auditoria | ✅ | 34 tabelas |
| **Inventário de TI** | ⚠️ **manual** | Cadastro, ciclo de vida, custódia e anexos existem. **Nada é coletado automaticamente** |
| Licenças de software | ⚠️ | Existe como *tipo* de ativo (`software_license`), não como gestão de licença (chave, posto, vencimento, conformidade) |
| Portal do solicitante / ESM | ⚠️ | O papel `solicitante` existe e o menu já filtra, mas não há portal enxuto nem catálogo |
| Workflow com aprovação | ⚠️ | Há alçada no financeiro (`approval_rules`) e regras de fila. Não há workflow genérico de chamado |
| **Agente nas máquinas** | ❌ | **Zero.** É a maior lacuna, e é a que você destacou |
| **Monitoramento de desempenho** | ❌ | Nada de CPU, RAM, disco, temperatura |
| **Vulnerabilidades** | ❌ | — |
| **Acesso remoto** | ❌ | — |
| **Omnichannel** | ❌ | WhatsApp e Telegram existem **só como item de menu marcado "em breve"** (`src/lib/navigation.ts`) |
| **Base de conhecimento** | ❌ | Nenhuma tabela |
| **IA / chatbot** | ❌ | — |
| **Pesquisa de satisfação** | ❌ | O `rating` que existe é de **fornecedor** (0–5), não de atendimento |
| **Catálogo de serviços** | ❌ | — |
| Relatórios e exportação | ❌ | LG-11, pedida em 4 módulos |
| Notificação (e-mail, push) | ❌ | LG-06 — bloqueia alerta de SLA, que é metade do produto |
| App móvel | ❌ | — |

### 2.1 O que o STI tem e o Milvus aparentemente não — e que seria burrice perder

Nenhuma fonte consultada menciona estes módulos no Milvus:

| Diferencial | Por que importa |
|---|---|
| **Financeiro completo** — contas a pagar e a receber, alçada configurável, centros de custo hierárquicos, contas bancárias com conciliação, **projeção de fluxo de caixa** | Para uma empresa que administra a TI de terceiros, custo e cobrança moram no mesmo lugar que o chamado |
| **Telefonia** — linhas, aparelho vinculado, fidelidade, custo por filial e operadora | Ninguém mais junta isso com helpdesk |
| **Links de internet** — contrato, banda, IP, CPE, disponibilidade, custo | Idem |
| **Mapa das filiais** com semáforo por domínio | Visual, e vende em demonstração |
| **Painel de TV** por token revogável | Idem |

**Esta é a história comercial a contar**, e ela não é "somos um Milvus mais
barato": é *"gestão de TI e o custo dela no mesmo sistema, para quem administra
várias empresas"*. Buscar paridade sem preservar isso troca uma posição própria
por uma disputa de preço com um concorrente estabelecido.

---

## 3. O agente — especificação

É o item que você destacou e é o de maior valor. Não é "um app de desktop": é um
serviço sem janela, que roda em segundo plano.

### 3.1 Decisões técnicas, com o motivo

| Decisão | Escolha | Por quê |
|---|---|---|
| Linguagem | **Go** | Binário único, sem runtime para instalar. Compila para Windows, macOS e Linux a partir da mesma base. Em máquina de cliente, "precisa instalar o .NET antes" mata o projeto |
| Transporte | **HTTPS** para uma Edge Function de ingestão | Mesmo caminho que o webhook de integração já usa, com token validado em tempo constante |
| Credencial | **Token por máquina**, obtido num *enrollment* com token do tenant | O agente **nunca** carrega a `service_role`. Máquina roubada se revoga sozinha |
| Identidade da máquina | UUID gerado na primeira execução, gravado localmente | Hostname muda, serial às vezes vem vazio. O UUID é o que não muda |
| Conciliação | `serial_number` → UUID → hostname, nessa ordem | **Nunca duplicar** um ativo que já foi cadastrado à mão. Duplicata em inventário destrói a confiança no módulo |
| Fila local | SQLite ou arquivo append-only | Notebook em viagem precisa acumular e mandar depois. Sem isso o dado some |
| Atualização | Autoatualização assinada, com *rollback* | 200 máquinas não se atualizam à mão. E agente que se atualiza errado é um incidente em 200 lugares ao mesmo tempo |
| Instalação | MSI com instalação silenciosa (GPO), `pkg`, `deb`/`rpm` | Sem instalação por GPO o cliente corporativo não instala em escala |

### 3.2 O que coleta

**Inventário** (uma vez por dia, ou quando muda): fabricante, modelo, número de
série, service tag, processador, núcleos, memória total e por pente, discos
(modelo, tamanho, tipo, SMART), placas de rede e MAC, placa de vídeo, BIOS/UEFI e
versão, sistema operacional e build, domínio, usuário logado, e a lista de
software instalado com versão.

**Desempenho** (amostra a cada 1–5 min): uso de CPU, memória, disco por volume,
temperatura quando disponível, tempo ligado, contagem de reinícios, e serviços
críticos no ar ou não.

### 3.3 Onde isso mora no banco — e a decisão que mais importa

> **Métrica de desempenho NÃO entra na linha do ativo.**

`it_assets` é um **registro** — uma linha por equipamento, que muda raramente.
Métrica é **série temporal**: 200 máquinas × 1 amostra por minuto são 288 mil
linhas por dia. Guardar o último `cpu_percent` na linha do ativo parece prático e
destrói a tabela: perde-se o histórico, e todo `update` de métrica dispara a
trigger de auditoria, enchendo `audit_log` de ruído.

Esboço:

| Tabela | Papel |
|---|---|
| `agent_enrollments` | Token do tenant, validade, quantas máquinas já usou |
| `agent_devices` | Uma por máquina: UUID, token hash, versão do agente, último contato, `it_asset_id` conciliado |
| `agent_inventory_snapshots` | Inventário completo em `jsonb`, com histórico — permite "o que mudou nesta máquina?" |
| `agent_metrics_raw` | Amostras cruas, **com retenção curta** (7 a 30 dias) |
| `agent_metrics_hourly` | Agregado por hora, retenção longa. É o que o gráfico lê |
| `agent_software` | Software instalado por máquina, normalizado — base para licenças e, depois, para CVE |
| `agent_alerts` | Disco acima de X%, máquina muda há N horas, serviço fora do ar |

Com RLS em todas, pelo mesmo `tenant_id`, e o agregado por hora carregando
`branch_id` — pela lição da entrega 6: indicador sem a coluna do escopo conta o
tenant inteiro enquanto a lista mostra uma empresa só.

### 3.4 Duas coisas que eu NÃO construiria

**Acesso remoto.** Controle remoto de tela é um produto inteiro — NAT traversal,
relay, codec, latência, segurança. Integrar **RustDesk auto-hospedado** ou
**MeshCentral** entrega o recurso em dias em vez de meses, e os dois são open
source. O agente só precisa registrar o id da máquina no serviço escolhido.

**Detecção de vulnerabilidade com CVE.** Casar software instalado com base de CVE
é outro produto. O caminho é faseado: **primeiro** o inventário de software (que
já é valioso: "quem ainda tem Windows 10?"), **depois** o casamento com CVE, se o
mercado pedir.

---

## 4. O tamanho real do esforço

Precisa estar escrito, porque muda a decisão.

O Milvus está na **versão 73**. É um produto maduro, com equipe, vendendo há
anos. **Paridade total não é um sprint — é um programa de vários anos para uma
equipe.** Em semanas de uma pessoa, só os módulos ausentes:

| Bloco | Esforço |
|---|---|
| Notificação (e-mail + job agendado + alertas de SLA) | 3–4 |
| Base de conhecimento + portal do solicitante + catálogo de serviços | 4–6 |
| Agente: coleta, ingestão, conciliação, telas, alertas | 8–12 |
| Agente: instalador MSI/pkg/deb, GPO, autoatualização | 3–5 |
| Omnichannel (WhatsApp API oficial + e-mail entrante + chat) | 6–10 |
| IA (resposta sugerida e artigo a partir de ticket) | 3–5 |
| Relatórios e exportação | 3–4 |
| CSAT, workflow de aprovação, licenças | 4–6 |
| Acesso remoto (integrando, não construindo) | 1–2 |
| **Total aproximado** | **35–54 semanas** |

Ou seja: **de oito meses a um ano** de uma pessoa, e isso ignorando que o
concorrente continua andando.

**Por isso o plano abaixo não persegue paridade.** Ele persegue, nesta ordem: o
que o produto promete e não entrega; o diferencial que ninguém tem; e só então a
paridade onde ela pesa na venda.

---

## 5. O plano

### Onda 1 — Fechar a promessa atual ✅ **executada**

Nada aqui era do Milvus: era o que o STI já dizia que faz e não fazia.

1. ✅ **Canal de e-mail** — `src/lib/mail/`, com caixa de saída e nova tentativa.
2. ✅ **Trabalho agendado** — `POST /api/jobs/run` e as três funções da migração
   0030. `auto_close_after_days` estava na tabela desde a 0002, era lido pela
   sessão e **nunca tinha sido executado por ninguém**.
3. ✅ **Alertas de SLA** — atenção, crítico e estourado.
4. ✅ **Pesquisa de satisfação (CSAT)** — convite por link sem login, tela de
   resultados em `/satisfacao`.

Como ligar: [docs/13](13-notificacoes-e-trabalhos.md). Três variáveis e um
agendador, e os três dependem de você.

**Quatro decisões que valem registro:**

- **Caixa de saída, não envio em linha.** Nenhuma trigger manda e-mail: elas
  escrevem numa fila e um trabalho a esvazia. Provedor fora do ar não pode
  derrubar a transação de negócio, nova tentativa precisa de estado, e sobra o
  registro do que foi mandado — que é a primeira coisa que o suporte pede.
- **A regra no SQL, a rede no TypeScript.** Quem decide a quem avisar são
  funções no banco, onde os dados estão e onde as asserções de schema provam a
  regra — 37 delas, na seção 34. Quem fala com o provedor é a aplicação.
- **Idempotência por chave, não por esperança.** Cada mensagem carrega uma
  `dedupe_key` com índice único, e a chave inclui o ciclo de reabertura do
  chamado. Rodar o trabalho três vezes seguidas continua sendo um aviso;
  chamado reaberto ganha um novo. "O cliente recebeu quarenta e-mails" é a falha
  clássica deste recurso.
- **Sem provedor configurado, a fila não é consumida.** Ausência de chave não é
  erro — o sistema roda sem canal de e-mail, como rodou até agora. O que não
  pode é fingir que enviou.

### Onda 2 — O agente, parte 1: inventário ✅ **executada**

Guia de uso em [docs/14](14-agente-de-inventario.md); o agente em
[`agente/README.md`](../agente/README.md).

5. ✅ Tabelas, RLS, *enrollment* e endpoint de ingestão (migração 0031).
6. ✅ Agente em Go: coleta de inventário, fila local, autoatualização assinada.
7. ✅ Conciliação com `it_assets` — **sem duplicar nada**.
8. ✅ Telas: `/inventario/agentes` e o detalhe da máquina.
9. ⚠️ Instalador: **PowerShell pronto e verificado**; MSI com a fonte escrita e
   dependente de uma máquina Windows com WiX.

> Fim da Onda 2 é o momento em que o discurso comercial muda: o inventário deixa
> de ser digitado.

**O que mudou em relação ao que estava planejado aqui, e por quê:**

- **Nenhum quarto uso de `service_role`.** O esboço previa "uma Edge Function de
  ingestão", que naturalmente usaria a chave de serviço. As duas funções de
  ingestão são `security definer` concedidas a `anon`, pelo mesmo raciocínio da
  pesquisa de satisfação: a função é a única porta, só aceita o token da máquina,
  e **não existe parâmetro de tenant para alguém falsificar**. Dar a chave mestra
  a um serviço que roda em 200 computadores de cliente seria desproporcional.

- **O batimento é uma rota separada da ingestão.** Não estava no esboço, e sem ele
  a conta não fecha: 200 máquinas × 144 contatos por dia × meio megabyte de lista
  de software seriam **14 GB por dia** para transportar um dado que não mudou.

- **`agent_metrics_*` e `agent_alerts` NÃO foram criadas.** Elas são da Onda 3, e
  criar tabela vazia uma onda antes não adianta: a forma certa de uma série
  temporal depende de como o gráfico vai lê-la.

- **Tarefa agendada no Windows, serviço no Linux e no macOS.** Falar o protocolo do
  Service Control Manager em Go exige um módulo de terceiro, num programa que roda
  como SYSTEM na máquina do cliente. Duas tarefas fazem o mesmo trabalho, sem
  dependência, e **uma execução que falha é repetida pela próxima** — enquanto um
  serviço que morre precisa de uma política de reinício que ninguém configura.

- **O filtro de número de série de fábrica.** Não estava previsto e é a asserção
  mais importante do arquivo de testes: placa de montagem branca vem com *"To Be
  Filled By O.E.M."* no lugar do serial, e casar por esse valor juntaria as 80
  máquinas do lote num ativo só.

### Onda 3 — O agente, parte 2: desempenho e alertas ✅ **executada**

Guia de uso em [docs/14](14-agente-de-inventario.md).

10. ✅ Métricas, agregação por hora, retenção (migração 0032).
11. ✅ Alertas: disco cheio, máquina muda, serviço fora do ar — e SMART em falha,
    que não estava no plano e é o mais acionável dos quatro.
12. ✅ Inventário de software e "quem ainda tem o sistema antigo"
    (`/inventario/software`).
13. ✅ Acesso remoto **integrando**: o agente lê o id do RustDesk e a tela oferece
    o link. A plataforma continua não implementando controle remoto.

**O que mudou em relação ao que estava planejado aqui, e por quê:**

- **Três camadas de retenção, não duas.** O esboço previa `agent_metrics_raw` e
  `agent_metrics_hourly`. O disco ganhou a sua própria (`agent_volume_samples`),
  agregada por hora **já na entrada**, guardando o **mínimo livre da hora** — que
  é exatamente o que um alerta de disco precisa. Sem ela, a tabela crua seria
  multiplicada pelo número de volumes de cada máquina para guardar um dado cujo
  único uso é o pior momento.

- **Amostra a cada 5 minutos, não a cada 1.** Um minuto daria 288 mil linhas por
  dia numa frota de 200; cinco dão 57 mil. A resolução de cinco minutos responde
  tudo que este módulo promete responder, e a de um minuto só responde o que a
  plataforma não se propõe a investigar.

- **A histerese dos alertas.** Não estava prevista e é o que separa um recurso
  útil de um que as pessoas filtram para a lixeira: o alerta abre no limiar e
  fecha cinco pontos abaixo, senão um disco parado em 90,1% manda e-mail oito
  vezes por dia.

- **Nenhuma métrica por processo.** "Qual programa está consumindo a CPU" é a
  pergunta seguinte, é tentadora, e a resposta carrega o nome e a linha de comando
  de tudo que a pessoa está rodando — que é vigilância, não inventário. O agente
  promete não olhar o que está aberto, e a promessa vale mais que o recurso.

- **A projeção de "em quantos dias este disco enche".** Não estava no plano. É a
  informação mais acionável que a série de disco produz: "enche em quatro dias"
  move alguém hoje, "está com 88%" não move ninguém.

### Onda 4 — Autoatendimento ✅ **executada**

Guia de uso em [docs/15](15-autoatendimento.md).

14. ✅ Base de conhecimento, alimentada pelos chamados resolvidos (migração 0033).
15. ⚠️ Portal do solicitante: a **tela** está pronta (`/portal`); o PWA não —
    ver abaixo.
16. ✅ Catálogo de serviços com preço por cliente e "incluído no contrato".

**O que mudou em relação ao que estava planejado aqui, e por quê:**

- **O portal é uma tela, não um segundo aplicativo.** O escopo pedia "enxuto", e
  a tentação é um layout próprio com menu próprio: duas camadas de navegação
  para manter, dois lugares onde uma permissão nova precisa ser refletida, dois
  lugares onde um defeito de sessão pode morar. O que torna um portal enxuto é a
  PÁGINA responder "o que você precisa?" — e o menu lateral já se filtra sozinho
  desde a 0017. **O PWA continua pendente**, e agora tem o que embrulhar.

- **A peça central não é a tabela de artigos: é o caminho do chamado para o
  artigo.** Bases de conhecimento morrem porque ninguém escreve, e a tela em
  branco é onde elas morrem. `app.kb_rascunho_do_chamado()` monta o texto a
  partir do próprio chamado resolvido, e o botão *Virar artigo* só aparece
  quando ele está resolvido — artigo escrito no meio do atendimento descreve uma
  hipótese, não uma solução.

- **O formulário de cada serviço é `jsonb`, e é digitado como JSON.** Um
  construtor visual é um projeto em si e adiaria o catálogo inteiro. O JSON é
  feio e honesto: quem cadastra serviço num helpdesk é de TI, o exemplo está ao
  lado, e o erro é validado na submissão — não na renderização da vitrine, onde
  quem cadastrou nunca veria.

- **Sem cruzamento com CVE e sem semelhança semântica.** As sugestões de artigo
  usam categoria e busca textual. Embeddings são da Onda 6, e um artigo relevante
  achado por categoria vale mais hoje que um artigo perfeito daqui a três meses.

### Onda 5 — Omnichannel ✅ **executada**

Guia de uso em [docs/16](16-canais-de-conversa.md).

17. ✅ WhatsApp pela API oficial da Meta (Cloud API v21). **Não** por biblioteca
    não-oficial: elas são banidas, e o produto cai junto.
18. ✅ E-mail entrante virando ticket, com qualquer provedor de recebimento.
19. ⚠️ Chat no portal: **não foi feito**, e o motivo está abaixo.

**Acrescentado ao escopo a pedido:** Bitrix24 e N8N como canais de conversa.

**O que mudou em relação ao que estava planejado aqui, e por quê:**

- **O N8N virou a peça mais importante da onda.** O plano listava três canais;
  ligá-los um a um é trabalho sem fim, porque o quarto pedido será Telegram, o
  quinto Slack e o sexto SMS. O N8N (ou Make, ou Zapier, ou um script) já resolve
  isso para toda a internet — faltava ter para onde mandar e de onde receber. Com
  um webhook genérico de entrada e uma URL genérica de saída, qualquer canal entra
  **sem esta base precisar conhecê-lo**. É o único dos quatro que funciona sem
  conta verificada, sem aprovação e sem cobrança por mensagem, e é por ele que se
  deve começar.

- **Não há caixa de resposta nos canais, e isso é a decisão central.** Uma tela
  estilo aplicativo de mensagens criaria **dois lugares para atender a mesma
  coisa**: "este cliente já foi respondido?" passaria a ter duas respostas, o SLA
  contaria de um jeito na fila e de outro no chat, e a pesquisa de satisfação
  ignoraria metade do atendimento. Toda conversa é um chamado; o atendente
  responde no chamado e a resposta volta pelo canal de onde veio.

- **Bitrix24 por webhook, e não pelo conector nativo (`imconnector`).** O conector
  aparece como canal no Contact Center e é melhor para quem vive dentro do
  Bitrix24, mas exige publicar e manter um aplicativo. O webhook funciona hoje,
  com o que o cliente já tem. A escolha fica registrada em
  [docs/16](16-canais-de-conversa.md) para não ser refeita do zero quando o
  segundo cliente pedir o conector.

- **O chat no portal não foi feito, e não por falta de tempo.** Ele é a quarta
  superfície de atendimento (fila, portal, WhatsApp, chat) e a única que exige
  presença: um chat sem ninguém do outro lado é pior que nenhum chat, porque
  promete resposta imediata. Com os canais prontos, quem quer conversar já tem
  WhatsApp e e-mail — e os dois deixam registro. O chat entra quando houver
  operação para atendê-lo.

- **Honestidade sobre o que não foi verificado:** nenhuma chamada real a provedor
  nenhum. Não há credencial da Meta, do Bitrix24 nem de provedor de e-mail neste
  ambiente. Os payloads dos testes vêm da documentação oficial, copiados, e a
  primeira ligação real pode exigir ajuste de nome de campo — por isso os
  adaptadores registram o que não souberam ler em vez de descartar.

### Onda 6 — IA ✅ **executada**

Guia de uso em [docs/17](17-sugestoes-de-ia.md).

20. ✅ Resposta sugerida a partir da base de conhecimento.
21. ✅ Artigo gerado a partir de um ticket resolvido, com revisão humana.
22. ✅ Triagem sugerida (categoria e prioridade), **sugerida** e não aplicada.

**O que mudou em relação ao que estava planejado aqui, e por quê:**

- **"Sugerida" virou a regra dos três, e não só da triagem.** O plano só grifava a
  palavra no item 22; na execução ela governa os três, porque o mesmo raciocínio
  vale para todos. Triagem aplicada sozinha muda o SLA sem autor no histórico;
  resposta enviada sozinha vai para o cliente. Toda sugestão nasce como linha
  `pendente`, e o CHECK `sug_decidida_tem_autor` impede o estado "aceita por
  ninguém".

- **A IA não escreve no chamado.** Não há autor "IA" em `ticket_comments`: a
  resposta sugerida tem botão de *copiar*, não de enviar. Ela vai para a caixa de
  comentário, onde a pessoa corrige e assina — a responsabilidade pelo que o
  cliente leu é de quem apertou enviar.

- **O painel de IA fica DEPOIS das sugestões da base, e não antes.** A base é
  determinística, gratuita, e já tem a resposta de um problema que alguém
  resolveu. Oferecer a IA primeiro ensinaria a equipe a pular a base — e a base
  deixaria de ser alimentada, que é o único jeito de ela servir para alguma coisa.

- **Teto de gasto por tenant, conferido antes da chamada.** Não estava no plano, e
  é o que separa um recurso que a empresa liga de um que ela desliga depois da
  primeira fatura. Estourado o teto, o painel volta ao caminho determinístico e
  diz o motivo.

- **Embeddings continuam de fora.** O item 14 da onda 4 já havia adiado a
  semelhança semântica, e ela continua adiada: as sugestões de artigo usam
  categoria e busca textual, e a IA lê o que a busca achou. Um banco de vetores
  seria uma dependência nova para melhorar um passo que hoje não é o gargalo — o
  gargalo é a base ter poucos artigos.

- **O chatbot do item de benchmarking não foi feito**, e é o mesmo motivo do chat
  no portal (onda 5): uma superfície que promete resposta imediata. Com os canais
  e as sugestões prontas, a equipe responde mais rápido no chamado — que é onde o
  SLA conta.

- **Honestidade sobre o que não foi verificado:** nenhuma chamada real ao
  provedor (não há credencial da Anthropic neste ambiente nem saída de rede para a
  API), e a **qualidade** das sugestões não foi medida — isso exigiria um conjunto
  de avaliação com chamados reais, que é trabalho de outra ordem. Os prompts são a
  parte que mais vai mudar depois da primeira semana de uso real.

---

## 6. O que fazer primeiro, se for para escolher uma coisa

**Onda 1 inteira, e nada além** — por um motivo que não é técnico: o produto hoje
promete alerta de SLA e não manda nenhum. Em qualquer demonstração séria isso
aparece em cinco minutos, e aparece como *defeito*, não como *roadmap*.

E, antes mesmo da Onda 1, continuam de pé os três passos de
[docs/09](09-conectar-no-supabase.md). Enquanto eles não forem feitos, **o sistema
nunca rodou contra a infraestrutura de produção** — e todo cronograma depois disso
é chute.
