'use client'

import type { Branch, Profile } from '@/lib/types'
import { assetStatusLabel, assetTypeLabel } from '@/lib/i18n'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { createAsset } from './actions'

export function NewAssetForm({
  branches,
  agents,
  suppliers,
}: {
  branches: Branch[]
  agents: Profile[]
  suppliers: { id: string; name: string }[]
}) {
  return (
    <ActionForm action={createAsset} className="flex flex-col gap-4">
      <Field label="Tipo" htmlFor="asset_type" required>
        <select id="asset_type" name="asset_type" required defaultValue="notebook" className={inputClass}>
          {Object.entries(assetTypeLabel).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Patrimônio" htmlFor="asset_tag">
          <input id="asset_tag" name="asset_tag" className={inputClass} placeholder="PAT-001042" />
        </Field>
        <Field label="Nº de série" htmlFor="serial_number">
          <input id="serial_number" name="serial_number" className={inputClass} />
        </Field>
        <Field label="Marca" htmlFor="brand">
          <input id="brand" name="brand" className={inputClass} placeholder="Dell" />
        </Field>
        <Field label="Modelo" htmlFor="model">
          <input id="model" name="model" className={inputClass} placeholder="Latitude 5450" />
        </Field>
      </div>

      <Field label="Status" htmlFor="status" required>
        <select id="status" name="status" required defaultValue="in_stock" className={inputClass}>
          {Object.entries(assetStatusLabel).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Filial" htmlFor="branch_id">
        <select id="branch_id" name="branch_id" defaultValue="" className={inputClass}>
          <option value="">Não vinculado</option>
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

      <Field label="Fornecedor" htmlFor="supplier_id">
        <select id="supplier_id" name="supplier_id" defaultValue="" className={inputClass}>
          <option value="">Não informado</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Aquisição" htmlFor="acquisition_date">
          <input id="acquisition_date" name="acquisition_date" type="date" className={inputClass} />
        </Field>
        <Field label="Garantia até" htmlFor="warranty_until">
          <input id="warranty_until" name="warranty_until" type="date" className={inputClass} />
        </Field>
      </div>

      <Field label="Valor de aquisição" htmlFor="acquisition_cost">
        <input
          id="acquisition_cost"
          name="acquisition_cost"
          type="number"
          step="0.01"
          min="0"
          className={inputClass}
          placeholder="6890.00"
        />
      </Field>

      <Field label="Observações" htmlFor="notes">
        <textarea id="notes" name="notes" rows={2} className={inputClass} />
      </Field>

      <SubmitButton pendingLabel="Cadastrando…">Cadastrar ativo</SubmitButton>
    </ActionForm>
  )
}
