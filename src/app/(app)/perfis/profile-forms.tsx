'use client'

import type { AccessProfile, UserRole } from '@/lib/types'
import { ROLE_RANK, catalogTree } from '@/lib/permissions'
import { roleLabel } from '@/lib/i18n'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import {
  createAccessProfile,
  saveProfileGrants,
  setAccessProfileActive,
  updateAccessProfile,
} from './actions'

const BASE_ROLES: Exclude<UserRole, 'super_admin'>[] = [
  'admin',
  'gestor',
  'atendente',
  'solicitante',
  'visualizador',
]

function ProfileFields({ defaults }: { defaults?: AccessProfile }) {
  const uid = defaults ? `ap-${defaults.id}` : 'ap-new'
  const bloqueado = defaults?.is_system ?? false
  return (
    <>
      <Field label="Nome do perfil" htmlFor={`${uid}-name`} required>
        <input
          id={`${uid}-name`}
          name="name"
          required
          maxLength={80}
          defaultValue={defaults?.name ?? ''}
          disabled={bloqueado}
          className={inputClass}
          placeholder="Operador de Compras"
        />
      </Field>
      <Field label="Descrição" htmlFor={`${uid}-description`}>
        <input
          id={`${uid}-description`}
          name="description"
          maxLength={300}
          defaultValue={defaults?.description ?? ''}
          disabled={bloqueado}
          className={inputClass}
        />
      </Field>
      <Field
        label="Papel base"
        htmlFor={`${uid}-base_role`}
        required
        hint="Teto do perfil. Nenhuma permissão acima dele pode ser concedida, e atribuir o perfil nunca promove ninguém."
      >
        <select
          id={`${uid}-base_role`}
          name="base_role"
          required
          defaultValue={defaults?.base_role ?? 'atendente'}
          disabled={bloqueado}
          className={inputClass}
        >
          {BASE_ROLES.map((r) => (
            <option key={r} value={r}>
              {roleLabel[r]}
            </option>
          ))}
        </select>
      </Field>
    </>
  )
}

export function NewProfileForm() {
  return (
    <ActionForm action={createAccessProfile} className="flex flex-col gap-4">
      <ProfileFields />
      <SubmitButton pendingLabel="Criando…">Criar perfil</SubmitButton>
    </ActionForm>
  )
}

export function EditProfileForm({ profile }: { profile: AccessProfile }) {
  return (
    <div className="flex flex-col gap-4">
      {profile.is_system ? (
        <p className="rounded-lg bg-[var(--color-brand-soft)] px-3.5 py-2.5 text-sm text-[var(--color-brand-ink)]">
          Perfil de sistema: nome, descrição e papel base são contrato da plataforma. Situação e
          permissões continuam editáveis.
        </p>
      ) : (
        <ActionForm action={updateAccessProfile} className="flex flex-col gap-4">
          <input type="hidden" name="id" value={profile.id} />
          <ProfileFields defaults={profile} />
          <SubmitButton>Salvar perfil</SubmitButton>
        </ActionForm>
      )}

      <ActionForm action={setAccessProfileActive} className="border-t border-[var(--color-border)] pt-4">
        <input type="hidden" name="id" value={profile.id} />
        <input type="hidden" name="is_active" value={profile.is_active ? 'false' : 'true'} />
        <p className="mb-2 text-xs text-[var(--color-ink-3)]">
          {profile.is_active
            ? 'Inativar não desatribui ninguém: quem já usa o perfil passa a cair no papel puro.'
            : 'Reativar devolve o perfil aos seletores de usuário.'}
        </p>
        <SubmitButton variant={profile.is_active ? 'danger' : 'secondary'}>
          {profile.is_active ? 'Inativar perfil' : 'Reativar perfil'}
        </SubmitButton>
      </ActionForm>
    </div>
  )
}

/**
 * Matriz módulo → tela → ação.
 *
 * Sem estado no cliente: os checkboxes são um formulário comum e o servidor
 * fecha a hierarquia com `withAncestors`. Marcar/desmarcar em cascata no
 * navegador daria a impressão de que a UI é a autoridade — e a autoridade é o
 * `saveProfileGrants`, que também recusa o que passa do teto.
 *
 * A ação acima do teto do perfil aparece desabilitada e explicada, em vez de
 * escondida: um administrador que não encontra "Editar perfis" na lista tende a
 * concluir que a permissão não existe.
 */
export function PermissionMatrix({
  profile,
  granted,
}: {
  profile: AccessProfile
  granted: string[]
}) {
  const marcado = new Set(granted)
  const teto = ROLE_RANK[profile.base_role]

  return (
    <ActionForm action={saveProfileGrants} className="flex flex-col gap-4">
      <input type="hidden" name="profile_id" value={profile.id} />

      <div className="flex flex-col gap-3">
        {catalogTree().map((mod) => {
          const moduloForaDoTeto = ROLE_RANK[
            (mod.screens[0]?.actions[0]?.minBaseRole ?? 'visualizador') as UserRole
          ]
          return (
            <details
              key={mod.key}
              open={marcado.has(mod.key)}
              className="rounded-lg border border-[var(--color-border)]"
            >
              <summary className="cursor-pointer list-none px-3 py-2 text-sm font-semibold text-[var(--color-ink)]">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="perm"
                    value={mod.key}
                    defaultChecked={marcado.has(mod.key)}
                    disabled={moduloForaDoTeto > teto}
                  />
                  {mod.label}
                </label>
              </summary>

              <div className="flex flex-col gap-2 border-t border-[var(--color-border)] px-3 py-2">
                {mod.screens.map((tela) => (
                  <div key={tela.key} className="pl-1">
                    <label className="inline-flex items-center gap-2 text-sm text-[var(--color-ink-2)]">
                      <input
                        type="checkbox"
                        name="perm"
                        value={tela.key}
                        defaultChecked={marcado.has(tela.key)}
                      />
                      {tela.label}
                    </label>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 border-l border-[var(--color-border)] pl-3">
                      {tela.actions.map((acao) => {
                        const fora = ROLE_RANK[acao.minBaseRole] > teto
                        return (
                          <label
                            key={acao.key}
                            title={
                              fora
                                ? `Exige papel base ${roleLabel[acao.minBaseRole]} — este perfil é ${roleLabel[profile.base_role]}`
                                : undefined
                            }
                            className={`inline-flex items-center gap-1.5 text-xs ${
                              fora ? 'text-[var(--color-ink-3)]' : 'text-[var(--color-ink-2)]'
                            }`}
                          >
                            <input
                              type="checkbox"
                              name="perm"
                              value={acao.key}
                              defaultChecked={marcado.has(acao.key)}
                              disabled={fora}
                            />
                            {acao.label}
                            {fora && <span aria-hidden="true">🔒</span>}
                          </label>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )
        })}
      </div>

      <p className="text-xs text-[var(--color-ink-3)]">
        Desmarcar o módulo nega tudo dentro dele. Marcar uma ação marca a tela e o módulo
        automaticamente ao salvar. Cadeado = acima do papel base deste perfil.
      </p>
      <SubmitButton>Salvar permissões</SubmitButton>
    </ActionForm>
  )
}
