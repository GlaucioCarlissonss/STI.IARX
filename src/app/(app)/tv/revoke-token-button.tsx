'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { revokeDashboardToken } from './actions'

export function RevokeTokenButton({ tokenId }: { tokenId: string }) {
  return (
    <ActionForm action={revokeDashboardToken}>
      <input type="hidden" name="token_id" value={tokenId} />
      <SubmitButton variant="danger" pendingLabel="Revogando…">
        Revogar
      </SubmitButton>
    </ActionForm>
  )
}
