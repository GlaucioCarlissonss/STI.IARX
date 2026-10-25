'use client'

import { useActionState, useState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { Badge, Card, ErrorNote } from '@/components/ui'
import { formatDateTime } from '@/lib/format'
import { centavosEmDolar, faixaDeConfianca } from '@/lib/ia/regras'
import type { TipoDeSugestao } from '@/lib/ia/tipos'
import { ROTULO_DA_SUGESTAO } from '@/lib/ia/tipos'
import { decidirSugestao, pedirSugestao, type SugestaoActionState } from './ia-actions'

export interface SugestaoNaTela {
  id: string
  kind: string
  payload: Record<string, unknown>
  status: string
  model: string | null
  custo_centavos: number
  created_at: string
  acted_at: string | null
  requested_by_name: string | null
  acted_by_name: string | null
}

/**
 * O painel de sugestões.
 *
 * ## Por que o botão diz "pedir" e não "gerar"
 *
 * Porque cada clique custa dinheiro de verdade, e a tela não deve esconder isso.
 * Depois da primeira sugestão, o rodapé mostra o que ela custou — não para
 * constranger ninguém, mas porque o teto mensal é real e some sem aviso se o
 * consumo for invisível.
 *
 * ## Nada daqui vai sozinho para lugar nenhum
 *
 * A resposta sugerida tem botão de **copiar**, não de enviar: ela vai para a
 * caixa de comentário, onde a pessoa corrige e envia com o nome dela. A triagem
 * tem botão de aceitar, e aceitar faz um `update` com as permissões de quem
 * clicou — o histórico do chamado registra a pessoa, não a IA.
 */
export function PainelDeIA({
  ticketId,
  sugestoes,
  podeUsar,
  disponivel,
  recursos,
  resolvido,
}: {
  ticketId: string
  sugestoes: SugestaoNaTela[]
  /** `false` = só leitura: vê as sugestões e quem decidiu, não pede nem decide. */
  podeUsar: boolean
  /** Quando a IA não pode ser usada, a frase que explica por quê. */
  disponivel: { pode: true } | { pode: false; motivo: string }
  recursos: { resposta: boolean; triagem: boolean; artigo: boolean }
  resolvido: boolean
}) {
  const [pedido, pedirAction] = useActionState<SugestaoActionState, FormData>(pedirSugestao, {})
  const [decisao, decidirAction] = useActionState(decidirSugestao, {})
  const [copiado, setCopiado] = useState<string | null>(null)

  const pendentes = sugestoes.filter((s) => s.status === 'pendente')
  const decididas = sugestoes.filter((s) => s.status !== 'pendente')

  /* O artigo só faz sentido com o chamado resolvido — mesma regra do botão
     "Virar artigo" (0033): artigo escrito no meio do atendimento descreve uma
     hipótese, não uma solução. */
  const botoes: { tipo: TipoDeSugestao; rotulo: string; habilitado: boolean }[] = [
    { tipo: 'resposta', rotulo: 'Sugerir resposta', habilitado: recursos.resposta },
    { tipo: 'triagem', rotulo: 'Sugerir classificação', habilitado: recursos.triagem },
    { tipo: 'artigo', rotulo: 'Rascunhar artigo', habilitado: recursos.artigo && resolvido },
  ]

  return (
    <Card title="Sugestões de IA" className="mb-6">
      {!podeUsar ? (
        /* Leitura: o registro de quem pediu e quem aceitou é o que esta pessoa
           veio ver. Mostrar botões que a ação recusaria seria pior que não
           mostrá-los. */
        <p className="text-sm text-[var(--color-ink-2)]">
          Você acompanha as sugestões deste chamado. Pedir e decidir é de quem atende.
        </p>
      ) : !disponivel.pode ? (
        <p className="text-sm text-[var(--color-ink-2)]">{disponivel.motivo}</p>
      ) : (
        <>
          <p className="mb-3 text-sm text-[var(--color-ink-2)]">
            Cada pedido envia o texto deste chamado ao provedor e <strong>custa dinheiro</strong>.
            Nada é aplicado sozinho: você lê, corrige e decide.
          </p>

          <div className="flex flex-wrap gap-2">
            {botoes
              .filter((b) => b.habilitado)
              .map((b) => (
                <form key={b.tipo} action={pedirAction}>
                  <input type="hidden" name="ticket_id" value={ticketId} />
                  <input type="hidden" name="tipo" value={b.tipo} />
                  <SubmitButton pendingLabel="Pensando…" variant="secondary">
                    {b.rotulo}
                  </SubmitButton>
                </form>
              ))}
          </div>

          {recursos.artigo && !resolvido && (
            <p className="mt-2 text-xs text-[var(--color-ink-3)]">
              O rascunho de artigo aparece quando o chamado estiver resolvido.
            </p>
          )}

          {pedido.error && <ErrorNote>{pedido.error}</ErrorNote>}
          {pedido.indisponivel && (
            <p role="status" className="mt-2 text-sm text-[var(--color-warn-ink)]">
              {pedido.indisponivel}
            </p>
          )}
          {pedido.success && (
            <p role="status" className="mt-2 text-sm text-[var(--color-ok-ink)]">
              {pedido.success}
            </p>
          )}
        </>
      )}

      {pendentes.length > 0 && (
        <div className="mt-5 flex flex-col gap-4">
          {pendentes.map((s) => (
            <Sugestao
              key={s.id}
              sugestao={s}
              ticketId={ticketId}
              podeUsar={podeUsar}
              decidirAction={decidirAction}
              copiado={copiado === s.id}
              aoCopiar={() => setCopiado(s.id)}
            />
          ))}
        </div>
      )}

      {decisao.error && <ErrorNote>{decisao.error}</ErrorNote>}
      {decisao.success && (
        <p role="status" className="mt-2 text-sm text-[var(--color-ok-ink)]">
          {decisao.success}
        </p>
      )}

      {decididas.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-[var(--color-ink-2)]">
            {decididas.length} sugestão(ões) já decidida(s)
          </summary>
          {/* O registro das recusas fica, e é ele que responde "esta IA ajuda?".
              Apagar a recusa deixaria só o que deu certo. */}
          <ul className="mt-2 flex flex-col gap-1.5">
            {decididas.map((s) => (
              <li key={s.id} className="text-xs text-[var(--color-ink-3)]">
                {ROTULO_DA_SUGESTAO[s.kind as TipoDeSugestao] ?? s.kind} ·{' '}
                {s.status === 'aceita' ? 'aceita' : 'recusada'} por {s.acted_by_name ?? 'alguém'}
                {s.acted_at && ` em ${formatDateTime(s.acted_at)}`} ·{' '}
                {centavosEmDolar(s.custo_centavos)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  )
}

function Sugestao({
  sugestao,
  ticketId,
  podeUsar,
  decidirAction,
  copiado,
  aoCopiar,
}: {
  sugestao: SugestaoNaTela
  ticketId: string
  podeUsar: boolean
  decidirAction: (formData: FormData) => void
  copiado: boolean
  aoCopiar: () => void
}) {
  const p = sugestao.payload
  const confianca = typeof p.confianca === 'number' ? faixaDeConfianca(p.confianca) : null
  const texto = textoParaCopiar(sugestao)

  return (
    <div className="rounded-lg border border-[var(--color-brand)]/30 bg-[var(--color-brand-soft)] p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-[var(--color-ink)]">
          {ROTULO_DA_SUGESTAO[sugestao.kind as TipoDeSugestao] ?? sugestao.kind}
        </span>
        {confianca && <Badge tone={confianca.tom}>{confianca.rotulo}</Badge>}
      </div>

      {/* O aviso que vem ANTES do texto: quando o chamado precisa de uma pessoa,
          isso vale mais que o rascunho educado abaixo. */}
      {p.precisa_de_pessoa === true && (
        <p className="mb-2 rounded border border-[var(--color-warn-ink)]/30 bg-[var(--color-warn-soft)] p-2 text-sm text-[var(--color-warn-ink)]">
          <strong>Isto não se resolve por resposta:</strong>{' '}
          {typeof p.motivo === 'string' && p.motivo ? p.motivo : 'precisa de alguém.'}
        </p>
      )}

      {sugestao.kind === 'triagem' ? (
        <div className="text-sm text-[var(--color-ink)]">
          <p>
            Categoria:{' '}
            <strong>{(p.category_name as string) ?? 'manter a atual'}</strong> · Prioridade:{' '}
            <strong>{(p.priority_name as string) ?? 'manter a atual'}</strong>
          </p>
          {typeof p.justificativa === 'string' && (
            <p className="mt-1.5 text-[var(--color-ink-2)]">{p.justificativa}</p>
          )}
        </div>
      ) : (
        <>
          {sugestao.kind === 'artigo' && typeof p.title === 'string' && (
            <p className="mb-1 text-sm font-semibold text-[var(--color-ink)]">{p.title}</p>
          )}
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-ink)]">
            {texto}
          </p>
        </>
      )}

      {Array.isArray(p.artigos_citados) && p.artigos_citados.length > 0 && (
        <p className="mt-2 text-xs text-[var(--color-ink-3)]">
          Baseada em: {(p.artigos_citados as string[]).join(' · ')}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!podeUsar ? null : sugestao.kind === 'triagem' ? (
          <form action={decidirAction}>
            <input type="hidden" name="suggestion_id" value={sugestao.id} />
            <input type="hidden" name="ticket_id" value={ticketId} />
            <input type="hidden" name="decisao" value="aceita" />
            <SubmitButton pendingLabel="Aplicando…">Aplicar classificação</SubmitButton>
          </form>
        ) : (
          /* Copiar, e não enviar. O texto vai para a caixa de comentário, onde a
             pessoa corrige e assina — a responsabilidade pelo que o cliente leu é
             de quem apertou enviar. */
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(texto)
              aoCopiar()
            }}
            className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
          >
            {copiado ? 'Copiado!' : 'Copiar para o comentário'}
          </button>
        )}

        {podeUsar && (
          <form action={decidirAction}>
            <input type="hidden" name="suggestion_id" value={sugestao.id} />
            <input type="hidden" name="ticket_id" value={ticketId} />
            <input type="hidden" name="decisao" value="recusada" />
            <SubmitButton pendingLabel="Recusando…" variant="secondary">
              Não serviu
            </SubmitButton>
          </form>
        )}

        {podeUsar && sugestao.kind !== 'triagem' && (
          <form action={decidirAction}>
            <input type="hidden" name="suggestion_id" value={sugestao.id} />
            <input type="hidden" name="ticket_id" value={ticketId} />
            <input type="hidden" name="decisao" value="aceita" />
            <SubmitButton pendingLabel="Marcando…" variant="secondary">
              Usei esta
            </SubmitButton>
          </form>
        )}
      </div>

      <p className="mt-2 text-xs text-[var(--color-ink-3)]">
        {sugestao.model ?? 'modelo desconhecido'} · {centavosEmDolar(sugestao.custo_centavos)} ·
        pedida por {sugestao.requested_by_name ?? 'alguém'} em{' '}
        {formatDateTime(sugestao.created_at)}
      </p>
    </div>
  )
}

/** O que o botão de copiar entrega, por tipo. */
function textoParaCopiar(s: SugestaoNaTela): string {
  const p = s.payload
  if (s.kind === 'artigo') {
    const titulo = typeof p.title === 'string' ? p.title : ''
    const corpo = typeof p.body === 'string' ? p.body : ''
    return titulo ? `${titulo}\n\n${corpo}` : corpo
  }
  return typeof p.texto === 'string' ? p.texto : ''
}
