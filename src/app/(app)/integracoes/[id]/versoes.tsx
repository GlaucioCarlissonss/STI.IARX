import { ActionForm, SubmitButton } from '@/components/action-form'
import { EditPanel } from '@/components/edit-panel'
import { Card, EmptyState, Table, Td } from '@/components/ui'
import { formatDateTime } from '@/lib/format'
import { restaurarMapeamento } from './mapeamento-actions'

export interface VersaoNaTela {
  id: string
  version: number
  note: string | null
  created_at: string
  created_by_name: string | null
  regras: number
}

const ROTULO_DA_NOTA: Record<string, string> = {
  insert: 'regra acrescentada',
  update: 'regra alterada',
  delete: 'regra removida',
}

/**
 * O histórico do mapeamento, que existia e ninguém lia.
 *
 * A trigger grava desde a 0013 — inclusive quando alguém edita por SQL direto,
 * que é o caso em que o histórico mais importa. O que faltava era isto: uma
 * lista, e um caminho de volta.
 *
 * ## Por que a contagem de regras aparece em cada linha
 *
 * É o que deixa visível, de relance, a versão que não se quer restaurar: a que
 * tem três regras onde as outras têm doze. Antes da 0042, o histórico era cheio
 * delas — a trigger gravava uma versão por LINHA alterada, então uma edição de
 * cinco regras deixava dez versões, e nove eram estados intermediários que o
 * mapeamento nunca teve como conjunto.
 */
export function Versoes({
  integrationId,
  versoes,
  podeRestaurar,
}: {
  integrationId: string
  versoes: VersaoNaTela[]
  podeRestaurar: boolean
}) {
  return (
    <Card title={`Histórico do mapeamento (${versoes.length})`}>
      {versoes.length === 0 ? (
        <EmptyState
          title="Nenhuma versão gravada"
          description="A primeira versão aparece assim que o mapeamento for alterado."
        />
      ) : (
        <Table
          head={['Versão', 'Quando', 'Quem', 'O que foi', 'Regras', podeRestaurar ? 'Voltar' : '']}
          label="Versões do mapeamento"
        >
          {versoes.map((v, i) => (
            <tr key={v.id}>
              <Td className="font-medium tabular-nums">
                #{v.version}
                {i === 0 && (
                  <span className="ml-1.5 text-xs font-normal text-[var(--color-ink-3)]">
                    (atual)
                  </span>
                )}
              </Td>
              <Td className="tabular-nums text-xs text-[var(--color-ink-2)]">
                {formatDateTime(v.created_at)}
              </Td>
              <Td className="text-[var(--color-ink-2)]">
                {/* Sem autor = alteração por SQL direto. É informação, não falha:
                    diz que a mudança não passou pela tela. */}
                {v.created_by_name ?? (
                  <span className="text-[var(--color-ink-3)]">por SQL direto</span>
                )}
              </Td>
              <Td className="text-[var(--color-ink-2)]">
                {v.note ? (ROTULO_DA_NOTA[v.note] ?? v.note) : '—'}
              </Td>
              <Td className="tabular-nums">{v.regras}</Td>
              <Td>
                {podeRestaurar && i > 0 && (
                  <EditPanel label="Voltar a esta" title={`Restaurar a versão #${v.version}`}>
                    <p className="mb-3 text-sm text-[var(--color-ink-2)]">
                      O mapeamento atual é <strong>trocado inteiro</strong> pelo desta versão, em
                      uma transação — não há instante com o mapeamento vazio. A troca também vira
                      uma versão nova, então dá para voltar atrás da volta.
                    </p>
                    <ActionForm action={restaurarMapeamento}>
                      <input type="hidden" name="integration_id" value={integrationId} />
                      <input type="hidden" name="version" value={v.version} />
                      <SubmitButton variant="danger" pendingLabel="Restaurando…">
                        Restaurar a versão #{v.version} ({v.regras} regra(s))
                      </SubmitButton>
                    </ActionForm>
                  </EditPanel>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}
