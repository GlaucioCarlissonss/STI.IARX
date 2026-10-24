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
 * O provedor que as variáveis de ambiente descrevem, ou `null`.
 *
 * `MAIL_FROM` é obrigatório junto com a chave: o Resend recusa remetente de
 * domínio não verificado, e descobrir isso só no primeiro envio de produção
 * seria descobrir tarde.
 */
export function provedorConfigurado(): Provedor | null {
  const chave = process.env.RESEND_API_KEY
  const remetente = process.env.MAIL_FROM
  if (!chave || !remetente) return null
  return resend(chave, remetente)
}
