import { Fragment } from 'react'
import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { formatCnpj, formatCurrency, formatDate, formatMinutes } from '@/lib/format'
import type { Supplier, SupplierContract } from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader, Table, Td } from '@/components/ui'
import { EditPanel } from '@/components/edit-panel'
import { EditSupplierForm, NewSupplierForm } from './supplier-forms'
import { EditSupplierContractForm, NewSupplierContractForm } from './supplier-contract-forms'

export const metadata: Metadata = { title: 'Fornecedores' }

export default async function FornecedoresPage() {
  await requireScreen('fornecedores.cadastro.ver')
  const [podeEditar, podeCriar, podeEditarContrato, podeCriarContrato] = await Promise.all([
    allowed('fornecedores.cadastro.editar'),
    allowed('fornecedores.cadastro.criar'),
    allowed('fornecedores.contratos.editar'),
    allowed('fornecedores.contratos.criar'),
  ])
  const supabase = await createClient()

  const [{ data: suppliers }, { data: contracts }] = await Promise.all([
    supabase
      .from('suppliers')
      .select('id, name, legal_name, cnpj, email, phone, services, rating, is_active')
      .is('deleted_at', null)
      .order('name')
      .returns<Supplier[]>(),
    supabase
      .from('supplier_contracts')
      .select(
        'id, supplier_id, contract_number, description, starts_on, ends_on, monthly_cost, response_sla_minutes, resolution_sla_minutes, is_active',
      )
      .order('starts_on', { ascending: false })
      .returns<SupplierContract[]>(),
  ])

  const list = suppliers ?? []
  const bySupplier = new Map<string, SupplierContract[]>()
  for (const c of contracts ?? []) {
    bySupplier.set(c.supplier_id, [...(bySupplier.get(c.supplier_id) ?? []), c])
  }

  return (
    <>
      <PageHeader
        title="Fornecedores"
        description="Prestadores de serviço de TI, contratos vigentes e SLAs contratados."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="flex flex-col gap-4">
          {list.length === 0 && <EmptyState title="Nenhum fornecedor cadastrado" />}

          {list.map((s) => {
            const supplierContracts = bySupplier.get(s.id) ?? []
            return (
              <Card key={s.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-[var(--color-ink)]">{s.name}</h2>
                    <p className="text-xs text-[var(--color-ink-3)]">
                      {s.legal_name ?? '—'} · {formatCnpj(s.cnpj)}
                    </p>
                    <p className="mt-1 text-xs text-[var(--color-ink-2)]">
                      {[s.email, s.phone].filter(Boolean).join(' · ') || 'Sem contato cadastrado'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {s.rating !== null && (
                      <Badge tone={s.rating >= 4 ? 'ok' : s.rating >= 3 ? 'warn' : 'breach'}>
                        Avaliação {s.rating.toFixed(1)}
                      </Badge>
                    )}
                    {s.is_active ? <Badge tone="ok">Ativo</Badge> : <Badge>Inativo</Badge>}
                  </div>
                </div>

                {s.services.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {s.services.map((svc) => (
                      <Badge key={svc} tone="neutral">
                        {svc}
                      </Badge>
                    ))}
                  </div>
                )}

                {supplierContracts.length > 0 && (
                  <div className="mt-4">
                    <Table
                      head={[
                        'Contrato',
                        'Vigência',
                        'Custo mensal',
                        'SLA resposta',
                        'SLA resolução',
                        'Situação',
                      ]}
                    >
                      {supplierContracts.map((c) => (
                        <Fragment key={c.id}>
                          <tr>
                            <Td>
                              <span className="font-medium text-[var(--color-ink)]">
                                {c.contract_number ?? '—'}
                              </span>
                              <p className="text-xs text-[var(--color-ink-3)]">{c.description ?? ''}</p>
                            </Td>
                            <Td className="text-[var(--color-ink-2)]">
                              {formatDate(c.starts_on)} → {c.ends_on ? formatDate(c.ends_on) : 'indeterminado'}
                            </Td>
                            <Td className="tabular-nums">{formatCurrency(c.monthly_cost)}</Td>
                            <Td className="tabular-nums">{formatMinutes(c.response_sla_minutes)}</Td>
                            <Td className="tabular-nums">{formatMinutes(c.resolution_sla_minutes)}</Td>
                            <Td>
                              {c.is_active ? <Badge tone="ok">Ativo</Badge> : <Badge>Inativo</Badge>}
                            </Td>
                          </tr>
                          {podeEditarContrato && (
                            <tr>
                              <Td className="bg-[var(--color-surface-2)]" colSpan={6}>
                                <EditPanel title={`Editar contrato ${c.contract_number ?? ''}`}>
                                  <EditSupplierContractForm contract={c} />
                                </EditPanel>
                              </Td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </Table>
                  </div>
                )}

                {/* Ocupa a largura do cartão: espremido na coluna dos selos, o
                    formulário viraria uma tira de campos de 6rem. */}
                {(podeEditar || podeCriarContrato) && (
                  <div className="mt-4 flex flex-col gap-3">
                    {podeEditar && (
                      <EditPanel title={`Editar ${s.name}`}>
                        <EditSupplierForm supplier={s} />
                      </EditPanel>
                    )}
                    {podeCriarContrato && (
                      <EditPanel label="+ Novo contrato">
                        <NewSupplierContractForm supplierId={s.id} />
                      </EditPanel>
                    )}
                  </div>
                )}
              </Card>
            )
          })}
        </div>

        {podeCriar && (
          <Card title="Novo fornecedor">
            <NewSupplierForm />
          </Card>
        )}
      </div>
    </>
  )
}
