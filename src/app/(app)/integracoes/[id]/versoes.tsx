import Link from 'next/link'
import type { Route } from 'next'
import { Card, EmptyState, Table, Td } from '@/components/ui'
import { formatDateTime } from '@/lib/format'

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
 *
 * ## Por que restaurar deixou de ser um botão na linha
 *
 * Porque a contagem diz *quantas* regras voltam, e não *quais*. Abrir a versão
 * na gaveta mostra as regras daquela versão, uma a uma, antes do botão que
 * troca o mapeamento inteiro por elas — e a troca é a operação mais destrutiva
 * desta tela.
 */
export function Versoes({
  versoes,
  podeRestaurar,
  endereco,
}: {
  versoes: VersaoNaTela[]
  podeRestaurar: boolean
  endereco: (mudancas: Record<string, string | null>) => Route
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
                  <Link
                    href={endereco({ versao: String(v.version), regra: null })}
                    data-testid="abrir-versao"
                    className="font-medium text-[var(--color-brand-ink)] hover:underline"
                  >
                    Ver e restaurar
                  </Link>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}
