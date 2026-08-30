import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { formatCurrency, formatDate } from '@/lib/format'
import type {
  ApprovalRule, BankAccount, CostCenter, ExpenseCategory, Payable, Tenant,
} from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { EditPanel } from '@/components/edit-panel'
import { Attachments, type AttachmentRecord } from '@/components/attachments'
import { PAYABLE_STATUS, tomDoVencimento } from '../titulos/labels'
import {
  ApprovalToggleForm, DecisionForm, DeleteApprovalRuleForm, EditPayableForm,
  NewApprovalRuleForm, NewExpenseCategoryForm, NewPayableForm, PaymentForm,
  ToggleExpenseCategoryForm,
} from '../titulos/forms'

export const metadata: Metadata = { title: 'Títulos a pagar' }

export default async function TitulosAPagarPage() {
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
  const [
    { data: titulos }, { data: contas }, { data: categorias }, { data: centros },
    { data: fornecedores }, { data: filiais }, { data: faixas }, { data: perfis },
    { data: tenant }, { data: anexos },
  ] = await Promise.all([
    supabase.from('payables')
      .select('id, description, document_ref, supplier_id, supplier_contract_id, expense_category_id, cost_center_id, branch_id, amount, issued_on, due_on, parent_payable_id, installment_number, installment_total, status, approved_at, approved_by, rejection_reason, paid_on, bank_account_id, notes')
      .is('deleted_at', null).order('due_on').returns<Payable[]>(),
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
    supabase.from('payable_attachments')
      .select('id, payable_id, storage_path, file_name, mime_type, size_bytes, created_at, kind')
      .order('created_at', { ascending: false })
      .returns<(AttachmentRecord & { payable_id: string })[]>(),
  ])

  const lista = titulos ?? []
  const cats = categorias ?? []
  const lookups = {
    suppliers: fornecedores ?? [],
    categories: cats.filter((c) => c.is_active),
    costCenters: centros ?? [],
    branches: filiais ?? [],
  }
  const anexosPorTitulo = new Map<string, AttachmentRecord[]>()
  for (const a of anexos ?? []) {
    anexosPorTitulo.set(a.payable_id, [...(anexosPorTitulo.get(a.payable_id) ?? []), a])
  }

  const aberto = lista.filter((t) => !['paid', 'cancelled'].includes(t.status))
  const aguardando = lista.filter((t) => t.status === 'pending_approval')
  const hoje = new Date().toISOString().slice(0, 10)
  const vencidos = aberto.filter((t) => t.due_on < hoje)
  const totalAberto = aberto.reduce((s, t) => s + Number(t.amount), 0)
  const aprovacaoLigada = tenant?.payable_approval_required ?? false

  return (
    <>
      <PageHeader
        title="Títulos a pagar"
        description="Lançamento de despesa, aprovação e baixa. Cada parcela é um título próprio, com aprovação e pagamento independentes."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Em aberto" value={aberto.length} hint={formatCurrency(totalAberto)} />
        <StatTile label="Aguardando aprovação" value={aguardando.length}
          tone={aguardando.length > 0 ? 'warn' : 'neutral'} />
        <StatTile label="Vencidos" value={vencidos.length}
          hint={formatCurrency(vencidos.reduce((s, t) => s + Number(t.amount), 0))}
          tone={vencidos.length > 0 ? 'crit' : 'ok'} />
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
            <Table head={['Vencimento', 'Descrição', 'Valor', 'Situação', 'Classificação', '']}>
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
