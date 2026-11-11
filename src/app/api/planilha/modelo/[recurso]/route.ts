import { NextResponse } from 'next/server'
import { allowed, requireSession } from '@/lib/session'
import { cabecalhosDeCsv, montarCsv } from '@/lib/exportacao'
import { cabecalhoModelo, camposChave, recursoPorChave } from '@/lib/planilha/recursos'

/**
 * O modelo de planilha de um recurso.
 *
 * Por que uma rota, e não um texto de ajuda na tela: "qual é o formato?" se
 * responde com um arquivo que a pessoa abre, preenche e devolve. Descrever as
 * colunas em prosa transfere para ela o trabalho de montar o cabeçalho — e é
 * exatamente aí que nasce a planilha com a coluna faltando.
 *
 * O modelo traz duas linhas: o cabeçalho e uma linha de DICAS, dizendo de cada
 * coluna o que ela aceita — quais valores, qual formato de data, qual é a
 * chave. Sem isso, "Situação" é uma coluna que a pessoa preenche adivinhando.
 *
 * A linha de dicas não é tratada de forma especial na importação, e é de
 * propósito. Ignorá-la por algum marcador criaria uma regra invisível ("linhas
 * que começam com X somem") que um dia engoliria um registro de verdade. Ela
 * grita APAGUE ESTA LINHA na primeira célula; quem esquecer recebe UMA recusa
 * com motivo claro, em vez de um cliente cadastrado como "Razão social".
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ recurso: string }> },
) {
  const { recurso: chave } = await params

  await requireSession()

  const recurso = recursoPorChave(chave)
  /* Recurso desconhecido responde 404 e nada mais — a mesma disciplina da rota
     de exportação: listar o que existe entregaria o catálogo. */
  if (!recurso) return new NextResponse(null, { status: 404 })

  if (!(await allowed('sistema.planilhas.ver'))) {
    return NextResponse.json({ erro: 'Sem permissão.' }, { status: 403 })
  }

  const chaves = camposChave(recurso).map((c) => c.titulo)
  const dicas = recurso.campos.map((c) => {
    const marcas = [
      chaves.includes(c.titulo) ? 'CHAVE' : null,
      c.obrigatorio ? 'obrigatório' : null,
      c.tipo === 'data' ? '31/12/2026' : null,
      c.tipo === 'numero' || c.tipo === 'inteiro' ? '1.234,56' : null,
      c.tipo === 'opcao' ? (c.opcoes ?? []).map((o) => o.rotulos[0]).join(' | ') : null,
      c.tipo === 'booleano' ? 'sim | não' : null,
      c.referencia ? `nome ou código do ${c.referencia.nome}` : null,
    ].filter(Boolean)
    return marcas.join(' · ')
  })
  dicas[0] = `APAGUE ESTA LINHA — ${dicas[0]}`

  const csv = montarCsv(
    [dicas],
    cabecalhoModelo(recurso).map((titulo, i) => ({
      titulo,
      valor: (linha: string[]) => linha[i],
    })),
  )

  return new NextResponse(csv, { status: 200, headers: cabecalhosDeCsv(`modelo-${recurso.chave}`) })
}
