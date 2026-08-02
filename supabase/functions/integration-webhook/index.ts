/**
 * Receptor genérico do Integration Hub (RF-INT-01/02/03).
 *
 * Endpoint: POST /functions/v1/integration-webhook?integracao=<slug>
 *
 * Aceita qualquer origem que consiga fazer um POST. Diferença em relação ao
 * handler do Bitrix24: aqui o payload já traz os dados (não é preciso chamar de
 * volta a origem), então o processamento é local e síncrono.
 *
 * Adicionar uma integração nova = cadastrar a linha em `integrations`, definir
 * os `integration_mappings` e apontar o webhook da origem para esta URL.
 * Nenhum código novo.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import {
  applyMapping,
  buildEventKey,
  getByPath,
  parseWebhookBody,
  type MappingRule,
} from '../../../src/lib/integrations/mapping.ts'
import { sha256Hex, timingSafeEqual } from '../_shared/bitrix.ts'

interface IntegrationRow {
  id: string
  tenant_id: string
  slug: string
  source_system: string
  status: string
  inbound_token_hash: string | null
  config: Record<string, unknown>
}

Deno.serve(async (req: Request) => {
  const startedAt = Date.now()

  if (req.method !== 'POST') return json({ error: 'Método não suportado' }, 405)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  const url = new URL(req.url)
  const slug = url.searchParams.get('integracao')
  if (!slug) return json({ error: 'Parâmetro "integracao" obrigatório' }, 400)

  const rawBody = await req.text()
  const payload = parseWebhookBody(rawBody, req.headers.get('content-type') ?? '')

  const { data: integration } = await supabase
    .from('integrations')
    .select('id, tenant_id, slug, source_system, status, inbound_token_hash, config')
    .eq('slug', slug)
    .maybeSingle<IntegrationRow>()

  if (!integration) return json({ error: 'Integração não encontrada' }, 404)

  const log = (fields: Record<string, unknown>) =>
    supabase.from('integration_logs').insert({
      tenant_id: integration.tenant_id,
      integration_id: integration.id,
      direction: 'inbound',
      method: 'POST',
      endpoint: `integration-webhook?integracao=${slug}`,
      request_payload: payload,
      duration_ms: Date.now() - startedAt,
      ...fields,
    })

  // Token aceito por header (padrão de mercado) ou no corpo, conforme o que a
  // origem conseguir enviar.
  if (integration.inbound_token_hash) {
    const provided =
      req.headers.get('x-webhook-token') ??
      req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
      String((payload as Record<string, unknown>).token ?? '')

    const providedHash = provided ? await sha256Hex(provided) : ''
    if (!timingSafeEqual(providedHash, integration.inbound_token_hash)) {
      await log({ response_status: 401, outcome: 'error', error_message: 'Token inválido' })
      return json({ error: 'Não autorizado' }, 401)
    }
  }

  if (integration.status !== 'active') {
    await log({ response_status: 202, outcome: 'ok', error_message: 'Integração pausada' })
    return json({ status: 'paused' }, 202)
  }

  const config = integration.config ?? {}

  // Onde encontrar o identificador externo e o tipo de evento é configurável,
  // porque cada origem nomeia esses campos de um jeito.
  const externalId = String(
    getByPath(payload, (config.external_id_path as string) ?? 'id') ?? '',
  )
  if (!externalId) {
    await log({ response_status: 400, outcome: 'error', error_message: 'Payload sem identificador externo' })
    return json({ error: 'Payload sem identificador externo' }, 400)
  }

  const eventType = String(getByPath(payload, (config.event_path as string) ?? 'event') ?? 'UPSERT')
  // Sem timestamp na origem, o hash do payload distingue conteúdos diferentes —
  // reentrega idêntica é duplicata, conteúdo novo é evento novo.
  const timestamp =
    String(getByPath(payload, (config.timestamp_path as string) ?? 'ts') ?? '') ||
    (await sha256Hex(rawBody)).slice(0, 16)

  const eventKey = buildEventKey(eventType, externalId, timestamp)

  const { data: eventRow, error: eventError } = await supabase
    .from('integration_events')
    .insert({
      tenant_id: integration.tenant_id,
      integration_id: integration.id,
      event_key: eventKey,
      event_type: eventType,
      external_id: externalId,
      payload,
    })
    .select('id')
    .single()

  if (eventError) {
    if (eventError.code === '23505') {
      await log({ response_status: 200, outcome: 'duplicate' })
      return json({ status: 'duplicate', event_key: eventKey }, 200)
    }
    await log({ response_status: 500, outcome: 'error', error_message: eventError.message })
    return json({ error: 'Falha ao registrar evento' }, 500)
  }

  const { data: rules } = await supabase
    .from('integration_mappings')
    .select('source_path, target_field, transform, value_map, default_value, is_required')
    .eq('integration_id', integration.id)
    .returns<MappingRule[]>()

  const mapped = applyMapping(payload, rules ?? [])

  if (mapped.errors.length > 0 && !mapped.fields.title) {
    const message = mapped.errors.join('; ')
    await supabase
      .from('integration_events')
      .update({ status: 'failed', last_error: message, processed_at: new Date().toISOString() })
      .eq('id', eventRow.id)
    await log({ event_id: eventRow.id, response_status: 422, outcome: 'error', error_message: message })
    return json({ error: 'Mapeamento incompleto', details: mapped.errors }, 422)
  }

  const fields: Record<string, unknown> = { ...mapped.fields }

  const priorityKey =
    (fields.priority_key as string | undefined) ?? (config.default_priority_key as string) ?? 'medium'
  delete fields.priority_key

  const { data: priority } = await supabase
    .from('ticket_priorities')
    .select('id')
    .eq('tenant_id', integration.tenant_id)
    .eq('key', priorityKey)
    .maybeSingle()
  if (priority) fields.priority_id = priority.id

  if (!fields.queue_id && config.default_queue_slug) {
    const { data: queue } = await supabase
      .from('queues')
      .select('id')
      .eq('tenant_id', integration.tenant_id)
      .eq('slug', config.default_queue_slug as string)
      .maybeSingle()
    if (queue) fields.queue_id = queue.id
  }

  for (const lookup of mapped.lookups) {
    if (lookup.kind === 'user_by_email') {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('tenant_id', integration.tenant_id)
        .ilike('email', lookup.value)
        .maybeSingle()
      if (profile) fields[lookup.target_field] = profile.id
    }
  }

  const { data: existing } = await supabase
    .from('tickets')
    .select('id')
    .eq('tenant_id', integration.tenant_id)
    .eq('source_system', integration.source_system)
    .eq('external_id', externalId)
    .is('deleted_at', null)
    .maybeSingle()

  let ticketId: string

  if (existing) {
    const { error } = await supabase
      .from('tickets')
      .update({ ...fields, change_source: 'integration' })
      .eq('id', existing.id)
    if (error) {
      await supabase
        .from('integration_events')
        .update({ status: 'failed', last_error: error.message, processed_at: new Date().toISOString() })
        .eq('id', eventRow.id)
      await log({ event_id: eventRow.id, response_status: 500, outcome: 'error', error_message: error.message })
      return json({ error: error.message }, 500)
    }
    ticketId = existing.id
  } else {
    const { data: created, error } = await supabase
      .from('tickets')
      .insert({
        ...fields,
        tenant_id: integration.tenant_id,
        source: 'integration',
        source_system: integration.source_system,
        external_id: externalId,
        change_source: 'integration',
      })
      .select('id')
      .single()

    if (error) {
      await supabase
        .from('integration_events')
        .update({ status: 'failed', last_error: error.message, processed_at: new Date().toISOString() })
        .eq('id', eventRow.id)
      await log({ event_id: eventRow.id, response_status: 500, outcome: 'error', error_message: error.message })
      return json({ error: error.message }, 500)
    }
    ticketId = created.id
  }

  await supabase
    .from('integration_events')
    .update({
      status: 'processed',
      ticket_id: ticketId,
      processed_at: new Date().toISOString(),
      last_error: mapped.errors.length > 0 ? mapped.errors.join('; ') : null,
    })
    .eq('id', eventRow.id)

  await log({ event_id: eventRow.id, response_status: 200, outcome: 'ok' })

  return json({ status: 'processed', ticket_id: ticketId, warnings: mapped.errors }, 200)
})

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
