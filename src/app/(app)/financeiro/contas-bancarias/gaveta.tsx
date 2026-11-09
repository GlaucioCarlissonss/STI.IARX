import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { formatCurrency } from '@/lib/format'
import type { BankAccount, BankAccountBalance, CostCenter } from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import { EditBankAccountForm, MovementForm, NewBankAccountForm, TransferForm } from './forms'

/**
 * A conta bancária na gaveta — e as três ações que ocupavam coluna fixa.
 *
 * Eram três cartões empilhados à direita o tempo todo: "Nova conta", "Lançar
 * movimentação" e "Transferir entre contas". Nenhum deles é consulta: são três
 * ações que acontecem algumas vezes por semana, e juntas ficavam com 23rem da
 * tela — numa página cujo conteúdo principal é um EXTRATO, que quer largura.
 *
 * Cada modo confere a sua permissão aqui dentro, e não só no botão que leva
 * até ele: botão escondido não é controle de acesso.
 */
export async function GavetaDeConta({
  id,
  novo,
  movimentar,
  transferir,
  fechar,
}: {
  id?: string
  novo?: boolean
  movimentar?: boolean
  transferir?: boolean
  fechar: string
}) {
  const [podeEditar, podeCriar, podeMovimentar, podeTransferir] = await Promise.all([
    allowed('financeiro.contas_bancarias.editar'),
    allowed('financeiro.contas_bancarias.criar'),
    allowed('financeiro.contas_bancarias.movimentar'),
    allowed('financeiro.contas_bancarias.transferir'),
  ])

  const supabase = await createClient()

  if (novo) {
    if (!podeCriar) return null
    return (
      <Gaveta fechar={fechar} rotulo="Nova conta bancária">
        <CabecalhoDaGaveta titulo="Nova conta" linha="Cadastro de conta bancária" fechar={fechar} />
        <CorpoDaGaveta>
          <NewBankAccountForm />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (movimentar || transferir) {
    if (movimentar && !podeMovimentar) return null
    if (transferir && !podeTransferir) return null

    const [{ data: saldos }, { data: centros }] = await Promise.all([
      supabase
        .from('vw_bank_account_balances')
        .select(
          'bank_account_id, name, bank_name, account_type, status, opening_balance, credit_limit, total_in, total_out, current_balance',
        )
        .order('name')
        .returns<BankAccountBalance[]>(),
      supabase
        .from('cost_centers')
        .select('id, parent_id, code, name, description, branch_id, is_active')
        .eq('is_active', true)
        .order('code')
        .returns<CostCenter[]>(),
    ])

    const contas = saldos ?? []

    return (
      <Gaveta
        fechar={fechar}
        rotulo={movimentar ? 'Lançar movimentação' : 'Transferir entre contas'}
      >
        <CabecalhoDaGaveta
          titulo={movimentar ? 'Lançar movimentação' : 'Transferir entre contas'}
          linha={movimentar ? 'Entrada ou saída no extrato' : 'Saída de uma conta, entrada na outra'}
          fechar={fechar}
        />
        <CorpoDaGaveta>
          {movimentar ? (
            <MovementForm accounts={contas} costCenters={centros ?? []} />
          ) : (
            <TransferForm accounts={contas} />
          )}
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!id || !podeEditar) return null

  const { data: conta } = await supabase
    .from('bank_accounts')
    .select(
      'id, name, bank_name, bank_code, agency, account_number, account_type, holder_name, holder_document, opening_balance, credit_limit, status, notes',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle<BankAccount>()

  if (!conta) return null

  return (
    <Gaveta fechar={fechar} rotulo={conta.name}>
      <CabecalhoDaGaveta
        titulo={conta.name}
        linha={`${conta.bank_name}${conta.account_number ? ` · ${conta.agency ?? ''}/${conta.account_number}` : ''} · abertura ${formatCurrency(conta.opening_balance)}`}
        fechar={fechar}
        selo={
          conta.status === 'active' ? (
            <Badge tone="ok">Ativa</Badge>
          ) : conta.status === 'blocked' ? (
            <Badge tone="breach">Bloqueada</Badge>
          ) : (
            <Badge>Inativa</Badge>
          )
        }
      />
      <CorpoDaGaveta>
        <EditBankAccountForm account={conta} />
      </CorpoDaGaveta>
    </Gaveta>
  )
}
