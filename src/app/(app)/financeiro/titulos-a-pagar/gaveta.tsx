import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { formatCurrency, formatDate } from '@/lib/format'
import type {
  ApprovalRule, BankAccount, CostCenter, ExpenseCategory, Payable, Tenant,
} from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import { Attachments, type AttachmentRecord } from '@/components/attachments'
import { PAYABLE_STATUS } from '../titulos/labels'
import {
  ApprovalToggleForm, DecisionForm, DeleteApprovalRuleForm, EditPayableForm,
  NewApprovalRuleForm, NewExpenseCategoryForm, NewPayableForm, PaymentForm,
  ToggleExpenseCategoryForm,
} from '../titulos/forms'

/**
 * A gaveta de títulos a pagar — registro, lançamento e ajustes.
 *
 * ## O que ela tira da tela
 *
 * Uma coluna de 24rem com três cartões empilhados ("Lançar despesa", "Alçada
 * de aprovação", "Categorias de despesa"), aberta o tempo todo. A lista ficava
 * com pouco mais da metade da largura, e por isso **vencimento e centro de
 * custo só apareciam dentro do painel de cada linha** — dado de lista
 * disfarçado de dado de ficha. Com a coluna fora, eles voltam a ser coluna.
 *
 * ## Três modos, uma gaveta
 *
 * - `?aberto=<id>` — o título: ficha, aprovação, baixa e anexos.
 * - `?novo=1` — o lançamento de despesa.
 * - `?ajustes=1` — alçada de aprovação e categorias, que são configuração da
 *   TELA, não de um registro. Ficavam ocupando espaço permanente para uma
 *   decisão que se toma uma vez por semestre.
 *
 * Cada modo confere a sua própria permissão, e a gaveta que a pessoa não pode
 * abrir simplesmente não abre — mesmo digitando o endereço na mão.
 */
export async function GavetaDeTitulos({
  id,
  novo,
  ajustes,
  fechar,
}: {
  id?: string
  novo?: boolean
  ajustes?: boolean
  fechar: string
}) {
  const supabase = await createClient()

  const [podeCriar, podeEditar, podeAprovar, podePagar, podeCancelar, podeConfigurar] =
    await Promise.all([
      allowed('financeiro.titulos_pagar.criar'),
      allowed('financeiro.titulos_pagar.editar'),
      allowed('financeiro.titulos_pagar.aprovar'),
      allowed('financeiro.titulos_pagar.pagar'),
      allowed('financeiro.titulos_pagar.cancelar'),
      allowed('financeiro.titulos_pagar.configurar'),
    ])

  /* Os lookups são os mesmos dos três modos, e a consulta é barata: listas
     curtas, todas sob RLS. Buscá-las por modo seriam três caminhos para manter
     em dia. */
  const [{ data: categorias }, { data: centros }, { data: fornecedores }, { data: filiais }] =
    await Promise.all([
      supabase
        .from('expense_categories')
        .select('id, code, name, requires_supplier, is_active')
        .order('code')
        .returns<ExpenseCategory[]>(),
      supabase
        .from('cost_centers')
        .select('id, parent_id, code, name, description, branch_id, is_active')
        .eq('is_active', true)
        .order('code')
        .returns<CostCenter[]>(),
      supabase.from('suppliers').select('id, name').is('deleted_at', null).order('name'),
      supabase.from('branches').select('id, name').eq('is_active', true).order('name'),
    ])

  const cats = categorias ?? []
  const lookups = {
    suppliers: fornecedores ?? [],
    categories: cats.filter((c) => c.is_active),
    costCenters: centros ?? [],
    branches: filiais ?? [],
  }

  if (novo) {
    if (!podeCriar) return null
    return (
      <Gaveta fechar={fechar} rotulo="Lançar despesa">
        <CabecalhoDaGaveta titulo="Lançar despesa" linha="Novo título a pagar" fechar={fechar} />
        <CorpoDaGaveta>
          <NewPayableForm lookups={lookups} />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (ajustes) {
    if (!podeConfigurar) return null
    const [{ data: faixas }, { data: perfis }, { data: tenant }] = await Promise.all([
      supabase
        .from('approval_rules')
        .select(
          'id, level, level_name, min_amount, max_amount, cost_center_id, branch_id, required_profile_id, is_active',
        )
        .order('level')
        .returns<ApprovalRule[]>(),
      supabase.from('access_profiles').select('id, name').eq('is_active', true).order('name'),
      supabase
        .from('tenants')
        .select('id, name, payable_approval_required')
        .maybeSingle<Tenant & { payable_approval_required: boolean }>(),
    ])
    const regras = faixas ?? []

    return (
      <Gaveta fechar={fechar} rotulo="Alçada e categorias">
        <CabecalhoDaGaveta
          titulo="Alçada e categorias"
          linha="Configuração de títulos a pagar"
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <section>
            <h3 className="mb-1.5 text-sm font-semibold text-[var(--color-ink)]">
              Alçada de aprovação
            </h3>
            <p className="mb-3 text-sm text-[var(--color-ink-2)]">
              A regra de quem aprova o quê é <strong>sua</strong>, não do sistema. Nenhuma faixa vem
              pré-cadastrada de propósito — inventar um valor aqui seria inventar a sua política de
              autorização.
            </p>
            <ApprovalToggleForm
              ligado={tenant?.payable_approval_required ?? false}
              temFaixa={regras.some((f) => f.is_active)}
            />

            {regras.length > 0 && (
              <div className="mt-4 flex flex-col gap-2 border-t border-[var(--color-border)] pt-4">
                {regras.map((f) => (
                  <div
                    key={f.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2"
                  >
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
              <NewApprovalRuleForm
                costCenters={centros ?? []}
                branches={filiais ?? []}
                profiles={perfis ?? []}
              />
            </div>
          </section>

          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-1.5 text-sm font-semibold text-[var(--color-ink)]">
              Categorias de despesa
            </h3>
            <p className="mb-3 text-sm text-[var(--color-ink-2)]">
              A categoria diz <strong>o que</strong> foi gasto; o centro de custo diz{' '}
              <strong>quem</strong> consumiu. São dimensões diferentes de propósito.
            </p>
            {cats.length > 0 && (
              <div className="mb-3 flex flex-col gap-1.5">
                {cats.map((c) => (
                  <div
                    key={c.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2"
                  >
                    <span className="text-sm">
                      <span className="font-mono text-xs">{c.code}</span> — {c.name}
                      {!c.is_active && <Badge>Inativa</Badge>}
                    </span>
                    <ToggleExpenseCategoryForm category={c} />
                  </div>
                ))}
              </div>
            )}
            <NewExpenseCategoryForm />
          </section>
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!id) return null

  const { data: titulo } = await supabase
    .from('payables')
    .select(
      'id, description, document_ref, supplier_id, supplier_contract_id, expense_category_id, cost_center_id, branch_id, amount, issued_on, due_on, parent_payable_id, installment_number, installment_total, status, approved_at, approved_by, rejection_reason, paid_on, bank_account_id, notes',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle<Payable>()

  if (!titulo) return null

  const [{ data: anexos }, { data: contas }] = await Promise.all([
    supabase
      .from('payable_attachments')
      .select('id, payable_id, storage_path, file_name, mime_type, size_bytes, created_at, kind')
      .eq('payable_id', id)
      .order('created_at', { ascending: false })
      .returns<(AttachmentRecord & { payable_id: string })[]>(),
    supabase
      .from('bank_accounts')
      .select(
        'id, name, bank_name, bank_code, agency, account_number, account_type, holder_name, holder_document, opening_balance, credit_limit, status, notes',
      )
      .eq('status', 'active')
      .is('deleted_at', null)
      .order('name')
      .returns<BankAccount[]>(),
  ])

  const st = PAYABLE_STATUS[titulo.status]

  return (
    <Gaveta fechar={fechar} rotulo={titulo.description}>
      <CabecalhoDaGaveta
        titulo={titulo.description}
        linha={`${formatCurrency(titulo.amount)} · vence ${formatDate(titulo.due_on)}${
          titulo.installment_total > 1
            ? ` · parcela ${titulo.installment_number}/${titulo.installment_total}`
            : ''
        }`}
        fechar={fechar}
        selo={<Badge tone={st.tone}>{st.label}</Badge>}
      />

      <CorpoDaGaveta>
        {titulo.status === 'rejected' && titulo.rejection_reason && (
          <p className="rounded-lg bg-[var(--color-breach-soft)] px-3 py-2 text-sm text-[var(--color-breach-ink)]">
            Reprovado: {titulo.rejection_reason}
          </p>
        )}

        {/* Aprovar e pagar vêm ANTES da ficha: quando o título está nesse
            estado, é isso que a pessoa veio fazer. */}
        {podeAprovar && titulo.status === 'pending_approval' && (
          <section className="rounded-xl border border-[var(--color-border)] p-3">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Aprovação</h3>
            <DecisionForm payable={titulo} nivel={1} />
          </section>
        )}

        {podePagar && ['approved', 'scheduled'].includes(titulo.status) && (
          <section className="rounded-xl border border-[var(--color-border)] p-3">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Baixa</h3>
            <PaymentForm payable={titulo} accounts={contas ?? []} />
          </section>
        )}

        {podeEditar && (
          <EditPayableForm payable={titulo} lookups={lookups} podeCancelar={podeCancelar} />
        )}

        <Attachments
          entity="titulos"
          entityId={titulo.id}
          records={anexos ?? []}
          title="NF, boleto e comprovante"
        />
      </CorpoDaGaveta>
    </Gaveta>
  )
}
