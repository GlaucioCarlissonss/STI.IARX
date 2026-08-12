'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession, canManageRecords } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'
import {
  buildGeocodeQuery,
  formatCoordinates,
  isValidCoordinates,
  mapGoogleLocationType,
  parseCoordinates,
  roundCoordinates,
} from '@/lib/maps'

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

interface GeocodeResponse {
  status: string
  error_message?: string
  results?: Array<{
    formatted_address?: string
    place_id?: string
    geometry?: { location?: { lat: number; lng: number }; location_type?: string }
  }>
}

/**
 * Geocodifica pelo endereço cadastrado, usando a Geocoding API.
 *
 * A chamada acontece **no servidor** com `GOOGLE_MAPS_SERVER_KEY` — chave
 * separada da do navegador, restrita por IP em vez de referrer. Chamar a
 * Geocoding API do cliente exporia uma chave irrestrita, que é o erro clássico
 * dessa integração.
 */
export async function geocodeBranch(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão para alterar a localização.' }

  const branchId = formData.get('branch_id')
  if (typeof branchId !== 'string') return { error: 'Filial inválida.' }

  const key = process.env.GOOGLE_MAPS_SERVER_KEY
  if (!key) {
    return {
      error:
        'GOOGLE_MAPS_SERVER_KEY não configurada. Sem ela, informe a localização ' +
        'colando a URL do Google Maps.',
    }
  }

  const supabase = await createClient()
  const { data: branch, error: readError } = await supabase
    .from('branches')
    .select('id, name, address_line, district, city, state, postal_code')
    .eq('id', branchId)
    .maybeSingle()

  if (readError) return { error: readError.message }
  if (!branch) return { error: 'Filial não encontrada.' }

  const query = buildGeocodeQuery({
    addressLine: branch.address_line,
    district: branch.district,
    city: branch.city,
    state: branch.state,
    postalCode: branch.postal_code,
  })

  // Só "Brasil" significa que a filial não tem endereço cadastrado — geocodificar
  // isso devolveria o centro do país e pareceria um acerto.
  if (query === 'Brasil') {
    return { error: 'Cadastre o endereço da filial antes de geocodificar.' }
  }

  let payload: GeocodeResponse
  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}` +
        `&region=br&language=pt-BR&key=${encodeURIComponent(key)}`,
      { cache: 'no-store' },
    )
    payload = (await res.json()) as GeocodeResponse
  } catch {
    return { error: 'Não foi possível falar com a Geocoding API do Google.' }
  }

  if (payload.status === 'ZERO_RESULTS') {
    return { error: `O Google não encontrou "${query}". Revise o endereço ou informe a coordenada.` }
  }
  if (payload.status !== 'OK' || !payload.results?.length) {
    return { error: `Geocodificação falhou (${payload.status}). ${payload.error_message ?? ''}`.trim() }
  }

  const best = payload.results[0]
  const loc = best.geometry?.location
  if (!loc || !isValidCoordinates(loc.lat, loc.lng)) {
    return { error: 'A resposta do Google não trouxe coordenada utilizável.' }
  }

  const { lat, lng } = roundCoordinates(loc)
  const precision = mapGoogleLocationType(best.geometry?.location_type)

  const { error } = await supabase
    .from('branches')
    .update({
      latitude: lat,
      longitude: lng,
      geocoded_at: new Date().toISOString(),
      geocode_source: 'google',
      geocode_precision: precision,
      geocoded_address: best.formatted_address ?? null,
      place_id: best.place_id ?? null,
    })
    .eq('id', branchId)

  if (error) return { error: error.message }

  revalidatePath('/clientes')
  revalidatePath('/mapas')

  // Avisamos quando o resultado é aproximado: o marcador vai cair no centro da
  // cidade, e é melhor a pessoa saber agora do que descobrir em campo.
  const warning =
    precision === 'approximate' || precision === 'geometric_center'
      ? ' Atenção: resultado aproximado — confira e, se preciso, cole a coordenada exata do Maps.'
      : ''

  return { success: `Localizado em ${formatCoordinates(lat, lng)}.${warning}` }
}
