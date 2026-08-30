'use client'

import type {
  ApprovalRule,
  BankAccount,
  Client,
  CostCenter,
  ExpenseCategory,
  Payable,
  Receivable,
} from '@/lib/types'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { ATTACHMENT_KINDS } from './labels'
import {
  createApprovalRule,
  createExpenseCategory,
  createPayable,
  createReceivable,
  decidePayable,
  deleteApprovalRule,
  payPayable,
  setApprovalRequired,
  setExpenseCategoryActive,
  setPayableStatus,
  setReceivableStatus,
  settleReceivable,
  updatePayable,
  updateReceivable,
} from './actions'

const hoje = () => new Date().toISOString().slice(0, 10)
/** Vencimento sugerido: 30 dias. É o prazo mais comum e poupa digitação. */
const em30dias = () => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)

interface Lookups {
  suppliers: { id: string; name: string }[]
  categories: ExpenseCategory[]
  costCenters: CostCenter[]
  branches: { id: string; name: string }[]
}

function PayableFields({ defaults, lookups }: { defaults?: Payable; lookups: Lookups }) {
  const uid = defaults ? `tp-${defaults.id}` : 'tp-novo'
  return (
    <>
      <Field label="Descrição" htmlFor={`${uid}-description`} required
        hint="O que foi comprado ou contratado. É por aqui que se procura o título depois.">
        <input id={`${uid}-description`} name="description" required maxLength={200}
          defaultValue={defaults?.description ?? ''} className={inputClass} />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Valor (R$)" htmlFor={`${uid}-amount`} required>
          <input id={`${uid}-amount`} name="amount" type="number" step="0.01" min="0.01" required
            defaultValue={defaults?.amount ?? ''} className={inputClass} />
        </Field>
        <Field label="Nº do documento" htmlFor={`${uid}-document_ref`}
          hint="Nota fiscal, boleto ou contrato.">
          <input id={`${uid}-document_ref`} name="document_ref" maxLength={60}
            defaultValue={defaults?.document_ref ?? ''} className={inputClass} />
        </Field>
        <Field label="Emissão" htmlFor={`${uid}-issued_on`} required>
          <input id={`${uid}-issued_on`} name="issued_on" type="date" required
            defaultValue={defaults?.issued_on ?? hoje()} className={inputClass} />
        </Field>
        <Field label="Vencimento" htmlFor={`${uid}-due_on`} required>
          <input id={`${uid}-due_on`} name="due_on" type="date" required
            defaultValue={defaults?.due_on ?? em30dias()} className={inputClass} />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Categoria da despesa" htmlFor={`${uid}-expense_category_id`}
          hint="O QUE foi gasto.">
          <select id={`${uid}-expense_category_id`} name="expense_category_id"
            defaultValue={defaults?.expense_category_id ?? ''} className={inputClass}>
            <option value="">Não classificada</option>
            {lookups.categories.map((c) => (
              <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Centro de custo" htmlFor={`${uid}-cost_center_id`}
          hint="QUEM consumiu. Dimensão diferente da categoria.">
          <select id={`${uid}-cost_center_id`} name="cost_center_id"
            defaultValue={defaults?.cost_center_id ?? ''} className={inputClass}>
            <option value="">Não informado</option>
            {lookups.costCenters.map((c) => (
              <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Fornecedor" htmlFor={`${uid}-supplier_id`}>
          <select id={`${uid}-supplier_id`} name="supplier_id"
            defaultValue={defaults?.supplier_id ?? ''} className={inputClass}>
            <option value="">Não informado</option>
            {lookups.suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Filial" htmlFor={`${uid}-branch_id`}>
          <select id={`${uid}-branch_id`} name="branch_id"
            defaultValue={defaults?.branch_id ?? ''} className={inputClass}>
            <option value="">Todas / não informado</option>
            {lookups.branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Observações" htmlFor={`${uid}-notes`}>
        <input id={`${uid}-notes`} name="notes" maxLength={300}
          defaultValue={defaults?.notes ?? ''} className={inputClass} />
      </Field>
    </>
  )
}

export function NewPayableForm({ lookups }: { lookups: Lookups }) {
  return (
    <ActionForm action={createPayable} className="flex flex-col gap-4">
      <PayableFields lookups={lookups} />

      <div className="grid gap-3 border-t border-[var(--color-border)] pt-4 sm:grid-cols-2">
        <Field label="Parcelas" htmlFor="tp-parcelas"
          hint="1 = à vista. O servidor divide o valor e distribui a sobra do centavo na primeira.">
          <input id="tp-parcelas" name="parcelas" type="number" min="1" max="60"
            defaultValue={1} className={inputClass} />
        </Field>
        <Field label="Intervalo (dias)" htmlFor="tp-intervalo"
          hint="Dias entre uma parcela e a seguinte.">
          <input id="tp-intervalo" name="intervalo_dias" type="number" min="1" max="365"
            defaultValue={30} className={inputClass} />
        </Field>
      </div>

      <SubmitButton pendingLabel="Lançando…">Lançar despesa</SubmitButton>
    </ActionForm>
  )
}

export function EditPayableForm({
  payable,
  lookups,
  podeCancelar,
}: {
  payable: Payable
  lookups: Lookups
  podeCancelar: boolean
}) {
  const encerrado = payable.status === 'paid' || payable.status === 'cancelled'
  return (
    <div className="flex flex-col gap-4">
      <ActionForm action={updatePayable} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={payable.id} />
        <PayableFields defaults={payable} lookups={lookups} />
        {payable.status === 'paid' && (
          <p className="text-xs text-[var(--color-warn-ink)]">
            Título pago: valor, vencimento e fornecedor não podem mais ser alterados — mudá-los
            descolaria o título da movimentação bancária que o pagou.
          </p>
        )}
        <SubmitButton>Salvar alterações</SubmitButton>
      </ActionForm>

      {podeCancelar && !encerrado && (
        <ActionForm action={setPayableStatus} className="border-t border-[var(--color-border)] pt-4">
          <input type="hidden" name="id" value={payable.id} />
          <input type="hidden" name="status" value="cancelled" />
          <p className="mb-2 text-xs text-[var(--color-ink-3)]">
            Cancelar não apaga o título: ele sai dos totais e continua no histórico.
          </p>
          <SubmitButton variant="danger">Cancelar título</SubmitButton>
        </ActionForm>
      )}
    </div>
  )
}

/** Aprovar ou reprovar. A reprovação exige motivo — o schema cobra. */
export function DecisionForm({ payable, nivel }: { payable: Payable; nivel: number }) {
  return (
    <ActionForm action={decidePayable} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={payable.id} />
      <input type="hidden" name="level" value={nivel} />
      <Field label="Observação" htmlFor={`ap-${payable.id}-note`}
        hint="Obrigatória ao reprovar: sem o motivo, quem recebe o título de volta não sabe o que corrigir.">
        <input id={`ap-${payable.id}-note`} name="note" maxLength={300} className={inputClass} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <button type="submit" name="decision" value="approved"
          className="inline-flex items-center rounded-lg bg-[var(--color-ok-ink)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
          Aprovar
        </button>
        <button type="submit" name="decision" value="rejected"
          className="inline-flex items-center rounded-lg border border-[var(--color-breach-ink)] px-4 py-2 text-sm font-semibold text-[var(--color-breach-ink)] hover:bg-[var(--color-breach-soft)]">
          Reprovar
        </button>
      </div>
    </ActionForm>
  )
}

export function PaymentForm({
  payable,
  accounts,
}: {
  payable: Payable
  accounts: BankAccount[]
}) {
  return (
    <ActionForm action={payPayable} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={payable.id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Conta de saída" htmlFor={`pg-${payable.id}-conta`} required>
          <select id={`pg-${payable.id}-conta`} name="bank_account_id" required defaultValue=""
            className={inputClass}>
            <option value="" disabled>Selecione…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name} — {a.bank_name}</option>
            ))}
          </select>
        </Field>
        <Field label="Data do pagamento" htmlFor={`pg-${payable.id}-data`} required>
          <input id={`pg-${payable.id}-data`} name="paid_on" type="date" required
            defaultValue={hoje()} className={inputClass} />
        </Field>
      </div>
      <p className="text-xs text-[var(--color-ink-3)]">
        A baixa gera a saída na conta escolhida, com o valor do título.
      </p>
      <SubmitButton pendingLabel="Registrando…">Registrar pagamento</SubmitButton>
    </ActionForm>
  )
}

/* ---------------------------------------------------------------- a receber */

interface ReceivableLookups {
  clients: Client[]
  contracts: { id: string; name: string }[]
  costCenters: CostCenter[]
}

function ReceivableFields({
  defaults,
  lookups,
}: {
  defaults?: Receivable
  lookups: ReceivableLookups
}) {
  const uid = defaults ? `tr-${defaults.id}` : 'tr-novo'
  return (
    <>
      <Field label="Descrição" htmlFor={`${uid}-description`} required>
        <input id={`${uid}-description`} name="description" required maxLength={200}
          defaultValue={defaults?.description ?? ''} className={inputClass} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Valor (R$)" htmlFor={`${uid}-amount`} required>
          <input id={`${uid}-amount`} name="amount" type="number" step="0.01" min="0.01" required
            defaultValue={defaults?.amount ?? ''} className={inputClass} />
        </Field>
        <Field label="Nº do documento" htmlFor={`${uid}-document_ref`}>
          <input id={`${uid}-document_ref`} name="document_ref" maxLength={60}
            defaultValue={defaults?.document_ref ?? ''} className={inputClass} />
        </Field>
        <Field label="Emissão" htmlFor={`${uid}-issued_on`} required>
          <input id={`${uid}-issued_on`} name="issued_on" type="date" required
            defaultValue={defaults?.issued_on ?? hoje()} className={inputClass} />
        </Field>
        <Field label="Vencimento" htmlFor={`${uid}-due_on`} required>
          <input id={`${uid}-due_on`} name="due_on" type="date" required
            defaultValue={defaults?.due_on ?? em30dias()} className={inputClass} />
        </Field>
        <Field label="Cliente" htmlFor={`${uid}-client_id`}>
          <select id={`${uid}-client_id`} name="client_id"
            defaultValue={defaults?.client_id ?? ''} className={inputClass}>
            <option value="">Não informado</option>
            {lookups.clients.map((c) => (
              <option key={c.id} value={c.id}>{c.trade_name ?? c.legal_name}</option>
            ))}
          </select>
        </Field>
        <Field label="Contrato de SLA" htmlFor={`${uid}-sla_contract_id`}
          hint="Liga a receita ao contrato que a originou.">
          <select id={`${uid}-sla_contract_id`} name="sla_contract_id"
            defaultValue={defaults?.sla_contract_id ?? ''} className={inputClass}>
            <option value="">Não informado</option>
            {lookups.contracts.map((k) => (
              <option key={k.id} value={k.id}>{k.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Centro de custo" htmlFor={`${uid}-cost_center_id`}>
        <select id={`${uid}-cost_center_id`} name="cost_center_id"
          defaultValue={defaults?.cost_center_id ?? ''} className={inputClass}>
          <option value="">Não informado</option>
          {lookups.costCenters.map((c) => (
            <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
          ))}
        </select>
      </Field>
      <Field label="Observações" htmlFor={`${uid}-notes`}>
        <input id={`${uid}-notes`} name="notes" maxLength={300}
          defaultValue={defaults?.notes ?? ''} className={inputClass} />
      </Field>
    </>
  )
}

export function NewReceivableForm({ lookups }: { lookups: ReceivableLookups }) {
  return (
    <ActionForm action={createReceivable} className="flex flex-col gap-4">
      <ReceivableFields lookups={lookups} />
      <Field label="Parcelas" htmlFor="tr-parcelas"
        hint="Mais de uma gera um título por mês, cada um com baixa própria.">
        <input id="tr-parcelas" name="parcelas" type="number" min="1" max="60"
          defaultValue={1} className={inputClass} />
      </Field>
      <SubmitButton pendingLabel="Lançando…">Lançar título</SubmitButton>
    </ActionForm>
  )
}

export function EditReceivableForm({
  receivable,
  lookups,
  podeCancelar,
}: {
  receivable: Receivable
  lookups: ReceivableLookups
  podeCancelar: boolean
}) {
  const encerrado = receivable.status === 'received' || receivable.status === 'cancelled'
  return (
    <div className="flex flex-col gap-4">
      <ActionForm action={updateReceivable} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={receivable.id} />
        <ReceivableFields defaults={receivable} lookups={lookups} />
        <SubmitButton>Salvar alterações</SubmitButton>
      </ActionForm>
      {podeCancelar && !encerrado && (
        <ActionForm action={setReceivableStatus} className="border-t border-[var(--color-border)] pt-4">
          <input type="hidden" name="id" value={receivable.id} />
          <input type="hidden" name="status" value="cancelled" />
          <SubmitButton variant="danger">Cancelar título</SubmitButton>
        </ActionForm>
      )}
    </div>
  )
}

export function SettlementForm({
  receivable,
  accounts,
}: {
  receivable: Receivable
  accounts: BankAccount[]
}) {
  return (
    <ActionForm action={settleReceivable} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={receivable.id} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Conta que recebeu" htmlFor={`bx-${receivable.id}-conta`} required>
          <select id={`bx-${receivable.id}-conta`} name="bank_account_id" required defaultValue=""
            className={inputClass}>
            <option value="" disabled>Selecione…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Data" htmlFor={`bx-${receivable.id}-data`} required>
          <input id={`bx-${receivable.id}-data`} name="received_on" type="date" required
            defaultValue={hoje()} className={inputClass} />
        </Field>
        <Field label="Valor recebido" htmlFor={`bx-${receivable.id}-valor`}
          hint="Vazio = valor do título.">
          <input id={`bx-${receivable.id}-valor`} name="received_amount" type="number"
            step="0.01" min="0.01" placeholder={String(receivable.amount)} className={inputClass} />
        </Field>
      </div>
      <p className="text-xs text-[var(--color-ink-3)]">
        Recebeu menos? Informe o valor real. O valor do título é preservado, e a diferença fica
        visível na conciliação em vez de desaparecer.
      </p>
      <SubmitButton pendingLabel="Registrando…">Registrar recebimento</SubmitButton>
    </ActionForm>
  )
}

/* ------------------------------------------------------------- configuração */

export function ApprovalToggleForm({
  ligado,
  temFaixa,
}: {
  ligado: boolean
  temFaixa: boolean
}) {
  return (
    <ActionForm action={setApprovalRequired} className="flex flex-col gap-2">
      <input type="hidden" name="required" value={ligado ? 'false' : 'true'} />
      <p className="text-sm text-[var(--color-ink-2)]">
        {ligado
          ? 'Aprovação EXIGIDA: título novo nasce aguardando aprovação.'
          : 'Aprovação DESLIGADA: título novo nasce já aprovado.'}
      </p>
      {!ligado && !temFaixa && (
        <p className="text-xs text-[var(--color-warn-ink)]">
          Cadastre uma faixa de alçada antes de ligar — sem faixa, todo título novo seria recusado.
        </p>
      )}
      <SubmitButton variant="secondary">
        {ligado ? 'Desligar aprovação' : 'Exigir aprovação'}
      </SubmitButton>
    </ActionForm>
  )
}

export function NewApprovalRuleForm({
  costCenters,
  branches,
  profiles,
}: {
  costCenters: CostCenter[]
  branches: { id: string; name: string }[]
  profiles: { id: string; name: string }[]
}) {
  return (
    <ActionForm action={createApprovalRule} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nível" htmlFor="ar-level" required hint="1 aprova primeiro, 2 depois.">
          <input id="ar-level" name="level" type="number" min="1" max="9" required
            defaultValue={1} className={inputClass} />
        </Field>
        <Field label="Nome do nível" htmlFor="ar-level_name" required
          hint="Como a sua empresa chama: N1, Coordenação, Diretoria.">
          <input id="ar-level_name" name="level_name" required maxLength={60} className={inputClass} />
        </Field>
        <Field label="Valor mínimo (R$)" htmlFor="ar-min" hint="Vazio = zero.">
          <input id="ar-min" name="min_amount" type="number" step="0.01" min="0"
            className={inputClass} />
        </Field>
        <Field label="Valor máximo (R$)" htmlFor="ar-max" hint="Vazio = sem teto.">
          <input id="ar-max" name="max_amount" type="number" step="0.01" min="0.01"
            className={inputClass} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Só neste centro de custo" htmlFor="ar-cc">
          <select id="ar-cc" name="cost_center_id" defaultValue="" className={inputClass}>
            <option value="">Qualquer</option>
            {costCenters.map((c) => (
              <option key={c.id} value={c.id}>{c.code}</option>
            ))}
          </select>
        </Field>
        <Field label="Só nesta filial" htmlFor="ar-branch">
          <select id="ar-branch" name="branch_id" defaultValue="" className={inputClass}>
            <option value="">Qualquer</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Quem aprova (perfil)" htmlFor="ar-profile">
          <select id="ar-profile" name="required_profile_id" defaultValue="" className={inputClass}>
            <option value="">Qualquer aprovador</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <SubmitButton variant="secondary">Cadastrar faixa</SubmitButton>
    </ActionForm>
  )
}

export function DeleteApprovalRuleForm({ rule }: { rule: ApprovalRule }) {
  return (
    <ActionForm action={deleteApprovalRule}>
      <input type="hidden" name="id" value={rule.id} />
      <SubmitButton variant="secondary" pendingLabel="…">Remover</SubmitButton>
    </ActionForm>
  )
}

export function NewExpenseCategoryForm() {
  return (
    <ActionForm action={createExpenseCategory} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Código" htmlFor="ec-code" required>
          <input id="ec-code" name="code" required maxLength={30} placeholder="SOFTWARE"
            className={inputClass} />
        </Field>
        <Field label="Nome" htmlFor="ec-name" required>
          <input id="ec-name" name="name" required maxLength={120} placeholder="Licenças de software"
            className={inputClass} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-[var(--color-ink-2)]">
        <input type="checkbox" name="requires_supplier" />
        Exige fornecedor
      </label>
      <SubmitButton variant="secondary">Cadastrar categoria</SubmitButton>
    </ActionForm>
  )
}

export function ToggleExpenseCategoryForm({ category }: { category: ExpenseCategory }) {
  return (
    <ActionForm action={setExpenseCategoryActive}>
      <input type="hidden" name="id" value={category.id} />
      <input type="hidden" name="is_active" value={category.is_active ? 'false' : 'true'} />
      <SubmitButton variant="secondary" pendingLabel="…">
        {category.is_active ? 'Inativar' : 'Reativar'}
      </SubmitButton>
    </ActionForm>
  )
}

export { ATTACHMENT_KINDS }
