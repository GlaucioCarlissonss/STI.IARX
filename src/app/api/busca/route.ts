import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { ticketStatusLabel } from '@/lib/i18n'
import type { TicketStatus } from '@/lib/types'

/**
 * A busca global — a caixa única da paleta de comandos.
 *
 * ## Por que uma rota, e não uma Server Action
 *
 * Porque ela é chamada **a cada tecla** (com atraso), e Server Action é uma
 * requisição POST que invalida cache de rota e dispara re-render do Next. Para
 * leitura por digitação isso é peso sem retorno: um `GET` com `fetch` cancelável
 * é o que a paleta precisa, e cancelar importa — sem isso a resposta da terceira
 * letra pode chegar depois da quinta e sobrescrever o resultado certo pelo
 * errado.
 *
 * ## Por que o cliente de SESSÃO, e não o de serviço
 *
 * Porque é ele que carrega o RLS. Esta rota não filtra por tenant em lugar
 * nenhum do código: quem recorta é a policy, com `app.current_tenant_id()`
 * derivado do cookie. Não existe parâmetro de tenant para alguém falsificar, e
 * um defeito aqui não vira acesso à base inteira.
 *
 * O escopo por cliente (quem só enxerga um grupo econômico) vem pelo mesmo
 * caminho, porque é policy também.
 *
 * ## Por que cada tipo é conferido por permissão
 *
 * O RLS impede LER o que não é do tenant, mas não é ele que decide se este
 * perfil pode ver inventário. Isso é permissão granular — a mesma chave que
 * governa a tela. Sem esta conferência, a busca viraria a porta dos fundos de
 * telas que a pessoa não alcança pelo menu.
 */

export const dynamic = 'force-dynamic'

/** Menos que isso casa com tudo e devolve ruído. */
const MINIMO = 2
const POR_TIPO = 5

export interface ResultadoDeBusca {
  tipo: 'ticket' | 'ativo' | 'cliente'
  titulo: string
  detalhe: string
  href: string
}

/** `%` e `_` são curingas no `ilike`: escapados, buscam a si mesmos. */
function paraIlike(termo: string): string {
  return `%${termo.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

export async function GET(request: Request) {
  const termo = (new URL(request.url).searchParams.get('q') ?? '').trim()
  /* Um dígito já é busca válida: "5" é o chamado #5, e é assim que as pessoas
     se referem a ele. Uma LETRA não é — casaria com quase tudo e devolveria
     ruído no lugar de resposta. */
  const soDigitos = /^\d+$/.test(termo)
  if (termo.length < (soDigitos ? 1 : MINIMO)) {
    return NextResponse.json({ resultados: [] })
  }

  const supabase = await createClient()
  const padrao = paraIlike(termo)
  const resultados: ResultadoDeBusca[] = []

  const [podeTickets, podeAtivos, podeClientes] = await Promise.all([
    allowed('helpdesk.tickets.ver'),
    allowed('inventario.ativos.ver'),
    allowed('clientes.grupos.ver'),
  ])

  /* Número puro procura pelo NÚMERO do chamado; texto procura no título. */
  if (podeTickets) {
    let consulta = supabase
      .from('tickets')
      .select('id, ticket_number, title, status')
      .is('deleted_at', null)
      .order('ticket_number', { ascending: false })
      .limit(POR_TIPO)

    consulta = soDigitos
      ? consulta.eq('ticket_number', Number(termo))
      : consulta.ilike('title', padrao)

    const { data } = await consulta
    for (const t of data ?? []) {
      resultados.push({
        tipo: 'ticket',
        titulo: `#${t.ticket_number} ${t.title}`,
        /* O rótulo, não o valor do banco: "Aguardando terceiro" é o que a
           pessoa lê na lista, e `waiting_third_party` não quer dizer nada para
           ela. A paleta não pode falar uma língua diferente do resto. */
        detalhe: ticketStatusLabel[t.status as TicketStatus] ?? '',
        href: `/tickets/${t.id}`,
      })
    }
  }

  if (podeAtivos) {
    const { data } = await supabase
      .from('it_assets')
      .select('id, asset_tag, serial_number, brand, model')
      .is('deleted_at', null)
      .or(
        [
          `asset_tag.ilike.${padrao}`,
          `serial_number.ilike.${padrao}`,
          `model.ilike.${padrao}`,
        ].join(','),
      )
      .limit(POR_TIPO)

    for (const a of data ?? []) {
      resultados.push({
        tipo: 'ativo',
        titulo: `${a.asset_tag ?? 'sem patrimônio'} — ${[a.brand, a.model].filter(Boolean).join(' ')}`,
        detalhe: a.serial_number ?? '',
        href: `/inventario?busca=${encodeURIComponent(a.asset_tag ?? '')}`,
      })
    }
  }

  if (podeClientes) {
    const { data } = await supabase
      .from('clients')
      .select('id, trade_name, legal_name')
      .is('deleted_at', null)
      .or([`trade_name.ilike.${padrao}`, `legal_name.ilike.${padrao}`].join(','))
      .limit(POR_TIPO)

    for (const c of data ?? []) {
      resultados.push({
        tipo: 'cliente',
        titulo: c.trade_name || c.legal_name,
        detalhe: c.trade_name && c.legal_name !== c.trade_name ? c.legal_name : '',
        href: `/clientes?busca=${encodeURIComponent(c.trade_name || c.legal_name)}`,
      })
    }
  }

  return NextResponse.json({ resultados })
}
