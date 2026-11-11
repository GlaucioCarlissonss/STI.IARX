'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { UNIDADE } from '@/lib/locacao/rotulos'
import type { Part, PartUnit } from '@/lib/types'
import { lancarMovimento, salvarPeca, salvarPolitica, transferirPeca } from './actions'

const UNIDADES = Object.keys(UNIDADE) as PartUnit[]

export function PecaForm({
  peca,
  fabricantes,
}: {
  peca?: Part
  fabricantes: { id: string; name: string }[]
}) {
  return (
    <ActionForm action={salvarPeca} className="flex flex-col gap-4" manterCampos={Boolean(peca)}>
      {peca && <input type="hidden" name="id" value={peca.id} />}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Código (SKU)" htmlFor="pc-sku" required>
          <input
            id="pc-sku"
            name="sku"
            required
            minLength={2}
            maxLength={40}
            defaultValue={peca?.sku ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Unidade" htmlFor="pc-un" required>
          <select id="pc-un" name="unit" required defaultValue={peca?.unit ?? 'un'} className={inputClass}>
            {UNIDADES.map((u) => (
              <option key={u} value={u}>
                {UNIDADE[u]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Nome" htmlFor="pc-nome" required>
        <input
          id="pc-nome"
          name="name"
          required
          minLength={3}
          maxLength={160}
          defaultValue={peca?.name ?? ''}
          className={inputClass}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Categoria" htmlFor="pc-cat">
          <input
            id="pc-cat"
            name="category"
            maxLength={60}
            defaultValue={peca?.category ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Fabricante" htmlFor="pc-fab">
          <select
            id="pc-fab"
            name="manufacturer_id"
            defaultValue={peca?.manufacturer_id ?? ''}
            className={inputClass}
          >
            <option value="">—</option>
            {fabricantes.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Observações" htmlFor="pc-obs">
        <textarea
          id="pc-obs"
          name="notes"
          rows={3}
          defaultValue={peca?.notes ?? ''}
          className={inputClass}
        />
      </Field>

      <SubmitButton pendingLabel="Salvando…">{peca ? 'Salvar' : 'Cadastrar peça'}</SubmitButton>
      <p className="text-xs text-[var(--color-ink-3)]">
        O saldo não se cadastra aqui — ele é a soma dos movimentos. Para a peça nascer com estoque,
        lance uma <strong>entrada</strong>.
      </p>
    </ActionForm>
  )
}

export function PoliticaForm({
  partId,
  depotId,
  min,
  max,
  prazo,
}: {
  partId: string
  depotId: string
  min: number | null
  max: number | null
  prazo: number | null
}) {
  return (
    <ActionForm action={salvarPolitica} className="flex flex-col gap-3" manterCampos>
      <input type="hidden" name="part_id" value={partId} />
      <input type="hidden" name="depot_id" value={depotId} />
      <div className="grid grid-cols-3 gap-3">
        <Field label="Mínimo" htmlFor={`pol-min-${depotId}`}>
          <input
            id={`pol-min-${depotId}`}
            name="min_quantity"
            type="number"
            min="0"
            step="0.001"
            defaultValue={min ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Máximo" htmlFor={`pol-max-${depotId}`}>
          <input
            id={`pol-max-${depotId}`}
            name="max_quantity"
            type="number"
            min="0"
            step="0.001"
            defaultValue={max ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Prazo (dias)" htmlFor={`pol-prazo-${depotId}`}>
          <input
            id={`pol-prazo-${depotId}`}
            name="lead_time_days"
            type="number"
            min="1"
            defaultValue={prazo ?? ''}
            className={inputClass}
          />
        </Field>
      </div>
      <SubmitButton variant="secondary" pendingLabel="Salvando…">
        Salvar política
      </SubmitButton>
      <p className="text-xs text-[var(--color-ink-3)]">
        A sugestão de compra é <strong>máximo − saldo</strong>: repor até o mínimo faz comprar de
        novo na semana seguinte.
      </p>
    </ActionForm>
  )
}

/**
 * O lançamento à mão.
 *
 * A direção é um seletor, e a quantidade é sempre positiva. Deixar digitar
 * "−3" num campo de quantidade é convidar o engano que o estoque não perdoa —
 * e o razão é imutável, então o engano vira duas linhas para sempre.
 */
export function MovimentoForm({ partId, depotId }: { partId: string; depotId: string }) {
  return (
    <ActionForm action={lancarMovimento} className="flex flex-col gap-3">
      <input type="hidden" name="part_id" value={partId} />
      <input type="hidden" name="depot_id" value={depotId} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="O que houve" htmlFor="mv-dir" required>
          <select id="mv-dir" name="direcao" required defaultValue="entrada" className={inputClass}>
            <option value="entrada">Entrada (compra avulsa)</option>
            <option value="saida">Saída</option>
            <option value="ajuste_mais">Ajuste — sobrou</option>
            <option value="ajuste_menos">Ajuste — faltou</option>
          </select>
        </Field>
        <Field label="Quantidade" htmlFor="mv-qtd" required>
          <input
            id="mv-qtd"
            name="quantity"
            type="number"
            min="0.001"
            step="0.001"
            required
            className={inputClass}
          />
        </Field>
      </div>
      <Field label="Custo unitário (R$)" htmlFor="mv-custo" hint="Só na entrada — é o que move o custo médio.">
        <input id="mv-custo" name="unit_cost" type="number" min="0" step="0.01" className={inputClass} />
      </Field>
      <Field label="Motivo" htmlFor="mv-notas">
        <input id="mv-notas" name="notes" maxLength={300} className={inputClass} />
      </Field>
      <SubmitButton pendingLabel="Lançando…">Lançar movimento</SubmitButton>
    </ActionForm>
  )
}

export function TransferenciaForm({
  partId,
  depotId,
  depositos,
}: {
  partId: string
  depotId: string
  depositos: { id: string; name: string }[]
}) {
  const destinos = depositos.filter((d) => d.id !== depotId)
  if (destinos.length === 0) {
    return (
      <p className="text-sm text-[var(--color-ink-3)]">
        Não há outro depósito para onde transferir.
      </p>
    )
  }
  return (
    <ActionForm action={transferirPeca} className="flex flex-col gap-3">
      <input type="hidden" name="part_id" value={partId} />
      <input type="hidden" name="depot_id" value={depotId} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Para" htmlFor="tr-dest" required>
          <select id="tr-dest" name="destino_id" required className={inputClass}>
            {destinos.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quantidade" htmlFor="tr-qtd" required>
          <input
            id="tr-qtd"
            name="quantity"
            type="number"
            min="0.001"
            step="0.001"
            required
            className={inputClass}
          />
        </Field>
      </div>
      <Field label="Motivo" htmlFor="tr-notas">
        <input id="tr-notas" name="notes" maxLength={300} className={inputClass} />
      </Field>
      <SubmitButton variant="secondary" pendingLabel="Transferindo…">
        Transferir
      </SubmitButton>
      <p className="text-xs text-[var(--color-ink-3)]">
        São dois movimentos, um em cada depósito — o total em estoque não muda, só o lugar.
      </p>
    </ActionForm>
  )
}
