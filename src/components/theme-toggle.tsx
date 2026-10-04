'use client'

import { useSyncExternalStore } from 'react'

export type Tema = 'claro' | 'escuro' | 'sistema'

/** Chave do `localStorage`. */
export const TEMA_KEY = 'sti.tema'

/**
 * O script que roda antes da primeira pintura, embutido em `layout.tsx`.
 *
 * Mora aqui, e não como texto solto no layout, por um motivo prático: ele e o
 * componente abaixo precisam concordar sobre a chave do `localStorage` e sobre
 * o nome do atributo. Quando essas duas coisas moram em arquivos diferentes,
 * uma delas muda sozinha mais cedo ou mais tarde, e o sintoma é um tema que
 * "não cola" — some ao recarregar, sem erro nenhum no console.
 *
 * O `try` não é zelo: `localStorage` **lança** em janela anônima com cookies de
 * terceiros bloqueados. Sem ele, a exceção derrubaria o script inteiro antes de
 * qualquer coisa ser pintada, e a página apareceria sem tema algum.
 */
export const TEMA_INLINE_SCRIPT = `
try {
  var t = localStorage.getItem('${TEMA_KEY}');
  if (t === 'claro' || t === 'escuro') {
    document.documentElement.dataset.tema = t;
  }
} catch (e) {}
`.trim()

/*
 * O tema vive no `<html>`, não no estado do React — foi escrito lá pelo script
 * acima, antes de qualquer componente existir. `useSyncExternalStore` é como se
 * lê uma fonte externa dessas sem copiá-la para dentro de um `useState` num
 * efeito: a cópia abriria a janela em que as duas discordam, e o React 19
 * proíbe a construção justamente por isso.
 */
const ouvintes = new Set<() => void>()

function inscrever(aviso: () => void) {
  ouvintes.add(aviso)
  return () => {
    ouvintes.delete(aviso)
  }
}

function lerDoDocumento(): Tema {
  const t = document.documentElement.dataset.tema
  return t === 'claro' || t === 'escuro' ? t : 'sistema'
}

/**
 * O que o servidor renderiza — e o que a hidratação usa.
 *
 * O servidor não tem como saber o que está no `localStorage` de quem abriu a
 * página. "Sistema" é a resposta honesta: é o padrão e o estado de quem nunca
 * escolheu. Logo após hidratar, o valor real entra no lugar.
 */
function lerNoServidor(): Tema {
  return 'sistema'
}

function aplicar(tema: Tema) {
  const raiz = document.documentElement
  if (tema === 'sistema') delete raiz.dataset.tema
  else raiz.dataset.tema = tema
  try {
    if (tema === 'sistema') localStorage.removeItem(TEMA_KEY)
    else localStorage.setItem(TEMA_KEY, tema)
  } catch {
    /* Janela anônima: o tema vale para esta sessão e não é lembrado. */
  }
  for (const aviso of ouvintes) aviso()
}

const OPCOES: { valor: Tema; simbolo: string; titulo: string }[] = [
  { valor: 'claro', simbolo: '☀', titulo: 'Tema claro' },
  { valor: 'escuro', simbolo: '☾', titulo: 'Tema escuro' },
  { valor: 'sistema', simbolo: '◐', titulo: 'Seguir o sistema' },
]

/**
 * Três estados, não dois.
 *
 * Um interruptor de duas posições obriga a escolher, e a escolha que a maioria
 * quer é "o que o meu sistema operacional já decidiu" — que num botão de duas
 * posições simplesmente não existe. "Sistema" é o padrão.
 *
 * É `radiogroup`, e não três botões soltos: para o leitor de tela isto é UMA
 * pergunta com três respostas, e a seta do teclado percorre as opções em vez de
 * exigir três tabulações.
 */
export function ThemeToggle() {
  const tema = useSyncExternalStore(inscrever, lerDoDocumento, lerNoServidor)

  return (
    <div
      role="radiogroup"
      aria-label="Tema da interface"
      className="hidden items-center gap-0.5 rounded-lg border border-[var(--color-border)] p-0.5 sm:flex"
    >
      {OPCOES.map((o) => {
        const ativo = tema === o.valor
        return (
          <button
            key={o.valor}
            type="button"
            role="radio"
            aria-checked={ativo}
            title={o.titulo}
            onClick={() => aplicar(o.valor)}
            className={`grid size-7 place-items-center rounded-md text-sm leading-none ${
              ativo
                ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand-ink)]'
                : 'text-[var(--color-ink-3)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink-2)]'
            }`}
          >
            <span aria-hidden="true">{o.simbolo}</span>
            <span className="sr-only">{o.titulo}</span>
          </button>
        )
      })}
    </div>
  )
}
