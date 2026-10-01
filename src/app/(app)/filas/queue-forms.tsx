'use client'

import type { Queue } from '@/lib/types'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { createQueue, setQueueActive, updateQueue } from './actions'

/**
 * Cadastro de fila.
 *
 * Os três pesos são o que diferencia uma fila de outra na prática: a mesma lista
 * de tickets ordenada por critérios diferentes é outra fila de trabalho. Por isso
 * eles aparecem com o que cada um significa, e não como três números soltos.
 */
function QueueFields({ defaults }: { defaults?: Queue }) {
  const uid = defaults ? `q-${defaults.id}` : 'q-new'
  const padrao = defaults?.is_system_default ?? false

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome" htmlFor={`${uid}-name`} required>
          <input
            id={`${uid}-name`}
            name="name"
            required
            maxLength={120}
            defaultValue={defaults?.name ?? ''}
            readOnly={padrao}
            className={inputClass}
            placeholder="Infraestrutura"
          />
        </Field>
        <Field
          label="Identificador"
          htmlFor={`${uid}-slug`}
          required
          hint="Vai para o endereço da tela. Letras minúsculas, números e hífen."
        >
          <input
            id={`${uid}-slug`}
            name="slug"
            required
            maxLength={60}
            defaultValue={defaults?.slug ?? ''}
            readOnly={padrao}
            className={inputClass}
            placeholder="infra"
          />
        </Field>
      </div>

      {padrao && (
        <p className="text-xs text-[var(--color-ink-3)]">
          Esta é a fila padrão do sistema: nome e identificador são protegidos no banco, e ela
          não pode ser desativada. É ela que recebe todo ticket que nenhuma regra roteou.
        </p>
      )}

      <Field label="Descrição" htmlFor={`${uid}-description`}>
        <input
          id={`${uid}-description`}
          name="description"
          maxLength={200}
          defaultValue={defaults?.description ?? ''}
          className={inputClass}
        />
      </Field>

      <p className="text-xs text-[var(--color-ink-3)]">
        Os pesos decidem a <strong>ordem</strong> dentro da fila, combinados num score. Não
        precisam somar 100: o que importa é a proporção entre eles.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Criticidade" htmlFor={`${uid}-weight_criticality`} required>
          <input
            id={`${uid}-weight_criticality`}
            name="weight_criticality"
            type="number"
            min={0}
            max={100}
            required
            defaultValue={defaults?.weight_criticality ?? 60}
            className={inputClass}
          />
        </Field>
        <Field label="Urgência de prazo" htmlFor={`${uid}-weight_deadline`} required>
          <input
            id={`${uid}-weight_deadline`}
            name="weight_deadline"
            type="number"
            min={0}
            max={100}
            required
            defaultValue={defaults?.weight_deadline ?? 30}
            className={inputClass}
          />
        </Field>
        <Field label="Tempo de espera" htmlFor={`${uid}-weight_age`} required>
          <input
            id={`${uid}-weight_age`}
            name="weight_age"
            type="number"
            min={0}
            max={100}
            required
            defaultValue={defaults?.weight_age ?? 10}
            className={inputClass}
          />
        </Field>
      </div>
    </>
  )
}

export function NewQueueForm() {
  return (
    <ActionForm action={createQueue} className="flex flex-col gap-3">
      <QueueFields />
      <SubmitButton pendingLabel="Criando…">Criar fila</SubmitButton>
    </ActionForm>
  )
}

export function EditQueueForm({ queue, podeInativar }: { queue: Queue; podeInativar: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <ActionForm action={updateQueue} className="flex flex-col gap-3">
        <input type="hidden" name="id" value={queue.id} />
        <QueueFields defaults={queue} />
        <SubmitButton>Salvar alterações</SubmitButton>
      </ActionForm>

      {/* A fila padrão não oferece o botão: a trigger do banco recusaria, e um
          botão que sempre dá erro é pior do que botão nenhum. */}
      {podeInativar && !queue.is_system_default && (
        <ActionForm action={setQueueActive} className="border-t border-[var(--color-border)] pt-3">
          <input type="hidden" name="id" value={queue.id} />
          <input type="hidden" name="is_active" value={queue.is_active ? 'false' : 'true'} />
          <p className="mb-2 text-xs text-[var(--color-ink-3)]">
            {queue.is_active
              ? 'Inativar tira a fila dos seletores e do roteamento. Os tickets já nela continuam onde estão — e continuam sendo atendidos.'
              : 'Reativar devolve a fila aos seletores e às regras de roteamento.'}
          </p>
          <SubmitButton variant={queue.is_active ? 'danger' : 'secondary'}>
            {queue.is_active ? 'Inativar fila' : 'Reativar fila'}
          </SubmitButton>
        </ActionForm>
      )}
    </div>
  )
}
