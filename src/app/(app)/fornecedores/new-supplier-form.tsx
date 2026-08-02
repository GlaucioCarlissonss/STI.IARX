'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { createSupplier } from './actions'

export function NewSupplierForm() {
  return (
    <ActionForm action={createSupplier} className="flex flex-col gap-4">
      <Field label="Nome" htmlFor="name" required>
        <input id="name" name="name" required className={inputClass} placeholder="NetLink Telecom" />
      </Field>

      <Field label="Razão social" htmlFor="legal_name">
        <input id="legal_name" name="legal_name" className={inputClass} />
      </Field>

      <Field label="CNPJ" htmlFor="cnpj">
        <input id="cnpj" name="cnpj" className={inputClass} placeholder="00.000.000/0001-00" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="E-mail" htmlFor="email">
          <input id="email" name="email" type="email" className={inputClass} />
        </Field>
        <Field label="Telefone" htmlFor="phone">
          <input id="phone" name="phone" className={inputClass} />
        </Field>
      </div>

      <Field
        label="Serviços prestados"
        htmlFor="services"
        hint="Separe por vírgula: link dedicado, MPLS, telefonia"
      >
        <input id="services" name="services" className={inputClass} />
      </Field>

      <Field label="Avaliação (0 a 5)" htmlFor="rating">
        <input
          id="rating"
          name="rating"
          type="number"
          step="0.1"
          min="0"
          max="5"
          className={inputClass}
        />
      </Field>

      <SubmitButton pendingLabel="Cadastrando…">Cadastrar fornecedor</SubmitButton>
    </ActionForm>
  )
}
