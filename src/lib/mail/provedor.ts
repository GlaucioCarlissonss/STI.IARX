/**
 * O provedor de e-mail, atrás de uma interface de três linhas.
 *
 * ## Por que uma interface, e não a chamada direta
 *
 * Não é previsão de troca de fornecedor — é testabilidade. Com a interface, a
 * drenagem da caixa de saída é exercitada por um provedor de mentira que grava
 * o que recebeu, sem rede nenhuma. Sem ela, só se testaria o provedor.
 *
 * ## Por que `null` quando não está configurado
 *
 * Ausência de chave **não é erro**: o sistema roda sem canal de e-mail, como
 * rodou até agora. O que não pode acontecer é fingir que enviou. Sem provedor, a
 * drenagem devolve `semProvedor` e a fila fica intacta — quando a chave entrar,
 * o acumulado sai. O silêncio é visível em `job_runs`, não escondido.
 */

export interface Mensagem {
  to: string
  toName?: string | null
  subject: string
  text: string
}

export type Envio = { ok: true; id?: string } | { ok: false; erro: string }

export interface Provedor {
  nome: string
  enviar(m: Mensagem): Promise<Envio>
}

/**
 * Resend: escolhido por ser o de menor atrito para começar (domínio verificado,
 * uma chave, uma chamada HTTP). A interface acima é o que torna essa escolha
 * reversível sem tocar na regra.
 */
function resend(apiKey: string, remetente: string): Provedor {
  return {
    nome: 'resend',
    async enviar(m) {
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: remetente,
            to: [m.to],
            subject: m.subject,
            text: m.text,
          }),
        })

        if (!r.ok) {
          /*
           * O corpo do erro do provedor vai para o log e para `last_error`, que
           * só administrador lê. Ele NÃO vira mensagem de tela: é a mesma regra
           * de `mensagemDeErro`, e aqui o texto é em inglês e cita cabeçalho
           * HTTP.
           */
          const corpo = await r.text().catch(() => '')
          return { ok: false, erro: `HTTP ${r.status} ${corpo.slice(0, 300)}` }
        }

        const dados = (await r.json().catch(() => ({}))) as { id?: string }
        return { ok: true, id: dados.id }
      } catch (e) {
        // Rede fora, DNS, tempo esgotado: falha de tentativa, não de mensagem.
        return { ok: false, erro: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}

/**
 * SMTP, para quem já tem caixa de e-mail e não quer um serviço a mais.
 *
 * ## Por que ele existe
 *
 * O Resend é o de menor atrito para COMEÇAR, e o de maior atrito para quem
 * compra hospedagem com e-mail incluído — que é o caso de quase toda VPS
 * brasileira. Exigir um serviço de fora, com verificação de domínio por DNS,
 * para mandar um link de redefinição de senha é pedir que a pessoa monte uma
 * dependência nova antes de conseguir publicar.
 *
 * Sem um dos dois provedores, confirmação de cadastro, convite e redefinição de
 * senha **não saem**. Isso não é um recurso a mais: é o que faz a entrada
 * pública funcionar.
 *
 * ## Por que `nodemailer`, e não um cliente escrito à mão
 *
 * SMTP tem AUTH em vários sabores, STARTTLS, codificação de cabeçalho com
 * acento, quebra de linha canônica e *dot-stuffing* (uma linha que começa com
 * ponto encerra a mensagem se não for escapada). Um cliente caseiro funciona
 * contra o servidor em que foi testado e falha contra o seguinte — e falha
 * entregando mensagem truncada, que é pior que não entregar.
 *
 * ## A porta decide o modo, e isso evita o erro mais comum
 *
 * 465 é TLS desde o primeiro byte; 587 e 25 começam em claro e sobem para TLS
 * com STARTTLS. Trocar os dois dá "wrong version number" ou um tempo de espera
 * sem mensagem — e é o primeiro tropeço de quem configura SMTP. Aqui o padrão
 * vem da porta, e `SMTP_SEGURO` só existe para o caso raro de precisar
 * contrariá-lo.
 */
function smtp(cfg: {
  host: string
  port: number
  user?: string
  pass?: string
  secure: boolean
  remetente: string
}): Provedor {
  return {
    nome: 'smtp',
    async enviar(m) {
      try {
        /* Importado aqui dentro, e não no topo: sem SMTP configurado o módulo
           nunca é carregado, e quem roda só com Resend não paga por ele. */
        const { createTransport } = await import('nodemailer')
        const transporte = createTransport({
          host: cfg.host,
          port: cfg.port,
          secure: cfg.secure,
          auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
          /* Um envio que nunca responde prende o trabalho agendado inteiro. A
             drenagem tem limite de mensagens por execução justamente para ter
             fim; sem tempo-limite aqui, uma mensagem travada anula isso. */
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 20_000,
        })

        const r = await transporte.sendMail({
          from: cfg.remetente,
          to: m.toName ? `${m.toName} <${m.to}>` : m.to,
          subject: m.subject,
          text: m.text,
        })
        return { ok: true, id: r.messageId }
      } catch (e) {
        /* Falha de rede, autenticação recusada, destinatário rejeitado: tudo
           cai aqui e vira falha de TENTATIVA. A caixa de saída reagenda, e o
           motivo vai para `last_error`, que só administrador lê. */
        return { ok: false, erro: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}

/**
 * O provedor que as variáveis de ambiente descrevem, ou `null`.
 *
 * ## A ordem: SMTP primeiro
 *
 * Quem configurou SMTP o fez de propósito — é mais trabalho que colar uma
 * chave de API. Se as duas estiverem presentes, a escolha explícita ganha.
 *
 * `MAIL_FROM` é obrigatório nos dois: o Resend recusa remetente de domínio não
 * verificado, e um servidor SMTP recusa remetente que não é da caixa
 * autenticada. Descobrir isso no primeiro envio de produção seria descobrir
 * tarde.
 */
export function provedorConfigurado(): Provedor | null {
  const remetente = process.env.MAIL_FROM
  if (!remetente) return null

  const host = process.env.SMTP_HOST
  if (host) {
    const port = Number(process.env.SMTP_PORT ?? 587)
    if (!Number.isFinite(port) || port <= 0) {
      console.error('[email] SMTP_PORT inválido:', process.env.SMTP_PORT)
      return null
    }
    /* A porta manda; a variável só existe para contrariá-la quando preciso. */
    const secure = process.env.SMTP_SEGURO
      ? process.env.SMTP_SEGURO === 'true'
      : port === 465
    return smtp({
      host,
      port,
      user: process.env.SMTP_USUARIO,
      pass: process.env.SMTP_SENHA,
      secure,
      remetente,
    })
  }

  const chave = process.env.RESEND_API_KEY
  if (!chave) return null
  return resend(chave, remetente)
}
