'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { ErrorNote, Field, inputClass } from '@/components/ui'
import { precoEmTexto, type Campo } from '@/lib/catalogo/campos'
import { pedirServico } from '../actions'

interface ServicoResumido {
  id: string
  preco: number | null
  unidade: string | null
  prazo_horas: number | null
  requer_aprovacao: boolean
  fila: string | null
}

/**
 * O formulário do pedido.
 *
 * ## O preço mostrado aqui é o de tabela, e a tela diz isso
 *
 * O preço real depende do contrato do cliente da filial escolhida, e quem o
 * calcula é o banco, no instante do pedido. Esta tela poderia buscar o preço a
 * cada troca de filial — e isso custaria uma requisição por clique num número
 * que a pessoa confere uma vez.
 *
 * A escolha foi dizer a verdade em vez de esconder a limitação: "a partir de X;
 * o valor final considera o contrato da sua empresa". Quem tem o serviço no
 * contrato descobre que não paga no chamado, que é onde isso fica registrado de
 * qualquer jeito.
 */
export function PedidoForm({
  servico,
  campos,
  filiais,
}: {
  servico: ServicoResumido
  campos: Campo[]
  filiais: { id: string; nome: string; cliente: string | null }[]
}) {
  const [state, action] = useActionState(pedirServico, {})

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="service_id" value={servico.id} />

      <dl className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg bg-[var(--color-surface-2)] p-3.5 text-sm">
        <div>
          <dt className="text-xs text-[var(--color-ink-3)]">Preço</dt>
          <dd className="font-medium text-[var(--color-ink)]">
            {servico.preco === null
              ? 'Sob consulta'
              : `a partir de ${precoEmTexto(servico.preco, false, servico.unidade)}`}
          </dd>
        </div>
        {servico.prazo_horas && (
          <div>
            <dt className="text-xs text-[var(--color-ink-3)]">Prazo</dt>
            <dd className="font-medium text-[var(--color-ink)]">
              {servico.prazo_horas} horas úteis
            </dd>
          </div>
        )}
        {servico.fila && (
          <div>
            <dt className="text-xs text-[var(--color-ink-3)]">Vai para</dt>
            <dd className="font-medium text-[var(--color-ink)]">{servico.fila}</dd>
          </div>
        )}
      </dl>

      {servico.preco !== null && (
        <p className="text-xs text-[var(--color-ink-3)]">
          O valor final considera o contrato da empresa da filial escolhida — pode ser menor, ou
          já estar incluído. Ele fica registrado no chamado.
        </p>
      )}

      {servico.requer_aprovacao && (
        <p className="rounded-lg border border-[var(--color-warn-ink)]/30 bg-[var(--color-warn-soft)] p-3 text-sm text-[var(--color-warn-ink)]">
          Este serviço <strong>precisa de aprovação</strong> antes de ser executado. O chamado é
          aberto na hora e fica aguardando.
        </p>
      )}

      <Field label="Para qual filial" htmlFor="branch_id">
        <select id="branch_id" name="branch_id" defaultValue="" className={inputClass}>
          <option value="">Não se aplica</option>
          {filiais.map((f) => (
            <option key={f.id} value={f.id}>
              {f.cliente ? `${f.cliente} — ${f.nome}` : f.nome}
            </option>
          ))}
        </select>
      </Field>

      {campos.map((c) => (
        <Field key={c.chave} label={c.rotulo} htmlFor={`campo_${c.chave}`} required={c.obrigatorio}>
          {c.tipo === 'escolha' ? (
            <select
              id={`campo_${c.chave}`}
              name={`campo_${c.chave}`}
              required={c.obrigatorio}
              defaultValue=""
              className={inputClass}
            >
              <option value="">Escolha</option>
              {(c.opcoes ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : c.tipo === 'simnao' ? (
            <label className="flex items-center gap-2 text-sm text-[var(--color-ink-2)]">
              <input id={`campo_${c.chave}`} name={`campo_${c.chave}`} type="checkbox" />
              Sim
            </label>
          ) : (
            <input
              id={`campo_${c.chave}`}
              name={`campo_${c.chave}`}
              type={c.tipo === 'numero' ? 'number' : 'text'}
              required={c.obrigatorio}
              maxLength={c.tipo === 'texto' ? 2000 : undefined}
              className={inputClass}
            />
          )}
          {c.ajuda && <p className="mt-1 text-xs text-[var(--color-ink-3)]">{c.ajuda}</p>}
        </Field>
      ))}

      <Field label="Mais alguma coisa?" htmlFor="observacao">
        <textarea
          id="observacao"
          name="observacao"
          rows={3}
          maxLength={20000}
          className={inputClass}
          placeholder="Qualquer detalhe que ajude quem vai atender."
        />
      </Field>

      {state.error && <ErrorNote>{state.error}</ErrorNote>}

      <SubmitButton pendingLabel="Abrindo o chamado…">Pedir</SubmitButton>
      <p className="text-xs text-[var(--color-ink-3)]">
        Pedir aqui abre um chamado já classificado. Você acompanha por ele.
      </p>
    </form>
  )
}
