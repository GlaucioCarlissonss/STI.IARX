import { ActionForm, SubmitButton } from '@/components/action-form'
import { Badge, Card, Field, inputClass } from '@/components/ui'
import { formatDateTime } from '@/lib/format'
import { decidirPedido } from './aprovacao-actions'

export interface AprovacaoNaTela {
  status: 'pendente' | 'aprovado' | 'recusado'
  requested_at: string
  requested_by_name: string | null
  decided_at: string | null
  decided_by_name: string | null
  motivo: string | null
  servico: string
  perfil_exigido: string | null
}

/**
 * A trava que a tela de pedido prometia desde a 0033.
 *
 * O aviso existia — "este serviço precisa de aprovação antes de ser executado"
 * — e nada o aplicava: o chamado era criado e atendido como qualquer outro.
 * Promessa falsa na tela é pior que recurso ausente, porque ninguém descobre
 * por erro. Descobre pelo serviço executado.
 *
 * ## Por que o painel aparece mesmo depois de decidido
 *
 * Um pedido aprovado em março vira um chamado comum, e três meses depois
 * ninguém lembra que houve aprovação. A linha com quem decidiu e quando é o que
 * responde "por que isto foi feito?" sem precisar abrir a trilha de auditoria.
 */
export function PainelDeAprovacao({
  ticketId,
  aprovacao,
  podeDecidir,
}: {
  ticketId: string
  aprovacao: AprovacaoNaTela
  podeDecidir: boolean
}) {
  if (aprovacao.status !== 'pendente') {
    const aprovado = aprovacao.status === 'aprovado'
    return (
      <Card title="Aprovação do pedido">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={aprovado ? 'ok' : 'breach'}>{aprovado ? 'Aprovado' : 'Recusado'}</Badge>
          <span className="text-sm text-[var(--color-ink-2)]">
            por {aprovacao.decided_by_name ?? 'alguém que não está mais no cadastro'} em{' '}
            {formatDateTime(aprovacao.decided_at)}
          </span>
        </div>
        {aprovacao.motivo && (
          <p className="mt-3 text-sm text-[var(--color-ink-2)]">
            <strong>Motivo:</strong> {aprovacao.motivo}
          </p>
        )}
      </Card>
    )
  }

  return (
    <Card title="Aguardando aprovação">
      <p className="text-sm text-[var(--color-ink-2)]">
        <strong>{aprovacao.servico}</strong> precisa de aprovação antes de ser executado. Pedido
        por {aprovacao.requested_by_name ?? 'alguém'} em{' '}
        {formatDateTime(aprovacao.requested_at)}.
      </p>
      <p className="mt-2 text-xs text-[var(--color-ink-3)]">
        Enquanto isto, o relógio do SLA está <strong>parado</strong>: o acordo é sobre o tempo de
        atendimento, e o atendimento não começou. Cobrar da equipe o tempo da decisão seria cobrar
        o prazo de uma decisão que não é dela.
      </p>

      {!podeDecidir ? (
        <p className="mt-4 rounded-lg bg-[var(--color-surface-2)] p-3 text-sm text-[var(--color-ink-2)]">
          Quem decide é{' '}
          {aprovacao.perfil_exigido
            ? `quem tem o perfil "${aprovacao.perfil_exigido}"`
            : 'um gestor ou administrador'}
          . Você consegue acompanhar, não decidir.
        </p>
      ) : (
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <ActionForm action={decidirPedido}>
            <input type="hidden" name="ticket_id" value={ticketId} />
            <input type="hidden" name="aprovado" value="sim" />
            <p className="mb-3 text-sm text-[var(--color-ink-2)]">
              Aprovar devolve o chamado para a fila e recomeça o relógio.
            </p>
            <SubmitButton pendingLabel="Aprovando…">Aprovar o pedido</SubmitButton>
          </ActionForm>

          <ActionForm action={decidirPedido}>
            <input type="hidden" name="ticket_id" value={ticketId} />
            <input type="hidden" name="aprovado" value="nao" />
            <Field
              label="Motivo da recusa"
              htmlFor="motivo"
              hint="Obrigatório. Sem ele, o mesmo pedido volta na semana que vem e custa o tempo de todo mundo de novo."
              required
            >
              <textarea
                id="motivo"
                name="motivo"
                rows={3}
                required
                minLength={3}
                maxLength={2000}
                className={inputClass}
              />
            </Field>
            <div className="mt-3">
              <SubmitButton variant="danger" pendingLabel="Recusando…">
                Recusar o pedido
              </SubmitButton>
            </div>
          </ActionForm>
        </div>
      )}
    </Card>
  )
}
