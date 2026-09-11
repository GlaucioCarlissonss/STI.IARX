'use client'

import type { BranchArea } from '@/lib/types'
import { areaKindLabel } from '@/lib/i18n'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import {
  createBranchArea,
  seedBranchAreas,
  setBranchAreaActive,
  updateBranchArea,
} from './actions'

/**
 * Áreas da filial.
 *
 * Ficam num arquivo próprio, e não em `forms.tsx`, porque aquele já carrega
 * cliente e filial: um terceiro cadastro ali passaria de 400 linhas e a edição
 * de uma coisa começaria a esbarrar na outra.
 */
function AreaFields({ branchId, defaults }: { branchId: string; defaults?: BranchArea }) {
  const uid = defaults ? `ar-${defaults.id}` : `ar-new-${branchId}`
  return (
    <>
      <input type="hidden" name="branch_id" value={branchId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome" htmlFor={`${uid}-name`} required>
          <input
            id={`${uid}-name`}
            name="name"
            required
            maxLength={120}
            defaultValue={defaults?.name ?? ''}
            className={inputClass}
            placeholder="Enfermagem"
          />
        </Field>
        <Field
          label="Natureza"
          htmlFor={`${uid}-kind`}
          required
          hint="Parada na Enfermagem não pesa o mesmo que parada na Administração."
        >
          <select
            id={`${uid}-kind`}
            name="kind"
            required
            defaultValue={defaults?.kind ?? 'administrativa'}
            className={inputClass}
          >
            {Object.entries(areaKindLabel).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Código" htmlFor={`${uid}-code`}>
          <input
            id={`${uid}-code`}
            name="code"
            maxLength={30}
            defaultValue={defaults?.code ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Ordem" htmlFor={`${uid}-sort_order`} hint="Menor aparece antes.">
          <input
            id={`${uid}-sort_order`}
            name="sort_order"
            type="number"
            min={0}
            max={32767}
            defaultValue={defaults?.sort_order ?? 100}
            className={inputClass}
          />
        </Field>
      </div>
    </>
  )
}

export function NewAreaForm({ branchId }: { branchId: string }) {
  return (
    <ActionForm action={createBranchArea} className="flex flex-col gap-3">
      <AreaFields branchId={branchId} />
      <SubmitButton pendingLabel="Cadastrando…">Cadastrar área</SubmitButton>
    </ActionForm>
  )
}

export function EditAreaForm({ area, canDeactivate }: { area: BranchArea; canDeactivate: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <ActionForm action={updateBranchArea} className="flex flex-col gap-3">
        <input type="hidden" name="id" value={area.id} />
        <AreaFields branchId={area.branch_id} defaults={area} />
        <SubmitButton>Salvar alterações</SubmitButton>
      </ActionForm>

      {canDeactivate && (
        <ActionForm action={setBranchAreaActive} className="border-t border-[var(--color-border)] pt-3">
          <input type="hidden" name="id" value={area.id} />
          <input type="hidden" name="is_active" value={area.is_active ? 'false' : 'true'} />
          {/* Não há exclusão de propósito: ativo, linha e link apontam para a
              área, e apagar levaria o histórico junto. Inativar tira dos
              seletores e preserva o que já foi registrado. */}
          <p className="mb-2 text-xs text-[var(--color-ink-3)]">
            {area.is_active
              ? 'Inativar tira a área dos seletores de cadastro. Os ativos, linhas e links já vinculados continuam apontando para ela.'
              : 'Reativar devolve a área aos seletores.'}
          </p>
          <SubmitButton variant={area.is_active ? 'danger' : 'secondary'}>
            {area.is_active ? 'Inativar área' : 'Reativar área'}
          </SubmitButton>
        </ActionForm>
      )}
    </div>
  )
}

/**
 * Cria as oito áreas padrão de uma vez.
 *
 * Sem isto, cadastrar 40 filiais é digitar as mesmas oito áreas 40 vezes — e a
 * divergência de nome que a tabela existe para evitar ("Enfermagem",
 * "enfermagem", "Enferm.") volta pela porta da frente.
 */
export function SeedAreasForm({ branchId }: { branchId: string }) {
  return (
    <ActionForm action={seedBranchAreas}>
      <input type="hidden" name="branch_id" value={branchId} />
      <SubmitButton variant="secondary" pendingLabel="Criando…">
        Usar as áreas padrão
      </SubmitButton>
    </ActionForm>
  )
}
