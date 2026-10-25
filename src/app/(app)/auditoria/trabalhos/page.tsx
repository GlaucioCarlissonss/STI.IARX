import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen } from '@/lib/session'
import { formatDateTime } from '@/lib/format'
import { Badge, Card, EmptyState, PageHeader, StatTile, Table, Td } from '@/components/ui'

export const metadata: Metadata = { title: 'Trabalhos agendados' }

interface Saude {
  job: string
  execucoes: number
  ultima_execucao: string
  ultimo_ok: boolean | null
  ultimo_detalhe: string | null
  ultimo_afetados: number | null
  falhas: number
  minutos_desde: number
}

interface Execucao {
  id: number
  job: string
  started_at: string
  finished_at: string | null
  ok: boolean | null
  affected: number | null
  detail: string | null
}

/**
 * Os trabalhos agendados.
 *
 * ## Por que esta tela existe
 *
 * A docs/13 mandava rodar SQL à mão para saber se o agendador parou. Quem
 * precisa dessa resposta — quem administra o ambiente — não tem psql.
 *
 * E a pergunta não é acadêmica: **trabalho parado é invisível por natureza.**
 * Não há erro, não há alerta, simplesmente nada acontece. O aviso de SLA não
 * sai, o chamado resolvido não fecha, o convite de satisfação não é enviado — e
 * o primeiro a perceber é o cliente que não recebeu nada.
 *
 * ## O número que importa é "há quanto tempo"
 *
 * Não é o total de execuções nem a taxa de sucesso: é **minutos desde a última**.
 * Um trabalho com 4.000 execuções bem-sucedidas e a última há três dias está
 * quebrado, e a taxa de sucesso continua dizendo 100%.
 */

/** Acima disto, o trabalho provavelmente parou. */
const LIMITE_DE_SILENCIO_MIN = 90

function tomDoSilencio(minutos: number) {
  if (minutos > LIMITE_DE_SILENCIO_MIN * 8) return 'breach' as const
  if (minutos > LIMITE_DE_SILENCIO_MIN) return 'warn' as const
  return 'ok' as const
}

function desdeQuando(minutos: number): string {
  if (minutos < 60) return `há ${Math.round(minutos)} min`
  if (minutos < 60 * 48) return `há ${Math.round(minutos / 60)} h`
  return `há ${Math.round(minutos / 1440)} dias`
}

export default async function TrabalhosPage() {
  await requireScreen('auditoria.trabalhos.ver')

  const supabase = await createClient()
  const [{ data: saude }, { data: execucoes }] = await Promise.all([
    supabase.from('vw_job_health').select('*').order('job').returns<Saude[]>(),
    supabase
      .from('job_runs')
      .select('id, job, started_at, finished_at, ok, affected, detail')
      .order('id', { ascending: false })
      .limit(50)
      .returns<Execucao[]>(),
  ])

  const resumo = saude ?? []
  const parados = resumo.filter((r) => r.minutos_desde > LIMITE_DE_SILENCIO_MIN)
  const comFalha = resumo.filter((r) => r.ultimo_ok === false)

  return (
    <>
      <PageHeader
        title="Trabalhos agendados"
        description="Aviso de SLA, fechamento automático, convite de satisfação, e-mail e respostas dos canais."
      />

      {resumo.length === 0 ? (
        <EmptyState
          title="Nenhuma execução registrada"
          description={
            /*
             * Duas causas muito diferentes com o mesmo sintoma, e a tela precisa
             * dizer as duas: `job_runs` é global (não tem `tenant_id`) e a policy
             * dela só devolve linha ao operador da plataforma. Então "vazio" pode
             * ser "nunca rodou" ou "você não é quem opera a plataforma" — e a
             * segunda não é defeito.
             */
            'Ou o agendador nunca chamou POST /api/jobs/run — veja docs/13 —, ou esta leitura é restrita ao operador da plataforma e o seu acesso é de administrador do ambiente.'
          }
        />
      ) : (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <StatTile label="Trabalhos" value={resumo.length} hint="que já rodaram ao menos uma vez" />
            {/* O indicador que importa: silêncio, não falha. */}
            <StatTile
              label="Em silêncio"
              value={parados.length}
              hint={`sem rodar há mais de ${LIMITE_DE_SILENCIO_MIN} min`}
              tone={parados.length > 0 ? 'breach' : 'ok'}
            />
            <StatTile
              label="Última falhou"
              value={comFalha.length}
              hint="o trabalho rodou e deu erro"
              tone={comFalha.length > 0 ? 'warn' : 'ok'}
            />
          </div>

          <Card title="Situação por trabalho" className="mb-6">
            <Table
              label="Saúde dos trabalhos"
              head={['Trabalho', 'Última execução', 'Resultado', 'Execuções']}
            >
              {resumo.map((r) => (
                <tr key={r.job}>
                  <Td className="font-mono text-xs">{r.job}</Td>
                  <Td>
                    <Badge tone={tomDoSilencio(r.minutos_desde)}>
                      {desdeQuando(r.minutos_desde)}
                    </Badge>
                    <p className="mt-1 text-xs text-[var(--color-ink-3)]">
                      {formatDateTime(r.ultima_execucao)}
                    </p>
                  </Td>
                  <Td>
                    {r.ultimo_ok === false ? (
                      <span className="text-sm text-[var(--color-breach-ink)]">
                        falhou: {r.ultimo_detalhe ?? 'sem detalhe'}
                      </span>
                    ) : r.ultimo_ok === null ? (
                      <span className="text-sm text-[var(--color-warn-ink)]">
                        começou e não terminou
                      </span>
                    ) : (
                      <span className="text-sm text-[var(--color-ink-2)]">
                        {r.ultimo_afetados ?? 0} registro(s)
                      </span>
                    )}
                  </Td>
                  <Td className="tabular-nums text-[var(--color-ink-2)]">
                    {r.execucoes}
                    {r.falhas > 0 && (
                      <p className="text-xs text-[var(--color-warn-ink)]">{r.falhas} com falha</p>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
            <p className="mt-2 text-xs text-[var(--color-ink-3)]">
              O número que importa é <strong>há quanto tempo</strong>, e não a taxa de sucesso: um
              trabalho com 4.000 execuções perfeitas e a última há três dias está parado — e a taxa
              continua dizendo 100%.
            </p>
          </Card>

          <Card title="Últimas 50 execuções">
            <Table label="Execuções" head={['Trabalho', 'Início', 'Duração', 'Resultado']}>
              {(execucoes ?? []).map((e) => {
                const duracao = e.finished_at
                  ? Math.round(
                      (new Date(e.finished_at).getTime() - new Date(e.started_at).getTime()) / 1000,
                    )
                  : null
                return (
                  <tr key={e.id}>
                    <Td className="font-mono text-xs">{e.job}</Td>
                    <Td className="whitespace-nowrap text-[var(--color-ink-2)]">
                      {formatDateTime(e.started_at)}
                    </Td>
                    <Td className="tabular-nums text-[var(--color-ink-2)]">
                      {duracao === null ? '—' : `${duracao}s`}
                    </Td>
                    <Td>
                      {e.ok === false ? (
                        <span className="text-sm text-[var(--color-breach-ink)]">
                          {e.detail ?? 'falhou'}
                        </span>
                      ) : e.ok === null ? (
                        <span className="text-sm text-[var(--color-warn-ink)]">inacabada</span>
                      ) : (
                        <span className="text-sm text-[var(--color-ink-2)]">
                          {e.affected ?? 0} registro(s)
                        </span>
                      )}
                    </Td>
                  </tr>
                )
              })}
            </Table>
          </Card>
        </>
      )}

      <Card title="Se um trabalho parou" className="mt-6">
        <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-[var(--color-ink-2)]">
          <li>
            Confira se o agendador ainda chama <code className="font-mono text-xs">POST /api/jobs/run</code>{' '}
            — cron, GitHub Actions ou pg_cron, conforme o que foi configurado.
          </li>
          <li>
            Confira se <code className="font-mono text-xs">JOBS_SECRET</code> continua definido: sem
            ele a rota responde 503, fechada, e nenhuma execução é registrada.
          </li>
          <li>
            O passo a passo está em <strong>docs/13</strong>.
          </li>
        </ol>
      </Card>
    </>
  )
}
