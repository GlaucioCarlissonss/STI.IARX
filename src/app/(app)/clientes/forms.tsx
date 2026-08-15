'use client'

import type { Branch, Client } from '@/lib/types'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import {
  createBranch,
  createClientRecord,
  setBranchActive,
  setClientStatus,
  updateBranch,
  updateClientRecord,
} from './actions'

/** Fusos brasileiros — cobrem as filiais reais sem exigir uma lista IANA inteira. */
const TIMEZONES = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Cuiaba',
  'America/Belem',
  'America/Fortaleza',
  'America/Recife',
  'America/Bahia',
  'America/Campo_Grande',
  'America/Porto_Velho',
  'America/Rio_Branco',
  'America/Boa_Vista',
  'America/Noronha',
]

export interface BusinessHoursOption {
  id: string
  name: string
  is_24x7: boolean
}

/*
 * Os campos ficam em componentes próprios porque cadastrar e editar usam
 * exatamente o mesmo conjunto. Duplicar o JSX faria com que um campo novo
 * aparecesse só no cadastro — e o formulário de edição passaria a apagar
 * silenciosamente o valor daquele campo a cada salvamento.
 */

function ClientFields({ defaults }: { defaults?: Client }) {
  const uid = defaults ? `c-${defaults.id}` : 'c-new'
  return (
    <>
      <Field label="Razão social" htmlFor={`${uid}-legal_name`} required>
        <input
          id={`${uid}-legal_name`}
          name="legal_name"
          required
          maxLength={200}
          defaultValue={defaults?.legal_name ?? ''}
          className={inputClass}
        />
      </Field>
      <Field label="Nome fantasia" htmlFor={`${uid}-trade_name`}>
        <input
          id={`${uid}-trade_name`}
          name="trade_name"
          maxLength={200}
          defaultValue={defaults?.trade_name ?? ''}
          className={inputClass}
        />
      </Field>
      <Field label="CNPJ" htmlFor={`${uid}-cnpj`}>
        <input
          id={`${uid}-cnpj`}
          name="cnpj"
          maxLength={20}
          defaultValue={defaults?.cnpj ?? ''}
          className={inputClass}
          placeholder="00.000.000/0001-00"
        />
      </Field>
      <Field label="Referência de contrato" htmlFor={`${uid}-contract_ref`}>
        <input
          id={`${uid}-contract_ref`}
          name="contract_ref"
          maxLength={100}
          defaultValue={defaults?.contract_ref ?? ''}
          className={inputClass}
        />
      </Field>
    </>
  )
}

export function NewClientForm() {
  return (
    <ActionForm action={createClientRecord} className="flex flex-col gap-4">
      <ClientFields />
      <SubmitButton pendingLabel="Cadastrando…">Cadastrar cliente</SubmitButton>
    </ActionForm>
  )
}

export function EditClientForm({ client }: { client: Client }) {
  return (
    <div className="flex flex-col gap-4">
      <ActionForm action={updateClientRecord} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={client.id} />
        <ClientFields defaults={client} />
        <SubmitButton>Salvar alterações</SubmitButton>
      </ActionForm>

      <ActionForm action={setClientStatus} className="border-t border-[var(--color-border)] pt-4">
        <input type="hidden" name="id" value={client.id} />
        <input
          type="hidden"
          name="status"
          value={client.status === 'active' ? 'inactive' : 'active'}
        />
        <p className="mb-2 text-xs text-[var(--color-ink-3)]">
          {client.status === 'active'
            ? 'Inativar tira o cliente dos seletores e mantém filiais, tickets e contratos históricos.'
            : 'Reativar devolve o cliente aos seletores de cadastro.'}
        </p>
        <SubmitButton variant={client.status === 'active' ? 'danger' : 'secondary'}>
          {client.status === 'active' ? 'Inativar cliente' : 'Reativar cliente'}
        </SubmitButton>
      </ActionForm>
    </div>
  )
}

function BranchFields({
  clients,
  businessHours,
  defaults,
}: {
  clients: Client[]
  businessHours: BusinessHoursOption[]
  defaults?: Branch
}) {
  const uid = defaults ? `b-${defaults.id}` : 'b-new'
  return (
    <>
      <Field label="Cliente" htmlFor={`${uid}-client_id`} required>
        <select
          id={`${uid}-client_id`}
          name="client_id"
          required
          defaultValue={defaults?.client_id ?? ''}
          className={inputClass}
        >
          <option value="" disabled>
            Selecione…
          </option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.trade_name ?? c.legal_name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Nome da filial" htmlFor={`${uid}-name`} required>
        <input
          id={`${uid}-name`}
          name="name"
          required
          maxLength={200}
          defaultValue={defaults?.name ?? ''}
          className={inputClass}
          placeholder="Matriz São Paulo"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Código" htmlFor={`${uid}-code`}>
          <input
            id={`${uid}-code`}
            name="code"
            maxLength={30}
            defaultValue={defaults?.code ?? ''}
            className={inputClass}
            placeholder="MER-SP"
          />
        </Field>
        <Field label="CNPJ" htmlFor={`${uid}-cnpj`}>
          <input
            id={`${uid}-cnpj`}
            name="cnpj"
            maxLength={20}
            defaultValue={defaults?.cnpj ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Cidade" htmlFor={`${uid}-city`}>
          <input
            id={`${uid}-city`}
            name="city"
            maxLength={120}
            defaultValue={defaults?.city ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="UF" htmlFor={`${uid}-state`}>
          <input
            id={`${uid}-state`}
            name="state"
            maxLength={2}
            defaultValue={defaults?.state ?? ''}
            className={inputClass}
            placeholder="SP"
          />
        </Field>
      </div>

      <Field
        label="Fuso horário"
        htmlFor={`${uid}-timezone`}
        required
        hint="Base do cálculo de horário útil de SLA."
      >
        <select
          id={`${uid}-timezone`}
          name="timezone"
          required
          defaultValue={defaults?.timezone ?? 'America/Sao_Paulo'}
          className={inputClass}
        >
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Calendário de atendimento" htmlFor={`${uid}-business_hours_id`}>
        <select
          id={`${uid}-business_hours_id`}
          name="business_hours_id"
          defaultValue={defaults?.business_hours_id ?? ''}
          className={inputClass}
        >
          <option value="">Padrão do tenant</option>
          {businessHours.map((bh) => (
            <option key={bh.id} value={bh.id}>
              {bh.name}
              {bh.is_24x7 ? ' (24x7)' : ''}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Contato principal" htmlFor={`${uid}-contact_name`}>
        <input
          id={`${uid}-contact_name`}
          name="contact_name"
          maxLength={120}
          defaultValue={defaults?.contact_name ?? ''}
          className={inputClass}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="E-mail" htmlFor={`${uid}-contact_email`}>
          <input
            id={`${uid}-contact_email`}
            name="contact_email"
            type="email"
            maxLength={200}
            defaultValue={defaults?.contact_email ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Telefone" htmlFor={`${uid}-contact_phone`}>
          <input
            id={`${uid}-contact_phone`}
            name="contact_phone"
            maxLength={30}
            defaultValue={defaults?.contact_phone ?? ''}
            className={inputClass}
          />
        </Field>
      </div>
    </>
  )
}

export function NewBranchForm({
  clients,
  businessHours,
}: {
  clients: Client[]
  businessHours: BusinessHoursOption[]
}) {
  return (
    <ActionForm action={createBranch} className="flex flex-col gap-4">
      <BranchFields clients={clients} businessHours={businessHours} />
      <SubmitButton pendingLabel="Cadastrando…">Cadastrar filial</SubmitButton>
    </ActionForm>
  )
}

export function EditBranchForm({
  branch,
  clients,
  businessHours,
}: {
  branch: Branch
  clients: Client[]
  businessHours: BusinessHoursOption[]
}) {
  return (
    <div className="flex flex-col gap-4">
      <ActionForm action={updateBranch} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={branch.id} />
        <BranchFields clients={clients} businessHours={businessHours} defaults={branch} />
        <SubmitButton>Salvar alterações</SubmitButton>
      </ActionForm>

      <ActionForm action={setBranchActive} className="border-t border-[var(--color-border)] pt-4">
        <input type="hidden" name="id" value={branch.id} />
        <input type="hidden" name="is_active" value={branch.is_active ? 'false' : 'true'} />
        <p className="mb-2 text-xs text-[var(--color-ink-3)]">
          {branch.is_active
            ? 'Inativar não apaga a filial nem seus ativos: ela só sai dos seletores de novos cadastros.'
            : 'Reativar devolve a filial aos seletores de cadastro.'}
        </p>
        <SubmitButton variant={branch.is_active ? 'danger' : 'secondary'}>
          {branch.is_active ? 'Inativar filial' : 'Reativar filial'}
        </SubmitButton>
      </ActionForm>

      <p className="text-xs text-[var(--color-ink-3)]">
        Endereço, coordenada e geolocalização desta filial ficam em <strong>Mapas</strong>.
      </p>
    </div>
  )
}
