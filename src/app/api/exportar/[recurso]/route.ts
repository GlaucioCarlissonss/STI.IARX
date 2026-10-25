import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { allowed, requireSession } from '@/lib/session'
import { cabecalhosDeCsv, montarCsv, type ColunaExportada } from '@/lib/exportacao'
import { alteracoesLegiveis, nomeDaEntidade, ROTULO_DA_ACAO } from '@/lib/auditoria'

/**
 * Exportação em CSV — a decisão que estava pendente desde o roadmap (LG-11).
 *
 * ## Por que no servidor
 *
 * A lacuna recomendava geração no servidor "para que o arquivo respeite
 * exatamente o escopo de RLS do usuário e não dependa do que o navegador
 * carregou". É o que acontece aqui: a rota usa `createClient()` — o mesmo
 * cliente de sessão das telas —, então cada consulta passa pelas mesmas policies
 * e o arquivo sai com as linhas que aquela pessoa enxerga. Nem uma a mais.
 *
 * Gerar no cliente exportaria **a página visível**, que depois da paginação da
 * entrega 6 são 50 linhas. "Exportei o inventário" com 50 de 412 ativos é pior
 * que não exportar.
 *
 * ## Uma rota, e um catálogo fechado
 *
 * O `recurso` é chave de um objeto literal, nunca nome de tabela vindo da URL.
 * Com nome livre, `/api/exportar/profiles` funcionaria — e, embora o RLS
 * continuasse valendo, a rota viraria um leitor genérico do banco, com as
 * colunas que ninguém escolheu e sem a permissão da tela correspondente.
 *
 * Cada recurso declara a sua própria chave de permissão, e ela é a MESMA da tela
 * que mostra aquele dado: quem não pode ver na tela não exporta.
 */

export const dynamic = 'force-dynamic'

/** Teto de linhas por arquivo. */
const LIMITE = 10000

type Cliente = Awaited<ReturnType<typeof createClient>>

interface Recurso {
  /** A chave do catálogo que protege o dado. A mesma da tela. */
  permissao: string
  /** Busca as linhas com o cliente de SESSÃO — o RLS é quem filtra. */
  buscar: (supabase: Cliente) => Promise<unknown[]>
  colunas: readonly ColunaExportada<never>[]
}

/* -------------------------------------------------------------------------- */

interface LinhaDaTrilha {
  action: string
  entity_type: string
  entity_id: string | null
  changes: Record<string, unknown>
  created_at: string
  actor: { full_name: string } | null
}

interface LinhaDeLinha {
  phone_number: string
  carrier: string | null
  plan_name: string | null
  status: string
  monthly_cost: number | null
  loyalty_until: string | null
  contract_end: string | null
  branch: { name: string } | null
  pessoa: { full_name: string } | null
}

interface LinhaDeCustodia {
  started_at: string
  ended_at: string | null
  reason: string | null
  reason_note: string | null
  asset: { asset_tag: string | null; brand: string | null; model: string | null } | null
  pessoa: { full_name: string } | null
  branch: { name: string } | null
}

const RECURSOS: Record<string, Recurso> = {
  /* A trilha é o recurso mais pedido numa auditoria externa, e é exatamente o
     tipo de coisa que alguém quer entregar como planilha. */
  trilha: {
    permissao: 'auditoria.trilha.ver',
    buscar: async (supabase) => {
      const { data } = await supabase
        .from('audit_log')
        .select('action, entity_type, entity_id, changes, created_at, actor:profiles(full_name)')
        .order('id', { ascending: false })
        .limit(LIMITE)
        .returns<LinhaDaTrilha[]>()
      return data ?? []
    },
    colunas: [
      { titulo: 'Quando', valor: (l: LinhaDaTrilha) => l.created_at },
      { titulo: 'Quem', valor: (l: LinhaDaTrilha) => l.actor?.full_name ?? 'sistema' },
      { titulo: 'Ação', valor: (l: LinhaDaTrilha) => ROTULO_DA_ACAO[l.action] ?? l.action },
      { titulo: 'Registro', valor: (l: LinhaDaTrilha) => nomeDaEntidade(l.entity_type) },
      { titulo: 'Id do registro', valor: (l: LinhaDaTrilha) => l.entity_id },
      {
        titulo: 'Mudou',
        valor: (l: LinhaDaTrilha) =>
          alteracoesLegiveis(l.changes)
            .map((a) => `${a.campo}: ${a.de} → ${a.para}`)
            .join(' | '),
      },
    ] as readonly ColunaExportada<never>[],
  },

  /* Pedida nominalmente pelo M6 do roadmap. */
  telefonia: {
    permissao: 'telefonia.linhas.ver',
    buscar: async (supabase) => {
      const { data } = await supabase
        .from('telecom_lines')
        .select(
          'phone_number, carrier, plan_name, status, monthly_cost, loyalty_until, contract_end, branch:branches(name), pessoa:profiles(full_name)',
        )
        .is('deleted_at', null)
        .order('phone_number')
        .limit(LIMITE)
        .returns<LinhaDeLinha[]>()
      return data ?? []
    },
    colunas: [
      { titulo: 'Número', valor: (l: LinhaDeLinha) => l.phone_number },
      { titulo: 'Operadora', valor: (l: LinhaDeLinha) => l.carrier },
      { titulo: 'Plano', valor: (l: LinhaDeLinha) => l.plan_name },
      { titulo: 'Situação', valor: (l: LinhaDeLinha) => l.status },
      { titulo: 'Filial', valor: (l: LinhaDeLinha) => l.branch?.name },
      { titulo: 'Responsável', valor: (l: LinhaDeLinha) => l.pessoa?.full_name },
      { titulo: 'Custo mensal', valor: (l: LinhaDeLinha) => l.monthly_cost },
      { titulo: 'Fidelidade até', valor: (l: LinhaDeLinha) => l.loyalty_until },
      { titulo: 'Contrato até', valor: (l: LinhaDeLinha) => l.contract_end },
    ] as readonly ColunaExportada<never>[],
  },

  /* Pedida nominalmente pelo M4. A view existe desde a 0023 e o roadmap
     registrava a exportação como a única parte pendente dela. */
  custodia: {
    permissao: 'inventario.ativos.ver',
    buscar: async (supabase) => {
      const { data } = await supabase
        .from('asset_assignments')
        .select(
          'started_at, ended_at, reason, reason_note, asset:it_assets(asset_tag, brand, model), pessoa:profiles(full_name), branch:branches(name)',
        )
        .order('started_at', { ascending: false })
        .limit(LIMITE)
        .returns<LinhaDeCustodia[]>()
      return data ?? []
    },
    colunas: [
      {
        titulo: 'Equipamento',
        valor: (l: LinhaDeCustodia) =>
          l.asset ? [l.asset.brand, l.asset.model].filter(Boolean).join(' ') : null,
      },
      { titulo: 'Patrimônio', valor: (l: LinhaDeCustodia) => l.asset?.asset_tag },
      { titulo: 'Responsável', valor: (l: LinhaDeCustodia) => l.pessoa?.full_name },
      { titulo: 'Filial', valor: (l: LinhaDeCustodia) => l.branch?.name },
      { titulo: 'Desde', valor: (l: LinhaDeCustodia) => l.started_at },
      {
        titulo: 'Até',
        valor: (l: LinhaDeCustodia) => l.ended_at ?? 'em uso',
      },
      { titulo: 'Motivo', valor: (l: LinhaDeCustodia) => l.reason },
      { titulo: 'Observação', valor: (l: LinhaDeCustodia) => l.reason_note },
    ] as readonly ColunaExportada<never>[],
  },
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ recurso: string }> },
) {
  const { recurso } = await params

  /* Sessão primeiro: sem ela, `allowed()` responderia sobre ninguém. */
  await requireSession()

  const definicao = RECURSOS[recurso]
  /* Recurso desconhecido responde 404 e nada mais — dizer "não existe esse
     recurso" e listar os que existem entregaria o catálogo a quem não deveria
     tê-lo. */
  if (!definicao) return new NextResponse(null, { status: 404 })

  if (!(await allowed(definicao.permissao))) {
    return NextResponse.json({ erro: 'Sem permissão para exportar este dado.' }, { status: 403 })
  }

  const supabase = await createClient()
  const linhas = await definicao.buscar(supabase)

  const csv = montarCsv(linhas as never[], definicao.colunas)
  return new NextResponse(csv, { status: 200, headers: cabecalhosDeCsv(recurso) })
}
