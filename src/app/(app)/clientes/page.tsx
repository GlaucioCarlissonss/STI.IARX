import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireRole } from '@/lib/session'
import { getBranches, getClients } from '@/lib/data/lookups'
import { formatCnpj } from '@/lib/format'
import { Badge, Card, EmptyState, PageHeader, Table, Td } from '@/components/ui'
import { NewClientForm, NewBranchForm } from './forms'

export const metadata: Metadata = { title: 'Clientes e filiais' }

export default async function ClientesPage() {
  await requireRole(['super_admin', 'admin', 'gestor'])
  const supabase = await createClient()

  const [clients, branches, { data: businessHours }] = await Promise.all([
    getClients(),
    getBranches(),
    supabase.from('business_hours').select('id, name, is_24x7').order('name'),
  ])

  return (
    <>
      <PageHeader
        title="Clientes e filiais"
        description="Grupos econômicos atendidos e suas unidades. A filial define a visibilidade dos atendentes e o fuso usado no cálculo de SLA."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="flex flex-col gap-4">
          {clients.length === 0 && <EmptyState title="Nenhum cliente cadastrado" />}

          {clients.map((c) => {
            const clientBranches = branches.filter((b) => b.client_id === c.id)
            return (
              <Card key={c.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-[var(--color-ink)]">
                      {c.trade_name ?? c.legal_name}
                    </h2>
                    <p className="text-xs text-[var(--color-ink-3)]">
                      {c.legal_name} · {formatCnpj(c.cnpj)}
                    </p>
                  </div>
                  <Badge tone={c.status === 'active' ? 'ok' : 'neutral'}>
                    {c.status === 'active' ? 'Ativo' : c.status}
                  </Badge>
                </div>

                <div className="mt-4">
                  {clientBranches.length > 0 ? (
                    <Table head={['Filial', 'Código', 'Cidade / UF', 'Fuso horário', 'Situação']}>
                      {clientBranches.map((b) => (
                        <tr key={b.id}>
                          <Td className="font-medium text-[var(--color-ink)]">{b.name}</Td>
                          <Td className="font-mono text-xs text-[var(--color-ink-2)]">
                            {b.code ?? '—'}
                          </Td>
                          <Td className="text-[var(--color-ink-2)]">
                            {[b.city, b.state].filter(Boolean).join(' / ') || '—'}
                          </Td>
                          <Td className="text-[var(--color-ink-2)]">{b.timezone}</Td>
                          <Td>
                            {b.is_active ? <Badge tone="ok">Ativa</Badge> : <Badge>Inativa</Badge>}
                          </Td>
                        </tr>
                      ))}
                    </Table>
                  ) : (
                    <p className="text-sm italic text-[var(--color-ink-3)]">
                      Nenhuma filial cadastrada para este cliente.
                    </p>
                  )}
                </div>
              </Card>
            )
          })}
        </div>

        <div className="flex flex-col gap-6">
          <Card title="Novo cliente">
            <NewClientForm />
          </Card>
          <Card title="Nova filial">
            <NewBranchForm clients={clients} businessHours={businessHours ?? []} />
          </Card>
        </div>
      </div>
    </>
  )
}
