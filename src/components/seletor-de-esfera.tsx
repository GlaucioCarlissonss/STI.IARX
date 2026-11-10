'use client'

import { useState } from 'react'
import { ESFERAS, ROTULO_DA_ESFERA, type Esfera } from '@/lib/esferas'
import { focarEsfera } from '@/app/(app)/esfera-actions'

/**
 * O seletor de foco — para quem tem as duas esferas.
 *
 * ## O que ele é, e o que ele não é
 *
 * Ele **encurta o menu**, e só. Não dá nem tira acesso: escolher "Locação"
 * esconde o atalho para Projetos, não o projeto — a paleta (⌘K) continua
 * achando a tela, e o endereço digitado continua abrindo. Por isso não é
 * controle de segurança e não entra na trilha de auditoria.
 *
 * ## Por que ele é cliente, se o que ele muda é servidor
 *
 * A escolha vira cookie, e quem monta o menu é o layout, no servidor. Um
 * `<form action={serverAction}>` puro faria isso sem JavaScript nenhum — e foi
 * assim que ele nasceu. O que reprovou essa versão foi medição: numa execução
 * em cada duas, a PRIMEIRA troca de foco não mudava o menu. É o mesmo sumiço de
 * transição já documentado em `docs/18` §4.1 — a revalidação que vem junto da
 * resposta da ação às vezes não é aplicada, e aí o clique não faz nada visível.
 *
 * Num seletor isso é pior do que parece: a pessoa clica, o menu não muda, e a
 * conclusão é que o controle está quebrado.
 *
 * ## Duas versões reprovadas antes desta, e o que cada uma ensinou
 *
 * A primeira era um `<form action={serverAction}>` puro, sem JavaScript. Em uma
 * execução de cada duas, a primeira troca não mudava o menu: a revalidação que
 * vem junto da resposta da ação às vezes não é aplicada (`docs/18` §4.1).
 *
 * A segunda acrescentou `useTransition` e um `router.refresh()`. Pior: quando a
 * revalidação se perdia, a transição **nunca terminava**, e os três botões
 * ficavam desabilitados para sempre.
 *
 * A terceira trocou o refresh por um `redirect()` para a mesma tela — e
 * entregou o menu ANTERIOR, atrasado em um clique: o endereço de destino é o
 * mesmo de origem, e a navegação reaproveitava a árvore que já estava ali.
 *
 * Esta quarta recarrega a página. É a única forma que não pode ser descartada
 * no caminho: o servidor lê o cookie novo porque é uma requisição nova. O preço
 * é um recarregamento inteiro num controle que se usa poucas vezes por dia — e
 * é barato perto de um seletor que às vezes não faz nada.
 */
export function SeletorDeEsfera({ atual }: { atual: Esfera | null }) {
  /* O que a pessoa escolheu, antes de o servidor confirmar: o realce muda no
     clique. Se a ação falhar, a próxima renderização do layout traz `atual` de
     volta e desfaz o realce — a tela não fica dizendo o que o banco não diz. */
  const [escolhido, setEscolhido] = useState<Esfera | null>(atual)
  const [salvando, setSalvando] = useState(false)
  const trocar = (valor: Esfera | null) => {
    setEscolhido(valor)
    setSalvando(true)
    const dados = new FormData()
    dados.set('esfera', valor ?? '')
    void focarEsfera(dados)
      /* Recarrega a MESMA tela — com filtro e gaveta abertos, porque o endereço
         não muda. Trocar o foco do menu não é motivo para perder onde se
         estava. */
      .then(() => window.location.reload())
      .catch(() => setSalvando(false))
  }

  return (
    <div
      role="group"
      aria-label="Foco do menu"
      data-testid="foco-da-esfera"
      className="hidden items-center rounded-lg border border-[var(--color-border)] p-0.5 md:flex"
    >
      <Botao
        rotulo="As duas"
        ativo={escolhido === null}
        salvando={salvando}
        aoClicar={() => trocar(null)}
      />
      {ESFERAS.map((e) => (
        <Botao
          key={e}
          rotulo={ROTULO_DA_ESFERA[e]}
          ativo={escolhido === e}
          salvando={salvando}
          aoClicar={() => trocar(e)}
        />
      ))}
    </div>
  )
}

function Botao({
  rotulo,
  ativo,
  salvando,
  aoClicar,
}: {
  rotulo: string
  ativo: boolean
  salvando: boolean
  aoClicar: () => void
}) {
  return (
    <button
      type="button"
      onClick={aoClicar}
      /* `aria-pressed`, e não `aria-current`: é um alternador de preferência,
         não a página em que se está. */
      aria-pressed={ativo}
      /* Sem `disabled`: o botão desabilitado de uma resposta que nunca chega é
         um controle morto na tela. Clicar de novo é a reação natural, e aqui
         ela funciona — a ação é idempotente. */
      aria-busy={salvando}
      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
        ativo
          ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand-ink)]'
          : 'text-[var(--color-ink-3)] hover:bg-[var(--color-surface-2)]'
      }`}
    >
      {rotulo}
    </button>
  )
}
