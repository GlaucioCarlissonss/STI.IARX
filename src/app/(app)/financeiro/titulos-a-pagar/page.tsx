import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { escopoDeCliente, porFilialOuGeral } from '@/lib/data/escopo'
import { lerPagina, paginar } from '@/lib/data/paginacao'
import { agruparPor } from '@/lib/data/agrupar'
import { requireScreen, allowed } from '@/lib/session'
import { formatCurrency, formatDate } from '@/lib/format'
import type {
  ApprovalRule, BankAccount, CostCenter, ExpenseCategory, Payable, Tenant,
} from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader, Pager, StatTile, Table, Td } from '@/components/ui'
import { EditPanel } from '@/components/edit-panel'
import { Attachments, type AttachmentRecord } from '@/components/attachments'
import { PAYABLE_STATUS, tomDoVencimento } from '../titulos/labels'
import {
  ApprovalToggleForm, DecisionForm, DeleteApprovalRuleForm, EditPayableForm,
  NewApprovalRuleForm, NewExpenseCategoryForm, NewPayableForm, PaymentForm,
  ToggleExpenseCategoryForm,
} from '../titulos/forms'

export const metadata: Metadata = { title: 'Títulos a pagar' }

interface ResumoDeTitulos {
  branch_id: string | null
  status: string
  titulos: number
  total: number
  vencidos: number
  total_vencido: number
}

export default async function TitulosAPagarPage({
  searchParams,
}: {
  searchParams: Promise<{ pagina?: string }>
}) {
  const params = await searchParams
  await requireScreen('financeiro.titulos_pagar.ver')
  const [podeCriar, podeEditar, podeAprovar, podePagar, podeCancelar, podeConfigurar] =
    await Promise.all([
      allowed('financeiro.titulos_pagar.criar'),
      allowed('financeiro.titulos_pagar.editar'),
      allowed('financeiro.titulos_pagar.aprovar'),
      allowed('financeiro.titulos_pagar.pagar'),
      allowed('financeiro.titulos_pagar.cancelar'),
      allowed('financeiro.titulos_pagar.configurar'),
    ])

  const supabase = await createClient()
  const escopo = await escopoDeCliente()
  const pagina = lerPagina(params.pagina)
  const [
    { data: titulos, count }, { data: contas }, { data: categorias }, { data: centros },
    { data: fornecedores }, { data: filiais }, { data: faixas }, { data: perfis },
    { data: tenant }, { data: resumo },
  ] = await Promise.all([
    /* Só a LISTA entra no escopo; os lookups seguem completos. Título sem filial
       é do tenant inteiro e aparece em qualquer foco — tirá-lo encolheria o
       total a pagar sem nenhum sinal na tela. */
    paginar(
      porFilialOuGeral(
        supabase.from('payables')
          .select('id, description, document_ref, supplier_id, supplier_contract_id, expense_category_id, cost_center_id, branch_id, amount, issued_on, due_on, parent_payable_id, installment_number, installment_total, status, approved_at, approved_by, rejection_reason, paid_on, bank_account_id, notes',
            { count: 'exact' })
          .is('deleted_at', null).order('due_on').order('id'),
        escopo,
      ),
      pagina,
    ).returns<Payable[]>(),
    supabase.from('bank_accounts')
      .select('id, name, bank_name, bank_code, agency, account_number, account_type, holder_name, holder_document, opening_balance, credit_limit, status, notes')
      .eq('status', 'active').is('deleted_at', null).order('name').returns<BankAccount[]>(),
    supabase.from('expense_categories')
      .select('id, code, name, requires_supplier, is_active').order('code')
      .returns<ExpenseCategory[]>(),
    supabase.from('cost_centers')
      .select('id, parent_id, code, name, description, branch_id, is_active')
      .eq('is_active', true).order('code').returns<CostCenter[]>(),
    supabase.from('suppliers').select('id, name').is('deleted_at', null).order('name'),
    supabase.from('branches').select('id, name').eq('is_active', true).order('name'),
    supabase.from('approval_rules')
      .select('id, level, level_name, min_amount, max_amount, cost_center_id, branch_id, required_profile_id, is_active')
      .order('level').returns<ApprovalRule[]>(),
    supabase.from('access_profiles').select('id, name').eq('is_active', true).order('name'),
    supabase.from('tenants').select('id, name, payable_approval_required').maybeSingle<
      Tenant & { payable_approval_required: boolean }>(),
    /* Indicadores da VIEW (migração 0028). Ela existia desde a 0020 e nunca
       tinha tido leitor — a tela calculava tudo a partir da lista completa, que
       é exatamente o que a paginação deixou de trazer. A 0028 lhe acrescentou
       `branch_id`, sem o qual o número do topo contaria o tenant inteiro
       enquanto a lista mostra uma empresa só. */
    porFilialOuGeral(
      supabase
        .from('vw_payables_summary')
        .select('branch_id, status, titulos, total, vencidos, total_vencido'),
      escopo,
    ).returns<ResumoDeTitulos[]>(),
  ])

  /* Anexos só dos títulos desta página: antes vinham os de todos os títulos, de
     todos os meses, para gavetas que quase ninguém abre. */
  const idsDaPagina = (titulos ?? []).map((t) => t.id)
  const { data: anexos } =
    idsDaPagina.length > 0
      ? await supabase
          .from('payable_attachments')
          .select('id, payable_id, storage_path, file_name, mime_type, size_bytes, created_at, kind')
          .in('payable_id', idsDaPagina)
          .order('created_at', { ascending: false })
          .returns<(AttachmentRecord & { payable_id: string })[]>()
      : { data: null }

  const lista = titulos ?? []
  const cats = categorias ?? []
  const lookups = {
    suppliers: fornecedores ?? [],
    categories: cats.filter((c) => c.is_active),
    costCenters: centros ?? [],
    branches: filiais ?? [],
  }
  const anexosPorTitulo = agruparPor(anexos, 'payable_id')

  /*
   * Os quatro indicadores somam a VIEW, que agrega o acervo inteiro. Com a
   * lista paginada, `lista.filter(...)` contaria só os 50 títulos visíveis — e
   * "Em aberto: 50" num mês com 300 lançamentos seria um número errado com cara
   * de fato.
   */
  const agregado = resumo ?? []
  const emAberto = agregado.filter((r) => !['paid', 'cancelled'].includes(r.status))
  const qtdAberto = emAberto.reduce((s, r) => s + Number(r.titulos ?? 0), 0)
  const totalAberto = emAberto.reduce((s, r) => s + Number(r.total ?? 0), 0)
  const qtdAguardando = agregado
    .filter((r) => r.status === 'pending_approval')
    .reduce((s, r) => s + Number(r.titulos ?? 0), 0)
  const qtdVencidos = agregado.reduce((s, r) => s + Number(r.vencidos ?? 0), 0)
  const totalVencido = agregado.reduce((s, r) => s + Number(r.total_vencido ?? 0), 0)
  const aprovacaoLigada = tenant?.payable_approval_required ?? false

  return (
    <>
      <PageHeader
        title="Títulos a pagar"
        description="Lançamento de despesa, aprovação e baixa. Cada parcela é um título próprio, com aprovação e pagamento independentes."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Em aberto" value={qtdAberto} hint={formatCurrency(totalAberto)} />
        <StatTile label="Aguardando aprovação" value={qtdAguardando}
          tone={qtdAguardando > 0 ? 'warn' : 'neutral'} />
        <StatTile label="Vencidos" value={qtdVencidos}
          hint={formatCurrency(totalVencido)}
          tone={qtdVencidos > 0 ? 'crit' : 'ok'} />
        <StatTile label="Aprovação" value={aprovacaoLigada ? 'exigida' : 'desligada'}
          hint={aprovacaoLigada ? `${(faixas ?? []).length} faixa(s) de alçada` : 'título nasce aprovado'}
          tone={aprovacaoLigada ? 'ok' : 'neutral'} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex flex-col gap-4">
          {lista.length === 0 ? (
            <EmptyState title="Nenhum título lançado"
              description="Use o formulário ao lado para lançar a primeira despesa." />
          ) : (
            <>
            <Table head={['Vencimento', 'Descrição', 'Valor', 'Situação', 'Classificação', '']} label="Títulos a pagar">
              {lista.map((t) => {
                const st = PAYABLE_STATUS[t.status]
                const encerrado = t.status === 'paid' || t.status === 'cancelled'
                const venc = tomDoVencimento(t.due_on, encerrado)
                const cat = cats.find((c) => c.id === t.expense_category_id)
                const cc = (centros ?? []).find((c) => c.id === t.cost_center_id)
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
                      {t.status === 'rejected' && t.rejection_reason && (
                        <div className="mt-1 text-xs text-[var(--color-breach-ink)]">
                          Reprovado: {t.rejection_reason}
                        </div>
                      )}
                    </Td>
                    <Td className="tabular-nums font-semibold">{formatCurrency(t.amount)}</Td>
                    <Td><Badge tone={st.tone}>{st.label}</Badge></Td>
                    <Td className="text-xs text-[var(--color-ink-3)]">
                      {cat ? cat.code : '—'}{cc ? ` / ${cc.code}` : ''}
                    </Td>
                    <Td>
                      <div className="flex flex-col gap-2">
                        {podeAprovar && t.status === 'pending_approval' && (
                          <EditPanel label="Aprovar" title={`Aprovação de ${t.description}`}>
                            <DecisionForm payable={t} nivel={1} />
                          </EditPanel>
                        )}
                        {podePagar && ['approved', 'scheduled'].includes(t.status) && (
                          <EditPanel label="Pagar" title={`Baixa de ${t.description}`}>
                            <PaymentForm payable={t} accounts={contas ?? []} />
                          </EditPanel>
                        )}
                        <EditPanel label="Detalhes" title={t.description}>
                          <div className="flex flex-col gap-4">
                            {podeEditar && (
                              <EditPayableForm payable={t} lookups={lookups}
                                podeCancelar={podeCancelar} />
                            )}
                            <Attachments entity="titulos" entityId={t.id}
                              records={anexosPorTitulo.get(t.id) ?? []}
                              title="NF, boleto e comprovante" />
                          </div>
                        </EditPanel>
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
              base="/financeiro/titulos-a-pagar"
              params={params}
            />
            </>
          )}
        </div>

        <div className="flex flex-col gap-6">
          {podeCriar && (
            <Card title="Lançar despesa">
              <NewPayableForm lookups={lookups} />
            </Card>
          )}

          {podeConfigurar && (
            <>
              <Card title="Alçada de aprovação">
                <p className="mb-3 text-sm text-[var(--color-ink-2)]">
                  A regra de quem aprova o quê é <strong>sua</strong>, não do sistema. Nenhuma faixa
                  vem pré-cadastrada de propósito — inventar um valor aqui seria inventar a sua
                  política de autorização.
                </p>
                <ApprovalToggleForm ligado={aprovacaoLigada}
                  temFaixa={(faixas ?? []).some((f) => f.is_active)} />

                {(faixas ?? []).length > 0 && (
                  <div className="mt-4 flex flex-col gap-2 border-t border-[var(--color-border)] pt-4">
                    {(faixas ?? []).map((f) => (
                      <div key={f.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2">
                        <div className="text-sm">
                          <span className="font-medium text-[var(--color-ink)]">
                            {f.level}. {f.level_name}
                          </span>
                          <div className="text-xs text-[var(--color-ink-3)]">
                            {formatCurrency(f.min_amount)} até{' '}
                            {f.max_amount === null ? 'sem teto' : formatCurrency(f.max_amount)}
                          </div>
                        </div>
                        <DeleteApprovalRuleForm rule={f} />
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt-4 border-t border-[var(--color-border)] pt-4">
                  <EditPanel label="+ Nova faixa de alçada">
                    <NewApprovalRuleForm costCenters={centros ?? []} branches={filiais ?? []}
                      profiles={perfis ?? []} />
                  </EditPanel>
                </div>
              </Card>

              <Card title="Categorias de despesa">
                <p className="mb-3 text-sm text-[var(--color-ink-2)]">
                  A categoria diz <strong>o que</strong> foi gasto; o centro de custo diz{' '}
                  <strong>quem</strong> consumiu. São dimensões diferentes de propósito.
                </p>
                {cats.length > 0 && (
                  <div className="mb-3 flex flex-col gap-1.5">
                    {cats.map((c) => (
                      <div key={c.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2">
                        <span className="text-sm">
                          <span className="font-mono text-xs">{c.code}</span> — {c.name}
                          {!c.is_active && <Badge>Inativa</Badge>}
                        </span>
                        <ToggleExpenseCategoryForm category={c} />
                      </div>
                    ))}
                  </div>
                )}
                <EditPanel label="+ Nova categoria">
                  <NewExpenseCategoryForm />
                </EditPanel>
              </Card>
            </>
          )}
        </div>
      </div>
    </>
  )
}
