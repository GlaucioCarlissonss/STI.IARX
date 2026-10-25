'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { Badge, Card, ErrorNote, Field, inputClass } from '@/components/ui'
import { formatDate } from '@/lib/format'
import {
  adicionarFaixa,
  adicionarFeriado,
  editarExpediente,
  removerFaixa,
  removerFeriado,
} from './actions'
import type { Expediente, Faixa, Feriado } from './page'

const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']

/** `08:00:00` → `08:00`. O banco guarda `time`; a tela não precisa dos segundos. */
function hhmm(t: string): string {
  return t.slice(0, 5)
}

export function ExpedienteCard({
  expediente,
  faixas,
  feriados,
  contratos,
  podeEditar,
}: {
  expediente: Expediente
  faixas: Faixa[]
  feriados: Feriado[]
  contratos: number
  podeEditar: boolean
}) {
  const [edicao, editarAction] = useActionState(editarExpediente, {})
  const [faixa, faixaAction] = useActionState(adicionarFaixa, {})
  const [removida, removerFaixaAction] = useActionState(removerFaixa, {})
  const [feriado, feriadoAction] = useActionState(adicionarFeriado, {})
  const [removido, removerFeriadoAction] = useActionState(removerFeriado, {})

  const hoje = new Date().toISOString().slice(0, 10)
  const porDia = DIAS.map((_, d) => faixas.filter((f) => f.weekday === d))
  /* Minutos por semana: o número que diz, de um olhar, se o expediente é o que
     alguém quis cadastrar. 2.700 min = 45 h, que é um expediente de 9h × 5. */
  const minutosSemana = faixas.reduce((soma, f) => {
    const [h1, m1] = hhmm(f.starts_at).split(':').map(Number)
    const [h2, m2] = hhmm(f.ends_at).split(':').map(Number)
    return soma + (h2! * 60 + m2! - (h1! * 60 + m1!))
  }, 0)

  return (
    <Card
      title={expediente.name}
      action={
        <div className="flex items-center gap-2">
          {expediente.is_default && <Badge tone="info">padrão</Badge>}
          {faixas.length === 0 && <Badge tone="breach">sem faixa</Badge>}
        </div>
      }
    >
      <p className="mb-4 text-sm text-[var(--color-ink-2)]">
        <code className="font-mono text-xs">{expediente.timezone}</code> ·{' '}
        {faixas.length === 0 ? (
          /* O estado silencioso que esta tela existe para tornar visível. */
          <span className="text-[var(--color-breach-ink)]">
            nenhuma faixa: o relógio não anda e o prazo nunca vence
          </span>
        ) : (
          <>
            {(minutosSemana / 60).toFixed(1).replace('.', ',')} h por semana
          </>
        )}
        {contratos > 0 && ` · ${contratos} contrato(s) de SLA usam este expediente`}
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Faixas de horário</h3>
          <ul className="flex flex-col gap-1.5">
            {DIAS.map((dia, d) => (
              <li key={dia} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-20 shrink-0 text-[var(--color-ink-2)]">{dia}</span>
                {porDia[d]!.length === 0 ? (
                  <span className="text-xs text-[var(--color-ink-3)]">fechado</span>
                ) : (
                  porDia[d]!.map((f) => (
                    <span
                      key={f.id}
                      className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-2)] px-2.5 py-1 text-xs tabular-nums text-[var(--color-ink)]"
                    >
                      {hhmm(f.starts_at)}–{hhmm(f.ends_at)}
                      {podeEditar && (
                        <form action={removerFaixaAction} className="inline">
                          <input type="hidden" name="id" value={f.id} />
                          <button
                            type="submit"
                            aria-label={`Remover faixa de ${hhmm(f.starts_at)} a ${hhmm(f.ends_at)} na ${dia}`}
                            className="text-[var(--color-ink-3)] hover:text-[var(--color-breach-ink)]"
                          >
                            ×
                          </button>
                        </form>
                      )}
                    </span>
                  ))
                )}
              </li>
            ))}
          </ul>

          {podeEditar && (
            <form action={faixaAction} className="mt-3 flex flex-wrap items-end gap-2">
              <input type="hidden" name="business_hours_id" value={expediente.id} />
              <Field label="Dia" htmlFor={`weekday-${expediente.id}`}>
                <select
                  id={`weekday-${expediente.id}`}
                  name="weekday"
                  defaultValue="1"
                  className={inputClass}
                >
                  {DIAS.map((dia, d) => (
                    <option key={dia} value={d}>
                      {dia}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Das" htmlFor={`starts-${expediente.id}`}>
                <input
                  id={`starts-${expediente.id}`}
                  name="starts_at"
                  type="time"
                  defaultValue="08:00"
                  required
                  className={inputClass}
                />
              </Field>
              <Field label="Até" htmlFor={`ends-${expediente.id}`}>
                <input
                  id={`ends-${expediente.id}`}
                  name="ends_at"
                  type="time"
                  defaultValue="18:00"
                  required
                  className={inputClass}
                />
              </Field>
              <SubmitButton pendingLabel="Salvando…" variant="secondary">
                Adicionar faixa
              </SubmitButton>
            </form>
          )}
          <p className="mt-2 text-xs text-[var(--color-ink-3)]">
            Duas faixas no mesmo dia são o almoço: 08:00–12:00 e 13:00–18:00 fazem o relógio parar
            entre uma e outra.
          </p>
          {faixa.error && <ErrorNote>{faixa.error}</ErrorNote>}
          {removida.error && <ErrorNote>{removida.error}</ErrorNote>}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
            Feriados ({feriados.length})
          </h3>
          {feriados.length === 0 ? (
            <p className="text-sm text-[var(--color-warn-ink)]">
              Nenhum feriado cadastrado — o prazo corre normalmente no Natal e no Carnaval.
            </p>
          ) : (
            <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {feriados.map((f) => (
                <li
                  key={f.id}
                  className={`flex items-center justify-between gap-2 text-sm ${
                    f.holiday_date < hoje ? 'text-[var(--color-ink-3)]' : 'text-[var(--color-ink)]'
                  }`}
                >
                  <span>
                    <span className="tabular-nums">{formatDate(f.holiday_date)}</span> — {f.name}
                  </span>
                  {podeEditar && (
                    <form action={removerFeriadoAction}>
                      <input type="hidden" name="id" value={f.id} />
                      <button
                        type="submit"
                        aria-label={`Remover o feriado ${f.name}`}
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
            <form action={feriadoAction} className="mt-3 flex flex-wrap items-end gap-2">
              <input type="hidden" name="business_hours_id" value={expediente.id} />
              <Field label="Data" htmlFor={`day-${expediente.id}`}>
                <input
                  id={`day-${expediente.id}`}
                  name="holiday_date"
                  type="date"
                  required
                  className={inputClass}
                />
              </Field>
              <Field label="Qual feriado" htmlFor={`fname-${expediente.id}`}>
                <input
                  id={`fname-${expediente.id}`}
                  name="name"
                  required
                  minLength={2}
                  maxLength={120}
                  className={inputClass}
                  placeholder="Carnaval"
                />
              </Field>
              <SubmitButton pendingLabel="Salvando…" variant="secondary">
                Adicionar feriado
              </SubmitButton>
            </form>
          )}
          <p className="mt-2 text-xs text-[var(--color-ink-3)]">
            A data tem ano porque Carnaval e Corpus Christi mudam todo ano. Um feriado
            &ldquo;recorrente&rdquo; que servisse só aos fixos seria armadilha.
          </p>
          {feriado.error && <ErrorNote>{feriado.error}</ErrorNote>}
          {removido.error && <ErrorNote>{removido.error}</ErrorNote>}
        </div>
      </div>

      {podeEditar && (
        <details className="mt-5 border-t border-[var(--color-border)] pt-4">
          <summary className="cursor-pointer text-sm text-[var(--color-ink-2)]">
            Renomear, trocar o fuso ou tornar padrão
          </summary>
          <form action={editarAction} className="mt-3 flex flex-wrap items-end gap-3">
            <input type="hidden" name="id" value={expediente.id} />
            <Field label="Nome" htmlFor={`name-${expediente.id}`}>
              <input
                id={`name-${expediente.id}`}
                name="name"
                defaultValue={expediente.name}
                required
                className={inputClass}
              />
            </Field>
            <Field label="Fuso" htmlFor={`tz-${expediente.id}`}>
              <input
                id={`tz-${expediente.id}`}
                name="timezone"
                defaultValue={expediente.timezone}
                required
                className={`${inputClass} font-mono`}
              />
            </Field>
            <label className="flex items-center gap-2 pb-2 text-sm text-[var(--color-ink)]">
              <input type="checkbox" name="is_default" defaultChecked={expediente.is_default} />
              padrão
            </label>
            <SubmitButton pendingLabel="Salvando…" variant="secondary">
              Salvar
            </SubmitButton>
          </form>
          {edicao.error && <ErrorNote>{edicao.error}</ErrorNote>}
          {edicao.success && (
            <p role="status" className="mt-2 text-sm text-[var(--color-ok-ink)]">
              {edicao.success}
            </p>
          )}
        </details>
      )}
    </Card>
  )
}
