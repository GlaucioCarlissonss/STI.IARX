'use client'

import type { Branch, QueueRule } from '@/lib/types'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { createQueueRule, setQueueRuleActive, updateQueueRule } from './actions'

export interface QueueOption {
  id: string
  name: string
}
export interface CategoryOption {
  id: string
  name: string
  parent_id: string | null
}
export interface PriorityOption {
  key: string
  label: string
}

interface Lookups {
  queues: QueueOption[]
  categories: CategoryOption[]
  priorities: PriorityOption[]
  branches: Branch[]
  sources: string[]
}

/**
 * Condições de uma regra.
 *
 * Só as QUATRO chaves que `app.fn_route_ticket` reconhece. Um campo livre de
 * JSON seria mais flexível e muito pior: chave desconhecida faz a regra não
 * casar (a função falha fechado), então o erro de digitação viraria uma regra
 * silenciosamente morta, e a pessoa ficaria procurando o defeito no ticket.
 */
function RuleFields({ queues, categories, priorities, branches, sources, defaults }: Lookups & { defaults?: QueueRule }) {
  const uid = defaults ? `qr-${defaults.id}` : 'qr-new'
  const c = defaults?.conditions ?? {}
  const nomeCategoria = (cat: CategoryOption) => {
    const pai = cat.parent_id ? categories.find((x) => x.id === cat.parent_id) : null
    return pai ? `${pai.name} › ${cat.name}` : cat.name
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome da regra" htmlFor={`${uid}-name`} required>
          <input
            id={`${uid}-name`}
            name="name"
            required
            maxLength={120}
            defaultValue={defaults?.name ?? ''}
            className={inputClass}
            placeholder="Telefonia por categoria"
          />
        </Field>
        <Field label="Fila de destino" htmlFor={`${uid}-queue_id`} required>
          <select
            id={`${uid}-queue_id`}
            name="queue_id"
            required
            defaultValue={defaults?.queue_id ?? ''}
            className={inputClass}
          >
            <option value="">Selecione…</option>
            {queues.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <p className="text-xs text-[var(--color-ink-3)]">
        As condições preenchidas valem <strong>todas juntas</strong>. Deixar um campo vazio
        significa &ldquo;não restringe&rdquo;. Categoria pai também vale para as filhas dela.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Categoria" htmlFor={`${uid}-category_id`}>
          <select
            id={`${uid}-category_id`}
            name="category_id"
            defaultValue={c.category_id ?? ''}
            className={inputClass}
          >
            <option value="">Qualquer</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {nomeCategoria(cat)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Prioridade" htmlFor={`${uid}-priority_key`}>
          <select
            id={`${uid}-priority_key`}
            name="priority_key"
            defaultValue={c.priority_key ?? ''}
            className={inputClass}
          >
            <option value="">Qualquer</option>
            {priorities.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Filial" htmlFor={`${uid}-branch_id`}>
          <select
            id={`${uid}-branch_id`}
            name="branch_id"
            defaultValue={c.branch_id ?? ''}
            className={inputClass}
          >
            <option value="">Qualquer</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Origem"
          htmlFor={`${uid}-source_system`}
          hint="Sistema que criou o ticket, quando veio de integração."
        >
          <select
            id={`${uid}-source_system`}
            name="source_system"
            defaultValue={c.source_system ?? ''}
            className={inputClass}
          >
            <option value="">Qualquer</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field
        label="Ordem de avaliação"
        htmlFor={`${uid}-sort_order`}
        hint="Menor roda primeiro, e a primeira que casar decide. Empate é resolvido de forma estável."
      >
        <input
          id={`${uid}-sort_order`}
          name="sort_order"
          type="number"
          min={0}
          max={32767}
          defaultValue={defaults?.sort_order ?? 100}
          className={inputClass}
        />
      </Field>
    </>
  )
}

export function NewRuleForm(lookups: Lookups) {
  return (
    <ActionForm action={createQueueRule} className="flex flex-col gap-3">
      <RuleFields {...lookups} />
      <SubmitButton pendingLabel="Cadastrando…">Cadastrar regra</SubmitButton>
    </ActionForm>
  )
}

export function EditRuleForm({ rule, ...lookups }: Lookups & { rule: QueueRule }) {
  return (
    <div className="flex flex-col gap-3">
      <ActionForm action={updateQueueRule} className="flex flex-col gap-3">
        <input type="hidden" name="id" value={rule.id} />
        <input type="hidden" name="is_active" value={rule.is_active ? 'true' : 'false'} />
        <RuleFields {...lookups} defaults={rule} />
        <SubmitButton>Salvar alterações</SubmitButton>
      </ActionForm>

      <ActionForm action={setQueueRuleActive} className="border-t border-[var(--color-border)] pt-3">
        <input type="hidden" name="id" value={rule.id} />
        <input type="hidden" name="is_active" value={rule.is_active ? 'false' : 'true'} />
        {/* Sem exclusão: a regra explica por que um ticket foi parar numa fila, e
            apagá-la tiraria a explicação junto. Desativar basta. */}
        <p className="mb-2 text-xs text-[var(--color-ink-3)]">
          {rule.is_active
            ? 'Desativar para de rotear pelos próximos tickets. Os já criados ficam onde estão.'
            : 'Reativar volta a aplicar esta regra na criação de ticket.'}
        </p>
        <SubmitButton variant={rule.is_active ? 'danger' : 'secondary'}>
          {rule.is_active ? 'Desativar regra' : 'Reativar regra'}
        </SubmitButton>
      </ActionForm>
    </div>
  )
}
