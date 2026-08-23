'use client'

import { useState, useTransition } from 'react'
import { ActionForm, SubmitButton } from './action-form'
import { Field, inputClass } from './ui'
import { attachFile, removeAttachment, signAttachmentUrl } from '@/app/(app)/anexos/actions'
import { ALLOWED_MIME_TYPES, type AttachmentEntity, type AttachmentKind } from '@/lib/storage'
import type { AttachmentRecord } from './attachments'

const ACCEPT = ALLOWED_MIME_TYPES.join(',')

export function AttachmentForm({
  entity,
  entityId,
  kinds,
}: {
  entity: AttachmentEntity
  entityId: string
  kinds: readonly AttachmentKind[]
}) {
  const uid = `at-${entity}-${entityId}`
  return (
    <ActionForm action={attachFile} className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-3">
      <input type="hidden" name="entity" value={entity} />
      <input type="hidden" name="entityId" value={entityId} />

      <div className={kinds.length > 0 ? 'grid gap-3 sm:grid-cols-2' : ''}>
        <Field label="Arquivo" htmlFor={`${uid}-file`} required hint="Até 25 MB por arquivo.">
          <input
            id={`${uid}-file`}
            name="file"
            type="file"
            required
            accept={ACCEPT}
            className={inputClass}
          />
        </Field>

        {/* Só onde a tabela cobra o tipo. Em ticket ele é derivado do MIME por
            trigger, e oferecer o campo daria uma escolha que o banco descarta. */}
        {kinds.length > 0 && (
          <Field label="Tipo do documento" htmlFor={`${uid}-kind`} required>
            <select id={`${uid}-kind`} name="kind" required defaultValue="" className={inputClass}>
              <option value="" disabled>
                Selecione…
              </option>
              {kinds.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <div>
        <SubmitButton variant="secondary" pendingLabel="Enviando…">
          Anexar
        </SubmitButton>
      </div>
    </ActionForm>
  )
}

export function AttachmentRow({
  entity,
  record,
  kindLabel,
  typeLabel,
  sizeLabel,
  dateLabel,
  canRemove,
}: {
  entity: AttachmentEntity
  record: AttachmentRecord
  kindLabel: string | null
  typeLabel: string
  sizeLabel: string
  dateLabel: string
  canRemove: boolean
}) {
  const [erro, setErro] = useState<string | null>(null)
  const [abrindo, startTransition] = useTransition()

  /*
   * O download passa por URL assinada pedida no clique, não por link pronto na
   * página. O bucket é privado e a URL expira em 5 minutos: gerar na renderização
   * deixaria o link válido no HTML de quem só abriu a tela e não baixou nada —
   * e ele vazaria por print, histórico ou página salva.
   */
  function abrir() {
    setErro(null)
    startTransition(async () => {
      const r = await signAttachmentUrl(entity, record.storage_path)
      if ('error' in r) {
        setErro(r.error)
        return
      }
      window.open(r.url, '_blank', 'noopener,noreferrer')
    })
  }

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-[var(--color-surface-2)] px-3 py-2">
      <button
        type="button"
        onClick={abrir}
        disabled={abrindo}
        className="min-w-0 flex-1 truncate text-left text-sm font-medium text-[var(--color-brand)] underline decoration-dotted underline-offset-2 hover:decoration-solid disabled:opacity-60"
      >
        {abrindo ? 'Abrindo…' : record.file_name}
      </button>

      <span className="text-xs text-[var(--color-ink-3)]">
        {kindLabel ? `${kindLabel} · ` : ''}
        {typeLabel} · {sizeLabel} · {dateLabel}
      </span>

      {canRemove && (
        <ActionForm action={removeAttachment}>
          <input type="hidden" name="entity" value={entity} />
          <input type="hidden" name="id" value={record.id} />
          <SubmitButton variant="secondary" pendingLabel="…">
            Remover
          </SubmitButton>
        </ActionForm>
      )}

      {erro && (
        <p role="alert" className="w-full text-xs text-[var(--color-breach-ink)]">
          {erro}
        </p>
      )}
    </li>
  )
}
