'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession, canManageRecords } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'
import { PRECISION_LABEL, formatCoordinates, parseCoordinates, roundCoordinates } from '@/lib/maps'
import {
  STATUS_TAG,
  type StructuredAddress,
  buildReportText,
  missingRequiredFields,
  normalizeCep,
} from '@/lib/address'
import { runGeocodePipeline } from '@/lib/geocode.server'

/**
 * Localização das filiais.
 *
 * Dois caminhos, de propósito:
 *  · `setBranchCoordinates` — a pessoa cola a URL do Google Maps. É o mais
 *    exato, porque quem cola está olhando o telhado do prédio.
 *  · `geocodeBranch` — deriva do endereço cadastrado, e guarda o nível de
 *    precisão devolvido pelo Google para que ninguém confunda "centro da
 *    cidade" com "porta da filial".
 */

const coordsSchema = z.object({
  branch_id: z.string().uuid(),
  input: z.string().trim().min(1, 'Cole a URL do Google Maps ou o par de coordenadas.'),
})

export async function setBranchCoordinates(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão para alterar a localização.' }

  const parsed = coordsSchema.safeParse({
    branch_id: formData.get('branch_id'),
    input: formData.get('input'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const coords = parseCoordinates(parsed.data.input)
  if (!coords) {
    return {
      error:
        'Não reconheci coordenadas nesse texto. Cole a URL do Google Maps ' +
        '(ex.: .../@-23.550520,-46.633308,17z) ou o par "-23.550520, -46.633308".',
    }
  }

  const { lat, lng } = roundCoordinates(coords)
  const supabase = await createClient()
  const { error } = await supabase
    .from('branches')
    .update({
      latitude: lat,
      longitude: lng,
      geocoded_at: new Date().toISOString(),
      geocode_source: 'manual',
      // Coordenada colada do Maps é a mais confiável que temos: quem colou
      // estava olhando o lugar. Marcamos 'manual', não 'approximate'.
      geocode_precision: 'manual',
    })
    .eq('id', parsed.data.branch_id)

  if (error) return { error: error.message }

  revalidatePath('/clientes')
  revalidatePath('/mapas')
  return { success: `Localização definida em ${formatCoordinates(lat, lng)}.` }
}


/* ==========================================================================
   Endereço estruturado
   ========================================================================== */

/**
 * Salvar endereço é o gatilho do fluxo.
 *
 * O trigger `trg_branches_geocode_staleness` marca a coordenada como
 * desatualizada quando qualquer campo de endereço muda — então salvar aqui não
 * deixa um pino antigo passando por atual.
 */
const addressSchema = z.object({
  branch_id: z.string().uuid(),
  street: z.string().trim().max(200),
  street_number: z.string().trim().max(30),
  address_complement: z.string().trim().max(120),
  district: z.string().trim().max(120),
  city: z.string().trim().max(120),
  state: z.string().trim().max(2),
  postal_code: z.string().trim().max(10),
})

export async function saveBranchAddress(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão para alterar o cadastro.' }

  const parsed = addressSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  const d = parsed.data

  // CEP é normalizado antes de gravar: o CHECK do banco exige 99999-999, e
  // aceitar as duas formas espalharia normalização por todo lugar que compara.
  const cep = normalizeCep(d.postal_code)
  if (d.postal_code && !cep) return { error: 'CEP inválido — informe 8 dígitos (99999-999).' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('branches')
    .update({
      street: d.street || null,
      street_number: d.street_number || null,
      address_complement: d.address_complement || null,
      district: d.district || null,
      city: d.city || null,
      state: d.state ? d.state.toUpperCase() : null,
      postal_code: cep,
    })
    .eq('id', d.branch_id)

  if (error) return { error: error.message }

  revalidatePath('/clientes')
  revalidatePath('/mapas')

  const missing = missingRequiredFields({
    street: d.street || null,
    streetNumber: d.street_number || null,
    district: d.district || null,
    postalCode: cep,
  })
  return missing.length
    ? {
        success: `Endereço salvo. ${STATUS_TAG.missing_fields} faltam para geolocalizar: ${missing.join(', ')}.`,
      }
    : { success: 'Endereço salvo. Pronto para geolocalizar.' }
}

/* ==========================================================================
   Geocodificação a partir do cadastro
   ========================================================================== */

/** Colunas do cadastro que alimentam o fluxo. */
const ADDRESS_COLUMNS =
  'id, tenant_id, name, street, street_number, address_complement, district, city, state, postal_code'

interface BranchAddressRow {
  id: string
  tenant_id: string
  name: string
  street: string | null
  street_number: string | null
  address_complement: string | null
  district: string | null
  city: string | null
  state: string | null
  postal_code: string | null
}

/**
 * Geocodifica pelo endereço CADASTRADO e registra o resultado.
 *
 * O endereço é lido do banco, não do formulário: o mapa tem de refletir o
 * cadastro atual, e aceitar o endereço de um POST permitiria renderizar um ponto
 * que não corresponde ao que está gravado.
 *
 * A chamada acontece no servidor com `GOOGLE_MAPS_SERVER_KEY` — chave separada
 * da do navegador, restrita por IP em vez de referrer. Geocodificar do cliente
 * exporia uma chave irrestrita, que é o erro clássico dessa integração.
 */
export async function geocodeBranch(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão para alterar a localização.' }

  const branchId = formData.get('branch_id')
  if (typeof branchId !== 'string') return { error: 'Filial inválida.' }

  const supabase = await createClient()
  const { data: branch, error: readError } = await supabase
    .from('branches')
    .select(ADDRESS_COLUMNS)
    .eq('id', branchId)
    .maybeSingle<BranchAddressRow>()

  if (readError) return { error: readError.message }
  if (!branch) return { error: 'Filial não encontrada.' }

  const address: StructuredAddress = {
    street: branch.street,
    streetNumber: branch.street_number,
    district: branch.district,
    postalCode: branch.postal_code,
    city: branch.city,
    state: branch.state,
    complement: branch.address_complement,
  }

  const report = await runGeocodePipeline(address)

  // O log é gravado em TODO desfecho, inclusive nas falhas: é nele que se
  // descobre que a cota estourou ou que um CEP está errado há semanas.
  await supabase.from('geocode_logs').insert({
    tenant_id: branch.tenant_id,
    branch_id: branch.id,
    requested_by: profile.id,
    input_address: address as unknown as Record<string, unknown>,
    status: report.status,
    provider: report.provider,
    latitude: report.chosen?.lat ?? null,
    longitude: report.chosen?.lng ?? null,
    formatted_address: report.chosen?.formattedAddress ?? null,
    precision: report.chosen?.precision ?? null,
    candidates: report.candidates,
    message: report.message || null,
    report_text: buildReportText(report),
  })

  // Candidatos anteriores somem a cada nova tentativa: manter os velhos faria o
  // operador confirmar uma opção que o provedor já não devolve.
  await supabase.from('geocode_candidates').delete().eq('branch_id', branch.id)

  if (report.status === 'multiple') {
    await supabase.from('geocode_candidates').insert(
      report.candidates.map((c, i) => ({
        tenant_id: branch.tenant_id,
        branch_id: branch.id,
        ordinal: i + 1,
        latitude: c.lat,
        longitude: c.lng,
        formatted_address: c.formattedAddress,
        precision: c.precision,
        place_id: c.placeId,
      })),
    )
  }

  if (report.chosen) {
    const { error } = await supabase
      .from('branches')
      .update({
        latitude: report.chosen.lat,
        longitude: report.chosen.lng,
        geocoded_at: new Date().toISOString(),
        geocode_source: 'google',
        geocode_precision: report.chosen.precision,
        geocoded_address: report.chosen.formattedAddress || null,
        place_id: report.chosen.placeId,
        geocode_status: report.status,
        geocode_provider: report.provider,
      })
      .eq('id', branch.id)
    if (error) return { error: error.message }
  } else {
    // Falha NÃO apaga a coordenada anterior: perder o pino bom por causa de uma
    // cota estourada seria pior do que exibi-lo marcado como desatualizado.
    await supabase
      .from('branches')
      .update({ geocode_status: report.status, geocode_provider: report.provider })
      .eq('id', branch.id)
  }

  revalidatePath('/clientes')
  revalidatePath('/mapas')

  if (report.status === 'ok')
    return {
      success: `Localizado em ${formatCoordinates(report.chosen!.lat, report.chosen!.lng)} — ${PRECISION_LABEL[report.chosen!.precision]}.`,
    }
  if (report.status === 'low_precision')
    return { success: `${STATUS_TAG.low_precision} ${report.message}` }

  const requirements =
    report.status === 'service_unavailable' ? ` Requisitos: ${report.requirements.join(' · ')}` : ''
  return { error: `${STATUS_TAG[report.status]} ${report.message}${requirements}` }
}

/* ==========================================================================
   Confirmação de candidato — [MÚLTIPLAS CORRESPONDÊNCIAS]
   ========================================================================== */

const confirmSchema = z.object({
  branch_id: z.string().uuid(),
  candidate_id: z.string().uuid(),
})

/**
 * O operador escolhe entre os candidatos do mesmo CEP.
 *
 * A coordenada vem da linha gravada, não do formulário: aceitar lat/lng de um
 * POST deixaria qualquer pessoa com sessão mover a filial para onde quisesse.
 */
export async function confirmGeocodeCandidate(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão para alterar a localização.' }

  const parsed = confirmSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { error: 'Seleção inválida.' }

  const supabase = await createClient()
  const { data: candidate, error: readError } = await supabase
    .from('geocode_candidates')
    .select('id, branch_id, latitude, longitude, formatted_address, precision, place_id')
    .eq('id', parsed.data.candidate_id)
    .eq('branch_id', parsed.data.branch_id)
    .maybeSingle()

  if (readError) return { error: readError.message }
  if (!candidate) return { error: 'Candidato não encontrado — refaça a geocodificação.' }

  const { error } = await supabase
    .from('branches')
    .update({
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      geocoded_at: new Date().toISOString(),
      geocode_source: 'google',
      geocode_precision: candidate.precision,
      geocoded_address: candidate.formatted_address,
      place_id: candidate.place_id,
      geocode_status: candidate.precision === 'rooftop' ? 'ok' : 'low_precision',
      geocode_provider: 'google-geocoding',
    })
    .eq('id', parsed.data.branch_id)

  if (error) return { error: error.message }

  await supabase.from('geocode_candidates').delete().eq('branch_id', parsed.data.branch_id)

  revalidatePath('/clientes')
  revalidatePath('/mapas')
  return {
    success: `Localização confirmada em ${formatCoordinates(Number(candidate.latitude), Number(candidate.longitude))}.`,
  }
}
