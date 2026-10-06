'use client'

import Link from 'next/link'
import { useEffect } from 'react'

/**
 * A tela quando uma página da aplicação falha.
 *
 * ## A regra que decide o que aparece aqui
 *
 * **Nada de detalhe técnico interno.** `error.message` numa falha de banco traz
 * nome de tabela, nome de coluna, às vezes o SQL — para quem está tentando
 * lançar um título isso não ajuda em nada, e para quem não deveria conhecer o
 * esquema é informação de graça. O que aparece é o que a pessoa pode fazer.
 *
 * O `digest` fica, e fica à vista: é o identificador que o Next gera para a
 * falha e repete no log do servidor. É a única coisa aqui que serve ao suporte —
 * e serve justamente por não dizer nada sozinho.
 *
 * ## Dois caminhos de saída, não um
 *
 * "Tentar de novo" resolve a falha passageira — a consulta que estourou o tempo,
 * a rede que caiu por um segundo. Quando não resolve, insistir no mesmo botão é
 * o único caminho que resta e a pessoa fica presa numa tela de erro. Por isso o
 * link para a Visão geral está ao lado desde o começo.
 *
 * ## O que este limite NÃO pega
 *
 * `redirect()` e `notFound()` não são falhas: o Next as resolve antes de chegar
 * aqui. É o que faz a negação de permissão (`requireScreen`) continuar levando a
 * pessoa para uma tela que ela alcança, em vez de mostrar "algo deu errado". E
 * uma falha no próprio layout passa reto, porque o limite vive dentro dele —
 * esse caso é de `src/app/global-error.tsx`.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // O console do navegador é o único lugar onde a mensagem crua ainda tem uso:
    // quem o abre está depurando, não tentando trabalhar.
    console.error(error)
  }, [error])

  return (
    <div className="mx-auto max-w-xl py-10">
      <div
        role="alert"
        className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center shadow-[var(--shadow-card)] sm:p-8"
      >
        <h1 className="text-xl font-bold text-[var(--color-ink)]">Esta tela não carregou</h1>
        <p className="mt-2 text-sm text-[var(--color-ink-2)]">
          A falha foi registrada. Nada do que você estava vendo foi alterado — nenhum dado é
          gravado ao abrir uma tela.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
          >
            Tentar de novo
          </button>
          <Link
            href="/painel"
            className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
          >
            Ir para a Visão geral
          </Link>
        </div>

        {error.digest && (
          <p className="mt-6 text-xs text-[var(--color-ink-3)]">
            Se precisar abrir um chamado, informe este código:{' '}
            <span className="font-mono text-[var(--color-ink-2)]">{error.digest}</span>
          </p>
        )}
      </div>
    </div>
  )
}
