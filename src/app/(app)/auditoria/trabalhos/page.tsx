import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen } from '@/lib/session'
import { formatDateTime } from '@/lib/format'
import { Badge, Card, EmptyState, FaixaDeIndicadores, PageHeader, StatTile, Table, Td } from '@/components/ui'

export const metadata: Metadata = { title: 'Trabalhos agendados' }

interface Alerta {
  job: string
  rotulo: string
  tolerancia_min: number
  ultima_execucao: string | null
  ultimo_ok: boolean | null
  ultimo_detalhe: string | null
  minutos_desde: number | null
  situacao: 'ok' | 'falhou' | 'parou' | 'nunca_rodou'
}

interface Saude {
  job: string
  execucoes: number
  ultimo_afetados: number | null
  falhas: number
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

interface Episodio {
  id: number
  job: string
  tipo: 'falhou' | 'parou'
  aberto_em: string
  fechado_em: string | null
  detalhe: string | null
  avisado_em: string | null
  canais: string[] | null
  erro_do_aviso: string | null
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
 * ## A tela deixou de ter opinião própria sobre o que é "parado"
 *
 * Até a 0055 havia aqui um `LIMITE_DE_SILENCIO_MIN = 90` aplicado a todos os
 * trabalhos. Era a única fonte da verdade sobre cadência, e estava errada para
 * quase todos: a purga roda uma vez por dia e aparecia vermelha todo dia; o
 * aviso de SLA pode estar quebrado há uma hora e aparecia verde.
 *
 * Agora quem sabe a cadência esperada é `job_expectations`, no banco, onde o
 * alerta automático também a lê. A tela e o alerta passaram a concordar por
 * construção — e não por alguém lembrar de mudar os dois.
 *
 * ## O que esta tela mostra que o alerta não manda
 *
 * O alerta avisa uma vez por episódio, de propósito. Quem abre esta tela quer o
 * estado de AGORA, e também quer saber se o aviso de fato saiu: um episódio
 * aberto com `avisado_em` vazio é um problema que ninguém recebeu.
 */

function tomDaSituacao(s: Alerta['situacao']) {
  if (s === 'parou') return 'breach' as const
  if (s === 'falhou') return 'warn' as const
  if (s === 'nunca_rodou') return 'neutral' as const
  return 'ok' as const
}

function nomeDaSituacao(s: Alerta['situacao']): string {
  return { ok: 'em dia', falhou: 'falhou', parou: 'parou', nunca_rodou: 'nunca rodou' }[s]
}

function desdeQuando(minutos: number | null): string {
  if (minutos === null) return 'nunca'
  if (minutos < 60) return `há ${Math.round(minutos)} min`
  if (minutos < 60 * 48) return `há ${Math.round(minutos / 60)} h`
  return `há ${Math.round(minutos / 1440)} dias`
}

function tolerânciaEmPalavras(minutos: number): string {
  if (minutos < 60) return `${minutos} min`
  if (minutos < 1440) return `${Math.round(minutos / 60)} h`
  return `${Math.round(minutos / 1440)} dia(s)`
}

export default async function TrabalhosPage() {
  await requireScreen('auditoria.trabalhos.ver')

  const supabase = await createClient()
  const [{ data: alertas }, { data: saude }, { data: execucoes }, { data: episodios }] =
    await Promise.all([
      supabase.from('vw_job_alerts').select('*').order('job').returns<Alerta[]>(),
      supabase
        .from('vw_job_health')
        .select('job, execucoes, ultimo_afetados, falhas')
        .returns<Saude[]>(),
      supabase
        .from('job_runs')
        .select('id, job, started_at, finished_at, ok, affected, detail')
        .order('id', { ascending: false })
        .limit(50)
        .returns<Execucao[]>(),
      supabase
        .from('job_alert_episodes')
        .select('id, job, tipo, aberto_em, fechado_em, detalhe, avisado_em, canais, erro_do_aviso')
        .order('id', { ascending: false })
        .limit(20)
        .returns<Episodio[]>(),
    ])

  const resumo = alertas ?? []
  /*
   * Contagens e falhas vêm numa consulta separada, casada aqui por `job`: o
   * driver local (docs/22) fala o dialeto do PostgREST mas não resolve relação
   * aninhada no `select`, e são oito linhas de cada lado.
   */
  const porJob = new Map((saude ?? []).map((s) => [s.job, s]))

  const parados = resumo.filter((r) => r.situacao === 'parou')
  const comFalha = resumo.filter((r) => r.situacao === 'falhou')
  const abertos = (episodios ?? []).filter((e) => e.fechado_em === null)
  const semAviso = abertos.filter((e) => e.avisado_em === null)

  return (
    <>
      <PageHeader
        title="Trabalhos agendados"
        description="Aviso de SLA, fechamento automático, convite de satisfação, e-mail e respostas dos canais."
      />

      {resumo.length === 0 ? (
        <EmptyState
          title="Nenhum trabalho visível"
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
          <FaixaDeIndicadores>
            <StatTile label="Trabalhos" value={resumo.length} hint="com cadência esperada declarada" />
            {/* O indicador que importa: silêncio, não falha. */}
            <StatTile
              label="Parados"
              value={parados.length}
              hint="sem rodar dentro da própria cadência"
              tone={parados.length > 0 ? 'breach' : 'ok'}
            />
            <StatTile
              label="Última falhou"
              value={comFalha.length}
              hint="o trabalho rodou e deu erro"
              tone={comFalha.length > 0 ? 'warn' : 'ok'}
            />
            <StatTile
              label="Sem aviso enviado"
              value={semAviso.length}
              hint="episódio aberto que ninguém recebeu"
              tone={semAviso.length > 0 ? 'warn' : 'ok'}
            />
          </FaixaDeIndicadores>

          {abertos.length > 0 && (
            <Card title="Episódios abertos" className="mb-6">
              <Table label="Episódios" head={['Trabalho', 'Desde', 'O que houve', 'Aviso']}>
                {abertos.map((e) => (
                  <tr key={e.id}>
                    <Td>
                      <span className="font-medium">
                        {resumo.find((r) => r.job === e.job)?.rotulo ?? e.job}
                      </span>
                      <p className="font-mono text-xs text-[var(--color-ink-3)]">{e.job}</p>
                    </Td>
                    <Td className="whitespace-nowrap text-[var(--color-ink-2)]">
                      {formatDateTime(e.aberto_em)}
                    </Td>
                    <Td className="text-sm text-[var(--color-ink-2)]">{e.detalhe ?? '—'}</Td>
                    <Td>
                      {e.avisado_em ? (
                        <>
                          <Badge tone="ok">enviado</Badge>
                          <p className="mt-1 text-xs text-[var(--color-ink-3)]">
                            {(e.canais ?? []).join(', ') || 'sem canal registrado'}
                          </p>
                        </>
                      ) : (
                        <>
                          <Badge tone="warn">não enviado</Badge>
                          <p className="mt-1 text-xs text-[var(--color-warn-ink)]">
                            {e.erro_do_aviso ?? 'nenhum canal de alerta configurado'}
                          </p>
                        </>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
              <p className="mt-2 text-xs text-[var(--color-ink-3)]">
                O aviso sai <strong>uma vez por episódio</strong>, não a cada execução: um trabalho
                que falha de cinco em cinco minutos mandaria 288 e-mails por dia, e no segundo dia
                ninguém leria nenhum.
              </p>
            </Card>
          )}

          <Card title="Situação por trabalho" className="mb-6">
            <Table
              label="Saúde dos trabalhos"
              head={['Trabalho', 'Situação', 'Última execução', 'Resultado', 'Execuções']}
            >
              {resumo.map((r) => {
                const s = porJob.get(r.job)
                return (
                  <tr key={r.job}>
                    <Td>
                      <span className="font-medium">{r.rotulo}</span>
                      <p className="font-mono text-xs text-[var(--color-ink-3)]">{r.job}</p>
                    </Td>
                    <Td>
                      <Badge tone={tomDaSituacao(r.situacao)}>{nomeDaSituacao(r.situacao)}</Badge>
                      <p className="mt-1 text-xs text-[var(--color-ink-3)]">
                        tolera {tolerânciaEmPalavras(r.tolerancia_min)}
                      </p>
                    </Td>
                    <Td>
                      <span className="text-sm text-[var(--color-ink-2)]">
                        {desdeQuando(r.minutos_desde)}
                      </span>
                      {r.ultima_execucao && (
                        <p className="mt-1 text-xs text-[var(--color-ink-3)]">
                          {formatDateTime(r.ultima_execucao)}
                        </p>
                      )}
                    </Td>
                    <Td>
                      {r.ultimo_ok === false ? (
                        <span className="text-sm text-[var(--color-breach-ink)]">
                          {r.ultimo_detalhe ?? 'sem detalhe'}
                        </span>
                      ) : r.ultimo_ok === null ? (
                        <span className="text-sm text-[var(--color-ink-3)]">—</span>
                      ) : (
                        <span className="text-sm text-[var(--color-ink-2)]">
                          {s?.ultimo_afetados ?? 0} registro(s)
                        </span>
                      )}
                    </Td>
                    <Td className="tabular-nums text-[var(--color-ink-2)]">
                      {s?.execucoes ?? 0}
                      {(s?.falhas ?? 0) > 0 && (
                        <p className="text-xs text-[var(--color-warn-ink)]">{s?.falhas} com falha</p>
                      )}
                    </Td>
                  </tr>
                )
              })}
            </Table>
            <p className="mt-2 text-xs text-[var(--color-ink-3)]">
              O número que importa é <strong>há quanto tempo</strong>, e não a taxa de sucesso: um
              trabalho com 4.000 execuções perfeitas e a última há três dias está parado — e a taxa
              continua dizendo 100%. Cada trabalho tem a sua própria tolerância, declarada em{' '}
              <code className="font-mono text-xs">job_expectations</code>: a purga roda uma vez por
              dia, o aviso de SLA a cada cinco minutos, e um limite único deixaria um dos dois errado.
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
            Para receber aviso sem abrir esta tela, defina{' '}
            <code className="font-mono text-xs">ALERTA_OPERACAO_EMAIL</code> e/ou{' '}
            <code className="font-mono text-xs">ALERTA_OPERACAO_WEBHOOK</code>.{' '}
            <strong>Mas note o limite:</strong> esse aviso é disparado pela própria rota de
            trabalhos. Se o agendador morrer por inteiro, ninguém o chama e nenhum aviso sai — por
            isso o monitor de disponibilidade deve apontar para{' '}
            <code className="font-mono text-xs">/api/health</code>, que não depende dele.
          </li>
          <li>
            O passo a passo está em <strong>docs/13</strong>; subir e restaurar, em{' '}
            <strong>docs/24</strong>.
          </li>
        </ol>
      </Card>
    </>
  )
}
