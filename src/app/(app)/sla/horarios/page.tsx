import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { Card, EmptyState, PageHeader, StatTile } from '@/components/ui'
import { ExpedienteForm } from './expediente-form'
import { ExpedienteCard } from './expediente-card'

export const metadata: Metadata = { title: 'Expediente e feriados' }

export interface Expediente {
  id: string
  name: string
  timezone: string
  is_default: boolean
}

export interface Faixa {
  id: string
  business_hours_id: string
  weekday: number
  starts_at: string
  ends_at: string
}

export interface Feriado {
  id: string
  business_hours_id: string
  holiday_date: string
  name: string
}

/**
 * Expediente e feriados.
 *
 * ## Por que esta tela não existia, e o que isso custava
 *
 * As três tabelas estão no banco desde a migração 0006, e a aritmética de prazo
 * já as lê: `fn_add_business_minutes` só conta minuto dentro de faixa, e
 * `fn_business_minutes_between` é o que credita a pausa do relógio.
 *
 * O que faltava era a tela. Dava para **escolher** um expediente no formulário
 * de contrato e no de definição de SLA, e não dava para **criar** nenhum. Na
 * prática: todo ambiente vivia com o expediente do seed, e **nenhum feriado era
 * respeitado** — um chamado aberto em 24 de dezembro às 17h vencia no dia 25 de
 * manhã, com a equipe em casa.
 *
 * ## Três coisas que a tela precisa dizer, porque o banco não diz
 *
 * - **Expediente sem faixa não conta tempo nenhum.** É um estado gravável e
 *   silencioso: o contrato aponta para ele, a conta roda e nunca vence.
 * - **Feriado tem ano.** Carnaval e Corpus Christi mudam de data; um "recorrente"
 *   que servisse só aos fixos seria armadilha.
 * - **Mudar o expediente muda prazo de chamado em andamento.** Não é um cadastro
 *   inerte.
 */
export default async function HorariosPage() {
  await requireScreen('sla.horarios.ver')
  const podeCriar = await allowed('sla.horarios.criar')
  const podeEditar = await allowed('sla.horarios.editar')

  const supabase = await createClient()
  const [{ data: expedientes }, { data: faixas }, { data: feriados }, { data: usos }] =
    await Promise.all([
      supabase
        .from('business_hours')
        .select('id, name, timezone, is_default')
        .order('is_default', { ascending: false })
        .order('name')
        .returns<Expediente[]>(),
      supabase
        .from('business_hours_intervals')
        .select('id, business_hours_id, weekday, starts_at, ends_at')
        .order('weekday')
        .order('starts_at')
        .returns<Faixa[]>(),
      supabase
        .from('business_hours_holidays')
        .select('id, business_hours_id, holiday_date, name')
        .order('holiday_date')
        .returns<Feriado[]>(),
      /* Quem usa cada expediente. Sem isto, apagar ou reconfigurar um seria um
         tiro no escuro: os contratos que apontam para ele passariam a contar
         diferente sem ninguém ver a relação. */
      supabase
        .from('sla_contracts')
        .select('business_hours_id')
        .not('business_hours_id', 'is', null)
        .returns<{ business_hours_id: string }[]>(),
    ])

  const lista = expedientes ?? []
  const todasFaixas = faixas ?? []
  const semFaixa = lista.filter(
    (e) => todasFaixas.filter((f) => f.business_hours_id === e.id).length === 0,
  ).length

  const hoje = new Date().toISOString().slice(0, 10)
  const feriadosFuturos = (feriados ?? []).filter((f) => f.holiday_date >= hoje).length

  return (
    <>
      <PageHeader
        title="Expediente e feriados"
        description="Onde o relógio do SLA corre e onde ele para. Toda conta de prazo passa por aqui."
        action={
          <Link
            href={'/sla' as Route}
            className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
          >
            Voltar ao SLA
          </Link>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <StatTile label="Expedientes" value={lista.length} />
        {/* O indicador que importa: expediente sem faixa é um relógio parado que
            ninguém vê. O contrato aponta para ele, a conta roda e nunca vence. */}
        <StatTile
          label="Sem faixa de horário"
          value={semFaixa}
          hint="não contam tempo nenhum"
          tone={semFaixa > 0 ? 'breach' : 'ok'}
        />
        <StatTile
          label="Feriados à frente"
          value={feriadosFuturos}
          hint="dias em que o prazo não corre"
          tone={feriadosFuturos === 0 ? 'warn' : 'ok'}
        />
      </div>

      {lista.length === 0 ? (
        <EmptyState
          title="Nenhum expediente cadastrado"
          description="Sem expediente, o prazo de SLA conta 24 horas por dia, inclusive domingo e Natal."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {lista.map((e) => (
            <ExpedienteCard
              key={e.id}
              expediente={e}
              faixas={todasFaixas.filter((f) => f.business_hours_id === e.id)}
              feriados={(feriados ?? []).filter((f) => f.business_hours_id === e.id)}
              contratos={(usos ?? []).filter((u) => u.business_hours_id === e.id).length}
              podeEditar={podeEditar}
            />
          ))}
        </div>
      )}

      {podeCriar && <ExpedienteForm className="mt-6" />}

      <Card title="Como isto entra na conta do prazo" className="mt-6">
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-[var(--color-ink-2)]">
          <li>
            O prazo só anda <strong>dentro</strong> de uma faixa. Um chamado aberto às 17h50 com
            prazo de 30 minutos vence às 8h20 do dia seguinte, não às 18h20.
          </li>
          <li>
            <strong>Feriado não conta</strong>, e por isso ele tem ano: Carnaval e Corpus Christi
            mudam de data, e um feriado &ldquo;recorrente&rdquo; que só servisse aos fixos seria pior que
            nenhum.
          </li>
          <li>
            Duas faixas no mesmo dia são o almoço: <strong>08:00–12:00</strong> e{' '}
            <strong>13:00–18:00</strong> fazem o relógio parar entre uma e outra.
          </li>
          <li>
            <strong>Mudar um expediente muda o prazo de chamado em andamento.</strong> A conta é
            refeita a partir da abertura — isto não é cadastro inerte.
          </li>
        </ul>
      </Card>
    </>
  )
}
