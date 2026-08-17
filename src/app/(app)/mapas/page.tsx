import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { isPreciseEnough, type GeocodePrecision } from '@/lib/maps'
import { Badge, PageHeader, StatTile } from '@/components/ui'
import { type MapPoint } from '@/components/branch-map'
import { MapWorkspace } from './map-workspace'
import { BranchGeoPanel, type BranchAddress } from './branch-geo-panel'
import { RealtimeRefresh } from '@/components/realtime-refresh'

export const metadata: Metadata = { title: 'Mapas' }

type Domain = 'tickets' | 'assets' | 'telecom' | 'internet'

const DOMAINS: { key: Domain; label: string; view: string; countField: string; unit: string }[] = [
  { key: 'tickets', label: 'Tickets em aberto', view: 'vw_map_tickets', countField: 'open_total', unit: 'tickets abertos' },
  { key: 'assets', label: 'Ativos de TI', view: 'vw_map_assets', countField: 'assets_total', unit: 'ativos' },
  { key: 'telecom', label: 'Linhas ativas', view: 'vw_map_telecom', countField: 'lines_active', unit: 'linhas ativas' },
  { key: 'internet', label: 'Links ativos', view: 'vw_map_internet', countField: 'links_active', unit: 'links ativos' },
]

interface MapRow {
  branch_id: string
  branch_name: string
  city: string | null
  state: string | null
  latitude: number | null
  longitude: number | null
  geocode_precision: GeocodePrecision | null
  geocoded_address: string | null
  marker_state: 'green' | 'amber' | 'red'
  [key: string]: unknown
}

interface AddressViewRow {
  branch_id: string
  branch_name: string
  client_name: string | null
  street: string | null
  street_number: string | null
  address_complement: string | null
  district: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  address_formatted: string | null
  address_complete: boolean
  latitude: number | null
  longitude: number | null
  geocode_precision: GeocodePrecision | null
  geocoded_address: string | null
  geocode_status: string
  geocode_stale: boolean
  geocode_verified_at: string | null
  geocode_provider: string | null
  last_message: string | null
  last_attempt_at: string | null
}

interface CandidateRow {
  id: string
  branch_id: string
  ordinal: number
  latitude: number
  longitude: number
  formatted_address: string
  precision: GeocodePrecision
}

interface LogRow {
  branch_id: string
  report_text: string | null
}

interface AreaRow {
  branch_id: string
  area_name: string
  assets_total: number
  lines_active: number
  links_active: number
}

export default async function MapasPage({
  searchParams,
}: {
  searchParams: Promise<{ dominio?: string }>
}) {
  const { dominio } = await searchParams
  await requireScreen('mapas.geolocalizacao.ver')
  const [podeEditarEndereco, podeGeocodificar] = await Promise.all([
    allowed('mapas.geolocalizacao.editar_endereco'),
    allowed('mapas.geolocalizacao.geocodificar'),
  ])

  const domain = DOMAINS.find((d) => d.key === dominio) ?? DOMAINS[0]
  const supabase = await createClient()

  const [{ data: rows }, { data: areas }, { data: addresses }, { data: candidates }, { data: logs }] =
    await Promise.all([
      supabase.from(domain.view).select('*').returns<MapRow[]>(),
      supabase
        .from('vw_map_area_breakdown')
        .select('branch_id, area_name, assets_total, lines_active, links_active')
        .returns<AreaRow[]>(),
      supabase.from('vw_branch_addresses').select('*').order('branch_name').returns<AddressViewRow[]>(),
      supabase
        .from('geocode_candidates')
        .select('id, branch_id, ordinal, latitude, longitude, formatted_address, precision')
        .order('ordinal')
        .returns<CandidateRow[]>(),
      // Último bloco técnico por filial, um por vez via `distinct on` no banco
      // (vw_branch_last_geocode_log) — não "os N logs mais recentes do
      // tenant": com muitas filiais, o log de uma pouco geocodificada caía
      // fora de qualquer corte fixo e a tela dizia "nunca tentamos" com
      // histórico existente, só mais antigo. `report_text` é o texto que o
      // operador leu na hora — não é recalculado, para o registro não mudar
      // com o código.
      supabase
        .from('vw_branch_last_geocode_log')
        .select('branch_id, report_text')
        .returns<LogRow[]>(),
    ])

  const all = rows ?? []
  const areaByBranch = new Map<string, AreaRow[]>()
  for (const a of areas ?? []) {
    areaByBranch.set(a.branch_id, [...(areaByBranch.get(a.branch_id) ?? []), a])
  }

  /** A quebra por área muda conforme o domínio; tickets não têm área (LG-13). */
  const breakdownFor = (branchId: string) => {
    if (domain.key === 'tickets') return []
    const field =
      domain.key === 'assets' ? 'assets_total' : domain.key === 'telecom' ? 'lines_active' : 'links_active'
    return (areaByBranch.get(branchId) ?? [])
      .map((a) => ({ label: a.area_name, value: Number(a[field as keyof AreaRow] ?? 0) }))
      .filter((x) => x.value > 0)
  }

  const points: MapPoint[] = all
    .filter((r) => r.latitude !== null && r.longitude !== null)
    .map((r) => ({
      branchId: r.branch_id,
      name: r.branch_name,
      city: r.city,
      state: r.state,
      lat: Number(r.latitude),
      lng: Number(r.longitude),
      count: Number(r[domain.countField] ?? 0),
      state_color: r.marker_state,
      precision: r.geocode_precision,
      address: r.geocoded_address,
      breakdown: breakdownFor(r.branch_id),
    }))

  const missing = all.filter((r) => r.latitude === null || r.longitude === null)
  const imprecise = all.filter(
    (r) => r.latitude !== null && !isPreciseEnough(r.geocode_precision),
  )
  const total = points.reduce((s, p) => s + p.count, 0)
  const critical = points.filter((p) => p.state_color === 'red').length

  /* --- Endereço e estado da geolocalização, por filial --- */
  const candidatesByBranch = new Map<string, CandidateRow[]>()
  for (const c of candidates ?? [])
    candidatesByBranch.set(c.branch_id, [...(candidatesByBranch.get(c.branch_id) ?? []), c])

  // A view já devolve uma linha por filial (distinct on), sem precisar de
  // dedup em memória nem de um corte fixo de "N logs mais recentes".
  const lastReport = new Map<string, string | null>((logs ?? []).map((l) => [l.branch_id, l.report_text]))

  const addressRows: BranchAddress[] = (addresses ?? []).map((r) => ({
    branchId: r.branch_id,
    branchName: r.branch_name,
    clientName: r.client_name ?? '—',
    street: r.street,
    streetNumber: r.street_number,
    complement: r.address_complement,
    district: r.district,
    city: r.city,
    state: r.state,
    postalCode: r.postal_code,
    addressFormatted: r.address_formatted,
    addressComplete: r.address_complete,
    lat: r.latitude === null ? null : Number(r.latitude),
    lng: r.longitude === null ? null : Number(r.longitude),
    precision: r.geocode_precision,
    geocodedAddress: r.geocoded_address,
    status: r.geocode_status as BranchAddress['status'],
    stale: r.geocode_stale,
    verifiedAt: r.geocode_verified_at,
    provider: r.geocode_provider,
    lastMessage: r.last_message,
    lastAttemptAt: r.last_attempt_at,
    reportText: lastReport.get(r.branch_id) ?? null,
    candidates: (candidatesByBranch.get(r.branch_id) ?? []).map((c) => ({
      id: c.id,
      ordinal: c.ordinal,
      lat: Number(c.latitude),
      lng: Number(c.longitude),
      formattedAddress: c.formatted_address,
      precision: c.precision,
    })),
  }))

  const pendencias = {
    missing: addressRows.filter((b) => !b.addressComplete).length,
    stale: addressRows.filter((b) => b.stale).length,
    candidates: addressRows.filter((b) => b.candidates.length > 0).length,
  }

  return (
    <>
      {/* Regra de tempo real: alteração de endereço ou coordenada em qualquer
          sessão redesenha esta tela, sem recarregar na mão. */}
      <RealtimeRefresh table="branches" debounceMs={800} />

      <PageHeader
        title="Mapa da operação"
        description="Mapa com marcador dimensionado pela quantidade e colorido por criticidade. Busque pela filial, clique na lista para centralizar e no marcador para ver a quebra por área."
      />

      <nav aria-label="Domínio do mapa" className="mb-4 flex flex-wrap gap-1.5">
        {DOMAINS.map((d) => (
          <Link
            key={d.key}
            href={`/mapas?dominio=${d.key}` as Route}
            aria-current={d.key === domain.key ? 'page' : undefined}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${
              d.key === domain.key
                ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand-ink)]'
                : 'border border-[var(--color-border)] text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]'
            }`}
          >
            {d.label}
          </Link>
        ))}
      </nav>

      <div className="mb-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label={domain.label} value={total} hint={`em ${points.length} filial(is) no mapa`} />
        <StatTile
          label="Filiais críticas"
          value={critical}
          hint="vermelho no mapa"
          tone={critical ? 'breach' : 'ok'}
        />
        <StatTile
          label="Sem localização"
          value={missing.length}
          hint="não aparecem no mapa"
          tone={missing.length ? 'warn' : 'ok'}
        />
        <StatTile
          label="Coordenada aproximada"
          value={imprecise.length}
          hint="centro da cidade"
          tone={imprecise.length ? 'warn' : 'ok'}
        />
      </div>

      <MapWorkspace
        points={points}
        unitLabel={domain.unit}
        missing={missing.map((r) => ({
          branchId: r.branch_id,
          name: r.branch_name,
          city: r.city,
          state: r.state,
          precision: null,
          count: Number(r[domain.countField] ?? 0),
        }))}
      />

      <div className="mt-3 flex flex-wrap gap-3 text-xs text-[var(--color-ink-2)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full bg-[var(--color-ok-ink)]" /> normal
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full bg-[var(--color-warn-ink)]" /> atenção
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full bg-[var(--color-breach-ink)]" /> crítico
        </span>
        <span className="text-[var(--color-ink-3)]">
          tamanho do marcador proporcional à quantidade
        </span>
      </div>

      {/* Endereço é a origem de tudo: sem os quatro campos, não há geolocalização.
          A seção fica na mesma tela do mapa porque é aqui que o operador percebe
          o pino errado — mandá-lo para outro menu perderia a correção. */}
      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">Endereço e geolocalização das filiais</h2>
            <p className="text-sm text-[var(--color-ink-2)]">
              O fluxo roda sobre o endereço cadastrado: logradouro, número, bairro e CEP. Cada
              filial mostra o estado do último fluxo, o mapa em satélite e a saída técnica
              registrada em log.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {pendencias.missing > 0 && (
              <Badge tone="warn">{pendencias.missing} com endereço incompleto</Badge>
            )}
            {pendencias.stale > 0 && (
              <Badge tone="warn">{pendencias.stale} com coordenada desatualizada</Badge>
            )}
            {pendencias.candidates > 0 && (
              <Badge tone="warn">{pendencias.candidates} aguardando confirmação</Badge>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {addressRows.map((b) => (
            <BranchGeoPanel
              key={b.branchId}
              branch={b}
              podeEditarEndereco={podeEditarEndereco}
              podeGeocodificar={podeGeocodificar}
            />
          ))}
        </div>
      </section>

    </>
  )
}
