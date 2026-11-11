'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import type {
  EquipmentCategory,
  EquipmentManufacturer,
  EquipmentModel,
  RentalDepot,
} from '@/lib/types'
import { DEPOSITO_KIND, MEDIDOR } from '@/lib/locacao/rotulos'
import {
  salvarCategoria,
  salvarDeposito,
  salvarFabricante,
  salvarModelo,
} from './actions'

/* Um formulário por cadastro, e todos com a mesma forma: o `id` escondido
   decide entre criar e editar. Ver o comentário de `EquipamentoForm`. */

export function FabricanteForm({ atual }: { atual?: EquipmentManufacturer }) {
  const uid = atual ? `fab-${atual.id}` : 'fab-novo'
  return (
    <ActionForm action={salvarFabricante} manterCampos={Boolean(atual)} className="flex flex-col gap-4">
      {atual && <input type="hidden" name="id" value={atual.id} />}
      <Field label="Nome" htmlFor={`${uid}-nome`} required>
        <input id={`${uid}-nome`} name="name" required maxLength={120}
          defaultValue={atual?.name ?? ''} className={inputClass} />
      </Field>
      <Field label="Contato de suporte" htmlFor={`${uid}-sup`}
        hint="Telefone ou e-mail de quem atende a garantia. É o dado que falta às 3 da manhã.">
        <input id={`${uid}-sup`} name="support_contact" maxLength={200}
          defaultValue={atual?.support_contact ?? ''} className={inputClass} />
      </Field>
      <Field label="Observações" htmlFor={`${uid}-obs`}>
        <textarea id={`${uid}-obs`} name="notes" rows={2} maxLength={1000}
          defaultValue={atual?.notes ?? ''} className={inputClass} />
      </Field>
      <SubmitButton>{atual ? 'Salvar fabricante' : 'Cadastrar fabricante'}</SubmitButton>
    </ActionForm>
  )
}

export function CategoriaForm({ atual }: { atual?: EquipmentCategory }) {
  const uid = atual ? `cat-${atual.id}` : 'cat-nova'
  return (
    <ActionForm action={salvarCategoria} manterCampos={Boolean(atual)} className="flex flex-col gap-4">
      {atual && <input type="hidden" name="id" value={atual.id} />}
      <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
        <Field label="Código" htmlFor={`${uid}-cod`} required>
          <input id={`${uid}-cod`} name="code" required maxLength={20}
            defaultValue={atual?.code ?? ''} className={inputClass} placeholder="OXI" />
        </Field>
        <Field label="Nome" htmlFor={`${uid}-nome`} required>
          <input id={`${uid}-nome`} name="name" required maxLength={120}
            defaultValue={atual?.name ?? ''} className={inputClass} />
        </Field>
      </div>
      <Field label="Medidor padrão" htmlFor={`${uid}-med`} required
        hint="Padrão, não regra: o equipamento pode divergir. Existe para que cadastrar o quadragésimo concentrador não exija lembrar o que vale para concentrador.">
        <select id={`${uid}-med`} name="default_meter_kind"
          defaultValue={atual?.default_meter_kind ?? 'none'} className={inputClass}>
          {(Object.keys(MEDIDOR) as (keyof typeof MEDIDOR)[]).map((k) => (
            <option key={k} value={k}>{MEDIDOR[k].label}</option>
          ))}
        </select>
      </Field>
      <Field label="Vida útil padrão (meses)" htmlFor={`${uid}-vida`}>
        <input id={`${uid}-vida`} name="default_useful_life_months" type="number" min="1" max="600"
          defaultValue={atual?.default_useful_life_months ?? ''} className={inputClass} />
      </Field>
      <SubmitButton>{atual ? 'Salvar categoria' : 'Cadastrar categoria'}</SubmitButton>
    </ActionForm>
  )
}

export function ModeloForm({
  atual,
  fabricantes,
  categorias,
}: {
  atual?: EquipmentModel
  fabricantes: EquipmentManufacturer[]
  categorias: EquipmentCategory[]
}) {
  const uid = atual ? `mod-${atual.id}` : 'mod-novo'
  return (
    <ActionForm action={salvarModelo} manterCampos={Boolean(atual)} className="flex flex-col gap-4">
      {atual && <input type="hidden" name="id" value={atual.id} />}
      <div className="grid gap-4 sm:grid-cols-[9rem_1fr]">
        <Field label="Código" htmlFor={`${uid}-cod`} required>
          <input id={`${uid}-cod`} name="code" required maxLength={40}
            defaultValue={atual?.code ?? ''} className={inputClass} placeholder="OXI-5L" />
        </Field>
        <Field label="Nome" htmlFor={`${uid}-nome`} required>
          <input id={`${uid}-nome`} name="name" required maxLength={160}
            defaultValue={atual?.name ?? ''} className={inputClass} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Fabricante" htmlFor={`${uid}-fab`} required>
          <select id={`${uid}-fab`} name="manufacturer_id" required
            defaultValue={atual?.manufacturer_id ?? ''} className={inputClass}>
            <option value="">Selecione…</option>
            {fabricantes.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </Field>
        <Field label="Categoria" htmlFor={`${uid}-cat`} required>
          <select id={`${uid}-cat`} name="category_id" required
            defaultValue={atual?.category_id ?? ''} className={inputClass}>
            <option value="">Selecione…</option>
            {categorias.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Preço mensal de tabela" htmlFor={`${uid}-mes`}
          hint="Preço mora no modelo, não na peça: corrigir a tabela no equipamento viraria um update em duzentas linhas, e a que escapasse cobraria diferente para sempre.">
          <input id={`${uid}-mes`} name="monthly_price" type="number" step="0.01" min="0"
            defaultValue={atual?.monthly_price ?? ''} className={inputClass} />
        </Field>
        <Field label="Preço diário de tabela" htmlFor={`${uid}-dia`}>
          <input id={`${uid}-dia`} name="daily_price" type="number" step="0.01" min="0"
            defaultValue={atual?.daily_price ?? ''} className={inputClass} />
        </Field>
      </div>
      <SubmitButton>{atual ? 'Salvar modelo' : 'Cadastrar modelo'}</SubmitButton>
    </ActionForm>
  )
}

export function DepositoForm({ atual }: { atual?: RentalDepot }) {
  const uid = atual ? `dep-${atual.id}` : 'dep-novo'
  return (
    <ActionForm action={salvarDeposito} manterCampos={Boolean(atual)} className="flex flex-col gap-4">
      {atual && <input type="hidden" name="id" value={atual.id} />}
      <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
        <Field label="Nome" htmlFor={`${uid}-nome`} required>
          <input id={`${uid}-nome`} name="name" required maxLength={120}
            defaultValue={atual?.name ?? ''} className={inputClass} />
        </Field>
        <Field label="Código" htmlFor={`${uid}-cod`}>
          <input id={`${uid}-cod`} name="code" maxLength={20}
            defaultValue={atual?.code ?? ''} className={inputClass} />
        </Field>
      </div>
      <Field label="Tipo" htmlFor={`${uid}-tipo`} required
        hint="Galpão guarda, oficina conserta. A distinção importa porque a peça em oficina não está disponível, mesmo estando 'em casa'.">
        <select id={`${uid}-tipo`} name="kind" defaultValue={atual?.kind ?? 'warehouse'} className={inputClass}>
          {Object.entries(DEPOSITO_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-[1fr_6rem]">
        <Field label="Cidade" htmlFor={`${uid}-cid`}>
          <input id={`${uid}-cid`} name="city" maxLength={80}
            defaultValue={atual?.city ?? ''} className={inputClass} />
        </Field>
        <Field label="UF" htmlFor={`${uid}-uf`}>
          <input id={`${uid}-uf`} name="state" maxLength={2}
            defaultValue={atual?.state ?? ''} className={inputClass} />
        </Field>
      </div>
      <SubmitButton>{atual ? 'Salvar depósito' : 'Cadastrar depósito'}</SubmitButton>
    </ActionForm>
  )
}
