'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { ErrorNote } from '@/components/ui'
import { arquivarArtigo } from '../actions'

/**
 * Arquivar, e não apagar.
 *
 * O artigo sai da busca e continua existindo para quem escreve. Uma resposta que
 * deixou de valer ainda diz o que já se soube — e "por que isto mudou?" é uma
 * pergunta que precisa da versão anterior para ser respondida.
 */
export function ArquivarArtigo({ articleId }: { articleId: string }) {
  const [state, action] = useActionState(arquivarArtigo, {})

  if (state.success) {
    return <span className="text-sm text-[var(--color-ok-ink)]">arquivado</span>
  }

  return (
    <div>
      <form action={action}>
        <input type="hidden" name="article_id" value={articleId} />
        <SubmitButton variant="secondary" pendingLabel="Arquivando…">
          Arquivar
        </SubmitButton>
      </form>
      {state.error && <ErrorNote>{state.error}</ErrorNote>}
    </div>
  )
}
