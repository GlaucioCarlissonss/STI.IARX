'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { Card } from '@/components/ui'
import {
  ESFERAS,
  RESUMO_DA_ESFERA,
  ROTULO_DA_ESFERA,
  TELAS_DA_ESFERA,
  type Esfera,
} from '@/lib/esferas'
import { salvarEsferas } from './actions'

/**
 * As esferas de negócio da empresa.
 *
 * ## Por que cada caixa mostra o que ela liga
 *
 * Porque o efeito é grande e invisível no instante do clique: marcar "Locação e
 * serviços" não muda nada nesta tela — muda o menu inteiro na próxima. Listar
 * as telas que entram é o que transforma um interruptor sem rótulo numa escolha
 * informada, e é a mesma razão pela qual os outros campos desta página dizem o
 * que acontece quando são mexidos.
 *
 * ## Caixa de seleção, e não um par de botões de rádio
 *
 * Porque as duas podem valer ao mesmo tempo — foi o pedido: um administrador
 * tem as duas esferas dentro do mesmo sistema. Rádio diria o contrário com a
 * forma, antes de qualquer texto.
 */
export function EsferasForm({
  atuais,
  podeEditar,
}: {
  atuais: readonly Esfera[]
  podeEditar: boolean
}) {
  return (
    <Card title="Esferas desta empresa" className="mb-6">
      <p className="mb-4 text-sm text-[var(--color-ink-2)]">
        A esfera decide <strong>quais telas existem</strong> nesta empresa — não quem pode abri-las,
        que é o que a matriz de perfis governa. Desligar uma esfera esconde as telas e as chaves de
        permissão dela; <strong>nada é apagado</strong>, e religar devolve tudo como estava.
      </p>

      <ActionForm action={salvarEsferas} manterCampos className="flex flex-col gap-4">
        <div className="grid gap-3 lg:grid-cols-2">
          {ESFERAS.map((e) => (
            <label
              key={e}
              className="flex cursor-pointer gap-3 rounded-xl border border-[var(--color-border)] p-3.5 transition-colors hover:bg-[var(--color-surface-2)] has-[:checked]:border-[var(--color-brand)] has-[:checked]:bg-[var(--color-brand-soft)]"
            >
              <input
                type="checkbox"
                name="esferas"
                value={e}
                defaultChecked={atuais.includes(e)}
                disabled={!podeEditar}
                className="mt-0.5 size-4 shrink-0"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-[var(--color-ink)]">
                  {ROTULO_DA_ESFERA[e]}
                </span>
                <span className="mt-1 block text-xs text-[var(--color-ink-2)]">
                  {RESUMO_DA_ESFERA[e]}
                </span>
                <span className="mt-2 block text-xs text-[var(--color-ink-3)]">
                  <strong className="font-semibold text-[var(--color-ink-2)]">Liga:</strong>{' '}
                  {TELAS_DA_ESFERA[e]}
                </span>
              </span>
            </label>
          ))}
        </div>

        <p className="rounded-lg bg-[var(--color-warn-soft)] px-3.5 py-2.5 text-xs text-[var(--color-warn-ink)]">
          O sistema recusa desligar as duas: empresa sem esfera nenhuma não teria tela nenhuma —
          nem esta, que é onde se desfaria o engano.
        </p>

        {podeEditar && <SubmitButton>Salvar esferas</SubmitButton>}
      </ActionForm>
    </Card>
  )
}
