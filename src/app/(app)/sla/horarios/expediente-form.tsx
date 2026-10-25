'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { Card, ErrorNote, Field, inputClass } from '@/components/ui'
import { criarExpediente } from './actions'

/**
 * Fusos oferecidos.
 *
 * Lista curta dos que o Brasil usa de fato, e não a IANA inteira (600 entradas).
 * O campo aceita digitar outro — é `datalist`, não `select` — porque um cliente
 * com operação fora do país é possível e não deve esperar uma versão do sistema.
 */
const FUSOS = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Cuiaba',
  'America/Belem',
  'America/Fortaleza',
  'America/Recife',
  'America/Bahia',
  'America/Campo_Grande',
  'America/Porto_Velho',
  'America/Boa_Vista',
  'America/Rio_Branco',
  'America/Noronha',
]

export function ExpedienteForm({ className = '' }: { className?: string }) {
  const [state, formAction] = useActionState(criarExpediente, {})

  return (
    <Card title="Novo expediente" className={className}>
      <p className="mb-4 text-sm text-[var(--color-ink-2)]">
        Um expediente é um conjunto de faixas de horário mais os feriados. Depois de criá-lo,
        cadastre as faixas — <strong>sem elas o relógio não anda</strong>.
      </p>

      <form action={formAction} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome" htmlFor="name" required>
            <input
              id="name"
              name="name"
              required
              minLength={2}
              maxLength={80}
              className={inputClass}
              placeholder="Comercial 8h-18h"
            />
          </Field>

          <Field
            label="Fuso horário"
            htmlFor="timezone"
            hint="Define a que horas o expediente abre para quem está nessa filial."
            required
          >
            <input
              id="timezone"
              name="timezone"
              list="fusos"
              required
              defaultValue="America/Sao_Paulo"
              className={`${inputClass} font-mono`}
            />
          </Field>
          <datalist id="fusos">
            {FUSOS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </div>

        <label className="flex items-start gap-2.5 text-sm text-[var(--color-ink)]">
          <input type="checkbox" name="is_default" className="mt-0.5" />
          <span>
            Usar como expediente padrão
            <span className="block text-xs text-[var(--color-ink-3)]">
              É o que vale quando um contrato ou uma definição de SLA não escolhe nenhum. Só um
              pode ser padrão — marcar este desmarca o anterior.
            </span>
          </span>
        </label>

        {state.error && <ErrorNote>{state.error}</ErrorNote>}
        {state.success && (
          <p role="status" className="text-sm text-[var(--color-ok-ink)]">
            {state.success}
          </p>
        )}

        <SubmitButton pendingLabel="Criando…">Criar expediente</SubmitButton>
      </form>
    </Card>
  )
}
