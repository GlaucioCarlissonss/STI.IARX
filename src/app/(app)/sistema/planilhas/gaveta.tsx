import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { formatDate } from '@/lib/format'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import { recursoPorChave } from '@/lib/planilha/recursos'
import { AplicarLoteForm, ConflitoForm, DescartarLoteForm } from './forms'

const DESTINO: Record<string, { label: string; tone: 'ok' | 'warn' | 'breach' | 'neutral' }> = {
  create: { label: 'entra nova', tone: 'ok' },
  update: { label: 'atualiza', tone: 'warn' },
  skip: { label: 'pulada', tone: 'neutral' },
  reject: { label: 'recusada', tone: 'breach' },
}

/**
 * A conferência, linha a linha.
 *
 * A lista começa pelas RECUSADAS, e não pela ordem do arquivo: quem abre esta
 * tela quer saber o que deu errado. As que vão entrar bem são as que não
 * precisam de atenção, e por isso ficam embaixo.
 */
export async function GavetaDeImportacao({
  id,
  novo,
  fechar,
}: {
  id?: string
  novo?: boolean
  fechar: string
}) {
  const podeImportar = await allowed('sistema.planilhas.importar')
  if (novo) return null
  if (!id) return null

  const supabase = await createClient()
  const { data: lote } = await supabase
    .from('import_batches')
    .select(
      'id, resource, file_name, file_bytes, status, on_conflict, total_rows, created_rows, updated_rows, skipped_rows, rejected_rows, created_at, applied_at',
    )
    .eq('id', id)
    .maybeSingle<{
      id: string
      resource: string
      file_name: string
      file_bytes: number
      status: 'preview' | 'applied' | 'discarded'
      on_conflict: 'update' | 'skip'
      total_rows: number
      created_rows: number
      updated_rows: number
      skipped_rows: number
      rejected_rows: number
      created_at: string
      applied_at: string | null
    }>()

  if (!lote) return null

  const recurso = recursoPorChave(lote.resource)

  /* Só as 200 primeiras: a prévia existe para a pessoa DECIDIR, e cinco mil
     linhas numa gaveta não ajudam a decidir nada. As recusadas vêm primeiro
     justamente para caberem aqui. */
  const LIMITE = 200
  const { data: linhas } = await supabase
    .from('import_rows')
    .select('id, line_number, raw, outcome, reason')
    .eq('batch_id', id)
    .order('outcome', { ascending: true })
    .order('line_number', { ascending: true })
    .limit(LIMITE)
    .returns<
      {
        id: string
        line_number: number
        outcome: 'create' | 'update' | 'skip' | 'reject'
        reason: string | null
        raw: { cru: Record<string, string> }
      }[]
    >()

  const lista = (linhas ?? []).sort((a, b) => {
    const peso = { reject: 0, update: 1, skip: 2, create: 3 } as const
    return peso[a.outcome] - peso[b.outcome] || a.line_number - b.line_number
  })

  const aplicaveis = lote.created_rows + lote.updated_rows
  const previa = lote.status === 'preview'

  return (
    <Gaveta fechar={fechar} rotulo={`Importação ${lote.file_name}`}>
      <CabecalhoDaGaveta
        titulo={lote.file_name}
        linha={`${recurso?.rotulo ?? lote.resource} · ${formatDate(lote.created_at)} · ${(lote.file_bytes / 1024).toFixed(0)} KB`}
        fechar={fechar}
        selo={
          <Badge tone={previa ? 'warn' : lote.status === 'applied' ? 'ok' : 'neutral'}>
            {previa ? 'prévia' : lote.status === 'applied' ? 'aplicada' : 'descartada'}
          </Badge>
        }
      />

      <CorpoDaGaveta>
        <section data-testid="resumo-da-importacao">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[var(--color-ink-3)]">Linhas no arquivo</dt>
            <dd className="text-right font-medium tabular-nums">{lote.total_rows}</dd>
            <dt className="text-[var(--color-ink-3)]">Entram novas</dt>
            <dd className="text-right font-medium tabular-nums text-[var(--color-ok-ink)]">
              {lote.created_rows}
            </dd>
            <dt className="text-[var(--color-ink-3)]">Atualizam</dt>
            <dd className="text-right font-medium tabular-nums text-[var(--color-warn-ink)]">
              {lote.updated_rows}
            </dd>
            {lote.skipped_rows > 0 && (
              <>
                <dt className="text-[var(--color-ink-3)]">Puladas</dt>
                <dd className="text-right font-medium tabular-nums">{lote.skipped_rows}</dd>
              </>
            )}
            <dt className="text-[var(--color-ink-3)]">Recusadas</dt>
            <dd className="text-right font-medium tabular-nums text-[var(--color-breach-ink)]">
              {lote.rejected_rows}
            </dd>
          </dl>

          {previa && (
            <p className="mt-2 rounded-lg bg-[var(--color-info-soft)] px-3 py-2 text-xs text-[var(--color-info-ink)]">
              Nada foi gravado ainda. As {lote.rejected_rows} recusada(s) não impedem as{' '}
              {aplicaveis} — baixe só as recusadas, corrija e reenvie esse arquivo menor.
            </p>
          )}
        </section>

        {previa && podeImportar && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Aplicar</h3>
            <div className="flex flex-col gap-3">
              {!recurso?.somenteCriacao && (
                <ConflitoForm id={lote.id} atual={lote.on_conflict} />
              )}
              <AplicarLoteForm id={lote.id} quantas={aplicaveis} />
              <DescartarLoteForm id={lote.id} />
            </div>
          </section>
        )}

        {/*
          * O arquivo de correção fica disponível SEMPRE que há recusa — na
          * prévia e depois de aplicada.
          *
          * Escondê-lo após aplicar tirava-o justamente do momento em que ele
          * serve: antes de aplicar a pessoa ainda pode descartar tudo e
          * reenviar; depois, as boas já entraram, e o que resta é exatamente
          * corrigir as recusadas e mandar de novo.
          */}
        {lote.rejected_rows > 0 && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Corrigir</h3>
            <a
              href={`/api/planilha/recusadas/${lote.id}`}
              download
              data-testid="baixar-recusadas"
              className="block rounded-lg border border-[var(--color-border)] px-3 py-2 text-center text-sm font-medium text-[var(--color-brand-ink)] hover:bg-[var(--color-surface-2)]"
            >
              Baixar as {lote.rejected_rows} recusadas, com o motivo
            </a>
            <p className="mt-2 text-xs text-[var(--color-ink-3)]">
              O arquivo traz as mesmas colunas do original, o número da linha e o motivo de cada
              recusa. Corrija e reenvie só ele.
            </p>
          </section>
        )}

        <section className="border-t border-[var(--color-border)] pt-4">
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
            Linhas ({lista.length}
            {lote.total_rows > LIMITE ? ` de ${lote.total_rows}` : ''})
          </h3>
          {lote.total_rows > LIMITE && (
            <p className="mb-2 text-xs text-[var(--color-ink-3)]">
              Mostrando as {LIMITE} primeiras, recusadas na frente. O arquivo de correção traz
              todas as recusadas.
            </p>
          )}
          <div className="flex flex-col gap-2">
            {lista.map((l) => {
              const destino = DESTINO[l.outcome]
              const resumo = Object.entries(l.raw.cru ?? {})
                .filter(([, v]) => v !== '')
                .slice(0, 3)
                .map(([k, v]) => `${k}: ${v}`)
                .join(' · ')
              return (
                <div
                  key={l.id}
                  data-testid="linha-da-importacao"
                  className={`rounded-lg border px-3 py-2 ${
                    l.outcome === 'reject'
                      ? 'border-[var(--color-breach)] bg-[var(--color-breach-soft)]'
                      : 'border-[var(--color-border)]'
                  }`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-mono text-xs text-[var(--color-ink-3)]">
                      linha {l.line_number}
                    </span>
                    <Badge tone={destino.tone}>{destino.label}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-[var(--color-ink)]">{resumo || '—'}</p>
                  {l.reason && (
                    <p className="mt-1 text-xs text-[var(--color-breach-ink)]">{l.reason}</p>
                  )}
                </div>
              )
            })}
          </div>
        </section>

        {lote.status === 'applied' && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <p className="text-sm text-[var(--color-ink-2)]">
              Aplicada em {lote.applied_at ? formatDate(lote.applied_at) : '—'}. Para corrigir,
              envie um lote novo — um lote aplicado não volta a ser prévia.
            </p>
            {recurso && (
              <Link
                href={`/${recurso.chave === 'ativos' ? 'inventario' : recurso.chave === 'clientes' || recurso.chave === 'filiais' ? 'clientes' : `locacao/${recurso.chave === 'leituras' ? 'medicoes' : recurso.chave}`}` as Route}
                className="mt-2 inline-block text-sm text-[var(--color-brand-ink)] hover:underline"
              >
                Ver {recurso.rotulo.toLowerCase()}
              </Link>
            )}
          </section>
        )}
      </CorpoDaGaveta>
    </Gaveta>
  )
}
