import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { lerPagina, paginar } from '@/lib/data/paginacao'
import { formatDate } from '@/lib/format'
import { Badge, Card, EmptyState, PageHeader, Pager, StatTile, Table, Td } from '@/components/ui'

export const metadata: Metadata = { title: 'Base de conhecimento' }

interface LinhaDeArtigo {
  id: string
  title: string
  resumo: string | null
  category_name: string | null
  status: string
  visibilidade: string
  published_at: string | null
  updated_at: string
  views: number
  uteis: number
  inuteis: number
  author_name: string | null
}

const TOM_DO_STATUS: Record<string, 'ok' | 'warn' | 'neutral'> = {
  publicado: 'ok',
  rascunho: 'warn',
  arquivado: 'neutral',
}

/**
 * A base de conhecimento.
 *
 * ## O indicador que importa não é quantos artigos existem
 *
 * É quantos foram **escritos a partir de um chamado**. Bases de conhecimento
 * morrem porque ninguém escreve, e a tela de "novo artigo" fica em branco: a
 * pessoa que poderia escrever está com a fila cheia, e escrever não resolve o
 * chamado que está nela agora.
 *
 * O caminho que funciona é o inverso — do chamado resolvido para o artigo,
 * com o texto já montado. Por isso o indicador mede exatamente isso: se ele
 * estiver em zero, a base vai parar de crescer, independentemente de quantos
 * artigos já tenha.
 *
 * ## A busca é a tela
 *
 * Quem abre esta página não quer navegar uma lista: quer achar uma resposta. Por
 * isso a caixa de busca vem antes de tudo e a lista é apenas o que sobra quando
 * ninguém buscou nada.
 */
export default async function BasePage({
  searchParams,
}: {
  searchParams: Promise<{ pagina?: string; busca?: string; status?: string }>
}) {
  const params = await searchParams
  await requireScreen('autoatendimento.base.ver')
  const podeEscrever = await allowed('autoatendimento.base.escrever')

  const supabase = await createClient()
  const pagina = lerPagina(params.pagina)
  const busca = (params.busca ?? '').trim()
  const status = ['publicado', 'rascunho', 'arquivado'].includes(params.status ?? '')
    ? params.status!
    : null

  let consulta = supabase
    .from('vw_kb_articles')
    .select(
      'id, title, resumo, category_name, status, visibilidade, published_at, updated_at, views, uteis, inuteis, author_name',
      { count: 'exact' },
    )
  if (status) consulta = consulta.eq('status', status)
  if (busca) {
    /*
     * A busca de texto completo vive em `kb_articles.search_vector`, e a visão
     * agrega votos — então a visão não a carrega. Filtrar aqui por `ilike` no
     * título pareceria equivalente e perderia o corpo do artigo, que é onde está
     * a resposta.
     *
     * A subconsulta resolve: o `search_vector` filtra na tabela, a visão traz os
     * votos. Uma coluna de busca na visão exigiria agrupar por ela, e tsvector
     * não agrupa bem.
     */
    const { data: achados } = await supabase
      .from('kb_articles')
      .select('id')
      .textSearch('search_vector', busca, {
        type: 'websearch',
        config: 'public.portugues_sem_acento',
      })
      .limit(500)
    const ids = (achados ?? []).map((a) => a.id)
    consulta = consulta.in('id', ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000'])
  }

  const [{ data: linhas, count }, { data: universo }] = await Promise.all([
    paginar(
      consulta.order('published_at', { ascending: false, nullsFirst: false }),
      pagina,
    ).returns<LinhaDeArtigo[]>(),
    /* Os indicadores leem o acervo inteiro, e não a página — mesma lição da
       entrega 6. */
    supabase
      .from('kb_articles')
      .select('status, source_ticket_id, views')
      .is('deleted_at', null)
      .returns<{ status: string; source_ticket_id: string | null; views: number }[]>(),
  ])

  const todos = universo ?? []
  const publicados = todos.filter((a) => a.status === 'publicado').length
  const rascunhos = todos.filter((a) => a.status === 'rascunho').length
  const deChamado = todos.filter((a) => a.source_ticket_id !== null).length
  const leituras = todos.reduce((s, a) => s + a.views, 0)

  const lista = linhas ?? []
  const filtroHref = (valor: string | null): Route =>
    (valor ? `/base?status=${valor}` : '/base') as Route

  return (
    <>
      <PageHeader
        title="Base de conhecimento"
        description="A resposta que evita o chamado. Procure antes de abrir um."
        action={
          podeEscrever && (
            <Link
              href={'/base/novo' as Route}
              className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
            >
              Escrever artigo
            </Link>
          )
        }
      />

      <form className="mb-6 flex flex-wrap gap-2" role="search">
        <label className="sr-only" htmlFor="busca">
          Procurar na base de conhecimento
        </label>
        <input
          id="busca"
          name="busca"
          type="search"
          defaultValue={busca}
          placeholder="impressora não imprime, trocar senha, vpn…"
          className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)]"
        />
        <button
          type="submit"
          className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)]"
        >
          Procurar
        </button>
      </form>

      {podeEscrever && (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile label="Artigos publicados" value={publicados} />
          {/* O indicador que importa. Ver o comentário do componente. */}
          <StatTile
            label="Escritos a partir de um chamado"
            value={deChamado}
            hint="é o caminho que mantém a base viva"
            tone={deChamado > 0 ? 'ok' : 'warn'}
          />
          <StatTile
            label="Rascunhos"
            value={rascunhos}
            hint="esperando revisão"
            tone={rascunhos > 0 ? 'warn' : 'ok'}
          />
          <StatTile label="Leituras" value={leituras} />
        </div>
      )}

      {podeEscrever && (
        <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filtrar por situação">
          {(
            [
              [null, 'Todos'],
              ['publicado', 'Publicados'],
              ['rascunho', 'Rascunhos'],
              ['arquivado', 'Arquivados'],
            ] as const
          ).map(([valor, rotulo]) => (
            <Link
              key={rotulo}
              href={filtroHref(valor)}
              aria-current={status === valor ? 'page' : undefined}
              className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                status === valor
                  ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
                  : 'border-[var(--color-line)] text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]'
              }`}
            >
              {rotulo}
            </Link>
          ))}
        </div>
      )}

      {lista.length === 0 ? (
        <EmptyState
          title={busca ? `Nada encontrado para "${busca}"` : 'A base ainda está vazia'}
          description={
            busca
              ? 'Tente outras palavras, ou abra um chamado — e, quando ele for resolvido, o artigo nasce dele.'
              : podeEscrever
                ? 'O jeito mais fácil de começar: abra um chamado já resolvido e use "Virar artigo". O texto vem pronto.'
                : 'Ainda não há artigos publicados. Abra um chamado que alguém te responde.'
          }
        />
      ) : (
        <>
          <Table
            label="Artigos"
            head={
              podeEscrever
                ? ['Artigo', 'Categoria', 'Situação', 'Quem lê', 'Útil']
                : ['Artigo', 'Categoria', 'Atualizado']
            }
          >
            {lista.map((a) => (
              <tr key={a.id}>
                <Td>
                  <Link
                    href={`/base/${a.id}` as Route}
                    className="font-medium text-[var(--color-brand-ink)] hover:underline"
                  >
                    {a.title}
                  </Link>
                  {a.resumo && <p className="text-xs text-[var(--color-ink-3)]">{a.resumo}</p>}
                </Td>
                <Td className="text-[var(--color-ink-2)]">{a.category_name ?? '—'}</Td>
                {podeEscrever ? (
                  <>
                    <Td>
                      <Badge tone={TOM_DO_STATUS[a.status] ?? 'neutral'}>{a.status}</Badge>
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">
                      {a.visibilidade === 'solicitante' ? 'Todos' : 'Só a equipe'}
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">
                      {a.uteis + a.inuteis === 0 ? (
                        <span className="text-[var(--color-ink-3)]">sem votos</span>
                      ) : (
                        <>
                          {a.uteis} de {a.uteis + a.inuteis}
                          <p className="text-xs text-[var(--color-ink-3)]">
                            em {a.views} leitura(s)
                          </p>
                        </>
                      )}
                    </Td>
                  </>
                ) : (
                  <Td className="text-[var(--color-ink-2)]">
                    {formatDate(a.published_at ?? a.updated_at)}
                  </Td>
                )}
              </tr>
            ))}
          </Table>
          <Pager
            pagina={pagina.numero}
            total={count ?? 0}
            tamanho={pagina.tamanho}
            base="/base"
            params={params}
          />
        </>
      )}

      {podeEscrever && (
        <Card title="Como esta base não morre" className="mt-6">
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-[var(--color-ink-2)]">
            <li>
              <strong>Escreva do chamado, não da página em branco.</strong> Em qualquer chamado
              resolvido há o botão <em>Virar artigo</em>: o título, o problema e a solução já vêm
              preenchidos a partir do próprio chamado.
            </li>
            <li>
              O artigo nasce <strong>interno</strong>. Liberar para o solicitante é uma escolha
              explícita — é o que impede a senha do roteador de ir parar na tela do cliente.
            </li>
            <li>
              Artigo que deixou de valer é <strong>arquivado</strong>, não apagado: ele sai da busca
              e continua respondendo &ldquo;o que já se soube sobre isto?&rdquo;.
            </li>
          </ul>
        </Card>
      )}
    </>
  )
}
