import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { escopoDeCliente, porFilialOuGeral } from '@/lib/data/escopo'
import { lerPagina, paginar } from '@/lib/data/paginacao'
import { requireScreen, allowed } from '@/lib/session'
import { formatCurrency, formatDate } from '@/lib/format'
import type { CostCenter, ExpenseCategory, Payable, Tenant } from '@/lib/types'
import Link from 'next/link'
import type { Route } from 'next'
import { comParametros } from '@/lib/data/endereco'
import {
  Badge, EmptyState, FaixaDeIndicadores, PageHeader, Pager, StatTile, Table, Td,
} from '@/components/ui'
import { PAYABLE_STATUS, tomDoVencimento } from '../titulos/labels'
import { GavetaDeTitulos } from './gaveta'

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
  searchParams: Promise<{
    pagina?: string
    /** O título aberto na gaveta. */
    aberto?: string
    novo?: string
    /** Alçada e categorias: configuração da tela, não de um registro. */
    ajustes?: string
  }>
}) {
  const params = await searchParams
  await requireScreen('financeiro.titulos_pagar.ver')
  /* Só as permissões que a LISTA usa para decidir o que mostrar; quem confere
     as de escrita é a gaveta, onde a escrita acontece. */
  const [podeCriar, podeConfigurar] = await Promise.all([
    allowed('financeiro.titulos_pagar.criar'),
    allowed('financeiro.titulos_pagar.configurar'),
  ])

  const supabase = await createClient()
  const escopo = await escopoDeCliente()
  const pagina = lerPagina(params.pagina)
  /* Contas, fornecedores, filiais, faixas e perfis saíram daqui com os
     formulários: quem precisa deles é a gaveta, e ela os busca quando abre.
     Eram cinco consultas por visita para alimentar uma coluna que, na maioria
     das visitas, ninguém usava. */
  const [
    { data: titulos, count }, { data: categorias }, { data: centros },
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
    supabase.from('expense_categories')
      .select('id, code, name, requires_supplier, is_active').order('code')
      .returns<ExpenseCategory[]>(),
    supabase.from('cost_centers')
      .select('id, parent_id, code, name, description, branch_id, is_active')
      .eq('is_active', true).order('code').returns<CostCenter[]>(),
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

  /* Os anexos saíram da lista: eram buscados para os 50 títulos da página a
     fim de alimentar painéis que quase ninguém abria. Agora quem busca é a
     gaveta, do título que está aberto. */
  const lista = titulos ?? []
  const cats = categorias ?? []
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

  /* Endereço desta tela com um parâmetro trocado — abre e fecha a gaveta sem
     perder a página nem o filtro. */
  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/financeiro/titulos-a-pagar', params, {
      ...mudancas,
      pagina: params.pagina ?? null,
    })

  const gavetaAberta = Boolean(params.aberto || params.novo || params.ajustes)

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && (
        <GavetaDeTitulos
          id={params.aberto}
          novo={Boolean(params.novo)}
          ajustes={Boolean(params.ajustes)}
          fechar={endereco({ aberto: null, novo: null, ajustes: null })}
        />
      )}

      <PageHeader
        title="Títulos a pagar"
        description="Lançamento de despesa, aprovação e baixa. Cada parcela é um título próprio, com aprovação e pagamento independentes."
        action={
          <div className="flex flex-wrap gap-2">
            {podeConfigurar && (
              <Link
                href={endereco({ ajustes: '1' }) as Route}
                data-testid="abrir-ajustes"
                className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
              >
                Alçada e categorias
              </Link>
            )}
            {podeCriar && (
              <Link
                href={endereco({ novo: '1' }) as Route}
                data-testid="novo-registro"
                className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
              >
                Lançar despesa
              </Link>
            )}
          </div>
        }
      />

      <FaixaDeIndicadores>
        <StatTile label="Em aberto" value={qtdAberto} hint={formatCurrency(totalAberto)} />
        <StatTile label="Aguardando aprovação" value={qtdAguardando}
          tone={qtdAguardando > 0 ? 'warn' : 'neutral'} />
        <StatTile label="Vencidos" value={qtdVencidos}
          hint={formatCurrency(totalVencido)}
          tone={qtdVencidos > 0 ? 'crit' : 'ok'} />
        <StatTile label="Aprovação" value={aprovacaoLigada ? 'exigida' : 'desligada'}
          hint={aprovacaoLigada ? 'faixas de alçada em Ajustes' : 'título nasce aprovado'}
          tone={aprovacaoLigada ? 'ok' : 'neutral'} />
      </FaixaDeIndicadores>

      {lista.length === 0 ? (
        <EmptyState
          title="Nenhum título lançado"
          description={
            podeCriar
              ? 'Lance a primeira despesa em "Lançar despesa".'
              : 'Nenhum título alcançável pelo seu perfil.'
          }
        />
      ) : (
        <>
          {/* A tabela ganhou "Centro de custo" como COLUNA: ele existia só
              dentro do painel de cada linha porque não havia largura para
              mostrá-lo — era dado de lista disfarçado de dado de ficha. */}
          <Table
            head={['Vencimento', 'Descrição', 'Valor', 'Situação', 'Categoria', 'Centro de custo']}
            label="Títulos a pagar"
          >
            {lista.map((t) => {
              const st = PAYABLE_STATUS[t.status]
              const encerrado = t.status === 'paid' || t.status === 'cancelled'
              const venc = tomDoVencimento(t.due_on, encerrado)
              const cat = cats.find((c) => c.id === t.expense_category_id)
              const cc = (centros ?? []).find((c) => c.id === t.cost_center_id)
              return (
                <tr key={t.id} className="hover:bg-[var(--color-surface-2)]">
                  <Td className="tabular-nums">
                    {formatDate(t.due_on)}
                    <div
                      className={`text-xs ${
                        venc.tone === 'breach'
                          ? 'text-[var(--color-breach-ink)]'
                          : venc.tone === 'crit'
                            ? 'text-[var(--color-crit-ink)]'
                            : venc.tone === 'warn'
                              ? 'text-[var(--color-warn-ink)]'
                              : 'text-[var(--color-ink-3)]'
                      }`}
                    >
                      {venc.texto}
                    </div>
                  </Td>
                  <Td>
                    <Link
                      href={endereco({ aberto: t.id }) as Route}
                      data-testid="abrir-registro"
                      className="font-medium text-[var(--color-brand-ink)] hover:underline"
                    >
                      {t.description}
                    </Link>
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
                  <Td>
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </Td>
                  <Td className="text-xs text-[var(--color-ink-2)]">
                    {cat ? `${cat.code} — ${cat.name}` : '—'}
                  </Td>
                  <Td className="text-xs text-[var(--color-ink-2)]">
                    {cc ? `${cc.code} — ${cc.name}` : '—'}
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
  )
}
