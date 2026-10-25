import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { competenciaAtual, paraExibicao } from '@/lib/projetos/competencia'
import { emReais, ROTULO_DA_ORIGEM, somar } from '@/lib/orcamento/rateio'
import { Badge, Card, EmptyState, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { LancamentoForm } from './lancamento-form'
import { Fechamento } from './fechamento'

export const metadata: Metadata = { title: 'Orçamento de TI' }

interface Lancamento {
  id: string
  competence: string
  amount: number
  description: string | null
  natureza: string
  classificacao: string
  consumo: string
  origem: string
  installment_number: number | null
  installment_total: number | null
  branch_name: string | null
  category_name: string
  supplier_name: string | null
  competencia_fechada: boolean
}

interface Consolidado {
  competence: string
  total: number
  total_despesa: number | null
  total_investimento: number | null
  total_manual: number | null
  total_planilha: number | null
  total_projecao: number | null
  total_titulos: number | null
  total_compartilhado: number | null
}

interface Fechado {
  id: string
  competence: string
  closed_at: string
  reopened_at: string | null
  reopen_reason: string | null
}

/**
 * Orçamento de TI.
 *
 * ## A pergunta que esta tela responde, e que `payables` não responde
 *
 * `payables` diz **quando eu pago**. Esta tela diz **quanto a TI custa por mês,
 * por filial e por categoria — e quanto vai custar**.
 *
 * A diferença é a **competência**: o mês a que a despesa pertence, não o mês em
 * que ela é paga. Uma licença anual paga em janeiro pertence aos doze meses, e
 * quem pergunta "quanto a TI custou em agosto" quer o duodécimo, não zero.
 *
 * ## Os dois não somam
 *
 * Um título a pagar vira lançamento **uma vez só**, por índice único em
 * `payable_id`. A importação é idempotente de propósito: quem importa não tem
 * como saber se já importou, e vai tentar de novo.
 *
 * ## A conferência de origem é o que torna o total verificável
 *
 * O número que o sistema mostra não é o total do que alguém digitou: parte veio
 * de título a pagar, parte de planilha, parte é projeção. Decompor por
 * procedência permite **conferir** a diferença em vez de explicá-la.
 */
export default async function OrcamentoPage({
  searchParams,
}: {
  searchParams: Promise<{ cliente?: string; competencia?: string }>
}) {
  const params = await searchParams
  await requireScreen('financeiro.orcamento.ver')
  const podeLancar = await allowed('financeiro.orcamento.lancar')
  const podeFechar = await allowed('financeiro.orcamento.fechar')

  const supabase = await createClient()

  const { data: clientes } = await supabase
    .from('clients')
    .select('id, trade_name, legal_name')
    .is('deleted_at', null)
    .order('legal_name')
    .returns<{ id: string; trade_name: string | null; legal_name: string }[]>()

  const lista = clientes ?? []
  /* Sem cliente escolhido, o primeiro: o orçamento é sempre de um cliente, e uma
     tela vazia pedindo que se escolha um esconde o recurso de quem tem um só. */
  const clienteId = params.cliente ?? lista[0]?.id ?? null
  const competencia = params.competencia
    ? (params.competencia.length === 7 ? `${params.competencia}-01` : params.competencia)
    : competenciaAtual()

  if (!clienteId) {
    return (
      <>
        <PageHeader title="Orçamento de TI" description="Quanto a TI custa, e quanto vai custar." />
        <EmptyState
          title="Nenhum cliente cadastrado"
          description="O orçamento é sempre de um cliente. Cadastre um em Clientes e filiais."
        />
      </>
    )
  }

  const [
    { data: lancamentos },
    { data: consolidado },
    { data: fechamentos },
    { data: cenarios },
    { data: categorias },
    { data: filiais },
    { data: fornecedores },
    { data: centros },
  ] = await Promise.all([
    supabase
      .from('vw_it_cost_entries')
      .select(
        'id, competence, amount, description, natureza, classificacao, consumo, origem, installment_number, installment_total, branch_name, category_name, supplier_name, competencia_fechada',
      )
      .eq('client_id', clienteId)
      .eq('competence', competencia)
      /* O mesmo recorte do consolidado logo abaixo: a lista e os totais da tela
         precisam somar a mesma coisa, ou a tela discorda de si mesma. */
      .eq('scenario_key', 'oficial')
      .order('amount', { ascending: false })
      .returns<Lancamento[]>(),
    /* O consolidado lê os doze meses, e não só a competência aberta: a série é o
       que mostra se o custo está subindo, e um número isolado não mostra nada. */
    supabase
      .from('vw_it_budget_monthly')
      .select(
        'competence, total, total_despesa, total_investimento, total_manual, total_planilha, total_projecao, total_titulos, total_compartilhado',
      )
      .eq('client_id', clienteId)
      /* Só o cenário oficial. É o contrato da 0038 — "o `oficial` alimenta os
         indicadores; os outros convivem sem contaminar os totais" — e sem este
         filtro a série somaria simulação com real no dia em que o primeiro
         cenário alternativo existisse. */
      .eq('scenario_key', 'oficial')
      .order('competence')
      .returns<Consolidado[]>(),
    supabase
      .from('it_budget_closings')
      .select('id, competence, closed_at, reopened_at, reopen_reason')
      .eq('client_id', clienteId)
      .order('competence', { ascending: false })
      .limit(24)
      .returns<Fechado[]>(),
    supabase
      .from('it_budget_scenarios')
      .select('id, key, name')
      .eq('client_id', clienteId)
      .order('key')
      .returns<{ id: string; key: string; name: string }[]>(),
    podeLancar
      ? supabase
          .from('expense_categories')
          .select('id, name')
          .eq('is_active', true)
          .order('name')
          .returns<{ id: string; name: string }[]>()
      : Promise.resolve({ data: [] }),
    podeLancar
      ? supabase
          .from('branches')
          .select('id, name')
          .eq('client_id', clienteId)
          .is('deleted_at', null)
          .order('name')
          .returns<{ id: string; name: string }[]>()
      : Promise.resolve({ data: [] }),
    podeLancar
      ? supabase
          .from('suppliers')
          .select('id, name')
          .eq('is_active', true)
          .is('deleted_at', null)
          .order('name')
          .returns<{ id: string; name: string }[]>()
      : Promise.resolve({ data: [] }),
    podeLancar
      ? supabase
          .from('cost_centers')
          .select('id, name')
          .eq('is_active', true)
          .order('name')
          .returns<{ id: string; name: string }[]>()
      : Promise.resolve({ data: [] }),
  ])

  const doMes = lancamentos ?? []
  const serie = consolidado ?? []
  /* O consolidado vem por categoria e filial; a tela quer por mês. Somar aqui é
     mais barato que uma segunda view com outro `group by`. */
  const porMes = new Map<string, Consolidado>()
  for (const c of serie) {
    const atual = porMes.get(c.competence)
    porMes.set(c.competence, {
      competence: c.competence,
      total: (atual?.total ?? 0) + Number(c.total ?? 0),
      total_despesa: (atual?.total_despesa ?? 0) + Number(c.total_despesa ?? 0),
      total_investimento: (atual?.total_investimento ?? 0) + Number(c.total_investimento ?? 0),
      total_manual: (atual?.total_manual ?? 0) + Number(c.total_manual ?? 0),
      total_planilha: (atual?.total_planilha ?? 0) + Number(c.total_planilha ?? 0),
      total_projecao: (atual?.total_projecao ?? 0) + Number(c.total_projecao ?? 0),
      total_titulos: (atual?.total_titulos ?? 0) + Number(c.total_titulos ?? 0),
      total_compartilhado: (atual?.total_compartilhado ?? 0) + Number(c.total_compartilhado ?? 0),
    })
  }
  const meses = [...porMes.values()].sort((a, b) => a.competence.localeCompare(b.competence))
  const doMesAtual = porMes.get(competencia)
  const totalDoMes = somar(doMes.map((l) => Number(l.amount)))

  const fechamentoDaCompetencia = (fechamentos ?? []).find(
    (f) => f.competence === competencia && f.reopened_at === null,
  )
  const cenarioOficial = (cenarios ?? []).find((c) => c.key === 'oficial') ?? (cenarios ?? [])[0]

  const href = (p: Record<string, string>): Route => {
    const q = new URLSearchParams({ cliente: clienteId, competencia, ...p })
    return `/financeiro/orcamento?${q.toString()}` as Route
  }

  return (
    <>
      <PageHeader
        title="Orçamento de TI"
        description="Quanto a TI custa por mês, por filial e por categoria — e quanto vai custar."
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
            Cliente
          </p>
          <div className="flex flex-wrap gap-1.5">
            {lista.map((c) => (
              <Link
                key={c.id}
                href={href({ cliente: c.id })}
                aria-current={c.id === clienteId ? 'page' : undefined}
                className={`rounded-full px-2.5 py-1 text-xs ${
                  c.id === clienteId
                    ? 'bg-[var(--color-brand-soft)] font-semibold text-[var(--color-brand-ink)]'
                    : 'text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]'
                }`}
              >
                {c.trade_name ?? c.legal_name}
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Escolher a competência">
        {meses.slice(-12).map((m) => (
          <Link
            key={m.competence}
            href={href({ competencia: m.competence })}
            aria-current={m.competence === competencia ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 text-xs tabular-nums ${
              m.competence === competencia
                ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
                : 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]'
            }`}
          >
            {paraExibicao(m.competence)}
          </Link>
        ))}
        {!porMes.has(competencia) && (
          <span className="rounded-full border border-[var(--color-brand)] bg-[var(--color-brand)] px-3 py-1 text-xs tabular-nums text-white">
            {paraExibicao(competencia)}
          </span>
        )}
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label={`Custo em ${paraExibicao(competencia)}`}
          value={emReais(totalDoMes)}
          hint={`${doMes.length} lançamento(s)`}
        />
        <StatTile
          label="Despesa"
          value={emReais(Number(doMesAtual?.total_despesa ?? 0))}
          hint="custo corrente"
        />
        <StatTile
          label="Investimento"
          value={emReais(Number(doMesAtual?.total_investimento ?? 0))}
          hint="vira ativo"
        />
        {/* O indicador que a base não tinha: quanto desta filial é pago por
            outra. Sem ele, a matriz que centraliza licenças aparece como a
            unidade cara e as que consomem aparecem baratas. */}
        <StatTile
          label="Compartilhado"
          value={emReais(Number(doMesAtual?.total_compartilhado ?? 0))}
          hint="pago por uma, consumido por outras"
          tone="neutral"
        />
      </div>

      {fechamentoDaCompetencia && (
        <div
          role="status"
          className="mb-6 rounded-lg border border-[var(--color-warn-ink)]/30 bg-[var(--color-warn-soft)] p-3.5 text-sm text-[var(--color-warn-ink)]"
        >
          <strong>Competência fechada.</strong> Nenhum lançamento entra, sai ou muda nesta
          competência — nem por importação. Reabrir exige motivo, e fica registrado.
        </div>
      )}

      <Card title="Conferência de origem" className="mb-6">
        <p className="mb-3 text-sm text-[var(--color-ink-2)]">
          O total não é o que alguém digitou: parte veio de título a pagar, parte de planilha,
          parte é projeção. Decompor por procedência é o que permite <strong>conferir</strong> a
          diferença em vez de explicá-la.
        </p>
        {meses.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-3)]">Nenhum lançamento neste cliente.</p>
        ) : (
          <Table
            label="Consolidado por competência"
            head={['Competência', 'Títulos', 'Planilha', 'Projeção', 'Lançado na tela', 'Total']}
          >
            {meses.slice(-12).map((m) => (
              <tr key={m.competence}>
                <Td className="tabular-nums">{paraExibicao(m.competence)}</Td>
                <Td className="tabular-nums text-[var(--color-ink-2)]">
                  {emReais(Number(m.total_titulos ?? 0))}
                </Td>
                <Td className="tabular-nums text-[var(--color-ink-2)]">
                  {emReais(Number(m.total_planilha ?? 0))}
                </Td>
                <Td className="tabular-nums text-[var(--color-ink-2)]">
                  {emReais(Number(m.total_projecao ?? 0))}
                </Td>
                <Td className="tabular-nums text-[var(--color-ink-2)]">
                  {emReais(Number(m.total_manual ?? 0))}
                </Td>
                <Td className="tabular-nums font-semibold">{emReais(Number(m.total))}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title={`Lançamentos de ${paraExibicao(competencia)}`} className="mb-6">
        {doMes.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-3)]">
            Nenhum lançamento nesta competência.
            {podeLancar && ' Lance abaixo, ou importe os títulos a pagar que vencem no mês.'}
          </p>
        ) : (
          <Table label="Lançamentos" head={['Categoria', 'Filial', 'Natureza', 'Origem', 'Valor']}>
            {doMes.map((l) => (
              <tr key={l.id}>
                <Td>
                  {l.category_name}
                  {l.description && (
                    <p className="text-xs text-[var(--color-ink-3)]">{l.description}</p>
                  )}
                  {l.supplier_name && (
                    <p className="text-xs text-[var(--color-ink-3)]">{l.supplier_name}</p>
                  )}
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {l.branch_name ?? <span className="text-[var(--color-ink-3)]">do grupo</span>}
                  {l.consumo === 'compartilhado' && (
                    <p className="text-xs text-[var(--color-ink-3)]">consumo compartilhado</p>
                  )}
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {l.natureza === 'pontual_parcelada' && l.installment_total
                    ? `parcela ${l.installment_number}/${l.installment_total}`
                    : l.natureza === 'fixa'
                      ? 'fixa'
                      : 'pontual'}
                  <p className="text-xs text-[var(--color-ink-3)]">
                    {l.classificacao === 'investimento' ? 'investimento' : 'despesa'}
                  </p>
                </Td>
                <Td>
                  <Badge tone={l.origem === 'titulo_a_pagar' ? 'info' : 'neutral'}>
                    {ROTULO_DA_ORIGEM[l.origem] ?? l.origem}
                  </Badge>
                </Td>
                <Td className="tabular-nums font-medium">{emReais(Number(l.amount))}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {podeLancar && cenarioOficial && (
        <LancamentoForm
          clientId={clienteId}
          scenarioId={cenarioOficial.id}
          competencia={competencia}
          fechada={Boolean(fechamentoDaCompetencia)}
          categorias={categorias ?? []}
          filiais={filiais ?? []}
          fornecedores={fornecedores ?? []}
          centros={centros ?? []}
        />
      )}

      {podeFechar && (
        <Fechamento
          clientId={clienteId}
          competencia={competencia}
          fechamento={fechamentoDaCompetencia ?? null}
          historico={(fechamentos ?? []).filter((f) => f.reopened_at !== null)}
          className="mt-6"
        />
      )}

      <Card title="Como este módulo conversa com os títulos a pagar" className="mt-6">
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-[var(--color-ink-2)]">
          <li>
            <strong>Os dois não somam.</strong> Um título vira lançamento uma vez só, por índice
            único — importar duas vezes não duplica nada.
          </li>
          <li>
            A diferença é a <strong>competência</strong>: o mês a que a despesa pertence, e não o
            mês em que ela é paga. Uma licença anual paga em janeiro pertence aos doze meses.
          </li>
          <li>
            A competência do título importado vem do <strong>vencimento</strong>. É a melhor
            aproximação sem pedir que alguém classifique título por título — e quem quiser outra
            edita o lançamento, sem que a origem mude.
          </li>
          <li>
            Título importado entra como <strong>despesa</strong>. Classificar como investimento é
            decisão contábil, e supô-la a partir do título erraria em favor do número mais vistoso.
          </li>
        </ul>
      </Card>
    </>
  )
}
