import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireRole } from '@/lib/session'
import { formatDate, formatMinutes } from '@/lib/format'
import { Badge, Card, EmptyState, PageHeader, Table, Td } from '@/components/ui'

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

interface DefinitionRow {
  id: string
  first_response_minutes: number
  resolution_minutes: number
  is_active: boolean
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
  await requireRole(['super_admin', 'admin', 'gestor'])
  const supabase = await createClient()

  const [{ data: compliance }, { data: definitions }, { data: uncovered }] = await Promise.all([
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
        'id, first_response_minutes, resolution_minutes, is_active, priority:ticket_priorities(label, color), category:ticket_categories(name), contract:sla_contracts(name)',
      )
      .order('resolution_minutes')
      .returns<DefinitionRow[]>(),
    // Cobertura: tickets que nenhuma definição de SLA alcançou. É o relatório
    // que revela buracos de configuração antes que o cliente reclame.
    supabase.from('sla_tracking').select('ticket_id', { count: 'exact', head: true }).eq('coverage', 'uncovered'),
  ])

  const uncoveredCount = (uncovered as unknown as { count: number } | null)?.count ?? 0

  return (
    <>
      <PageHeader
        title="SLA"
        description="Compliance por período e fila, e as definições vigentes."
      />

      {uncoveredCount > 0 && (
        <div className="mb-6">
          <Card>
            <p className="text-sm font-semibold text-[var(--color-warn-ink)]">
              {uncoveredCount} ticket(s) sem SLA aplicável
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

      <section>
        <h2 className="mb-3 text-lg font-semibold text-[var(--color-ink)]">Definições vigentes</h2>
        {definitions && definitions.length > 0 ? (
          <Table head={['Contrato', 'Categoria', 'Prioridade', 'Primeira resposta', 'Resolução', '']}>
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
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title="Nenhuma definição de SLA cadastrada" />
        )}
      </section>
    </>
  )
}
