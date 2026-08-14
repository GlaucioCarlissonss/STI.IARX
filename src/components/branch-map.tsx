'use client'

import { GoogleBranchMap } from './google-map'
import { LeafletBranchMap } from './leaflet-branch-map'
import type { MapPoint } from './map-marker'

export type { MapPoint }

interface BranchMapProps {
  points: MapPoint[]
  height?: number
  /** Filial a centralizar. `nonce` permite repetir o foco na mesma filial. */
  focus?: { branchId: string; nonce: number } | null
  focusZoom?: number
}

/**
 * Mapa das filiais — escolhe o motor sem exigir nada do operador.
 *
 * `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` presente → Google Maps (motor oficial,
 * exige conta e cobrança do Google Cloud, mas com melhor SLA e suporte).
 * Ausente (padrão) → OpenStreetMap + Esri, gratuitos e sem cadastro — o app
 * já sai do zero mostrando mapa real, satélite incluído, sem o operador
 * precisar configurar nada.
 *
 * Os dois motores têm a mesma assinatura de props porque compartilham o
 * marcador e o popup (`map-marker.tsx`) — trocar de motor não muda quem
 * consome este componente.
 */
export function BranchMap(props: BranchMapProps) {
  const hasGoogleKey = Boolean(process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY)
  return hasGoogleKey ? <GoogleBranchMap {...props} /> : <LeafletBranchMap {...props} />
}
