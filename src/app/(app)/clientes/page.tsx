import { Fragment } from 'react'
import type { Metadata } from 'next'
import { requireScreen, allowed } from '@/lib/session'
import { createClient } from '@/lib/supabase/server'
import { getBranches, getBusinessHours, getClients } from '@/lib/data/lookups'
import { formatCnpj } from '@/lib/format'
import { areaKindLabel } from '@/lib/i18n'
import type { BranchArea } from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader, Table, Td } from '@/components/ui'
import { EditPanel } from '@/components/edit-panel'
import { EditBranchForm, EditClientForm, NewClientForm, NewBranchForm } from './forms'
import { EditAreaForm, NewAreaForm, SeedAreasForm } from './area-forms'

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
    podeVerArea,
    podeCriarArea,
    podeEditarArea,
    podeInativarArea,
  ] = await Promise.all([
    allowed('clientes.grupos.editar'),
    allowed('clientes.grupos.criar'),
    allowed('clientes.filiais.ver'),
    allowed('clientes.filiais.editar'),
    allowed('clientes.filiais.criar'),
    allowed('clientes.areas.ver'),
    allowed('clientes.areas.criar'),
    allowed('clientes.areas.editar'),
    allowed('clientes.areas.inativar'),
  ])

  const supabase = await createClient()
  const [clients, branches, businessHours, { data: areas }] = await Promise.all([
    getClients(),
    getBranches(),
    getBusinessHours(),
    // Uma consulta para todas as filiais, agrupada em memória. Uma por filial
    // viraria N+1 no primeiro cliente com muitas unidades.
    podeVerArea
      ? supabase
          .from('branch_areas')
          .select('id, branch_id, name, code, kind, is_active, sort_order')
          .order('sort_order')
          .returns<BranchArea[]>()
      : { data: null },
  ])

  const areasPorFilial = new Map<string, BranchArea[]>()
  for (const a of areas ?? []) {
    areasPorFilial.set(a.branch_id, [...(areasPorFilial.get(a.branch_id) ?? []), a])
  }

  /* A linha do painel aparece para quem edita a filial OU alcança as áreas: são
     dois assuntos distintos, e exigir a permissão de filial para ver a área
     esconderia o cadastro de quem justamente o administra. */
  const abrePainelFilial = podeEditarFilial || podeVerArea

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
                            {abrePainelFilial && (
                              <tr>
                                <Td className="bg-[var(--color-surface-2)]" colSpan={5}>
                                  <EditPanel title={`Editar ${b.name}`}>
                                    <div className="flex flex-col gap-5">
                                      {podeEditarFilial && (
                                        <EditBranchForm
                                          branch={b}
                                          clients={clients}
                                          businessHours={businessHours}
                                        />
                                      )}
                                      {podeVerArea && (
                                        <AreasDaFilial
                                          branchId={b.id}
                                          areas={areasPorFilial.get(b.id) ?? []}
                                          podeCriar={podeCriarArea}
                                          podeEditar={podeEditarArea}
                                          podeInativar={podeInativarArea}
                                        />
                                      )}
                                    </div>
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

/**
 * Painel de áreas de uma filial.
 *
 * Server Component: decide por permissão aqui, então o formulário de cadastro
 * nem chega ao HTML de quem não pode criar. Os controles interativos moram em
 * `area-forms.tsx`, que é cliente.
 */
function AreasDaFilial({
  branchId,
  areas,
  podeCriar,
  podeEditar,
  podeInativar,
}: {
  branchId: string
  areas: BranchArea[]
  podeCriar: boolean
  podeEditar: boolean
  podeInativar: boolean
}) {
  const ativas = areas.filter((a) => a.is_active).length

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">Áreas da filial</h3>
        <span className="text-xs text-[var(--color-ink-3)]">
          {areas.length === 0
            ? 'nenhuma área'
            : `${ativas} ativa(s) de ${areas.length}`}
        </span>
      </div>

      {areas.length === 0 ? (
        <p className="mb-3 text-sm text-[var(--color-ink-2)]">
          Sem área cadastrada, ativo, linha e link desta filial ficam sem lugar. Comece pelas
          áreas padrão e ajuste depois.
        </p>
      ) : (
        <ul className="mb-3 flex flex-col gap-1.5">
          {areas.map((a) => (
            <li
              key={a.id}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-[var(--color-ink)]">
                  {a.name}
                  {a.code && (
                    <span className="ml-2 font-mono text-xs text-[var(--color-ink-3)]">{a.code}</span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={a.kind === 'assistencial' ? 'warn' : 'neutral'}>
                    {areaKindLabel[a.kind] ?? a.kind}
                  </Badge>
                  {!a.is_active && <Badge>Inativa</Badge>}
                </span>
              </div>
              {(podeEditar || podeInativar) && (
                <div className="mt-2">
                  <EditPanel label="Editar área" title={`Editar ${a.name}`}>
                    <EditAreaForm area={a} canDeactivate={podeInativar} />
                  </EditPanel>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {podeCriar && (
        <div className="flex flex-col gap-3">
          {areas.length === 0 && <SeedAreasForm branchId={branchId} />}
          <EditPanel label="Nova área" title="Nova área">
            <NewAreaForm branchId={branchId} />
          </EditPanel>
        </div>
      )}
    </section>
  )
}
