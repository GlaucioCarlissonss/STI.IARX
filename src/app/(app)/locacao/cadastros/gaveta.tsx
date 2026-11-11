import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import type {
  EquipmentCategory,
  EquipmentManufacturer,
  EquipmentModel,
  RentalDepot,
} from '@/lib/types'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import { CategoriaForm, DepositoForm, FabricanteForm, ModeloForm } from './forms'

/** Os quatro cadastros desta tela. `?tipo=` chega do endereço e é validado. */
export const TIPOS_DE_CADASTRO = ['modelo', 'categoria', 'fabricante', 'deposito'] as const
export type TipoDeCadastro = (typeof TIPOS_DE_CADASTRO)[number]

export function lerTipoDeCadastro(valor: string | undefined): TipoDeCadastro | undefined {
  return TIPOS_DE_CADASTRO.find((t) => t === valor)
}

const TITULO: Record<TipoDeCadastro, { novo: string; linha: string }> = {
  modelo: { novo: 'Novo modelo', linha: 'Fabricante, categoria e preço de tabela' },
  categoria: { novo: 'Nova categoria', linha: 'Medidor e vida útil padrão do tipo de bem' },
  fabricante: { novo: 'Novo fabricante', linha: 'Quem atende a garantia' },
  deposito: { novo: 'Novo depósito', linha: 'Onde a frota fica quando não está com cliente' },
}

/**
 * A gaveta dos cadastros da locação — quatro modos, quatro tabelas.
 *
 * Mesma forma da gaveta de /sla, e pelo mesmo motivo: são cadastros que só
 * fazem sentido juntos, e cada modo consulta apenas o que o seu formulário
 * pede. O modo de modelo é o único que carrega lookups — fabricante e
 * categoria —, e os outros três não pagam por isso.
 */
export async function GavetaDeCadastro({
  tipo,
  id,
  novo,
  fechar,
}: {
  tipo: TipoDeCadastro
  id?: string
  novo?: boolean
  fechar: string
}) {
  if (!id && !novo) return null

  const podeGerenciar = await allowed('locacao.cadastros.gerenciar')
  if (!podeGerenciar) return null

  const supabase = await createClient()

  if (tipo === 'fabricante') {
    const atual = id
      ? (
          await supabase
            .from('equipment_manufacturers')
            .select('id, name, support_contact, notes, is_active')
            .eq('id', id)
            .is('deleted_at', null)
            .maybeSingle<EquipmentManufacturer>()
        ).data
      : null
    if (id && !atual) return null
    return (
      <Gaveta fechar={fechar} rotulo={atual?.name ?? TITULO.fabricante.novo}>
        <CabecalhoDaGaveta
          titulo={atual?.name ?? TITULO.fabricante.novo}
          linha={TITULO.fabricante.linha}
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <FabricanteForm atual={atual ?? undefined} />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (tipo === 'categoria') {
    const atual = id
      ? (
          await supabase
            .from('equipment_categories')
            .select('id, code, name, default_meter_kind, default_useful_life_months, is_active')
            .eq('id', id)
            .is('deleted_at', null)
            .maybeSingle<EquipmentCategory>()
        ).data
      : null
    if (id && !atual) return null
    return (
      <Gaveta fechar={fechar} rotulo={atual?.name ?? TITULO.categoria.novo}>
        <CabecalhoDaGaveta
          titulo={atual?.name ?? TITULO.categoria.novo}
          linha={atual ? `Código ${atual.code}` : TITULO.categoria.linha}
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <CategoriaForm atual={atual ?? undefined} />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (tipo === 'deposito') {
    const atual = id
      ? (
          await supabase
            .from('rental_depots')
            .select('id, name, code, kind, city, state, is_active')
            .eq('id', id)
            .is('deleted_at', null)
            .maybeSingle<RentalDepot>()
        ).data
      : null
    if (id && !atual) return null
    return (
      <Gaveta fechar={fechar} rotulo={atual?.name ?? TITULO.deposito.novo}>
        <CabecalhoDaGaveta
          titulo={atual?.name ?? TITULO.deposito.novo}
          linha={atual ? [atual.city, atual.state].filter(Boolean).join('/') || '—' : TITULO.deposito.linha}
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <DepositoForm atual={atual ?? undefined} />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  /* Modelo. */
  const [{ data: fabricantes }, { data: categorias }] = await Promise.all([
    supabase
      .from('equipment_manufacturers')
      .select('id, name, support_contact, notes, is_active')
      .is('deleted_at', null)
      .eq('is_active', true)
      .order('name')
      .returns<EquipmentManufacturer[]>(),
    supabase
      .from('equipment_categories')
      .select('id, code, name, default_meter_kind, default_useful_life_months, is_active')
      .is('deleted_at', null)
      .eq('is_active', true)
      .order('name')
      .returns<EquipmentCategory[]>(),
  ])

  const atual = id
    ? (
        await supabase
          .from('equipment_models')
          .select(
            'id, manufacturer_id, category_id, code, name, specs, monthly_price, daily_price, is_active',
          )
          .eq('id', id)
          .is('deleted_at', null)
          .maybeSingle<EquipmentModel>()
      ).data
    : null
  if (id && !atual) return null

  return (
    <Gaveta fechar={fechar} rotulo={atual?.name ?? TITULO.modelo.novo}>
      <CabecalhoDaGaveta
        titulo={atual?.name ?? TITULO.modelo.novo}
        linha={atual ? `Código ${atual.code}` : TITULO.modelo.linha}
        fechar={fechar}
      />
      <CorpoDaGaveta>
        {(fabricantes ?? []).length === 0 || (categorias ?? []).length === 0 ? (
          <p className="rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn-ink)]">
            Um modelo precisa de um fabricante e de uma categoria. Cadastre os dois antes — eles
            estão nesta mesma tela, logo abaixo.
          </p>
        ) : (
          <ModeloForm
            atual={atual ?? undefined}
            fabricantes={fabricantes ?? []}
            categorias={categorias ?? []}
          />
        )}
      </CorpoDaGaveta>
    </Gaveta>
  )
}
