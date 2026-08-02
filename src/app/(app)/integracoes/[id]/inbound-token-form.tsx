'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { setInboundToken } from '../actions'

export function InboundTokenForm({ integrationId }: { integrationId: string }) {
  return (
    <ActionForm action={setInboundToken} className="flex flex-col gap-3">
      <input type="hidden" name="integration_id" value={integrationId} />
      <Field label="application_token" htmlFor="token" required>
        <input
          id="token"
          name="token"
          type="password"
          required
          minLength={8}
          autoComplete="off"
          className={inputClass}
        />
      </Field>
      <SubmitButton pendingLabel="Salvando…">Registrar token</SubmitButton>
    </ActionForm>
  )
}
