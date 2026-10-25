'use client'

import { useActionState, useState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { Card, ErrorNote, Field, inputClass } from '@/components/ui'
import { criarProjeto } from './actions'

/**
 * Cadastro de projeto.
 *
 * O campo de mês é `<input type="month">`, que entrega `AAAA-MM` — e
 * `paraInterno()` na ação aceita esse formato e o brasileiro. Um campo de texto
 * livre aqui devolveria "abril/26" e "04-2026" na mesma semana.
 */
export function ProjetoForm({
  clientes,
  filiais,
  className = '',
}: {
  clientes: { id: string; nome: string }[]
  filiais: { id: string; name: string; client_id: string }[]
  className?: string
}) {
  const [state, formAction] = useActionState(criarProjeto, {})
  const [clienteId, setClienteId] = useState('')
  const [status, setStatus] = useState('planejado')

  /* Filial depende do cliente: oferecer a filial de outro cliente é oferecer um
     erro que a chave composta do ADR-001 recusaria com mensagem de constraint. */
  const filiaisDoCliente = clienteId ? filiais.filter((f) => f.client_id === clienteId) : []

  return (
    <Card title="Novo projeto" className={className}>
      <form action={formAction} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome do projeto" htmlFor="name" required>
            <input
              id="name"
              name="name"
              required
              minLength={2}
              maxLength={160}
              className={inputClass}
              placeholder="Migração do servidor de arquivos"
            />
          </Field>

          <Field label="Cliente" htmlFor="client_id" required>
            <select
              id="client_id"
              name="client_id"
              value={clienteId}
              onChange={(e) => setClienteId(e.target.value)}
              required
              className={inputClass}
            >
              <option value="" disabled>
                Escolha o cliente…
              </option>
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field
          label="Filial"
          htmlFor="branch_id"
          hint="Em branco: projeto do grupo inteiro, atravessando as unidades."
        >
          <select
            id="branch_id"
            name="branch_id"
            key={clienteId}
            defaultValue=""
            disabled={filiaisDoCliente.length === 0}
            className={inputClass}
          >
            <option value="">{clienteId ? 'Do grupo inteiro' : 'Escolha o cliente primeiro'}</option>
            {filiaisDoCliente.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Descrição" htmlFor="description">
          <textarea id="description" name="description" rows={2} maxLength={2000} className={inputClass} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Início" htmlFor="start_month" required>
            <input id="start_month" name="start_month" type="month" required className={inputClass} />
          </Field>

          <Field label="Fim planejado" htmlFor="planned_end_month" required>
            <input
              id="planned_end_month"
              name="planned_end_month"
              type="month"
              required
              className={inputClass}
            />
          </Field>

          <Field label="Situação" htmlFor="status">
            <select
              id="status"
              name="status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className={inputClass}
            >
              <option value="planejado">Planejado</option>
              <option value="em_andamento">Em andamento</option>
              <option value="concluido">Concluído</option>
              <option value="cancelado">Cancelado</option>
            </select>
          </Field>

          <Field
            label="Fim real"
            htmlFor="actual_end_month"
            hint="Só na conclusão. É ele que vira o desvio."
            required={status === 'concluido'}
          >
            <input
              id="actual_end_month"
              name="actual_end_month"
              type="month"
              required={status === 'concluido'}
              className={inputClass}
            />
          </Field>
        </div>

        {status === 'concluido' && (
          <p className="text-xs text-[var(--color-ink-3)]">
            Projeto concluído exige o mês de fim real: sem ele, &ldquo;concluído&rdquo; é um rótulo
            sem desvio nenhum para medir.
          </p>
        )}

        {state.error && <ErrorNote>{state.error}</ErrorNote>}
        {state.success && (
          <p role="status" className="text-sm text-[var(--color-ok-ink)]">
            {state.success}
          </p>
        )}

        <SubmitButton pendingLabel="Criando…">Criar projeto</SubmitButton>
      </form>
    </Card>
  )
}
