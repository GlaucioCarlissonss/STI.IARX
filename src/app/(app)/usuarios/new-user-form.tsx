'use client'

import { useState } from 'react'
import type { Branch, UserRole } from '@/lib/types'
import { roleLabel } from '@/lib/i18n'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { createUserAccount } from './actions'
import { ASSIGNABLE, TENANT_WIDE } from './user-access-form'

export function NewUserForm({ branches }: { branches: Branch[] }) {
  const [role, setRole] = useState<UserRole>('atendente')
  const scopedByBranch = !TENANT_WIDE.includes(role)

  return (
    <ActionForm action={createUserAccount} className="flex flex-col gap-4">
      <Field label="Nome completo" htmlFor="full_name" required>
        <input id="full_name" name="full_name" required maxLength={150} className={inputClass} />
      </Field>

      <Field label="E-mail" htmlFor="new-user-email" required>
        <input
          id="new-user-email"
          name="email"
          type="email"
          required
          maxLength={200}
          className={inputClass}
        />
      </Field>

      <Field label="Telefone" htmlFor="new-user-phone">
        <input id="new-user-phone" name="phone" maxLength={30} className={inputClass} />
      </Field>

      <Field label="Papel" htmlFor="new-user-role" required>
        <select
          id="new-user-role"
          name="role"
          required
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
            A primeira marcada vira a filial principal.
          </p>
          <div className="max-h-36 overflow-y-auto rounded-lg border border-[var(--color-border)] p-2">
            {branches.map((b) => (
              <label
                key={b.id}
                className="flex items-center gap-2 py-0.5 text-sm text-[var(--color-ink-2)]"
              >
                <input type="checkbox" name="branch_ids" value={b.id} />
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

      <p className="text-xs text-[var(--color-ink-3)]">
        Uma senha temporária é gerada e mostrada uma única vez após o cadastro — repasse-a com
        segurança e peça para a pessoa trocá-la em &quot;Minha conta&quot; no primeiro acesso.
      </p>

      <SubmitButton pendingLabel="Criando…">Criar usuário</SubmitButton>
    </ActionForm>
  )
}
