'use client'

import type { SupplierContract } from '@/lib/types'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { createSupplierContract, setSupplierContractActive, updateSupplierContract } from './actions'

function SupplierContractFields({
  supplierId,
  defaults,
}: {
  supplierId: string
  defaults?: SupplierContract
}) {
  const uid = defaults ? `sc-${defaults.id}` : `sc-new-${supplierId}`
  return (
    <>
      <input type="hidden" name="supplier_id" value={supplierId} />

      <Field label="Número do contrato" htmlFor={`${uid}-contract_number`}>
        <input
          id={`${uid}-contract_number`}
          name="contract_number"
          maxLength={60}
          defaultValue={defaults?.contract_number ?? ''}
          className={inputClass}
        />
      </Field>

      <Field label="Descrição" htmlFor={`${uid}-description`}>
        <textarea
          id={`${uid}-description`}
          name="description"
          rows={2}
          maxLength={500}
          defaultValue={defaults?.description ?? ''}
          className={inputClass}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Início da vigência" htmlFor={`${uid}-starts_on`}>
          <input
            id={`${uid}-starts_on`}
            name="starts_on"
            type="date"
            defaultValue={defaults?.starts_on ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Fim da vigência" htmlFor={`${uid}-ends_on`}>
          <input
            id={`${uid}-ends_on`}
            name="ends_on"
            type="date"
            defaultValue={defaults?.ends_on ?? ''}
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Custo mensal" htmlFor={`${uid}-monthly_cost`}>
        <input
          id={`${uid}-monthly_cost`}
          name="monthly_cost"
          type="number"
          step="0.01"
          min="0"
          defaultValue={defaults?.monthly_cost ?? ''}
          className={inputClass}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="SLA de resposta (min)"
          htmlFor={`${uid}-response_sla_minutes`}
          hint="Prazo que o fornecedor nos deve — diferente do SLA que oferecemos ao cliente."
        >
          <input
            id={`${uid}-response_sla_minutes`}
            name="response_sla_minutes"
            type="number"
            min="1"
            defaultValue={defaults?.response_sla_minutes ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="SLA de resolução (min)" htmlFor={`${uid}-resolution_sla_minutes`}>
          <input
            id={`${uid}-resolution_sla_minutes`}
            name="resolution_sla_minutes"
            type="number"
            min="1"
            defaultValue={defaults?.resolution_sla_minutes ?? ''}
            className={inputClass}
          />
        </Field>
      </div>
    </>
  )
}

export function NewSupplierContractForm({ supplierId }: { supplierId: string }) {
  return (
    <ActionForm action={createSupplierContract} className="flex flex-col gap-4">
      <SupplierContractFields supplierId={supplierId} />
      <SubmitButton pendingLabel="Cadastrando…">Cadastrar contrato</SubmitButton>
    </ActionForm>
  )
}

export function EditSupplierContractForm({ contract }: { contract: SupplierContract }) {
  return (
    <div className="flex flex-col gap-4">
      <ActionForm action={updateSupplierContract} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={contract.id} />
        <SupplierContractFields supplierId={contract.supplier_id} defaults={contract} />
        <SubmitButton>Salvar alterações</SubmitButton>
      </ActionForm>

      <ActionForm action={setSupplierContractActive} className="border-t border-[var(--color-border)] pt-4">
        <input type="hidden" name="id" value={contract.id} />
        <input type="hidden" name="is_active" value={contract.is_active ? 'false' : 'true'} />
        <SubmitButton variant={contract.is_active ? 'danger' : 'secondary'}>
          {contract.is_active ? 'Inativar contrato' : 'Reativar contrato'}
        </SubmitButton>
      </ActionForm>
    </div>
  )
}
