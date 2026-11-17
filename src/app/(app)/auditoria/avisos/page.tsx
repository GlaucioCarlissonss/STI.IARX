import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen } from '@/lib/session'
import { formatDateTime } from '@/lib/format'
import {
  Badge,
  Card,
  EmptyState,
  FaixaDeIndicadores,
  PageHeader,
  StatTile,
  Table,
  Td,
} from '@/components/ui'

export const metadata: Metadata = { title: 'Avisos enviados' }

interface Resumo {
  total: number
  pendentes: number
  enviadas: number
  falhadas: number
  puladas: number
  paradas: number
  ultimo_envio: string | null
}

interface Mensagem {
  id: string
  to_email: string
  to_name: string | null
  subject: string
  kind: string
  status: string
  attempts: number
  last_error: string | null
  scheduled_for: string
  sent_at: string | null
  created_at: string
}

/**
 * A caixa de saída de e-mail.
 *
 * ## A pergunta que esta tela responde
 *
 * **"O e-mail saiu?"** — e ela não tinha resposta sem `psql` até a migração
 * 0058. A tabela existe desde a 0029, com situação, tentativas e último erro;
 * a tela, não.
 *
 * Deu para viver sem enquanto o e-mail era só aviso de SLA: quem não recebia o
 * aviso descobria o problema pelo próprio chamado. A 0057 mudou isso — o e-mail
 * virou o caminho de volta para a conta, e "não recebi o link de senha" passou
 * a ser a reclamação mais provável do sistema inteiro.
 *
 * ## O indicador que importa é "paradas", não "falhadas"
 *
 * Falha tem sintoma: `last_error` preenchido, e a drenagem tenta de novo
 * sozinha, com espera crescente. O caso silencioso é a mensagem **pendente há
 * mais de uma hora** — ela não falhou, ninguém tentou enviá-la. Quase sempre
 * significa uma destas duas coisas, e as duas somem da tela se só se olhar
 * "falhadas":
 *
 *  - não há provedor configurado (`RESEND_API_KEY` e `MAIL_FROM` vazios), e a
 *    fila acumula de propósito, esperando a chave;
 *  - o agendador parou, e aí nada drena — que é o que `/auditoria/trabalhos`
 *    mostra, e por isso as duas telas se apontam.
 *
 * ## O corpo da mensagem NÃO aparece aqui
 *
 * Ele carrega o link de redefinição de senha (0057) e o token da pesquisa de
 * satisfação (0029) — segredos de curta vida que, enquanto valem, abrem a conta
 * de outra pessoa. O assunto, o destinatário e o erro bastam para o suporte
 * responder o que precisa, e nenhum deles é segredo de ninguém.
 */

const ROTULO: Record<string, string> = {
  sla_warning: 'SLA em atenção',
  sla_critical: 'SLA crítico',
  sla_breach: 'SLA estourado',
  satisfaction_invite: 'Pesquisa de satisfação',
  ticket_assigned: 'Chamado atribuído',
  agent_alert: 'Alerta do agente',
  contract_expiring: 'Contrato vencendo',
  link_down: 'Link caiu',
  link_restored: 'Link voltou',
  password_reset: 'Redefinir senha',
  email_confirm: 'Confirmar e-mail',
  test: 'Teste de configuração',
}

function tomDaSituacao(s: string) {
  if (s === 'failed') return 'breach' as const
  if (s === 'pending') return 'warn' as const
  if (s === 'skipped') return 'neutral' as const
  return 'ok' as const
}

const NOME_DA_SITUACAO: Record<string, string> = {
  pending: 'na fila',
  sent: 'enviada',
  failed: 'falhou',
  skipped: 'pulada',
}

export default async function AvisosPage() {
  await requireScreen('auditoria.avisos.ver')

  const supabase = await createClient()
  const [{ data: resumo }, { data: mensagens }] = await Promise.all([
    supabase.from('vw_email_outbox_resumo').select('*').maybeSingle<Resumo>(),
    supabase
      .from('email_outbox')
      .select(
        'id, to_email, to_name, subject, kind, status, attempts, last_error, scheduled_for, sent_at, created_at',
      )
      .order('created_at', { ascending: false })
      .limit(100)
      .returns<Mensagem[]>(),
  ])

  const fila = mensagens ?? []
  const r = resumo ?? {
    total: 0,
    pendentes: 0,
    enviadas: 0,
    falhadas: 0,
    puladas: 0,
    paradas: 0,
    ultimo_envio: null,
  }

  return (
    <>
      <PageHeader
        title="Avisos enviados"
        description="A fila de e-mails do sistema: o que saiu, o que está esperando e o que falhou — com o motivo."
      />

      {r.total === 0 ? (
        <EmptyState
          title="Nenhuma mensagem na fila"
          description="Nada foi enfileirado ainda. Avisos de SLA, convites de avaliação e links de redefinição de senha aparecem aqui assim que o sistema os gerar."
        />
      ) : (
        <>
          <FaixaDeIndicadores>
            <StatTile label="Enviadas" value={r.enviadas} hint="saíram para o provedor" />
            <StatTile
              label="Na fila"
              value={r.pendentes}
              hint="aguardando a próxima drenagem"
              tone={r.pendentes > 0 ? 'warn' : 'ok'}
            />
            {/* O indicador que importa: parada é silenciosa, falha não é. */}
            <StatTile
              label="Paradas"
              value={r.paradas}
              hint="na fila há mais de 1 hora"
              tone={r.paradas > 0 ? 'breach' : 'ok'}
            />
            <StatTile
              label="Falharam"
              value={r.falhadas}
              hint="esgotaram as tentativas"
              tone={r.falhadas > 0 ? 'breach' : 'ok'}
            />
          </FaixaDeIndicadores>

          {r.paradas > 0 && (
            <Card title="Há mensagem parada na fila" className="mb-6">
              <p className="text-sm text-[var(--color-ink-2)]">
                Mensagem pendente há mais de uma hora quase sempre quer dizer uma destas duas
                coisas, e nenhuma delas é erro da mensagem:
              </p>
              <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-sm text-[var(--color-ink-2)]">
                <li>
                  <strong>Não há provedor de e-mail configurado.</strong> Sem{' '}
                  <code className="font-mono text-xs">RESEND_API_KEY</code> e{' '}
                  <code className="font-mono text-xs">MAIL_FROM</code>, a fila acumula de propósito
                  e nada se perde — quando a chave entrar, o acumulado sai.
                </li>
                <li>
                  <strong>O agendador parou.</strong> É ele que drena a fila. Confira em{' '}
                  <a
                    href="/auditoria/trabalhos"
                    className="text-[var(--color-brand)] hover:underline"
                  >
                    Trabalhos agendados
                  </a>
                  .
                </li>
              </ol>
            </Card>
          )}

          <Card title="Últimas 100 mensagens">
            <Table
              label="Caixa de saída"
              head={['Para', 'Assunto', 'Tipo', 'Situação', 'Quando']}
            >
              {fila.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <span className="text-[var(--color-ink-2)]">{m.to_email}</span>
                    {m.to_name && (
                      <p className="text-xs text-[var(--color-ink-3)]">{m.to_name}</p>
                    )}
                  </Td>
                  <Td className="text-[var(--color-ink-2)]">{m.subject}</Td>
                  <Td>
                    <span className="text-xs text-[var(--color-ink-3)]">
                      {ROTULO[m.kind] ?? m.kind}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={tomDaSituacao(m.status)}>
                      {NOME_DA_SITUACAO[m.status] ?? m.status}
                    </Badge>
                    {m.attempts > 0 && (
                      <p className="mt-1 text-xs text-[var(--color-ink-3)]">
                        {m.attempts} tentativa(s)
                      </p>
                    )}
                    {/* O erro do provedor, em inglês e citando cabeçalho HTTP, só
                        chega aqui — nunca a uma tela de quem usa o sistema. */}
                    {m.last_error && (
                      <p className="mt-1 max-w-xs text-xs text-[var(--color-breach-ink)]">
                        {m.last_error}
                      </p>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-[var(--color-ink-2)]">
                    {m.sent_at ? (
                      formatDateTime(m.sent_at)
                    ) : (
                      <span className="text-[var(--color-ink-3)]">
                        na fila desde {formatDateTime(m.created_at)}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
            <p className="mt-2 text-xs text-[var(--color-ink-3)]">
              O <strong>corpo</strong> das mensagens não é exibido: ele carrega o link de
              redefinição de senha e o token da pesquisa de satisfação, que enquanto valem abrem a
              conta de outra pessoa. O assunto, o destinatário e o erro respondem o que o suporte
              precisa saber.
            </p>
          </Card>
        </>
      )}
    </>
  )
}
