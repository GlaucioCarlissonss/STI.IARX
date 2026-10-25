# 18 — A revisão: seis recursos que existiam no banco e não na vida de ninguém

**Status:** implementado (migração 0036).
**Depende de você:** nada. Nenhuma variável nova, nenhuma credencial.

> Esta rodada quase não escreveu banco. Ela encontrou **tabelas com dados, RLS,
> auditoria e nenhuma tela** — recursos que o sistema tinha e que, do ponto de
> vista de quem usa, nunca existiram.

---

## 1. Como as lacunas foram encontradas

Cruzando a lista de tabelas de `public` com as tabelas citadas em `src/`:

```bash
for t in $(psql -At -c "select table_name from information_schema.tables
                         where table_schema='public' and table_type='BASE TABLE'"); do
  grep -rql "'$t'" src/ || echo "SEM UI: $t"
done
```

Treze tabelas apareceram. Sete eram **internas** — escritas por trigger e lidas
por view (`channel_conversations`, `sla_pauses`, `permission_catalog`,
`integration_sync_state`…) — e não precisam de tela. As outras seis eram
promessas não cumpridas.

| Tabela | No banco desde | O que a ausência custava |
|---|---|---|
| `queue_members` | 0004 | A última lacuna ⬜ do M1 no roadmap. Não havia como dizer quem cuida de cada fila |
| `ticket_assets` | 0004 | O README **afirmava** "vínculo com tickets" no inventário desde a primeira versão. "Quantos chamados esta máquina já deu?" não tinha resposta |
| `ticket_telecom_lines` | 0004 | Idem, para linha telefônica |
| `business_hours*` | 0006 | Dava para **escolher** um expediente no contrato de SLA e não dava para **criar** nenhum, nem cadastrar feriado |
| `audit_log` | 0010 | 45 tabelas auditadas por trigger, nenhum lugar para ler o resultado |
| `job_runs` | 0030 | A [docs/13](13-notificacoes-e-trabalhos.md) mandava rodar SQL à mão para saber se o agendador parou |

---

## 2. O que cada uma destravou

### 2.1 Expediente e feriados — `/sla/horarios`

É a de maior consequência, e a mais invisível das seis.

A aritmética já existia: `fn_add_business_minutes` só conta minuto dentro de uma
faixa, e `fn_business_minutes_between` é o que credita a pausa do relógio. O que
faltava era a tela — e, sem ela, **nenhum feriado era respeitado em ambiente
nenhum**. Um chamado aberto em 24 de dezembro às 17h, com prazo de 4 horas,
vencia no dia 25 de manhã, com a equipe em casa e o relógio correndo.

Três coisas que a tela diz porque o banco não diz:

- **Expediente sem faixa não conta tempo nenhum.** É um estado gravável e
  silencioso: o contrato aponta para ele, a conta roda, o prazo nunca vence. A
  tela mostra isso como indicador vermelho na frente, e há asserção de schema
  provando o comportamento.
- **Feriado tem ano.** Carnaval e Corpus Christi mudam de data. Um "recorrente"
  que servisse só aos fixos seria armadilha: a pessoa cadastraria 25/12 e suporia
  o resto coberto.
- **Mudar o expediente muda prazo de chamado em andamento.** A conta é refeita a
  partir da abertura. Não é cadastro inerte.

Duas faixas no mesmo dia são o almoço — `08:00–12:00` e `13:00–18:00` fazem o
relógio parar entre uma e outra. É a razão de a tabela existir em vez de duas
colunas `abre`/`fecha`.

### 2.2 Trilha de alterações — `/auditoria`

`app.attach_audit()` grava desde a 0010, hoje em 45 tabelas, e nunca houve como
ler. A pergunta que a trilha responde é sempre a mesma e sempre vem em dia ruim:
**quem mudou isso?** Um contrato de SLA que estava em 4 horas e amanheceu em 24;
um ativo que trocou de filial; um perfil que ganhou uma permissão.

O trabalho da tela é tradução. `audit_log.changes` guarda o diff cru em três
formatos:

```
insert → { "created": { <linha inteira> } }
update → { "coluna": { "old": ..., "new": ... }, ... }
delete → { "deleted": { <linha inteira> } }
```

Mostrar isso cru seria mostrar JSON a quem quer saber quem mexeu no contrato da
Transportadora Alfa. Então: criação e exclusão aparecem como o **ato** e o
tamanho do registro (listar trinta colunas de um chamado recém-criado afogaria a
alteração que interessa), e alteração aparece como campo, de e para — descartando
`tenant_id`, `updated_at` e os outros que mudam em toda linha.

Dois índices entraram junto, e não são detalhe: `audit_log` cresce para sempre e
sem teto. Um filtro por entidade sem índice vira varredura completa, e a primeira
abertura da tela num ambiente com um ano de uso derrubaria o banco.

### 2.3 Trabalhos agendados — `/auditoria/trabalhos`

**Trabalho parado é invisível por natureza.** Não há erro, não há alerta,
simplesmente nada acontece: o aviso de SLA não sai, o chamado resolvido não fecha,
o convite de satisfação não é enviado — e o primeiro a perceber é o cliente que
não recebeu nada.

O número que importa é **minutos desde a última execução**, e não o total nem a
taxa de sucesso: um trabalho com 4.000 execuções perfeitas e a última há três dias
está quebrado, e a taxa continua dizendo 100%. A view `vw_job_health` calcula isso
porque a tela não sabe a cadência esperada de cada trabalho.

`job_runs` não tem `tenant_id` — o agendador é infraestrutura compartilhada — e a
policy dela restringe a leitura ao operador da plataforma. Então "vazio" tem duas
causas muito diferentes, e a tela diz as duas: ou nunca rodou, ou o seu acesso é
de administrador do ambiente e não de quem opera a plataforma. A segunda não é
defeito.

### 2.4 Equipamento e linha no chamado

Sem o vínculo, "quantos chamados esta máquina já deu?" não tinha resposta — e é a
pergunta que decide trocar um equipamento em vez de consertá-lo pela quinta vez.
O histórico do ativo não mostrava o atendimento e o do chamado não mostrava o
equipamento: as duas metades da mesma história em telas que não se falavam.

A chave é `helpdesk.tickets.vincular`, e não `editar`, porque vincular **não muda
o chamado** — acrescenta contexto a ele. É ato de quem atende, feito no meio do
atendimento, e não exige o poder de mudar título, fila ou prazo.

Os candidatos vêm restritos à **filial** do chamado: `it_assets` e
`telecom_lines` são por filial, e um ambiente com trinta filiais tem milhares de
ativos. Oferecer todos num `select` seria uma lista inutilizável.

### 2.5 Equipe da fila

Era a última lacuna que o roadmap ainda marcava como ⬜ no M1.

**E ela não é autorização.** O RLS de `tickets` não lê `queue_members`, e ninguém
deixa de ver um chamado por não ser membro. A tela diz isso em negrito, porque
sugerir o contrário seria o pior tipo de erro: a pessoa configuraria a fila
achando que fechou o acesso, e não fechou nada. Há uma asserção de schema que
quebra se alguém um dia ligar as duas coisas sem decidir ligá-las.

O que a lista é: quem a operação considera responsável — para atribuir, para medir
carga e para a pergunta "quem cuida disso quando o Jorge entra de férias".

### 2.6 Exportação em CSV (LG-11)

A lacuna recomendava **gerar no servidor**, "para que o arquivo respeite
exatamente o escopo de RLS do usuário e não dependa do que o navegador carregou".
É o que `/api/exportar/[recurso]` faz: usa o cliente de sessão, as mesmas policies
de sempre.

Gerar no cliente exportaria **a página visível** — 50 linhas desde a paginação da
entrega 6. "Exportei o inventário" com 50 de 412 ativos é pior que não exportar.

**CSV e não XLSX nem PDF.** XLSX exige biblioteca (~1 MB) e PDF exige duas. CSV
abre no Excel, no LibreOffice e no Sheets, não acrescenta dependência, e é o
formato que quem recebe realmente usa. Quando alguém pedir o PDF carimbado para um
auditor, aí a biblioteca se justifica.

Três armadilhas do formato, resolvidas em `src/lib/exportacao.ts`:

| Armadilha | O que acontece sem tratar |
|---|---|
| Separador vírgula | O Excel pt-BR lê vírgula como separador **decimal**: o arquivo abre com tudo na primeira coluna |
| Sem BOM | O Excel abre UTF-8 como Latin-1 e todo acento vira caractere estranho |
| Célula com `=` `+` `-` `@` | É **fórmula**: `=cmd\|'/c calc'!A1` roda um comando na máquina de quem abre |

A terceira é de segurança, e não é hipótese: o conteúdo exportado vem de campo
livre preenchido por terceiros — título de chamado, nome de cliente, mensagem de
WhatsApp. Toda célula assim é prefixada com apóstrofo.

O `recurso` é chave de um catálogo fechado, nunca nome de tabela vindo da URL:
com nome livre, `/api/exportar/profiles` funcionaria, e — embora o RLS continuasse
valendo — a rota viraria um leitor genérico do banco, com colunas que ninguém
escolheu e sem a permissão da tela correspondente.

---

## 3. O que NÃO ganhou tela, e por quê

**`sla_pauses` não ganhou escrita.** A pausa do relógio é automática desde a 0006:
a trigger abre quando o chamado entra em estado de espera e fecha quando sai,
creditando só os minutos que caíram dentro do expediente. Um botão de "pausar"
criaria um segundo caminho para a mesma coisa, e os dois brigariam pelo índice
único de pausa aberta.

O que faltava ali era **leitura**: o chamado mostrava o distintivo "relógio
pausado" e o total de minutos, e não dizia desde quando nem por quê. Agora diz.

As outras seis tabelas da varredura (`permission_catalog`, `integration_sync_state`,
`integration_mapping_versions`, `channel_conversations`, `ticket_assets` antes
desta rodada, `audit_log` como escrita) são internas por natureza: escritas por
trigger, lidas por view ou pelo código, e uma tela para elas seria tela para o
encanamento.

---

## 4. Dois defeitos antigos, achados por um script novo

`ticket_priorities.name` **não existe** — a coluna se chama `label`. O nome errado
estava em duas telas já entregues: o cadastro de serviço (Onda 4) e o cadastro de
canal (Onda 5). Nas duas, o Supabase devolvia erro, o `?? []` virava lista vazia,
e o campo **"Prioridade" nunca teve opção nenhuma**.

Em silêncio, e sem nada que pegasse: o `tsc` não vê o nome de uma coluna, porque
ele é uma string; o `.returns<T>()` é **asserção** de quem escreveu, não
verificação; e não há Supabase neste ambiente para um teste exercitar.

`scripts/conferir-colunas.py` confere cada `.from('tabela').select('coluna')`
contra o schema real. Achou os dois na primeira execução e passou a fazer parte da
verificação:

```bash
bash scripts/validate-migrations.sh && python3 scripts/conferir-colunas.py
```

---

## 5. O que continua aberto, e por que

> **M7 e M8 fecharam na migração 0041.** Eram descritos aqui como "a pendência
> mais barata da lista e a mais fácil de fechar", e eram. `app.job_contract_alerts()`
> avisa de contrato de fornecedor, contrato de link e fim de fidelidade;
> `app.job_link_alerts()` avisa de queda além do limiar e do retorno. Ver
> [docs/13](13-notificacoes-e-trabalhos.md).
>
> Fechá-los descobriu uma lacuna maior: **os onze parâmetros de operação de
> `tenants` nunca tiveram tela.** Percentuais de SLA, fechamento automático,
> cota de anexo, os quatro do agente — todos no valor padrão da migração que os
> criou, em qualquer ambiente instalado, porque mudá-los exigia um `update` à
> mão no banco. É o mesmo defeito desta revisão, numa tabela que a varredura não
> pegou: `tenants` tinha tela de leitura em toda sessão, só não tinha de
> escrita. Agora tem: `/ambiente`.

> **M10 fechou na migração 0042.** O diagnóstico ("o histórico existe e ninguém
> lê") estava certo pela metade: além de não haver leitura, não havia como
> editar o mapeamento pela tela, nem voltar a uma versão, nem saber o que um
> payload produziria antes de ele chegar. As três coisas existem agora, e o
> ensaio chama **a mesma função que o webhook chama** — uma segunda
> implementação atestaria o que o sistema não faz.
>
> Abrir o histórico para leitura revelou um defeito que ninguém sentia porque
> ninguém olhava: a trigger era `for each row`, então uma edição de cinco regras
> gravava **dez versões**, nove delas estados que o mapeamento nunca teve como
> conjunto. Quem fosse "voltar para antes da mudança de ontem" escolheria um
> desses. Agora é uma instrução, uma versão.

> **A aprovação de pedido fechou na migração 0043** — e veio na frente da fila
> por um motivo que não estava escrito aqui: `service_catalog.requer_aprovacao`
> existia desde a 0033, a tela de pedido mostrava em destaque que "o chamado é
> aberto na hora e fica aguardando", e **nada acontecia**. O chamado era criado
> e atendido como qualquer outro. A coluna era decoração, e a tela, uma promessa
> falsa — que é pior que um recurso ausente, porque ninguém descobre por erro:
> descobre pelo serviço executado.
>
> O bloqueio registrado ("quem aprova o quê é decisão do cliente") continua
> sendo do cliente, mas deixou de bloquear: virou cadastro. Em branco, aprovam
> gestores e administradores; preenchido com um perfil de acesso, só quem tem
> aquele perfil — e ter a permissão não basta.
>
> Duas asserções acharam defeitos durante a implementação: o relógio do SLA
> corria durante a aprovação (a trigger de pausa da 0006 só roda em `update`, e
> o chamado já nasce em espera), e a trigger nova disparava **antes** da que
> cria o `sla_tracking`, porque triggers do mesmo evento disparam em ordem
> alfabética.

Nada aqui é "falta de tempo" — cada um tem um motivo.

| Pendência | Por que continua aberta |
|---|---|
| **Edge Function do Zabbix (M8, LG-07)** | Exige um Zabbix real para testar contra. Hoje a queda é registrada à mão, pelo mesmo evento que o webhook vai gravar — sem retrabalho quando ele chegar |
| **PWA do portal, identidade visual por cliente, domínio próprio** | É o "módulo maior" do LG-08. Nenhum deles muda o que o solicitante consegue fazer — mudam onde ele faz |
| **Chat (portal e chatbot)** | Quarta superfície de atendimento, e a única que exige presença. Chat sem ninguém do outro lado promete resposta imediata e não entrega |
| **Embeddings / semelhança semântica** | Dependência nova para melhorar um passo que não é o gargalo. O gargalo é a base ter poucos artigos |
| **PDF/XLSX** | Duas bibliotecas por um formato que, hoje, ninguém pediu nominalmente |
| **Player de áudio e vídeo em anexo (M5)** | Cosmético, e o navegador já abre o arquivo |
| **LG-01 (dado sensível de saúde), LG-03 (antivírus), LG-10 (pausa configurável), LG-13 (área em tickets)** | São **decisões pendentes**, não código pendente. Cada uma precisa de uma resposta do cliente antes de virar implementação |

E, antes de tudo isso, continuam de pé os três passos de
[docs/09](09-conectar-no-supabase.md): **o sistema nunca rodou contra a
infraestrutura de produção.** Enquanto isso não acontecer, todo prazo depois disso
é chute — e esse é o item que destrava os outros, não mais código.
