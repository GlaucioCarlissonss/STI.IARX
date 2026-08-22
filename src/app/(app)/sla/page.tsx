import { Fragment } from 'react'
import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { getBranches, getBusinessHours, getCategories, getClients, getPriorities } from '@/lib/data/lookups'
import { formatDate, formatMinutes } from '@/lib/format'
import type { Category, Priority, SlaContract } from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader, Table, Td } from '@/components/ui'
import { EditPanel } from '@/components/edit-panel'
import { EditCategoryForm, NewCategoryForm } from './category-forms'
import { EditPriorityForm, NewPriorityForm } from './priority-forms'
import { EditSlaContractForm, NewSlaContractForm } from './sla-contract-forms'
import { EditSlaDefinitionForm, NewSlaDefinitionForm, type SlaDefinitionDefaults } from './sla-definition-forms'

export const metadata: Metadata = { title: 'SLA' }

interface ComplianceRow {
  period: string
  queue_name: string
  tickets_total: number
  tickets_with_sla: number
  response_breaches: number
  resolution_breaches: number
  resolution_compliance_pct: number | null
  response_compliance_pct: number | null
}

interface DefinitionRow extends SlaDefinitionDefaults {
  priority: { label: string; color: string } | null
  category: { name: string } | null
  contract: { name: string } | null
}

/** Compliance abaixo de 95% é o limiar em que a operação precisa reagir. */
function complianceTone(pct: number | null) {
  if (pct === null) return 'neutral' as const
  if (pct >= 95) return 'ok' as const
  if (pct >= 85) return 'warn' as const
  return 'breach' as const
}

export default async function SlaPage() {
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

  const [
    { data: compliance },
    { data: definitions },
    { count: uncoveredCount },
    { data: allCategories },
    { data: allPriorities },
    { data: contracts },
    clients,
    branches,
    businessHours,
    activeCategories,
    activePriorities,
  ] = await Promise.all([
    supabase
      .from('vw_sla_compliance')
      .select(
        'period, queue_name, tickets_total, tickets_with_sla, response_breaches, resolution_breaches, resolution_compliance_pct, response_compliance_pct',
      )
      .order('period', { ascending: false })
      .limit(40)
      .returns<ComplianceRow[]>(),
    supabase
      .from('sla_definitions')
      .select(
        'id, contract_id, category_id, priority_id, first_response_minutes, resolution_minutes, business_hours_id, is_active, priority:ticket_priorities(label, color), category:ticket_categories(name), contract:sla_contracts(name)',
      )
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
    supabase
      .from('sla_contracts')
      .select('id, client_id, branch_id, name, business_hours_id, valid_from, valid_to, is_active, notes')
      .order('name')
      .returns<SlaContract[]>(),
    getClients(),
    getBranches(),
    getBusinessHours(),
    getCategories(),
    getPriorities(),
  ])

  // Com `{ count: 'exact', head: true }` o Supabase devolve `data: null` e o
  // total no campo `count`, IRMÃO de `data` — não dentro dele. Ler de `data`
  // (como estava antes) sempre dava `undefined`, e o card de "tickets sem
  // SLA aplicável" nunca aparecia, mesmo com cobertura furada de verdade.
  const semSla = uncoveredCount ?? 0

  const categories = allCategories ?? []
  const priorities = allPriorities ?? []
  const slaContracts = contracts ?? []
  const topLevelCategories = categories.filter((c) => c.parent_id === null)
  const contractLookups = { clients, branches, businessHours }
  const definitionLookups = {
    contracts: slaContracts,
    categories: activeCategories,
    priorities: activePriorities,
    businessHours,
  }

  return (
    <>
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
        {compliance && compliance.length > 0 ? (
          <Table
            head={['Período', 'Fila', 'Tickets', 'Com SLA', 'Resolução', 'Resposta', 'Violações']}
          >
            {compliance.map((row, i) => (
              <tr key={`${row.period}-${row.queue_name}-${i}`}>
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
              <Card title="Categorias">
                <div className="flex flex-col gap-3">
                  {categories.length === 0 && <EmptyState title="Nenhuma categoria cadastrada" />}
                  {topLevelCategories.map((parent) => {
                    const children = categories.filter((c) => c.parent_id === parent.id)
                    return (
                      <div key={parent.id} className="rounded-lg border border-[var(--color-border)] p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium text-[var(--color-ink)]">{parent.name}</span>
                          <div className="flex items-center gap-2">
                            {parent.is_active ? <Badge tone="ok">Ativa</Badge> : <Badge>Inativa</Badge>}
                            {editarCategoria && (
                              <EditPanel title={`Editar ${parent.name}`}>
                                <EditCategoryForm category={parent} topLevel={topLevelCategories} />
                              </EditPanel>
                            )}
                          </div>
                        </div>
                        {children.length > 0 && (
                          <ul className="mt-2 flex flex-col gap-1.5 border-l border-[var(--color-border)] pl-3">
                            {children.map((child) => (
                              <li key={child.id} className="flex flex-wrap items-center justify-between gap-2">
                                <span className="text-sm text-[var(--color-ink-2)]">{child.name}</span>
                                <div className="flex items-center gap-2">
                                  {child.is_active ? <Badge tone="ok">Ativa</Badge> : <Badge>Inativa</Badge>}
                                  {editarCategoria && (
                                    <EditPanel title={`Editar ${child.name}`}>
                                      <EditCategoryForm category={child} topLevel={topLevelCategories} />
                                    </EditPanel>
                                  )}
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )
                  })}
            </div>

            {criarCategoria && (
              <div className="mt-4 border-t border-[var(--color-border)] pt-4">
                <EditPanel label="+ Nova categoria">
                  <NewCategoryForm topLevel={topLevelCategories} />
                </EditPanel>
              </div>
            )}
          </Card>
            )}

            {verPrioridades && (
          <Card title="Prioridades">
            <div className="flex flex-col gap-2">
              {priorities.length === 0 && <EmptyState title="Nenhuma prioridade cadastrada" />}
              {priorities.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] p-3"
                >
                  <span className="inline-flex items-center gap-2 font-medium" style={{ color: p.color }}>
                    <span aria-hidden="true" className="inline-block size-2.5 rounded-full" style={{ background: p.color }} />
                    {p.label}
                    <span className="text-xs text-[var(--color-ink-3)]">peso {p.weight}</span>
                  </span>
                  <div className="flex items-center gap-2">
                    {p.is_active ? <Badge tone="ok">Ativa</Badge> : <Badge>Inativa</Badge>}
                    {editarPrioridade && (
                      <EditPanel title={`Editar ${p.label}`}>
                        <EditPriorityForm priority={p} />
                      </EditPanel>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {criarPrioridade && (
              <div className="mt-4 border-t border-[var(--color-border)] pt-4">
                <EditPanel label="+ Nova prioridade">
                  <NewPriorityForm />
                </EditPanel>
              </div>
            )}
          </Card>
            )}

            {verContratos && (
          <Card title="Contratos de SLA">
            <div className="flex flex-col gap-2">
              {slaContracts.length === 0 && <EmptyState title="Nenhum contrato de SLA cadastrado" />}
              {slaContracts.map((c) => (
                <div
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] p-3"
                >
                  <span className="font-medium text-[var(--color-ink)]">{c.name}</span>
                  <div className="flex items-center gap-2">
                    {c.is_active ? <Badge tone="ok">Ativo</Badge> : <Badge>Inativo</Badge>}
                    {editarContrato && (
                      <EditPanel title={`Editar ${c.name}`}>
                        <EditSlaContractForm contract={c} {...contractLookups} />
                      </EditPanel>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {criarContrato && (
              <div className="mt-4 border-t border-[var(--color-border)] pt-4">
                <EditPanel label="+ Novo contrato de SLA">
                  <NewSlaContractForm {...contractLookups} />
                </EditPanel>
              </div>
            )}
          </Card>
            )}

            {verDefinicoes && (
          <Card title="Definições de SLA">
            {definitions && definitions.length > 0 ? (
              <Table head={['Contrato', 'Categoria', 'Prioridade', '1ª resposta', 'Resolução', '', '']}>
                {definitions.map((d) => (
                  <Fragment key={d.id}>
                    <tr>
                      <Td className="text-[var(--color-ink-2)]">{d.contract?.name ?? 'Padrão do tenant'}</Td>
                      <Td className="text-[var(--color-ink-2)]">{d.category?.name ?? 'Todas'}</Td>
                      <Td>
                        <span className="font-semibold" style={{ color: d.priority?.color }}>
                          {d.priority?.label ?? '—'}
                        </span>
                      </Td>
                      <Td className="tabular-nums">{formatMinutes(d.first_response_minutes)}</Td>
                      <Td className="tabular-nums">{formatMinutes(d.resolution_minutes)}</Td>
                      <Td>{d.is_active ? <Badge tone="ok">Ativa</Badge> : <Badge>Inativa</Badge>}</Td>
                      <Td>
                        {editarDefinicao && (
                          <EditPanel title="Editar definição de SLA">
                            <EditSlaDefinitionForm definition={d} {...definitionLookups} />
                          </EditPanel>
                        )}
                      </Td>
                    </tr>
                  </Fragment>
                ))}
              </Table>
            ) : (
              <EmptyState title="Nenhuma definição de SLA cadastrada" />
            )}

            {criarDefinicao && (
              <div className="mt-4 border-t border-[var(--color-border)] pt-4">
                <EditPanel label="+ Nova definição de SLA">
                  <NewSlaDefinitionForm {...definitionLookups} />
                </EditPanel>
              </div>
            )}
          </Card>
            )}
          </div>
        </>
      )}
    </>
  )
}
