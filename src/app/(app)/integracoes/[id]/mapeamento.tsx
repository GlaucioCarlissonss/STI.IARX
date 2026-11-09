import Link from 'next/link'
import type { Route } from 'next'
import { Card, EmptyState, Table, Td } from '@/components/ui'
import {
  ROTULO_DO_CAMPO,
  TRANSFORMACOES_DE_BUSCA,
  type CampoDeTicket,
} from '@/lib/integrations/regras'
import type { TransformKind } from '@/lib/integrations/mapping'

export interface RegraNaTela {
  id: string
  source_path: string
  target_field: string
  transform: string
  value_map: Record<string, string> | null
  default_value: string | null
  is_required: boolean
}

/**
 * A tabela do mapeamento de campos.
 *
 * Só leitura: o editor mora na gaveta, aberto por `?regra=<id>`. Antes ele
 * abria num `<details>` dentro da última célula desta tabela — nove campos na
 * largura de uma coluna chamada "Ações" —, e era o pior lugar da aplicação para
 * editar qualquer coisa.
 *
 * O que ficou aqui é o que se lê de relance: de onde vem, para onde vai, que
 * transformação se aplica e com que valores. Inclusive o aviso de busca não
 * resolvida, que é a única coluna desta tabela capaz de explicar um campo
 * teimosamente em branco.
 */
export function Mapeamento({
  regras,
  podeEditar,
  ehBitrix,
  endereco,
}: {
  regras: RegraNaTela[]
  podeEditar: boolean
  ehBitrix: boolean
  /** Monta o endereço desta mesma página com outros parâmetros. */
  endereco: (mudancas: Record<string, string | null>) => Route
}) {
  return (
    <Card
      title={`Mapeamento de campos (${regras.length})`}
      action={
        podeEditar && (
          <Link
            href={endereco({ regra: 'nova', versao: null })}
            data-testid="nova-regra"
            className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-sm font-medium text-[var(--color-brand-ink)] hover:bg-[var(--color-surface-2)]"
          >
            + Acrescentar regra
          </Link>
        )
      }
    >
      {regras.length === 0 ? (
        <EmptyState
          title="Nenhum mapeamento cadastrado"
          description="Sem nenhuma regra, todo evento recebido vira um chamado em branco — e não há erro para avisar."
        />
      ) : (
        <Table
          head={[
            'Campo de origem',
            'Campo do chamado',
            'Transformação',
            'Valores',
            podeEditar ? 'Ajustar' : 'Obrigatório',
          ]}
          label="Mapeamento de campos"
        >
          {regras.map((r) => (
            <tr key={r.id}>
              <Td className="font-mono text-xs">{r.source_path}</Td>
              <Td className="font-medium text-[var(--color-ink)]">
                {ROTULO_DO_CAMPO[r.target_field as CampoDeTicket] ?? r.target_field}
                {r.is_required && (
                  <span className="ml-1 text-[var(--color-breach-ink)]" title="Obrigatório">
                    *
                  </span>
                )}
              </Td>
              <Td className="text-[var(--color-ink-2)]">
                {r.transform}
                {TRANSFORMACOES_DE_BUSCA.includes(r.transform as TransformKind) &&
                  !ehBitrix &&
                  r.transform !== 'user_by_email' && (
                    /* O webhook genérico só resolve busca por e-mail. As outras
                       duas não dão erro: o campo fica em branco, para sempre. */
                    <span
                      className="ml-1.5 rounded bg-[var(--color-warn-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-warn-ink)]"
                      title="O webhook genérico não resolve esta busca — o campo fica em branco."
                    >
                      não resolvida
                    </span>
                  )}
              </Td>
              <Td className="font-mono text-xs text-[var(--color-ink-3)]">
                {Object.keys(r.value_map ?? {}).length > 0
                  ? Object.entries(r.value_map ?? {})
                      .map(([k, v]) => `${k}→${v}`)
                      .join(', ')
                  : (r.default_value ?? '—')}
              </Td>
              <Td>
                {podeEditar ? (
                  <Link
                    href={endereco({ regra: r.id, versao: null })}
                    data-testid="abrir-regra"
                    className="font-medium text-[var(--color-brand-ink)] hover:underline"
                  >
                    Editar
                  </Link>
                ) : (
                  <span className="text-[var(--color-ink-3)]">{r.is_required ? 'sim' : 'não'}</span>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {podeEditar && regras.length > 0 && (
        <p className="mt-3 text-xs text-[var(--color-ink-3)]">
          Toda alteração grava uma versão do mapeamento inteiro — dá para voltar a qualquer uma
          delas no histórico, logo abaixo.
        </p>
      )}
    </Card>
  )
}
