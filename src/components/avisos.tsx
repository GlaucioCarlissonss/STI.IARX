'use client'

import { useSyncExternalStore } from 'react'

/**
 * Os avisos da aplicação — e por que eles não podem morar no formulário.
 *
 * ## O defeito que isto corrige
 *
 * Medido, não suposto: publicar um comentário gravava no banco, e a tela não
 * dizia nada. A confirmação nunca aparecia, o texto continuava no campo e a
 * conversa não mudava. Da cadeira de quem atende isso é indistinguível de
 * "não funcionou" — e a reação natural é clicar de novo, o que põe dois
 * comentários iguais no chamado do cliente.
 *
 * A causa: a mensagem vivia dentro do componente do formulário, e a
 * revalidação disparada pela própria ação recria esse componente. O estado de
 * `useActionState` vai junto. Ou seja, quanto mais a ação acerta em atualizar
 * a tela, mais certo é que a confirmação dela some.
 *
 * As 87 mensagens de sucesso que as ações devolvem passam por aqui.
 *
 * ## Por que uma loja de módulo, e não contexto
 *
 * Porque quem precisa avisar não está numa árvore só: formulário, edição na
 * linha, barra de lote, gaveta. Um contexto obrigaria todos eles a estarem
 * dentro de um provedor comum — e o provedor teria que viver acima da parte da
 * árvore que a revalidação recria, que é exatamente a restrição que causou o
 * defeito. Uma loja de módulo não tem árvore: `avisar()` funciona de qualquer
 * lugar, e a região que desenha é um componente só, no layout.
 */

export interface Aviso {
  id: number
  tipo: 'ok' | 'erro'
  texto: string
  /** Rótulo e ação do "desfazer", quando a operação é reversível. */
  desfazer?: { rotulo: string; aoClicar: () => void }
}

let lista: Aviso[] = []
let proximoId = 1
const ouvintes = new Set<() => void>()

function publicar() {
  for (const o of ouvintes) o()
}

/** Quanto tempo a confirmação fica. O erro NÃO sai sozinho — ver `avisar`. */
const SEGUNDOS = 5

/**
 * Mostra um aviso.
 *
 * Confirmação some sozinha; **erro fica até alguém fechar**. Mensagem de erro
 * que desaparece sozinha é mensagem que ninguém leu — e erro é justamente o
 * que precisa ser lido, porque quase sempre explica o que fazer em seguida.
 */
export function avisar(aviso: Omit<Aviso, 'id'>): number {
  const id = proximoId++
  lista = [...lista, { ...aviso, id }]
  publicar()
  if (aviso.tipo === 'ok') {
    setTimeout(() => dispensar(id), SEGUNDOS * 1000)
  }
  return id
}

export function dispensar(id: number) {
  lista = lista.filter((a) => a.id !== id)
  publicar()
}

function assinar(aoMudar: () => void) {
  ouvintes.add(aoMudar)
  return () => {
    ouvintes.delete(aoMudar)
  }
}

const ler = () => lista
const lerNoServidor = (): Aviso[] => VAZIO

/* A MESMA referência sempre: `useSyncExternalStore` compara por identidade, e
   um array novo a cada leitura do servidor derruba a renderização em laço. */
const VAZIO: Aviso[] = []

/**
 * A região que desenha os avisos. Fica no layout, uma vez só.
 *
 * `aria-live="polite"` anuncia sem interromper o que a pessoa estiver ouvindo;
 * o erro usa `role="alert"`, que interrompe — porque erro é o caso em que
 * interromper é o certo.
 */
export function RegiaoDeAvisos() {
  const avisos = useSyncExternalStore(assinar, ler, lerNoServidor)

  return (
    <div
      aria-live="polite"
      data-testid="avisos"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
    >
      {avisos.map((a) => (
        <div
          key={a.id}
          role={a.tipo === 'erro' ? 'alert' : 'status'}
          data-testid={a.tipo === 'erro' ? 'aviso-erro' : 'aviso-ok'}
          className={`pointer-events-auto flex max-w-xl items-center gap-3 rounded-xl px-4 py-2.5 text-sm font-medium shadow-lg ${
            a.tipo === 'erro'
              ? 'bg-[var(--color-danger-solid)] text-[var(--color-on-solid)]'
              : 'bg-[var(--color-ink)] text-[var(--color-surface)]'
          }`}
        >
          <span aria-hidden="true">{a.tipo === 'erro' ? '!' : '✓'}</span>
          <span>{a.texto}</span>

          {a.desfazer && (
            <button
              type="button"
              data-testid="desfazer"
              onClick={() => {
                dispensar(a.id)
                a.desfazer?.aoClicar()
              }}
              className="ml-1 shrink-0 underline underline-offset-2 opacity-90 hover:opacity-100"
            >
              {a.desfazer.rotulo}
            </button>
          )}

          <button
            type="button"
            aria-label="Fechar o aviso"
            onClick={() => dispensar(a.id)}
            className="ml-auto shrink-0 opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
