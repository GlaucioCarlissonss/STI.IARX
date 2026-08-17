'use client'

import type { Branch, CostCenter } from '@/lib/types'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { createCostCenter, setCostCenterActive, updateCostCenter } from '../actions'

function CostCenterFields({
  centers,
  branches,
  defaults,
}: {
  /** Só quem pode ser pai: centros de nível 1 ou 2, já filtrados pela página. */
  centers: CostCenter[]
  branches: Branch[]
  defaults?: CostCenter
}) {
  const uid = defaults ? `cc-${defaults.id}` : 'cc-new'
  const paiPossivel = centers.filter((c) => c.id !== defaults?.id)
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Código" htmlFor={`${uid}-code`} required>
          <input
            id={`${uid}-code`}
            name="code"
            required
            maxLength={30}
            defaultValue={defaults?.code ?? ''}
            className={inputClass}
            placeholder="CC-100"
          />
        </Field>
        <Field label="Nome" htmlFor={`${uid}-name`} required>
          <input
            id={`${uid}-name`}
            name="name"
            required
            maxLength={120}
            defaultValue={defaults?.name ?? ''}
            className={inputClass}
            placeholder="Operação"
          />
        </Field>
      </div>

      <Field
        label="Centro de custo pai"
        htmlFor={`${uid}-parent_id`}
        hint="Deixe em branco para um centro de topo. A hierarquia aceita 3 níveis."
      >
        <select
          id={`${uid}-parent_id`}
          name="parent_id"
          defaultValue={defaults?.parent_id ?? ''}
          className={inputClass}
        >
          <option value="">Nenhum (centro de topo)</option>
          {paiPossivel.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} — {c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Filial"
        htmlFor={`${uid}-branch_id`}
        hint="Em branco = centro global do tenant, aplicável a qualquer filial."
      >
        <select
          id={`${uid}-branch_id`}
          name="branch_id"
          defaultValue={defaults?.branch_id ?? ''}
          className={inputClass}
        >
          <option value="">Global (todas as filiais)</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Descrição" htmlFor={`${uid}-description`}>
        <input
          id={`${uid}-description`}
          name="description"
          maxLength={300}
          defaultValue={defaults?.description ?? ''}
          className={inputClass}
        />
      </Field>
    </>
  )
}

export function NewCostCenterForm(props: { centers: CostCenter[]; branches: Branch[] }) {
  return (
    <ActionForm action={createCostCenter} className="flex flex-col gap-4">
      <CostCenterFields {...props} />
      <SubmitButton pendingLabel="Cadastrando…">Cadastrar centro de custo</SubmitButton>
    </ActionForm>
  )
}

export function EditCostCenterForm({
  center,
  ...props
}: {
  center: CostCenter
  centers: CostCenter[]
  branches: Branch[]
}) {
  return (
    <div className="flex flex-col gap-4">
      <ActionForm action={updateCostCenter} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={center.id} />
        <CostCenterFields {...props} defaults={center} />
        <SubmitButton>Salvar alterações</SubmitButton>
      </ActionForm>

      <ActionForm action={setCostCenterActive} className="border-t border-[var(--color-border)] pt-4">
        <input type="hidden" name="id" value={center.id} />
        <input type="hidden" name="is_active" value={center.is_active ? 'false' : 'true'} />
        <p className="mb-2 text-xs text-[var(--color-ink-3)]">
          {center.is_active
            ? 'Inativar tira o centro dos seletores de lançamento; o que já foi rateado nele continua no histórico.'
            : 'Reativar devolve o centro aos seletores de lançamento.'}
        </p>
        <SubmitButton variant={center.is_active ? 'danger' : 'secondary'}>
          {center.is_active ? 'Inativar centro' : 'Reativar centro'}
        </SubmitButton>
      </ActionForm>
    </div>
  )
}
