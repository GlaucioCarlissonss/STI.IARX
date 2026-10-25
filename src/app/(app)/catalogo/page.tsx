import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { precoEmTexto } from '@/lib/catalogo/campos'
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui'
import { ServicoForm } from './servico-form'

export const metadata: Metadata = { title: 'Catálogo de serviços' }

interface ItemDaVitrine {
  id: string
  name: string
  description: string | null
  category_name: string | null
  queue_name: string | null
  preco: number | null
  unidade: string | null
  prazo_horas: number | null
  requer_aprovacao: boolean
  is_active: boolean
  pedidos: number
}

/**
 * A vitrine.
 *
 * ## Por que o preço mostrado aqui é o de tabela
 *
 * A lista não conhece a filial de quem está olhando — e o preço depende do
 * contrato do cliente daquela filial. Mostrar um preço "personalizado" sem saber
 * de qual cliente se trata seria mostrar o preço errado com cara de certo.
 *
 * O preço real aparece na tela do serviço, depois de a filial ser escolhida, e é
 * calculado pelo banco (`service_preco_para_cliente`). Aqui a lista diz "a
 * partir de", que é honesto: é o teto, e o contrato só reduz.
 *
 * ## Por que o catálogo é visível a qualquer sessão do tenant
 *
 * Ele É a vitrine. Esconder a vitrine de quem pode pedir esvazia o recurso — e a
 * informação que ela expõe (que a empresa oferece "formatação de estação") não é
 * sensível. O que é sensível é o preço NEGOCIADO de cada cliente, e esse não
 * está aqui: mora em `service_catalog_clients`, atrás da permissão de gerência.
 */
export default async function CatalogoPage() {
  await requireScreen('autoatendimento.catalogo.ver')
  const podeGerenciar = await allowed('autoatendimento.catalogo.gerenciar')
  const podePedir = await allowed('autoatendimento.catalogo.pedir')

  const supabase = await createClient()

  const [
    { data: itens },
    { data: categorias },
    { data: filas },
    { data: prioridades },
    { data: perfis },
  ] = await Promise.all([
      supabase
        .from('vw_service_catalog')
        .select(
          'id, name, description, category_name, queue_name, preco, unidade, prazo_horas, requer_aprovacao, is_active, pedidos',
        )
        .order('sort_order')
        .order('name')
        .returns<ItemDaVitrine[]>(),
      podeGerenciar
        ? supabase
            .from('ticket_categories')
            .select('id, name')
            .eq('is_active', true)
            .order('name')
            .returns<{ id: string; name: string }[]>()
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      podeGerenciar
        ? supabase
            .from('queues')
            .select('id, name')
            .order('name')
            .returns<{ id: string; name: string }[]>()
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      podeGerenciar
        ? supabase
            .from('ticket_priorities')
            /* `label`, e não `name`: a coluna de `ticket_priorities` sempre se
               chamou assim. Com o nome errado o Supabase devolve erro e `data`
               nulo — a lista de prioridades ficava VAZIA, em silêncio, num campo
               do formulário de cadastro de serviço. */
            .select('id, label')
            .order('sort_order')
            .returns<{ id: string; label: string }[]>()
        : Promise.resolve({ data: [] as { id: string; label: string }[] }),
      /* Perfis de acesso, para restringir quem aprova um serviço. Só os ativos:
         oferecer um perfil desativado criaria um serviço que ninguém pode
         aprovar — e a trava viraria um beco. */
      podeGerenciar
        ? supabase
            .from('access_profiles')
            .select('id, name')
            .eq('is_active', true)
            .order('name')
            .returns<{ id: string; name: string }[]>()
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    ])

  const lista = itens ?? []
  const ativos = lista.filter((i) => i.is_active)
  const inativos = lista.filter((i) => !i.is_active)

  return (
    <>
      <PageHeader
        title="Catálogo de serviços"
        description="O que a equipe de TI faz, com prazo e preço. Pedir aqui abre um chamado já classificado."
      />

      {ativos.length === 0 ? (
        <EmptyState
          title="O catálogo ainda está vazio"
          description={
            podeGerenciar
              ? 'Cadastre abaixo o primeiro serviço. Comece pelo que mais pedem por e-mail — é o que o catálogo tira da sua caixa de entrada.'
              : 'Ainda não há serviços publicados. Abra um chamado comum.'
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {ativos.map((item) => (
            <article
              key={item.id}
              className="flex flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
            >
              <h2 className="text-base font-semibold text-[var(--color-ink)]">{item.name}</h2>
              {item.category_name && (
                <p className="mt-0.5 text-xs text-[var(--color-ink-3)]">{item.category_name}</p>
              )}
              {item.description && (
                <p className="mt-2 flex-1 text-sm text-[var(--color-ink-2)]">{item.description}</p>
              )}

              <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-ink-2)]">
                <div>
                  <dt className="inline text-[var(--color-ink-3)]">Preço: </dt>
                  <dd className="inline font-medium">
                    {item.preco === null
                      ? 'Sob consulta'
                      : `a partir de ${precoEmTexto(item.preco, false, item.unidade)}`}
                  </dd>
                </div>
                {item.prazo_horas && (
                  <div>
                    <dt className="inline text-[var(--color-ink-3)]">Prazo: </dt>
                    <dd className="inline font-medium">{item.prazo_horas} h úteis</dd>
                  </div>
                )}
              </dl>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {item.requer_aprovacao && <Badge tone="warn">precisa de aprovação</Badge>}
                {podeGerenciar && item.pedidos > 0 && (
                  <span className="text-xs text-[var(--color-ink-3)]">
                    {item.pedidos} pedido(s)
                  </span>
                )}
              </div>

              {podePedir && (
                <Link
                  href={`/catalogo/${item.id}` as Route}
                  className="mt-4 rounded-lg bg-[var(--color-brand)] px-4 py-2 text-center text-sm font-semibold text-[var(--color-on-brand)] hover:bg-[var(--color-brand-ink)]"
                >
                  Pedir
                </Link>
              )}
            </article>
          ))}
        </div>
      )}

      {podeGerenciar && inativos.length > 0 && (
        <Card title={`Fora da vitrine (${inativos.length})`} className="mt-6">
          <p className="mb-3 text-sm text-[var(--color-ink-2)]">
            Serviços desativados não aparecem para quem pede, e os chamados que já nasceram deles
            continuam onde estão.
          </p>
          <ul className="flex flex-col gap-1 text-sm text-[var(--color-ink-2)]">
            {inativos.map((i) => (
              <li key={i.id}>
                {i.name}
                {i.pedidos > 0 && (
                  <span className="text-[var(--color-ink-3)]"> — {i.pedidos} pedido(s)</span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {podeGerenciar && (
        <ServicoForm
          className="mt-6"
          categorias={categorias ?? []}
          filas={filas ?? []}
          prioridades={prioridades ?? []}
          perfis={perfis ?? []}
        />
      )}
    </>
  )
}
