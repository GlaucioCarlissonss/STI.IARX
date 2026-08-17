'use client'

import type { AccessProfile } from '@/lib/types'
import { roleLabel } from '@/lib/i18n'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { setUserAccessProfile } from '@/app/(app)/perfis/actions'

/**
 * Atribuição de perfil de acesso, em formulário próprio.
 *
 * Separado do formulário de papel e filiais porque a trigger do banco recusa a
 * auto-atribuição: unir os dois faria uma tentativa inválida de trocar o próprio
 * perfil descartar também a mudança de filial que estava correta.
 */
export function AccessProfileForm({
  userId,
  currentProfileId,
  profiles,
}: {
  userId: string
  currentProfileId: string | null
  profiles: AccessProfile[]
}) {
  return (
    <ActionForm action={setUserAccessProfile} className="flex flex-col gap-3">
      <input type="hidden" name="user_id" value={userId} />
      <Field
        label="Perfil de acesso"
        htmlFor={`ap-${userId}`}
        hint="Define quais telas e botões a pessoa vê. Sem perfil, ela cai no papel puro — tudo que o papel alcança."
      >
        <select
          id={`ap-${userId}`}
          name="profile_id"
          defaultValue={currentProfileId ?? ''}
          className={inputClass}
        >
          <option value="">Nenhum (papel puro)</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — teto {roleLabel[p.base_role]}
            </option>
          ))}
        </select>
      </Field>
      <SubmitButton variant="secondary" pendingLabel="Salvando…">
        Salvar perfil de acesso
      </SubmitButton>
    </ActionForm>
  )
}
