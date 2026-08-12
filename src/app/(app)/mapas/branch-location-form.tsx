'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { inputClass } from '@/components/ui'
import { geocodeBranch, setBranchCoordinates } from '@/app/(app)/clientes/geo-actions'

/**
 * Define a localização de uma filial por dois caminhos.
 *
 * Colar a URL do Google Maps vem primeiro porque é o mais exato: quem cola está
 * olhando o prédio. A geocodificação por endereço é o atalho, e pode devolver o
 * centro da cidade — por isso o aviso.
 */
export function BranchLocationForm({
  branchId,
  branchName,
  city,
  state,
}: {
  branchId: string
  branchName: string
  city: string | null
  state: string | null
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3.5">
      <div className="mb-2">
        <p className="text-sm font-semibold text-[var(--color-ink)]">{branchName}</p>
        <p className="text-xs text-[var(--color-ink-3)]">
          {[city, state].filter(Boolean).join(' / ') || 'sem cidade cadastrada'}
        </p>
      </div>

      <ActionForm action={setBranchCoordinates} className="flex flex-col gap-2">
        <input type="hidden" name="branch_id" value={branchId} />
        <label htmlFor={`loc-${branchId}`} className="text-xs font-medium text-[var(--color-ink-2)]">
          Cole a URL do Google Maps ou o par de coordenadas
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id={`loc-${branchId}`}
            name="input"
            required
            className={`${inputClass} min-w-56 flex-1`}
            placeholder="https://www.google.com/maps/@-23.550520,-46.633308,17z"
          />
          <SubmitButton pendingLabel="Salvando…">Definir</SubmitButton>
        </div>
        <p className="text-xs text-[var(--color-ink-3)]">
          No Google Maps: clique com o botão direito no local → a primeira linha do menu já traz as
          coordenadas; ou copie a URL da barra de endereço.
        </p>
      </ActionForm>

      <div className="mt-3 border-t border-[var(--color-border)] pt-3">
        <ActionForm action={geocodeBranch}>
          <input type="hidden" name="branch_id" value={branchId} />
          <SubmitButton variant="secondary" pendingLabel="Consultando o Google…">
            Geocodificar pelo endereço cadastrado
          </SubmitButton>
        </ActionForm>
      </div>
    </div>
  )
}
