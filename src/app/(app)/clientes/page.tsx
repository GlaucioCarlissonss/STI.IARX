import { Fragment } from 'react'
import type { Metadata } from 'next'
import { requireScreen, allowed } from '@/lib/session'
import { getBranches, getBusinessHours, getClients } from '@/lib/data/lookups'
import { formatCnpj } from '@/lib/format'
import { Badge, Card, EmptyState, PageHeader, Table, Td } from '@/components/ui'
import { EditPanel } from '@/components/edit-panel'
import { EditBranchForm, EditClientForm, NewClientForm, NewBranchForm } from './forms'

export const metadata: Metadata = { title: 'Clientes e filiais' }

export default async function ClientesPage() {
  await requireScreen('clientes.grupos.ver')
  /*
   * `clientes.filiais.ver` governa a seção de filiais inteira — tabela e
   * formulário de cadastro. Antes ela existia no catálogo e não era consultada
   * em lugar nenhum: o administrador desmarcava e continuava tudo visível, que
   * é pior que não ter a chave.
   */
  const [
    podeEditarCliente,
    podeCriarCliente,
    podeVerFilial,
    podeEditarFilial,
    podeCriarFilial,
  ] = await Promise.all([
    allowed('clientes.grupos.editar'),
    allowed('clientes.grupos.criar'),
    allowed('clientes.filiais.ver'),
    allowed('clientes.filiais.editar'),
    allowed('clientes.filiais.criar'),
  ])

  const [clients, branches, businessHours] = await Promise.all([
    getClients(),
    getBranches(),
    getBusinessHours(),
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

                {/* Largura do cartão inteiro: na coluna dos selos o formulário
                    seria uma tira estreita de campos. */}
                {podeEditarCliente && (
                  <div className="mt-4">
                    <EditPanel title={`Editar ${c.trade_name ?? c.legal_name}`}>
                      <EditClientForm client={c} />
                    </EditPanel>
                  </div>
                )}

                {podeVerFilial && (
                  <div className="mt-4">
                    {clientBranches.length > 0 ? (
                      <Table
                        head={[
                          'Filial',
                          'Código',
                          'Cidade / UF',
                          'Fuso horário',
                          'Situação',
                        ]}
                      >
                        {clientBranches.map((b) => (
                          // O painel de edição ocupa uma linha própria, não a
                          // última célula: dentro de uma coluna estreita o
                          // formulário ficaria espremido a ponto de atrapalhar.
                          <Fragment key={b.id}>
                            <tr>
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
                            {podeEditarFilial && (
                              <tr>
                                <Td className="bg-[var(--color-surface-2)]" colSpan={5}>
                                  <EditPanel title={`Editar ${b.name}`}>
                                    <EditBranchForm
                                      branch={b}
                                      clients={clients}
                                      businessHours={businessHours}
                                    />
                                  </EditPanel>
                                </Td>
                              </tr>
                            )}
                          </Fragment>
                        ))}
                      </Table>
                    ) : (
                      <p className="text-sm italic text-[var(--color-ink-3)]">
                        Nenhuma filial cadastrada para este cliente.
                      </p>
                    )}
                  </div>
                )}
              </Card>
            )
          })}
        </div>

        <div className="flex flex-col gap-6">
          {podeCriarCliente && (
            <Card title="Novo cliente">
              <NewClientForm />
            </Card>
          )}
          {podeVerFilial && podeCriarFilial && (
            <Card title="Nova filial">
              <NewBranchForm clients={clients} businessHours={businessHours} />
            </Card>
          )}
        </div>
      </div>
    </>
  )
}
