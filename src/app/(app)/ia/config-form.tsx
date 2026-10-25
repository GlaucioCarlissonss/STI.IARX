'use client'

import { useActionState, useState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { Card, ErrorNote, Field, inputClass } from '@/components/ui'
import { salvarConfigDeIA } from './actions'

export interface ConfigNaTela {
  enabled: boolean
  model: string
  effort: string
  secret_ref: string | null
  sugerir_resposta: boolean
  sugerir_triagem: boolean
  redigir_artigo: boolean
  enviar_notas_internas: boolean
  limite_mensal_dolares: number
}

const PADRAO: ConfigNaTela = {
  enabled: false,
  model: 'claude-opus-5-5',
  effort: 'medium',
  secret_ref: null,
  sugerir_resposta: true,
  sugerir_triagem: true,
  redigir_artigo: true,
  /* Desligado por padrão, e é a única opção do formulário que começa desligada:
     a nota interna é onde se escreve o que não se diz ao cliente. */
  enviar_notas_internas: false,
  limite_mensal_dolares: 50,
}

export function ConfigForm({
  config,
  podeGerenciar,
  modelos,
}: {
  config: ConfigNaTela | null
  podeGerenciar: boolean
  modelos: string[]
}) {
  const [state, formAction] = useActionState(salvarConfigDeIA, {})
  const atual = config ?? PADRAO
  const [ligada, setLigada] = useState(atual.enabled)
  const [notas, setNotas] = useState(atual.enviar_notas_internas)

  if (!podeGerenciar) {
    return (
      <Card title="Configuração">
        <p className="text-sm text-[var(--color-ink-2)]">
          A IA está <strong>{atual.enabled ? 'ligada' : 'desligada'}</strong>
          {atual.enabled && ` com o modelo ${atual.model}`}. Só quem administra o ambiente pode
          alterar isso.
        </p>
      </Card>
    )
  }

  return (
    <Card title="Configuração">
      <form action={formAction} className="flex flex-col gap-4">
        <label className="flex items-start gap-2.5 text-sm text-[var(--color-ink)]">
          <input
            type="checkbox"
            name="enabled"
            checked={ligada}
            onChange={(e) => setLigada(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Ligar as sugestões de IA
            <span className="block text-xs text-[var(--color-ink-3)]">
              Desligada, nada é enviado a provedor nenhum e o painel do chamado diz isso. A base de
              conhecimento continua sugerindo artigos, como sempre fez.
            </span>
          </span>
        </label>

        <Field
          label="Variável de ambiente com a chave"
          htmlFor="secret_ref"
          hint="O NOME da variável, nunca a chave. Ela precisa existir no servidor — o formulário confere antes de deixar ligar."
          required={ligada}
        >
          <input
            id="secret_ref"
            name="secret_ref"
            defaultValue={atual.secret_ref ?? ''}
            required={ligada}
            pattern="[A-Z][A-Z0-9_]{2,60}"
            className={`${inputClass} font-mono`}
            placeholder="ANTHROPIC_API_KEY"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Modelo" htmlFor="model" hint="Preço por token muda muito entre eles.">
            <input
              id="model"
              name="model"
              defaultValue={atual.model}
              list="modelos-conhecidos"
              required
              className={`${inputClass} font-mono`}
            />
          </Field>
          {/* Lista de sugestões, e não `select`: modelo novo sai sem avisar, e um
              `select` fechado obrigaria a esperar uma versão do sistema para usá-lo.
              O preço de um modelo fora da lista é estimado pelo mais caro conhecido,
              que é o erro seguro. */}
          <datalist id="modelos-conhecidos">
            {modelos.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>

          <Field
            label="Esforço"
            htmlFor="effort"
            hint="Mais esforço custa mais e demora mais. Para triagem, o baixo basta."
          >
            <select id="effort" name="effort" defaultValue={atual.effort} className={inputClass}>
              <option value="low">Baixo</option>
              <option value="medium">Médio</option>
              <option value="high">Alto</option>
            </select>
          </Field>

          <Field
            label="Teto do mês (US$)"
            htmlFor="limite_mensal_dolares"
            hint="Atingido o teto, o painel volta ao caminho sem IA e diz o motivo."
          >
            <input
              id="limite_mensal_dolares"
              name="limite_mensal_dolares"
              type="number"
              min={0}
              max={1000000}
              defaultValue={atual.limite_mensal_dolares}
              required
              className={inputClass}
            />
          </Field>
        </div>

        <fieldset className="rounded-lg border border-[var(--color-border)] p-3.5">
          <legend className="px-1 text-sm font-semibold text-[var(--color-ink)]">
            Quais recursos
          </legend>
          <div className="flex flex-col gap-2">
            {(
              [
                ['sugerir_resposta', 'Resposta sugerida', atual.sugerir_resposta,
                 'O rascunho da próxima resposta ao cliente. É o único que pode acabar na frente dele — e por isso vai para a caixa de comentário, não para o envio.'],
                ['sugerir_triagem', 'Classificação sugerida', atual.sugerir_triagem,
                 'Categoria e prioridade. Aplicar é um clique de quem atende, e fica no histórico com o nome dessa pessoa.'],
                ['redigir_artigo', 'Rascunho de artigo', atual.redigir_artigo,
                 'A partir de chamado resolvido. Alguém revisa e publica.'],
              ] as const
            ).map(([nome, rotulo, padrao, explicacao]) => (
              <label key={nome} className="flex items-start gap-2.5 text-sm text-[var(--color-ink)]">
                <input type="checkbox" name={nome} defaultChecked={padrao} className="mt-0.5" />
                <span>
                  {rotulo}
                  <span className="block text-xs text-[var(--color-ink-3)]">{explicacao}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="flex items-start gap-2.5 text-sm text-[var(--color-ink)]">
          <input
            type="checkbox"
            name="enviar_notas_internas"
            checked={notas}
            onChange={(e) => setNotas(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Enviar também as notas internas
            <span className="block text-xs text-[var(--color-ink-3)]">
              Melhora a sugestão e é uma decisão sobre dado sensível: a nota interna é onde se
              escreve o que não se diz ao cliente.
            </span>
          </span>
        </label>

        {notas && (
          <p
            role="status"
            className="rounded-lg border border-[var(--color-warn-ink)]/30 bg-[var(--color-warn-soft)] p-3 text-sm text-[var(--color-warn-ink)]"
          >
            Com isto ligado, o conteúdo das notas internas de cada chamado sai deste servidor a cada
            sugestão pedida. Ligue se a sua política de dados permitir.
          </p>
        )}

        {state.error && <ErrorNote>{state.error}</ErrorNote>}
        {state.success && (
          <p role="status" className="text-sm text-[var(--color-ok-ink)]">
            {state.success}
          </p>
        )}

        <SubmitButton pendingLabel="Salvando…">Salvar configuração</SubmitButton>
      </form>
    </Card>
  )
}
