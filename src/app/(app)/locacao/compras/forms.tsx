'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import type { PurchaseOrder } from '@/lib/types'
import {
  moverOrdem,
  receberItem,
  registrarNota,
  removerItem,
  salvarItem,
  salvarOrdem,
} from './actions'

export function OrdemForm({
  ordem,
  fornecedores,
  depositos,
  codigoSugerido,
}: {
  ordem?: PurchaseOrder
  fornecedores: { id: string; name: string }[]
  depositos: { id: string; name: string }[]
  codigoSugerido?: string
}) {
  return (
    <ActionForm action={salvarOrdem} className="flex flex-col gap-4" manterCampos={Boolean(ordem)}>
      {ordem && <input type="hidden" name="id" value={ordem.id} />}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Número da ordem" htmlFor="oc-code" required>
          <input
            id="oc-code"
            name="code"
            required
            minLength={3}
            maxLength={40}
            defaultValue={ordem?.code ?? codigoSugerido ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Entrega prevista" htmlFor="oc-data">
          <input
            id="oc-data"
            name="expected_on"
            type="date"
            defaultValue={ordem?.expected_on ?? ''}
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Fornecedor" htmlFor="oc-forn">
        <select
          id="oc-forn"
          name="supplier_id"
          defaultValue={ordem?.supplier_id ?? ''}
          className={inputClass}
        >
          <option value="">—</option>
          {fornecedores.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Depósito de entrada"
        htmlFor="oc-dep"
        required
        hint="Onde a mercadoria dá entrada quando chegar."
      >
        <select
          id="oc-dep"
          name="depot_id"
          required
          defaultValue={ordem?.depot_id ?? ''}
          className={inputClass}
        >
          <option value="">Selecione…</option>
          {depositos.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Observações" htmlFor="oc-obs">
        <textarea
          id="oc-obs"
          name="notes"
          rows={2}
          defaultValue={ordem?.notes ?? ''}
          className={inputClass}
        />
      </Field>

      <SubmitButton pendingLabel="Salvando…">{ordem ? 'Salvar' : 'Criar ordem'}</SubmitButton>
      {!ordem && (
        <p className="text-xs text-[var(--color-ink-3)]">
          A ordem nasce como <strong>rascunho</strong>, sem itens. Rascunho não compromete nada: é o
          enviar que vira pedido ao fornecedor.
        </p>
      )}
    </ActionForm>
  )
}

export function ItemForm({
  orderId,
  pecas,
}: {
  orderId: string
  pecas: { id: string; sku: string; name: string; sugestao: number }[]
}) {
  if (pecas.length === 0) {
    return (
      <p className="rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn-ink)]">
        Nenhuma peça cadastrada. Cadastre em Peças e estoque antes de montar a ordem.
      </p>
    )
  }
  return (
    <ActionForm action={salvarItem} className="flex flex-col gap-3">
      <input type="hidden" name="order_id" value={orderId} />
      <Field label="Peça" htmlFor="it-peca" required>
        <select id="it-peca" name="part_id" required className={inputClass}>
          <option value="">Selecione…</option>
          {pecas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.sku} — {p.name}
              {p.sugestao > 0 ? ` (sugestão: ${p.sugestao})` : ''}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Quantidade" htmlFor="it-qtd" required>
          <input
            id="it-qtd"
            name="quantity"
            type="number"
            min="0.001"
            step="0.001"
            required
            className={inputClass}
          />
        </Field>
        <Field label="Preço unitário (R$)" htmlFor="it-preco">
          <input id="it-preco" name="unit_price" type="number" min="0" step="0.01" className={inputClass} />
        </Field>
      </div>
      <SubmitButton variant="secondary" pendingLabel="Acrescentando…">
        Acrescentar item
      </SubmitButton>
    </ActionForm>
  )
}

export function RemoverItemForm({ id }: { id: string }) {
  return (
    <ActionForm action={removerItem}>
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="secondary" pendingLabel="Removendo…">
        Remover
      </SubmitButton>
    </ActionForm>
  )
}

/**
 * Receber — a quantidade padrão é o que FALTA, não o que foi pedido.
 *
 * Quem está na doca confere o que chegou; oferecer o total pedido como padrão
 * convida a confirmar sem contar, e aí o sistema registra uma entrega completa
 * que não aconteceu.
 */
export function ReceberForm({ itemId, falta }: { itemId: string; falta: number }) {
  return (
    <ActionForm action={receberItem} className="flex items-end gap-2">
      <input type="hidden" name="item_id" value={itemId} />
      <Field label="Chegou" htmlFor={`rec-${itemId}`}>
        <input
          id={`rec-${itemId}`}
          name="quantity"
          type="number"
          min="0.001"
          max={falta}
          step="0.001"
          defaultValue={falta}
          required
          className={`${inputClass} w-24`}
        />
      </Field>
      <SubmitButton pendingLabel="Recebendo…">Receber</SubmitButton>
    </ActionForm>
  )
}

export function MoverOrdemForm({
  id,
  status,
}: {
  id: string
  status: 'draft' | 'sent' | 'cancelled'
  rotulo?: string
}) {
  const rotulos = { draft: 'Voltar a rascunho', sent: 'Enviar ao fornecedor', cancelled: 'Cancelar ordem' }
  return (
    <ActionForm action={moverOrdem}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value={status} />
      <SubmitButton
        variant={status === 'cancelled' ? 'danger' : status === 'sent' ? 'primary' : 'secondary'}
        pendingLabel="Salvando…"
      >
        {rotulos[status]}
      </SubmitButton>
    </ActionForm>
  )
}

export function NotaForm({ id, total }: { id: string; total: string }) {
  const em30 = new Date()
  em30.setDate(em30.getDate() + 30)
  return (
    <ActionForm action={registrarNota} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Número da NF" htmlFor={`nf-${id}`} required>
          <input id={`nf-${id}`} name="invoice_ref" required maxLength={60} className={inputClass} />
        </Field>
        <Field label="Vencimento" htmlFor={`nf-venc-${id}`} required>
          <input
            id={`nf-venc-${id}`}
            name="due_on"
            type="date"
            required
            defaultValue={em30.toISOString().slice(0, 10)}
            className={inputClass}
          />
        </Field>
      </div>
      <SubmitButton pendingLabel="Registrando…">Registrar NF e gerar título de {total}</SubmitButton>
      <p className="text-xs text-[var(--color-ink-3)]">
        O título nasce no financeiro que já existe — com aprovação, baixa e fluxo de caixa. A ordem
        guarda o número do título, e o título guarda o número da nota.
      </p>
    </ActionForm>
  )
}
