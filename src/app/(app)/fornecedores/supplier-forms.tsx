'use client'

import type { Supplier } from '@/lib/types'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { createSupplier, setSupplierActive, updateSupplier } from './actions'

function SupplierFields({ defaults }: { defaults?: Supplier }) {
  const uid = defaults ? `f-${defaults.id}` : 'f-new'
  return (
    <>
      <Field label="Nome" htmlFor={`${uid}-name`} required>
        <input
          id={`${uid}-name`}
          name="name"
          required
          maxLength={200}
          defaultValue={defaults?.name ?? ''}
          className={inputClass}
          placeholder="NetLink Telecom"
        />
      </Field>

      <Field label="Razão social" htmlFor={`${uid}-legal_name`}>
        <input
          id={`${uid}-legal_name`}
          name="legal_name"
          maxLength={200}
          defaultValue={defaults?.legal_name ?? ''}
          className={inputClass}
        />
      </Field>

      <Field label="CNPJ" htmlFor={`${uid}-cnpj`}>
        <input
          id={`${uid}-cnpj`}
          name="cnpj"
          maxLength={20}
          defaultValue={defaults?.cnpj ?? ''}
          className={inputClass}
          placeholder="00.000.000/0001-00"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="E-mail" htmlFor={`${uid}-email`}>
          <input
            id={`${uid}-email`}
            name="email"
            type="email"
            maxLength={200}
            defaultValue={defaults?.email ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Telefone" htmlFor={`${uid}-phone`}>
          <input
            id={`${uid}-phone`}
            name="phone"
            maxLength={30}
            defaultValue={defaults?.phone ?? ''}
            className={inputClass}
          />
        </Field>
      </div>

      <Field
        label="Serviços prestados"
        htmlFor={`${uid}-services`}
        hint="Separe por vírgula: link dedicado, MPLS, telefonia"
      >
        <input
          id={`${uid}-services`}
          name="services"
          defaultValue={defaults?.services.join(', ') ?? ''}
          className={inputClass}
        />
      </Field>

      <Field label="Avaliação (0 a 5)" htmlFor={`${uid}-rating`}>
        <input
          id={`${uid}-rating`}
          name="rating"
          type="number"
          step="0.1"
          min="0"
          max="5"
          defaultValue={defaults?.rating ?? ''}
          className={inputClass}
        />
      </Field>
    </>
  )
}

export function NewSupplierForm() {
  return (
    <ActionForm action={createSupplier} className="flex flex-col gap-4">
      <SupplierFields />
      <SubmitButton pendingLabel="Cadastrando…">Cadastrar fornecedor</SubmitButton>
    </ActionForm>
  )
}

export function EditSupplierForm({ supplier }: { supplier: Supplier }) {
  return (
    <div className="flex flex-col gap-4">
      <ActionForm action={updateSupplier} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={supplier.id} />
        <SupplierFields defaults={supplier} />
        <SubmitButton>Salvar alterações</SubmitButton>
      </ActionForm>

      <ActionForm action={setSupplierActive} className="border-t border-[var(--color-border)] pt-4">
        <input type="hidden" name="id" value={supplier.id} />
        <input type="hidden" name="is_active" value={supplier.is_active ? 'false' : 'true'} />
        <p className="mb-2 text-xs text-[var(--color-ink-3)]">
          {supplier.is_active
            ? 'Inativar tira o fornecedor dos seletores; contratos e ativos já vinculados continuam como estão.'
            : 'Reativar devolve o fornecedor aos seletores de cadastro.'}
        </p>
        <SubmitButton variant={supplier.is_active ? 'danger' : 'secondary'}>
          {supplier.is_active ? 'Inativar fornecedor' : 'Reativar fornecedor'}
        </SubmitButton>
      </ActionForm>
    </div>
  )
}
