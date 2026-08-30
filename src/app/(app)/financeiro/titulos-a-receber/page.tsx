import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { formatCurrency, formatDate } from '@/lib/format'
import type { BankAccount, Client, CostCenter, Receivable } from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { EditPanel } from '@/components/edit-panel'
import { RECEIVABLE_STATUS, tomDoVencimento } from '../titulos/labels'
import {
  EditReceivableForm, NewReceivableForm, SettlementForm,
} from '../titulos/forms'

export const metadata: Metadata = { title: 'Títulos a receber' }

export default async function TitulosAReceberPage() {
  await requireScreen('financeiro.titulos_receber.ver')
  const [podeCriar, podeEditar, podeBaixar, podeCancelar] = await Promise.all([
    allowed('financeiro.titulos_receber.criar'),
    allowed('financeiro.titulos_receber.editar'),
    allowed('financeiro.titulos_receber.baixar'),
    allowed('financeiro.titulos_receber.cancelar'),
  ])

  const supabase = await createClient()
  const [{ data: titulos }, { data: contas }, { data: clientes }, { data: contratos }, { data: centros }] =
    await Promise.all([
      supabase.from('receivables')
        .select('id, description, document_ref, client_id, sla_contract_id, cost_center_id, branch_id, amount, issued_on, due_on, installment_number, installment_total, status, received_on, received_amount, bank_account_id, notes')
        .is('deleted_at', null).order('due_on').returns<Receivable[]>(),
      supabase.from('bank_accounts')
        .select('id, name, bank_name, bank_code, agency, account_number, account_type, holder_name, holder_document, opening_balance, credit_limit, status, notes')
        .eq('status', 'active').is('deleted_at', null).order('name').returns<BankAccount[]>(),
      supabase.from('clients')
        .select('id, legal_name, trade_name, cnpj, contract_ref, status')
        .is('deleted_at', null).order('legal_name').returns<Client[]>(),
      supabase.from('sla_contracts').select('id, name').eq('is_active', true).order('name'),
      supabase.from('cost_centers')
        .select('id, parent_id, code, name, description, branch_id, is_active')
        .eq('is_active', true).order('code').returns<CostCenter[]>(),
    ])

  const lista = titulos ?? []
  const lookups = {
    clients: clientes ?? [],
    contracts: contratos ?? [],
    costCenters: centros ?? [],
  }

  const hoje = new Date().toISOString().slice(0, 10)
  const abertos = lista.filter((t) => t.status === 'open')
  const vencidos = abertos.filter((t) => t.due_on < hoje)
  const recebidos = lista.filter((t) => t.status === 'received')
  const totalAberto = abertos.reduce((s, t) => s + Number(t.amount), 0)
  // Diferença entre combinado e recebido: é onde desconto e recebimento parcial
  // aparecem. Somar só o recebido esconderia a perda.
  const diferenca = recebidos.reduce(
    (s, t) => s + (Number(t.amount) - Number(t.received_amount ?? t.amount)), 0)

  return (
    <>
      <PageHeader
        title="Títulos a receber"
        description="Receita combinada e sua baixa. Sem fluxo de aprovação: aprovar o que se vai receber não protege ninguém — o controle aqui é a baixa."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Em aberto" value={abertos.length} hint={formatCurrency(totalAberto)} />
        <StatTile label="Vencidos" value={vencidos.length}
          hint={formatCurrency(vencidos.reduce((s, t) => s + Number(t.amount), 0))}
          tone={vencidos.length > 0 ? 'crit' : 'ok'} />
        <StatTile label="Recebidos" value={recebidos.length}
          hint={formatCurrency(recebidos.reduce((s, t) => s + Number(t.received_amount ?? t.amount), 0))}
          tone="ok" />
        <StatTile label="Diferença de baixa" value={formatCurrency(diferenca)}
          hint="desconto e recebimento parcial" tone={diferenca > 0 ? 'warn' : 'neutral'} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div>
          {lista.length === 0 ? (
            <EmptyState title="Nenhum título a receber"
              description="Lance a primeira cobrança no formulário ao lado." />
          ) : (
            <Table head={['Vencimento', 'Descrição', 'Cliente', 'Valor', 'Situação', '']}>
              {lista.map((t) => {
                const st = RECEIVABLE_STATUS[t.status]
                const encerrado = t.status === 'received' || t.status === 'cancelled'
                const venc = tomDoVencimento(t.due_on, encerrado)
                const cli = (clientes ?? []).find((c) => c.id === t.client_id)
                const parcial =
                  t.received_amount !== null && Number(t.received_amount) < Number(t.amount)
                return (
                  <tr key={t.id}>
                    <Td className="tabular-nums">
                      {formatDate(t.due_on)}
                      <div className={`text-xs ${
                        venc.tone === 'breach' ? 'text-[var(--color-breach-ink)]'
                        : venc.tone === 'crit' ? 'text-[var(--color-crit-ink)]'
                        : venc.tone === 'warn' ? 'text-[var(--color-warn-ink)]'
                        : 'text-[var(--color-ink-3)]'}`}>{venc.texto}</div>
                    </Td>
                    <Td>
                      <div className="font-medium text-[var(--color-ink)]">{t.description}</div>
                      <div className="text-xs text-[var(--color-ink-3)]">
                        {t.document_ref ? `doc ${t.document_ref}` : 'sem documento'}
                        {t.installment_total > 1 &&
                          ` · parcela ${t.installment_number}/${t.installment_total}`}
                      </div>
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">
                      {cli ? (cli.trade_name ?? cli.legal_name) : '—'}
                    </Td>
                    <Td className="tabular-nums font-semibold">
                      {formatCurrency(t.amount)}
                      {parcial && (
                        <div className="text-xs font-normal text-[var(--color-warn-ink)]">
                          recebido {formatCurrency(t.received_amount!)}
                        </div>
                      )}
                    </Td>
                    <Td><Badge tone={st.tone}>{st.label}</Badge></Td>
                    <Td>
                      <div className="flex flex-col gap-2">
                        {podeBaixar && t.status === 'open' && (
                          <EditPanel label="Dar baixa" title={`Recebimento de ${t.description}`}>
                            <SettlementForm receivable={t} accounts={contas ?? []} />
                          </EditPanel>
                        )}
                        {podeEditar && (
                          <EditPanel label="Detalhes" title={t.description}>
                            <EditReceivableForm receivable={t} lookups={lookups}
                              podeCancelar={podeCancelar} />
                          </EditPanel>
                        )}
                      </div>
                    </Td>
                  </tr>
                )
              })}
            </Table>
          )}
        </div>

        {podeCriar && (
          <Card title="Lançar título a receber">
            <NewReceivableForm lookups={lookups} />
          </Card>
        )}
      </div>
    </>
  )
}
