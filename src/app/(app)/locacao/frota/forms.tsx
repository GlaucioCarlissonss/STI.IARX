'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import type { EquipmentModel, RentalDepot, RentalEquipment } from '@/lib/types'
import { ESTADO_DO_EQUIPAMENTO, MEDIDOR } from '@/lib/locacao/rotulos'
import type { EquipmentStatus } from '@/lib/types'
import {
  bloquearEquipamento,
  criarEquipamento,
  editarEquipamento,
  moverEstadoDoEquipamento,
  registrarLeitura,
} from './actions'

/**
 * A ficha do equipamento — a mesma no cadastro e na edição.
 *
 * Um formulário só, e não dois quase iguais: a diferença entre criar e editar
 * é o `id` escondido e o verbo do botão. Dois componentes divergiriam no
 * primeiro campo acrescentado em um deles — foi assim que, em outra tela desta
 * base, um campo obrigatório existiu só na edição por uma onda inteira.
 */
export function EquipamentoForm({
  equipamento,
  modelos,
  depositos,
}: {
  equipamento?: RentalEquipment
  modelos: EquipmentModel[]
  depositos: RentalDepot[]
}) {
  const uid = equipamento ? `eq-${equipamento.id}` : 'eq-novo'
  return (
    <ActionForm
      action={equipamento ? editarEquipamento : criarEquipamento}
      manterCampos={Boolean(equipamento)}
      className="flex flex-col gap-4"
    >
      {equipamento && <input type="hidden" name="id" value={equipamento.id} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Patrimônio"
          htmlFor={`${uid}-tag`}
          required
          hint="O número que está colado na máquina — é por ele que quem está no campo a identifica."
        >
          <input
            id={`${uid}-tag`}
            name="asset_tag"
            required
            maxLength={40}
            defaultValue={equipamento?.asset_tag ?? ''}
            className={inputClass}
            placeholder="EQP-0412"
          />
        </Field>
        <Field label="Número de série" htmlFor={`${uid}-serie`}>
          <input
            id={`${uid}-serie`}
            name="serial_number"
            maxLength={60}
            defaultValue={equipamento?.serial_number ?? ''}
            className={inputClass}
          />
        </Field>
      </div>

      <Field
        label="Modelo"
        htmlFor={`${uid}-modelo`}
        required
        hint="O modelo carrega fabricante, categoria e preço de tabela. Preço não mora no equipamento: corrigi-lo viraria um update em duzentas linhas."
      >
        <select
          id={`${uid}-modelo`}
          name="model_id"
          required
          defaultValue={equipamento?.model_id ?? ''}
          className={inputClass}
        >
          <option value="">Selecione…</option>
          {modelos.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.code})
            </option>
          ))}
        </select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Depósito" htmlFor={`${uid}-deposito`} hint="Onde a peça fica quando não está com cliente.">
          <select
            id={`${uid}-deposito`}
            name="depot_id"
            defaultValue={equipamento?.depot_id ?? ''}
            className={inputClass}
          >
            <option value="">Sem depósito</option>
            {depositos.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Medidor"
          htmlFor={`${uid}-medidor`}
          required
          hint="Cama e mobiliário locam por tempo, não por uso: 'sem medidor' é a resposta certa para eles."
        >
          <select
            id={`${uid}-medidor`}
            name="meter_kind"
            defaultValue={equipamento?.meter_kind ?? 'none'}
            className={inputClass}
          >
            {(Object.keys(MEDIDOR) as (keyof typeof MEDIDOR)[]).map((k) => (
              <option key={k} value={k}>
                {MEDIDOR[k].label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Data de aquisição" htmlFor={`${uid}-data`}>
          <input
            id={`${uid}-data`}
            name="acquisition_date"
            type="date"
            defaultValue={equipamento?.acquisition_date ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Valor de aquisição" htmlFor={`${uid}-valor`}>
          <input
            id={`${uid}-valor`}
            name="acquisition_value"
            type="number"
            step="0.01"
            min="0"
            defaultValue={equipamento?.acquisition_value ?? ''}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nota fiscal" htmlFor={`${uid}-nf`}>
          <input
            id={`${uid}-nf`}
            name="invoice_ref"
            maxLength={60}
            defaultValue={equipamento?.invoice_ref ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Vida útil (meses)" htmlFor={`${uid}-vida`}>
          <input
            id={`${uid}-vida`}
            name="useful_life_months"
            type="number"
            min="1"
            max="600"
            defaultValue={equipamento?.useful_life_months ?? ''}
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Observações" htmlFor={`${uid}-obs`}>
        <textarea
          id={`${uid}-obs`}
          name="notes"
          rows={3}
          maxLength={2000}
          defaultValue={equipamento?.notes ?? ''}
          className={inputClass}
        />
      </Field>

      <SubmitButton pendingLabel={equipamento ? 'Salvando…' : 'Cadastrando…'}>
        {equipamento ? 'Salvar ficha' : 'Cadastrar equipamento'}
      </SubmitButton>
    </ActionForm>
  )
}

/**
 * Os botões de transição.
 *
 * Um formulário por destino, e não um `<select>` com "aplicar": mover o ciclo
 * de vida é um ato, não uma escolha de campo — e o rótulo de cada botão diz o
 * que vai acontecer com a máquina, que é a informação que falta na hora de
 * decidir.
 */
export function MoverEstadoForm({
  id,
  destinos,
}: {
  id: string
  destinos: { status: string; rotulo: string | null }[]
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {destinos.map((d) => {
        const estado = ESTADO_DO_EQUIPAMENTO[d.status as EquipmentStatus]
        const perigoso = d.status === 'lost' || d.status === 'written_off'
        return (
          <ActionForm key={d.status} action={moverEstadoDoEquipamento}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="status" value={d.status} />
            {/* O `title` fica no invólucro: o botão é componente compartilhado,
                e acrescentar uma prop nele para um caso só é como componentes
                compartilhados viram colchas de retalhos. */}
            <span title={d.rotulo ?? undefined}>
              <SubmitButton variant={perigoso ? 'danger' : 'secondary'} pendingLabel="Movendo…">
                {estado?.label ?? d.status}
              </SubmitButton>
            </span>
          </ActionForm>
        )
      })}
    </div>
  )
}

export function BloqueioForm({ equipamento }: { equipamento: RentalEquipment }) {
  if (equipamento.blocked) {
    return (
      <ActionForm action={bloquearEquipamento}>
        <input type="hidden" name="id" value={equipamento.id} />
        <input type="hidden" name="blocked" value="false" />
        <p className="mb-2 rounded-lg bg-[var(--color-crit-soft)] px-3 py-2 text-sm text-[var(--color-crit-ink)]">
          {equipamento.block_reason}
        </p>
        <SubmitButton variant="secondary" pendingLabel="Desbloqueando…">
          Desbloquear
        </SubmitButton>
      </ActionForm>
    )
  }

  return (
    <ActionForm action={bloquearEquipamento} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={equipamento.id} />
      <input type="hidden" name="blocked" value="true" />
      <Field
        label="Motivo do bloqueio"
        htmlFor={`bloq-${equipamento.id}`}
        required
        hint="Obrigatório no banco: máquina parada sem motivo registrado é a que alguém destrava para destravar o contrato."
      >
        <input
          id={`bloq-${equipamento.id}`}
          name="block_reason"
          required
          maxLength={300}
          className={inputClass}
          placeholder="Preventiva vencida desde 10/10"
        />
      </Field>
      <Field label="Até quando (opcional)" htmlFor={`bloq-ate-${equipamento.id}`}>
        <input
          id={`bloq-ate-${equipamento.id}`}
          name="block_until"
          type="date"
          className={inputClass}
        />
      </Field>
      <SubmitButton variant="danger" pendingLabel="Bloqueando…">
        Bloquear equipamento
      </SubmitButton>
    </ActionForm>
  )
}

export function LeituraForm({ equipamento }: { equipamento: RentalEquipment }) {
  return (
    <ActionForm action={registrarLeitura} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={equipamento.id} />
      <Field
        label={`${MEDIDOR[equipamento.meter_kind].label} agora`}
        htmlFor={`leitura-${equipamento.id}`}
        required
        hint="O banco recusa leitura menor que a anterior: medidor que anda para trás é troca de aparelho ou erro de digitação, e os dois precisam de registro."
      >
        <input
          id={`leitura-${equipamento.id}`}
          name="meter_reading"
          type="number"
          step="1"
          min={equipamento.meter_reading}
          defaultValue={equipamento.meter_reading}
          required
          className={inputClass}
        />
      </Field>
      <SubmitButton pendingLabel="Registrando…">Registrar leitura</SubmitButton>
    </ActionForm>
  )
}
