import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { FormularioDeAvaliacao } from './avaliar-form'

export const metadata: Metadata = {
  title: 'Avaliar atendimento',
  robots: { index: false, follow: false },
}

interface Convite {
  ticket_number: number
  ticket_title: string
  already_answered: boolean
  expired: boolean
}

/**
 * A pesquisa de satisfação, respondida SEM LOGIN.
 *
 * Quem responde é quem abriu o chamado, e muitas vezes essa pessoa não tem conta
 * no sistema: é o funcionário da empresa-cliente que ligou para o suporte.
 * Exigir login aqui derrubaria a taxa de resposta a quase zero, que é o mesmo
 * que não ter a pesquisa.
 *
 * O escopo vem do token do endereço, e quem o resolve é
 * `public.satisfaction_invite` — uma função `security definer` que aceita só o
 * token e devolve só o número do chamado, o título e dois booleanos. Nenhuma
 * chave de serviço entra aqui.
 *
 * ## Por que todo caminho mostra a mesma moldura
 *
 * Token inválido, já respondido e expirado chegam a telas diferentes **em
 * texto**, mas nenhuma delas confirma se o token existe. "Este link não é
 * válido" cobre o inexistente e o adulterado com a mesma frase: distinguir os
 * dois entregaria a quem estivesse tentando adivinhar a informação de que
 * chegou perto.
 */
export default async function AvaliarPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const supabase = await createClient()

  const { data } = await supabase.rpc('satisfaction_invite', { p_token: token })
  const convite = (data as Convite[] | null)?.[0] ?? null

  return (
    <div className="grid min-h-screen place-items-center px-6 py-12">
      <div className="w-full max-w-md text-center">
        <p className="fonte-display text-2xl font-bold text-[var(--color-brand)]">STI</p>

        {!convite ? (
          <Aviso
            titulo="Este link não é válido"
            texto="Ele pode ter sido digitado errado ou pertencer a um atendimento removido."
          />
        ) : convite.already_answered ? (
          <Aviso
            titulo="Você já respondeu"
            texto="Obrigado — a sua avaliação deste atendimento já foi registrada."
          />
        ) : convite.expired ? (
          <Aviso
            titulo="O prazo para avaliar terminou"
            texto="O link vale por 30 dias. Avaliação de um atendimento de meses atrás mede memória, não atendimento."
          />
        ) : (
          <>
            <h1 className="mt-6 text-xl font-bold text-[var(--color-ink)]">
              Como foi o atendimento?
            </h1>
            <p className="mt-2 text-sm text-[var(--color-ink-2)]">
              Chamado #{convite.ticket_number} — {convite.ticket_title}
            </p>
            <FormularioDeAvaliacao token={token} />
          </>
        )}
      </div>
    </div>
  )
}

function Aviso({ titulo, texto }: { titulo: string; texto: string }) {
  return (
    <>
      <h1 className="mt-6 text-xl font-bold text-[var(--color-ink)]">{titulo}</h1>
      <p className="mt-2 text-sm text-[var(--color-ink-2)]">{texto}</p>
    </>
  )
}
