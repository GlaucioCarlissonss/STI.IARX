import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { escopoDeCliente, porCliente, porClienteOuGeral } from '@/lib/data/escopo'
import { agruparCompliance, type LinhaDeCompliance } from '@/lib/data/compliance'
import { requireScreen, allowed } from '@/lib/session'
import { formatDate, formatMinutes } from '@/lib/format'
import { comParametros } from '@/lib/data/endereco'
import type { Category, Priority, SlaContract } from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader, Table, Td } from '@/components/ui'
import { GavetaDeSla, lerTipo } from './gaveta'
import { SELECT_DE_DEFINICAO, type DefinitionRow } from './linhas'

export const metadata: Metadata = { title: 'SLA' }

/** Compliance abaixo de 95% é o limiar em que a operação precisa reagir. */
function complianceTone(pct: number | null) {
  if (pct === null) return 'neutral' as const
  if (pct >= 95) return 'ok' as const
  if (pct >= 85) return 'warn' as const
  return 'breach' as const
}

export default async function SlaPage({
  searchParams,
}: {
  searchParams: Promise<{ tipo?: string; aberto?: string; novo?: string }>
}) {
  const params = await searchParams
  await requireScreen('sla.compliance.ver')
  /*
   * As 4 telas de configuração moram nesta página, então a guarda é por bloco e
   * não `requireScreen` — que redirecionaria a página inteira e tiraria o
   * compliance de quem só não pode configurar.
   *
   * Antes daqui a seção "Configuração" não consultava permissão alguma: quem
   * tinha `sla.compliance.ver` via todos os botões de criar e editar, e a ação
   * só falhava no envio. As 8 chaves abaixo existiam no catálogo sem governar
   * nada nesta tela.
   */
  const [
    verCategorias,
    criarCategoria,
    editarCategoria,
    verPrioridades,
    criarPrioridade,
    editarPrioridade,
    verContratos,
    criarContrato,
    editarContrato,
    verDefinicoes,
    criarDefinicao,
    editarDefinicao,
  ] = await Promise.all([
    allowed('sla.categorias.ver'),
    allowed('sla.categorias.criar'),
    allowed('sla.categorias.editar'),
    allowed('sla.prioridades.ver'),
    allowed('sla.prioridades.criar'),
    allowed('sla.prioridades.editar'),
    allowed('sla.contratos.ver'),
    allowed('sla.contratos.criar'),
    allowed('sla.contratos.editar'),
    allowed('sla.definicoes.ver'),
    allowed('sla.definicoes.criar'),
    allowed('sla.definicoes.editar'),
  ])
  const mostraConfiguracao =
    verCategorias || verPrioridades || verContratos || verDefinicoes

  const supabase = await createClient()
  const escopo = await escopoDeCliente()

  /* Doze meses, contados do primeiro dia do mês de onze meses atrás: o mês
     corrente mais onze completos. Janela em vez de número de linhas — ver o
     comentário da consulta. */
  const janela = new Date()
  janela.setDate(1)
  janela.setMonth(janela.getMonth() - 11)
  const inicioDaJanela = janela.toISOString().slice(0, 10)

  const [
    { data: compliance },
    { data: definitions },
    { count: uncoveredCount },
    { data: allCategories },
    { data: allPriorities },
    { data: contracts },
  ] = await Promise.all([
    /* A view já agrupa por `client_id` (0011:304), então filtrar por cliente
       não altera a granularidade das linhas — só escolhe quais voltam.

       O recorte é por JANELA DE TEMPO, e não por número de linhas, e isso
       conserta um defeito: `vw_sla_compliance` agrupa por período, fila,
       ATENDENTE e cliente, então um mês com cinco filas e dez atendentes rende
       dezenas de linhas. O `.limit(40)` que estava aqui podia cortar antes de
       terminar o primeiro mês — numa tabela cujo título diz "por mês e fila". */
    porClienteOuGeral(
      supabase
        .from('vw_sla_compliance')
        .select(
          'period, queue_name, tickets_total, tickets_with_sla, response_breaches, resolution_breaches',
        )
        .gte('period', inicioDaJanela)
        .order('period', { ascending: false }),
      escopo,
    ).returns<LinhaDeCompliance[]>(),
    supabase
      .from('sla_definitions')
      .select(SELECT_DE_DEFINICAO)
      .order('resolution_minutes')
      .returns<DefinitionRow[]>(),
    // Cobertura: tickets que nenhuma definição de SLA alcançou. É o relatório
    // que revela buracos de configuração antes que o cliente reclame.
    supabase.from('sla_tracking').select('ticket_id', { count: 'exact', head: true }).eq('coverage', 'uncovered'),
    // As duas consultas abaixo trazem TODAS as linhas (ativas e inativas): é a
    // tela de gestão, diferente de `getCategories()`/`getPriorities()` — que
    // filtram só o que pode ser escolhido ao abrir um ticket.
    supabase
      .from('ticket_categories')
      .select('id, parent_id, name, description, is_active')
      .order('name')
      .returns<Category[]>(),
    supabase
      .from('ticket_priorities')
      .select('id, key, label, weight, color, sort_order, is_active')
      .order('sort_order')
      .returns<Priority[]>(),
    /* `sla_contracts.client_id` é NOT NULL: todo contrato tem dono, então aqui
       é `porCliente` e não a variante que inclui nulos. */
    porCliente(
      supabase
        .from('sla_contracts')
        .select('id, client_id, branch_id, name, business_hours_id, valid_from, valid_to, is_active, notes')
        .order('name'),
      escopo,
    ).returns<SlaContract[]>(),
  ])

  // Com `{ count: 'exact', head: true }` o Supabase devolve `data: null` e o
  // total no campo `count`, IRMÃO de `data` — não dentro dele. Ler de `data`
  // (como estava antes) sempre dava `undefined`, e o card de "tickets sem
  // SLA aplicável" nunca aparecia, mesmo com cobertura furada de verdade.
  const linhasCompliance = agruparCompliance(compliance ?? [])
  const semSla = uncoveredCount ?? 0

  const categories = allCategories ?? []
  const priorities = allPriorities ?? []
  const slaContracts = contracts ?? []
  const topLevelCategories = categories.filter((c) => c.parent_id === null)

  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/sla', params, mudancas)
  const tipo = lerTipo(params.tipo)
  const gavetaAberta = Boolean(tipo && (params.aberto || params.novo))
  const fechar = endereco({ tipo: null, aberto: null, novo: null })

  /** O link que abre um dos quatro cadastros — em branco ou num registro. */
  const abrir = (t: string, alvo: { aberto?: string; novo?: boolean }) =>
    endereco({
      tipo: t,
      aberto: alvo.aberto ?? null,
      novo: alvo.novo ? '1' : null,
    }) as Route

  /* O mesmo botão nos quatro cartões: "+ Nova prioridade" dentro do cartão de
     prioridades, e não um botão só no cabeçalho da página — são quatro
     cadastros diferentes, e um botão genérico exigiria escolher o tipo depois
     de clicar. */
  const botaoNovo = (t: string, rotulo: string) => (
    <Link
      href={abrir(t, { novo: true })}
      data-testid={`novo-${t}`}
      className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-sm font-medium text-[var(--color-brand-ink)] hover:bg-[var(--color-surface-2)]"
    >
      {rotulo}
    </Link>
  )

  const linkEditar = (t: string, id: string) => (
    <Link
      href={abrir(t, { aberto: id })}
      data-testid="abrir-registro"
      className="text-sm font-medium text-[var(--color-brand-ink)] hover:underline"
    >
      Editar
    </Link>
  )

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && tipo && (
        <GavetaDeSla
          tipo={tipo}
          id={params.aberto}
          novo={Boolean(params.novo)}
          fechar={fechar}
        />
      )}

      <PageHeader
        title="SLA"
        description="Compliance por período e fila, e a configuração de categorias, prioridades, contratos e definições."
      />

      {semSla > 0 && (
        <div className="mb-6">
          <Card>
            <p className="text-sm font-semibold text-[var(--color-warn-ink)]">
              {semSla} ticket(s) sem SLA aplicável
            </p>
            <p className="mt-1 text-sm text-[var(--color-ink-2)]">
              Nenhuma definição casou com a combinação de contrato, categoria e prioridade desses
              tickets. Eles foram criados normalmente, mas não são medidos — cadastre uma definição
              padrão do tenant para cobrir os casos restantes.
            </p>
          </Card>
        </div>
      )}

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold text-[var(--color-ink)]">
          Compliance por mês e fila
        </h2>
        <p className="mb-2 text-sm text-[var(--color-ink-2)]">
          Últimos 12 meses. O percentual é sobre os tickets cobertos por uma definição de SLA —
          ticket sem prazo definido não tem o que cumprir.
        </p>
        {linhasCompliance.length > 0 ? (
          <Table
            label="Compliance de SLA por período"
            head={['Período', 'Fila', 'Tickets', 'Com SLA', 'Resolução', 'Resposta', 'Violações']}
          >
            {linhasCompliance.map((row) => (
              <tr key={`${row.period}-${row.queue_name}`}>
                <Td className="tabular-nums text-[var(--color-ink-2)]">{formatDate(row.period)}</Td>
                <Td className="font-medium text-[var(--color-ink)]">{row.queue_name}</Td>
                <Td className="tabular-nums">{row.tickets_total}</Td>
                <Td className="tabular-nums text-[var(--color-ink-2)]">{row.tickets_with_sla}</Td>
                <Td>
                  <Badge tone={complianceTone(row.resolution_compliance_pct)}>
                    {row.resolution_compliance_pct !== null
                      ? `${row.resolution_compliance_pct}%`
                      : '—'}
                  </Badge>
                </Td>
                <Td>
                  <Badge tone={complianceTone(row.response_compliance_pct)}>
                    {row.response_compliance_pct !== null
                      ? `${row.response_compliance_pct}%`
                      : '—'}
                  </Badge>
                </Td>
                <Td className="tabular-nums text-[var(--color-ink-2)]">
                  {row.resolution_breaches} resol. · {row.response_breaches} resp.
                </Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title="Sem dados de compliance ainda" />
        )}
      </section>

      {mostraConfiguracao && (
        <>
          <h2 className="mb-3 text-lg font-semibold text-[var(--color-ink)]">Configuração</h2>
          <div className="grid gap-6 xl:grid-cols-2">
            {verCategorias && (
              <Card
                title="Categorias"
                action={criarCategoria && botaoNovo('categoria', '+ Nova categoria')}
              >
                <div className="flex flex-col gap-3">
                  {categories.length === 0 && <EmptyState title="Nenhuma categoria cadastrada" />}
                  {topLevelCategories.map((parent) => {
                    const children = categories.filter((c) => c.parent_id === parent.id)
                    return (
                      <div
                        key={parent.id}
                        className="rounded-lg border border-[var(--color-border)] p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium text-[var(--color-ink)]">{parent.name}</span>
                          <div className="flex items-center gap-2">
                            {parent.is_active ? (
                              <Badge tone="ok">Ativa</Badge>
                            ) : (
                              <Badge>Inativa</Badge>
                            )}
                            {editarCategoria && linkEditar('categoria', parent.id)}
                          </div>
                        </div>
                        {children.length > 0 && (
                          <ul className="mt-2 flex flex-col gap-1.5 border-l border-[var(--color-border)] pl-3">
                            {children.map((child) => (
                              <li
                                key={child.id}
                                className="flex flex-wrap items-center justify-between gap-2"
                              >
                                <span className="text-sm text-[var(--color-ink-2)]">
                                  {child.name}
                                </span>
                                <div className="flex items-center gap-2">
                                  {child.is_active ? (
                                    <Badge tone="ok">Ativa</Badge>
                                  ) : (
                                    <Badge>Inativa</Badge>
                                  )}
                                  {editarCategoria && linkEditar('categoria', child.id)}
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )
                  })}
                </div>
              </Card>
            )}

            {verPrioridades && (
              <Card
                title="Prioridades"
                action={criarPrioridade && botaoNovo('prioridade', '+ Nova prioridade')}
              >
                <div className="flex flex-col gap-2">
                  {priorities.length === 0 && <EmptyState title="Nenhuma prioridade cadastrada" />}
                  {priorities.map((p) => (
                    <div
                      key={p.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] p-3"
                    >
                      <span
                        className="inline-flex items-center gap-2 font-medium"
                        style={{ color: p.color }}
                      >
                        <span
                          aria-hidden="true"
                          className="inline-block size-2.5 rounded-full"
                          style={{ background: p.color }}
                        />
                        {p.label}
                        <span className="text-xs text-[var(--color-ink-3)]">peso {p.weight}</span>
                      </span>
                      <div className="flex items-center gap-2">
                        {p.is_active ? <Badge tone="ok">Ativa</Badge> : <Badge>Inativa</Badge>}
                        {editarPrioridade && linkEditar('prioridade', p.id)}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {verContratos && (
              <Card
                title="Contratos de SLA"
                action={criarContrato && botaoNovo('contrato', '+ Novo contrato')}
              >
                <div className="flex flex-col gap-2">
                  {slaContracts.length === 0 && (
                    <EmptyState title="Nenhum contrato de SLA cadastrado" />
                  )}
                  {slaContracts.map((c) => (
                    <div
                      key={c.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] p-3"
                    >
                      <span className="font-medium text-[var(--color-ink)]">{c.name}</span>
                      <div className="flex items-center gap-2">
                        {c.is_active ? <Badge tone="ok">Ativo</Badge> : <Badge>Inativo</Badge>}
                        {editarContrato && linkEditar('contrato', c.id)}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {verDefinicoes && (
              <Card
                title="Definições de SLA"
                action={criarDefinicao && botaoNovo('definicao', '+ Nova definição')}
              >
                {definitions && definitions.length > 0 ? (
                  <Table
                    head={[
                      'Contrato',
                      'Categoria',
                      'Prioridade',
                      '1ª resposta',
                      'Resolução',
                      'Situação',
                      editarDefinicao ? 'Ajustar' : '',
                    ]}
                    label="Definições de SLA"
                  >
                    {definitions.map((d) => (
                      <tr key={d.id}>
                        <Td className="text-[var(--color-ink-2)]">
                          {d.contract?.name ?? 'Padrão do tenant'}
                        </Td>
                        <Td className="text-[var(--color-ink-2)]">{d.category?.name ?? 'Todas'}</Td>
                        <Td>
                          <span className="font-semibold" style={{ color: d.priority?.color }}>
                            {d.priority?.label ?? '—'}
                          </span>
                        </Td>
                        <Td className="tabular-nums">{formatMinutes(d.first_response_minutes)}</Td>
                        <Td className="tabular-nums">{formatMinutes(d.resolution_minutes)}</Td>
                        <Td>{d.is_active ? <Badge tone="ok">Ativa</Badge> : <Badge>Inativa</Badge>}</Td>
                        <Td>{editarDefinicao && linkEditar('definicao', d.id)}</Td>
                      </tr>
                    ))}
                  </Table>
                ) : (
                  <EmptyState title="Nenhuma definição de SLA cadastrada" />
                )}
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  )
}
