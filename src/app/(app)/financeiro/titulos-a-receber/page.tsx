import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { escopoDeCliente, porClienteOuGeral } from '@/lib/data/escopo'
import { lerPagina, paginar } from '@/lib/data/paginacao'
import { requireScreen, allowed } from '@/lib/session'
import { formatCurrency, formatDate } from '@/lib/format'
import { comParametros } from '@/lib/data/endereco'
import type { Client, Receivable } from '@/lib/types'
import {
  Badge, EmptyState, FaixaDeIndicadores, PageHeader, Pager, StatTile, Table, Td,
} from '@/components/ui'
import { RECEIVABLE_STATUS, tomDoVencimento } from '../titulos/labels'
import { GavetaDeRecebivel } from './gaveta'

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
  searchParams: Promise<{ pagina?: string; aberto?: string; novo?: string }>
}) {
  const params = await searchParams
  await requireScreen('financeiro.titulos_receber.ver')
  /* Só a permissão que a LISTA usa; as de escrita são conferidas na gaveta. */
  const podeCriar = await allowed('financeiro.titulos_receber.criar')

  const supabase = await createClient()
  const escopo = await escopoDeCliente()
  const pagina = lerPagina(params.pagina)
  /* Contas bancárias, contratos e centros de custo saíram com o formulário:
     quem precisa deles é a gaveta. A lista só precisa dos clientes, porque
     mostra o nome de cada um na coluna. */
  const [{ data: titulos, count }, { data: clientes }, { data: resumo }] = await Promise.all([
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
      supabase.from('clients')
        .select('id, legal_name, trade_name, cnpj, contract_ref, status')
        .is('deleted_at', null).order('legal_name').returns<Client[]>(),
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

  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/financeiro/titulos-a-receber', params, {
      ...mudancas,
      pagina: params.pagina ?? null,
    })

  const gavetaAberta = Boolean(params.aberto || params.novo)

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && (
        <GavetaDeRecebivel
          id={params.aberto}
          novo={Boolean(params.novo)}
          fechar={endereco({ aberto: null, novo: null })}
        />
      )}

      <PageHeader
        title="Títulos a receber"
        description="Receita combinada e sua baixa. Sem fluxo de aprovação: aprovar o que se vai receber não protege ninguém — o controle aqui é a baixa."
        action={
          podeCriar && (
            <Link
              href={endereco({ novo: '1' }) as Route}
              data-testid="novo-registro"
              className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
            >
              Lançar título
            </Link>
          )
        }
      />

      <FaixaDeIndicadores>
        <StatTile label="Em aberto" value={qtdAbertos} hint={formatCurrency(totalAberto)} />
        <StatTile label="Vencidos" value={qtdVencidos}
          hint={formatCurrency(totalVencido)}
          tone={qtdVencidos > 0 ? 'crit' : 'ok'} />
        <StatTile label="Recebidos" value={qtdRecebidos}
          hint={formatCurrency(totalRecebido)}
          tone="ok" />
        <StatTile label="Diferença de baixa" value={formatCurrency(diferenca)}
          hint="desconto e recebimento parcial" tone={diferenca > 0 ? 'warn' : 'neutral'} />
      </FaixaDeIndicadores>

      <div>
        <div>
          {lista.length === 0 ? (
            <EmptyState title="Nenhum título a receber"
              description={podeCriar
                ? 'Lance a primeira cobrança em "Lançar título".'
                : 'Nenhum título alcançável pelo seu perfil.'} />
          ) : (
            <>
            <Table head={['Vencimento', 'Descrição', 'Cliente', 'Valor', 'Situação']} label="Títulos a receber">
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
      </div>
    </div>
  )
}
