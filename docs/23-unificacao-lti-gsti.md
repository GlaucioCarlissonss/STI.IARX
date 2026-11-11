# 23 — A unificação: Locação (LTI) e Gestão (GSTI) dentro do STI

**Status:** plano aprovado nas decisões de produto; execução por fases, nenhuma
iniciada. **Depende de você:** as respostas já dadas (esferas, duas tabelas de
equipamento, chamado de campo, fatura + título) estão incorporadas aqui.

> Três repositórios, um produto. Este documento diz o que entra, o que se
> dissolve no que já existe, o que **não** entra, e em que ordem — para que a
> unificação não vire dois sistemas dentro de um menu.

---

## 1. O ponto de partida, medido

| Sistema | O que é | Tamanho | Situação |
|---|---|---|---|
| **STI.IARX** (esta base) | Helpdesk + gestão de TI, Next.js 16 + Postgres com RLS | 46 migrações, ~90 tabelas, 37 rotas | em uso |
| **GSTI.IARX** | Gestão para gestores de TI (financeiro, projetos, suporte), SQLite | 1 schema, ~37 tabelas | **já absorvido** |
| **IARX / LTI** | Locação de equipamentos, Postgres com RLS + API + SPA | 38 migrações, ~80 tabelas, 25 telas | **a absorver** |

### O GSTI já está dentro

Os três módulos foram decididos um a um, e isso está registrado desde antes
deste documento:

- **Projetos** veio inteiro ([docs/19](19-modulo-de-projetos.md), migração 0037).
- **Financeiro de gestão** veio como camada de planejamento sobre os títulos que
  já existiam, e não como segundo financeiro ([docs/20](20-orcamento-de-ti.md), 0038).
- **Visão de resultado** veio como relatório, sem tabela nova ([docs/21](21-visao-de-resultado.md), 0039-0040).
- **SLA agregado não entrou**: aqui a conformidade é contada chamado a chamado,
  e um agregado digitado competiria com um número derivado.

Resta **uma** peça do GSTI: o ciclo de planilha (importar e exportar Excel), que
lá é o grupo *Sistema*. Entra na Fase 7, porque é conveniência de operação e não
regra de negócio.

### O LTI é o trabalho de verdade

Das ~80 tabelas do LTI, cerca de **40 entram como novas** e cerca de **40 se
dissolvem** no que o STI já tem. A dissolução não é economia de digitação: sem
ela a unificação entrega dois cadastros de cliente, dois financeiros e duas
verdades sobre o mesmo dinheiro.

| Do LTI | Vira, aqui |
|---|---|
| `cliente`, `filial`, `grupo_economico` | `clients`, `branches` |
| `fornecedor` | `suppliers` |
| `titulo_pagar*`, `titulo_receber*`, `conta_bancaria`, `movimentacao_bancaria`, `centro_custo` | o financeiro do STI |
| `usuario`, `perfil`, `usuario_perfil`, `sessao`, `token_recuperacao` | `profiles`, `access_profiles`, `permission_grants` |
| `audit_log`, `log_acesso`, `anexo`, `notificacao`, `job_execucao` | `audit_log`, anexos por entidade, `notification_preferences`, `job_runs` |
| `outbox_evento`, `requisicao_idempotente` | `integration_events` e a idempotência que ele já tem |
| `visao_salva` | filtro na URL (Fase 2 da revisão de usabilidade) |
| chamados do LTI | `tickets` — **um helpdesk só** |
| mapa, portal do cliente | `/mapas`, `/portal` |

---

## 2. As quatro decisões de produto

Tomadas por você, e cada uma muda o desenho do banco. Ficam escritas aqui porque
daqui a seis meses o motivo some antes do código.

### 2.1 Duas esferas no mesmo sistema

O sistema passa a entender **dois negócios diferentes**:

- **Gestão de TI** — a TI que responde pelo parque de um cliente. O dinheiro
  **sai**: nota de fornecedor → título a pagar → orçamento de TI.
- **Locação e serviços** — o fornecedor que aluga equipamento próprio e presta
  serviço. O dinheiro **entra**: contrato + medição → fatura → título a receber.

A esfera é um atributo **da empresa**, não do usuário, e um administrador pode
ter as duas. Quem tem uma só não vê seletor nenhum — não há escolha a fazer.

Por que não resolver isso só com permissão: permissão responde *“esta pessoa
pode abrir esta tela?”*. A esfera responde *“esta tela existe neste negócio?”*.
Um gestor de TI com todas as permissões do mundo não deveria ver “Tabelas de
franquia”, e um locador não deveria ver “Agentes nas máquinas”. Misturar as duas
perguntas é como a navegação vira um depósito.

### 2.2 Duas tabelas de equipamento, com o mesmo idioma

| | Ativo de TI (`it_assets`, já existe) | Equipamento de frota (novo) |
|---|---|---|
| Pergunta que responde | “quem está com isto, e até quando a garantia cobre?” | “para qual cliente está locado, quanto rodou e quanto custou manter?” |
| Inclui bem de terceiro | **sim** — o que vocês alugam *de* um fornecedor mora aqui | não |
| Inclui bem próprio para locar | não | **sim** — é a razão dele existir |
| Tem medidor e contrato | não | sim |

Um bem nunca está nos dois lugares, e isso é **restrição de banco**, não
disciplina de quem cadastra. O que as duas compartilham — anexo, localização,
histórico, custódia — é código comum, não tabela repetida.

### 2.3 A ordem de serviço é um chamado de campo

A manutenção da locação **não** ganha lista própria de trabalho pendente: vira
um ticket, em fila própria, com três coisas a mais — apontamento de horas, peça
consumida e alçada de custo. Assim o SLA, os anexos, o histórico, a busca, a
paleta e o app valem para ela sem nada novo, e “o que está aberto” continua
tendo **um** lugar.

### 2.4 A fatura e o título são coisas diferentes

Você pediu os dois, e os dois são necessários:

- A **fatura de locação** é o documento: numeração própria, itens (locação fixa,
  excedente de franquia, serviço, peça), calculada e conferível linha a linha.
  Nunca digitada. É dela que sairá a NFS-e quando entrar.
- O **título a receber** é o direito de receber, no financeiro que já existe,
  com baixa, conciliação e fluxo de caixa.

A fatura emitida gera o título e guarda o vínculo nos dois sentidos. A fatura
não guarda saldo nem recebimento; o título não guarda item nem cálculo. Cancelar
a fatura cancela o título. É a mesma regra que fez o orçamento do GSTI *ler* os
títulos em vez de recriá-los.

---

## 3. As fases

Cada fase entrega tela utilizável, com suíte própria, e nenhuma depende de uma
fase posterior. A ordem não é gosto: cada uma é pré-requisito da seguinte.

| Fase | Entrega | Por que nesta ordem |
|---|---|---|
| **0 — Acesso** ✅ | O protótipo cabendo no celular (18 das 25 telas estouravam; agora 0) | Você precisa conseguir revisar antes de aprovar |
| **1 — Esferas** ✅ | Esfera por empresa (0047), seletor no cabeçalho, filtro no menu e na matriz de permissão | Sem ela, cada tela nova nasce no lugar errado e o menu vira depósito |
| **2 — Frota** ✅ | Equipamento próprio, ciclo de vida em gatilho, modelo/fabricante/categoria/depósito, movimentação (0048) | Contrato sem equipamento não aloca nada |
| **3 — Contratos** | Contrato, itens alocados, local de operação, tabela de preço, franquia, reajuste, desconto | Medição sem contrato não sabe o que cobrar |
| **4 — Medição e fatura** | Medidor, leitura, importação de leitura, consumo por competência, **fatura → título a receber** | É aqui que a locação vira dinheiro — e o que fecha o mês |
| **5 — Campo** | Chamado de campo: apontamento, pausa, peça consumida, alçada de custo | Precisa da frota (o que quebrou) e do contrato (quem paga) |
| **6 — Estoque e compras** | Peça, depósito, saldo, política de reposição, inventário, ordem de compra, NF de compra | Só faz sentido quando já existe consumo de peça para abastecer |
| **7 — Planilha do GSTI** | Importar e exportar Excel (o grupo *Sistema* do GSTI) | Conveniência de operação; não bloqueia nada |
| **8 — Produção** | Banco real, migrações, backup, domínio, TLS, observabilidade na VPS | Ver seção 4 |

**Como cada fase é verificada:** migração aplicada em banco limpo, `tsc` e lint
limpos, suíte de unidade verde, suíte de navegador própria (como
`demo/tests/local/gaveta.spec.mjs`), e as telas medidas a 390px — a Fase 0
mostrou que “parece certo” não é medição.

---

## 4. O que precisa estar pronto antes da VPS

A aplicação **já roda sem Supabase** ([docs/22](22-modo-local-sem-supabase.md)):
há um driver próprio sobre `pg` que aplica RLS com `set local role` e
`request.jwt.claims`, igual ao PostgREST. Isso é o que torna a VPS viável sem
reescrever o acesso a dados. O que falta, e não é pouco:

1. **Migrações em banco limpo, do zero ao fim**, sem passo manual — hoje são 46,
   e a unificação acrescenta mais. `scripts/validate-migrations.sh` já confere a
   ordem; falta o ensaio completo em banco vazio, em CI.
2. **Segredos fora do código**: chave de serviço, `JOBS_SECRET`, `RESEND_API_KEY`
   e provedores vivem na configuração do ambiente. A `SUPABASE_SERVICE_ROLE_KEY`
   **nunca** recebe o prefixo `NEXT_PUBLIC_` — ele publica o valor no pacote do
   navegador, e aquela chave ignora todo o RLS.
3. **Backup com restauração testada.** Backup que nunca foi restaurado é
   esperança, não backup.
4. **Trabalhos agendados** (SLA, alertas de contrato, fechamento) com um
   agendador de verdade na VPS, não com a aba aberta de alguém.
5. **Domínio e TLS**, e o cabeçalho de segurança que o Next já emite conferido
   atrás do proxy reverso.
6. **Observabilidade mínima**: log de erro com retenção, e um alerta quando um
   trabalho agendado falha — hoje isso só aparece na tela de trabalhos.

---

## 5. O que este plano deliberadamente não faz

- **Não migra dado nenhum** do GSTI nem do LTI. Importador é projeto próprio,
  decidido depois que o destino existir — e, no caso do GSTI, a decisão já foi
  essa nas três vezes anteriores.
- **Não traz o portal do cliente do LTI** como tela nova: o `/portal` daqui
  ganha as abas de contrato, parque e consumo quando a Fase 4 fechar.
- **Não unifica os dois repositórios de código.** O LTI é NestJS + SPA Vite; o
  que atravessa é o **domínio** (schema, regra, tela), não o código. Copiar o
  código traria junto uma segunda forma de fazer tudo.
