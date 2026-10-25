import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { requireScreen } from '@/lib/session'
import { Card, PageHeader } from '@/components/ui'
import { ArtigoForm, type ArtigoInicial } from '../../artigo-form'

export const metadata: Metadata = { title: 'Editar artigo' }

export default async function EditarArtigoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireScreen('autoatendimento.base.escrever')

  const supabase = await createClient()
  const [{ data: artigo }, { data: categorias }] = await Promise.all([
    supabase
      .from('kb_articles')
      .select('id, title, resumo, body, category_id, visibilidade, status, source_ticket_id')
      .eq('id', id)
      .maybeSingle<ArtigoInicial>(),
    supabase
      .from('ticket_categories')
      .select('id, name')
      .eq('is_active', true)
      .order('name')
      .returns<{ id: string; name: string }[]>(),
  ])

  // Zero linhas cobre "não existe" e "o RLS negou". Os dois são um 404.
  if (!artigo) notFound()

  return (
    <>
      <PageHeader
        title="Editar artigo"
        description="Mudar o conteúdo não muda quem pode ler: confira a visibilidade antes de salvar."
      />
      <Card title="">
        <ArtigoForm inicial={artigo} categorias={categorias ?? []} />
      </Card>
    </>
  )
}
