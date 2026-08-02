'use client'

import type { Branch, Category, Priority, Profile, Queue } from '@/lib/types'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { createTicket } from '../actions'

type CategoryGroup = Category & { children: Category[] }

export function NewTicketForm({
  priorities,
  queues,
  categoryGroups,
  branches,
  agents,
  canAssign,
}: {
  priorities: Priority[]
  queues: Queue[]
  categoryGroups: CategoryGroup[]
  branches: Branch[]
  agents: Profile[]
  canAssign: boolean
}) {
  // Prioridade média como padrão: pré-selecionar "crítica" faz todo mundo abrir
  // tudo como crítico, e a fila perde o poder de discriminar.
  const defaultPriority =
    priorities.find((p) => p.key === 'medium')?.id ?? priorities[Math.floor(priorities.length / 2)]?.id

  return (
    <ActionForm
      action={createTicket}
      className="flex flex-col gap-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
    >
      <Field label="Título" htmlFor="title" required hint="Resuma o problema em uma frase.">
        <input
          id="title"
          name="title"
          required
          minLength={4}
          maxLength={200}
          className={inputClass}
          placeholder="ex.: Internet da matriz oscilando desde as 08h"
        />
      </Field>

      <Field
        label="Descrição"
        htmlFor="description"
        hint="Quando começou, quem é afetado, o que já foi tentado."
      >
        <textarea id="description" name="description" rows={6} className={inputClass} />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Prioridade" htmlFor="priority_id" required>
          <select id="priority_id" name="priority_id" required defaultValue={defaultPriority} className={inputClass}>
            {priorities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Categoria" htmlFor="category_id" hint="Define o SLA aplicável.">
          <select id="category_id" name="category_id" defaultValue="" className={inputClass}>
            <option value="">Sem categoria</option>
            {categoryGroups.map((group) => (
              <optgroup key={group.id} label={group.name}>
                <option value={group.id}>{group.name} (geral)</option>
                {group.children.map((child) => (
                  <option key={child.id} value={child.id}>
                    {child.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>

        <Field label="Filial" htmlFor="branch_id" hint="Em branco, usa a sua filial principal.">
          <select id="branch_id" name="branch_id" defaultValue="" className={inputClass}>
            <option value="">Automática</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Fila" htmlFor="queue_id" hint="Em branco, usa a fila padrão do sistema.">
          <select id="queue_id" name="queue_id" defaultValue="" className={inputClass}>
            <option value="">Automática</option>
            {queues.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </select>
        </Field>

        {canAssign && (
          <Field label="Atendente" htmlFor="assignee_id">
            <select id="assignee_id" name="assignee_id" defaultValue="" className={inputClass}>
              <option value="">Não atribuir agora</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.full_name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <div className="flex justify-end">
        <SubmitButton pendingLabel="Abrindo…">Abrir ticket</SubmitButton>
      </div>
    </ActionForm>
  )
}
