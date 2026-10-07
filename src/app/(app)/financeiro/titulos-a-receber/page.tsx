import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { escopoDeCliente, porClienteOuGeral } from '@/lib/data/escopo'
import { lerPagina, paginar } from '@/lib/data/paginacao'
import { requireScreen, allowed } from '@/lib/session'
import { formatCurrency, formatDate } from '@/lib/format'
import type { BankAccount, Client, CostCenter, Receivable } from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader, Pager, StatTile, Table, Td } from '@/components/ui'
import { EditPanel } from '@/components/edit-panel'
import { RECEIVABLE_STATUS, tomDoVencimento } from '../titulos/labels'
import {
  EditReceivableForm, NewReceivableForm, SettlementForm,
} from '../titulos/forms'

export const metadata: Metadata = { title: 'Títulos a receber' }

interface ResumoDeRecebiveis {
  client_id: string | null
  status: string
  titulos: number
  total: number
  vencidos: number
  total_vencido: number
  diferenca_recebida: number
}

export default async function TitulosAReceberPage({
  searchParams,
}: {
  searchParams: Promise<{ pagina?: string }>
}) {
  const params = await searchParams
  await requireScreen('financeiro.titulos_receber.ver')
  const [podeCriar, podeEditar, podeBaixar, podeCancelar] = await Promise.all([
    allowed('financeiro.titulos_receber.criar'),
    allowed('financeiro.titulos_receber.editar'),
    allowed('financeiro.titulos_receber.baixar'),
    allowed('financeiro.titulos_receber.cancelar'),
  ])

  const supabase = await createClient()
  const escopo = await escopoDeCliente()
  const pagina = lerPagina(params.pagina)
  const [
    { data: titulos, count },
    { data: contas },
    { data: clientes },
    { data: contratos },
    { data: centros },
    { data: resumo },
  ] = await Promise.all([
      /* Só a LISTA entra no escopo. Os quatro lookups abaixo alimentam o
         formulário e continuam completos de propósito: um seletor que perde a
         opção já gravada no título faria o campo voltar vazio ao salvar. */
      paginar(
        porClienteOuGeral(
          supabase.from('receivables')
            .select('id, description, document_ref, client_id, sla_contract_id, cost_center_id, branch_id, amount, issued_on, due_on, installment_number, installment_total, status, received_on, received_amount, bank_account_id, notes',
              { count: 'exact' })
            .is('deleted_at', null).order('due_on').order('id'),
          escopo,
        ),
        pagina,
      ).returns<Receivable[]>(),
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
      /* Indicadores da view criada na 0028, com `client_id` para acompanhar o
         foco por empresa. Sem ela, paginar transformaria "Em aberto: 312" em
         "Em aberto: 50" sem nenhum sinal de que o número mudou de significado. */
      porClienteOuGeral(
        supabase
          .from('vw_receivables_summary')
          .select('client_id, status, titulos, total, vencidos, total_vencido, diferenca_recebida'),
        escopo,
      ).returns<ResumoDeRecebiveis[]>(),
    ])

  const lista = titulos ?? []
  const lookups = {
    clients: clientes ?? [],
    contracts: contratos ?? [],
    costCenters: centros ?? [],
  }

  const agregado = resumo ?? []
  const soma = (campo: keyof ResumoDeRecebiveis, status?: string) =>
    agregado
      .filter((r) => status === undefined || r.status === status)
      .reduce((s, r) => s + Number(r[campo] ?? 0), 0)

  const qtdAbertos = soma('titulos', 'open')
  const totalAberto = soma('total', 'open')
  const qtdVencidos = soma('vencidos')
  const totalVencido = soma('total_vencido')
  const qtdRecebidos = soma('titulos', 'received')
  // Diferença entre combinado e recebido: é onde desconto e recebimento parcial
  // aparecem. Somar só o recebido esconderia a perda. A view calcula a mesma
  // conta em SQL (0028), inclusive a regra de que baixa sem valor informado
  // valeu integral.
  const diferenca = soma('diferenca_recebida')
  // O que de fato entrou: o combinado dos recebidos menos a diferença.
  const totalRecebido = soma('total', 'received') - diferenca

  return (
    <>
      <PageHeader
        title="Títulos a receber"
        description="Receita combinada e sua baixa. Sem fluxo de aprovação: aprovar o que se vai receber não protege ninguém — o controle aqui é a baixa."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Em aberto" value={qtdAbertos} hint={formatCurrency(totalAberto)} />
        <StatTile label="Vencidos" value={qtdVencidos}
          hint={formatCurrency(totalVencido)}
          tone={qtdVencidos > 0 ? 'crit' : 'ok'} />
        <StatTile label="Recebidos" value={qtdRecebidos}
          hint={formatCurrency(totalRecebido)}
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
            <>
            <Table head={['Vencimento', 'Descrição', 'Cliente', 'Valor', 'Situação', '']} label="Títulos a receber">
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
            <Pager
              pagina={pagina.numero}
              total={count ?? 0}
              tamanho={pagina.tamanho}
              base="/financeiro/titulos-a-receber"
              params={params}
            />
            </>
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
