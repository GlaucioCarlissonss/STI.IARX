'use client'

import type { Category, Priority, SlaContract } from '@/lib/types'
import type { BusinessHoursOption } from '@/lib/data/lookups'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { createSlaDefinition, setSlaDefinitionActive, updateSlaDefinition } from './actions'

export interface SlaDefinitionDefaults {
  id: string
  contract_id: string | null
  category_id: string | null
  priority_id: string
  first_response_minutes: number
  resolution_minutes: number
  business_hours_id: string | null
  is_active: boolean
}

interface Lookups {
  contracts: SlaContract[]
  categories: Category[]
  priorities: Priority[]
  businessHours: BusinessHoursOption[]
}

function SlaDefinitionFields({
  contracts,
  categories,
  priorities,
  businessHours,
  defaults,
}: Lookups & { defaults?: SlaDefinitionDefaults }) {
  const uid = defaults ? `slad-${defaults.id}` : 'slad-new'
  return (
    <>
      <Field
        label="Contrato de SLA"
        htmlFor={`${uid}-contract_id`}
        hint="Deixe em branco para a definição padrão do tenant."
      >
        <select
          id={`${uid}-contract_id`}
          name="contract_id"
          defaultValue={defaults?.contract_id ?? ''}
          className={inputClass}
        >
          <option value="">Padrão do tenant</option>
          {contracts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.is_active ? '' : ' (inativo)'}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Categoria"
        htmlFor={`${uid}-category_id`}
        hint="Deixe em branco para valer para todas as categorias."
      >
        <select
          id={`${uid}-category_id`}
          name="category_id"
          defaultValue={defaults?.category_id ?? ''}
          className={inputClass}
        >
          <option value="">Todas as categorias</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Prioridade" htmlFor={`${uid}-priority_id`} required>
        <select
          id={`${uid}-priority_id`}
          name="priority_id"
          required
          defaultValue={defaults?.priority_id ?? ''}
          className={inputClass}
        >
          <option value="" disabled>
            Selecione…
          </option>
          {priorities.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Primeira resposta (min)" htmlFor={`${uid}-first_response_minutes`} required>
          <input
            id={`${uid}-first_response_minutes`}
            name="first_response_minutes"
            type="number"
            min={1}
            required
            defaultValue={defaults?.first_response_minutes ?? 60}
            className={inputClass}
          />
        </Field>
        <Field label="Resolução (min)" htmlFor={`${uid}-resolution_minutes`} required>
          <input
            id={`${uid}-resolution_minutes`}
            name="resolution_minutes"
            type="number"
            min={1}
            required
            defaultValue={defaults?.resolution_minutes ?? 480}
            className={inputClass}
          />
        </Field>
      </div>

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
    </>
  )
}

export function NewSlaDefinitionForm(lookups: Lookups) {
  return (
    <ActionForm action={createSlaDefinition} className="flex flex-col gap-4">
      <SlaDefinitionFields {...lookups} />
      <SubmitButton pendingLabel="Cadastrando…">Cadastrar definição</SubmitButton>
    </ActionForm>
  )
}

export function EditSlaDefinitionForm({
  definition,
  ...lookups
}: Lookups & { definition: SlaDefinitionDefaults }) {
  return (
    <div className="flex flex-col gap-4">
      <ActionForm action={updateSlaDefinition} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={definition.id} />
        <SlaDefinitionFields {...lookups} defaults={definition} />
        <SubmitButton>Salvar alterações</SubmitButton>
      </ActionForm>

      <ActionForm action={setSlaDefinitionActive} className="border-t border-[var(--color-border)] pt-4">
        <input type="hidden" name="id" value={definition.id} />
        <input type="hidden" name="is_active" value={definition.is_active ? 'false' : 'true'} />
        <SubmitButton variant={definition.is_active ? 'danger' : 'secondary'}>
          {definition.is_active ? 'Inativar definição' : 'Reativar definição'}
        </SubmitButton>
      </ActionForm>
    </div>
  )
}
