'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { mudarEstadoDoCanal } from '../actions'

/**
 * Pausar e religar.
 *
 * Fica em componente próprio, e não dentro do formulário de criação, porque cada
 * linha da tabela precisa do seu próprio estado de ação: com um `useActionState`
 * compartilhado, pausar o terceiro canal mostraria a mensagem de erro ao lado do
 * primeiro.
 */
export function EstadoDoCanal({ channelId, status }: { channelId: string; status: string }) {
  const [state, formAction] = useActionState(mudarEstadoDoCanal, {})
  const alvo = status === 'ativo' ? 'pausado' : 'ativo'

  return (
    <form action={formAction} className="inline-flex flex-col items-start gap-1">
      <input type="hidden" name="channel_id" value={channelId} />
      <input type="hidden" name="status" value={alvo} />
      <SubmitButton
        pendingLabel={alvo === 'pausado' ? 'Pausando…' : 'Religando…'}
        variant="secondary"
      >
        {alvo === 'pausado' ? 'Pausar' : 'Religar'}
      </SubmitButton>
      {state.error && <span className="text-xs text-[var(--color-breach-ink)]">{state.error}</span>}
    </form>
  )
}
