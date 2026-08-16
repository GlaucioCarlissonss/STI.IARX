'use client'

import type { Priority } from '@/lib/types'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { createPriority, setPriorityActive, updatePriority } from './actions'

function PriorityFields({ defaults }: { defaults?: Priority }) {
  const uid = defaults ? `pri-${defaults.id}` : 'pri-new'
  return (
    <>
      <Field label="Nome" htmlFor={`${uid}-label`} required>
        <input
          id={`${uid}-label`}
          name="label"
          required
          maxLength={60}
          defaultValue={defaults?.label ?? ''}
          className={inputClass}
          placeholder="Crítica"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Peso"
          htmlFor={`${uid}-weight`}
          required
          hint="0 a 100 — quanto maior, mais no topo da fila."
        >
          <input
            id={`${uid}-weight`}
            name="weight"
            type="number"
            min={0}
            max={100}
            required
            defaultValue={defaults?.weight ?? 50}
            className={inputClass}
          />
        </Field>
        <Field label="Cor" htmlFor={`${uid}-color`} required>
          <input
            id={`${uid}-color`}
            name="color"
            type="color"
            required
            defaultValue={defaults?.color ?? '#64748b'}
            className={`${inputClass} h-10 p-1`}
          />
        </Field>
      </div>

      <Field label="Ordem de exibição" htmlFor={`${uid}-sort_order`} required>
        <input
          id={`${uid}-sort_order`}
          name="sort_order"
          type="number"
          min={0}
          max={999}
          required
          defaultValue={defaults?.sort_order ?? 0}
          className={inputClass}
        />
      </Field>
    </>
  )
}

export function NewPriorityForm() {
  return (
    <ActionForm action={createPriority} className="flex flex-col gap-4">
      <PriorityFields />
      <SubmitButton pendingLabel="Cadastrando…">Cadastrar prioridade</SubmitButton>
    </ActionForm>
  )
}

export function EditPriorityForm({ priority }: { priority: Priority }) {
  return (
    <div className="flex flex-col gap-4">
      <ActionForm action={updatePriority} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={priority.id} />
        <PriorityFields defaults={priority} />
        <SubmitButton>Salvar alterações</SubmitButton>
      </ActionForm>

      <ActionForm action={setPriorityActive} className="border-t border-[var(--color-border)] pt-4">
        <input type="hidden" name="id" value={priority.id} />
        <input type="hidden" name="is_active" value={priority.is_active ? 'false' : 'true'} />
        <p className="mb-2 text-xs text-[var(--color-ink-3)]">
          {priority.is_active
            ? 'Inativar tira a prioridade do formulário de abertura de ticket; tickets já abertos com ela não mudam.'
            : 'Reativar devolve a prioridade ao formulário de abertura de ticket.'}
        </p>
        <SubmitButton variant={priority.is_active ? 'danger' : 'secondary'}>
          {priority.is_active ? 'Inativar prioridade' : 'Reativar prioridade'}
        </SubmitButton>
      </ActionForm>
    </div>
  )
}
