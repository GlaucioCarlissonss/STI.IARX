import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { requireScreen, allowed } from '@/lib/session'
import { escopoDeCliente } from '@/lib/data/escopo'
import { getBranches, getClients } from '@/lib/data/lookups'
import { formatCnpj } from '@/lib/format'
import { comParametros } from '@/lib/data/endereco'
import { Badge, Card, EmptyState, PageHeader, Table, Td } from '@/components/ui'
import { GavetaDeCliente } from './gaveta'

export const metadata: Metadata = { title: 'Clientes e filiais' }

export default async function ClientesPage({
  searchParams,
}: {
  searchParams: Promise<{
    aberto?: string
    filial?: string
    novo?: string
    novaFilial?: string
  }>
}) {
  const params = await searchParams
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
  ] = await Promise.all([
    allowed('clientes.grupos.editar'),
    allowed('clientes.grupos.criar'),
    allowed('clientes.filiais.ver'),
    allowed('clientes.filiais.editar'),
    allowed('clientes.filiais.criar'),
    /* As permissões de ESCRITA em área são conferidas na gaveta, onde a
       escrita acontece. A tela só precisa saber se a pessoa alcança as áreas
       para decidir se o nome da filial abre alguma coisa. */
    allowed('clientes.areas.ver'),
  ])

  const escopo = await escopoDeCliente()
  /* As ÁREAS saíram daqui: elas vivem dentro da gaveta da filial, e a tela
     trazia do banco as áreas de todas as filiais de todos os clientes para
     desenhar as de uma, quando alguém abrisse o painel. */
  const [todosClientes, todasFiliais] = await Promise.all([getClients(), getBranches()])

  /* Aqui o escopo é aplicado EM MEMÓRIA, não na consulta — é a única tela onde
     isso acontece, e por um motivo: `getClients()` é a mesma consulta que
     alimenta o seletor de foco no cabeçalho. Filtrá-la no banco deixaria o
     seletor com uma opção só e trancaria a pessoa dentro do cliente escolhido,
     sem caminho de volta. São poucas dezenas de linhas, já em cache de
     requisição; filtrar depois custa menos que uma segunda viagem ao banco. */
  const clients = escopo.clientId
    ? todosClientes.filter((c) => c.id === escopo.clientId)
    : todosClientes
  const branches = escopo.branchIds
    ? todasFiliais.filter((b) => escopo.branchIds!.includes(b.id))
    : todasFiliais

  /* A linha do painel aparece para quem edita a filial OU alcança as áreas: são
     dois assuntos distintos, e exigir a permissão de filial para ver a área
     esconderia o cadastro de quem justamente o administra. */
  const abrePainelFilial = podeEditarFilial || podeVerArea

  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/clientes', params, mudancas)

  const gavetaAberta = Boolean(
    params.aberto || params.filial || params.novo || params.novaFilial,
  )

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && (
        <GavetaDeCliente
          cliente={params.aberto}
          filial={params.filial}
          novo={Boolean(params.novo)}
          novaFilial={Boolean(params.novaFilial)}
          fechar={endereco({ aberto: null, filial: null, novo: null, novaFilial: null })}
        />
      )}

      <PageHeader
        title="Clientes e filiais"
        description="Grupos econômicos atendidos e suas unidades. A filial define a visibilidade dos atendentes e o fuso usado no cálculo de SLA."
        action={
          <div className="flex flex-wrap gap-2">
            {podeVerFilial && podeCriarFilial && (
              <Link
                href={endereco({ novaFilial: '1' }) as Route}
                className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
              >
                Nova filial
              </Link>
            )}
            {podeCriarCliente && (
              <Link
                href={endereco({ novo: '1' }) as Route}
                data-testid="novo-registro"
                className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
              >
                Novo cliente
              </Link>
            )}
          </div>
        }
      />

      <div>
        <div className="flex flex-col gap-4">
          {clients.length === 0 && <EmptyState title="Nenhum cliente cadastrado" />}

          {clients.map((c) => {
            const clientBranches = branches.filter((b) => b.client_id === c.id)
            return (
              <Card key={c.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  {/* `aria-hidden` no quadrado: a cor é reconhecimento de
                      relance, não informação. O nome está logo ao lado, e
                      anunciar "círculo azul" a cada cliente da lista só
                      acrescentaria ruído a quem usa leitor de tela. */}
                  <div className="flex items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className="mt-1 size-3 shrink-0 rounded-full ring-1 ring-inset ring-[var(--color-border-strong)]"
                      style={{ backgroundColor: c.color ?? '#64748b' }}
                    />
                    <div>
                      <h2 className="text-base font-semibold text-[var(--color-ink)]">
                        {podeEditarCliente ? (
                          <Link
                            href={endereco({ aberto: c.id }) as Route}
                            data-testid="abrir-registro"
                            className="text-[var(--color-brand-ink)] hover:underline"
                          >
                            {c.trade_name ?? c.legal_name}
                          </Link>
                        ) : (
                          (c.trade_name ?? c.legal_name)
                        )}
                      </h2>
                      <p className="text-xs text-[var(--color-ink-3)]">
                        {c.legal_name} · {formatCnpj(c.cnpj)}
                      </p>
                    </div>
                  </div>
                  <Badge tone={c.status === 'active' ? 'ok' : 'neutral'}>
                    {c.status === 'active' ? 'Ativo' : c.status}
                  </Badge>
                </div>

                {podeVerFilial && (
                  <div className="mt-4">
                    {clientBranches.length > 0 ? (
                      <Table
                        label="Filiais do cliente"
                        head={[
                          'Filial',
                          'Código',
                          'Cidade / UF',
                          'Fuso horário',
                          'Situação',
                        ]}
                      >
                        {clientBranches.map((b) => (
                            <tr key={b.id}>
                              <Td className="font-medium text-[var(--color-ink)]">
                                {abrePainelFilial ? (
                                  <Link
                                    href={endereco({ filial: b.id }) as Route}
                                    data-testid="abrir-filial"
                                    className="text-[var(--color-brand-ink)] hover:underline"
                                  >
                                    {b.name}
                                  </Link>
                                ) : (
                                  b.name
                                )}
                              </Td>
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
                )}
              </Card>
            )
          })}
        </div>
      </div>
    </div>
  )
}
