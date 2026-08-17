'use client'

import { useActionState, useState } from 'react'
import {
  PRECISION_LABEL,
  formatCoordinates,
  isPreciseEnough,
  googleMapsUrl,
  type GeocodePrecision,
} from '@/lib/maps'
import { STATUS_TAG, type GeocodeStatus, normalizeCep } from '@/lib/address'
import { Badge, Button, Field, inputClass } from '@/components/ui'
import { BranchMap, type MapPoint } from '@/components/branch-map'
import {
  confirmGeocodeCandidate,
  geocodeBranch,
  saveBranchAddress,
  setBranchCoordinates,
} from '@/app/(app)/clientes/geo-actions'

export interface BranchAddress {
  branchId: string
  branchName: string
  clientName: string
  street: string | null
  streetNumber: string | null
  complement: string | null
  district: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  addressFormatted: string | null
  addressComplete: boolean
  lat: number | null
  lng: number | null
  precision: GeocodePrecision | null
  geocodedAddress: string | null
  status: GeocodeStatus | 'pending'
  stale: boolean
  verifiedAt: string | null
  provider: string | null
  lastMessage: string | null
  lastAttemptAt: string | null
  reportText: string | null
  candidates: {
    id: string
    ordinal: number
    lat: number
    lng: number
    formattedAddress: string
    precision: GeocodePrecision
  }[]
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'breach' | 'neutral'> = {
  ok: 'ok',
  low_precision: 'warn',
  pending: 'neutral',
  missing_fields: 'warn',
  inconsistent: 'breach',
  multiple: 'warn',
  not_found: 'breach',
  service_unavailable: 'breach',
}

const STATUS_LABEL: Record<string, string> = {
  ok: 'Localizado (exato)',
  low_precision: 'Localizado com baixa precisão',
  pending: 'Aguardando geolocalização',
  missing_fields: 'Endereço incompleto',
  inconsistent: 'Inconsistência de endereço',
  multiple: 'Múltiplas correspondências',
  not_found: 'Endereço não encontrado',
  service_unavailable: 'Serviço indisponível',
}

/** Campo de texto do formulário de endereço, sobre o `Field` compartilhado. */
function TextField({
  label,
  name,
  branchId,
  defaultValue,
  required,
  placeholder,
  maxLength,
}: {
  label: string
  name: string
  branchId: string
  defaultValue?: string
  required?: boolean
  placeholder?: string
  maxLength?: number
}) {
  const id = `${name}-${branchId}`
  return (
    <Field label={label} htmlFor={id} required={required}>
      <input
        id={id}
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        maxLength={maxLength}
        required={required}
        aria-required={required}
        className={inputClass}
      />
    </Field>
  )
}

/**
 * Endereço estruturado + geolocalização de uma filial.
 *
 * A ordem da tela é a ordem do fluxo: endereço primeiro, depois geocodificação,
 * depois mapa. Deixar o botão de geocodificar acima do endereço convidaria a
 * geolocalizar cadastro incompleto — que é exatamente o que o fluxo barra.
 */
/**
 * Painel de endereço e geolocalização de uma filial.
 *
 * As quatro permissões chegam por prop, decididas no servidor. Antes desta
 * revisão o painel não consultava papel nenhum e a página era só
 * `requireSession()`: os botões de gravar endereço e geocodificar apareciam para
 * solicitante e visualizador, e só falhavam depois do clique, no servidor.
 */
export function BranchGeoPanel({
  branch,
  podeEditarEndereco,
  podeGeocodificar,
}: {
  branch: BranchAddress
  podeEditarEndereco: boolean
  podeGeocodificar: boolean
}) {
  const [addressState, saveAddress, savingAddress] = useActionState(saveBranchAddress, {})
  const [geoState, runGeocode, geocoding] = useActionState(geocodeBranch, {})
  const [confirmState, confirm, confirming] = useActionState(confirmGeocodeCandidate, {})
  const [coordState, setCoords, settingCoords] = useActionState(setBranchCoordinates, {})
  const [showReport, setShowReport] = useState(false)

  const hasCoords = branch.lat !== null && branch.lng !== null
  const point: MapPoint | null = hasCoords
    ? {
        branchId: branch.branchId,
        name: branch.branchName,
        city: branch.city,
        state: branch.state,
        lat: branch.lat!,
        lng: branch.lng!,
        count: 1,
        state_color: isPreciseEnough(branch.precision) ? 'green' : 'amber',
        precision: branch.precision,
        address: branch.geocodedAddress ?? branch.addressFormatted,
        breakdown: [],
      }
    : null

  const messages = [addressState, geoState, confirmState, coordState]

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{branch.branchName}</h3>
          <p className="text-xs text-[var(--color-ink-3)]">{branch.clientName}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={STATUS_TONE[branch.status] ?? 'neutral'}>
            {STATUS_LABEL[branch.status] ?? branch.status}
          </Badge>
          {branch.stale && (
            <Badge tone="warn">Coordenada desatualizada — endereço mudou depois</Badge>
          )}
          {!branch.addressComplete && <Badge tone="warn">{STATUS_TAG.missing_fields}</Badge>}
        </div>
      </header>

      {messages.map((m, i) =>
        m.error ? (
          <p key={i} role="alert" className="mb-2 text-sm font-medium text-[var(--color-breach-ink)]">
            {m.error}
          </p>
        ) : m.success ? (
          // O botão de origem fica desabilitado durante o envio e o foco some
          // para o body — sem aria-live, "Endereço salvo" e "Localizado em…"
          // nunca eram anunciados para quem usa leitor de tela.
          <p key={i} role="status" aria-live="polite" className="mb-2 text-sm font-medium text-[var(--color-ok-ink)]">
            {m.success}
          </p>
        ) : null,
      )}

      {/* 1. Endereço estruturado. Os quatro obrigatórios estão marcados. */}
      {/* Campo editável sem botão de salvar convida a digitar e perder o que
          foi digitado. `fieldset disabled` desliga os campos de uma vez. */}
      <fieldset disabled={!podeEditarEndereco} style={{ border: 0, padding: 0, margin: 0 }}>
      <form action={saveAddress} className="grid gap-3 sm:grid-cols-6">
        <input type="hidden" name="branch_id" value={branch.branchId} />
        <div className="sm:col-span-3">
          <TextField
            branchId={branch.branchId}
            label="Logradouro" name="street" required maxLength={200} defaultValue={branch.street ?? ''} />
        </div>
        <div className="sm:col-span-1">
          <TextField
            branchId={branch.branchId}
            label="Número" name="street_number" required maxLength={30} defaultValue={branch.streetNumber ?? ''} />
        </div>
        <div className="sm:col-span-2">
          <TextField
            branchId={branch.branchId}
            label="Complemento" name="address_complement" maxLength={120} defaultValue={branch.complement ?? ''} />
        </div>
        <div className="sm:col-span-2">
          <TextField
            branchId={branch.branchId}
            label="Bairro" name="district" required maxLength={120} defaultValue={branch.district ?? ''} />
        </div>
        <div className="sm:col-span-2">
          <TextField
            branchId={branch.branchId}
            label="Cidade" name="city" maxLength={120} defaultValue={branch.city ?? ''} />
        </div>
        <div className="sm:col-span-1">
          <TextField
            branchId={branch.branchId}
            label="UF" name="state" defaultValue={branch.state ?? ''} maxLength={2} />
        </div>
        <div className="sm:col-span-1">
          <TextField
            branchId={branch.branchId}
            label="CEP"
            name="postal_code"
            required
            maxLength={10}
            defaultValue={branch.postalCode ?? ''}
            placeholder="99999-999"
          />
        </div>
        <div className="flex items-end gap-2 sm:col-span-6">
          {podeEditarEndereco ? (
            <>
              <Button type="submit" disabled={savingAddress}>
                {savingAddress ? 'Salvando…' : 'Salvar endereço'}
              </Button>
              <span className="text-xs text-[var(--color-ink-3)]">
                Logradouro, número, bairro e CEP são obrigatórios para geolocalizar.
              </span>
            </>
          ) : (
            <span className="text-xs text-[var(--color-ink-3)]">
              Você tem acesso de leitura ao endereço desta filial.
            </span>
          )}
        </div>
      </form>
      </fieldset>

      {/* 2. Geocodificação a partir do cadastro. */}
      {(podeGeocodificar || podeEditarEndereco) && (
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
        {podeGeocodificar && (
        <form action={runGeocode}>
          <input type="hidden" name="branch_id" value={branch.branchId} />
          <Button
            type="submit"
            variant="secondary"
            disabled={geocoding || !branch.addressComplete}
            aria-describedby={!branch.addressComplete ? `geocode-hint-${branch.branchId}` : undefined}
          >
            {geocoding ? 'Geolocalizando…' : 'Geolocalizar pelo endereço'}
          </Button>
        </form>
        )}

        {podeEditarEndereco && (
        <form action={setCoords} className="flex flex-1 flex-wrap items-center gap-2">
          <input type="hidden" name="branch_id" value={branch.branchId} />
          <input
            name="input"
            className={`${inputClass} max-w-xs flex-1`}
            placeholder="…ou cole a URL do Google Maps do ponto exato"
            aria-label="URL do Google Maps"
          />
          <Button type="submit" variant="secondary" disabled={settingCoords}>
            Definir manualmente
          </Button>
        </form>
        )}
      </div>
      )}

      {!branch.addressComplete && (
        <p id={`geocode-hint-${branch.branchId}`} className="mt-2 text-xs text-[var(--color-warn-ink)]">
          {STATUS_TAG.missing_fields} O botão de geolocalizar fica desabilitado até os quatro campos
          estarem preenchidos — geocodificar endereço parcial devolve um ponto convincente e errado.
        </p>
      )}

      {/* 3. [MÚLTIPLAS CORRESPONDÊNCIAS] — escolha do operador. */}
      {branch.candidates.length > 0 && (
        <section className="mt-4 rounded-lg border border-[var(--color-warn-ink)] bg-[var(--color-warn-soft)] p-3">
          <h4 className="text-sm font-semibold text-[var(--color-warn-ink)]">
            {STATUS_TAG.multiple} {branch.candidates.length} endereços para este CEP
          </h4>
          <p className="mb-2 text-xs text-[var(--color-warn-ink)]">
            Condomínio e galeria compartilham CEP. Confirme qual é a localização correta — o sistema
            não escolhe por você.
          </p>
          <ul className="flex flex-col gap-2">
            {branch.candidates.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{c.formattedAddress}</span>
                <span className="font-mono text-xs">{formatCoordinates(c.lat, c.lng)}</span>
                <Badge tone={isPreciseEnough(c.precision) ? 'ok' : 'warn'}>
                  {PRECISION_LABEL[c.precision]}
                </Badge>
                <a
                  href={googleMapsUrl(c.lat, c.lng, branch.branchName)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-semibold text-[var(--color-brand)] hover:underline"
                >
                  conferir
                </a>
                {podeGeocodificar && (
                  <form action={confirm} className="ml-auto">
                    <input type="hidden" name="branch_id" value={branch.branchId} />
                    <input type="hidden" name="candidate_id" value={c.id} />
                    <Button type="submit" disabled={confirming}>
                      Confirmar este
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 4. Renderização em satélite, com marcador no ponto geolocalizado. */}
      {point ? (
        <section className="mt-4">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
            <span className="font-mono">{formatCoordinates(point.lat, point.lng)}</span>
            <Badge tone={isPreciseEnough(branch.precision) ? 'ok' : 'warn'}>
              {branch.precision ? PRECISION_LABEL[branch.precision] : 'precisão desconhecida'}
            </Badge>
            {branch.geocodedAddress && (
              <span className="text-[var(--color-ink-3)]">{branch.geocodedAddress}</span>
            )}
            {branch.verifiedAt && (
              <span className="text-[var(--color-ink-3)]">
                verificado em {new Date(branch.verifiedAt).toLocaleString('pt-BR')}
              </span>
            )}
          </div>
          {/* Satélite com rótulos é o padrão: é o que permite ver se o pino caiu
              no imóvel. A alternância satélite/mapa fica no controle do próprio
              mapa (Google, ou o seletor de camadas do Leaflet quando não há
              chave configurada — ver `branch-map.tsx`). */}
          <BranchMap points={[point]} height={320} focusZoom={18} />
          {!isPreciseEnough(branch.precision) && (
            <p className="mt-2 text-xs text-[var(--color-warn-ink)]">
              {STATUS_TAG.low_precision} O ponto não é o imóvel — confira no satélite e, se preciso,
              cole a coordenada exata do Maps antes de despachar equipe.
            </p>
          )}
        </section>
      ) : (
        <p className="mt-4 rounded-lg border border-dashed border-[var(--color-border)] p-4 text-center text-sm text-[var(--color-ink-2)]">
          Sem coordenada — mapa não renderizado. Complete o endereço e geolocalize.
        </p>
      )}

      {/* 5. Bloco técnico do último fluxo, como ficou registrado no log. */}
      {branch.reportText && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowReport((v) => !v)}
            aria-expanded={showReport}
            className="text-xs font-semibold text-[var(--color-brand)] hover:underline"
          >
            {showReport ? 'Ocultar' : 'Ver'} saída técnica do último fluxo
            {branch.lastAttemptAt && ` (${new Date(branch.lastAttemptAt).toLocaleString('pt-BR')})`}
          </button>
          {showReport && (
            <pre className="mt-2 overflow-x-auto rounded-lg bg-[var(--color-surface-2)] p-3 text-[11px] leading-relaxed">
              {branch.reportText}
            </pre>
          )}
        </div>
      )}

      {branch.postalCode && !normalizeCep(branch.postalCode) && (
        <p className="mt-2 text-xs text-[var(--color-breach-ink)]">
          CEP fora do formato 99999-999.
        </p>
      )}
    </div>
  )
}
