'use client'

import { useActionState, useState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { Card, ErrorNote, Field, inputClass } from '@/components/ui'
import { classificarContato } from '../actions'

/**
 * Diz de quem é o número.
 *
 * ## Por que o formulário fica aqui, e não na tela de administração
 *
 * Porque é na conversa que se descobre. A pessoa escreve "aqui é o Marcos da
 * Transportadora", e quem está lendo sabe — o administrador, olhando uma lista de
 * telefones, não sabe. Por isso a permissão é `canais.conversas.responder`.
 *
 * ## A filial depende do cliente
 *
 * Escolher a filial de outro cliente é um erro que o banco recusa (chave composta
 * do ADR-001), com uma mensagem sobre constraint. Filtrar a lista aqui evita o
 * erro em vez de explicá-lo.
 */
export function ContatoForm({
  contato,
  pessoas,
  clientes,
  filiais,
}: {
  contato: {
    id: string
    display_name: string | null
    profile_id: string | null
    client_id: string | null
    branch_id: string | null
    bloqueado: boolean
  }
  pessoas: { id: string; full_name: string }[]
  clientes: { id: string; nome: string }[]
  filiais: { id: string; name: string; client_id: string }[]
}) {
  const [state, formAction] = useActionState(classificarContato, {})
  const [clienteId, setClienteId] = useState(contato.client_id ?? '')

  const filiaisDoCliente = clienteId ? filiais.filter((f) => f.client_id === clienteId) : []

  return (
    <Card title="De quem é este número">
      <p className="mb-4 text-sm text-[var(--color-ink-2)]">
        Classificar não muda os chamados já abertos — muda os próximos, que passam a nascer com
        cliente e com SLA.
      </p>

      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="contact_id" value={contato.id} />

        <Field label="Como chamá-lo" htmlFor="display_name">
          <input
            id="display_name"
            name="display_name"
            maxLength={200}
            defaultValue={contato.display_name ?? ''}
            className={inputClass}
            placeholder="Marcos da Transportadora"
          />
        </Field>

        <Field
          label="Pessoa cadastrada"
          htmlFor="profile_id"
          hint="Quando existe cadastro, é o que liga a conversa ao histórico dela."
        >
          <select
            id="profile_id"
            name="profile_id"
            defaultValue={contato.profile_id ?? ''}
            className={inputClass}
          >
            <option value="">Ninguém ainda</option>
            {pessoas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Cliente"
          htmlFor="client_id"
          hint="Sem cliente, o chamado não tem SLA nem aparece no painel de ninguém."
        >
          <select
            id="client_id"
            name="client_id"
            value={clienteId}
            onChange={(e) => setClienteId(e.target.value)}
            className={inputClass}
          >
            <option value="">Nenhum</option>
            {clientes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nome}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Filial" htmlFor="branch_id">
          <select
            id="branch_id"
            name="branch_id"
            /* `key` pelo cliente: sem isso, trocar de cliente manteria
               selecionada a filial do cliente anterior, que o banco recusa. */
            key={clienteId}
            defaultValue={clienteId === contato.client_id ? (contato.branch_id ?? '') : ''}
            disabled={filiaisDoCliente.length === 0}
            className={inputClass}
          >
            <option value="">{clienteId ? 'A definir' : 'Escolha o cliente primeiro'}</option>
            {filiaisDoCliente.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>

        <label className="flex items-start gap-2.5 text-sm text-[var(--color-ink)]">
          <input
            type="checkbox"
            name="bloqueado"
            defaultChecked={contato.bloqueado}
            className="mt-0.5"
          />
          <span>
            Bloquear este contato
            <span className="block text-xs text-[var(--color-ink-3)]">
              As mensagens continuam sendo registradas e deixam de abrir chamado. Registrar em vez
              de descartar é o que permite descobrir um bloqueio feito por engano.
            </span>
          </span>
        </label>

        {state.error && <ErrorNote>{state.error}</ErrorNote>}
        {state.success && (
          <p role="status" className="text-sm text-[var(--color-ok-ink)]">
            {state.success}
          </p>
        )}

        <SubmitButton pendingLabel="Salvando…">Salvar</SubmitButton>
      </form>
    </Card>
  )
}
