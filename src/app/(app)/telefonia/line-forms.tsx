'use client'

import type { Branch, BranchArea, Profile, TelecomLine } from '@/lib/types'
import { lineStatusLabel, lineTypeLabel } from '@/lib/i18n'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { createTelecomLine, setTelecomLineStatus, updateTelecomLine } from './actions'

export interface DeviceOption {
  id: string
  asset_tag: string | null
  brand: string | null
  model: string | null
}

interface Lookups {
  branches: Branch[]
  areas: BranchArea[]
  agents: Profile[]
  devices: DeviceOption[]
}

function LineFields({ branches, areas, agents, devices, defaults }: Lookups & { defaults?: TelecomLine }) {
  const uid = defaults ? `l-${defaults.id}` : 'l-new'
  return (
    <>
      <Field label="Número" htmlFor={`${uid}-phone_number`} required>
        <input
          id={`${uid}-phone_number`}
          name="phone_number"
          required
          maxLength={30}
          defaultValue={defaults?.phone_number ?? ''}
          className={inputClass}
          placeholder="+55 11 98800-1001"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Operadora" htmlFor={`${uid}-carrier`} required>
          <input
            id={`${uid}-carrier`}
            name="carrier"
            required
            maxLength={80}
            defaultValue={defaults?.carrier ?? ''}
            className={inputClass}
            placeholder="Vivo"
          />
        </Field>
        <Field label="Plano" htmlFor={`${uid}-plan_name`}>
          <input
            id={`${uid}-plan_name`}
            name="plan_name"
            maxLength={120}
            defaultValue={defaults?.plan_name ?? ''}
            className={inputClass}
            placeholder="Controle 20GB"
          />
        </Field>
        <Field label="Tipo" htmlFor={`${uid}-line_type`} required>
          <select
            id={`${uid}-line_type`}
            name="line_type"
            required
            defaultValue={defaults?.line_type ?? 'postpaid'}
            className={inputClass}
          >
            {Object.entries(lineTypeLabel).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status" htmlFor={`${uid}-status`} required>
          <select
            id={`${uid}-status`}
            name="status"
            required
            defaultValue={defaults?.status ?? 'active'}
            className={inputClass}
          >
            {Object.entries(lineStatusLabel).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {/* Select único com a filial no rótulo, e não dois encadeados: encadear
          exigiria JavaScript, e a trigger `trg_lines_area_branch` (0013) já
          recusa área de outra filial. A coluna existe desde aquela migração e o
          formulário nunca a ofereceu — a linha ficava sem lugar dentro da
          filial, enquanto ativo e link já tinham. */}
      <Field label="Área da empresa" htmlFor={`${uid}-company_area_id`}>
        <select
          id={`${uid}-company_area_id`}
          name="company_area_id"
          defaultValue={defaults?.company_area_id ?? ''}
          className={inputClass}
        >
          <option value="">Sem área</option>
          {areas.map((a) => (
            <option key={a.id} value={a.id}>
              {branches.find((b) => b.id === a.branch_id)?.name ?? '—'} · {a.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Filial" htmlFor={`${uid}-branch_id`}>
        <select
          id={`${uid}-branch_id`}
          name="branch_id"
          defaultValue={defaults?.branch_id ?? ''}
          className={inputClass}
        >
          <option value="">Não vinculada</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Responsável" htmlFor={`${uid}-assigned_user_id`}>
        <select
          id={`${uid}-assigned_user_id`}
          name="assigned_user_id"
          defaultValue={defaults?.assigned_user_id ?? ''}
          className={inputClass}
        >
          <option value="">Sem responsável</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.full_name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Aparelho vinculado" htmlFor={`${uid}-device_asset_id`}>
        <select
          id={`${uid}-device_asset_id`}
          name="device_asset_id"
          defaultValue={defaults?.device_asset_id ?? ''}
          className={inputClass}
        >
          <option value="">Nenhum</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {[d.asset_tag, d.brand, d.model].filter(Boolean).join(' · ')}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Custo mensal" htmlFor={`${uid}-monthly_cost`}>
          <input
            id={`${uid}-monthly_cost`}
            name="monthly_cost"
            type="number"
            step="0.01"
            min="0"
            defaultValue={defaults?.monthly_cost ?? ''}
            className={inputClass}
            placeholder="79.90"
          />
        </Field>
        <Field label="Ativação" htmlFor={`${uid}-activated_on`}>
          <input
            id={`${uid}-activated_on`}
            name="activated_on"
            type="date"
            defaultValue={defaults?.activated_on ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Fidelidade até" htmlFor={`${uid}-loyalty_until`}>
          <input
            id={`${uid}-loyalty_until`}
            name="loyalty_until"
            type="date"
            defaultValue={defaults?.loyalty_until ?? ''}
            className={inputClass}
          />
        </Field>
        <Field
          label="Cancelamento"
          htmlFor={`${uid}-cancelled_on`}
          hint="Obrigatório se o status for cancelada."
        >
          <input
            id={`${uid}-cancelled_on`}
            name="cancelled_on"
            type="date"
            defaultValue={defaults?.cancelled_on ?? ''}
            className={inputClass}
          />
        </Field>
      </div>
    </>
  )
}

export function NewLineForm(lookups: Lookups) {
  return (
    <ActionForm action={createTelecomLine} className="flex flex-col gap-4">
      <LineFields {...lookups} />
      <SubmitButton pendingLabel="Cadastrando…">Cadastrar linha</SubmitButton>
    </ActionForm>
  )
}

export function EditLineForm({ line, ...lookups }: Lookups & { line: TelecomLine }) {
  const suspendable = line.status !== 'cancelled'
  return (
    <div className="flex flex-col gap-4">
      <ActionForm action={updateTelecomLine} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={line.id} />
        <LineFields {...lookups} defaults={line} />
        <SubmitButton>Salvar alterações</SubmitButton>
      </ActionForm>

      {suspendable && (
        <ActionForm
          action={setTelecomLineStatus}
          className="border-t border-[var(--color-border)] pt-4"
        >
          <input type="hidden" name="id" value={line.id} />
          <input
            type="hidden"
            name="status"
            value={line.status === 'active' ? 'suspended' : 'active'}
          />
          <p className="mb-2 text-xs text-[var(--color-ink-3)]">
            Suspender interrompe a linha sem encerrar o contrato — o custo mensal deixa de
            entrar no total ativo. Cancelar exige a data e é feito no formulário acima.
          </p>
          <SubmitButton variant="secondary">
            {line.status === 'active' ? 'Suspender linha' : 'Reativar linha'}
          </SubmitButton>
        </ActionForm>
      )}
    </div>
  )
}
