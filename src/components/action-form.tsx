'use client'

import { useActionState, useRef, type ReactNode } from 'react'
import { useFormStatus } from 'react-dom'
import type { ActionState } from '@/lib/actions/estado'
import { ErrorNote } from './ui'
import { avisar } from './avisos'

/**
 * Formulário ligado a uma Server Action, com feedback de erro/sucesso.
 *
 * Centraliza o `useActionState` para que cada tela não repita o mesmo boilerplate
 * de pending/erro — e para que a mensagem de retorno tenha sempre o mesmo
 * tratamento acessível (`role="alert"` / `role="status"`).
 */
export function ActionForm({
  action,
  children,
  className = '',
  /** Formulário de edição que não deve voltar aos valores iniciais ao salvar. */
  manterCampos = false,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>
  children: ReactNode
  className?: string
  manterCampos?: boolean
}) {
  const formRef = useRef<HTMLFormElement>(null)

  /*
   * O aviso e a limpeza acontecem AQUI, logo depois que a ação responde — não
   * num efeito que lê o estado depois.
   *
   * A diferença é o caso em que a ação funciona bem demais: ela revalida, o
   * servidor manda a árvore nova, e o formulário que disparou tudo pode deixar
   * de existir nesse mesmo instante (uma lista que esvazia, uma gaveta que
   * troca de conteúdo). Um efeito agendado nesse componente simplesmente não
   * roda, e a confirmação some justamente quando a escrita deu certo — foi o
   * defeito medido que originou esta fase, e ele voltou uma vez por este
   * caminho.
   *
   * Envolvendo a ação, o aviso é publicado numa loja de módulo que não depende
   * de árvore nenhuma, antes de qualquer re-renderização.
   *
   * Limpar o campo importa tanto quanto avisar: campo ainda cheio depois de
   * publicar é a pista mais forte de que "não foi", e é o que leva ao segundo
   * clique e ao comentário duplicado no chamado do cliente.
   */
  const comAviso = async (anterior: ActionState, dados: FormData): Promise<ActionState> => {
    const r = await action(anterior, dados)
    if (r.success) {
      avisar({ tipo: 'ok', texto: r.success })
      if (!manterCampos) formRef.current?.reset()
    }
    return r
  }

  const [state, formAction] = useActionState<ActionState, FormData>(comAviso, {})

  return (
    <form ref={formRef} action={formAction} className={className}>
      {children}
      {/* O ERRO continua aqui, ao lado do campo que o causou — "escreva um
          comentário" não faz sentido flutuando no rodapé da tela. Quem vai
          para a região de avisos é a confirmação, que é o que sumia. */}
      {state.error && (
        <div className="mt-3">
          <ErrorNote>{state.error}</ErrorNote>
        </div>
      )}
    </form>
  )
}

export function SubmitButton({
  children,
  variant = 'primary',
  pendingLabel = 'Salvando…',
}: {
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'danger'
  pendingLabel?: string
}) {
  const { pending } = useFormStatus()

  const variants = {
    primary: 'bg-[var(--color-brand)] text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]',
    secondary:
      'border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]',
    danger: 'bg-[var(--color-danger-solid)] text-[var(--color-on-solid)] hover:opacity-90',
  }

  return (
    <button
      type="submit"
      disabled={pending}
      className={`inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]}`}
    >
      {pending ? pendingLabel : children}
    </button>
  )
}
