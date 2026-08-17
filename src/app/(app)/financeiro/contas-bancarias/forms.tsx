'use client'

import type { BankAccount, BankAccountBalance, CostCenter } from '@/lib/types'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import {
  createBankAccount,
  createBankMovement,
  setBankAccountStatus,
  transferBetweenAccounts,
  updateBankAccount,
} from '../actions'

const TIPOS: { value: BankAccount['account_type']; label: string }[] = [
  { value: 'checking', label: 'Conta corrente' },
  { value: 'savings', label: 'Poupança' },
  { value: 'payment', label: 'Conta de pagamento' },
  { value: 'investment', label: 'Investimento' },
]

const SITUACOES: { value: BankAccount['status']; label: string }[] = [
  { value: 'active', label: 'Ativa' },
  { value: 'inactive', label: 'Inativa' },
  { value: 'blocked', label: 'Bloqueada' },
]

function AccountFields({ defaults }: { defaults?: BankAccount }) {
  const uid = defaults ? `ba-${defaults.id}` : 'ba-new'
  return (
    <>
      <Field
        label="Nome da conta"
        htmlFor={`${uid}-name`}
        required
        hint="Como a equipe chama esta conta: Operação, Folha, Investimento."
      >
        <input
          id={`${uid}-name`}
          name="name"
          required
          maxLength={80}
          defaultValue={defaults?.name ?? ''}
          className={inputClass}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Banco" htmlFor={`${uid}-bank_name`} required>
          <input
            id={`${uid}-bank_name`}
            name="bank_name"
            required
            maxLength={80}
            defaultValue={defaults?.bank_name ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Código do banco" htmlFor={`${uid}-bank_code`}>
          <input
            id={`${uid}-bank_code`}
            name="bank_code"
            maxLength={10}
            defaultValue={defaults?.bank_code ?? ''}
            className={inputClass}
            placeholder="001"
          />
        </Field>
        <Field label="Agência" htmlFor={`${uid}-agency`}>
          <input
            id={`${uid}-agency`}
            name="agency"
            maxLength={20}
            defaultValue={defaults?.agency ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Conta" htmlFor={`${uid}-account_number`}>
          <input
            id={`${uid}-account_number`}
            name="account_number"
            maxLength={30}
            defaultValue={defaults?.account_number ?? ''}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Tipo" htmlFor={`${uid}-account_type`} required>
          <select
            id={`${uid}-account_type`}
            name="account_type"
            required
            defaultValue={defaults?.account_type ?? 'checking'}
            className={inputClass}
          >
            {TIPOS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Situação" htmlFor={`${uid}-status`} required>
          <select
            id={`${uid}-status`}
            name="status"
            required
            defaultValue={defaults?.status ?? 'active'}
            className={inputClass}
          >
            {SITUACOES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Titular" htmlFor={`${uid}-holder_name`}>
          <input
            id={`${uid}-holder_name`}
            name="holder_name"
            maxLength={150}
            defaultValue={defaults?.holder_name ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="CNPJ/CPF do titular" htmlFor={`${uid}-holder_document`}>
          <input
            id={`${uid}-holder_document`}
            name="holder_document"
            maxLength={20}
            defaultValue={defaults?.holder_document ?? ''}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Saldo inicial (R$)"
          htmlFor={`${uid}-opening_balance`}
          hint="Ponto de partida. O saldo corrente é calculado a partir das movimentações."
        >
          <input
            id={`${uid}-opening_balance`}
            name="opening_balance"
            type="number"
            step="0.01"
            defaultValue={defaults?.opening_balance ?? 0}
            className={inputClass}
          />
        </Field>
        <Field label="Limite de crédito (R$)" htmlFor={`${uid}-credit_limit`}>
          <input
            id={`${uid}-credit_limit`}
            name="credit_limit"
            type="number"
            step="0.01"
            min="0"
            defaultValue={defaults?.credit_limit ?? 0}
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Observações" htmlFor={`${uid}-notes`}>
        <input
          id={`${uid}-notes`}
          name="notes"
          maxLength={300}
          defaultValue={defaults?.notes ?? ''}
          className={inputClass}
        />
      </Field>
    </>
  )
}

export function NewBankAccountForm() {
  return (
    <ActionForm action={createBankAccount} className="flex flex-col gap-4">
      <AccountFields />
      <SubmitButton pendingLabel="Cadastrando…">Cadastrar conta</SubmitButton>
    </ActionForm>
  )
}

export function EditBankAccountForm({ account }: { account: BankAccount }) {
  return (
    <div className="flex flex-col gap-4">
      <ActionForm action={updateBankAccount} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={account.id} />
        <AccountFields defaults={account} />
        <SubmitButton>Salvar alterações</SubmitButton>
      </ActionForm>

      <ActionForm action={setBankAccountStatus} className="border-t border-[var(--color-border)] pt-4">
        <input type="hidden" name="id" value={account.id} />
        <Field label="Mudar situação" htmlFor={`st-${account.id}`}>
          <select
            id={`st-${account.id}`}
            name="status"
            defaultValue={account.status}
            className={inputClass}
          >
            {SITUACOES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <p className="mb-2 mt-2 text-xs text-[var(--color-ink-3)]">
          Bloquear ou inativar não apaga movimentação nenhuma — o extrato e o saldo continuam.
        </p>
        <SubmitButton variant="secondary">Salvar situação</SubmitButton>
      </ActionForm>
    </div>
  )
}

export function MovementForm({
  accounts,
  costCenters,
}: {
  accounts: BankAccountBalance[]
  costCenters: CostCenter[]
}) {
  const hoje = new Date().toISOString().slice(0, 10)
  return (
    <ActionForm action={createBankMovement} className="flex flex-col gap-4">
      <Field label="Conta" htmlFor="mv-account" required>
        <select id="mv-account" name="bank_account_id" required defaultValue="" className={inputClass}>
          <option value="" disabled>
            Selecione…
          </option>
          {accounts.map((a) => (
            <option key={a.bank_account_id} value={a.bank_account_id}>
              {a.name} — {a.bank_name}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Sentido" htmlFor="mv-direction" required>
          <select id="mv-direction" name="direction" required defaultValue="out" className={inputClass}>
            <option value="in">Entrada</option>
            <option value="out">Saída</option>
          </select>
        </Field>
        <Field label="Valor (R$)" htmlFor="mv-amount" required>
          <input
            id="mv-amount"
            name="amount"
            type="number"
            step="0.01"
            min="0.01"
            required
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Data" htmlFor="mv-date" required>
        <input id="mv-date" name="moved_on" type="date" required defaultValue={hoje} className={inputClass} />
      </Field>

      <Field label="Descrição" htmlFor="mv-desc" required>
        <input id="mv-desc" name="description" required maxLength={200} className={inputClass} />
      </Field>

      <Field label="Centro de custo" htmlFor="mv-cc">
        <select id="mv-cc" name="cost_center_id" defaultValue="" className={inputClass}>
          <option value="">Não informado</option>
          {costCenters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} — {c.name}
            </option>
          ))}
        </select>
      </Field>

      <SubmitButton pendingLabel="Lançando…">Lançar movimentação</SubmitButton>
    </ActionForm>
  )
}

export function TransferForm({ accounts }: { accounts: BankAccountBalance[] }) {
  const hoje = new Date().toISOString().slice(0, 10)
  return (
    <ActionForm action={transferBetweenAccounts} className="flex flex-col gap-4">
      <Field label="Conta de origem" htmlFor="tr-from" required>
        <select id="tr-from" name="from_account_id" required defaultValue="" className={inputClass}>
          <option value="" disabled>
            Selecione…
          </option>
          {accounts.map((a) => (
            <option key={a.bank_account_id} value={a.bank_account_id}>
              {a.name} — {a.bank_name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Conta de destino" htmlFor="tr-to" required>
        <select id="tr-to" name="to_account_id" required defaultValue="" className={inputClass}>
          <option value="" disabled>
            Selecione…
          </option>
          {accounts.map((a) => (
            <option key={a.bank_account_id} value={a.bank_account_id}>
              {a.name} — {a.bank_name}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Valor (R$)" htmlFor="tr-amount" required>
          <input
            id="tr-amount"
            name="amount"
            type="number"
            step="0.01"
            min="0.01"
            required
            className={inputClass}
          />
        </Field>
        <Field label="Data" htmlFor="tr-date" required>
          <input id="tr-date" name="moved_on" type="date" required defaultValue={hoje} className={inputClass} />
        </Field>
      </div>

      <Field label="Descrição" htmlFor="tr-desc" required>
        <input id="tr-desc" name="description" required maxLength={200} className={inputClass} />
      </Field>

      <p className="text-xs text-[var(--color-ink-3)]">
        Gera duas movimentações ligadas: uma saída na origem e uma entrada no destino, de mesmo
        valor. O banco recusa transferência com uma só metade.
      </p>
      <SubmitButton pendingLabel="Transferindo…">Registrar transferência</SubmitButton>
    </ActionForm>
  )
}
