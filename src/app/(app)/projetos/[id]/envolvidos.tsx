'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { Card, ErrorNote, inputClass } from '@/components/ui'
import { adicionarEnvolvido, removerEnvolvido } from '../actions'

export interface Envolvido {
  id: string
  name: string
  role_in_project: string | null
}

/**
 * Quem está no projeto.
 *
 * O nome é texto livre, e não um seletor de `profiles`: metade dos envolvidos de
 * um projeto de TI é fornecedor, gente de outro setor ou alguém que não tem
 * conta aqui. Exigir cadastro faria a lista nascer vazia e ficar assim.
 */
export function EnvolvidosDoProjeto({
  projectId,
  envolvidos,
  podeEditar,
  className = '',
}: {
  projectId: string
  envolvidos: Envolvido[]
  podeEditar: boolean
  className?: string
}) {
  const [adicao, adicionarAction] = useActionState(adicionarEnvolvido, {})
  const [remocao, removerAction] = useActionState(removerEnvolvido, {})

  return (
    <Card title={`Envolvidos (${envolvidos.length})`} className={className}>
      {envolvidos.length === 0 ? (
        <p className="text-sm text-[var(--color-ink-3)]">Ninguém registrado neste projeto.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {envolvidos.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-[var(--color-ink)]">
                {e.name}
                {e.role_in_project && (
                  <span className="ml-1.5 text-xs text-[var(--color-ink-3)]">
                    {e.role_in_project}
                  </span>
                )}
              </span>
              {podeEditar && (
                <form action={removerAction}>
                  <input type="hidden" name="id" value={e.id} />
                  <input type="hidden" name="project_id" value={projectId} />
                  <button
                    type="submit"
                    aria-label={`Remover ${e.name} do projeto`}
                    className="text-[var(--color-ink-3)] hover:text-[var(--color-breach-ink)]"
                  >
                    ×
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {podeEditar && (
        <form action={adicionarAction} className="mt-4 flex flex-wrap items-end gap-2">
          <input type="hidden" name="project_id" value={projectId} />
          <label className="sr-only" htmlFor={`env-nome-${projectId}`}>
            Nome
          </label>
          <input
            id={`env-nome-${projectId}`}
            name="name"
            required
            minLength={2}
            maxLength={160}
            className={inputClass}
            placeholder="Nome"
          />
          <label className="sr-only" htmlFor={`env-papel-${projectId}`}>
            Papel no projeto
          </label>
          <input
            id={`env-papel-${projectId}`}
            name="role_in_project"
            maxLength={120}
            className={inputClass}
            placeholder="Papel (ex.: fornecedor)"
          />
          <SubmitButton pendingLabel="…" variant="secondary">
            Acrescentar
          </SubmitButton>
        </form>
      )}

      {adicao.error && <ErrorNote>{adicao.error}</ErrorNote>}
      {remocao.error && <ErrorNote>{remocao.error}</ErrorNote>}
    </Card>
  )
}
