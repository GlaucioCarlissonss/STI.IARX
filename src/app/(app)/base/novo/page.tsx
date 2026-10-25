import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen } from '@/lib/session'
import { Card, PageHeader } from '@/components/ui'
import { ArtigoForm, type ArtigoInicial } from '../artigo-form'

export const metadata: Metadata = { title: 'Escrever artigo' }

/**
 * Página em branco — ou, com `?chamado=<id>`, o rascunho já montado.
 *
 * O segundo caminho é o que importa. Bases de conhecimento morrem porque ninguém
 * escreve, e a tela em branco é onde elas morrem: quem poderia escrever está com
 * a fila cheia, e escrever não resolve o chamado que está nela agora.
 *
 * Vindo de um chamado resolvido, o título, o problema e a solução já estão lá —
 * tirados do próprio chamado. O que resta é revisar, que é um trabalho de
 * minutos no instante em que o assunto ainda está na cabeça de quem resolveu.
 */
export default async function NovoArtigoPage({
  searchParams,
}: {
  searchParams: Promise<{ chamado?: string }>
}) {
  const params = await searchParams
  await requireScreen('autoatendimento.base.escrever')

  const supabase = await createClient()
  const { data: categorias } = await supabase
    .from('ticket_categories')
    .select('id, name')
    .eq('is_active', true)
    .order('name')
    .returns<{ id: string; name: string }[]>()

  let inicial: ArtigoInicial = {}
  if (params.chamado) {
    /* A função é `security invoker`: se o RLS não deixa esta sessão ver o
       chamado, ela devolve zero linhas e a página abre em branco — sem vazar
       nem o fato de o chamado existir. */
    const { data } = await supabase
      .rpc('kb_rascunho_do_chamado', { p_ticket_id: params.chamado })
      .maybeSingle<{ title: string; resumo: string; body: string; category_id: string | null }>()
    if (data) {
      inicial = {
        title: data.title,
        resumo: data.resumo,
        body: data.body,
        category_id: data.category_id,
        source_ticket_id: params.chamado,
      }
    }
  }

  return (
    <>
      <PageHeader
        title={inicial.source_ticket_id ? 'Virar artigo' : 'Escrever artigo'}
        description={
          inicial.source_ticket_id
            ? 'O texto veio do chamado. Revise, corte o que é específico daquele caso e publique.'
            : 'Um artigo bom responde uma pergunta só, e responde inteira.'
        }
      />
      <Card title="">
        <ArtigoForm inicial={inicial} categorias={categorias ?? []} />
      </Card>
    </>
  )
}
