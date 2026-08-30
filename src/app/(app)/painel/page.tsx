import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { requireSession, allowed } from '@/lib/session'
import { formatCurrency, formatMinutes } from '@/lib/format'
import type {
  BankAccountBalance,
  DashboardMetrics,
  EnrichedTicket,
  Payable,
  Receivable,
} from '@/lib/types'
import { Card, EmptyState, PageHeader, StatTile } from '@/components/ui'
import { TicketList } from '@/components/ticket-list'
import { RealtimeRefresh } from '@/components/realtime-refresh'

export const metadata: Metadata = { title: 'Visão geral' }

/**
 * Visão geral — a tela inicial de todo mundo.
 *
 * Deixou de ser "painel do helpdesk". A mudança não foi estética: com o menu
 * agrupado, `/painel` é o primeiro item e o destino natural pós-login, e um
 * Aprovador Financeiro caía aqui sem ter `helpdesk.painel.ver`. Antes isso
 * produzia laço de redirect; agora a página é aberta a qualquer sessão e cada
 * BLOCO é que exige a permissão do seu módulo.
 *
 * Consequência prática: nenhuma consulta é feita para bloco que a pessoa não vê.
 * Além de não desperdiçar viagem ao banco, evita a leitura errada de "a query
 * voltou vazia" quando o certo é "esta pessoa não olha para isso".
 */
export default async function VisaoGeralPage() {
  const { profile } = await requireSession()

  const [verHelpdesk, verSla, verPagar, verReceber, verContas, verInventario, verTelefonia, verTv] =
    await Promise.all([
      allowed('helpdesk.painel.ver'),
      allowed('sla.compliance.ver'),
      allowed('financeiro.titulos_pagar.ver'),
      allowed('financeiro.titulos_receber.ver'),
      allowed('financeiro.contas_bancarias.ver'),
      allowed('inventario.ativos.ver'),
      allowed('telefonia.linhas.ver'),
      allowed('tv.tokens.ver'),
    ])

  const supabase = await createClient()
  const hoje = new Date().toISOString().slice(0, 10)

  const [metrics, online, atRisk, mine, saldos, aPagar, aReceber, ativos, linhas] =
    await Promise.all([
      verHelpdesk
        ? supabase.from('vw_dashboard_metrics').select('*').maybeSingle<DashboardMetrics>()
        : null,
      verHelpdesk
        ? supabase.from('vw_agents_online').select('agents_online, agents_total').maybeSingle()
        : null,
      verHelpdesk
        ? supabase
            .from('vw_tickets_enriched')
            .select('*')
            .in('resolution_state', ['breached', 'critical', 'warning'])
            .not('status', 'in', '("resolved","closed")')
            .order('minutes_to_resolution_due', { ascending: true })
            .limit(8)
            .returns<EnrichedTicket[]>()
        : null,
      verHelpdesk
        ? supabase
            .from('vw_tickets_enriched')
            .select('*')
            .eq('assignee_id', profile.id)
            .not('status', 'in', '("resolved","closed")')
            .order('queue_score', { ascending: false })
            .limit(8)
            .returns<EnrichedTicket[]>()
        : null,
      verContas
        ? supabase
            .from('vw_bank_account_balances')
            .select('bank_account_id, name, status, current_balance, unreconciled_count')
            .eq('status', 'active')
            .returns<BankAccountBalance[]>()
        : null,
      verPagar
        ? supabase
            .from('payables')
            .select('id, amount, due_on, status')
            .is('deleted_at', null)
            .not('status', 'in', '("paid","cancelled")')
            .returns<Pick<Payable, 'id' | 'amount' | 'due_on' | 'status'>[]>()
        : null,
      verReceber
        ? supabase
            .from('receivables')
            .select('id, amount, due_on, status')
            .is('deleted_at', null)
            .eq('status', 'open')
            .returns<Pick<Receivable, 'id' | 'amount' | 'due_on' | 'status'>[]>()
        : null,
      verInventario
        ? supabase
            .from('it_assets')
            .select('id', { count: 'exact', head: true })
            .is('deleted_at', null)
        : null,
      verTelefonia
        ? supabase
            .from('telecom_lines')
            .select('id', { count: 'exact', head: true })
            .is('deleted_at', null)
            .eq('status', 'active')
        : null,
    ])

  const m = metrics?.data
  const pagar = aPagar?.data ?? []
  const receber = aReceber?.data ?? []
  const contas = saldos?.data ?? []

  const totalPagar = pagar.reduce((s, t) => s + Number(t.amount), 0)
  const pagarVencido = pagar.filter((t) => t.due_on < hoje)
  const aguardandoAprovacao = pagar.filter((t) => t.status === 'pending_approval')
  const totalReceber = receber.reduce((s, t) => s + Number(t.amount), 0)
  const receberVencido = receber.filter((t) => t.due_on < hoje)
  const saldoTotal = contas.reduce((s, c) => s + Number(c.current_balance), 0)

  const verFinanceiro = verPagar || verReceber || verContas
  const verInfra = verInventario || verTelefonia
  const nenhumBloco = !verHelpdesk && !verFinanceiro && !verInfra && !verSla

  return (
    <>
      {/* Atualiza os contadores quando qualquer ticket muda (RNF-08). */}
      {verHelpdesk && <RealtimeRefresh />}

      <PageHeader
        title={`Olá, ${profile.full_name.split(' ')[0]}`}
        description="Cada bloco aparece conforme o que o seu perfil de acesso alcança."
        action={
          verTv ? (
            <Link
              href="/tv"
              className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
            >
              Painéis de TV
            </Link>
          ) : undefined
        }
      />

      {nenhumBloco && (
        <EmptyState
          title="Nada para mostrar aqui ainda"
          description="Seu perfil de acesso não alcança nenhum dos módulos com indicadores. Use o menu para o que estiver disponível, ou peça ao administrador para revisar o seu perfil."
        />
      )}

      {/* ---------------------------------------------------------- Financeiro */}
      {/* Vem antes do helpdesk quando existe: quem tem os dois costuma abrir a
          tela para olhar dinheiro, e o helpdesk tem tela própria e painel de TV. */}
      {verFinanceiro && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-[var(--color-ink)]">Financeiro</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {verContas && (
              <StatTile
                label="Saldo consolidado"
                value={formatCurrency(saldoTotal)}
                hint={`${contas.length} conta(s) ativa(s)`}
                tone={saldoTotal < 0 ? 'breach' : 'ok'}
              />
            )}
            {verPagar && (
              <StatTile
                label="A pagar"
                value={formatCurrency(totalPagar)}
                hint={`${pagar.length} título(s) em aberto`}
              />
            )}
            {verPagar && (
              <StatTile
                label="Vencido a pagar"
                value={formatCurrency(pagarVencido.reduce((s, t) => s + Number(t.amount), 0))}
                hint={`${pagarVencido.length} título(s)`}
                tone={pagarVencido.length > 0 ? 'crit' : 'ok'}
              />
            )}
            {verPagar && (
              <StatTile
                label="Aguardando aprovação"
                value={aguardandoAprovacao.length}
                hint={formatCurrency(
                  aguardandoAprovacao.reduce((s, t) => s + Number(t.amount), 0),
                )}
                tone={aguardandoAprovacao.length > 0 ? 'warn' : 'neutral'}
              />
            )}
            {verReceber && (
              <StatTile
                label="A receber"
                value={formatCurrency(totalReceber)}
                hint={`${receber.length} título(s) aberto(s)`}
              />
            )}
            {verReceber && (
              <StatTile
                label="Vencido a receber"
                value={formatCurrency(receberVencido.reduce((s, t) => s + Number(t.amount), 0))}
                hint={`${receberVencido.length} título(s)`}
                tone={receberVencido.length > 0 ? 'crit' : 'ok'}
              />
            )}
            {verContas && (
              <StatTile
                label="Não conciliadas"
                value={contas.reduce((s, c) => s + Number(c.unreconciled_count), 0)}
                hint="movimentações sem baixa"
                tone={
                  contas.reduce((s, c) => s + Number(c.unreconciled_count), 0) > 0
                    ? 'warn'
                    : 'neutral'
                }
              />
            )}
            {/* Saldo menos o que já está comprometido. É o número que responde
                "posso pagar isso?", e nenhuma das duas colunas responde sozinha. */}
            {verContas && verPagar && (
              <StatTile
                label="Saldo após o a pagar"
                value={formatCurrency(saldoTotal - totalPagar)}
                hint="saldo menos títulos em aberto"
                tone={saldoTotal - totalPagar < 0 ? 'breach' : 'ok'}
              />
            )}
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------ Helpdesk */}
      {verHelpdesk && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-[var(--color-ink)]">Atendimento</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="Em aberto"
              value={m?.open_total ?? 0}
              hint={`${m?.open_new ?? 0} aguardando triagem`}
            />
            <StatTile label="Em andamento" value={m?.in_progress_total ?? 0} tone="info" />
            <StatTile label="Críticos" value={m?.critical_total ?? 0} tone="crit" />
            <StatTile label="SLA estourado" value={m?.sla_breached ?? 0} tone="breach" />
            <StatTile label="SLA em risco" value={m?.sla_at_risk ?? 0} tone="warn" />
            <StatTile
              label="Aguardando terceiros"
              value={m?.waiting_total ?? 0}
              hint="relógio de SLA pausado"
            />
            <StatTile
              label="Resolvidos hoje"
              value={m?.resolved_today ?? 0}
              tone="ok"
              hint={`${m?.created_today ?? 0} abertos hoje`}
            />
            <StatTile
              label="Tempo médio de resolução"
              value={formatMinutes(m?.avg_resolution_minutes_24h)}
              hint="últimas 24 horas"
            />
          </div>

          <div className="mt-3">
            <Card
              title={`Atendentes online: ${online?.data?.agents_online ?? 0} de ${
                online?.data?.agents_total ?? 0
              }`}
            >
              <p className="text-sm text-[var(--color-ink-2)]">
                Considera atividade nos últimos 5 minutos.
              </p>
            </Card>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------ Infraestrutura */}
      {verInfra && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-[var(--color-ink)]">Infraestrutura</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {verInventario && (
              <StatTile label="Ativos de TI" value={ativos?.count ?? 0} hint="não excluídos" />
            )}
            {verTelefonia && (
              <StatTile label="Linhas ativas" value={linhas?.count ?? 0} />
            )}
          </div>
        </section>
      )}

      {/* Listas de ticket ficam no fim: são para agir, não para medir, e quem
          mede olha os números acima. */}
      {verHelpdesk && (
        <>
          <section className="mb-8">
            <h2 className="mb-3 text-lg font-semibold text-[var(--color-ink)]">
              Atenção imediata — SLA em risco ou estourado
            </h2>
            {atRisk?.data && atRisk.data.length > 0 ? (
              <TicketList tickets={atRisk.data} />
            ) : (
              <EmptyState
                title="Nenhum ticket em risco"
                description="Todos os prazos estão sob controle."
              />
            )}
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold text-[var(--color-ink)]">Meus tickets</h2>
            {mine?.data && mine.data.length > 0 ? (
              <TicketList tickets={mine.data} />
            ) : (
              <EmptyState title="Nenhum ticket atribuído a você" />
            )}
          </section>
        </>
      )}
    </>
  )
}
