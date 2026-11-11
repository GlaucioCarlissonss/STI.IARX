import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { comParametros } from '@/lib/data/endereco'
import { formatCurrency } from '@/lib/format'
import type {
  EquipmentCategory,
  EquipmentManufacturer,
  EquipmentModel,
  RentalDepot,
  RentalEquipment,
} from '@/lib/types'
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui'
import { DEPOSITO_KIND, MEDIDOR } from '@/lib/locacao/rotulos'
import { GavetaDeCadastro, lerTipoDeCadastro } from './gaveta'

export const metadata: Metadata = { title: 'Modelos e categorias' }

/**
 * Os quatro cadastros que sustentam a frota, numa tela só.
 *
 * O mesmo arranjo de **SLA e prazos**, que já tem quatro cadastros convivendo —
 * e pelo mesmo motivo: eles só fazem sentido juntos. Quem cadastra um
 * equipamento novo precisa do modelo; quem cadastra o modelo precisa do
 * fabricante e da categoria. Em telas separadas, isso vira navegação em
 * círculo para fazer uma coisa só.
 *
 * Cada cartão mostra, ao lado do nome, **quantos equipamentos dependem dele**.
 * É o número que diz se dá para mexer: renomear uma categoria com oitenta peças
 * é outra conversa.
 */
export default async function CadastrosDaLocacaoPage({
  searchParams,
}: {
  searchParams: Promise<{ tipo?: string; aberto?: string; novo?: string }>
}) {
  const params = await searchParams
  await requireScreen('locacao.cadastros.ver')
  const podeGerenciar = await allowed('locacao.cadastros.gerenciar')

  const supabase = await createClient()
  const [
    { data: modelos },
    { data: categorias },
    { data: fabricantes },
    { data: depositos },
    { data: equipamentos },
  ] = await Promise.all([
    supabase
      .from('equipment_models')
      .select('id, manufacturer_id, category_id, code, name, specs, monthly_price, daily_price, is_active')
      .is('deleted_at', null)
      .order('name')
      .returns<EquipmentModel[]>(),
    supabase
      .from('equipment_categories')
      .select('id, code, name, default_meter_kind, default_useful_life_months, is_active')
      .is('deleted_at', null)
      .order('name')
      .returns<EquipmentCategory[]>(),
    supabase
      .from('equipment_manufacturers')
      .select('id, name, support_contact, notes, is_active')
      .is('deleted_at', null)
      .order('name')
      .returns<EquipmentManufacturer[]>(),
    supabase
      .from('rental_depots')
      .select('id, name, code, kind, city, state, is_active')
      .is('deleted_at', null)
      .order('name')
      .returns<RentalDepot[]>(),
    /* Só o vínculo: é a contagem por modelo e por depósito que diz se mexer no
       cadastro é inócuo ou é mudar a vida de oitenta peças. */
    supabase
      .from('rental_equipment')
      .select('id, asset_tag, serial_number, model_id, depot_id, status, blocked, block_reason, block_until, meter_kind, meter_reading, meter_read_at, acquisition_date, acquisition_value, invoice_ref, useful_life_months, notes')
      .is('deleted_at', null)
      .returns<RentalEquipment[]>(),
  ])

  const frota = equipamentos ?? []
  const porModelo = new Map<string, number>()
  const porDeposito = new Map<string, number>()
  for (const e of frota) {
    porModelo.set(e.model_id, (porModelo.get(e.model_id) ?? 0) + 1)
    if (e.depot_id) porDeposito.set(e.depot_id, (porDeposito.get(e.depot_id) ?? 0) + 1)
  }
  const modeloPorId = new Map((modelos ?? []).map((m) => [m.id, m]))
  const porCategoria = new Map<string, number>()
  for (const e of frota) {
    const cat = modeloPorId.get(e.model_id)?.category_id
    if (cat) porCategoria.set(cat, (porCategoria.get(cat) ?? 0) + 1)
  }

  const endereco = (mudancas: Record<string, string | null>) =>
    comParametros('/locacao/cadastros', params, mudancas)
  const tipo = lerTipoDeCadastro(params.tipo)
  const gavetaAberta = Boolean(tipo && (params.aberto || params.novo))

  const abrir = (t: string, alvo: { aberto?: string; novo?: boolean }) =>
    endereco({ tipo: t, aberto: alvo.aberto ?? null, novo: alvo.novo ? '1' : null }) as Route

  const botaoNovo = (t: string, rotulo: string) =>
    podeGerenciar && (
      <Link
        href={abrir(t, { novo: true })}
        data-testid={`novo-${t}`}
        className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-sm font-medium text-[var(--color-brand-ink)] hover:bg-[var(--color-surface-2)]"
      >
        {rotulo}
      </Link>
    )

  const linkEditar = (t: string, id: string) =>
    podeGerenciar && (
      <Link
        href={abrir(t, { aberto: id })}
        data-testid="abrir-registro"
        className="text-sm font-medium text-[var(--color-brand-ink)] hover:underline"
      >
        Editar
      </Link>
    )

  const emUso = (n: number) => (
    <span className="text-xs text-[var(--color-ink-3)]">
      {n === 0 ? 'nenhum equipamento' : `${n} equipamento(s)`}
    </span>
  )

  return (
    <div className={gavetaAberta ? 'lg:pr-[35rem]' : undefined}>
      {gavetaAberta && tipo && (
        <GavetaDeCadastro
          tipo={tipo}
          id={params.aberto}
          novo={Boolean(params.novo)}
          fechar={endereco({ tipo: null, aberto: null, novo: null })}
        />
      )}

      <PageHeader
        title="Modelos e categorias"
        description="O que sustenta a frota: o modelo carrega fabricante, categoria e preço de tabela; o equipamento é a peça física de um modelo."
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title={`Modelos (${(modelos ?? []).length})`} action={botaoNovo('modelo', '+ Novo modelo')}>
          <div className="flex flex-col gap-2">
            {(modelos ?? []).length === 0 && (
              <EmptyState
                title="Nenhum modelo"
                description="Sem modelo não há equipamento: é ele que carrega fabricante, categoria e preço."
              />
            )}
            {(modelos ?? []).map((m) => {
              const cat = (categorias ?? []).find((c) => c.id === m.category_id)
              const fab = (fabricantes ?? []).find((f) => f.id === m.manufacturer_id)
              return (
                <div
                  key={m.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] p-3"
                >
                  <div className="min-w-0">
                    <span className="font-medium text-[var(--color-ink)]">{m.name}</span>
                    <p className="text-xs text-[var(--color-ink-3)]">
                      {m.code} · {fab?.name ?? '—'} · {cat?.name ?? '—'} ·{' '}
                      {m.monthly_price !== null ? `${formatCurrency(m.monthly_price)}/mês` : 'sem preço'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {emUso(porModelo.get(m.id) ?? 0)}
                    {linkEditar('modelo', m.id)}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>

        <Card
          title={`Categorias (${(categorias ?? []).length})`}
          action={botaoNovo('categoria', '+ Nova categoria')}
        >
          <div className="flex flex-col gap-2">
            {(categorias ?? []).length === 0 && <EmptyState title="Nenhuma categoria" />}
            {(categorias ?? []).map((c) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] p-3"
              >
                <div className="min-w-0">
                  <span className="font-medium text-[var(--color-ink)]">
                    <span className="font-mono text-xs text-[var(--color-ink-3)]">{c.code}</span>{' '}
                    {c.name}
                  </span>
                  <p className="text-xs text-[var(--color-ink-3)]">
                    {MEDIDOR[c.default_meter_kind].label}
                    {c.default_useful_life_months
                      ? ` · vida útil ${c.default_useful_life_months} meses`
                      : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {emUso(porCategoria.get(c.id) ?? 0)}
                  {linkEditar('categoria', c.id)}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title={`Fabricantes (${(fabricantes ?? []).length})`}
          action={botaoNovo('fabricante', '+ Novo fabricante')}
        >
          <div className="flex flex-col gap-2">
            {(fabricantes ?? []).length === 0 && <EmptyState title="Nenhum fabricante" />}
            {(fabricantes ?? []).map((f) => (
              <div
                key={f.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] p-3"
              >
                <div className="min-w-0">
                  <span className="font-medium text-[var(--color-ink)]">{f.name}</span>
                  <p className="text-xs text-[var(--color-ink-3)]">
                    {f.support_contact ?? 'sem contato de suporte'}
                  </p>
                </div>
                {linkEditar('fabricante', f.id)}
              </div>
            ))}
          </div>
        </Card>

        <Card
          title={`Depósitos (${(depositos ?? []).length})`}
          action={botaoNovo('deposito', '+ Novo depósito')}
        >
          <div className="flex flex-col gap-2">
            {(depositos ?? []).length === 0 && (
              <EmptyState
                title="Nenhum depósito"
                description="É onde a frota fica quando não está com cliente — galpão, oficina ou trânsito."
              />
            )}
            {(depositos ?? []).map((d) => (
              <div
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] p-3"
              >
                <div className="min-w-0">
                  <span className="font-medium text-[var(--color-ink)]">{d.name}</span>
                  <p className="text-xs text-[var(--color-ink-3)]">
                    {[d.city, d.state].filter(Boolean).join('/') || 'sem cidade'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge>{DEPOSITO_KIND[d.kind] ?? d.kind}</Badge>
                  {emUso(porDeposito.get(d.id) ?? 0)}
                  {linkEditar('deposito', d.id)}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
