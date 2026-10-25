'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { Card, ErrorNote, inputClass } from '@/components/ui'
import { desvincularDoChamado, vincularAoChamado } from './vinculo-actions'

export interface AtivoVinculado {
  asset_id: string
  asset: {
    id: string
    asset_tag: string | null
    brand: string | null
    model: string | null
    asset_type: string
    status: string
  } | null
}

/**
 * Como um ativo se chama na tela.
 *
 * `it_assets` não tem coluna `name`: tem `asset_tag` (o patrimônio, nulável),
 * `brand` e `model`. "DELL Latitude 5420" identifica para quem atende; o
 * patrimônio identifica para quem faz inventário. Os dois aparecem.
 */
export function nomeDoAtivo(a: {
  asset_tag: string | null
  brand: string | null
  model: string | null
  asset_type: string
}): string {
  const marca = [a.brand, a.model].filter(Boolean).join(' ')
  return marca || a.asset_type
}

export interface LinhaVinculada {
  line_id: string
  line: { id: string; phone_number: string; carrier: string | null } | null
}

/**
 * O que este chamado tem a ver com o patrimônio.
 *
 * ## Por que vale uma seção própria no chamado
 *
 * "Quantos chamados esta máquina já deu?" é a pergunta que decide trocar um
 * equipamento em vez de consertá-lo pela quinta vez. Ela só tem resposta se
 * alguém marcar, durante o atendimento, de qual máquina o problema era — e o
 * único instante em que isso custa um clique é esse.
 *
 * As tabelas existiam desde a migração 0004 e nenhuma tela escrevia nelas.
 */
export function VinculosDoChamado({
  ticketId,
  ativos,
  linhas,
  ativosDisponiveis,
  linhasDisponiveis,
  podeVincular,
}: {
  ticketId: string
  ativos: AtivoVinculado[]
  linhas: LinhaVinculada[]
  ativosDisponiveis: {
    id: string
    asset_tag: string | null
    brand: string | null
    model: string | null
    asset_type: string
  }[]
  linhasDisponiveis: { id: string; phone_number: string }[]
  podeVincular: boolean
}) {
  const [vinculo, vincularAction] = useActionState(vincularAoChamado, {})
  const [remocao, desvincularAction] = useActionState(desvincularDoChamado, {})

  const vazio = ativos.length === 0 && linhas.length === 0

  return (
    <Card title="Equipamento e linha">
      {vazio && !podeVincular && (
        <p className="text-sm text-[var(--color-ink-3)]">Nada vinculado a este chamado.</p>
      )}

      {ativos.length > 0 && (
        <ul className="mb-3 flex flex-col gap-2">
          {ativos.map((a) => (
            <li key={a.asset_id} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-[var(--color-ink)]">
                {a.asset ? nomeDoAtivo(a.asset) : 'ativo removido'}
                {a.asset?.asset_tag && (
                  <span className="ml-1.5 font-mono text-xs text-[var(--color-ink-3)]">
                    {a.asset.asset_tag}
                  </span>
                )}
              </span>
              {podeVincular && (
                <form action={desvincularAction}>
                  <input type="hidden" name="ticket_id" value={ticketId} />
                  <input type="hidden" name="alvo_id" value={a.asset_id} />
                  <input type="hidden" name="tipo" value="ativo" />
                  <button
                    type="submit"
                    aria-label={`Desvincular ${a.asset ? nomeDoAtivo(a.asset) : 'o ativo'}`}
                    className="text-[var(--color-ink-3)] hover:text-[var(--color-breach-ink)]"
                  >
                    ×
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {linhas.length > 0 && (
        <ul className="mb-3 flex flex-col gap-2">
          {linhas.map((l) => (
            <li key={l.line_id} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-[var(--color-ink)]">
                {l.line?.phone_number ?? 'linha removida'}
                {l.line?.carrier && (
                  <span className="ml-1.5 text-xs text-[var(--color-ink-3)]">{l.line.carrier}</span>
                )}
              </span>
              {podeVincular && (
                <form action={desvincularAction}>
                  <input type="hidden" name="ticket_id" value={ticketId} />
                  <input type="hidden" name="alvo_id" value={l.line_id} />
                  <input type="hidden" name="tipo" value="linha" />
                  <button
                    type="submit"
                    aria-label={`Desvincular ${l.line?.phone_number ?? 'a linha'}`}
                    className="text-[var(--color-ink-3)] hover:text-[var(--color-breach-ink)]"
                  >
                    ×
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {podeVincular && (
        <>
          {ativosDisponiveis.length > 0 && (
            <form action={vincularAction} className="mb-2 flex items-end gap-2">
              <input type="hidden" name="ticket_id" value={ticketId} />
              <input type="hidden" name="tipo" value="ativo" />
              <label className="sr-only" htmlFor={`ativo-${ticketId}`}>
                Ativo a vincular
              </label>
              <select
                id={`ativo-${ticketId}`}
                name="alvo_id"
                defaultValue=""
                required
                className={inputClass}
              >
                <option value="" disabled>
                  Vincular um equipamento…
                </option>
                {ativosDisponiveis.map((a) => (
                  <option key={a.id} value={a.id}>
                    {nomeDoAtivo(a)}
                    {a.asset_tag ? ` (${a.asset_tag})` : ''}
                  </option>
                ))}
              </select>
              <SubmitButton pendingLabel="…" variant="secondary">
                Vincular
              </SubmitButton>
            </form>
          )}

          {linhasDisponiveis.length > 0 && (
            <form action={vincularAction} className="flex items-end gap-2">
              <input type="hidden" name="ticket_id" value={ticketId} />
              <input type="hidden" name="tipo" value="linha" />
              <label className="sr-only" htmlFor={`linha-${ticketId}`}>
                Linha a vincular
              </label>
              <select
                id={`linha-${ticketId}`}
                name="alvo_id"
                defaultValue=""
                required
                className={inputClass}
              >
                <option value="" disabled>
                  Vincular uma linha…
                </option>
                {linhasDisponiveis.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.phone_number}
                  </option>
                ))}
              </select>
              <SubmitButton pendingLabel="…" variant="secondary">
                Vincular
              </SubmitButton>
            </form>
          )}

          {/* A lista vem filtrada pelo cliente do chamado, e vazia é um estado
              legítimo: chamado de cliente sem equipamento cadastrado. Dizer isso
              evita que pareça defeito. */}
          {ativosDisponiveis.length === 0 && linhasDisponiveis.length === 0 && (
            <p className="text-sm text-[var(--color-ink-3)]">
              Nenhum equipamento ou linha cadastrada na filial deste chamado.
            </p>
          )}

          {vinculo.error && <ErrorNote>{vinculo.error}</ErrorNote>}
          {remocao.error && <ErrorNote>{remocao.error}</ErrorNote>}
        </>
      )}

      {!vazio && (
        <p className="mt-3 text-xs text-[var(--color-ink-3)]">
          O vínculo responde &ldquo;quantos chamados esta máquina já deu?&rdquo; — a pergunta que
          decide trocar um equipamento em vez de consertá-lo pela quinta vez.
        </p>
      )}
    </Card>
  )
}
