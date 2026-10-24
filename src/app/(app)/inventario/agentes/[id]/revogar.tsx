'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { ErrorNote } from '@/components/ui'
import { revogarMaquina } from '../actions'

/**
 * Tirar a máquina da frota.
 *
 * O botão fica no cabeçalho e não escondido num menu porque o caso de uso é
 * urgente: notebook roubado. Quem precisa dele está com pressa, e um clique a
 * mais é um clique a mais.
 *
 * Não há confirmação em diálogo, e é deliberado: a ação é **reversível em termos
 * de dado** — o ativo, o inventário e o histórico ficam todos onde estavam; o que
 * para é o agente ser aceito. O que não é reversível é o contrário: deixar uma
 * máquina roubada reportando porque alguém hesitou numa caixa de confirmação.
 */
export function RevogarMaquina({ deviceId }: { deviceId: string }) {
  const [state, action] = useActionState(revogarMaquina, {})

  if (state.success) {
    return (
      <p role="status" className="text-sm font-medium text-[var(--color-ok-ink)]">
        Máquina revogada.
      </p>
    )
  }

  return (
    <div>
      <form action={action}>
        <input type="hidden" name="device_id" value={deviceId} />
        <SubmitButton variant="danger" pendingLabel="Revogando…">
          Revogar máquina
        </SubmitButton>
      </form>
      {state.error && <ErrorNote>{state.error}</ErrorNote>}
    </div>
  )
}
