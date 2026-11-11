import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { lerEsferas } from '@/lib/esferas'
import { comParametros } from '@/lib/data/endereco'
import { formatDate } from '@/lib/format'
import { Badge, EmptyState, FaixaDeIndicadores, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { recursoPorChave, recursosNaEsfera } from '@/lib/planilha/recursos'
import { EnviarPlanilhaForm } from './forms'
import { GavetaDeImportacao } from './gaveta'

export const metadata: Metadata = { title: 'Planilhas' }

export default async function PlanilhasPage({
  searchParams,
}: {
  searchParams: Promise<{ aberto?: string }>
}) {
  const params = await searchParams
  const ctx = await requireScreen('sistema.planilhas.ver')
  const podeImportar = await allowed('sistema.planilhas.importar')

  const esferas = lerEsferas(ctx.tenant?.spheres)
  const recursos = recursosNaEsfera(esferas)

  const supabase = await createClient()
  const { data: lotes } = await supabase
    .from('import_batches')
    .select(
      'id, resource, file_name, status, total_rows, created_rows, updated_rows, skipped_rows, rejected_rows, created_at, applied_at, created_by',
    )
    .order('created_at', { ascending: false })
    .limit(50)
    .returns<
      {
        id: string
        resource: string
        file_name: string
        status: 'preview' | 'applied' | 'discarded'
        total_rows: number
        created_rows: number
        updated_rows: number
        skipped_rows: number
        rejected_rows: number
        created_at: string
        applied_at: string | null
        created_by: string | null
      }[]
    >()

  const lista = lotes ?? []
  const autores = [...new Set(lista.map((l) => l.created_by).filter(Boolean))] as string[]
  const { data: pessoas } = autores.length
    ? await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', autores)
        .returns<{ id: string; full_name: string }[]>()
    : { data: [] }
  const nome = new Map((pessoas ?? []).map((p) => [p.id, p.full_name]))

  const previas = lista.filter((l) => l.status === 'preview')
  const aplicadas = lista.filter((l) => l.status === 'applied')
  const entraram = aplicadas.reduce((s, l) => s + l.created_rows + l.updated_rows, 0)
  const recusadas = aplicadas.reduce((s, l) => s + l.rejected_rows, 0)

  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/sistema/planilhas', params, mudancas)
  const gavetaAberta = Boolean(params.aberto)

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && (
        <GavetaDeImportacao id={params.aberto} fechar={endereco({ aberto: null })} />
      )}

      <PageHeader
        title="Planilhas"
        description="Importar e exportar. Na importação, nada é gravado antes da conferência — e cada recusa diz em qual linha e por quê."
      />

      <FaixaDeIndicadores>
        <StatTile
          label="Prévias abertas"
          value={previas.length}
          hint="conferidas, ainda não aplicadas"
          tone={previas.length > 0 ? 'warn' : 'neutral'}
        />
        <StatTile label="Importações aplicadas" value={aplicadas.length} hint="nos últimos 50 envios" />
        <StatTile label="Linhas que entraram" value={entraram} hint="criadas ou atualizadas" tone="ok" />
        <StatTile
          label="Linhas recusadas"
          value={recusadas}
          hint="com motivo guardado"
          tone={recusadas > 0 ? 'crit' : 'ok'}
        />
      </FaixaDeIndicadores>

      {podeImportar && (
        <section className="mb-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)]">
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-ink)]">Importar</h2>
          <EnviarPlanilhaForm recursos={recursos} />
        </section>
      )}

      <section className="mb-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)]">
        <h2 className="mb-1 text-sm font-semibold text-[var(--color-ink)]">Modelos de planilha</h2>
        <p className="mb-3 text-xs text-[var(--color-ink-3)]">
          “Qual é o formato?” é a primeira pergunta de quem vai importar, e a resposta honesta é um
          arquivo — não um parágrafo de ajuda. Cada modelo traz o cabeçalho na ordem certa.
        </p>
        <div className="flex flex-wrap gap-2">
          {recursos.map((r) => (
            <a
              key={r.chave}
              href={`/api/planilha/modelo/${r.chave}`}
              download
              data-testid="baixar-modelo"
              className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-brand-ink)] hover:bg-[var(--color-surface-2)]"
            >
              {r.rotulo}
            </a>
          ))}
        </div>
      </section>

      {lista.length === 0 ? (
        <EmptyState
          title="Nenhuma importação ainda"
          description="Baixe o modelo do que você quer importar, preencha e envie. A conferência mostra o que vai acontecer antes de gravar."
        />
      ) : (
        <Table
          label="Importações"
          head={['Quando', 'Recurso', 'Arquivo', 'Entraram', 'Recusadas', 'Quem', 'Situação']}
        >
          {lista.map((l) => {
            const recurso = recursoPorChave(l.resource)
            const entrou = l.created_rows + l.updated_rows
            return (
              <tr key={l.id}>
                <Td className="tabular-nums text-[var(--color-ink-2)]">
                  <Link
                    href={endereco({ aberto: l.id }) as Route}
                    data-testid="abrir-registro"
                    className="font-medium text-[var(--color-brand-ink)] hover:underline"
                  >
                    {formatDate(l.created_at)}
                  </Link>
                </Td>
                <Td className="font-medium text-[var(--color-ink)]">
                  {recurso?.rotulo ?? l.resource}
                </Td>
                <Td className="font-mono text-xs text-[var(--color-ink-2)]">{l.file_name}</Td>
                <Td className="tabular-nums font-medium text-[var(--color-ok-ink)]">
                  {l.status === 'applied' ? entrou : '—'}
                </Td>
                <Td
                  className={`tabular-nums font-medium ${
                    l.rejected_rows > 0 ? 'text-[var(--color-breach-ink)]' : ''
                  }`}
                >
                  {l.rejected_rows}
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {l.created_by ? (nome.get(l.created_by) ?? '—') : '—'}
                </Td>
                <Td>
                  <Badge
                    tone={
                      l.status === 'applied' ? 'ok' : l.status === 'preview' ? 'warn' : 'neutral'
                    }
                  >
                    {l.status === 'applied'
                      ? 'aplicada'
                      : l.status === 'preview'
                        ? 'prévia aberta'
                        : 'descartada'}
                  </Badge>
                </Td>
              </tr>
            )
          })}
        </Table>
      )}
    </div>
  )
}
