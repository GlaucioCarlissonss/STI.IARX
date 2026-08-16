'use client'

import type { Branch, Client, SlaContract } from '@/lib/types'
import type { BusinessHoursOption } from '@/lib/data/lookups'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { createSlaContract, setSlaContractActive, updateSlaContract } from './actions'

interface Lookups {
  clients: Client[]
  branches: Branch[]
  businessHours: BusinessHoursOption[]
}

function SlaContractFields({ clients, branches, businessHours, defaults }: Lookups & { defaults?: SlaContract }) {
  const uid = defaults ? `slac-${defaults.id}` : 'slac-new'
  return (
    <>
      <Field label="Cliente" htmlFor={`${uid}-client_id`} required>
        <select
          id={`${uid}-client_id`}
          name="client_id"
          required
          defaultValue={defaults?.client_id ?? ''}
          className={inputClass}
        >
          <option value="" disabled>
            Selecione…
          </option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.trade_name ?? c.legal_name}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Filial"
        htmlFor={`${uid}-branch_id`}
        hint="Deixe em branco para o contrato valer em todas as filiais do cliente."
      >
        <select
          id={`${uid}-branch_id`}
          name="branch_id"
          defaultValue={defaults?.branch_id ?? ''}
          className={inputClass}
        >
          <option value="">Todas as filiais</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Nome do contrato" htmlFor={`${uid}-name`} required>
        <input
          id={`${uid}-name`}
          name="name"
          required
          maxLength={150}
          defaultValue={defaults?.name ?? ''}
          className={inputClass}
          placeholder="Contrato padrão 2026"
        />
      </Field>

      <Field label="Calendário de atendimento" htmlFor={`${uid}-business_hours_id`}>
        <select
          id={`${uid}-business_hours_id`}
          name="business_hours_id"
          defaultValue={defaults?.business_hours_id ?? ''}
          className={inputClass}
        >
          <option value="">Padrão do tenant</option>
          {businessHours.map((bh) => (
            <option key={bh.id} value={bh.id}>
              {bh.name}
              {bh.is_24x7 ? ' (24x7)' : ''}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Vigência início" htmlFor={`${uid}-valid_from`}>
          <input
            id={`${uid}-valid_from`}
            name="valid_from"
            type="date"
            defaultValue={defaults?.valid_from ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Vigência fim" htmlFor={`${uid}-valid_to`}>
          <input
            id={`${uid}-valid_to`}
            name="valid_to"
            type="date"
            defaultValue={defaults?.valid_to ?? ''}
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Observações" htmlFor={`${uid}-notes`}>
        <textarea
          id={`${uid}-notes`}
          name="notes"
          rows={2}
          maxLength={1000}
          defaultValue={defaults?.notes ?? ''}
          className={inputClass}
        />
      </Field>
    </>
  )
}

export function NewSlaContractForm(lookups: Lookups) {
  return (
    <ActionForm action={createSlaContract} className="flex flex-col gap-4">
      <SlaContractFields {...lookups} />
      <SubmitButton pendingLabel="Cadastrando…">Cadastrar contrato de SLA</SubmitButton>
    </ActionForm>
  )
}

export function EditSlaContractForm({ contract, ...lookups }: Lookups & { contract: SlaContract }) {
  return (
    <div className="flex flex-col gap-4">
      <ActionForm action={updateSlaContract} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={contract.id} />
        <SlaContractFields {...lookups} defaults={contract} />
        <SubmitButton>Salvar alterações</SubmitButton>
      </ActionForm>

      <ActionForm action={setSlaContractActive} className="border-t border-[var(--color-border)] pt-4">
        <input type="hidden" name="id" value={contract.id} />
        <input type="hidden" name="is_active" value={contract.is_active ? 'false' : 'true'} />
        <p className="mb-2 text-xs text-[var(--color-ink-3)]">
          {contract.is_active
            ? 'Inativar não apaga as definições de SLA já vinculadas a este contrato.'
            : 'Reativar devolve o contrato aos seletores de definição de SLA.'}
        </p>
        <SubmitButton variant={contract.is_active ? 'danger' : 'secondary'}>
          {contract.is_active ? 'Inativar contrato' : 'Reativar contrato'}
        </SubmitButton>
      </ActionForm>
    </div>
  )
}
