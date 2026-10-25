'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { Card, ErrorNote, Field, inputClass } from '@/components/ui'
import { salvarPreferencias } from './actions'

export interface Preferencias {
  sla_warning_pct: number
  sla_critical_pct: number
  auto_close_after_days: number
  attachment_quota_mb: number
  payable_approval_required: boolean
  agent_disk_alert_pct: number
  agent_mute_hours: number
  agent_metrics_retention_days: number
  contract_alert_days: number
  link_alert_minutes: number
}

function Numero({
  nome,
  rotulo,
  dica,
  valor,
  min,
  max,
  sufixo,
}: {
  nome: keyof Preferencias
  rotulo: string
  dica: string
  valor: number
  min: number
  max: number
  sufixo: string
}) {
  return (
    <Field label={rotulo} htmlFor={nome} hint={dica}>
      <div className="flex items-center gap-2">
        <input
          id={nome}
          name={nome}
          type="number"
          inputMode="numeric"
          defaultValue={valor}
          min={min}
          max={max}
          required
          className={`${inputClass} max-w-28 tabular-nums`}
        />
        <span className="text-sm text-[var(--color-ink-3)]">{sufixo}</span>
      </div>
    </Field>
  )
}

/**
 * As preferências de operação do ambiente.
 *
 * ## Por que cada campo diz o que acontece se for mexido
 *
 * Nenhum destes números tem efeito visível no instante em que é salvo. O
 * percentual de atenção muda o e-mail que sai amanhã de madrugada; a retenção de
 * métricas muda o que terá sido apagado na semana que vem. Um formulário de
 * números sem consequência escrita é um convite a girar o botão para ver o que
 * acontece — e o que acontece, aqui, acontece longe e depois.
 *
 * ## E por que os zeros têm aviso próprio
 *
 * `0` em fechamento automático **desliga** o recurso em vez de fechar tudo na
 * hora. É a diferença entre uma configuração e um acidente, e o campo diz isso
 * antes, não depois.
 */
export function PreferenciasForm({
  atual,
  podeEditar,
}: {
  atual: Preferencias
  podeEditar: boolean
}) {
  const [state, formAction] = useActionState(salvarPreferencias, {})

  if (!podeEditar) {
    return (
      <Card title="Preferências">
        <p className="text-sm text-[var(--color-ink-2)]">
          Estas preferências governam quando o sistema age sozinho. Só quem administra o ambiente
          pode alterá-las — o que você vê abaixo é o que está valendo.
        </p>
        <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Linha termo="Atenção de SLA" valor={`${atual.sla_warning_pct}%`} />
          <Linha termo="Crítico de SLA" valor={`${atual.sla_critical_pct}%`} />
          <Linha
            termo="Fechamento automático"
            valor={
              atual.auto_close_after_days === 0
                ? 'desligado'
                : `${atual.auto_close_after_days} dia(s)`
            }
          />
          <Linha termo="Cota de anexos" valor={`${atual.attachment_quota_mb} MB`} />
          <Linha
            termo="Aprovação de título"
            valor={atual.payable_approval_required ? 'exigida' : 'não exigida'}
          />
          <Linha termo="Alerta de disco" valor={`${atual.agent_disk_alert_pct}%`} />
          <Linha termo="Máquina muda" valor={`${atual.agent_mute_hours} h`} />
          <Linha termo="Retenção de métricas" valor={`${atual.agent_metrics_retention_days} dias`} />
          <Linha termo="Aviso de contrato" valor={`${atual.contract_alert_days} dias antes`} />
          <Linha termo="Alerta de link caído" valor={`${atual.link_alert_minutes} min`} />
        </dl>
      </Card>
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-6">
      {state.error && <ErrorNote>{state.error}</ErrorNote>}
      {state.success && (
        <p
          role="status"
          className="rounded-lg bg-[var(--color-ok-soft)] px-3.5 py-2.5 text-sm font-medium text-[var(--color-ok-ink)]"
        >
          {state.success}
        </p>
      )}

      <Card title="Prazos de atendimento">
        <div className="grid gap-5 sm:grid-cols-2">
          <Numero
            nome="sla_warning_pct"
            rotulo="Atenção a partir de"
            dica="Percentual do prazo consumido em que o chamado entra em atenção e o primeiro aviso sai."
            valor={atual.sla_warning_pct}
            min={1}
            max={99}
            sufixo="% do prazo"
          />
          <Numero
            nome="sla_critical_pct"
            rotulo="Crítico a partir de"
            dica="Tem de ser maior que o de atenção — senão o chamado entraria em crítico sem passar por atenção."
            valor={atual.sla_critical_pct}
            min={1}
            max={99}
            sufixo="% do prazo"
          />
          <Numero
            nome="auto_close_after_days"
            rotulo="Fechar sozinho depois de"
            dica="Dias que um chamado resolvido espera antes de fechar. ZERO DESLIGA o fechamento automático — não fecha na hora."
            valor={atual.auto_close_after_days}
            min={0}
            max={365}
            sufixo="dia(s) resolvido"
          />
        </div>
      </Card>

      <Card title="Avisos de contrato e de link">
        <div className="grid gap-5 sm:grid-cols-2">
          <Numero
            nome="contract_alert_days"
            rotulo="Avisar do fim do contrato"
            dica="Primeiro aviso. O segundo sai a 7 dias do fim, quando este prazo for maior que isso. Vale para contrato de fornecedor, de link e para o fim da fidelidade."
            valor={atual.contract_alert_days}
            min={1}
            max={365}
            sufixo="dias antes"
          />
          <Numero
            nome="link_alert_minutes"
            rotulo="Avisar de link caído após"
            dica="Queda mais curta que isto é oscilação de operadora. Avisar oscilação ensina a ignorar o aviso — e a perder a queda de três horas junto."
            valor={atual.link_alert_minutes}
            min={1}
            max={1440}
            sufixo="minutos fora"
          />
        </div>
      </Card>

      <Card title="Agente nas máquinas">
        <div className="grid gap-5 sm:grid-cols-2">
          <Numero
            nome="agent_disk_alert_pct"
            rotulo="Alertar disco a partir de"
            dica="O alerta fecha sozinho com cinco pontos de folga, para o disco na fronteira não abrir e fechar aviso a cada coleta."
            valor={atual.agent_disk_alert_pct}
            min={50}
            max={99}
            sufixo="% de uso"
          />
          <Numero
            nome="agent_mute_hours"
            rotulo="Máquina é 'muda' após"
            dica="Agente parado é invisível: não dá erro, só deixa de haver dado novo. Este é o prazo até alguém ser avisado."
            valor={atual.agent_mute_hours}
            min={1}
            max={720}
            sufixo="horas sem sinal"
          />
          <Numero
            nome="agent_metrics_retention_days"
            rotulo="Guardar métricas por"
            dica="O detalhe por minuto é apagado depois disso; o agregado por hora permanece. Diminuir aqui apaga histórico que não volta."
            valor={atual.agent_metrics_retention_days}
            min={1}
            max={90}
            sufixo="dias"
          />
        </div>
      </Card>

      <Card title="Anexos e financeiro">
        <div className="grid gap-5 sm:grid-cols-2">
          <Numero
            nome="attachment_quota_mb"
            rotulo="Cota de anexos"
            dica="Total por empresa, aplicado por trigger no momento do envio. Reduzir abaixo do já usado não apaga nada — impede o próximo envio."
            valor={atual.attachment_quota_mb}
            min={1}
            max={100000}
            sufixo="MB"
          />
          <Field
            label="Aprovação de título a pagar"
            htmlFor="payable_approval_required"
            hint="Com isto ligado, nenhum título é pago sem passar pelas regras de aprovação."
          >
            <label className="flex items-start gap-2.5 text-sm text-[var(--color-ink)]">
              <input
                id="payable_approval_required"
                name="payable_approval_required"
                type="checkbox"
                defaultChecked={atual.payable_approval_required}
                className="mt-0.5"
              />
              Exigir aprovação antes do pagamento
            </label>
          </Field>
        </div>
      </Card>

      <div>
        <SubmitButton>Salvar preferências</SubmitButton>
      </div>
    </form>
  )
}

function Linha({ termo, valor }: { termo: string; valor: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-[var(--color-border)] py-1">
      <dt className="text-[var(--color-ink-2)]">{termo}</dt>
      <dd className="font-medium tabular-nums text-[var(--color-ink)]">{valor}</dd>
    </div>
  )
}
