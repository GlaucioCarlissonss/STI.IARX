import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { formatDateTime } from '@/lib/format'
import { EXIGENCIAS_DO_CANAL, ROTULO_DO_CANAL, type TipoDeCanal } from '@/lib/canais/registro'
import { Badge, Card, EmptyState, PageHeader, Table, Td } from '@/components/ui'
import { CanalForm } from './canal-form'
import { ListaDeExigencias } from './exigencias'
import { EstadoDoCanal } from './estado-do-canal'

export const metadata: Metadata = { title: 'Canais de conversa' }

interface Canal {
  id: string
  name: string
  kind: string
  status: string
  secret_ref: string | null
  abre_chamado: boolean
  last_inbound_at: string | null
  last_outbound_at: string | null
  created_at: string
}

/**
 * Configuração dos canais.
 *
 * ## A tela diz o que cada provedor exige ANTES de a pessoa tentar
 *
 * Ligar um WhatsApp oficial envolve conta Business verificada, número dedicado,
 * dois segredos diferentes com papéis diferentes, e um verify token no painel da
 * Meta. Descobrir isso errando, um item por vez, com uma mensagem de erro da Meta
 * que não diz o motivo, é meio dia perdido.
 *
 * Por isso a lista de exigências de cada tipo vem do mesmo lugar que o adaptador
 * (`EXIGENCIAS_DO_CANAL`): quando o adaptador passar a exigir outra coisa, a tela
 * muda junto, em vez de continuar ensinando o procedimento antigo.
 */
export default async function CanaisPage() {
  await requireScreen('canais.canais.ver')
  /* Ver a configuração e mexer nela são permissões diferentes: a tela mostra qual
     variável de ambiente cada canal usa, que é leitura útil para quem audita, sem
     o poder de desligar o WhatsApp da empresa no meio do expediente. */
  const podeGerenciar = await allowed('canais.canais.gerenciar')

  const supabase = await createClient()
  const [{ data: canais }, { data: filas }, { data: prioridades }, { data: clientes }] =
    await Promise.all([
      supabase
        .from('channels')
        .select(
          'id, name, kind, status, secret_ref, abre_chamado, last_inbound_at, last_outbound_at, created_at',
        )
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .returns<Canal[]>(),
      supabase.from('queues').select('id, name').order('name').returns<{ id: string; name: string }[]>(),
      supabase
        .from('ticket_priorities')
        .select('id, name')
        .order('sort_order')
        .returns<{ id: string; name: string }[]>(),
      supabase
        .from('clients')
        .select('id, trade_name, legal_name')
        .is('deleted_at', null)
        .order('legal_name')
        .returns<{ id: string; trade_name: string | null; legal_name: string }[]>(),
    ])

  const lista = canais ?? []

  return (
    <>
      <PageHeader
        title="Canais de conversa"
        description="Onde as mensagens entram e por onde as respostas saem. A credencial mora no ambiente, nunca aqui."
      />

      {lista.length === 0 ? (
        <EmptyState
          title="Nenhum canal configurado"
          description="Comece pelo N8N se quiser ver funcionando em minutos: ele liga Telegram, Slack ou SMS sem configuração do lado de cá."
        />
      ) : (
        <Card title="Canais" className="mb-6">
          <Table
            label="Canais configurados"
            head={['Canal', 'Tipo', 'Credencial', 'Último contato', '']}
          >
            {lista.map((c) => (
              <tr key={c.id}>
                <Td>
                  {c.name}
                  <p className="text-xs text-[var(--color-ink-3)]">
                    {c.abre_chamado ? 'abre chamado' : 'só observando'}
                  </p>
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {ROTULO_DO_CANAL[c.kind as TipoDeCanal] ?? c.kind}
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {c.secret_ref ? (
                    <code className="font-mono text-xs">{c.secret_ref}</code>
                  ) : (
                    /* Canal sem credencial recebe e não responde — é um estado
                       legítimo, do mesmo jeito que a caixa de saída de e-mail
                       sem RESEND_API_KEY. A tela diz, em vez de parecer um
                       defeito. */
                    <span className="text-[var(--color-ink-3)]">recebe, não responde</span>
                  )}
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {c.last_inbound_at ? formatDateTime(c.last_inbound_at) : (
                    <span className="text-[var(--color-ink-3)]">nunca</span>
                  )}
                </Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <Badge tone={c.status === 'ativo' ? 'ok' : 'warn'}>{c.status}</Badge>
                    {podeGerenciar && <EstadoDoCanal channelId={c.id} status={c.status} />}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 text-xs text-[var(--color-ink-3)]">
            Pausar não desliga o webhook do provedor: a rota continua respondendo 200 e
            descartando. A Meta desinscreve um webhook que devolve erro, e religar exigiria
            refazer a configuração dela.
          </p>
        </Card>
      )}

      {podeGerenciar && (
        <CanalForm
          filas={filas ?? []}
          prioridades={prioridades ?? []}
          clientes={(clientes ?? []).map((c) => ({ id: c.id, nome: c.trade_name ?? c.legal_name }))}
        />
      )}

      <Card title="O que cada tipo exige" className="mt-6">
        <dl className="flex flex-col gap-4">
          {(Object.keys(EXIGENCIAS_DO_CANAL) as TipoDeCanal[]).map((kind) => (
            <div key={kind}>
              <dt className="text-sm font-semibold text-[var(--color-ink)]">
                {ROTULO_DO_CANAL[kind]}
              </dt>
              <dd>
                <ListaDeExigencias kind={kind} className="mt-1" />
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-sm text-[var(--color-ink-2)]">
          O passo a passo de cada um está em <strong>docs/16</strong>. O WhatsApp pela API
          oficial da Meta exige conta Business verificada e cobra por conversa — e é a única
          forma que não resulta no número banido.
        </p>
      </Card>
    </>
  )
}
