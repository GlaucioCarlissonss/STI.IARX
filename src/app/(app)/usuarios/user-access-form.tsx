'use client'

import { useState } from 'react'
import type { Branch, UserRole } from '@/lib/types'
import { roleLabel } from '@/lib/i18n'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { updateUserAccess } from './actions'

const ASSIGNABLE: UserRole[] = ['admin', 'gestor', 'atendente', 'solicitante', 'visualizador']

/** Papéis que já enxergam o tenant inteiro — para eles, marcar filial é inócuo. */
const TENANT_WIDE: UserRole[] = ['admin', 'gestor']

export function UserAccessForm({
  userId,
  currentRole,
  isActive,
  assignedBranchIds,
  branches,
}: {
  userId: string
  currentRole: UserRole
  isActive: boolean
  assignedBranchIds: string[]
  branches: Branch[]
}) {
  const [role, setRole] = useState<UserRole>(currentRole)
  const scopedByBranch = !TENANT_WIDE.includes(role)

  return (
    <ActionForm action={updateUserAccess} className="flex flex-col gap-3">
      <input type="hidden" name="user_id" value={userId} />

      <Field label="Papel" htmlFor={`role-${userId}`}>
        <select
          id={`role-${userId}`}
          name="role"
          value={role}
          onChange={(e) => setRole(e.target.value as UserRole)}
          className={inputClass}
        >
          {ASSIGNABLE.map((r) => (
            <option key={r} value={r}>
              {roleLabel[r]}
            </option>
          ))}
        </select>
      </Field>

      {scopedByBranch ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm font-medium text-[var(--color-ink)]">Filiais visíveis</legend>
          <p className="text-xs text-[var(--color-ink-3)]">
            A primeira marcada vira a filial principal, usada como padrão ao abrir tickets.
          </p>
          <div className="max-h-36 overflow-y-auto rounded-lg border border-[var(--color-border)] p-2">
            {branches.map((b) => (
              <label
                key={b.id}
                className="flex items-center gap-2 py-0.5 text-sm text-[var(--color-ink-2)]"
              >
                <input
                  type="checkbox"
                  name="branch_ids"
                  value={b.id}
                  defaultChecked={assignedBranchIds.includes(b.id)}
                />
                {b.name}
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <p className="text-xs text-[var(--color-ink-2)]">
          {roleLabel[role]} enxerga todas as filiais do tenant — não é preciso vincular.
        </p>
      )}

      <label className="flex items-center gap-2 text-sm text-[var(--color-ink-2)]">
        <input type="checkbox" name="is_active" defaultChecked={isActive} />
        Usuário ativo
      </label>

      <SubmitButton variant="secondary" pendingLabel="Salvando…">
        Salvar acesso
      </SubmitButton>
    </ActionForm>
  )
}
