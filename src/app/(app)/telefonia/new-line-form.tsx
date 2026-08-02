'use client'

import type { Branch, Profile } from '@/lib/types'
import { lineStatusLabel, lineTypeLabel } from '@/lib/i18n'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { createTelecomLine } from './actions'

export function NewLineForm({
  branches,
  agents,
  devices,
}: {
  branches: Branch[]
  agents: Profile[]
  devices: { id: string; asset_tag: string | null; brand: string | null; model: string | null }[]
}) {
  return (
    <ActionForm action={createTelecomLine} className="flex flex-col gap-4">
      <Field label="Número" htmlFor="phone_number" required>
        <input
          id="phone_number"
          name="phone_number"
          required
          className={inputClass}
          placeholder="+55 11 98800-1001"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Operadora" htmlFor="carrier" required>
          <input id="carrier" name="carrier" required className={inputClass} placeholder="Vivo" />
        </Field>
        <Field label="Plano" htmlFor="plan_name">
          <input id="plan_name" name="plan_name" className={inputClass} placeholder="Controle 20GB" />
        </Field>
        <Field label="Tipo" htmlFor="line_type" required>
          <select id="line_type" name="line_type" required defaultValue="postpaid" className={inputClass}>
            {Object.entries(lineTypeLabel).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status" htmlFor="status" required>
          <select id="status" name="status" required defaultValue="active" className={inputClass}>
            {Object.entries(lineStatusLabel).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Filial" htmlFor="branch_id">
        <select id="branch_id" name="branch_id" defaultValue="" className={inputClass}>
          <option value="">Não vinculada</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Responsável" htmlFor="assigned_user_id">
        <select id="assigned_user_id" name="assigned_user_id" defaultValue="" className={inputClass}>
          <option value="">Sem responsável</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.full_name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Aparelho vinculado" htmlFor="device_asset_id">
        <select id="device_asset_id" name="device_asset_id" defaultValue="" className={inputClass}>
          <option value="">Nenhum</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {[d.asset_tag, d.brand, d.model].filter(Boolean).join(' · ')}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Custo mensal" htmlFor="monthly_cost">
          <input
            id="monthly_cost"
            name="monthly_cost"
            type="number"
            step="0.01"
            min="0"
            className={inputClass}
            placeholder="79.90"
          />
        </Field>
        <Field label="Ativação" htmlFor="activated_on">
          <input id="activated_on" name="activated_on" type="date" className={inputClass} />
        </Field>
        <Field label="Fidelidade até" htmlFor="loyalty_until">
          <input id="loyalty_until" name="loyalty_until" type="date" className={inputClass} />
        </Field>
        <Field
          label="Cancelamento"
          htmlFor="cancelled_on"
          hint="Obrigatório se o status for cancelada."
        >
          <input id="cancelled_on" name="cancelled_on" type="date" className={inputClass} />
        </Field>
      </div>

      <SubmitButton pendingLabel="Cadastrando…">Cadastrar linha</SubmitButton>
    </ActionForm>
  )
}
