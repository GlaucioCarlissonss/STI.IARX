'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { abrirContagem, cancelarContagem, fecharContagem, lancarContagem } from './actions'

export function AbrirContagemForm({
  depositos,
  codigoSugerido,
}: {
  depositos: { id: string; name: string }[]
  codigoSugerido: string
}) {
  if (depositos.length === 0) {
    return (
      <p className="rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn-ink)]">
        Nenhum depósito cadastrado. Cadastre em Modelos e categorias antes.
      </p>
    )
  }
  return (
    <ActionForm action={abrirContagem} className="flex flex-col gap-4">
      <Field label="Depósito" htmlFor="ct-dep" required>
        <select id="ct-dep" name="depot_id" required className={inputClass}>
          <option value="">Selecione…</option>
          {depositos.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Código" htmlFor="ct-code" required>
        <input
          id="ct-code"
          name="code"
          required
          minLength={3}
          maxLength={40}
          defaultValue={codigoSugerido}
          className={inputClass}
        />
      </Field>
      <Field label="Observações" htmlFor="ct-obs">
        <textarea id="ct-obs" name="notes" rows={2} className={inputClass} />
      </Field>
      <SubmitButton pendingLabel="Abrindo…">Abrir contagem</SubmitButton>
      <p className="text-xs text-[var(--color-ink-3)]">
        Abrir <strong>congela o esperado</strong> de cada peça do depósito. É o que impede que a
        peça consumida durante a contagem vire uma falta que nunca houve.
      </p>
    </ActionForm>
  )
}

/**
 * O lançamento da contagem, peça a peça.
 *
 * O campo nasce VAZIO, e não com o esperado: pré-preencher convida a confirmar
 * sem contar, e uma contagem que só confirma o sistema não é contagem.
 */
export function LancarContagemForm({ id, atual }: { id: string; atual: number | null }) {
  return (
    <ActionForm action={lancarContagem} className="flex items-end gap-2" manterCampos>
      <input type="hidden" name="id" value={id} />
      <Field label="Contado" htmlFor={`ct-item-${id}`}>
        <input
          id={`ct-item-${id}`}
          name="counted_quantity"
          type="number"
          min="0"
          step="0.001"
          defaultValue={atual ?? ''}
          className={`${inputClass} w-24`}
        />
      </Field>
      <SubmitButton variant="secondary" pendingLabel="Lançando…">
        Lançar
      </SubmitButton>
    </ActionForm>
  )
}

export function FecharContagemForm({ id, pendentes }: { id: string; pendentes: number }) {
  if (pendentes > 0) {
    return (
      <p className="rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn-ink)]">
        Faltam <strong>{pendentes}</strong> peça(s) sem lançamento. Fechar pela metade registraria
        perda na peça contada e silêncio na não contada — o banco recusa, e está certo.
      </p>
    )
  }
  return (
    <ActionForm action={fecharContagem} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <SubmitButton pendingLabel="Fechando…">Fechar e gerar ajustes</SubmitButton>
      <p className="text-xs text-[var(--color-ink-3)]">
        Cada diferença vira um <strong>movimento de ajuste</strong> no razão, com o esperado e o
        contado escritos. Nada é apagado.
      </p>
    </ActionForm>
  )
}

export function CancelarContagemForm({ id }: { id: string }) {
  return (
    <ActionForm action={cancelarContagem}>
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="danger" pendingLabel="Cancelando…">
        Cancelar contagem
      </SubmitButton>
    </ActionForm>
  )
}
