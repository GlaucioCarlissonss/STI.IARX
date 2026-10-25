'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { Card, ErrorNote, Field, inputClass } from '@/components/ui'
import { formatDateTime } from '@/lib/format'
import { paraExibicao } from '@/lib/projetos/competencia'
import { fecharCompetencia, reabrirCompetencia } from './actions'

export interface FechamentoNaTela {
  id: string
  competence: string
  closed_at: string
  reopened_at: string | null
  reopen_reason: string | null
}

/**
 * Fechar e reabrir a competência.
 *
 * ## Por que isto é uma permissão própria
 *
 * Fechar um mês é o ato que dá sentido a um número divulgado: se março pode
 * mudar depois de o relatório de março ter saído, o relatório não vale nada.
 * Quem lança não decide quando o mês para de aceitar lançamento.
 *
 * ## A reabertura não apaga o fechamento
 *
 * A linha fica, com a data da reabertura e o motivo. Apagar faria "este mês já
 * esteve fechado?" perder resposta — e essa é exatamente a pergunta de quem
 * audita um número que mudou.
 */
export function Fechamento({
  clientId,
  competencia,
  fechamento,
  historico,
  className = '',
}: {
  clientId: string
  competencia: string
  fechamento: FechamentoNaTela | null
  historico: FechamentoNaTela[]
  className?: string
}) {
  const [fechar, fecharAction] = useActionState(fecharCompetencia, {})
  const [reabrir, reabrirAction] = useActionState(reabrirCompetencia, {})

  return (
    <Card title="Fechamento da competência" className={className}>
      {fechamento ? (
        <>
          <p className="mb-3 text-sm text-[var(--color-ink-2)]">
            <strong>{paraExibicao(competencia)} está fechada</strong> desde{' '}
            {formatDateTime(fechamento.closed_at)}. Nenhum lançamento entra, sai ou muda — nem por
            importação, nem com justificativa.
          </p>
          <form action={reabrirAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="id" value={fechamento.id} />
            <Field
              label="Por que reabrir"
              htmlFor="reason"
              hint="Fica registrado. É a única coisa que alguém vai querer saber depois."
              required
            >
              <input
                id="reason"
                name="reason"
                required
                minLength={5}
                maxLength={400}
                className={inputClass}
                placeholder="Nota fiscal de dezembro chegou atrasada"
              />
            </Field>
            <SubmitButton pendingLabel="Reabrindo…" variant="danger">
              Reabrir {paraExibicao(competencia)}
            </SubmitButton>
          </form>
          {reabrir.error && <ErrorNote>{reabrir.error}</ErrorNote>}
          {reabrir.success && (
            <p role="status" className="mt-2 text-sm text-[var(--color-ok-ink)]">
              {reabrir.success}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="mb-3 text-sm text-[var(--color-ink-2)]">
            Fechar <strong>{paraExibicao(competencia)}</strong> trava a competência: nenhum
            lançamento entra, sai ou muda nela. É o que faz um número divulgado continuar valendo.
          </p>
          <form action={fecharAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="client_id" value={clientId} />
            <input type="hidden" name="competence" value={competencia} />
            <Field label="Observação" htmlFor="note">
              <input id="note" name="note" maxLength={400} className={inputClass} />
            </Field>
            <SubmitButton pendingLabel="Fechando…">
              Fechar {paraExibicao(competencia)}
            </SubmitButton>
          </form>
          {fechar.error && <ErrorNote>{fechar.error}</ErrorNote>}
          {fechar.success && (
            <p role="status" className="mt-2 text-sm text-[var(--color-ok-ink)]">
              {fechar.success}
            </p>
          )}
        </>
      )}

      {historico.length > 0 && (
        <details className="mt-4 border-t border-[var(--color-border)] pt-3">
          <summary className="cursor-pointer text-sm text-[var(--color-ink-2)]">
            {historico.length} competência(s) que já estiveram fechadas
          </summary>
          {/* O registro das reaberturas fica, e é ele que responde "este mês já
              esteve fechado?" — a pergunta de quem audita um número que mudou. */}
          <ul className="mt-2 flex flex-col gap-1.5">
            {historico.map((h) => (
              <li key={h.id} className="text-xs text-[var(--color-ink-3)]">
                <strong className="text-[var(--color-ink-2)]">
                  {paraExibicao(h.competence)}
                </strong>{' '}
                — fechada em {formatDateTime(h.closed_at)}, reaberta em{' '}
                {h.reopened_at ? formatDateTime(h.reopened_at) : '—'}
                {h.reopen_reason && `: ${h.reopen_reason}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  )
}
