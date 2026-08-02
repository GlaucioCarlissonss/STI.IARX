/**
 * Cliente do Bitrix24 REST usado pelas Edge Functions.
 *
 * Segredos NUNCA vêm do banco (ADR-009): a URL do incoming webhook é lida de
 * variável de ambiente, cujo NOME está em `integrations.secret_ref`.
 */

export interface BitrixTask {
  id: string
  [key: string]: unknown
}

/** Erro de chamada ao Bitrix24, com o status HTTP preservado para o log. */
export class BitrixError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message)
    this.name = 'BitrixError'
  }
}

/**
 * Chama um método REST do Bitrix24 via incoming webhook.
 *
 * `webhookUrl` tem a forma `https://portal.bitrix24.com.br/rest/<user>/<segredo>/`
 * — o segredo faz parte da URL, então ela é tratada como credencial: nunca é
 * registrada em log nem devolvida em mensagem de erro.
 */
export async function callBitrix<T = unknown>(
  webhookUrl: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const base = webhookUrl.endsWith('/') ? webhookUrl : `${webhookUrl}/`
  const url = `${base}${method}.json`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })

  const text = await response.text()

  if (!response.ok) {
    throw new BitrixError(`Bitrix24 respondeu ${response.status} em ${method}`, response.status, text)
  }

  let json: { result?: T; error?: string; error_description?: string }
  try {
    json = JSON.parse(text)
  } catch {
    throw new BitrixError(`Resposta não-JSON do Bitrix24 em ${method}`, response.status, text)
  }

  if (json.error) {
    throw new BitrixError(
      `Bitrix24 retornou erro em ${method}: ${json.error_description ?? json.error}`,
      response.status,
      text,
    )
  }

  return json.result as T
}

/**
 * Busca a tarefa completa.
 *
 * É indispensável: o webhook `ONTASKUPDATE` do Bitrix24 entrega apenas
 * `FIELDS_AFTER.ID`, sem os campos alterados. Sem esta chamada de volta, não há
 * como saber o que mudou. (Ver docs/05-integracao-bitrix24.md §3.)
 */
export async function getBitrixTask(webhookUrl: string, taskId: string): Promise<BitrixTask | null> {
  const result = await callBitrix<{ task?: BitrixTask }>(webhookUrl, 'tasks.task.get', {
    taskId,
    select: [
      'ID',
      'TITLE',
      'DESCRIPTION',
      'STATUS',
      'PRIORITY',
      'RESPONSIBLE_ID',
      'CREATED_BY',
      'CREATED_DATE',
      'CHANGED_DATE',
      'CLOSED_DATE',
      'DEADLINE',
      'GROUP_ID',
      'TAGS',
    ],
  })
  return result?.task ?? null
}

/** Dados de um usuário do Bitrix24 — usados para casar responsável por e-mail. */
export async function getBitrixUser(
  webhookUrl: string,
  userId: string,
): Promise<{ ID: string; EMAIL?: string; NAME?: string; LAST_NAME?: string } | null> {
  const result = await callBitrix<Array<{ ID: string; EMAIL?: string; NAME?: string; LAST_NAME?: string }>>(
    webhookUrl,
    'user.get',
    { ID: userId },
  )
  return Array.isArray(result) && result.length > 0 ? result[0] : null
}

/** Atualiza a tarefa original — sincronização reversa (RF-INT-09). */
export async function updateBitrixTask(
  webhookUrl: string,
  taskId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await callBitrix(webhookUrl, 'tasks.task.update', { taskId, fields })
}

/**
 * Retenta com backoff exponencial (RF-INT-05): 1s, 2s, 4s.
 *
 * Só faz sentido retentar falha transitória. Um 4xx (payload inválido, token
 * revogado) vai falhar de novo igual — retentar só atrasa o registro do erro.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = 3,
): Promise<{ result?: T; error?: Error; attempts: number }> {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return { result: await operation(), attempts: attempt }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      const status = error instanceof BitrixError ? error.status : undefined
      const isClientError = status !== undefined && status >= 400 && status < 500 && status !== 429
      if (isClientError || attempt === maxAttempts) {
        return { error: lastError, attempts: attempt }
      }

      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)))
    }
  }

  return { error: lastError, attempts: maxAttempts }
}

/** SHA-256 em hex — compara tokens sem nunca guardar o valor em claro. */
export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Comparação em tempo constante.
 * Um `===` em string vaza, pelo tempo de resposta, quantos caracteres iniciais
 * do token estavam corretos — o suficiente para descobri-lo byte a byte.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
