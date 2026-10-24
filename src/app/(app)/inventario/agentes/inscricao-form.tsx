'use client'

import { useActionState, useState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { Card, ErrorNote, Field, inputClass, Table, Td } from '@/components/ui'
import { formatDate } from '@/lib/format'
import {
  emitirTokenDeInscricao,
  revogarTokenDeInscricao,
  type InscricaoActionState,
} from './actions'

interface TokenDeInscricao {
  id: string
  name: string
  max_uses: number | null
  uses_count: number
  expires_at: string | null
  branch: { name: string } | null
}

/**
 * Emissão e revogação dos tokens de inscrição.
 *
 * ## Por que o token aparece dentro de uma linha de comando pronta
 *
 * Porque é assim que ele vai ser usado. Mostrar só a string obrigaria quem
 * instala a montar o comando à mão — na primeira máquina ele monta certo, na
 * trigésima erra uma aspa e passa vinte minutos descobrindo por quê. O comando
 * pronto é a diferença entre "instalei em 200 máquinas pela GPO" e "o cliente
 * desistiu".
 */
export function InscricaoForm({
  tokens,
  branches = [],
  className = '',
}: {
  tokens: TokenDeInscricao[]
  branches?: { id: string; name: string }[]
  className?: string
}) {
  const [state, formAction] = useActionState<InscricaoActionState, FormData>(
    emitirTokenDeInscricao,
    {},
  )
  const [revogar, revogarAction] = useActionState(revogarTokenDeInscricao, {})
  const [copiado, setCopiado] = useState<'comando' | 'token' | null>(null)

  const origem = typeof window !== 'undefined' ? window.location.origin : ''
  const comando = state.plainToken
    ? `msiexec /i sti-agente.msi /qn SERVIDOR="${origem}" TOKEN="${state.plainToken}"`
    : null

  return (
    <Card title="Instalar o agente em novas máquinas" className={className}>
      <p className="mb-4 text-sm text-[var(--color-ink-2)]">
        O token abaixo serve para a máquina <strong>trocar de credencial</strong>: ela o entrega uma
        vez e recebe um token só dela. Depois disso, revogar um computador não afeta nenhum outro.
      </p>

      <form action={formAction} className="flex flex-col gap-4">
        <Field label="Nome do lote" htmlFor="name" required>
          <input
            id="name"
            name="name"
            required
            minLength={3}
            className={inputClass}
            placeholder="Notebooks da filial de Londrina"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Filial das máquinas" htmlFor="branch_id">
            <select id="branch_id" name="branch_id" defaultValue="" className={inputClass}>
              <option value="">A classificar depois</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Máximas máquinas" htmlFor="max_uses">
            <input
              id="max_uses"
              name="max_uses"
              type="number"
              min={1}
              max={10000}
              className={inputClass}
              placeholder="sem limite"
            />
          </Field>

          <Field label="Vence em (dias)" htmlFor="dias" required>
            <input
              id="dias"
              name="dias"
              type="number"
              min={1}
              max={365}
              defaultValue={30}
              required
              className={inputClass}
            />
          </Field>
        </div>

        <p className="text-xs text-[var(--color-ink-3)]">
          A filial escolhida é herdada por toda máquina inscrita com este token — é o que evita
          classificar 30 computadores um a um depois.
        </p>

        {state.error && <ErrorNote>{state.error}</ErrorNote>}

        <SubmitButton pendingLabel="Emitindo…">Emitir token de inscrição</SubmitButton>
      </form>

      {state.plainToken && comando && (
        <div
          role="status"
          className="mt-4 rounded-lg border border-[var(--color-ok-ink)]/30 bg-[var(--color-ok-soft)] p-3.5"
        >
          <p className="text-sm font-semibold text-[var(--color-ok-ink)]">
            Token emitido — copie agora
          </p>
          <p className="mt-1 text-xs text-[var(--color-ok-ink)]">
            Ele não aparece de novo: o sistema guarda só o resumo criptográfico. Se perder, emita
            outro e revogue este.
          </p>

          <p className="mt-3 text-xs font-semibold text-[var(--color-ok-ink)]">
            Instalação silenciosa no Windows (serve na GPO):
          </p>
          <code className="mt-1 block overflow-x-auto whitespace-nowrap rounded bg-[var(--color-surface)] p-2 font-mono text-xs">
            {comando}
          </code>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(comando)
                setCopiado('comando')
              }}
              className="rounded-lg border border-[var(--color-ok-ink)]/40 px-3 py-1.5 text-xs font-semibold text-[var(--color-ok-ink)]"
            >
              {copiado === 'comando' ? 'Copiado!' : 'Copiar comando'}
            </button>
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(state.plainToken!)
                setCopiado('token')
              }}
              className="rounded-lg border border-[var(--color-ok-ink)]/40 px-3 py-1.5 text-xs font-semibold text-[var(--color-ok-ink)]"
            >
              {copiado === 'token' ? 'Copiado!' : 'Copiar só o token'}
            </button>
          </div>
        </div>
      )}

      {tokens.length > 0 && (
        <div className="mt-6">
          <Table label="Tokens de inscrição ativos" head={['Lote', 'Filial', 'Uso', 'Vence', '']}>
            {tokens.map((t) => (
              <tr key={t.id}>
                <Td>{t.name}</Td>
                <Td className="text-[var(--color-ink-2)]">{t.branch?.name ?? '—'}</Td>
                <Td className="text-[var(--color-ink-2)]">
                  {t.uses_count}
                  {t.max_uses === null ? ' (sem limite)' : ` de ${t.max_uses}`}
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {t.expires_at ? formatDate(t.expires_at) : 'não vence'}
                </Td>
                <Td>
                  <form action={revogarAction}>
                    <input type="hidden" name="enrollment_id" value={t.id} />
                    <SubmitButton pendingLabel="Revogando…" variant="danger">
                      Revogar
                    </SubmitButton>
                  </form>
                </Td>
              </tr>
            ))}
          </Table>
          {revogar.error && <ErrorNote>{revogar.error}</ErrorNote>}
          {revogar.success && (
            <p role="status" className="mt-2 text-sm text-[var(--color-ok-ink)]">
              {revogar.success}
            </p>
          )}
          <p className="mt-2 text-xs text-[var(--color-ink-3)]">
            Revogar um token impede <strong>novas</strong> inscrições. As máquinas já instaladas
            continuam reportando — cada uma tem o token dela.
          </p>
        </div>
      )}
    </Card>
  )
}
