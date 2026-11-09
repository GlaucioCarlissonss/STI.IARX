'use client'

import { useState, useTransition } from 'react'
import type { ActionState } from '@/lib/actions/estado'
import { assignTicket, changeStatus } from '@/app/(app)/tickets/actions'
import { avisar } from './avisos'

/**
 * Trocar status ou atendente sem sair da lista.
 *
 * ## Resposta imediata, com volta honesta
 *
 * O valor novo aparece na hora, antes de o servidor responder. Isso não é
 * enfeite: esperar meio segundo olhando para o valor VELHO faz a pessoa clicar
 * de novo, e dois cliques num seletor de status é como se muda o chamado duas
 * vezes.
 *
 * O que normalmente vem junto com interface otimista é o defeito oposto —
 * mostrar "salvo" quando não salvou. Aqui não pode acontecer, porque a máquina
 * de estados vive no banco (ADR-007) e a permissão é conferida no servidor: se
 * a transição for proibida ou a chave faltar, **o valor volta ao que era** e a
 * mensagem diz o motivo, no lugar onde a pessoa está olhando.
 *
 * ## Quem não pode editar vê TEXTO
 *
 * Não um seletor desabilitado. Controle inerte não explica nada, rouba uma
 * parada de tabulação e ainda anuncia "indisponível" no leitor de tela — três
 * incômodos para informar zero. Quem não tem a permissão simplesmente lê o
 * valor, como sempre leu.
 */

export interface OpcaoDeEdicao {
  valor: string
  rotulo: string
}

export function EdicaoNaLinha({
  ticketId,
  campo,
  valor,
  opcoes,
  rotulo,
  podeEditar,
  children,
}: {
  ticketId: string
  campo: 'status' | 'atendente'
  /** O valor atual, como ele chega do servidor. */
  valor: string
  opcoes: OpcaoDeEdicao[]
  /** Nome do campo para leitor de tela ("Status do chamado 5"). */
  rotulo: string
  podeEditar: boolean
  /** Como o valor aparece quando não há edição (a pílula, o nome). */
  children: React.ReactNode
}) {
  const [escolhido, setEscolhido] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [pendente, iniciar] = useTransition()

  if (!podeEditar) return <>{children}</>

  const atual = escolhido ?? valor

  function mudar(novo: string) {
    if (novo === atual) return
    const antes = atual
    setErro(null)
    setEscolhido(novo)

    iniciar(async () => {
      const dados = new FormData()
      dados.set('ticket_id', ticketId)
      let r: ActionState
      if (campo === 'status') {
        dados.set('status', novo)
        r = await changeStatus({}, dados)
      } else {
        dados.set('assignee_id', novo)
        r = await assignTicket({}, dados)
      }
      /* Recusou: desfaz na tela o que não aconteceu no banco. */
      if (r.error) {
        setEscolhido(antes === valor ? null : antes)
        setErro(r.error)
        return
      }

      /*
       * Deu certo e a linha já mostra o novo valor — mas isso não basta: uma
       * troca de status pode tirar o chamado do filtro atual, e aí a linha
       * some. Sem aviso, o que a pessoa vê é um registro desaparecendo.
       *
       * O "desfazer" existe só para atribuição: voltar um atendente é sempre
       * possível, enquanto voltar um status depende da máquina de estados do
       * banco — oferecer um desfazer que pode ser recusado seria pior do que
       * não oferecer.
       */
      const rotulo = opcoes.find((o) => o.valor === novo)?.rotulo ?? novo
      avisar({
        tipo: 'ok',
        texto: campo === 'status' ? `Status: ${rotulo}.` : `Atendente: ${rotulo}.`,
        desfazer:
          campo === 'atendente'
            ? { rotulo: 'desfazer', aoClicar: () => mudar(antes) }
            : undefined,
      })
    })
  }

  return (
    <span className="relative inline-flex max-w-full items-center">
      {/* Enquanto o valor é o do servidor, mostra o que a lista desenharia (a
          pílula de status, o nome do atendente). Assim que a pessoa escolhe
          outro, mostra o novo rótulo — é essa troca que faz a tela responder
          antes da rede. */}
      <span className={pendente ? 'opacity-60' : undefined}>
        {atual === valor ? children : <ValorEscolhido opcoes={opcoes} valor={atual} />}
      </span>

      <span aria-hidden="true" className="ml-1 text-[0.6rem] text-[var(--color-ink-3)]">
        ⌄
      </span>

      {/* O `<select>` nativo por cima do valor: no celular abre o seletor do
          próprio aparelho — maior, rola com o polegar, já conhecido — e no
          computador continua sendo um controle de formulário de verdade, com
          teclado e leitor de tela de graça. */}
      <select
        value={atual}
        disabled={pendente}
        aria-label={rotulo}
        data-testid={`editar-${campo}`}
        onChange={(e) => mudar(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {opcoes.map((o) => (
          <option key={o.valor || 'vazio'} value={o.valor}>
            {o.rotulo}
          </option>
        ))}
      </select>

      {erro && (
        <span
          role="alert"
          data-testid="erro-edicao"
          className="absolute left-0 top-full z-20 mt-1 w-64 rounded-lg bg-[var(--color-breach-soft)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-breach-ink)] shadow-lg"
        >
          {erro}
        </span>
      )}
    </span>
  )
}

/** O rótulo do valor escolhido enquanto o servidor ainda não confirmou. */
function ValorEscolhido({ opcoes, valor }: { opcoes: OpcaoDeEdicao[]; valor: string }) {
  const op = opcoes.find((o) => o.valor === valor)
  return (
    <span className="text-sm font-medium text-[var(--color-ink)]">{op?.rotulo ?? '—'}</span>
  )
}
