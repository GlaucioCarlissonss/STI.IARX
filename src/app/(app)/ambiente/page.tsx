import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { Card, EmptyState, PageHeader } from '@/components/ui'
import { PreferenciasForm, type Preferencias } from './preferencias-form'

export const metadata: Metadata = { title: 'Preferências do ambiente' }

/**
 * As preferências de operação do tenant.
 *
 * ## Por que esta tela existe
 *
 * `tenants` carrega onze parâmetros que governam **quando o sistema age
 * sozinho** — percentuais de SLA, fechamento automático, cota de anexo,
 * aprovação de título, os quatro do agente, e os dois de alerta que a 0041
 * acrescentou. Nenhum deles jamais teve tela.
 *
 * Isso não é um detalhe de conforto: significa que, em qualquer ambiente já
 * instalado, **todos os onze estão no valor padrão da migração que os criou** —
 * não porque alguém escolheu, mas porque mudá-los exigia um `update` à mão no
 * banco, e ninguém faz isso num sistema em produção por causa de um percentual.
 *
 * É o mesmo defeito que a 0036 corrigiu em seis tabelas, e a regra desta base é
 * explícita: configuração sem tela é configuração morta.
 *
 * ## A escrita já era permitida
 *
 * A policy `tenants_update` existe desde a 0012 e exige `can_manage_config()`
 * — admin e super_admin. Esta tela não afrouxa nada: ela usa o caminho que já
 * estava aberto e vazio.
 */
export default async function AmbientePage() {
  await requireScreen('ambiente.preferencias.ver')
  const podeEditar = await allowed('ambiente.preferencias.editar')

  const supabase = await createClient()
  const { data: tenant } = await supabase
    .from('tenants')
    .select(
      'id, name, sla_warning_pct, sla_critical_pct, auto_close_after_days, attachment_quota_mb, payable_approval_required, agent_disk_alert_pct, agent_mute_hours, agent_metrics_retention_days, contract_alert_days, link_alert_minutes',
    )
    .maybeSingle<Preferencias & { id: string; name: string }>()

  if (!tenant) {
    return (
      <>
        <PageHeader title="Preferências do ambiente" />
        <EmptyState
          title="Não consegui ler o ambiente"
          description="A sessão não está associada a nenhuma empresa. Saia e entre de novo; se persistir, é caso para quem administra o ambiente."
        />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Preferências do ambiente"
        description={`O que o sistema faz sozinho em ${tenant.name} — e quando.`}
      />

      <Card title="O que muda aqui, muda longe" className="mb-6">
        <p className="text-sm text-[var(--color-ink-2)]">
          Nenhum destes números tem efeito visível no instante em que é salvo. O percentual de
          atenção muda o e-mail que sai de madrugada; a retenção de métricas muda o que terá sido
          apagado na semana que vem. Por isso cada campo diz o que acontece quando é mexido — e os
          zeros, que desligam em vez de zerar, dizem antes.
        </p>
        <p className="mt-2 text-sm text-[var(--color-ink-2)]">
          Quem executa isso são os trabalhos agendados. Se eles pararem, nada aqui tem efeito — e{' '}
          <Link
            href={'/auditoria/trabalhos' as Route}
            className="text-[var(--color-brand-ink)] hover:underline"
          >
            a tela de trabalhos agendados
          </Link>{' '}
          é onde se vê se pararam.
        </p>
      </Card>

      <PreferenciasForm atual={tenant} podeEditar={podeEditar} />
    </>
  )
}
