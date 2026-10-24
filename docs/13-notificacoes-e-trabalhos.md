# 13 — Avisos por e-mail e trabalhos agendados: como ligar

**Status:** implementado (Onda 1 de [docs/12](12-paridade-milvus.md)).
**Depende de você:** três variáveis e um agendador. Enquanto não existirem, a
aplicação funciona — ela só não manda e-mail, e isso fica **visível**, não
escondido.

---

## 1. O que passou a existir

| O que | Onde |
|---|---|
| Aviso de SLA: prazo se aproximando, crítico e estourado | `app.job_sla_alerts()` |
| Fechamento automático do chamado resolvido | `app.job_auto_close()` |
| Convite de avaliação (1 a 5) depois do encerramento | `app.job_satisfaction_invites()` |
| Tela de resultados | `/satisfacao` |
| Resposta da pesquisa, sem login | `/avaliar/<token>` |
| Quem não quer receber desliga por tipo | `/conta` |

O **fechamento automático** merece uma nota: `tenants.auto_close_after_days`
existe desde a migração 0002, é lido pela sessão e **nunca foi executado por
ninguém**. Não havia nenhum processo agendado nesta plataforma. A regra estava
declarada e parada.

---

## 2. As três variáveis *(depende de você)*

Vão na configuração do ambiente, junto das que o [docs/09](09-conectar-no-supabase.md)
já pede. **Nenhuma delas leva `NEXT_PUBLIC_`** — as três são segredo.

| Variável | O que é | Onde pegar |
|---|---|---|
| `RESEND_API_KEY` | A chave da API do Resend | [resend.com](https://resend.com) → API Keys |
| `MAIL_FROM` | O remetente, ex. `STI <suporte@iartech.cloud>` | Precisa ser de **domínio verificado** no Resend |
| `JOBS_SECRET` | Um segredo inventado por você, só para esta finalidade | Gere com `openssl rand -hex 32` |

### Por que `MAIL_FROM` é obrigatório junto da chave

O Resend recusa remetente de domínio não verificado. Se a chave existisse sem o
remetente, o primeiro envio de produção descobriria isso — e descobrir no
primeiro envio de produção é descobrir tarde. Faltando qualquer uma das duas, o
sistema trata como "sem provedor": a fila **não é consumida** e nada se perde.

### Por que o `JOBS_SECRET` é separado de tudo

A rota `/api/jobs/run` fecha chamado e dispara e-mail. Ela não pode compartilhar
credencial com mais nada, e **sem a variável ela responde 503** — fechada, nunca
aberta por esquecimento. Um endpoint desses caindo em "modo sem senha" por
variável faltando é exatamente o tipo de acidente que acontece.

---

## 3. O agendador *(depende de você)*

A rota precisa ser chamada de tempos em tempos. **Qualquer** agendador serve:

```bash
curl -X POST https://sti.iartech.cloud/api/jobs/run \
  -H "Authorization: Bearer $JOBS_SECRET"
```

**De quanto em quanto tempo:** a cada 10 ou 15 minutos é o bastante. O aviso de
SLA perde o sentido se chegar uma hora depois, e mais frequente que isso não
melhora nada — os percentuais de atenção e crítico são do tenant, e mudam de
estado em escala de horas.

Três jeitos, do mais simples ao mais robusto:

1. **Coolify** — tarefa agendada apontando para o contêiner. É onde o Supabase já
   roda, então é um lugar a menos para lembrar.
2. **GitHub Actions** — `schedule: cron`, com o segredo no `secrets`. Grátis, e o
   histórico de execução fica à vista.
3. **`pg_cron` + `pg_net`** no próprio Postgres. O mais robusto, e o único que eu
   **não** pude verificar: não dá para afirmar daqui que esta instalação tem as
   duas extensões. Confira com `select * from pg_extension`.

### Como saber se parou

```sql
select job, max(started_at) as ultima, bool_and(ok) as sem_falha
  from public.job_runs
 group by job;
```

A tabela `job_runs` existe para isto. Trabalho parado é invisível por natureza:
não há erro, não há alerta, simplesmente nada acontece — e o primeiro a perceber
seria o cliente que não recebeu o aviso.

---

## 4. Testando antes de confiar

**1. A rota está fechada?**

```bash
curl -i -X POST https://sti.iartech.cloud/api/jobs/run
# espera 401 (ou 503, se JOBS_SECRET ainda não existe)
```

**2. Os trabalhos rodam?**

```bash
curl -X POST https://sti.iartech.cloud/api/jobs/run \
  -H "Authorization: Bearer $JOBS_SECRET"
```

A resposta traz a contagem de cada um e o resultado do envio. `"semProvedor":
true` significa que a chave do Resend ainda não está lá — e que a fila está
intacta, esperando.

**3. O e-mail sai?** Encerre um chamado de teste e rode de novo. Deve chegar um
convite de avaliação para quem abriu o chamado.

---

## 5. O que fica registrado

| Tabela | O que guarda | Quem lê |
|---|---|---|
| `email_outbox` | Toda mensagem: destinatário, assunto, tentativas, erro | Só administrador (contém e-mail de outras pessoas) |
| `job_runs` | Uma linha por execução, com a contagem | Só `super_admin` — é da plataforma |
| `ticket_satisfaction` | Nota, comentário e data | Quem já enxerga o chamado |
| `notification_preferences` | Quem pediu silêncio, e de quê | **Só a própria pessoa**, nem o administrador |

O corpo do convite de avaliação é **apagado depois do envio**: ele carrega o
token do link em claro, e segredo que já cumpriu o papel e continua guardado é só
risco acumulado. O assunto, o destinatário e a data ficam — que é o que o suporte
precisa.

---

## 6. Decisões que você pode querer rever

Estão aqui porque mudam o que as pessoas recebem, e porque a escolha é de
produto, não de engenharia:

| Decisão | Como está | Como mudar |
|---|---|---|
| Quem recebe o aviso de SLA | O responsável; **sem responsável, todos os gestores e admins ativos** | `app.job_sla_alerts()` |
| Quando o convite de avaliação sai | No **encerramento**, não na resolução — entre os dois a pessoa ainda pode reabrir, e perguntar "como foi?" para quem vai dizer "não resolveu" é a pior hora | `app.job_satisfaction_invites()` |
| Validade do link de avaliação | 30 dias | idem |
| Escala | 1 a 5 (CSAT), não 0 a 10 (NPS) — são perguntas diferentes, e misturá-las dá um número que não responde nenhuma | migração 0029 |
| Padrão de recebimento | **Ligado.** Sem linha em `notification_preferences` = recebe | `app.quer_notificacao()` |
| Ranking por atendente | **Não existe**, de propósito: nota vira meta, meta vira pressão para pedir nota boa, e a pesquisa passa a medir quem pede melhor | — |
