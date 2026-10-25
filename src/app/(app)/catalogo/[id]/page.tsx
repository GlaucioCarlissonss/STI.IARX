import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { requireScreen } from '@/lib/session'
import { lerCampos } from '@/lib/catalogo/campos'
import { Card, PageHeader } from '@/components/ui'
import { PedidoForm } from './pedido-form'

export const metadata: Metadata = { title: 'Pedir serviço' }

interface Servico {
  id: string
  name: string
  description: string | null
  preco: number | null
  unidade: string | null
  prazo_horas: number | null
  requer_aprovacao: boolean
  is_active: boolean
  campos: unknown
  category: { name: string } | null
  queue: { name: string } | null
}

/**
 * Pedir um serviço.
 *
 * ## A filial vem antes do preço, e isso é a tela inteira
 *
 * O preço depende do contrato do cliente, e o cliente vem da filial. Então a
 * ordem não é cosmética: enquanto a filial não é escolhida, o que se pode
 * mostrar honestamente é o preço de tabela. Depois dela, o preço é o do contrato
 * daquela empresa — calculado pelo banco, não pela tela.
 *
 * Mostrar um preço antes de saber de quem é o contrato seria mostrar o preço
 * errado com cara de certo, e a primeira cobrança viraria uma discussão.
 */
export default async function PedirServicoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireScreen('autoatendimento.catalogo.ver')

  const supabase = await createClient()

  const [{ data: servico }, { data: filiais }] = await Promise.all([
    supabase
      .from('service_catalog')
      .select(
        'id, name, description, preco, unidade, prazo_horas, requer_aprovacao, is_active, campos, category:ticket_categories(name), queue:queues(name)',
      )
      .eq('id', id)
      .maybeSingle<Servico>(),
    /* As filiais que esta sessão alcança — o RLS já as restringe. Quem só
       enxerga uma vê uma, e a escolha deixa de ser uma pergunta. */
    supabase
      .from('branches')
      .select('id, name, client_id, client:clients(trade_name, legal_name)')
      .is('deleted_at', null)
      .eq('is_active', true)
      .order('name')
      .returns<
        {
          id: string
          name: string
          client_id: string
          client: { trade_name: string | null; legal_name: string } | null
        }[]
      >(),
  ])

  if (!servico) notFound()

  return (
    <>
      <PageHeader
        title={servico.name}
        description={servico.category?.name ?? undefined}
      />

      {servico.description && (
        <Card title="O que está incluído" className="mb-6">
          <p className="whitespace-pre-wrap text-sm text-[var(--color-ink-2)]">
            {servico.description}
          </p>
        </Card>
      )}

      <Card title="Seu pedido">
        {servico.is_active ? (
          <PedidoForm
            servico={{
              id: servico.id,
              preco: servico.preco,
              unidade: servico.unidade,
              prazo_horas: servico.prazo_horas,
              requer_aprovacao: servico.requer_aprovacao,
              fila: servico.queue?.name ?? null,
            }}
            campos={lerCampos(servico.campos)}
            filiais={(filiais ?? []).map((f) => ({
              id: f.id,
              nome: f.name,
              cliente: f.client?.trade_name ?? f.client?.legal_name ?? null,
            }))}
          />
        ) : (
          <p className="text-sm text-[var(--color-ink-2)]">
            Este serviço saiu da vitrine. Abra um chamado comum descrevendo o que precisa — ele
            chega na mesma fila.
          </p>
        )}
      </Card>
    </>
  )
}
