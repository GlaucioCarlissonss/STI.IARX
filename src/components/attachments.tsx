import { allowed } from '@/lib/session'
import { formatDate } from '@/lib/format'
import {
  ATTACHMENT_TARGETS,
  fileKindLabel,
  formatBytes,
  type AttachmentEntity,
} from '@/lib/storage'
import { AttachmentForm, AttachmentRow } from './attachment-forms'

/**
 * Lista de anexos com upload e remoção, compartilhada pelos três módulos.
 *
 * Server Component: decide por permissão aqui, então o formulário de upload nem
 * chega ao HTML de quem não pode anexar. Os controles interativos moram em
 * `attachment-forms.tsx`, que é cliente — este arquivo continua no servidor para
 * poder chamar `allowed()`.
 */
export interface AttachmentRecord {
  id: string
  storage_path: string
  file_name: string
  mime_type: string | null
  size_bytes: number | null
  created_at: string
  kind?: string | null
}

export async function Attachments({
  entity,
  entityId,
  records,
  title = 'Anexos',
}: {
  entity: AttachmentEntity
  entityId: string
  records: AttachmentRecord[]
  title?: string
}) {
  const target = ATTACHMENT_TARGETS[entity]
  const [podeVer, podeAnexar, podeRemover] = await Promise.all([
    allowed(target.permissions.ver),
    allowed(target.permissions.anexar),
    allowed(target.permissions.remover),
  ])

  // Sem permissão de consulta a seção inteira desaparece — inclusive a contagem.
  // Dizer "3 anexos" a quem não pode abri-los já entrega informação.
  if (!podeVer) return null

  const rotuloKind = (valor: string | null | undefined) =>
    target.kinds.find((k) => k.value === valor)?.label ?? null

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">{title}</h3>
        <span className="text-xs text-[var(--color-ink-3)]">
          {records.length === 0
            ? 'nenhum arquivo'
            : `${records.length} ${records.length === 1 ? 'arquivo' : 'arquivos'}`}
        </span>
      </div>

      {records.length > 0 && (
        <ul className="mb-3 flex flex-col gap-1.5">
          {records.map((r) => (
            <AttachmentRow
              key={r.id}
              entity={entity}
              record={r}
              kindLabel={rotuloKind(r.kind)}
              typeLabel={fileKindLabel(r.mime_type)}
              sizeLabel={formatBytes(r.size_bytes)}
              dateLabel={formatDate(r.created_at)}
              canRemove={podeRemover}
            />
          ))}
        </ul>
      )}

      {podeAnexar ? (
        <AttachmentForm entity={entity} entityId={entityId} kinds={target.kinds} />
      ) : (
        records.length === 0 && (
          <p className="text-sm italic text-[var(--color-ink-3)]">
            Nenhum anexo. Você não tem permissão para anexar arquivos aqui.
          </p>
        )
      )}
    </section>
  )
}
