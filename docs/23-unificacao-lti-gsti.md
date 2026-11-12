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

Restava **uma** peça do GSTI: o ciclo de planilha, que lá é o grupo *Sistema*.
Entrou na Fase 7 (0054) — com uma diferença deliberada em relação ao original:
**CSV, e não Excel**. Ler `.xlsx` exige uma biblioteca que descompacta ZIP e lê
XML, e enquanto “Salvar como CSV” resolve, o peso não se justifica; a tela diz
isso em vez de aceitar o arquivo e falhar depois. A exportação já seguia o mesmo
raciocínio desde a LG-11.

E o ciclo fechou uma lacuna que a Fase 4 tinha deixado em aberto: a **importação
de leitura de medidor**, prometida naquela linha e não entregue. É o recurso de
maior volume dos seis — mil leituras por mês não se digitam.

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

### 2.5 O saldo de estoque é derivado, e o razão é imutável (Fase 6)

Não é uma quinta decisão sua — é a consequência das quatro primeiras aplicada ao
estoque, e fica escrita aqui porque é a que mais tenta se desfazer sozinha.

`part_balances` é escrito **somente** pelo gatilho de `part_movements`; não há
policy de escrita para ninguém, nem para o gestor. Para o saldo mudar, alguém
precisa dizer *por quê* — entrou por compra, saiu por atendimento, foi ajustado
por contagem. E movimento não se edita nem se apaga: errou, lança-se o
contrário, e os dois ficam à vista.

Três consequências que a tela cumpre:

- **saldo negativo é recusado** — não é um número menor que zero, é a confissão
  de que falta um movimento;
- **a sugestão de compra é máximo − saldo**, não mínimo − saldo: repor até o
  mínimo faz comprar de novo na semana seguinte;
- **a contagem congela o esperado na abertura** — compará-lo com o saldo do
  fechamento transformaria a peça consumida no meio numa falta que nunca houve.

### 2.6 O importador não é porta dos fundos (Fase 7)

Toda linha importada passa pela mesma guarda, pelo mesmo RLS e pelos mesmos
gatilhos de quem digita na tela. A permissão é **dupla**: uma chave para usar o
importador e a chave do próprio cadastro — quem não pode criar cliente à mão não
cria em lote.

Quatro regras sustentam o resto, e as quatro existem para o mesmo fim: que o
erro apareça **antes** de virar dado.

1. **Nada é gravado antes da conferência.** O lote nasce como prévia e só
   escreve quando alguém manda aplicar.
2. **Erro é por linha**, com o número e o motivo em português. "Falhou" num
   arquivo de 300 linhas não diz nada a ninguém.
3. **A chave natural decide** criar, atualizar ou pular — reenviar o mesmo
   arquivo não duplica. É o acidente mais comum de importador.
4. **As recusadas voltam num arquivo**, com a linha original e o motivo ao lado.
   Sem ele, corrigir sete linhas no meio de 312 leva a pessoa a refazer a
   planilha inteira.

E a planilha enviada **não é guardada**: é lida em memória e descartada. Guardá-la
criaria um arquivo com dado de cliente dentro do bucket, sem dono e sem prazo.

---

## 3. As fases

Cada fase entrega tela utilizável, com suíte própria, e nenhuma depende de uma
fase posterior. A ordem não é gosto: cada uma é pré-requisito da seguinte.

| Fase | Entrega | Por que nesta ordem |
|---|---|---|
| **0 — Acesso** ✅ | O protótipo cabendo no celular (18 das 25 telas estouravam; agora 0) | Você precisa conseguir revisar antes de aprovar |
| **1 — Esferas** ✅ | Esfera por empresa (0047), seletor no cabeçalho, filtro no menu e na matriz de permissão | Sem ela, cada tela nova nasce no lugar errado e o menu vira depósito |
| **2 — Frota** ✅ | Equipamento próprio, ciclo de vida em gatilho, modelo/fabricante/categoria/depósito, movimentação (0048) | Contrato sem equipamento não aloca nada |
| **3 — Contratos** ✅ | Contrato, itens alocados, local de operação, franquia e excedente, estados em gatilho (0049) | Medição sem contrato não sabe o que cobrar |
| **4 — Medição e fatura** ✅ | Medidor, leitura, consumo por competência, **fatura → título a receber** (0050) | É aqui que a locação vira dinheiro — e o que fecha o mês |
| **5 — Campo** ✅ | Chamado de campo: equipamento, apontamento de horas e peças, alçada de custo em gatilho (0051) | Precisa da frota (o que quebrou) e do contrato (quem paga) |
| **6 — Estoque e compras** ✅ | Peça, saldo derivado do razão, política por peça×depósito, contagem, ordem de compra, **NF → título a pagar** (0053) | Só faz sentido quando já existe consumo de peça para abastecer |
| **7 — Planilha do GSTI** ✅ | Importar com conferência linha a linha, modelo por recurso, arquivo de correção; exportação atrás de chave própria (0054) | Conveniência de operação; não bloqueia nada |
| **8 — Produção** | Banco real, migrações, backup, domínio, TLS, observabilidade na VPS | Ver seção 4 |

**Como cada fase é verificada:** migração aplicada em banco limpo, `tsc` e lint
limpos, suíte de unidade verde, suíte de navegador própria (como
`demo/tests/local/gaveta.spec.mjs`), e as telas medidas a 390px — a Fase 0
mostrou que “parece certo” não é medição.

> **E a validação de schema roda a CADA fase, não ao final.** As Fases 3 e 4
> foram emendadas sem rodar `npm run db:validate` entre elas, e as duas
> entregaram views sem `security_invoker = true` — o que, em Postgres, faz a
> view rodar com os privilégios do dono e ignorar o RLS. Uma sessão autenticada
> de um tenant inexistente via **três alocações e dois consumos** de outro
> tenant. A asserção que cobra a opção em toda view de `public` existe desde a
> seção 1 de `supabase/tests/schema_test.sql` e acusou as três assim que foi
> executada; a correção é a migração **0052**. A rede existia — faltou puxá-la.

---

## 4. O que precisa estar pronto antes da VPS

A aplicação **já roda sem Supabase** ([docs/22](22-modo-local-sem-supabase.md)):
há um driver próprio sobre `pg` que aplica RLS com `set local role` e
`request.jwt.claims`, igual ao PostgREST. Isso é o que torna a VPS viável sem
reescrever o acesso a dados. O que falta, e não é pouco:

1. ~~**Migrações em banco limpo, do zero ao fim**, sem passo manual — hoje são
   46, e a unificação acrescenta mais. `scripts/validate-migrations.sh` já
   confere a ordem; falta o ensaio completo em banco vazio, em CI.~~
   **Correção:** isto já existia quando o plano foi escrito. O job `database` do
   `.github/workflows/ci.yml` sobe um PostgreSQL limpo, aplica todas as
   migrações em ordem, roda o seed e executa as asserções de RLS com um papel
   sem `bypassrls` — a cada push. O que faltava de verdade era outra coisa, e
   só apareceu ao montar a VPS: **o caminho de atualização.** Aplicar tudo num
   banco vazio é o primeiro dia; o segundo dia é aplicar só o que falta num
   banco com dados, e as migrações não são idempotentes. Isso agora é
   `scripts/migrar.sh`, com livro-razão e soma de verificação, e o CI o roda
   **duas vezes** — a segunda não pode aplicar nada.
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

### Situação dos seis (Fase 8)

Os seis estão fechados, e o runbook é a [docs/24](24-producao-na-vps.md).

| # | Onde ficou |
|---|---|
| 1 | já existia (job `database`); o que faltava era o caminho de **atualização**: `scripts/migrar.sh` |
| 2 | `src/lib/segredos.ts` + passo de CI **antes** do build, que é a única ordem que serve |
| 3 | `scripts/backup.sh`, `scripts/restaurar.sh` e o **ensaio** em CI, que suja o banco depois do dump para que restaurar tenha o que desfazer |
| 4 | serviço `agendador` no `compose.producao.yml` |
| 5 | `Caddyfile` — TLS automático, HSTS, e o log com rotação declarada |
| 6 | migração 0055: distingue **parou** de **falhou**, avisa uma vez por episódio por e-mail e webhook |

Uma ressalva do item 6 que vale estar aqui e não só na docs/24: o alerta é
disparado pela própria rota de trabalhos agendados. Se o agendador morrer por
inteiro, ninguém o chama e nenhum aviso sai. Ele cobre "um trabalho parou
enquanto os outros rodam" — o caso comum e o mais difícil de notar. O outro caso
exige um vigia de fora, e por isso a docs/24 manda apontar o monitor de
disponibilidade para `/api/health`.

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
