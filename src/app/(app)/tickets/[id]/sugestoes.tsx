import Link from 'next/link'
import type { Route } from 'next'
import { Card } from '@/components/ui'

export interface Sugestao {
  id: string
  title: string
  resumo: string | null
  relevancia: number
}

/**
 * Os dois lados do ciclo da base de conhecimento, numa faixa só.
 *
 * **Entrando:** artigos que podem resolver este chamado. É o retorno do
 * investimento — o artigo escrito a partir de um chamado volta a aparecer no
 * chamado seguinte parecido.
 *
 * **Saindo:** o botão que transforma este chamado em artigo. Ele só aparece
 * quando o chamado está resolvido ou encerrado, e é deliberado: um artigo
 * escrito no meio do atendimento descreve uma hipótese, não uma solução.
 *
 * O componente some inteiro quando não há nem sugestão nem botão — uma faixa
 * vazia em todo chamado seria ruído permanente em troca de nada.
 */
export function SugestoesDaBase({
  sugestoes,
  ticketId,
  podeEscrever,
  artigoDoChamado,
  resolvido,
}: {
  sugestoes: Sugestao[]
  ticketId: string
  podeEscrever: boolean
  artigoDoChamado: { id: string; title: string } | null
  resolvido: boolean
}) {
  const mostraBotao = podeEscrever && resolvido && !artigoDoChamado
  if (sugestoes.length === 0 && !mostraBotao && !artigoDoChamado) return null

  return (
    <Card title="Base de conhecimento" className="mb-6">
      {sugestoes.length > 0 && (
        <>
          <p className="mb-2 text-sm text-[var(--color-ink-2)]">
            Artigos que podem resolver este chamado:
          </p>
          <ul className="flex flex-col gap-1.5">
            {sugestoes.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/base/${s.id}` as Route}
                  className="text-sm font-medium text-[var(--color-brand-ink)] hover:underline"
                >
                  {s.title}
                </Link>
                {s.resumo && <p className="text-xs text-[var(--color-ink-3)]">{s.resumo}</p>}
              </li>
            ))}
          </ul>
        </>
      )}

      {artigoDoChamado && (
        <p className={sugestoes.length > 0 ? 'mt-4 text-sm' : 'text-sm'}>
          <span className="text-[var(--color-ink-2)]">Este chamado já virou artigo: </span>
          <Link
            href={`/base/${artigoDoChamado.id}` as Route}
            className="font-medium text-[var(--color-brand-ink)] hover:underline"
          >
            {artigoDoChamado.title}
          </Link>
        </p>
      )}

      {mostraBotao && (
        <div className={sugestoes.length > 0 ? 'mt-4' : ''}>
          <Link
            href={`/base/novo?chamado=${ticketId}` as Route}
            className="inline-block rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
          >
            Virar artigo
          </Link>
          <p className="mt-2 text-xs text-[var(--color-ink-3)]">
            O título, o problema e a solução vêm preenchidos deste chamado. É o único momento em
            que escrever custa pouco — depois, o assunto já saiu da sua cabeça.
          </p>
        </div>
      )}
    </Card>
  )
}
