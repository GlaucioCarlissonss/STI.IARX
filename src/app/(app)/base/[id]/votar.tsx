'use client'

import { useActionState, useState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { ErrorNote, inputClass } from '@/components/ui'
import { votarNoArtigo } from '../actions'

/**
 * "Isto resolveu o seu problema?"
 *
 * ## Por que o comentário só aparece no "não"
 *
 * Quem clicou em "sim" já respondeu tudo que interessa e vai embora — pedir um
 * comentário ali é um campo em branco que ninguém preenche e que, por estar na
 * tela, faz o "sim" parecer mais trabalhoso do que é.
 *
 * O "não" é diferente: ele é a lista de tarefas de quem mantém a base, e sem o
 * comentário é só um número. "Não ajudou" não diz se o artigo está errado, se
 * está incompleto ou se a pessoa procurava outra coisa — e as três exigem
 * correções diferentes.
 */
export function VotarNoArtigo({
  articleId,
  jaVotou,
}: {
  articleId: string
  jaVotou: 'sim' | 'nao' | null
}) {
  const [state, action] = useActionState(votarNoArtigo, {})
  const [mostrarComentario, setMostrarComentario] = useState(false)

  if (state.success) {
    return (
      <p role="status" className="text-sm text-[var(--color-ok-ink)]">
        {state.success}
      </p>
    )
  }

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="article_id" value={articleId} />

      {jaVotou && !mostrarComentario && (
        <p className="text-sm text-[var(--color-ink-2)]">
          Você já respondeu <strong>{jaVotou === 'sim' ? 'que ajudou' : 'que não ajudou'}</strong>.
          Pode mudar de ideia abaixo.
        </p>
      )}

      {mostrarComentario ? (
        <>
          <label htmlFor="comentario" className="text-sm text-[var(--color-ink-2)]">
            O que faltou? (opcional, mas é o que permite corrigir)
          </label>
          <textarea
            id="comentario"
            name="comentario"
            rows={3}
            maxLength={1000}
            className={inputClass}
            placeholder="O passo 3 não existe mais na versão nova do sistema."
          />
          <input type="hidden" name="util" value="nao" />
          <div className="flex gap-2">
            <SubmitButton pendingLabel="Enviando…">Enviar</SubmitButton>
            <button
              type="button"
              onClick={() => setMostrarComentario(false)}
              className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)]"
            >
              Voltar
            </button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          <SubmitButton pendingLabel="Enviando…">Sim, resolveu</SubmitButton>
          <input type="hidden" name="util" value="sim" />
          <button
            type="button"
            onClick={() => setMostrarComentario(true)}
            className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
          >
            Não resolveu
          </button>
        </div>
      )}

      {state.error && <ErrorNote>{state.error}</ErrorNote>}
    </form>
  )
}
