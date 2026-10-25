import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireSession, allowed } from '@/lib/session'
import { formatDate } from '@/lib/format'
import { precoEmTexto } from '@/lib/catalogo/campos'
import { Badge, Card, EmptyState, PageHeader, StatusBadge, Table, Td } from '@/components/ui'
import type { TicketStatus } from '@/lib/types'

export const metadata: Metadata = { title: 'Portal' }

interface MeuChamado {
  id: string
  ticket_number: number
  title: string
  status: TicketStatus
  created_at: string
}

interface ServicoNaVitrine {
  id: string
  name: string
  description: string | null
  preco: number | null
  unidade: string | null
  prazo_horas: number | null
}

interface ArtigoSugerido {
  id: string
  title: string
  resumo: string | null
}

/**
 * O portal de quem pede.
 *
 * ## Por que é uma tela e não um segundo aplicativo
 *
 * O escopo pedia "portal do solicitante — enxuto". A tentação é um layout
 * próprio, com menu próprio e rotas próprias, e ela custa caro: duas camadas de
 * navegação para manter, dois lugares onde uma permissão nova precisa ser
 * refletida, e dois lugares onde um defeito de sessão pode morar.
 *
 * O que torna um portal enxuto não é o layout: é a PÁGINA responder "o que você
 * precisa?" em vez de apresentar um sistema. O menu lateral já se filtra sozinho
 * pelas permissões desde a migração 0017 — um solicitante vê cinco itens, não
 * vinte e cinco.
 *
 * Então esta é a tela inicial de quem pede, e não um aplicativo paralelo. O PWA,
 * quando vier, embrulha isto.
 *
 * ## A ordem das três seções é a ordem do que resolve mais barato
 *
 * Primeiro **achar a resposta** (custa zero para a equipe), depois **pedir um
 * serviço** (chega classificado, sem ida e volta), e só então **abrir um chamado
 * livre** (é o caminho mais caro para os dois lados). Pôr o botão de abrir
 * chamado no topo inverteria essa economia inteira — e é exatamente o que a
 * maioria dos helpdesks faz.
 */
export default async function PortalPage() {
  const { profile } = await requireSession()
  const podeVerBase = await allowed('autoatendimento.base.ver')
  const podePedir = await allowed('autoatendimento.catalogo.pedir')
  const podeAbrir = await allowed('helpdesk.tickets.criar')

  const supabase = await createClient()

  const [{ data: meus }, { data: servicos }, { data: artigos }] = await Promise.all([
    /* A policy de `tickets` já limita o solicitante aos próprios chamados desde
       a 0012 — esta consulta não acrescenta regra nenhuma, só ordena. */
    supabase
      .from('tickets')
      .select('id, ticket_number, title, status, created_at')
      .eq('requester_id', profile.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(5)
      .returns<MeuChamado[]>(),
    podePedir
      ? supabase
          .from('service_catalog')
          .select('id, name, description, preco, unidade, prazo_horas')
          .eq('is_active', true)
          .is('deleted_at', null)
          .order('sort_order')
          .limit(6)
          .returns<ServicoNaVitrine[]>()
      : Promise.resolve({ data: [] as ServicoNaVitrine[] }),
    podeVerBase
      ? supabase
          .from('kb_articles')
          .select('id, title, resumo')
          .eq('status', 'publicado')
          .is('deleted_at', null)
          .order('views', { ascending: false })
          .limit(5)
          .returns<ArtigoSugerido[]>()
      : Promise.resolve({ data: [] as ArtigoSugerido[] }),
  ])

  const chamados = meus ?? []
  const abertos = chamados.filter((c) => c.status !== 'closed' && c.status !== 'resolved').length
  const primeiroNome = profile.full_name?.split(' ')[0] ?? ''

  return (
    <>
      <PageHeader
        title={primeiroNome ? `Olá, ${primeiroNome}` : 'Portal'}
        description={
          abertos > 0
            ? `Você tem ${abertos} chamado(s) em andamento.`
            : 'Procure a resposta, peça um serviço, ou abra um chamado.'
        }
      />

      {podeVerBase && (
        <Card title="Procure antes de abrir um chamado" className="mb-6">
          <form action="/base" className="flex flex-wrap gap-2" role="search">
            <label className="sr-only" htmlFor="busca">
              Qual é o problema?
            </label>
            <input
              id="busca"
              name="busca"
              type="search"
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

          {(artigos ?? []).length > 0 && (
            <>
              <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
                Os mais lidos
              </p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {(artigos ?? []).map((a) => (
                  <li key={a.id}>
                    <Link
                      href={`/base/${a.id}` as Route}
                      className="text-sm font-medium text-[var(--color-brand-ink)] hover:underline"
                    >
                      {a.title}
                    </Link>
                    {a.resumo && (
                      <p className="text-xs text-[var(--color-ink-3)]">{a.resumo}</p>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}

      {podePedir && (servicos ?? []).length > 0 && (
        <Card title="Peça um serviço" className="mb-6">
          <p className="mb-3 text-sm text-[var(--color-ink-2)]">
            O pedido chega já classificado, com o que a equipe precisa saber — sem ida e volta.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {(servicos ?? []).map((s) => (
              <Link
                key={s.id}
                href={`/catalogo/${s.id}` as Route}
                className="rounded-lg border border-[var(--color-border)] p-3 transition-colors hover:bg-[var(--color-surface-2)]"
              >
                <span className="block text-sm font-semibold text-[var(--color-ink)]">
                  {s.name}
                </span>
                <span className="mt-1 block text-xs text-[var(--color-ink-3)]">
                  {s.preco === null
                    ? 'Sob consulta'
                    : `a partir de ${precoEmTexto(s.preco, false, s.unidade)}`}
                  {s.prazo_horas ? ` · ${s.prazo_horas} h úteis` : ''}
                </span>
              </Link>
            ))}
          </div>
          <Link
            href={'/catalogo' as Route}
            className="mt-3 inline-block text-sm font-medium text-[var(--color-brand-ink)] hover:underline"
          >
            Ver o catálogo inteiro
          </Link>
        </Card>
      )}

      <Card
        title="Seus chamados"
        className="mb-6"
      >
        {chamados.length === 0 ? (
          <EmptyState
            title="Você ainda não abriu nenhum chamado"
            description="Quando abrir, ele aparece aqui com a situação e o que já foi respondido."
          />
        ) : (
          <>
            <Table label="Seus chamados" head={['Chamado', 'Situação', 'Aberto em']}>
              {chamados.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Link
                      href={`/tickets/${c.id}` as Route}
                      className="font-medium text-[var(--color-brand-ink)] hover:underline"
                    >
                      #{c.ticket_number}
                    </Link>
                    <p className="text-xs text-[var(--color-ink-3)]">{c.title}</p>
                  </Td>
                  <Td>
                    <StatusBadge status={c.status} />
                  </Td>
                  <Td className="text-[var(--color-ink-2)]">{formatDate(c.created_at)}</Td>
                </tr>
              ))}
            </Table>
            <Link
              href={'/tickets' as Route}
              className="mt-3 inline-block text-sm font-medium text-[var(--color-brand-ink)] hover:underline"
            >
              Ver todos
            </Link>
          </>
        )}
      </Card>

      {podeAbrir && (
        <Card title="Não achou?">
          {/*
            Por último, e de propósito. Abrir um chamado livre é o caminho mais
            caro para os dois lados: para quem pede, porque vai ter ida e volta;
            para quem atende, porque chega sem classificação. Pôr este botão no
            topo inverteria a economia inteira da página.
          */}
          <p className="mb-3 text-sm text-[var(--color-ink-2)]">
            Descreva o que está acontecendo. Quanto mais específico, menos perguntas de volta.
          </p>
          <Link
            href={'/tickets/novo' as Route}
            className="inline-block rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
          >
            Abrir um chamado
          </Link>
          {!podeVerBase && (
            <p className="mt-2 text-xs text-[var(--color-ink-3)]">
              <Badge tone="neutral">dica</Badge> Peça ao administrador acesso à base de
              conhecimento: metade dos chamados já tem resposta escrita.
            </p>
          )}
        </Card>
      )}
    </>
  )
}
