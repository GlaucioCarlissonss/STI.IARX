'use client'

import type { Category } from '@/lib/types'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { createCategory, setCategoryActive, updateCategory } from './actions'

function CategoryFields({
  topLevel,
  defaults,
}: {
  /** Só categorias de topo entram aqui — profundidade máxima é 2 (RF-TAX-01). */
  topLevel: Category[]
  defaults?: Category
}) {
  const uid = defaults ? `cat-${defaults.id}` : 'cat-new'
  // Editando uma categoria de topo, ela não pode virar sua própria subcategoria.
  const parentOptions = topLevel.filter((c) => c.id !== defaults?.id)

  return (
    <>
      <Field
        label="Categoria-pai"
        htmlFor={`${uid}-parent_id`}
        hint="Deixe em branco para uma categoria de topo."
      >
        <select
          id={`${uid}-parent_id`}
          name="parent_id"
          defaultValue={defaults?.parent_id ?? ''}
          className={inputClass}
        >
          <option value="">Nenhuma (categoria de topo)</option>
          {parentOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Nome" htmlFor={`${uid}-name`} required>
        <input
          id={`${uid}-name`}
          name="name"
          required
          maxLength={120}
          defaultValue={defaults?.name ?? ''}
          className={inputClass}
          placeholder="Hardware"
        />
      </Field>

      <Field label="Descrição" htmlFor={`${uid}-description`}>
        <textarea
          id={`${uid}-description`}
          name="description"
          rows={2}
          maxLength={500}
          defaultValue={defaults?.description ?? ''}
          className={inputClass}
        />
      </Field>
    </>
  )
}

export function NewCategoryForm({ topLevel }: { topLevel: Category[] }) {
  return (
    <ActionForm action={createCategory} className="flex flex-col gap-4">
      <CategoryFields topLevel={topLevel} />
      <SubmitButton pendingLabel="Cadastrando…">Cadastrar categoria</SubmitButton>
    </ActionForm>
  )
}

export function EditCategoryForm({
  category,
  topLevel,
}: {
  category: Category
  topLevel: Category[]
}) {
  return (
    <div className="flex flex-col gap-4">
      <ActionForm action={updateCategory} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={category.id} />
        <CategoryFields topLevel={topLevel} defaults={category} />
        <SubmitButton>Salvar alterações</SubmitButton>
      </ActionForm>

      <ActionForm action={setCategoryActive} className="border-t border-[var(--color-border)] pt-4">
        <input type="hidden" name="id" value={category.id} />
        <input type="hidden" name="is_active" value={category.is_active ? 'false' : 'true'} />
        <p className="mb-2 text-xs text-[var(--color-ink-3)]">
          {category.is_active
            ? 'Inativar tira a categoria do formulário de abertura de ticket; definições de SLA que a usam continuam valendo.'
            : 'Reativar devolve a categoria ao formulário de abertura de ticket.'}
        </p>
        <SubmitButton variant={category.is_active ? 'danger' : 'secondary'}>
          {category.is_active ? 'Inativar categoria' : 'Reativar categoria'}
        </SubmitButton>
      </ActionForm>
    </div>
  )
}
