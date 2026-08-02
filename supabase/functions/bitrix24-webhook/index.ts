/**
 * Receptor de outgoing webhooks do Bitrix24 (RF-INT-08).
 *
 * Endpoint: POST /functions/v1/bitrix24-webhook?integracao=<slug>
 * Eventos:  ONTASKADD, ONTASKUPDATE
 *
 * Fluxo (ADR-010):
 *   1. Parse do corpo (form-urlencoded com colchetes PHP, ou JSON)
 *   2. Verificação do application_token por comparação de HASH
 *   3. Gravação do evento — a UNIQUE constraint É a idempotência
 *   4. Busca da tarefa completa no Bitrix24 (o webhook só manda o ID)
 *   5. Detecção de eco (mudança que nós mesmos causamos)
 *   6. Mapeamento e upsert do ticket
 *   7. Log da requisição
 *
 * Responder rápido é requisito, não otimização: o Bitrix24 desiste de handlers
 * lentos e reenvia o evento, multiplicando o trabalho.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import {
  applyMapping,
  buildEventKey,
  normalizeBitrixTask,
  parseWebhookBody,
  type MappingRule,
} from '../../../src/lib/integrations/mapping.ts'
import {
  getBitrixTask,
  getBitrixUser,
  sha256Hex,
  timingSafeEqual,
  withRetry,
} from '../_shared/bitrix.ts'

const SUPPORTED_EVENTS = ['ONTASKADD', 'ONTASKUPDATE']

interface IntegrationRow {
  id: string
  tenant_id: string
  slug: string
  status: string
  secret_ref: string | null
  inbound_token_hash: string | null
  echo_window_seconds: number
  config: Record<string, unknown>
}

Deno.serve(async (req: Request) => {
  const startedAt = Date.now()

  if (req.method !== 'POST') {
    return json({ error: 'Método não suportado' }, 405)
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  const url = new URL(req.url)
  const slug = url.searchParams.get('integracao') ?? 'bitrix24-tarefas'

  const rawBody = await req.text()
  const payload = parseWebhookBody(rawBody, req.headers.get('content-type') ?? '')

  const event = String(payload.event ?? '').toUpperCase()
  const auth = (payload.auth ?? {}) as Record<string, unknown>
  const applicationToken = String(auth.application_token ?? '')

  const { data: integration } = await supabase
    .from('integrations')
    .select('id, tenant_id, slug, status, secret_ref, inbound_token_hash, echo_window_seconds, config')
    .eq('slug', slug)
    .eq('source_system', 'bitrix24')
    .maybeSingle<IntegrationRow>()

  if (!integration) {
    // 404 sem detalhar: a rota não deve servir para descobrir slugs válidos.
    return json({ error: 'Integração não encontrada' }, 404)
  }

  const log = (fields: Record<string, unknown>) =>
    supabase.from('integration_logs').insert({
      tenant_id: integration.tenant_id,
      integration_id: integration.id,
      direction: 'inbound',
      method: 'POST',
      endpoint: `bitrix24-webhook?integracao=${slug}`,
      request_payload: payload,
      duration_ms: Date.now() - startedAt,
      ...fields,
    })

  // --- 2. Autenticidade do remetente -------------------------------------
  if (integration.inbound_token_hash) {
    const receivedHash = applicationToken ? await sha256Hex(applicationToken) : ''
    if (!timingSafeEqual(receivedHash, integration.inbound_token_hash)) {
      await log({ response_status: 401, outcome: 'error', error_message: 'application_token inválido' })
      return json({ error: 'Não autorizado' }, 401)
    }
  }

  if (integration.status !== 'active') {
    await log({ response_status: 202, outcome: 'ok', error_message: 'Integração pausada' })
    return json({ status: 'paused' }, 202)
  }

  if (!SUPPORTED_EVENTS.includes(event)) {
    await log({ response_status: 202, outcome: 'ok', error_message: `Evento ignorado: ${event}` })
    return json({ status: 'ignored', event }, 202)
  }

  // O ID da tarefa aparece em FIELDS_AFTER (update) ou FIELDS_AFTER/FIELDS_BEFORE (add).
  const data = (payload.data ?? {}) as Record<string, unknown>
  const after = (data.FIELDS_AFTER ?? {}) as Record<string, unknown>
  const before = (data.FIELDS_BEFORE ?? {}) as Record<string, unknown>
  const externalId = String(after.ID ?? before.ID ?? '')

  if (!externalId) {
    await log({ response_status: 400, outcome: 'error', error_message: 'Payload sem ID de tarefa' })
    return json({ error: 'Payload sem ID de tarefa' }, 400)
  }

  // --- 3. Idempotência ----------------------------------------------------
  const eventKey = buildEventKey(event, externalId, String(payload.ts ?? ''))

  const { data: eventRow, error: eventError } = await supabase
    .from('integration_events')
    .insert({
      tenant_id: integration.tenant_id,
      integration_id: integration.id,
      event_key: eventKey,
      event_type: event,
      external_id: externalId,
      payload,
    })
    .select('id')
    .single()

  if (eventError) {
    // 23505 = evento já recebido. Responder 200 é deliberado: um erro faria o
    // Bitrix24 reenviar indefinidamente algo que já foi processado.
    if (eventError.code === '23505') {
      await log({ response_status: 200, outcome: 'duplicate' })
      return json({ status: 'duplicate', event_key: eventKey }, 200)
    }
    await log({ response_status: 500, outcome: 'error', error_message: eventError.message })
    return json({ error: 'Falha ao registrar evento' }, 500)
  }

  const eventId = eventRow.id

  const fail = async (message: string, status = 500) => {
    await supabase
      .from('integration_events')
      .update({ status: 'failed', last_error: message, attempts: 1, processed_at: new Date().toISOString() })
      .eq('id', eventId)
    await log({ event_id: eventId, response_status: status, outcome: 'error', error_message: message })
    return json({ error: message }, status)
  }

  // --- 4. Busca da tarefa completa ---------------------------------------
  const webhookUrl = integration.secret_ref ? Deno.env.get(integration.secret_ref) : undefined
  if (!webhookUrl) {
    return await fail(
      `Segredo "${integration.secret_ref}" não configurado no ambiente da Edge Function`,
      500,
    )
  }

  const fetched = await withRetry(() => getBitrixTask(webhookUrl, externalId))
  if (fetched.error || !fetched.result) {
    return await fail(
      `Não foi possível obter a tarefa ${externalId}: ${fetched.error?.message ?? 'resposta vazia'}`,
      502,
    )
  }

  const task = normalizeBitrixTask(fetched.result as Record<string, unknown>)

  // --- 5. Supressão de eco (ADR-008) --------------------------------------
  const inboundHash = await sha256Hex(JSON.stringify(task))
  const { data: syncState } = await supabase
    .from('integration_sync_state')
    .select('last_outbound_hash, last_outbound_at')
    .eq('integration_id', integration.id)
    .eq('external_id', externalId)
    .maybeSingle()

  if (syncState?.last_outbound_hash === inboundHash && syncState.last_outbound_at) {
    const ageSeconds = (Date.now() - new Date(syncState.last_outbound_at).getTime()) / 1000
    if (ageSeconds <= integration.echo_window_seconds) {
      await supabase
        .from('integration_events')
        .update({ status: 'skipped_echo', processed_at: new Date().toISOString() })
        .eq('id', eventId)
      await log({ event_id: eventId, response_status: 200, outcome: 'skipped_echo' })
      return json({ status: 'skipped_echo' }, 200)
    }
  }

  // --- 6. Mapeamento e upsert --------------------------------------------
  const { data: rules } = await supabase
    .from('integration_mappings')
    .select('source_path, target_field, transform, value_map, default_value, is_required')
    .eq('integration_id', integration.id)
    .returns<MappingRule[]>()

  const mapped = applyMapping(task, rules ?? [])

  try {
    const ticketFields = await resolveTicketFields(supabase, integration, mapped.fields, mapped.lookups)

    const { data: existing } = await supabase
      .from('tickets')
      .select('id')
      .eq('tenant_id', integration.tenant_id)
      .eq('source_system', 'bitrix24')
      .eq('external_id', externalId)
      .is('deleted_at', null)
      .maybeSingle()

    let ticketId: string

    if (existing) {
      // Atualização: não sobrescrevemos requester_id nem created_at, que só
      // fazem sentido na criação e mudariam o histórico do ticket.
      const { requester_id: _r, created_at: _c, ...updatable } = ticketFields
      const { error } = await supabase
        .from('tickets')
        .update({ ...updatable, change_source: 'integration' })
        .eq('id', existing.id)

      if (error) throw new Error(error.message)
      ticketId = existing.id
    } else {
      const { data: created, error } = await supabase
        .from('tickets')
        .insert({
          ...ticketFields,
          tenant_id: integration.tenant_id,
          source: 'integration',
          source_system: 'bitrix24',
          external_id: externalId,
          change_source: 'integration',
        })
        .select('id')
        .single()

      if (error) throw new Error(error.message)
      ticketId = created.id
    }

    await supabase.from('integration_sync_state').upsert(
      {
        integration_id: integration.id,
        ticket_id: ticketId,
        tenant_id: integration.tenant_id,
        external_id: externalId,
        last_inbound_hash: inboundHash,
        last_inbound_at: new Date().toISOString(),
      },
      { onConflict: 'integration_id,ticket_id' },
    )

    await supabase
      .from('integration_events')
      .update({
        status: 'processed',
        ticket_id: ticketId,
        processed_at: new Date().toISOString(),
        // Avisos de mapeamento não impedem o ticket, mas ficam visíveis na UI.
        last_error: mapped.errors.length > 0 ? mapped.errors.join('; ') : null,
      })
      .eq('id', eventId)

    await log({ event_id: eventId, response_status: 200, outcome: 'ok' })

    return json({ status: 'processed', ticket_id: ticketId, warnings: mapped.errors }, 200)
  } catch (error) {
    return await fail(error instanceof Error ? error.message : String(error), 500)
  }
})

/**
 * Resolve os campos que dependem do banco e aplica os defaults da integração.
 * É aqui que `priority_key` vira `priority_id` e `RESPONSIBLE_ID` do Bitrix24
 * vira o `profiles.id` correspondente.
 */
async function resolveTicketFields(
  supabase: SupabaseClient,
  integration: IntegrationRow,
  fields: Record<string, unknown>,
  lookups: Array<{ target_field: string; kind: string; value: string }>,
): Promise<Record<string, unknown>> {
  const config = integration.config ?? {}
  const result: Record<string, unknown> = { ...fields }

  // Prioridade: chave textual → id, com fallback configurado na integração.
  const priorityKey =
    (result.priority_key as string | undefined) ?? (config.default_priority_key as string) ?? 'medium'
  delete result.priority_key

  const { data: priority } = await supabase
    .from('ticket_priorities')
    .select('id')
    .eq('tenant_id', integration.tenant_id)
    .eq('key', priorityKey)
    .maybeSingle()

  if (priority) result.priority_id = priority.id

  // Fila padrão da integração; se não houver, a trigger do banco aplica a
  // fila padrão do sistema.
  if (!result.queue_id && config.default_queue_slug) {
    const { data: queue } = await supabase
      .from('queues')
      .select('id')
      .eq('tenant_id', integration.tenant_id)
      .eq('slug', config.default_queue_slug as string)
      .maybeSingle()
    if (queue) result.queue_id = queue.id
  }

  if (config.default_branch_code) {
    const { data: branch } = await supabase
      .from('branches')
      .select('id')
      .eq('tenant_id', integration.tenant_id)
      .eq('code', config.default_branch_code as string)
      .maybeSingle()
    if (branch) result.branch_id = branch.id
  }

  const webhookUrl = integration.secret_ref ? Deno.env.get(integration.secret_ref) : undefined

  for (const lookup of lookups) {
    if (lookup.kind === 'user_by_external_id' && webhookUrl) {
      // O Bitrix24 identifica pessoas por ID interno; o casamento com o nosso
      // usuário é feito por e-mail, o único identificador comum aos dois lados.
      const bitrixUser = await getBitrixUser(webhookUrl, lookup.value).catch(() => null)
      if (bitrixUser?.EMAIL) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('id')
          .eq('tenant_id', integration.tenant_id)
          .ilike('email', bitrixUser.EMAIL)
          .maybeSingle()
        if (profile) result[lookup.target_field] = profile.id
      }
      continue
    }

    if (lookup.kind === 'user_by_email') {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('tenant_id', integration.tenant_id)
        .ilike('email', lookup.value)
        .maybeSingle()
      if (profile) result[lookup.target_field] = profile.id
      continue
    }

    if (lookup.kind === 'queue_by_external_id') {
      // GROUP_ID do Bitrix24 → fila, via mapa em `integrations.config`.
      const groupMap = (config.group_to_queue_slug ?? {}) as Record<string, string>
      const queueSlug = groupMap[lookup.value]
      if (queueSlug) {
        const { data: queue } = await supabase
          .from('queues')
          .select('id')
          .eq('tenant_id', integration.tenant_id)
          .eq('slug', queueSlug)
          .maybeSingle()
        if (queue) result.queue_id = queue.id
      }
    }
  }

  // `deadline` não é coluna de tickets: o prazo real vem do SLA (ADR-004).
  // Guardamos como tag para não perder a informação vinda do Bitrix24.
  delete result.deadline

  return result
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
