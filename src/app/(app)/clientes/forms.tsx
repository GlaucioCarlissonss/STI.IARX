'use client'

import type { Client } from '@/lib/types'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { createBranch, createClientRecord } from './actions'

/** Fusos brasileiros — cobrem as filiais reais sem exigir uma lista IANA inteira. */
const TIMEZONES = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Cuiaba',
  'America/Belem',
  'America/Fortaleza',
  'America/Recife',
  'America/Bahia',
  'America/Campo_Grande',
  'America/Porto_Velho',
  'America/Rio_Branco',
  'America/Boa_Vista',
  'America/Noronha',
]

export function NewClientForm() {
  return (
    <ActionForm action={createClientRecord} className="flex flex-col gap-4">
      <Field label="Razão social" htmlFor="legal_name" required>
        <input id="legal_name" name="legal_name" required className={inputClass} />
      </Field>
      <Field label="Nome fantasia" htmlFor="trade_name">
        <input id="trade_name" name="trade_name" className={inputClass} />
      </Field>
      <Field label="CNPJ" htmlFor="cnpj">
        <input id="cnpj" name="cnpj" className={inputClass} placeholder="00.000.000/0001-00" />
      </Field>
      <Field label="Referência de contrato" htmlFor="contract_ref">
        <input id="contract_ref" name="contract_ref" className={inputClass} />
      </Field>
      <SubmitButton pendingLabel="Cadastrando…">Cadastrar cliente</SubmitButton>
    </ActionForm>
  )
}

export function NewBranchForm({
  clients,
  businessHours,
}: {
  clients: Client[]
  businessHours: { id: string; name: string; is_24x7: boolean }[]
}) {
  return (
    <ActionForm action={createBranch} className="flex flex-col gap-4">
      <Field label="Cliente" htmlFor="client_id" required>
        <select id="client_id" name="client_id" required defaultValue="" className={inputClass}>
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

      <Field label="Nome da filial" htmlFor="name" required>
        <input id="name" name="name" required className={inputClass} placeholder="Matriz São Paulo" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Código" htmlFor="code">
          <input id="code" name="code" className={inputClass} placeholder="MER-SP" />
        </Field>
        <Field label="CNPJ" htmlFor="branch_cnpj">
          <input id="branch_cnpj" name="cnpj" className={inputClass} />
        </Field>
        <Field label="Cidade" htmlFor="city">
          <input id="city" name="city" className={inputClass} />
        </Field>
        <Field label="UF" htmlFor="state">
          <input id="state" name="state" maxLength={2} className={inputClass} placeholder="SP" />
        </Field>
      </div>

      <Field
        label="Fuso horário"
        htmlFor="timezone"
        required
        hint="Base do cálculo de horário útil de SLA."
      >
        <select id="timezone" name="timezone" required defaultValue="America/Sao_Paulo" className={inputClass}>
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Calendário de atendimento" htmlFor="business_hours_id">
        <select id="business_hours_id" name="business_hours_id" defaultValue="" className={inputClass}>
          <option value="">Padrão do tenant</option>
          {businessHours.map((bh) => (
            <option key={bh.id} value={bh.id}>
              {bh.name}
              {bh.is_24x7 ? ' (24x7)' : ''}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Contato principal" htmlFor="contact_name">
        <input id="contact_name" name="contact_name" className={inputClass} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="E-mail" htmlFor="contact_email">
          <input id="contact_email" name="contact_email" type="email" className={inputClass} />
        </Field>
        <Field label="Telefone" htmlFor="contact_phone">
          <input id="contact_phone" name="contact_phone" className={inputClass} />
        </Field>
      </div>

      <SubmitButton pendingLabel="Cadastrando…">Cadastrar filial</SubmitButton>
    </ActionForm>
  )
}
