import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { formatDateTime } from '@/lib/format'
import { ROTULO_DO_CANAL, type TipoDeCanal } from '@/lib/canais/registro'
import { Badge, Card, PageHeader } from '@/components/ui'
import { ContatoForm } from './contato-form'

export const metadata: Metadata = { title: 'Conversa' }

interface Conversa {
  conversation_id: string
  status: string
  ticket_id: string | null
  channel_name: string
  channel_kind: string
  contact_id: string
  contact_external_id: string
  contact_name: string | null
  contact_bloqueado: boolean
  profile_id: string | null
  profile_name: string | null
  client_name: string | null
  ticket_number: number | null
  ticket_title: string | null
}

interface Mensagem {
  id: string
  direction: string
  body: string | null
  media: { tipo?: string; nome?: string }[]
  status: string
  last_error: string | null
  created_at: string
}

/**
 * Uma conversa.
 *
 * ## Ela mostra o que aconteceu, e deixa responder no chamado
 *
 * Não há caixa de resposta aqui, pelo motivo escrito na tela de conversas: dois
 * lugares para responder a mesma coisa produzem duas respostas para "este cliente
 * já foi atendido?". O botão leva ao chamado, que é onde se responde.
 *
 * O que esta tela faz de exclusivo é dizer **de quem é o número** — e esse é o
 * trabalho que tira os próximos chamados do anonimato.
 */
export default async function ConversaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireScreen('canais.conversas.ver')
  const podeClassificar = await allowed('canais.conversas.responder')

  const supabase = await createClient()
  const { data: conversa } = await supabase
    .from('vw_channel_conversations')
    .select(
      'conversation_id, status, ticket_id, channel_name, channel_kind, contact_id, contact_external_id, contact_name, contact_bloqueado, profile_id, profile_name, client_name, ticket_number, ticket_title',
    )
    .eq('conversation_id', id)
    .maybeSingle<Conversa>()

  if (!conversa) notFound()

  const [
    { data: mensagens },
    { data: contato },
    { data: pessoas },
    { data: clientes },
    { data: filiais },
  ] = await Promise.all([
      supabase
        .from('channel_messages')
        .select('id, direction, body, media, status, last_error, created_at')
        .eq('conversation_id', id)
        .order('created_at', { ascending: true })
        .limit(200)
        .returns<Mensagem[]>(),
      /* O cliente e a filial atuais do contato não estão na view (ela carrega o
         NOME do cliente, para a lista). O formulário precisa dos ids para vir
         preenchido — sem isso, salvar uma correção de nome apagaria a
         classificação que já existia. */
      supabase
        .from('channel_contacts')
        .select('client_id, branch_id')
        .eq('id', conversa.contact_id)
        .maybeSingle<{ client_id: string | null; branch_id: string | null }>(),
      podeClassificar
        ? supabase
            .from('profiles')
            .select('id, full_name')
            .is('deleted_at', null)
            .order('full_name')
            .returns<{ id: string; full_name: string }[]>()
        : Promise.resolve({ data: [] }),
      podeClassificar
        ? supabase
            .from('clients')
            .select('id, trade_name, legal_name')
            .is('deleted_at', null)
            .order('legal_name')
            .returns<{ id: string; trade_name: string | null; legal_name: string }[]>()
        : Promise.resolve({ data: [] }),
      podeClassificar
        ? supabase
            .from('branches')
            .select('id, name, client_id')
            .is('deleted_at', null)
            .order('name')
            .returns<{ id: string; name: string; client_id: string }[]>()
        : Promise.resolve({ data: [] }),
    ])

  const quem = conversa.profile_name ?? conversa.contact_name ?? conversa.contact_external_id
  const anonimo = conversa.profile_id === null && conversa.client_name === null

  return (
    <>
      <PageHeader
        title={quem}
        description={`${ROTULO_DO_CANAL[conversa.channel_kind as TipoDeCanal] ?? conversa.channel_kind} · ${conversa.channel_name} · ${conversa.contact_external_id}`}
        action={
          conversa.ticket_id ? (
            <Link
              href={`/tickets/${conversa.ticket_id}` as Route}
              className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
            >
              Responder no chamado #{conversa.ticket_number}
            </Link>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone={conversa.status === 'aberta' ? 'ok' : 'neutral'}>{conversa.status}</Badge>
        {conversa.contact_bloqueado && <Badge tone="breach">contato bloqueado</Badge>}
        {anonimo && <Badge tone="warn">sem dono</Badge>}
        {conversa.client_name && (
          <span className="text-sm text-[var(--color-ink-2)]">{conversa.client_name}</span>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Card title="Mensagens">
          {(mensagens ?? []).length === 0 ? (
            <p className="text-sm text-[var(--color-ink-3)]">Nenhuma mensagem registrada.</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {(mensagens ?? []).map((m) => {
                const nossa = m.direction === 'saida'
                return (
                  <li
                    key={m.id}
                    className={`max-w-[85%] rounded-xl border p-3 ${
                      nossa
                        ? 'ml-auto border-[var(--color-brand)]/30 bg-[var(--color-brand-soft)]'
                        : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
                    }`}
                  >
                    <p className="whitespace-pre-wrap text-sm text-[var(--color-ink)]">
                      {m.body ?? <span className="text-[var(--color-ink-3)]">(sem texto)</span>}
                    </p>
                    {m.media.length > 0 && (
                      <p className="mt-1 text-xs text-[var(--color-ink-3)]">
                        {m.media.length} anexo(s): {m.media.map((a) => a.nome ?? a.tipo).join(', ')}
                      </p>
                    )}
                    <p className="mt-1.5 text-xs text-[var(--color-ink-3)]">
                      {nossa ? 'nós' : 'cliente'} · {formatDateTime(m.created_at)}
                      {nossa && ` · ${m.status}`}
                    </p>
                    {/* A falha de envio aparece onde a mensagem está. Vista só no
                        indicador do topo, ela diz que algo falhou; vista aqui,
                        diz O QUE o cliente não recebeu. */}
                    {m.status === 'falhou' && (
                      <p className="mt-1 text-xs text-[var(--color-breach-ink)]">
                        Não saiu: {m.last_error ?? 'sem motivo registrado'}
                      </p>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
          <p className="mt-4 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-ink-3)]">
            Para responder, use o chamado. O comentário público volta pelo canal; a nota interna
            não sai.
          </p>
        </Card>

        <div className="flex flex-col gap-6">
          {podeClassificar ? (
            <ContatoForm
              contato={{
                id: conversa.contact_id,
                display_name: conversa.contact_name,
                profile_id: conversa.profile_id,
                client_id: contato?.client_id ?? null,
                branch_id: contato?.branch_id ?? null,
                bloqueado: conversa.contact_bloqueado,
              }}
              pessoas={pessoas ?? []}
              clientes={(clientes ?? []).map((c) => ({
                id: c.id,
                nome: c.trade_name ?? c.legal_name,
              }))}
              filiais={filiais ?? []}
            />
          ) : (
            <Card title="De quem é este número">
              <p className="text-sm text-[var(--color-ink-2)]">
                {anonimo
                  ? 'Ninguém classificou este contato ainda. Quem atende pode fazê-lo.'
                  : 'Contato já classificado.'}
              </p>
            </Card>
          )}

          {conversa.ticket_title && (
            <Card title="Chamado desta conversa">
              <p className="text-sm text-[var(--color-ink)]">{conversa.ticket_title}</p>
              {conversa.ticket_id && (
                <Link
                  href={`/tickets/${conversa.ticket_id}` as Route}
                  className="mt-2 inline-block text-sm font-medium text-[var(--color-brand-ink)] hover:underline"
                >
                  Abrir #{conversa.ticket_number}
                </Link>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  )
}
