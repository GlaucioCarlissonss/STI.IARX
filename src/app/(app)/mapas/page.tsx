import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireSession } from '@/lib/session'
import { PRECISION_LABEL, googleMapsUrl, isPreciseEnough, type GeocodePrecision } from '@/lib/maps'
import { Badge, Card, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { type MapPoint } from '@/components/google-map'
import { BranchLocationForm } from './branch-location-form'
import { MapWorkspace } from './map-workspace'

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
  await requireSession()

  const domain = DOMAINS.find((d) => d.key === dominio) ?? DOMAINS[0]
  const supabase = await createClient()

  const [{ data: rows }, { data: areas }] = await Promise.all([
    supabase.from(domain.view).select('*').returns<MapRow[]>(),
    supabase
      .from('vw_map_area_breakdown')
      .select('branch_id, area_name, assets_total, lines_active, links_active')
      .returns<AreaRow[]>(),
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

  return (
    <>
      <PageHeader
        title="Mapa da operação"
        description="Google Maps com marcador dimensionado pela quantidade e colorido por criticidade. Busque pela filial, clique na lista para centralizar e no marcador para ver a quebra por área."
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

      {/* Filial sem coordenada não pode simplesmente desaparecer do mapa: quem
          olha acreditaria que a operação inteira está representada. */}
      {missing.length > 0 && (
        <section className="mt-6">
          <Card title={`${missing.length} filial(is) sem localização`}>
            <p className="mb-3 text-sm text-[var(--color-ink-2)]">
              Não aparecem no mapa. Informe a coordenada colando a URL do Google Maps, ou
              geocodifique pelo endereço cadastrado.
            </p>
            <div className="flex flex-col gap-3">
              {missing.map((r) => (
                <BranchLocationForm
                  key={r.branch_id}
                  branchId={r.branch_id}
                  branchName={r.branch_name}
                  city={r.city}
                  state={r.state}
                />
              ))}
            </div>
          </Card>
        </section>
      )}

      {imprecise.length > 0 && (
        <section className="mt-6">
          <Card title={`${imprecise.length} filial(is) com coordenada imprecisa`}>
            <p className="mb-3 text-sm text-[var(--color-ink-2)]">
              O Google devolveu um ponto aproximado — normalmente o centro da cidade. Serve para o
              painel, não para despachar técnico ao endereço.
            </p>
            <Table head={['Filial', 'Cidade', 'Precisão', 'Coordenada', '']}>
              {imprecise.map((r) => (
                <tr key={r.branch_id}>
                  <Td className="font-medium">{r.branch_name}</Td>
                  <Td className="text-[var(--color-ink-2)]">
                    {[r.city, r.state].filter(Boolean).join(' / ') || '—'}
                  </Td>
                  <Td>
                    <Badge tone="warn">
                      {r.geocode_precision ? PRECISION_LABEL[r.geocode_precision] : 'desconhecida'}
                    </Badge>
                  </Td>
                  <Td className="font-mono text-xs">
                    {Number(r.latitude).toFixed(6)}, {Number(r.longitude).toFixed(6)}
                  </Td>
                  <Td>
                    <a
                      href={googleMapsUrl(Number(r.latitude), Number(r.longitude), r.branch_name)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-semibold text-[var(--color-brand)] hover:underline"
                    >
                      Conferir no Maps
                    </a>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        </section>
      )}
    </>
  )
}
