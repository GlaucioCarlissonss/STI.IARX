'use client'

import type { Branch, InternetLink } from '@/lib/types'
import { linkStatusLabel, linkTechnologyLabel } from '@/lib/i18n'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import {
  closeLinkOutage,
  createInternetLink,
  openLinkOutage,
  setInternetLinkStatus,
  updateInternetLink,
} from './actions'

export interface AreaOption {
  id: string
  branch_id: string
  name: string
}

export interface SupplierOption {
  id: string
  name: string
}

interface Lookups {
  branches: Branch[]
  areas: AreaOption[]
  suppliers: SupplierOption[]
}

/**
 * Campos do link.
 *
 * A área da filial é um select único com a filial no rótulo, e não dois selects
 * encadeados: encadear exigiria JavaScript, e a trigger `trg_links_area_branch`
 * (0013) já recusa área de outra filial. Assim o formulário continua funcionando
 * antes da hidratação, como o resto desta base.
 *
 * `has_static_ip` não aparece: é derivado de o IP ter sido preenchido, no
 * `internetLinkSchema`. Pedir a marcação e o endereço em separado criaria o estado
 * "marquei mas não preenchi", que o CHECK `link_static_ip_pair` recusa.
 */
function LinkFields({ branches, areas, suppliers, defaults }: Lookups & { defaults?: InternetLink }) {
  const uid = defaults ? `k-${defaults.id}` : 'k-new'
  const branchName = new Map(branches.map((b) => [b.id, b.name]))

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nº do contrato" htmlFor={`${uid}-contract_number`}>
          <input
            id={`${uid}-contract_number`}
            name="contract_number"
            maxLength={60}
            defaultValue={defaults?.contract_number ?? ''}
            className={inputClass}
            placeholder="NL-LINK-005"
          />
        </Field>
        <Field label="Tecnologia" htmlFor={`${uid}-technology`} required>
          <select
            id={`${uid}-technology`}
            name="technology"
            required
            defaultValue={defaults?.technology ?? 'fiber'}
            className={inputClass}
          >
            {Object.entries(linkTechnologyLabel).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Fornecedor cadastrado" htmlFor={`${uid}-supplier_id`}>
          <select
            id={`${uid}-supplier_id`}
            name="supplier_id"
            defaultValue={defaults?.supplier_id ?? ''}
            className={inputClass}
          >
            <option value="">—</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Operadora"
          htmlFor={`${uid}-carrier_name`}
          hint="Preencha quando a operadora não estiver no cadastro de fornecedores."
        >
          <input
            id={`${uid}-carrier_name`}
            name="carrier_name"
            maxLength={80}
            defaultValue={defaults?.carrier_name ?? ''}
            className={inputClass}
            placeholder="Vivo Fibra"
          />
        </Field>

        <Field label="Filial" htmlFor={`${uid}-branch_id`} required>
          <select
            id={`${uid}-branch_id`}
            name="branch_id"
            required
            defaultValue={defaults?.branch_id ?? ''}
            className={inputClass}
          >
            <option value="">Selecione…</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Área da filial" htmlFor={`${uid}-branch_area_id`}>
          <select
            id={`${uid}-branch_area_id`}
            name="branch_area_id"
            defaultValue={defaults?.branch_area_id ?? ''}
            className={inputClass}
          >
            <option value="">—</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {branchName.get(a.branch_id) ?? '—'} · {a.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Download (Mbps)" htmlFor={`${uid}-download_mbps`}>
          <input
            id={`${uid}-download_mbps`}
            name="download_mbps"
            type="number"
            min={1}
            defaultValue={defaults?.download_mbps ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Upload (Mbps)" htmlFor={`${uid}-upload_mbps`}>
          <input
            id={`${uid}-upload_mbps`}
            name="upload_mbps"
            type="number"
            min={1}
            defaultValue={defaults?.upload_mbps ?? ''}
            className={inputClass}
          />
        </Field>
        <Field
          label="Banda garantida (Mbps)"
          htmlFor={`${uid}-guaranteed_mbps`}
          hint="O piso contratado, não a velocidade nominal."
        >
          <input
            id={`${uid}-guaranteed_mbps`}
            name="guaranteed_mbps"
            type="number"
            min={1}
            defaultValue={defaults?.guaranteed_mbps ?? ''}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="IP fixo" htmlFor={`${uid}-static_ip`} hint="Deixe vazio se o link não tem IP fixo.">
          <input
            id={`${uid}-static_ip`}
            name="static_ip"
            defaultValue={defaults?.static_ip ?? ''}
            className={inputClass}
            placeholder="200.150.10.2"
          />
        </Field>
        <Field
          label="Host monitorado"
          htmlFor={`${uid}-monitoring_host`}
          hint="Vazio = não monitorado. O link não passa a constar como fora do ar por isso."
        >
          <input
            id={`${uid}-monitoring_host`}
            name="monitoring_host"
            defaultValue={defaults?.monitoring_host ?? ''}
            className={inputClass}
            placeholder="200.150.10.2"
          />
        </Field>

        <Field label="CPE — marca" htmlFor={`${uid}-cpe_brand`}>
          <input
            id={`${uid}-cpe_brand`}
            name="cpe_brand"
            maxLength={60}
            defaultValue={defaults?.cpe_brand ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="CPE — modelo" htmlFor={`${uid}-cpe_model`}>
          <input
            id={`${uid}-cpe_model`}
            name="cpe_model"
            maxLength={60}
            defaultValue={defaults?.cpe_model ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="CPE — nº de série" htmlFor={`${uid}-cpe_serial`}>
          <input
            id={`${uid}-cpe_serial`}
            name="cpe_serial"
            maxLength={80}
            defaultValue={defaults?.cpe_serial ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Custo mensal" htmlFor={`${uid}-monthly_cost`}>
          <input
            id={`${uid}-monthly_cost`}
            name="monthly_cost"
            type="number"
            step="0.01"
            min={0}
            defaultValue={defaults?.monthly_cost ?? ''}
            className={inputClass}
            placeholder="4800.00"
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Situação" htmlFor={`${uid}-status`} required>
          <select
            id={`${uid}-status`}
            name="status"
            required
            defaultValue={defaults?.status ?? 'active'}
            className={inputClass}
          >
            {Object.entries(linkStatusLabel).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Cancelamento"
          htmlFor={`${uid}-cancelled_on`}
          hint="Obrigatório se a situação for cancelado."
        >
          <input
            id={`${uid}-cancelled_on`}
            name="cancelled_on"
            type="date"
            defaultValue={defaults?.cancelled_on ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Ativação" htmlFor={`${uid}-activated_on`}>
          <input
            id={`${uid}-activated_on`}
            name="activated_on"
            type="date"
            defaultValue={defaults?.activated_on ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Início da vigência" htmlFor={`${uid}-contract_start`}>
          <input
            id={`${uid}-contract_start`}
            name="contract_start"
            type="date"
            defaultValue={defaults?.contract_start ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Fim da vigência" htmlFor={`${uid}-contract_end`}>
          <input
            id={`${uid}-contract_end`}
            name="contract_end"
            type="date"
            defaultValue={defaults?.contract_end ?? ''}
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Observações" htmlFor={`${uid}-notes`}>
        <textarea
          id={`${uid}-notes`}
          name="notes"
          rows={2}
          defaultValue={defaults?.notes ?? ''}
          className={inputClass}
        />
      </Field>
    </>
  )
}

export function NewLinkForm(lookups: Lookups) {
  return (
    <ActionForm action={createInternetLink} className="flex flex-col gap-4">
      <LinkFields {...lookups} />
      <SubmitButton pendingLabel="Cadastrando…">Cadastrar link</SubmitButton>
    </ActionForm>
  )
}

export function EditLinkForm({ link, ...lookups }: Lookups & { link: InternetLink }) {
  const suspendable = link.status !== 'cancelled'
  return (
    <ActionForm action={updateInternetLink} className="flex flex-col gap-4">
      <input type="hidden" name="id" value={link.id} />
      <LinkFields {...lookups} defaults={link} />
      <SubmitButton>Salvar alterações</SubmitButton>
      {!suspendable && (
        <p className="text-xs text-[var(--color-ink-3)]">
          Link cancelado. Reativar é mudar a situação acima e limpar a data de cancelamento.
        </p>
      )}
    </ActionForm>
  )
}

/** Atalho de situação, fora do formulário grande. */
export function LinkStatusShortcut({ link }: { link: InternetLink }) {
  if (link.status === 'cancelled') return null
  return (
    <ActionForm action={setInternetLinkStatus}>
      <input type="hidden" name="id" value={link.id} />
      <input type="hidden" name="status" value={link.status === 'active' ? 'suspended' : 'active'} />
      <p className="mb-2 text-xs text-[var(--color-ink-3)]">
        Suspender interrompe o link sem encerrar o contrato — o custo mensal sai do total ativo.
        Cancelar exige a data e é feito no formulário acima.
      </p>
      <SubmitButton variant="secondary">
        {link.status === 'active' ? 'Suspender link' : 'Reativar link'}
      </SubmitButton>
    </ActionForm>
  )
}

/**
 * Registro manual de queda e retorno.
 *
 * É o mesmo evento que a Edge Function do Zabbix vai gravar quando existir — por
 * isso `source` é `'manual'` no banco: quem olha o histórico precisa distinguir o
 * que foi medido do que foi digitado.
 */
export function LinkOutageForm({ link, aberta }: { link: InternetLink; aberta: boolean }) {
  if (aberta) {
    return (
      <ActionForm action={closeLinkOutage}>
        <input type="hidden" name="link_id" value={link.id} />
        <SubmitButton variant="secondary" pendingLabel="Registrando…">
          Registrar retorno do link
        </SubmitButton>
      </ActionForm>
    )
  }
  return (
    <ActionForm action={openLinkOutage} className="flex flex-col gap-3">
      <input type="hidden" name="link_id" value={link.id} />
      <Field label="O que aconteceu" htmlFor={`out-${link.id}`} hint="Opcional.">
        <input
          id={`out-${link.id}`}
          name="note"
          maxLength={200}
          className={inputClass}
          placeholder="Rompimento de fibra na avenida"
        />
      </Field>
      <SubmitButton variant="secondary" pendingLabel="Registrando…">
        Registrar queda
      </SubmitButton>
    </ActionForm>
  )
}
