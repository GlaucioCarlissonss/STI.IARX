import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'

export const metadata: Metadata = { title: 'Sem conexão' }

/**
 * O que aparece quando a rede some.
 *
 * É a página que o service worker mostra no lugar do erro do navegador. A
 * diferença entre as duas não é estética: o dinossauro diz que a INTERNET caiu,
 * e a conclusão natural de quem o vê num sistema de trabalho é que o sistema
 * caiu. Esta diz o que aconteceu, o que continua valendo e o que fazer.
 *
 * É estática de propósito — nenhuma consulta, nenhuma sessão. Uma página que
 * precisa do servidor não serve para dizer que o servidor está inalcançável.
 */
export default function SemConexao() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-5xl" aria-hidden="true">
        ⚡
      </p>
      <h1 className="font-display text-2xl font-bold">Sem conexão</h1>
      <p className="text-[var(--color-ink-2)]">
        Este aparelho não está alcançando a rede agora. O sistema continua no ar —
        o que falta é o caminho até ele.
      </p>
      <p className="text-sm text-[var(--color-ink-3)]">
        Nada do que você digitou foi enviado. Quando a conexão voltar, abra de novo
        e refaça o último passo.
      </p>
      <Link
        href={'/portal' as Route}
        className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-white"
      >
        Tentar de novo
      </Link>
    </main>
  )
}
