import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { formatCurrency, formatDate } from '@/lib/format'
import type { BankAccount, Client, CostCenter, Receivable } from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import { RECEIVABLE_STATUS } from '../titulos/labels'
import { EditReceivableForm, NewReceivableForm, SettlementForm } from '../titulos/forms'

/**
 * O título a receber na gaveta.
 *
 * Mesma troca das outras telas do grupo: sai o cartão "Lançar título a receber"
 * que ficava aberto numa coluna de 23rem, entram um botão no cabeçalho e esta
 * gaveta. A diferença é a BAIXA — recebimento parcial e desconto —, que aqui
 * ganha lugar próprio no alto, acima da ficha: quando o título está em aberto,
 * é isso que a pessoa veio fazer.
 *
 * Os quatro lookups do formulário continuam completos de propósito: um seletor
 * que perde a opção já gravada no título faria o campo voltar vazio ao salvar.
 */
export async function GavetaDeRecebivel({
  id,
  novo,
  fechar,
}: {
  id?: string
  novo?: boolean
  fechar: string
}) {
  const [podeCriar, podeEditar, podeBaixar, podeCancelar] = await Promise.all([
    allowed('financeiro.titulos_receber.criar'),
    allowed('financeiro.titulos_receber.editar'),
    allowed('financeiro.titulos_receber.baixar'),
    allowed('financeiro.titulos_receber.cancelar'),
  ])

  const supabase = await createClient()
  const [{ data: clientes }, { data: contratos }, { data: centros }] = await Promise.all([
    supabase
      .from('clients')
      .select('id, legal_name, trade_name, cnpj, contract_ref, status')
      .is('deleted_at', null)
      .order('legal_name')
      .returns<Client[]>(),
    supabase.from('sla_contracts').select('id, name').eq('is_active', true).order('name'),
    supabase
      .from('cost_centers')
      .select('id, parent_id, code, name, description, branch_id, is_active')
      .eq('is_active', true)
      .order('code')
      .returns<CostCenter[]>(),
  ])

  const lookups = {
    clients: clientes ?? [],
    contracts: contratos ?? [],
    costCenters: centros ?? [],
  }

  if (novo) {
    if (!podeCriar) return null
    return (
      <Gaveta fechar={fechar} rotulo="Lançar título a receber">
        <CabecalhoDaGaveta
          titulo="Lançar título a receber"
          linha="Novo título a receber"
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <NewReceivableForm lookups={lookups} />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!id) return null

  const { data: titulo } = await supabase
    .from('receivables')
    .select(
      'id, description, document_ref, client_id, sla_contract_id, cost_center_id, branch_id, amount, issued_on, due_on, installment_number, installment_total, status, received_on, received_amount, bank_account_id, notes',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle<Receivable>()

  if (!titulo) return null

  const { data: contas } = await supabase
    .from('bank_accounts')
    .select(
      'id, name, bank_name, bank_code, agency, account_number, account_type, holder_name, holder_document, opening_balance, credit_limit, status, notes',
    )
    .eq('status', 'active')
    .is('deleted_at', null)
    .order('name')
    .returns<BankAccount[]>()

  const st = RECEIVABLE_STATUS[titulo.status]
  const cliente = (clientes ?? []).find((c) => c.id === titulo.client_id)

  return (
    <Gaveta fechar={fechar} rotulo={titulo.description}>
      <CabecalhoDaGaveta
        titulo={titulo.description}
        linha={`${formatCurrency(titulo.amount)} · vence ${formatDate(titulo.due_on)}${
          cliente ? ` · ${cliente.trade_name ?? cliente.legal_name}` : ''
        }`}
        fechar={fechar}
        selo={<Badge tone={st.tone}>{st.label}</Badge>}
      />

      <CorpoDaGaveta>
        {podeBaixar && titulo.status === 'open' && (
          <section className="rounded-xl border border-[var(--color-border)] p-3">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Dar baixa</h3>
            <SettlementForm receivable={titulo} accounts={contas ?? []} />
          </section>
        )}

        {titulo.received_amount !== null && titulo.received_amount !== titulo.amount && (
          <p className="rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn-ink)]">
            Recebido {formatCurrency(titulo.received_amount)} de{' '}
            {formatCurrency(titulo.amount)} — a diferença aparece no indicador de desconto.
          </p>
        )}

        {podeEditar && (
          <EditReceivableForm receivable={titulo} lookups={lookups} podeCancelar={podeCancelar} />
        )}
      </CorpoDaGaveta>
    </Gaveta>
  )
}
