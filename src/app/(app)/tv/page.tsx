import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen } from '@/lib/session'
import { getBranches } from '@/lib/data/lookups'
import { formatDateTime } from '@/lib/format'
import { Badge, Card, EmptyState, PageHeader, Table, Td } from '@/components/ui'
import { NewTokenForm } from './new-token-form'
import { RevokeTokenButton } from './revoke-token-button'

export const metadata: Metadata = { title: 'Painéis de TV' }

interface TokenRow {
  id: string
  name: string
  branch_ids: string[]
  expires_at: string | null
  revoked_at: string | null
  last_used_at: string | null
  created_at: string
  layout: { name: string } | null
}

export default async function TvAdminPage() {
  await requireScreen('tv.tokens.ver')
  const supabase = await createClient()

  const [{ data: tokens }, { data: layouts }, branches] = await Promise.all([
    supabase
      .from('dashboard_tokens')
      .select('id, name, branch_ids, expires_at, revoked_at, last_used_at, created_at, layout:dashboard_layouts(name)')
      .order('created_at', { ascending: false })
      .returns<TokenRow[]>(),
    supabase.from('dashboard_layouts').select('id, name').order('name'),
    getBranches(),
  ])

  const branchName = new Map(branches.map((b) => [b.id, b.name]))

  return (
    <>
      <PageHeader
        title="Painéis de TV"
        description="Cada painel é acessado por um token de exibição — sem login, somente leitura e revogável a qualquer momento."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div>
          {tokens && tokens.length > 0 ? (
            <Table head={['Painel', 'Layout', 'Escopo', 'Último uso', 'Situação', '']} label="Painéis de TV emitidos">
              {tokens.map((t) => {
                const revoked = Boolean(t.revoked_at)
                const expired = Boolean(t.expires_at && new Date(t.expires_at) < new Date())
                return (
                  <tr key={t.id}>
                    <Td>
                      <span className="font-medium text-[var(--color-ink)]">{t.name}</span>
                      <p className="text-xs text-[var(--color-ink-3)]">
                        criado {formatDateTime(t.created_at)}
                      </p>
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">{t.layout?.name ?? 'Padrão'}</Td>
                    <Td className="text-[var(--color-ink-2)]">
                      {t.branch_ids.length === 0
                        ? 'Todas as filiais'
                        : t.branch_ids.map((id) => branchName.get(id) ?? id).join(', ')}
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">
                      {t.last_used_at ? formatDateTime(t.last_used_at) : 'nunca'}
                    </Td>
                    <Td>
                      {revoked ? (
                        <Badge tone="breach">Revogado</Badge>
                      ) : expired ? (
                        <Badge tone="warn">Expirado</Badge>
                      ) : (
                        <Badge tone="ok">Ativo</Badge>
                      )}
                    </Td>
                    <Td>{!revoked && <RevokeTokenButton tokenId={t.id} />}</Td>
                  </tr>
                )
              })}
            </Table>
          ) : (
            /* Era um `Card` com um parágrafo — a mesma informação, numa forma
               que não se parecia com o vazio de nenhuma outra tela. Estado
               vazio é um componente justamente para ser reconhecido de longe. */
            <EmptyState
              title="Nenhum painel de TV emitido"
              description="Cada painel é um endereço com token próprio, que você abre na TV e pode revogar a qualquer momento. Emita o primeiro no formulário ao lado."
            />
          )}
        </div>

        <Card title="Emitir novo painel">
          <NewTokenForm layouts={layouts ?? []} branches={branches} />
        </Card>
      </div>
    </>
  )
}
