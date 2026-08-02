'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { setIntegrationStatus, setReverseSync } from './actions'

export function IntegrationControls({
  integrationId,
  status,
  reverseSyncEnabled,
}: {
  integrationId: string
  status: 'active' | 'paused' | 'error'
  reverseSyncEnabled: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ActionForm action={setIntegrationStatus}>
        <input type="hidden" name="integration_id" value={integrationId} />
        <input type="hidden" name="status" value={status === 'active' ? 'paused' : 'active'} />
        <SubmitButton variant={status === 'active' ? 'secondary' : 'primary'} pendingLabel="…">
          {status === 'active' ? 'Pausar' : 'Ativar'}
        </SubmitButton>
      </ActionForm>

      <ActionForm action={setReverseSync}>
        <input type="hidden" name="integration_id" value={integrationId} />
        <input type="hidden" name="enabled" value={reverseSyncEnabled ? 'false' : 'true'} />
        <SubmitButton variant="secondary" pendingLabel="…">
          {reverseSyncEnabled ? 'Desligar sync reversa' : 'Ligar sync reversa'}
        </SubmitButton>
      </ActionForm>
    </div>
  )
}
