import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { allowed, requireSession } from '@/lib/session'
import { cabecalhosDeCsv, montarCsv } from '@/lib/exportacao'
import { recursoPorChave } from '@/lib/planilha/recursos'

/**
 * As linhas recusadas, com o motivo ao lado — prontas para corrigir e reenviar.
 *
 * ## Por que isto é parte do ciclo, e não um extra
 *
 * Sem este arquivo, quem recebe "7 recusadas" tem de abrir a planilha original,
 * localizar sete linhas pelo número, lembrar o motivo de cada uma e apagar as
 * 305 que entraram — à mão, no Excel, sem errar. Na prática não faz: refaz a
 * planilha inteira e reimporta tudo, e aí a escolha entre atualizar e pular
 * passa a valer para 312 linhas em vez de sete.
 *
 * O arquivo sai com as MESMAS colunas do original, na mesma ordem, mais uma
 * coluna de motivo no fim. Corrigir, apagar a coluna de motivo (ou nem apagar —
 * coluna desconhecida é ignorada no casamento) e reenviar.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  await requireSession()
  if (!(await allowed('sistema.planilhas.ver'))) {
    return NextResponse.json({ erro: 'Sem permissão.' }, { status: 403 })
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse(null, { status: 404 })

  const supabase = await createClient()

  /* O lote é buscado sob RLS: um id de outro tenant some aqui, e a resposta é
     404 — igual à de um id que não existe. */
  const { data: lote } = await supabase
    .from('import_batches')
    .select('id, resource, file_name')
    .eq('id', id)
    .maybeSingle<{ id: string; resource: string; file_name: string }>()
  if (!lote) return new NextResponse(null, { status: 404 })

  const recurso = recursoPorChave(lote.resource)
  if (!recurso) return new NextResponse(null, { status: 404 })

  const { data: linhas } = await supabase
    .from('import_rows')
    .select('line_number, raw, reason')
    .eq('batch_id', lote.id)
    .eq('outcome', 'reject')
    .order('line_number')
    .returns<{ line_number: number; reason: string | null; raw: { cru: Record<string, string> } }[]>()

  const corpo = linhas ?? []
  const colunas = [
    /* O número da linha ORIGINAL vai junto: é como a pessoa confere, lado a
       lado com a planilha que ela tem aberta, que linha é qual. */
    { titulo: 'Linha original', valor: (l: (typeof corpo)[number]) => l.line_number },
    ...recurso.campos.map((c) => ({
      titulo: c.titulo,
      valor: (l: (typeof corpo)[number]) => l.raw?.cru?.[c.titulo] ?? '',
    })),
    { titulo: 'Motivo da recusa', valor: (l: (typeof corpo)[number]) => l.reason ?? '' },
  ]

  const csv = montarCsv(corpo, colunas)
  return new NextResponse(csv, {
    status: 200,
    headers: cabecalhosDeCsv(`recusadas-${recurso.chave}`),
  })
}
