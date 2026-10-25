'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { Card, ErrorNote, Field, inputClass } from '@/components/ui'
import { salvarServico } from './actions'

const EXEMPLO = `[
  {
    "chave": "patrimonio",
    "rotulo": "Patrimônio do equipamento",
    "tipo": "texto",
    "obrigatorio": true,
    "ajuda": "A etiqueta colada na lateral"
  },
  {
    "chave": "sistema",
    "rotulo": "Sistema desejado",
    "tipo": "escolha",
    "obrigatorio": true,
    "opcoes": ["Windows 11", "Ubuntu 24.04"]
  },
  { "chave": "urgente", "rotulo": "É urgente?", "tipo": "simnao" }
]`

/**
 * Cadastro de serviço.
 *
 * ## Por que os campos do formulário são digitados como JSON
 *
 * Um construtor visual de formulário é um projeto em si — arrastar, reordenar,
 * editar opção por opção, pré-visualizar. Ele seria melhor para quem cadastra, e
 * o custo de construí-lo agora adiaria o catálogo inteiro.
 *
 * O JSON é feio e é honesto: quem cadastra serviço num helpdesk é alguém de TI, o
 * exemplo está ao lado, e o erro é validado na submissão com mensagem em
 * português — não na renderização da vitrine, onde quem cadastrou nunca veria.
 *
 * Está escrito aqui para a próxima pessoa saber que a escolha foi de prazo, e não
 * de preguiça.
 */
export function ServicoForm({
  categorias,
  filas,
  prioridades,
  className = '',
}: {
  categorias: { id: string; name: string }[]
  filas: { id: string; name: string }[]
  prioridades: { id: string; name: string }[]
  className?: string
}) {
  const [state, action] = useActionState(salvarServico, {})

  return (
    <Card title="Cadastrar um serviço" className={className}>
      <p className="mb-4 text-sm text-[var(--color-ink-2)]">
        Comece pelo que mais pedem por e-mail. É o que o catálogo tira da caixa de entrada — e o
        pedido chega já com a fila, a prioridade e as informações que faltavam.
      </p>

      <form action={action} className="flex flex-col gap-4">
        <Field label="Nome do serviço" htmlFor="name" required>
          <input
            id="name"
            name="name"
            required
            minLength={3}
            maxLength={120}
            className={inputClass}
            placeholder="Formatação de estação"
          />
        </Field>

        <Field label="O que está incluído" htmlFor="description">
          <textarea
            id="description"
            name="description"
            rows={3}
            maxLength={4000}
            className={inputClass}
            placeholder="Backup dos arquivos, formatação, instalação do pacote padrão e devolução configurada."
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Categoria" htmlFor="category_id">
            <select id="category_id" name="category_id" defaultValue="" className={inputClass}>
              <option value="">Sem categoria</option>
              {categorias.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Fila de destino" htmlFor="queue_id">
            <select id="queue_id" name="queue_id" defaultValue="" className={inputClass}>
              <option value="">Fila padrão</option>
              {filas.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Prioridade" htmlFor="priority_id">
            <select id="priority_id" name="priority_id" defaultValue="" className={inputClass}>
              <option value="">Padrão do chamado</option>
              {prioridades.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Preço de tabela" htmlFor="preco">
            <input
              id="preco"
              name="preco"
              type="number"
              step="0.01"
              min={0}
              className={inputClass}
              placeholder="deixe vazio = sob consulta"
            />
            <p className="mt-1 text-xs text-[var(--color-ink-3)]">
              Vazio não é zero: vazio é &ldquo;sob consulta&rdquo;, zero é &ldquo;sem
              custo&rdquo;.
            </p>
          </Field>

          <Field label="Unidade" htmlFor="unidade">
            <select id="unidade" name="unidade" defaultValue="" className={inputClass}>
              <option value="">—</option>
              <option value="unidade">por unidade</option>
              <option value="hora">por hora</option>
              <option value="mes">por mês</option>
              <option value="ponto">por ponto</option>
              <option value="usuario">por usuário</option>
            </select>
          </Field>

          <Field label="Prazo (horas úteis)" htmlFor="prazo_horas">
            <input
              id="prazo_horas"
              name="prazo_horas"
              type="number"
              min={1}
              max={2000}
              className={inputClass}
              placeholder="8"
            />
            <p className="mt-1 text-xs text-[var(--color-ink-3)]">
              É a expectativa publicada, não o SLA — o SLA continua vindo do contrato.
            </p>
          </Field>
        </div>

        <Field label="Campos do formulário (JSON)" htmlFor="campos">
          <textarea
            id="campos"
            name="campos"
            rows={10}
            defaultValue="[]"
            className={`${inputClass} font-mono text-xs`}
          />
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-[var(--color-brand-ink)]">
              Ver um exemplo
            </summary>
            <pre className="mt-2 overflow-x-auto rounded bg-[var(--color-surface-2)] p-2 font-mono text-xs text-[var(--color-ink-2)]">
              {EXEMPLO}
            </pre>
            <p className="mt-2 text-xs text-[var(--color-ink-3)]">
              Tipos: <code>texto</code>, <code>numero</code>, <code>escolha</code> (com{' '}
              <code>opcoes</code>) e <code>simnao</code>. A <code>chave</code> aceita só letras
              minúsculas, números e sublinhado — ela atravessa o HTML e o JSON do chamado.
            </p>
          </details>
        </Field>

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-[var(--color-ink-2)]">
            <input type="checkbox" name="is_active" defaultChecked />
            Aparecer na vitrine
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--color-ink-2)]">
            <input type="checkbox" name="requer_aprovacao" />
            Precisa de aprovação antes de executar
          </label>
        </div>

        {state.error && <ErrorNote>{state.error}</ErrorNote>}
        {state.success && (
          <p role="status" className="text-sm text-[var(--color-ok-ink)]">
            {state.success}
          </p>
        )}

        <SubmitButton pendingLabel="Salvando…">Cadastrar serviço</SubmitButton>
      </form>
    </Card>
  )
}
