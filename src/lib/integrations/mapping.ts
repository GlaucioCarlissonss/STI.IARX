/**
 * Motor de mapeamento do Integration Hub (RF-INT-01/02).
 *
 * Este módulo é PROPOSITALMENTE sem dependências — nem Node, nem Deno, nem
 * Supabase. Isso permite que a mesma implementação rode:
 *   · nas Edge Functions (Deno), que importam este arquivo por caminho relativo;
 *   · no app Next.js;
 *   · nos testes unitários (Vitest), sem mock nenhum.
 *
 * Duas implementações do mesmo mapeamento divergiriam em semanas, e a divergência
 * só apareceria como ticket criado com campo errado em produção.
 */

export type TransformKind =
  | 'direct'
  | 'value_map'
  | 'datetime'
  | 'user_by_email'
  | 'user_by_external_id'
  | 'queue_by_external_id'
  | 'constant'
  | 'html_to_text'

export interface MappingRule {
  source_path: string
  target_field: string
  transform: TransformKind
  value_map?: Record<string, string> | null
  default_value?: string | null
  is_required?: boolean
}

/** Campo que precisa de consulta ao banco para ser resolvido. */
export interface PendingLookup {
  target_field: string
  kind: 'user_by_email' | 'user_by_external_id' | 'queue_by_external_id'
  value: string
}

export interface MappingResult {
  fields: Record<string, unknown>
  lookups: PendingLookup[]
  errors: string[]
}

/* ------------------------------------------------------------------------ */
/* Acesso ao payload                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Lê um caminho em notação por ponto: `data.FIELDS_AFTER.TITLE`.
 * Suporta índice de array (`tags.0`) porque payloads reais trazem listas.
 */
export function getByPath(source: unknown, path: string): unknown {
  if (!path) return undefined

  let current: unknown = source
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined

    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }

    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/* ------------------------------------------------------------------------ */
/* Transformações                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Converte HTML/BBCode em texto puro.
 * O Bitrix24 devolve descrições com BBCode (`[B]`, `[LIST]`) ou HTML conforme a
 * origem da tarefa; gravar isso cru faria a descrição do ticket exibir marcação.
 */
export function htmlToText(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\/?[A-Za-z][^\]]*\]/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Normaliza data para ISO 8601 em UTC.
 * O Bitrix24 envia `2026-08-05T14:30:00+03:00` (fuso do portal) e, em alguns
 * endpoints legados, `05.08.2026 14:30:00`. Aceitamos ambos e devolvemos UTC —
 * o banco guarda `timestamptz` e a conversão para o fuso da filial é feita na
 * apresentação.
 */
export function toIsoDate(input: string): string | null {
  const value = input.trim()
  if (!value) return null

  // dd.mm.yyyy hh:mm:ss — formato legado do Bitrix24
  const legacy = value.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/)
  if (legacy) {
    const [, d, m, y, hh = '00', mm = '00', ss = '00'] = legacy
    const parsed = new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function toStringValue(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return null
}

/* ------------------------------------------------------------------------ */
/* Aplicação do mapeamento                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Aplica as regras de mapeamento sobre o payload.
 *
 * Campos que dependem do banco (usuário por e-mail, fila por ID externo) não
 * são resolvidos aqui: saem em `lookups` para o chamador resolver. Assim o motor
 * continua puro e testável, e o acesso ao banco fica concentrado em um lugar só.
 */
export function applyMapping(payload: unknown, rules: MappingRule[]): MappingResult {
  const fields: Record<string, unknown> = {}
  const lookups: PendingLookup[] = []
  const errors: string[] = []

  for (const rule of rules) {
    if (rule.transform === 'constant') {
      if (rule.default_value !== null && rule.default_value !== undefined) {
        fields[rule.target_field] = rule.default_value
      }
      continue
    }

    const raw = getByPath(payload, rule.source_path)

    // Ausente: cai no default; se for obrigatório e não houver default, é erro.
    if (raw === null || raw === undefined || raw === '') {
      if (rule.default_value !== null && rule.default_value !== undefined) {
        fields[rule.target_field] = rule.default_value
      } else if (rule.is_required) {
        errors.push(`Campo obrigatório ausente no payload: ${rule.source_path}`)
      }
      continue
    }

    switch (rule.transform) {
      case 'direct': {
        // Arrays passam intactos: `tags` do Bitrix24 vira text[] no ticket.
        fields[rule.target_field] = Array.isArray(raw) ? raw.map(String) : (toStringValue(raw) ?? raw)
        break
      }

      case 'html_to_text': {
        const text = toStringValue(raw)
        if (text !== null) fields[rule.target_field] = htmlToText(text)
        break
      }

      case 'datetime': {
        const text = toStringValue(raw)
        const iso = text === null ? null : toIsoDate(text)
        if (iso) {
          fields[rule.target_field] = iso
        } else {
          errors.push(`Data inválida em ${rule.source_path}: ${String(raw)}`)
        }
        break
      }

      case 'value_map': {
        const key = toStringValue(raw)
        const mapped = key !== null ? rule.value_map?.[key] : undefined
        if (mapped !== undefined) {
          fields[rule.target_field] = mapped
        } else if (rule.default_value !== null && rule.default_value !== undefined) {
          fields[rule.target_field] = rule.default_value
        } else {
          // Valor desconhecido não vira erro fatal: o sistema de origem pode
          // introduzir um status novo, e derrubar a integração inteira por
          // causa disso seria pior do que criar o ticket sem esse campo.
          errors.push(
            `Valor não mapeado para ${rule.target_field}: "${String(raw)}" (${rule.source_path})`,
          )
        }
        break
      }

      case 'user_by_email':
      case 'user_by_external_id':
      case 'queue_by_external_id': {
        const key = toStringValue(raw)
        if (key !== null) {
          lookups.push({ target_field: rule.target_field, kind: rule.transform, value: key })
        }
        break
      }
    }
  }

  return { fields, lookups, errors }
}

/* ------------------------------------------------------------------------ */
/* Bitrix24                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * O Bitrix24 é inconsistente entre camelCase e UPPER_SNAKE: `tasks.task.get`
 * devolve `{ title, responsibleId }`, enquanto webhooks e `tasks.task.add`
 * usam `{ TITLE, RESPONSIBLE_ID }`. Normalizamos tudo para UPPER_SNAKE, que é
 * a forma usada nos mapeamentos cadastrados.
 */
export function normalizeBitrixTask(task: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(task)) {
    out[camelToUpperSnake(key)] = value
  }
  return out
}

export function camelToUpperSnake(key: string): string {
  if (/^[A-Z0-9_]+$/.test(key)) return key // já está em UPPER_SNAKE
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
}

/**
 * Chave de deduplicação do evento (RF-INT-06, ADR-010).
 *
 * Inclui o timestamp do evento porque duas edições distintas da MESMA tarefa
 * são eventos diferentes e ambas precisam ser processadas — deduplicar só por
 * `evento + id` descartaria a segunda edição legítima.
 */
export function buildEventKey(event: string, externalId: string, timestamp?: string): string {
  return [event.toUpperCase(), externalId, timestamp ?? ''].filter(Boolean).join(':')
}

/**
 * Converte o corpo de um outgoing webhook do Bitrix24 em objeto.
 *
 * O Bitrix24 envia `application/x-www-form-urlencoded` com notação PHP de
 * colchetes (`data[FIELDS_AFTER][ID]=42`), e não JSON. Aceitamos também JSON
 * para que a mesma função sirva a integrações genéricas.
 */
export function parseWebhookBody(body: string, contentType: string): Record<string, unknown> {
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(body)
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  const result: Record<string, unknown> = {}
  for (const [rawKey, value] of new URLSearchParams(body).entries()) {
    const segments = parseBracketKey(rawKey)
    let cursor = result

    segments.forEach((segment, index) => {
      if (index === segments.length - 1) {
        cursor[segment] = value
        return
      }
      const existing = cursor[segment]
      if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
        cursor[segment] = {}
      }
      cursor = cursor[segment] as Record<string, unknown>
    })
  }
  return result
}

/** `data[FIELDS_AFTER][ID]` → `['data', 'FIELDS_AFTER', 'ID']` */
function parseBracketKey(key: string): string[] {
  const match = key.match(/^([^[\]]+)((\[[^[\]]*\])*)$/)
  if (!match) return [key]

  const [, head, rest] = match
  const segments = [head]
  if (rest) {
    for (const part of rest.matchAll(/\[([^[\]]*)\]/g)) {
      segments.push(part[1])
    }
  }
  return segments
}
