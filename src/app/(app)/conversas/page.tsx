import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { lerPagina, paginar } from '@/lib/data/paginacao'
import { desdeQuando } from '@/lib/agent/inventario'
import { ROTULO_DO_CANAL, type TipoDeCanal } from '@/lib/canais/registro'
import { Badge, Card, EmptyState, PageHeader, Pager, StatTile, Table, Td } from '@/components/ui'

export const metadata: Metadata = { title: 'Conversas' }

interface LinhaDeConversa {
  conversation_id: string
  status: string
  last_message_at: string
  ticket_id: string | null
  channel_name: string
  channel_kind: string
  contact_external_id: string
  contact_name: string | null
  contact_bloqueado: boolean
  profile_id: string | null
  profile_name: string | null
  client_name: string | null
  ticket_number: number | null
  ticket_title: string | null
  ticket_status: string | null
  mensagens: number
  falhas: number
}

/**
 * A caixa de conversas.
 *
 * ## Por que ela não é uma segunda fila de atendimento
 *
 * A tentação é óbvia: uma tela estilo aplicativo de mensagens, com a lista de
 * conversas à esquerda e o balão à direita, onde o atendente responde. Ela seria
 * bonita e criaria **dois lugares para atender a mesma coisa** — e a pergunta
 * "este cliente já foi respondido?" passaria a ter duas respostas possíveis.
 *
 * Toda conversa É um chamado. O atendente responde no chamado, como sempre fez,
 * e a resposta chega no WhatsApp pela trigger da migração 0034 — sem ele
 * precisar saber de onde o chamado veio.
 *
 * O que esta tela faz é o que o chamado não faz: mostrar **de onde** as conversas
 * estão vindo, **quem** é o número que ainda não foi identificado, e **o que
 * falhou ao sair**. São as três perguntas que só existem por causa dos canais.
 *
 * ## O indicador que importa é o de contatos sem dono
 *
 * Um contato sem `profile_id` e sem cliente abre chamado anônimo: sem SLA, sem
 * pesquisa de satisfação e sem aparecer no painel da empresa certa. É silencioso
 * — o chamado funciona, só está no lugar errado —, e por isso vira número na
 * frente da tela.
 */
export default async function ConversasPage({
  searchParams,
}: {
  searchParams: Promise<{ pagina?: string; filtro?: string }>
}) {
  const params = await searchParams
  await requireScreen('canais.conversas.ver')
  const podeGerenciar = await allowed('canais.canais.gerenciar')

  const supabase = await createClient()
  const pagina = lerPagina(params.pagina)
  const FILTROS = ['abertas', 'sem_dono', 'com_falha'] as const
  type Filtro = (typeof FILTROS)[number]
  const filtro = FILTROS.includes(params.filtro as Filtro) ? (params.filtro as Filtro) : null

  let consulta = supabase
    .from('vw_channel_conversations')
    .select(
      'conversation_id, status, last_message_at, ticket_id, channel_name, channel_kind, contact_external_id, contact_name, contact_bloqueado, profile_id, profile_name, client_name, ticket_number, ticket_title, ticket_status, mensagens, falhas',
      { count: 'exact' },
    )
  if (filtro === 'abertas') consulta = consulta.eq('status', 'aberta')
  if (filtro === 'sem_dono') consulta = consulta.is('profile_id', null)
  if (filtro === 'com_falha') consulta = consulta.gt('falhas', 0)

  const [{ data: linhas, count }, { data: universo }] = await Promise.all([
    paginar(
      consulta.order('last_message_at', { ascending: false }),
      pagina,
    ).returns<LinhaDeConversa[]>(),
    /* Os indicadores leem o acervo inteiro, e não a página — mesma lição da
       entrega 6. Quatro colunas, que é um payload pequeno. */
    supabase
      .from('vw_channel_conversations')
      .select('status, profile_id, client_name, falhas')
      .returns<
        { status: string; profile_id: string | null; client_name: string | null; falhas: number }[]
      >(),
  ])

  const todas = universo ?? []
  const abertas = todas.filter((c) => c.status === 'aberta').length
  const semDono = todas.filter((c) => c.profile_id === null && c.client_name === null).length
  const comFalha = todas.filter((c) => c.falhas > 0).length

  const lista = linhas ?? []
  const filtroHref = (valor: Filtro | null): Route =>
    (valor ? `/conversas?filtro=${valor}` : '/conversas') as Route

  return (
    <>
      <PageHeader
        title="Conversas"
        description="De onde os chamados estão chegando. Quem responde é o chamado — aqui se vê o canal."
        action={
          podeGerenciar && (
            <Link
              href={'/conversas/canais' as Route}
              className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
            >
              Configurar canais
            </Link>
          )
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Conversas" value={todas.length} />
        <StatTile label="Abertas agora" value={abertas} />
        {/* O que importa: contato anônimo abre chamado sem SLA, sem satisfação e
            sem aparecer no painel da empresa certa. É silencioso — o chamado
            funciona, só está no lugar errado. */}
        <StatTile
          label="Contatos sem dono"
          value={semDono}
          hint="chamado anônimo: sem cliente e sem SLA"
          tone={semDono > 0 ? 'warn' : 'ok'}
        />
        <StatTile
          label="Respostas que falharam"
          value={comFalha}
          hint="o cliente não recebeu"
          tone={comFalha > 0 ? 'breach' : 'ok'}
        />
      </div>

      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filtrar conversas">
        {(
          [
            [null, 'Todas'],
            ['abertas', 'Abertas'],
            ['sem_dono', 'Sem dono'],
            ['com_falha', 'Com falha'],
          ] as const
        ).map(([valor, rotulo]) => (
          <Link
            key={rotulo}
            href={filtroHref(valor)}
            aria-current={filtro === valor ? 'page' : undefined}
            className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
              filtro === valor
                ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
                : 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]'
            }`}
          >
            {rotulo}
          </Link>
        ))}
      </div>

      {lista.length === 0 ? (
        <EmptyState
          title={filtro ? 'Nada aqui' : 'Nenhuma conversa ainda'}
          description={
            filtro
              ? 'Esse é o estado bom. Volte a "Todas" para ver tudo.'
              : podeGerenciar
                ? 'Configure um canal e divulgue o número ou o endereço. A primeira mensagem aparece aqui em segundos.'
                : 'Quando alguém escrever pelo WhatsApp, por e-mail ou por outro canal, a conversa aparece aqui.'
          }
        />
      ) : (
        <>
          <Table
            label="Conversas"
            head={['Quem', 'Canal', 'Chamado', 'Mensagens', 'Última']}
          >
            {lista.map((c) => (
              <tr key={c.conversation_id}>
                <Td>
                  <Link
                    href={`/conversas/${c.conversation_id}` as Route}
                    className="font-medium text-[var(--color-ink)] hover:underline"
                  >
                    {c.profile_name ?? c.contact_name ?? c.contact_external_id}
                  </Link>
                  <p className="text-xs text-[var(--color-ink-3)]">
                    {c.client_name ?? (
                      /* Sem cliente E sem pessoa = o chamado nasceu anônimo. A
                         tela diz isso onde a pessoa está olhando, e não só no
                         indicador do topo. */
                      c.profile_id === null ? (
                        <span className="text-[var(--color-warn-ink)]">sem dono</span>
                      ) : (
                        c.contact_external_id
                      )
                    )}
                    {c.contact_bloqueado && ' · bloqueado'}
                  </p>
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {ROTULO_DO_CANAL[c.channel_kind as TipoDeCanal] ?? c.channel_kind}
                  <p className="text-xs text-[var(--color-ink-3)]">{c.channel_name}</p>
                </Td>
                <Td>
                  {c.ticket_id ? (
                    <Link
                      href={`/tickets/${c.ticket_id}` as Route}
                      className="font-medium text-[var(--color-brand-ink)] hover:underline"
                    >
                      #{c.ticket_number}
                    </Link>
                  ) : (
                    <span className="text-[var(--color-ink-3)]">—</span>
                  )}
                  {c.ticket_title && (
                    <p className="text-xs text-[var(--color-ink-3)]">{c.ticket_title}</p>
                  )}
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {c.mensagens}
                  {c.falhas > 0 && (
                    <p className="text-xs text-[var(--color-breach-ink)]">
                      {c.falhas} não saiu
                    </p>
                  )}
                </Td>
                <Td>
                  {c.status === 'aberta' ? (
                    <Badge tone="ok">aberta</Badge>
                  ) : (
                    <Badge tone="neutral">fechada</Badge>
                  )}
                  <p className="text-xs text-[var(--color-ink-3)]">
                    {desdeQuando(c.last_message_at)}
                  </p>
                </Td>
              </tr>
            ))}
          </Table>
          <Pager
            pagina={pagina.numero}
            total={count ?? 0}
            tamanho={pagina.tamanho}
            base="/conversas"
            params={params}
          />
        </>
      )}

      <Card title="Como isto funciona" className="mt-6">
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-[var(--color-ink-2)]">
          <li>
            <strong>Toda conversa é um chamado.</strong> Você responde no chamado, como sempre — a
            resposta volta pelo canal de onde a pergunta veio, sem você precisar saber qual é.
          </li>
          <li>
            <strong>Nota interna não sai.</strong> Só o comentário público vira mensagem. É a
            mesma regra de sempre, e aqui ela protege contra vazar para o cliente.
          </li>
          <li>
            Enquanto o chamado estiver aberto, as mensagens seguintes da mesma pessoa entram
            nele. Quando ele fecha, a próxima mensagem abre outro.
          </li>
          <li>
            <strong>Contato sem dono</strong> é o que merece atenção: o chamado nasce sem cliente
            e sem SLA. Abra a conversa e diga de quem é o número — ele fica sabido para sempre.
          </li>
        </ul>
      </Card>
    </>
  )
}
