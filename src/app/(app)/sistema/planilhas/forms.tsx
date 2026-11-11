'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import type { RecursoDeImportacao } from '@/lib/planilha/recursos'
import { aplicarLote, conferirPlanilha, descartarLote, trocarConflito } from './actions'

export function EnviarPlanilhaForm({ recursos }: { recursos: RecursoDeImportacao[] }) {
  if (recursos.length === 0) {
    return (
      <p className="rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn-ink)]">
        Nenhum recurso disponível para importar nesta empresa.
      </p>
    )
  }
  return (
    <ActionForm action={conferirPlanilha} className="flex flex-col gap-4">
      <Field label="O que você vai importar" htmlFor="pl-recurso" required>
        <select id="pl-recurso" name="recurso" required className={inputClass}>
          <option value="">Selecione…</option>
          {recursos.map((r) => (
            <option key={r.chave} value={r.chave}>
              {r.rotulo} — {r.descricao}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Arquivo CSV"
        htmlFor="pl-arquivo"
        required
        hint="Até 4 MB e 5.000 linhas. No Excel: Salvar como → CSV UTF-8."
      >
        <input
          id="pl-arquivo"
          name="arquivo"
          type="file"
          required
          accept=".csv,text/csv"
          className={inputClass}
        />
      </Field>

      <Field
        label="Quando a linha já existir"
        htmlFor="pl-conflito"
        hint="A chave de cada recurso está na descrição acima."
      >
        <select id="pl-conflito" name="conflito" defaultValue="update" className={inputClass}>
          <option value="update">Atualizar o que já existe</option>
          <option value="skip">Pular — só entram as novas</option>
        </select>
      </Field>

      <SubmitButton pendingLabel="Conferindo…">Conferir planilha</SubmitButton>
      <p className="text-xs text-[var(--color-ink-3)]">
        <strong>Nada é gravado agora.</strong> A conferência monta a prévia linha a linha, e só
        depois você decide aplicar. A planilha enviada não é guardada.
      </p>
    </ActionForm>
  )
}

export function AplicarLoteForm({
  id,
  quantas,
}: {
  id: string
  quantas: number
}) {
  return (
    <ActionForm action={aplicarLote} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <SubmitButton pendingLabel="Aplicando…" variant={quantas > 0 ? 'primary' : 'secondary'}>
        {quantas > 0 ? `Aplicar ${quantas} linha(s)` : 'Aplicar (nada a gravar)'}
      </SubmitButton>
    </ActionForm>
  )
}

export function DescartarLoteForm({ id }: { id: string }) {
  return (
    <ActionForm action={descartarLote}>
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="secondary" pendingLabel="Descartando…">
        Descartar prévia
      </SubmitButton>
    </ActionForm>
  )
}

export function ConflitoForm({ id, atual }: { id: string; atual: 'update' | 'skip' }) {
  return (
    <ActionForm action={trocarConflito} className="flex items-end gap-2" manterCampos>
      <input type="hidden" name="id" value={id} />
      <Field label="Quando já existir" htmlFor={`cf-${id}`}>
        <select id={`cf-${id}`} name="conflito" defaultValue={atual} className={inputClass}>
          <option value="update">Atualizar</option>
          <option value="skip">Pular</option>
        </select>
      </Field>
      <SubmitButton variant="secondary" pendingLabel="Aplicando…">
        Trocar
      </SubmitButton>
    </ActionForm>
  )
}
