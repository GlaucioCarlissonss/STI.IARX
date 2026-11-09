import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { agruparPor } from '@/lib/data/agrupar'
import { requireScreen, allowed } from '@/lib/session'
import { formatCnpj, formatCurrency, formatDate, formatMinutes } from '@/lib/format'
import type { Supplier, SupplierContract } from '@/lib/types'
import { comParametros } from '@/lib/data/endereco'
import { Badge, Card, EmptyState, PageHeader, Table, Td } from '@/components/ui'
import { GavetaDeFornecedor } from './gaveta'

export const metadata: Metadata = { title: 'Fornecedores' }

export default async function FornecedoresPage({
  searchParams,
}: {
  searchParams: Promise<{ aberto?: string; novo?: string }>
}) {
  const params = await searchParams
  await requireScreen('fornecedores.cadastro.ver')
  /*
   * `fornecedores.contratos.ver` governa a seção de contratos. Sem ela nem a
   * consulta sai: a chave existia no catálogo sem ser lida em lugar nenhum, o
   * que fazia o administrador desmarcar e nada mudar.
   */
  const [podeEditar, podeCriar, podeVerContrato] = await Promise.all([
    allowed('fornecedores.cadastro.editar'),
    allowed('fornecedores.cadastro.criar'),
    allowed('fornecedores.contratos.ver'),
  ])
  const supabase = await createClient()

  const [{ data: suppliers }, { data: contracts }] = await Promise.all([
    supabase
      .from('suppliers')
      .select('id, name, legal_name, cnpj, email, phone, services, rating, is_active')
      .is('deleted_at', null)
      .order('name')
      .returns<Supplier[]>(),
    podeVerContrato
      ? supabase
          .from('supplier_contracts')
          .select(
            'id, supplier_id, contract_number, description, starts_on, ends_on, monthly_cost, response_sla_minutes, resolution_sla_minutes, is_active',
          )
          .order('starts_on', { ascending: false })
          .returns<SupplierContract[]>()
      : { data: [] as SupplierContract[] },
  ])

  const list = suppliers ?? []
  const bySupplier = agruparPor(contracts, 'supplier_id')

  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/fornecedores', params, mudancas)

  const gavetaAberta = Boolean(params.aberto || params.novo)

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && (
        <GavetaDeFornecedor
          id={params.aberto}
          novo={Boolean(params.novo)}
          fechar={endereco({ aberto: null, novo: null })}
        />
      )}

      <PageHeader
        title="Fornecedores"
        description="Prestadores de serviço de TI, contratos vigentes e SLAs contratados."
        action={
          podeCriar && (
            <Link
              href={endereco({ novo: '1' }) as Route}
              data-testid="novo-registro"
              className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
            >
              Novo fornecedor
            </Link>
          )
        }
      />

      <div>
        <div className="flex flex-col gap-4">
          {list.length === 0 && <EmptyState title="Nenhum fornecedor cadastrado" />}

          {list.map((s) => {
            const supplierContracts = bySupplier.get(s.id) ?? []
            return (
              <Card key={s.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-[var(--color-ink)]">
                      <Link
                        href={endereco({ aberto: s.id }) as Route}
                        data-testid="abrir-registro"
                        className="text-[var(--color-brand-ink)] hover:underline"
                      >
                        {s.name}
                      </Link>
                    </h2>
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

                {podeVerContrato && supplierContracts.length > 0 && (
                  <div className="mt-4">
                    <Table
                      label="Contratos do fornecedor"
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
                          <tr key={c.id}>
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
                      ))}
                    </Table>
                  </div>
                )}

                {/* Editar o fornecedor e mexer nos contratos dele acontece na
                    gaveta: aqui a tela é de consulta, e consulta não precisa de
                    formulário embutido em cada cartão. */}
                {podeEditar && (
                  <div className="mt-4">
                    <Link
                      href={endereco({ aberto: s.id }) as Route}
                      className="text-sm font-semibold text-[var(--color-brand-ink)] hover:underline"
                    >
                      Editar fornecedor e contratos ›
                    </Link>
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      </div>
    </div>
  )
}
