import { z } from 'zod'

/**
 * O contrato comum dos canais de conversa.
 *
 * ## A forma única, e por que ela existe
 *
 * WhatsApp, e-mail, Bitrix24 e N8N entregam payloads completamente diferentes —
 * o da Meta tem `entry[].changes[].value.messages[]`, o do e-mail depende do
 * provedor, o do Bitrix24 vem em `application/x-www-form-urlencoded`. Mas o que
 * o sistema precisa saber é sempre o mesmo: **quem falou, o que disse, quando, e
 * qual é o id disso lá fora**.
 *
 * Normalizar na borda deixa `channel_ingest` (no banco) com uma entrada só. A
 * alternativa — cada provedor com o próprio caminho até o chamado — produziria
 * quatro implementações da regra de threading, e elas divergiriam em semanas.
 */

export const mensagemNormalizadaSchema = z.object({
  /**
   * O id da mensagem no provedor. É a idempotência — e ela não é opcional no
   * WhatsApp, que reentrega o webhook por desenho quando não recebe 200 rápido.
   */
  externo: z.string().trim().min(1).max(200).optional(),
  /** Telefone em E.164, endereço de e-mail, id de usuário do Bitrix24. */
  de: z.string().trim().min(1).max(200),
  nome: z.string().trim().max(200).optional(),
  texto: z.string().trim().max(20000).optional(),
  /** Quando o PROVEDOR diz que a mensagem foi enviada. */
  em: z.string().datetime().optional(),
  /** `Message-ID`/`In-Reply-To` no e-mail; o WhatsApp não tem. */
  thread: z.string().trim().max(400).optional(),
  /*
   * Mídia por REFERÊNCIA, nunca por conteúdo. O WhatsApp entrega uma URL com
   * prazo de validade, e baixar o arquivo exige o token de acesso, cota de
   * Storage e política de retenção — três decisões que são de outra onda. O que
   * fica é o bastante para saber que houve um anexo e ir buscá-lo.
   */
  midia: z
    .array(
      z.object({
        tipo: z.string().trim().max(60),
        nome: z.string().trim().max(300).optional(),
        url: z.string().trim().max(2000).optional(),
        id: z.string().trim().max(200).optional(),
      }),
    )
    .max(20)
    .optional(),
})

export type MensagemNormalizada = z.infer<typeof mensagemNormalizadaSchema>

/** O que a rota sabe do canal antes de interpretar o corpo. */
export interface CanalResolvido {
  kind: 'whatsapp' | 'email' | 'bitrix24' | 'n8n'
  status: string
  config: Record<string, unknown>
  secret_ref: string | null
}

/** O resultado de uma tentativa de entrega. */
export type Entrega = { ok: true; externo?: string } | { ok: false; erro: string }

/**
 * Um adaptador de provedor.
 *
 * As três responsabilidades são separadas de propósito: `verificar` roda sobre os
 * BYTES CRUS (a assinatura da Meta é sobre eles, e re-serializar o JSON quebra o
 * HMAC), `normalizar` roda sobre o objeto já lido, e `enviar` não toca em nada do
 * que entra.
 */
export interface Provedor {
  nome: string

  /**
   * Confere que o corpo veio mesmo do provedor.
   *
   * Recebe os bytes CRUS. Devolver `false` faz a rota responder 401 sem olhar o
   * conteúdo — que é o ponto: um corpo não autenticado não deve nem ser
   * interpretado.
   *
   * Um provedor sem assinatura (N8N, a maioria dos relés de e-mail) devolve
   * `true` e se apoia no segredo da URL. Está dito em cada adaptador qual é o
   * caso, porque "este canal não verifica assinatura" é uma informação de
   * segurança, não um detalhe.
   */
  verificar(bruto: Uint8Array, cabecalhos: Headers, canal: CanalResolvido): boolean

  /**
   * Traduz o payload do provedor para zero ou mais mensagens normalizadas.
   *
   * ZERO é um resultado normal e frequente: a Meta manda eventos de status de
   * entrega (`sent`, `delivered`, `read`) no mesmo webhook das mensagens, e
   * nenhum deles é uma mensagem. Tratá-los como erro encheria o registro de
   * falhas em operação perfeitamente normal.
   */
  normalizar(corpo: unknown, canal: CanalResolvido): MensagemNormalizada[]

  /** Entrega uma resposta. `destino` é o contato; `texto` é o corpo. */
  enviar(
    destino: string,
    texto: string,
    canal: CanalResolvido,
    credencial: string | null,
  ): Promise<Entrega>
}

/**
 * Lê a credencial do ambiente, pelo NOME que o canal guardou.
 *
 * O banco guarda a referência, o ambiente guarda o valor (ADR-009). Esta função
 * é o único lugar onde os dois se encontram — e ela devolve `null` em vez de
 * lançar, porque canal sem credencial é um estado legítimo: ele recebe e não
 * responde, exatamente como a caixa de saída de e-mail sem `RESEND_API_KEY`.
 */
export function credencialDoCanal(secretRef: string | null): string | null {
  if (!secretRef) return null
  /* A validação de formato é a mesma do CHECK no banco. Repeti-la aqui não é
     redundância inútil: `process.env[x]` com `x` vindo de uma linha de tabela é
     exatamente o tipo de leitura que alguém usaria para sondar o ambiente. */
  if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(secretRef)) return null
  return process.env[secretRef] ?? null
}

/** Texto de um erro HTTP, cortado para caber no registro. */
export function erroDeEntrega(status: number, corpo: string): string {
  const limpo = corpo.replace(/\s+/g, ' ').trim()
  return `HTTP ${status}${limpo ? `: ${limpo.slice(0, 300)}` : ''}`
}
