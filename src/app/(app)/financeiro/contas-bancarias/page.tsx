import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { formatCurrency, formatDate } from '@/lib/format'
import type { BankAccount, BankAccountBalance, BankMovement, CostCenter } from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { EditPanel } from '@/components/edit-panel'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { toggleMovementReconciled } from '../actions'
import {
  EditBankAccountForm,
  MovementForm,
  NewBankAccountForm,
  TransferForm,
} from './forms'

export const metadata: Metadata = { title: 'Contas bancárias' }

const TIPO_LABEL: Record<BankAccount['account_type'], string> = {
  checking: 'Corrente',
  savings: 'Poupança',
  payment: 'Pagamento',
  investment: 'Investimento',
}

const SITUACAO: Record<BankAccount['status'], { label: string; tone: 'ok' | 'neutral' | 'breach' }> = {
  active: { label: 'Ativa', tone: 'ok' },
  inactive: { label: 'Inativa', tone: 'neutral' },
  blocked: { label: 'Bloqueada', tone: 'breach' },
}

export default async function ContasBancariasPage() {
  await requireScreen('financeiro.contas_bancarias.ver')
  const [podeEditar, podeCriar, podeMovimentar, podeTransferir] = await Promise.all([
    allowed('financeiro.contas_bancarias.editar'),
    allowed('financeiro.contas_bancarias.criar'),
    allowed('financeiro.contas_bancarias.movimentar'),
    allowed('financeiro.contas_bancarias.transferir'),
  ])

  const supabase = await createClient()
  const [{ data: balances }, { data: accounts }, { data: movements }, { data: costCenters }] =
    await Promise.all([
      supabase
        .from('vw_bank_account_balances')
        .select(
          'bank_account_id, name, bank_name, account_type, status, opening_balance, credit_limit, total_in, total_out, current_balance, unreconciled_count, last_movement_on',
        )
        .order('name')
        .returns<BankAccountBalance[]>(),
      supabase
        .from('bank_accounts')
        .select(
          'id, name, bank_code, bank_name, agency, account_number, account_type, holder_name, holder_document, opening_balance, credit_limit, status, notes',
        )
        .is('deleted_at', null)
        .order('name')
        .returns<BankAccount[]>(),
      supabase
        .from('bank_account_movements')
        .select(
          'id, bank_account_id, direction, amount, moved_on, description, cost_center_id, transfer_group, reconciled_at',
        )
        .order('moved_on', { ascending: false })
        .limit(60)
        .returns<BankMovement[]>(),
      supabase
        .from('cost_centers')
        .select('id, parent_id, code, name, description, branch_id, is_active')
        .eq('is_active', true)
        .order('code')
        .returns<CostCenter[]>(),
    ])

  const saldos = balances ?? []
  const contas = accounts ?? []
  const contaPorId = new Map(contas.map((a) => [a.id, a]))
  const centroPorId = new Map((costCenters ?? []).map((c) => [c.id, c]))

  const ativas = saldos.filter((s) => s.status === 'active')
  const saldoTotal = ativas.reduce((soma, s) => soma + Number(s.current_balance), 0)
  const naoConciliadas = saldos.reduce((soma, s) => soma + Number(s.unreconciled_count), 0)
  // Conta no vermelho além do limite é o alerta que precisa aparecer antes do
  // extrato, não depois de alguém somar as colunas na mão.
  const estouradas = saldos.filter((s) => Number(s.current_balance) < -Number(s.credit_limit))

  return (
    <>
      <PageHeader
        title="Contas bancárias"
        description="Saldo, extrato e conciliação. O saldo é derivado das movimentações — nunca gravado — para não divergir do extrato no primeiro arredondamento."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Contas ativas" value={ativas.length} />
        <StatTile
          label="Saldo consolidado"
          value={formatCurrency(saldoTotal)}
          hint="soma das contas ativas"
          tone={saldoTotal < 0 ? 'breach' : 'ok'}
        />
        <StatTile
          label="Não conciliadas"
          value={naoConciliadas}
          hint="movimentações sem baixa no extrato"
          tone={naoConciliadas > 0 ? 'warn' : 'neutral'}
        />
        <StatTile
          label="Acima do limite"
          value={estouradas.length}
          hint="saldo abaixo do limite de crédito"
          tone={estouradas.length > 0 ? 'crit' : 'neutral'}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="flex flex-col gap-6">
          {saldos.length === 0 ? (
            <EmptyState
              title="Nenhuma conta bancária cadastrada"
              description="Sem conta cadastrada não há como registrar de onde o dinheiro sai nem para onde entra."
            />
          ) : (
            <Table
              head={['Conta', 'Tipo', 'Saldo inicial', 'Entradas', 'Saídas', 'Saldo atual', 'Situação', '']}
            >
              {saldos.map((s) => {
                const conta = contaPorId.get(s.bank_account_id)
                const estourou = Number(s.current_balance) < -Number(s.credit_limit)
                return (
                  <tr key={s.bank_account_id}>
                    <Td>
                      <div className="font-medium text-[var(--color-ink)]">{s.name}</div>
                      <div className="text-xs text-[var(--color-ink-3)]">
                        {s.bank_name}
                        {conta?.account_number ? ` · ${conta.agency ?? ''}/${conta.account_number}` : ''}
                      </div>
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">{TIPO_LABEL[s.account_type]}</Td>
                    <Td className="tabular-nums">{formatCurrency(s.opening_balance)}</Td>
                    <Td className="tabular-nums text-[var(--color-ok-ink)]">
                      {formatCurrency(s.total_in)}
                    </Td>
                    <Td className="tabular-nums text-[var(--color-breach-ink)]">
                      {formatCurrency(s.total_out)}
                    </Td>
                    <Td className="tabular-nums font-semibold">
                      {formatCurrency(s.current_balance)}
                      {estourou && (
                        <span className="ml-1 text-xs font-normal text-[var(--color-breach-ink)]">
                          acima do limite
                        </span>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={SITUACAO[s.status].tone}>{SITUACAO[s.status].label}</Badge>
                    </Td>
                    <Td>
                      {podeEditar && conta && (
                        <EditPanel title={`Editar ${conta.name}`}>
                          <EditBankAccountForm account={conta} />
                        </EditPanel>
                      )}
                    </Td>
                  </tr>
                )
              })}
            </Table>
          )}

          {movements && movements.length > 0 && (
            <section>
              <h2 className="mb-3 text-lg font-semibold text-[var(--color-ink)]">
                Extrato consolidado
              </h2>
              <p className="mb-2 text-sm text-[var(--color-ink-2)]">
                Últimas 60 movimentações. Transferências aparecem duas vezes — uma saída e uma
                entrada — porque são o mesmo fato em duas contas.
              </p>
              <Table head={['Data', 'Conta', 'Descrição', 'Centro de custo', 'Valor', 'Conciliação']}>
                {movements.map((m) => (
                  <tr key={m.id}>
                    <Td className="tabular-nums text-[var(--color-ink-2)]">{formatDate(m.moved_on)}</Td>
                    <Td className="text-[var(--color-ink-2)]">
                      {contaPorId.get(m.bank_account_id)?.name ?? '—'}
                    </Td>
                    <Td>
                      {m.description}
                      {m.transfer_group && (
                        <Badge tone="info">transferência</Badge>
                      )}
                    </Td>
                    <Td className="text-[var(--color-ink-3)]">
                      {m.cost_center_id ? (centroPorId.get(m.cost_center_id)?.code ?? '—') : '—'}
                    </Td>
                    <Td
                      className={`tabular-nums font-medium ${
                        m.direction === 'in'
                          ? 'text-[var(--color-ok-ink)]'
                          : 'text-[var(--color-breach-ink)]'
                      }`}
                    >
                      {m.direction === 'in' ? '+' : '−'} {formatCurrency(m.amount)}
                    </Td>
                    <Td>
                      {podeMovimentar ? (
                        <ActionForm action={toggleMovementReconciled}>
                          <input type="hidden" name="id" value={m.id} />
                          <input
                            type="hidden"
                            name="reconciled"
                            value={m.reconciled_at ? 'false' : 'true'}
                          />
                          <SubmitButton variant="secondary" pendingLabel="…">
                            {m.reconciled_at ? 'Desfazer' : 'Conciliar'}
                          </SubmitButton>
                        </ActionForm>
                      ) : m.reconciled_at ? (
                        <Badge tone="ok">Conciliada</Badge>
                      ) : (
                        <Badge tone="warn">Pendente</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            </section>
          )}
        </div>

        <div className="flex flex-col gap-6">
          {podeCriar && (
            <Card title="Nova conta">
              <NewBankAccountForm />
            </Card>
          )}
          {podeMovimentar && saldos.length > 0 && (
            <Card title="Lançar movimentação">
              <MovementForm accounts={saldos} costCenters={costCenters ?? []} />
            </Card>
          )}
          {podeTransferir && saldos.length > 1 && (
            <Card title="Transferir entre contas">
              <TransferForm accounts={saldos} />
            </Card>
          )}
        </div>
      </div>
    </>
  )
}
