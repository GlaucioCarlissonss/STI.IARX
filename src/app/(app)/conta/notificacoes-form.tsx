'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { definirPreferencia } from './notificacoes-actions'

/**
 * Um formulário por tipo de aviso.
 *
 * Parece repetitivo e é deliberado: cada linha é uma Server Action independente,
 * então desligar um aviso não depende de salvar a tela inteira. Um botão
 * "Salvar" único falharia por inteiro quando uma linha falhasse — e a pessoa não
 * saberia qual.
 */
export function PreferenciasDeAviso({
  tipos,
  estado,
}: {
  tipos: readonly { kind: string; label: string; hint: string }[]
  estado: Record<string, boolean>
}) {
  return (
    <ul className="flex flex-col divide-y divide-[var(--color-border)]">
      {tipos.map((t) => {
        // Sem linha na tabela = recebe. O padrão é o serviço ligado.
        const ligado = estado[t.kind] ?? true
        return (
          <li key={t.kind} className="flex flex-wrap items-center gap-3 py-3 first:pt-0">
            <div className="min-w-48 flex-1">
              <p className="text-sm font-medium text-[var(--color-ink)]">{t.label}</p>
              <p className="text-xs text-[var(--color-ink-3)]">{t.hint}</p>
            </div>
            <ActionForm action={definirPreferencia}>
              <input type="hidden" name="kind" value={t.kind} />
              <input type="hidden" name="enabled" value={ligado ? 'false' : 'true'} />
              <SubmitButton variant="secondary" pendingLabel="…">
                {ligado ? 'Desligar' : 'Ligar'}
              </SubmitButton>
            </ActionForm>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                ligado
                  ? 'bg-[var(--color-ok-soft)] text-[var(--color-ok-ink)]'
                  : 'bg-[var(--color-neutral-soft)] text-[var(--color-neutral-ink)]'
              }`}
            >
              {ligado ? 'recebendo' : 'silenciado'}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
