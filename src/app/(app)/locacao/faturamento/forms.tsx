'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import type { RentalContract } from '@/lib/types'
import { cancelarFatura, emitirFatura, gerarFatura } from './actions'

/**
 * Gerar a prévia.
 *
 * Contrato e competência, e só. Tudo o mais — quais itens, quantos dias,
 * quanto de excedente — sai do contrato e das medições: é o ponto inteiro deste
 * módulo que a fatura não seja digitada.
 */
export function GerarFaturaForm({
  contratos,
  competenciaPadrao,
}: {
  contratos: (RentalContract & { cliente: string })[]
  competenciaPadrao: string
}) {
  if (contratos.length === 0) {
    return (
      <p className="rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn-ink)]">
        Nenhum contrato ativo ou suspenso para faturar. Rascunho não fatura — ative o contrato
        antes.
      </p>
    )
  }
  return (
    <ActionForm action={gerarFatura} className="flex flex-col gap-4">
      <Field label="Contrato" htmlFor="fat-contrato" required>
        <select id="fat-contrato" name="contract_id" required className={inputClass}>
          <option value="">Selecione…</option>
          {contratos.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} — {c.cliente}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Competência"
        htmlFor="fat-comp"
        required
        hint="O mês a que a cobrança pertence — não o mês em que ela é emitida."
      >
        <input
          id="fat-comp"
          name="competencia"
          type="month"
          required
          defaultValue={competenciaPadrao}
          className={inputClass}
        />
      </Field>
      <SubmitButton pendingLabel="Calculando…">Gerar prévia</SubmitButton>
      <p className="text-xs text-[var(--color-ink-3)]">
        A prévia é gravada como <strong>rascunho</strong>: o que você confere é exatamente o que
        será emitido, com a memória de cálculo em cada linha. Rascunho não cobra nada.
      </p>
    </ActionForm>
  )
}

export function EmitirFaturaForm({ id, total }: { id: string; total: number }) {
  return (
    <ActionForm action={emitirFatura} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <SubmitButton pendingLabel="Emitindo…" variant={total > 0 ? 'primary' : 'secondary'}>
        Emitir e gerar título
      </SubmitButton>
      <p className="text-xs text-[var(--color-ink-3)]">
        Emitir cria o título a receber no financeiro que já existe — com baixa, conciliação e fluxo
        de caixa. A fatura guarda o número do título, e o título guarda o número da fatura.
      </p>
    </ActionForm>
  )
}

export function CancelarFaturaForm({ id, emitida }: { id: string; emitida: boolean }) {
  return (
    <ActionForm action={cancelarFatura} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      <Field label="Motivo" htmlFor={`canc-${id}`} hint="Fica na fatura — é o que explica o cancelamento seis meses depois.">
        <input id={`canc-${id}`} name="motivo" maxLength={300} className={inputClass} />
      </Field>
      <SubmitButton variant="danger" pendingLabel="Cancelando…">
        {emitida ? 'Cancelar fatura e o título' : 'Descartar rascunho'}
      </SubmitButton>
    </ActionForm>
  )
}
