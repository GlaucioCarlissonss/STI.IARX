# 11 — De sistema pronto a MicroSaaS vendável: diagnóstico e plano

**Status:** plano, nada implementado.
**Base:** levantamento feito no código em 11/10/2026, não em memória — cada
afirmação abaixo tem um arquivo ou uma consulta atrás dela.

---

## 1. Veredito em uma frase

O **produto** está pronto; o **negócio** não existe no código ainda. O que falta
não é qualidade de engenharia — é a camada que transforma um sistema instalado
num serviço que alguém assina sozinho, paga todo mês e opera sem você.

A distinção importa porque muda o que fazer: não há nada a refazer, há coisa a
acrescentar.

---

## 2. O que já está acima da média, e não deve ser mexido

Vale listar antes, porque é o que normalmente custa caro e aqui já está pago:

| O que | Por que importa comercialmente |
|---|---|
| **Multi-tenancy com RLS forçado**: 166 policies, `FORCE ROW LEVEL SECURITY`, validadas com papel **sem `BYPASSRLS`** | É a parte que quase todo MicroSaaS erra e que fica impossível de consertar depois do primeiro cliente. Aqui ela foi feita certo desde o começo, e é testada |
| **Isolamento provado em CI** (`.github/workflows/ci.yml`, job `database`) | "Nosso sistema isola os dados" deixa de ser promessa comercial e vira coisa demonstrável numa auditoria de cliente |
| **Permissões granulares** módulo → tela → ação, 151 chaves, com teste que proíbe chave inerte | Vende sozinho em B2B: o cliente corporativo pergunta isso na segunda reunião |
| **Auditoria em 34 tabelas** + histórico dedicado de ticket | Idem. E é requisito em qualquer cliente com processo interno |
| **Cota de anexo por tenant**, aplicada por trigger (`0013`) | Já existe o mecanismo para limitar por plano. Falta só ligar ao plano |
| **Painel de TV por token revogável**, sem sessão | Diferencial concreto, e já funciona |
| **Suíte de verificação**: 321 testes, 397 asserções de banco, 61 em navegador | Permite mexer no produto toda semana sem medo — que é a condição para um SaaS evoluir |

**Conclusão prática:** a fundação técnica não é o gargalo. O gargalo é que não
existe porta de entrada, não existe cobrança e não existe operação.

---

## 3. O que falta — agrupado pelo que impede o quê

### 3.1 Impede VENDER (sem isto não há produto comercial)

| Lacuna | Evidência | Consequência |
|---|---|---|
| **Não há cadastro** | Nenhum fluxo de signup; usuário só nasce por `createUserAccount`, que exige um admin existente | O cliente não consegue começar sozinho. Cada venda vira trabalho manual seu |
| **Não há provisionamento de tenant** | O primeiro `tenants` de um cliente só nasce por SQL | Idem, e pior: toda venda passa por você com acesso de produção |
| **Não há cobrança** | Zero ocorrências de `subscription`, `billing`, `stripe`, `trial` no repositório | Não há o que cobrar nem como |
| **Não há plano nem limite por plano** | `attachment_quota_mb` existe e é aplicada, mas é só uma e não está ligada a nada | Não há diferença entre o cliente que paga mais e o que paga menos |
| **Não há operação da plataforma** | `super_admin` existe no modelo e **não tem nenhuma tela** | Suspender inadimplente, ver uso, investigar chamado de suporte: tudo por SQL |

### 3.2 Impede ENTREGAR o que o produto promete

| Lacuna | Evidência | Consequência |
|---|---|---|
| **Nenhum canal de notificação** | Sem `resend`/`nodemailer`/`sendgrid`; só o e-mail do Supabase Auth, para senha | **SLA sem alerta é metade do produto.** O cliente compra "me avise antes de estourar", e hoje ele só descobre abrindo a tela |
| **Nenhum job agendado** | Nenhum cron; `auto_close_after_days` existe na tabela e não roda | Fechamento automático, alerta de garantia, aviso de contrato vencendo: todos dependem disto |
| **Exportação PDF/Excel** | Pedida em 4 módulos, inexistente (LG-11) | É o primeiro pedido do financeiro e da diretoria |
| **Nunca rodou contra o Supabase real** | Os três passos de [docs/09](09-conectar-no-supabase.md) seguem abertos | Storage e e-mail são serviços separados; **nenhuma asserção local prova que funcionam** |

### 3.3 Impede DORMIR (risco operacional e jurídico)

| Lacuna | Evidência | Consequência |
|---|---|---|
| **Nenhuma observabilidade** | Sem Sentry/OpenTelemetry/qualquer coletor | Erro que não chega ao time é erro que o cliente reporta por WhatsApp, dias depois |
| **Nenhum limite de taxa** | Nenhum `rateLimit` em `/api/health`, no webhook de integração ou no login | Custo de infraestrutura e superfície de abuso, ambos sem teto |
| **Nenhum artefato de LGPD** | Sem política de privacidade, termos, DPA, exportação ou eliminação por titular | O primeiro cliente corporativo pede na assinatura do contrato. Sem isso a venda trava |
| **Backup e restauração não declarados** | Nada em `docs/` | "Qual o seu RPO/RTO?" é pergunta de compra, não de engenharia |
| **Sem MFA** | Só e-mail e senha | Bloqueia venda para cliente com política de segurança |

### 3.4 Lacunas menores, mas visíveis

- **`tenants.default_locale` existe e nada lê** — a aplicação é só pt-BR. Se a
  venda for Brasil, isso fica como está e a coluna vira ruído; se não for,
  é trabalho maior do que parece.
- **Sem PWA** (nenhum `manifest`) — e é exatamente o que liga esta seção à
  próxima.

---

## 4. Web, desktop e mobile — e a recomendação que eu daria antes do plano

Você pediu plano para os três. Vou dar — mas a parte de expertise que vale mais
que o plano é **a ordem**, porque duas das três não devem ser feitas agora.

### 4.1 O que este produto é, na prática

Olhando as telas: tabelas densas, financeiro, inventário, configuração de SLA,
mapas. Isso é **trabalho de escritório em tela grande**. Transportar para celular
não melhora nada — piora.

O que de fato pede celular é um subconjunto pequeno e específico:

1. **abrir chamado** e acompanhar o meu;
2. **receber aviso** de SLA estourando;
3. **o técnico em campo**: foto do equipamento, transferência de custódia,
   leitura do patrimônio.

O que pede desktop é menor ainda — e é só um item, que trato em 4.4.

### 4.2 Web: continua sendo o produto

Nada muda de estratégia. O que falta na web é o da seção 3, não interface.

### 4.3 Mobile: PWA primeiro, nativo só com motivo

**PWA cobre os três casos acima por volta de um décimo do custo de um app
nativo**, e o código já está pronto para isso: a aplicação é responsiva, foi
verificada em 360px, tem tema escuro e já roda com Service Worker se um for
adicionado.

O que um app nativo dá a mais, e quando isso justifica:

| Motivo | Justifica? |
|---|---|
| Push no Android | **Não** — PWA faz |
| Push no iOS | **Parcialmente** — PWA faz desde iOS 16.4, mas exige que a pessoa adicione à tela de início. Se o seu comprador for corporativo com iPhone gerenciado, vira atrito real |
| Câmera e leitura de QR do patrimônio | **Não** — a web faz |
| Funcionar sem rede, de verdade, no campo | **Sim** — é o caso em que PWA fica frágil |
| Estar na App Store / Play Store | **Sim, comercialmente** — mas é argumento de venda, não técnico. Decida por isso conscientemente, não por hábito |

**Recomendação:** PWA na Fase 3. App nativo só se aparecer cliente com equipe de
campo em área sem sinal, ou se a presença em loja for exigência comercial
declarada.

### 4.4 Desktop: a única razão boa é o agente de inventário

Embrulhar a web num Electron/Tauri para "ter app de desktop" não acrescenta nada
que um atalho do navegador não dê.

**Mas existe uma razão forte, e ela é de produto, não de empacotamento:**

> Hoje o inventário de TI é **100% digitado à mão**. Um agente instalado nas
> máquinas do cliente que colete automaticamente marca, modelo, número de série,
> processador, memória, disco, sistema e software instalado — e mande para a API
> — transforma o módulo mais trabalhoso do sistema no mais fácil.

Não é palpite meu: o benchmarking da fase inicial
([docs/02](02-benchmarking.md)) já registrou "inventário profundo (com agente de
descoberta)" como **a** força do GLPI, ao lado de "UI datada" e "SLA e dashboards
fracos" como fraquezas. Ou seja: o concorrente open source ganha exatamente onde
este produto não compete, e perde exatamente onde ele é forte.

Para este produto, portanto, **é o maior diferencial competitivo disponível** — e
tem um efeito colateral comercial: o agente é instalado por máquina, o que dá
uma métrica de cobrança natural e defensável.

Isso **não é um app de desktop**. É um serviço pequeno, sem janela, que roda em
segundo plano — e por isso entra tarde no plano, depois de haver o que faturar.

---

## 5. O plano

Esforço em **semanas de uma pessoa**, ordem de grandeza — não promessa de data.

### Fase 0 — Destravar (1 semana, e metade é sua)

Sem isto nada mais pode ser validado.

1. Os três passos de [docs/09](09-conectar-no-supabase.md): liberar o endereço na
   política de rede, pôr as quatro variáveis no ambiente, rodar
   `entrega/instalar-banco-completo.sql`.
2. Validar contra o Supabase real o que nenhuma asserção local prova: **upload de
   anexo no Storage** e **recuperação de senha por e-mail**.
3. Publicar em um ambiente de verdade (Vercel + Supabase) e medir a primeira
   carga real.

**Entregável:** o sistema rodando num endereço, com um cliente-piloto podendo
usar.

### Fase 1 — Virar SaaS (4 a 6 semanas)

É a fase que não dá para pular nem terceirizar depois.

| Item | O que envolve |
|---|---|
| **Cadastro e provisionamento** | Tela de signup; função transacional que cria `tenant` + primeiro `admin` + perfis de acesso do sistema (a trigger `trg_tenants_seed_access_profiles` já faz metade); verificação de e-mail; subdomínio ou slug |
| **Planos e cobrança** | Tabelas `plans`/`subscriptions`; Stripe ou Asaas/Pagar.me (no Brasil, boleto e Pix pesam na decisão); webhook de pagamento; estado `trial` → `ativo` → `inadimplente` → `suspenso` |
| **Limites por plano** | Generalizar o que já existe: `attachment_quota_mb` vira uma linha de uma tabela de limites (usuários, tickets/mês, armazenamento, painéis de TV). O mecanismo de trigger já está provado |
| **Console da plataforma** | As telas que o `super_admin` nunca teve: listar tenants, uso, suspender, entrar como (com registro em auditoria — isso é obrigatório, não opcional) |
| **Observabilidade** | Sentry no app e nas Edge Functions; alerta quando a taxa de erro sobe |
| **Limite de taxa** | Login, webhook de integração, `/api/health`. O webhook já valida token com comparação em tempo constante; falta o teto |
| **LGPD** | Política de privacidade, termos, DPA; exportação e eliminação dos dados de um titular; política de retenção declarada |
| **Backup e restauração** | Documentar RPO/RTO reais do plano Supabase contratado, e **testar uma restauração** |

**Entregável:** um estranho assina, paga e usa sem você saber.

### Fase 2 — O que o cliente acha que está comprando (3 a 4 semanas)

| Item | Por quê |
|---|---|
| **Canal de e-mail transacional** (Resend ou similar) | Destrava tudo abaixo. É a lacuna LG-06, que bloqueia quatro módulos |
| **Job agendado** (cron do Supabase ou GitHub Actions) | Destrava `auto_close_after_days`, alerta de garantia, aviso de contrato vencendo |
| **Alertas de SLA** | O que o cliente compra: aviso **antes** de estourar, não relatório depois |
| **Exportação PDF/Excel** | Primeiro pedido do financeiro e da diretoria (LG-11) |
| **Portal do solicitante** | Tela enxuta para quem só abre e acompanha chamado — e é exatamente o que vira o PWA da Fase 3 |

### Fase 3 — PWA: "app" de celular e de desktop sem app nativo (1 a 2 semanas)

| Item |
|---|
| `manifest.webmanifest` com ícones, nome, cor e `display: standalone` |
| Service Worker: cache do shell, tela offline honesta ("sem conexão", não tela branca) |
| Web Push ligado aos alertas da Fase 2 |
| Atalhos do manifest: "Abrir chamado", "Meus chamados" |
| Instalável no Windows, macOS, Android e iOS — **isso já é o "desktop" e o "mobile" para 90% dos casos** |

### Fase 4 — Agente de inventário (3 a 5 semanas) — **o diferencial**

| Item |
|---|
| Serviço em Go ou Rust (binário único, sem runtime): coleta hardware, sistema e software instalado |
| Envio autenticado por token de máquina, com fila local para quando não há rede |
| Endpoint de ingestão + conciliação com `it_assets` (achar o ativo que já existe em vez de duplicar) |
| Instalador MSI/pkg/deb e instalação silenciosa por GPO — **sem isso o cliente corporativo não instala em 200 máquinas** |
| Tela de máquinas vistas pela última vez, e alerta de agente mudo |

### Fase 5 — Mobile nativo (4 a 6 semanas) — **só com motivo declarado**

Só entre aqui se um dos dois for verdade: equipe de campo em área sem sinal, ou
presença em loja exigida comercialmente.

| Item |
|---|
| React Native ou Expo, reaproveitando as regras de `src/lib` |
| Escopo pequeno de propósito: abrir e acompanhar chamado, notificação, foto, leitura de QR do patrimônio, custódia |
| Offline real com fila de sincronização |

---

## 6. Se houvesse só quatro semanas

Nesta ordem, e nada além:

1. **Fase 0 inteira.** Software que nunca rodou em produção não tem estado
   conhecido.
2. **E-mail + job agendado + alerta de SLA** (parte da Fase 2). É o que torna o
   produto defensável numa demonstração: sem alerta, ele é uma planilha bonita.
3. **Cadastro + provisionamento de tenant** (parte da Fase 1). Enquanto cada
   cliente novo depender de você rodando SQL, não há escala — nem férias.
4. **Sentry.** Barato, rápido, e é a diferença entre saber e descobrir.

Cobrança pode esperar as primeiras semanas: dá para faturar os primeiros clientes
na mão enquanto se aprende o que eles realmente usam. **Provisionamento não pode**
— é o que permite dizer "sim" para o segundo cliente no mesmo dia.

---

## 7. Três riscos que eu assinalaria ao investidor ou ao sócio

1. **O produto nunca rodou contra a infraestrutura de produção.** As 397
   asserções provam o schema e o RLS contra PostgreSQL real; não provam Storage
   nem e-mail, que são serviços separados. Isso é risco conhecido e barato de
   eliminar — mas enquanto não for eliminado, qualquer cronograma depois dele é
   chute.

2. **Dependência de um fornecedor em três camadas.** Banco, autenticação e
   armazenamento são todos Supabase. É a decisão certa para começar, e tem um
   custo: migrar depois é caro. O mitigante já existe parcialmente — as
   migrações são SQL puro e rodam em PostgreSQL comum (`scripts/supabase-shim.sql`),
   então o banco é portátil. Auth e Storage não são.

3. **O mercado de helpdesk é cheio** — Freshservice, Jira Service Management,
   Zendesk, GLPI e ManageEngine foram os cinco estudados em
   [docs/02](02-benchmarking.md). O
   que este produto tem de diferente não é o helpdesk: é **helpdesk + inventário
   + telefonia + links + financeiro no mesmo lugar, para quem administra a TI de
   várias empresas** (o foco por empresa da entrega 3 é exatamente isso). Essa é
   a história a contar, e o agente de inventário da Fase 4 é o que a sustenta.
