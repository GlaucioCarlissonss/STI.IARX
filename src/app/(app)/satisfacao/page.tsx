import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { requireScreen } from '@/lib/session'
import { escopoDeCliente, porClienteOuGeral } from '@/lib/data/escopo'
import { lerPagina, paginar } from '@/lib/data/paginacao'
import { formatDateTime } from '@/lib/format'
import { Badge, Card, EmptyState, PageHeader, Pager, StatTile, Table, Td } from '@/components/ui'

export const metadata: Metadata = { title: 'Satisfação' }

interface LinhaDeAvaliacao {
  ticket_id: string
  score: number | null
  comment: string | null
  sent_at: string
  answered_at: string | null
  expires_at: string
  ticket: { ticket_number: number; title: string; client_id: string | null } | null
}

/** 1-2 é ruim, 3 é morno, 4-5 é bom. A cor segue essa leitura. */
function tomDaNota(score: number | null) {
  if (score === null) return 'neutral' as const
  if (score <= 2) return 'breach' as const
  if (score === 3) return 'warn' as const
  return 'ok' as const
}

/**
 * As avaliações recebidas.
 *
 * ## Os dois números do topo, e por que são dois
 *
 * A **nota média** sozinha mente por omissão: média 4,6 com três respostas de
 * duzentos chamados não diz nada sobre o atendimento, diz que ninguém respondeu.
 * Por isso a **taxa de resposta** fica ao lado, do mesmo tamanho — ela é o que
 * qualifica a média.
 *
 * ## O que NÃO tem aqui
 *
 * Ranking por atendente. A tentação é óbvia e o efeito é conhecido: nota vira
 * meta, e meta vira pressão sobre quem atende para pedir nota boa — e aí a
 * pesquisa deixa de medir satisfação e passa a medir quem pede melhor. Os dados
 * estão no banco para quem quiser cruzar; a tela não oferece o atalho.
 */
export default async function SatisfacaoPage({
  searchParams,
}: {
  searchParams: Promise<{ pagina?: string }>
}) {
  const params = await searchParams
  await requireScreen('helpdesk.satisfacao.ver')

  const supabase = await createClient()
  const escopo = await escopoDeCliente()
  const pagina = lerPagina(params.pagina)

  /*
   * O escopo é aplicado na tabela EMBUTIDA (`ticket.client_id`), porque
   * `ticket_satisfaction` não tem `client_id` próprio — ela se liga ao cliente
   * pelo ticket. É a mesma regra das colunas nulas: chamado interno, sem
   * cliente, aparece em qualquer foco.
   */
  const [{ data: linhas, count }, { data: todas }] = await Promise.all([
    paginar(
      porClienteOuGeral(
        supabase
          .from('ticket_satisfaction')
          .select(
            'ticket_id, score, comment, sent_at, answered_at, expires_at, ticket:tickets!inner(ticket_number, title, client_id)',
            { count: 'exact' },
          )
          .not('answered_at', 'is', null)
          .order('answered_at', { ascending: false }),
        escopo,
        'tickets.client_id',
      ),
      pagina,
    ).returns<LinhaDeAvaliacao[]>(),
    /* Os indicadores precisam do acervo inteiro, não da página — mesma lição da
       entrega 6. Só duas colunas, que é um payload pequeno mesmo com milhares
       de linhas. */
    porClienteOuGeral(
      supabase
        .from('ticket_satisfaction')
        .select('score, answered_at, ticket:tickets!inner(client_id)'),
      escopo,
      'tickets.client_id',
    ).returns<{ score: number | null; answered_at: string | null }[]>(),
  ])

  const universo = todas ?? []
  const respondidas = universo.filter((a) => a.answered_at !== null && a.score !== null)
  const media =
    respondidas.length > 0
      ? respondidas.reduce((s, a) => s + Number(a.score), 0) / respondidas.length
      : null
  const taxa = universo.length > 0 ? (respondidas.length / universo.length) * 100 : null
  const ruins = respondidas.filter((a) => Number(a.score) <= 2).length

  const lista = linhas ?? []

  return (
    <>
      <PageHeader
        title="Satisfação"
        description="Avaliação de 1 a 5 enviada a quem abriu o chamado, depois do encerramento."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Nota média"
          value={media === null ? '—' : media.toFixed(1).replace('.', ',')}
          hint={`${respondidas.length} resposta(s)`}
          tone={media === null ? 'neutral' : tomDaNota(Math.round(media))}
        />
        <StatTile
          label="Taxa de resposta"
          value={taxa === null ? '—' : `${Math.round(taxa)}%`}
          hint={`de ${universo.length} convite(s)`}
        />
        <StatTile
          label="Notas 1 e 2"
          value={ruins}
          hint="atendimento a revisitar"
          tone={ruins > 0 ? 'breach' : 'ok'}
        />
        <StatTile label="Convites enviados" value={universo.length} />
      </div>

      {lista.length === 0 ? (
        <EmptyState
          title="Nenhuma avaliação respondida ainda"
          description="O convite sai automaticamente quando um chamado é encerrado, e o link vale por 30 dias."
        />
      ) : (
        <>
          <Table label="Avaliações respondidas" head={['Nota', 'Chamado', 'Comentário', 'Quando']}>
            {lista.map((a) => (
              <tr key={a.ticket_id}>
                <Td>
                  <Badge tone={tomDaNota(a.score)}>{a.score ?? '—'}</Badge>
                </Td>
                <Td>
                  <Link
                    href={`/tickets/${a.ticket_id}`}
                    className="font-medium text-[var(--color-brand-ink)] hover:underline"
                  >
                    #{a.ticket?.ticket_number ?? '—'}
                  </Link>
                  <p className="text-xs text-[var(--color-ink-3)]">{a.ticket?.title ?? ''}</p>
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {a.comment ? a.comment : <span className="text-[var(--color-ink-3)]">—</span>}
                </Td>
                <Td className="text-[var(--color-ink-2)]">{formatDateTime(a.answered_at)}</Td>
              </tr>
            ))}
          </Table>
          <Pager
            pagina={pagina.numero}
            total={count ?? 0}
            tamanho={pagina.tamanho}
            base="/satisfacao"
            params={params}
          />
        </>
      )}

      <Card title="Como a pesquisa funciona" className="mt-6">
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-[var(--color-ink-2)]">
          <li>
            O convite sai quando o chamado é <strong>encerrado</strong>, não quando é resolvido:
            entre um e outro a pessoa ainda pode reabrir, e perguntar &ldquo;como foi?&rdquo; para
            quem está prestes a dizer &ldquo;não resolveu&rdquo; é a pior hora de perguntar.
          </li>
          <li>Responde-se sem login, por link com token. O link vale 30 dias e só serve uma vez.</li>
          <li>
            Quem não quiser receber desliga em <strong>Minha conta</strong>, por tipo de aviso.
          </li>
        </ul>
      </Card>
    </>
  )
}
