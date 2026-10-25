import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed, requireSession } from '@/lib/session'
import { formatDate, formatDateTime } from '@/lib/format'
import { Badge, Card, PageHeader, Table, Td } from '@/components/ui'
import { VotarNoArtigo } from './votar'
import { ArquivarArtigo } from './arquivar'

export const metadata: Metadata = { title: 'Artigo' }

interface Artigo {
  id: string
  title: string
  resumo: string | null
  body: string
  status: string
  visibilidade: string
  source_ticket_id: string | null
  published_at: string | null
  updated_at: string
  views: number
  category: { name: string } | null
  author: { full_name: string } | null
  ticket: { ticket_number: number } | null
}

interface Voto {
  user_id: string
  util: boolean
  comentario: string | null
  created_at: string
  profile: { full_name: string } | null
}

/**
 * Um artigo.
 *
 * ## Por que o corpo é renderizado como texto, e não como markdown
 *
 * Renderizar markdown exigiria um renderizador (dependência) e um sanitizador
 * (segunda dependência, e a que ninguém lembra de atualizar). Este artigo é lido
 * por `solicitante` — inclusive de empresa-cliente —, e markdown não sanitizado
 * num texto que outra pessoa escreveu é XSS armazenado, servido para o público
 * mais amplo que esta aplicação tem.
 *
 * `whitespace-pre-wrap` preserva parágrafos e indentação, que é o que um
 * "como trocar a senha" precisa. O React escapa o conteúdo por padrão, então não
 * há como o texto virar marcação.
 *
 * ## O voto fica no fim, e é a única pergunta
 *
 * "Isto resolveu o seu problema?" é a única medida que diz se a base funciona. O
 * número de leituras diz o que as pessoas clicaram; o voto diz o que as ajudou.
 */
export default async function ArtigoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireScreen('autoatendimento.base.ver')
  const podeEscrever = await allowed('autoatendimento.base.escrever')
  const { profile } = await requireSession()

  const supabase = await createClient()

  const [{ data: artigo }, { data: votos }] = await Promise.all([
    supabase
      .from('kb_articles')
      .select(
        'id, title, resumo, body, status, visibilidade, source_ticket_id, published_at, updated_at, views, category:ticket_categories(name), author:profiles!kb_articles_author_id_fkey(full_name), ticket:tickets(ticket_number)',
      )
      .eq('id', id)
      .maybeSingle<Artigo>(),
    supabase
      .from('kb_feedback')
      .select('user_id, util, comentario, created_at, profile:profiles(full_name)')
      .eq('article_id', id)
      .order('created_at', { ascending: false })
      .returns<Voto[]>(),
  ])

  /* RLS nega devolvendo zero linhas, não erro: artigo interno pedido por um
     solicitante e artigo inexistente chegam aqui exatamente iguais, e as duas
     coisas são um 404. É de propósito — distinguir diria a quem está sondando
     que o artigo existe. */
  if (!artigo) notFound()

  /* A contagem de leitura é feita por uma função `security definer`: o público
     principal da base é quem NÃO tem permissão de escrita no artigo. */
  if (artigo.status === 'publicado') {
    await supabase.rpc('kb_registrar_leitura', { p_article_id: id })
  }

  const todos = votos ?? []
  const meuVoto = todos.find((v) => v.user_id === profile.id)
  const uteis = todos.filter((v) => v.util).length
  const inuteis = todos.length - uteis

  return (
    <>
      <PageHeader
        title={artigo.title}
        description={artigo.resumo ?? undefined}
        action={
          podeEscrever && (
            <div className="flex items-center gap-3">
              <Link
                href={`/base/${artigo.id}/editar` as Route}
                className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
              >
                Editar
              </Link>
              {artigo.status !== 'arquivado' && <ArquivarArtigo articleId={artigo.id} />}
            </div>
          )
        }
      />

      {podeEscrever && (
        <div className="mb-6 flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={artigo.status === 'publicado' ? 'ok' : 'warn'}>{artigo.status}</Badge>
          <Badge tone={artigo.visibilidade === 'solicitante' ? 'neutral' : 'warn'}>
            {artigo.visibilidade === 'solicitante' ? 'Visível a todos' : 'Só a equipe'}
          </Badge>
          {artigo.category && (
            <span className="text-[var(--color-ink-3)]">{artigo.category.name}</span>
          )}
          {artigo.ticket && artigo.source_ticket_id && (
            <Link
              href={`/tickets/${artigo.source_ticket_id}` as Route}
              className="text-[var(--color-brand-ink)] hover:underline"
            >
              nasceu do chamado #{artigo.ticket.ticket_number}
            </Link>
          )}
        </div>
      )}

      <Card title="" className="mb-6">
        {/*
          Texto, não markdown. Ver o comentário do componente: o público inclui
          solicitante de empresa-cliente, e renderizar marcação de terceiro sem
          sanitizar é XSS armazenado.
        */}
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-ink)]">
          {artigo.body}
        </div>
        <p className="mt-6 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-ink-3)]">
          {artigo.author?.full_name ? `Escrito por ${artigo.author.full_name}. ` : ''}
          {artigo.published_at
            ? `Publicado em ${formatDate(artigo.published_at)}.`
            : 'Ainda não publicado.'}{' '}
          Atualizado em {formatDate(artigo.updated_at)}.
        </p>
      </Card>

      <Card title="Isto resolveu o seu problema?" className="mb-6">
        <VotarNoArtigo
          articleId={artigo.id}
          jaVotou={meuVoto ? (meuVoto.util ? 'sim' : 'nao') : null}
        />
        {todos.length > 0 && (
          <p className="mt-3 text-xs text-[var(--color-ink-3)]">
            {uteis} de {todos.length} {todos.length === 1 ? 'pessoa disse' : 'pessoas disseram'} que
            ajudou, em {artigo.views} leitura(s).
          </p>
        )}
      </Card>

      {podeEscrever && inuteis > 0 && (
        <Card title={`Quem disse que não ajudou (${inuteis})`}>
          {/*
            Só os votos negativos, e só para quem escreve. O positivo não tem o
            que revisar; o negativo é a lista de tarefas desta tela — e uma lista
            misturada esconderia justamente o que precisa de atenção.
          */}
          <Table label="Votos negativos" head={['Quem', 'O que disse', 'Quando']}>
            {todos
              .filter((v) => !v.util)
              .map((v) => (
                <tr key={v.user_id}>
                  <Td className="text-[var(--color-ink-2)]">{v.profile?.full_name ?? '—'}</Td>
                  <Td className="text-[var(--color-ink-2)]">
                    {v.comentario ?? (
                      <span className="text-[var(--color-ink-3)]">sem comentário</span>
                    )}
                  </Td>
                  <Td className="text-[var(--color-ink-2)]">{formatDateTime(v.created_at)}</Td>
                </tr>
              ))}
          </Table>
        </Card>
      )}
    </>
  )
}
