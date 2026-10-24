'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { ErrorNote } from '@/components/ui'
import { fecharAlerta } from '../actions'

/**
 * Fechar um alerta à mão.
 *
 * Quase sempre desnecessário: o alerta se fecha sozinho quando a condição deixa
 * de valer — o disco esvazia, a máquina volta a falar, o serviço sobe. Isto
 * existe para o caso em que a condição foi resolvida de outro jeito, ou em que
 * alguém quer limpar a lista enquanto trata do problema.
 *
 * **E, se a condição continuar valendo, o alerta volta a abrir no ciclo
 * seguinte** — e volta a avisar, porque reabrir é um acontecimento novo. Isso é
 * deliberado: um botão que silenciasse um problema real seria um botão que
 * transforma o módulo de alerta num módulo de esconder alerta.
 */
export function FecharAlerta({ alertaId }: { alertaId: string }) {
  const [state, action] = useActionState(fecharAlerta, {})

  if (state.success) {
    return <span className="text-xs text-[var(--color-ok-ink)]">fechado</span>
  }

  return (
    <div>
      <form action={action}>
        <input type="hidden" name="alerta_id" value={alertaId} />
        <SubmitButton variant="secondary" pendingLabel="Fechando…">
          Fechar
        </SubmitButton>
      </form>
      {state.error && <ErrorNote>{state.error}</ErrorNote>}
    </div>
  )
}
