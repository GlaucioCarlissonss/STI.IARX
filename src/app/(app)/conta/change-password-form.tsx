'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { changePassword } from './actions'

export function ChangePasswordForm() {
  return (
    <ActionForm action={changePassword} className="flex flex-col gap-4">
      <Field label="Nova senha" htmlFor="password" required hint="Pelo menos 8 caracteres.">
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className={inputClass}
        />
      </Field>
      <Field label="Confirme a nova senha" htmlFor="confirm" required>
        <input
          id="confirm"
          name="confirm"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className={inputClass}
        />
      </Field>
      <SubmitButton pendingLabel="Salvando…">Trocar senha</SubmitButton>
    </ActionForm>
  )
}
