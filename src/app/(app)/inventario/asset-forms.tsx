'use client'

import type { Branch, BranchArea, ItAsset, Profile } from '@/lib/types'
import { assetStatusLabel, assetTypeLabel, custodyReasonLabel } from '@/lib/i18n'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { changeAssetCustody, changeAssetStatus, createAsset, updateAsset } from './actions'

export interface SupplierOption {
  id: string
  name: string
}

interface Lookups {
  branches: Branch[]
  areas: BranchArea[]
  agents: Profile[]
  suppliers: SupplierOption[]
}

/**
 * Seletor de área.
 *
 * Um select só, com a filial no rótulo, em vez de dois encadeados: encadear
 * exigiria JavaScript, e a trigger `trg_assets_area_branch` (0013) já recusa
 * área de outra filial. Assim o formulário continua sendo enviado ao servidor
 * mesmo antes de a hidratação terminar, como o resto desta base.
 */
function AreaSelect({
  id,
  name,
  areas,
  branches,
  value,
}: {
  id: string
  name: string
  areas: BranchArea[]
  branches: Branch[]
  value: string | null | undefined
}) {
  const branchName = new Map(branches.map((b) => [b.id, b.name]))
  return (
    <select id={id} name={name} defaultValue={value ?? ''} className={inputClass}>
      <option value="">Sem área</option>
      {areas.map((a) => (
        <option key={a.id} value={a.id}>
          {branchName.get(a.branch_id) ?? '—'} · {a.name}
        </option>
      ))}
    </select>
  )
}

/*
 * Cadastrar e editar compartilham os campos pelo mesmo motivo dos cadastros de
 * cliente e filial: um campo que existisse só no cadastro seria apagado a cada
 * edição, sem aviso.
 */
function AssetFields({ branches, areas, agents, suppliers, defaults }: Lookups & { defaults?: ItAsset }) {
  const uid = defaults ? `a-${defaults.id}` : 'a-new'
  return (
    <>
      <Field label="Tipo" htmlFor={`${uid}-asset_type`} required>
        <select
          id={`${uid}-asset_type`}
          name="asset_type"
          required
          defaultValue={defaults?.asset_type ?? 'notebook'}
          className={inputClass}
        >
          {Object.entries(assetTypeLabel).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Patrimônio" htmlFor={`${uid}-asset_tag`}>
          <input
            id={`${uid}-asset_tag`}
            name="asset_tag"
            maxLength={60}
            defaultValue={defaults?.asset_tag ?? ''}
            className={inputClass}
            placeholder="PAT-001042"
          />
        </Field>
        <Field label="Nº de série" htmlFor={`${uid}-serial_number`}>
          <input
            id={`${uid}-serial_number`}
            name="serial_number"
            maxLength={120}
            defaultValue={defaults?.serial_number ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Marca" htmlFor={`${uid}-brand`}>
          <input
            id={`${uid}-brand`}
            name="brand"
            maxLength={80}
            defaultValue={defaults?.brand ?? ''}
            className={inputClass}
            placeholder="Dell"
          />
        </Field>
        <Field label="Modelo" htmlFor={`${uid}-model`}>
          <input
            id={`${uid}-model`}
            name="model"
            maxLength={120}
            defaultValue={defaults?.model ?? ''}
            className={inputClass}
            placeholder="Latitude 5450"
          />
        </Field>
      </div>

      <Field label="Status" htmlFor={`${uid}-status`} required>
        <select
          id={`${uid}-status`}
          name="status"
          required
          defaultValue={defaults?.status ?? 'in_stock'}
          className={inputClass}
        >
          {Object.entries(assetStatusLabel).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Filial" htmlFor={`${uid}-branch_id`}>
        <select
          id={`${uid}-branch_id`}
          name="branch_id"
          defaultValue={defaults?.branch_id ?? ''}
          className={inputClass}
        >
          <option value="">Não vinculado</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Área da filial"
        htmlFor={`${uid}-branch_area_id`}
        hint="Onde o equipamento fica. É o que permite ler o parque por setor."
      >
        <AreaSelect
          id={`${uid}-branch_area_id`}
          name="branch_area_id"
          areas={areas}
          branches={branches}
          value={defaults?.branch_area_id}
        />
      </Field>

      <Field label="Responsável" htmlFor={`${uid}-assigned_user_id`}>
        <select
          id={`${uid}-assigned_user_id`}
          name="assigned_user_id"
          defaultValue={defaults?.assigned_user_id ?? ''}
          className={inputClass}
        >
          <option value="">Sem responsável</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.full_name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Fornecedor" htmlFor={`${uid}-supplier_id`}>
        <select
          id={`${uid}-supplier_id`}
          name="supplier_id"
          defaultValue={defaults?.supplier_id ?? ''}
          className={inputClass}
        >
          <option value="">Não informado</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Aquisição" htmlFor={`${uid}-acquisition_date`}>
          <input
            id={`${uid}-acquisition_date`}
            name="acquisition_date"
            type="date"
            defaultValue={defaults?.acquisition_date ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Garantia até" htmlFor={`${uid}-warranty_until`}>
          <input
            id={`${uid}-warranty_until`}
            name="warranty_until"
            type="date"
            defaultValue={defaults?.warranty_until ?? ''}
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Valor de aquisição" htmlFor={`${uid}-acquisition_cost`}>
        <input
          id={`${uid}-acquisition_cost`}
          name="acquisition_cost"
          type="number"
          step="0.01"
          min="0"
          defaultValue={defaults?.acquisition_cost ?? ''}
          className={inputClass}
          placeholder="6890.00"
        />
      </Field>

      <Field label="Observações" htmlFor={`${uid}-notes`}>
        <textarea
          id={`${uid}-notes`}
          name="notes"
          rows={2}
          maxLength={2000}
          defaultValue={defaults?.notes ?? ''}
          className={inputClass}
        />
      </Field>
    </>
  )
}

export function NewAssetForm(lookups: Lookups) {
  return (
    <ActionForm action={createAsset} className="flex flex-col gap-4">
      <AssetFields {...lookups} />
      <SubmitButton pendingLabel="Cadastrando…">Cadastrar ativo</SubmitButton>
    </ActionForm>
  )
}

export function EditAssetForm({ asset, ...lookups }: Lookups & { asset: ItAsset }) {
  return (
    <div className="flex flex-col gap-4">
      <ActionForm action={updateAsset} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={asset.id} />
        <AssetFields {...lookups} defaults={asset} />
        <SubmitButton>Salvar alterações</SubmitButton>
      </ActionForm>

      {/*
        Atalho de ciclo de vida: mandar para manutenção ou dar baixa é a
        operação mais frequente da tela e não deveria exigir abrir a ficha
        inteira. Cada botão é um formulário próprio para levar o seu status.
      */}
      <div className="border-t border-[var(--color-border)] pt-4">
        <p className="mb-2 text-xs text-[var(--color-ink-3)]">
          Mudança rápida de ciclo de vida — o histórico de custódia é gravado pelo banco.
        </p>
        <div className="flex flex-wrap gap-2">
          {Object.entries(assetStatusLabel)
            .filter(([value]) => value !== asset.status)
            .map(([value, label]) => (
              <ActionForm key={value} action={changeAssetStatus}>
                <input type="hidden" name="asset_id" value={asset.id} />
                <input type="hidden" name="status" value={value} />
                <SubmitButton variant="secondary" pendingLabel="Movendo…">
                  {label}
                </SubmitButton>
              </ActionForm>
            ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Transferência de custódia.
 *
 * Separada da edição da ficha de propósito: trocar o responsável por um
 * equipamento é um ato com motivo e registro, não uma correção de cadastro. É
 * por isso que tem chave de permissão própria (`inventario.ativos.custodiar`) e
 * que o motivo é obrigatório — sem ele o histórico diria "mudou" sem dizer por
 * quê, que é a metade inútil de um registro patrimonial.
 */
export function CustodyForm({
  asset,
  branches,
  areas,
  agents,
}: {
  asset: ItAsset
  branches: Branch[]
  areas: BranchArea[]
  agents: Profile[]
}) {
  const uid = `cu-${asset.id}`
  return (
    <ActionForm action={changeAssetCustody} className="flex flex-col gap-3">
      <input type="hidden" name="asset_id" value={asset.id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Responsável" htmlFor={`${uid}-user`}>
          <select
            id={`${uid}-user`}
            name="assigned_user_id"
            defaultValue={asset.assigned_user_id ?? ''}
            className={inputClass}
          >
            <option value="">Sem responsável</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.full_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Filial" htmlFor={`${uid}-branch`}>
          <select
            id={`${uid}-branch`}
            name="branch_id"
            defaultValue={asset.branch_id ?? ''}
            className={inputClass}
          >
            <option value="">Não vinculado</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Área" htmlFor={`${uid}-area`}>
          <AreaSelect
            id={`${uid}-area`}
            name="branch_area_id"
            areas={areas}
            branches={branches}
            value={asset.branch_area_id}
          />
        </Field>
        <Field label="Motivo" htmlFor={`${uid}-reason`} required>
          <select id={`${uid}-reason`} name="reason" required defaultValue="realocacao" className={inputClass}>
            {Object.entries(custodyReasonLabel).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Observação" htmlFor={`${uid}-note`} hint="Opcional.">
        <input
          id={`${uid}-note`}
          name="note"
          maxLength={200}
          className={inputClass}
          placeholder="Entregue no desligamento do colaborador"
        />
      </Field>
      <SubmitButton variant="secondary" pendingLabel="Registrando…">
        Registrar custódia
      </SubmitButton>
    </ActionForm>
  )
}
